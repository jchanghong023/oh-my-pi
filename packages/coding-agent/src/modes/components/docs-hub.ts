import { type Component, Input, matchesKey, type TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import { DocsService } from "../../docs/service";
import type { DocsIndexSummary, DocsProgress, DocsSectionHit } from "../../docs/types";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { DocsAddWizard, type DocsAddWizardResult } from "./docs-add-wizard";

export interface DocsHubCallbacks {
	onCancel: () => void;
}
type HubMode = "list" | "search" | "detail" | "confirm-remove";
type SearchHit = { section: DocsSectionHit; label: string };

function sanitizeTerminalText(text: string): string {
	return sanitizeText(text).replaceAll("\t", "    ");
}

function sanitizeTerminalLine(text: string): string {
	return sanitizeTerminalText(text).replace(/\n+/g, " ");
}

/** Failure text for panel display: message extraction plus terminal sanitization. */
function errorLine(error: unknown): string {
	return sanitizeTerminalLine(error instanceof Error ? error.message : String(error));
}

export class DocsHubComponent implements Component {
	#indexes: DocsIndexSummary[] = [];
	#listed = false;
	#selected = 0;
	#mode: HubMode = "list";
	#detail: string[] = [];
	#search = new Input();
	#hits: SearchHit[] = [];
	#hitIndex = 0;
	#searchQuery = "";
	#searchIndex?: string;
	#nextCursor?: string;
	#pageStart = 0;
	#resultSummary: string[] = [];
	#showingHit = false;
	#wizard?: DocsAddWizard;
	#abort?: AbortController;
	#progress?: DocsProgress;
	#latestError?: string;
	#disposed = false;
	#disposePromise?: Promise<void>;
	#busy?: string;

	private constructor(
		private readonly tui: TUI,
		private readonly service: DocsService,
		private readonly callbacks: DocsHubCallbacks,
	) {}

	static async create(
		tui: TUI,
		cwd: string,
		settings: Settings,
		callbacks: DocsHubCallbacks,
	): Promise<DocsHubComponent> {
		const hub = new DocsHubComponent(
			tui,
			new DocsService({
				agentDir: settings.getAgentDir(),
				cwd,
			}),
			callbacks,
		);
		hub.#start("Loading document indexes…", (signal, current) => hub.#refresh(signal, current));
		return hub;
	}

	invalidate(): void {}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#cancel();
		this.#disposePromise = this.service.close();
		return this.#disposePromise;
	}

	async #refresh(signal: AbortSignal, current: () => boolean): Promise<void> {
		const indexes = await this.service.list({ signal });
		if (!current()) return;
		this.#indexes = indexes;
		this.#listed = true;
		this.#selected = Math.max(0, Math.min(this.#selected, this.#indexes.length - 1));
		this.tui.requestRender();
	}

	#selectedIndex(): DocsIndexSummary | undefined {
		return this.#indexes[this.#selected];
	}

	#cancel(): void {
		this.#abort?.abort();
		this.#abort = undefined;
		this.#busy = undefined;
		this.#progress = undefined;
	}

	#start(busy: string, work: (signal: AbortSignal, current: () => boolean) => Promise<unknown>): void {
		if (this.#disposed || this.#abort) return;
		const controller = new AbortController();
		const current = () => !this.#disposed && this.#abort === controller && !controller.signal.aborted;
		this.#abort = controller;
		this.#busy = busy;
		this.#latestError = undefined;
		void Promise.resolve()
			.then(() => {
				if (current()) return work(controller.signal, current);
			})
			.catch(error => {
				if (current() && !(error instanceof Error && error.name === "AbortError")) {
					this.#latestError = errorLine(error);
				}
			})
			.finally(() => {
				if (this.#abort !== controller) return;
				this.#abort = undefined;
				this.#busy = undefined;
				this.#progress = undefined;
				if (!this.#disposed) this.tui.requestRender();
			});
		this.tui.requestRender();
	}

	#create(result: DocsAddWizardResult): void {
		this.#wizard = undefined;
		this.#start("Indexing document index…", async (signal, current) => {
			await this.service.init(result.directory, result.name, {
				signal,
				onProgress: progress => {
					if (!current()) return;
					this.#progress = progress;
					this.tui.requestRender();
				},
			});
			if (current()) await this.#refresh(signal, current);
		});
	}

	#runSearch(cursor?: string): void {
		const query = cursor ? this.#searchQuery : this.#search.getValue().trim();
		if (!query) return;
		const index = cursor ? this.#searchIndex : this.#selectedIndex()?.name;
		const pageStart = cursor ? this.#pageStart + this.#hits.length : 0;
		this.#start("Searching document indexes…", async (signal, current) => {
			const result = await this.service.search(query, { index, limit: 20, cursor, signal });
			if (!current()) return;
			this.#pageStart = pageStart;
			this.#searchQuery = query;
			this.#searchIndex = index;
			this.#nextCursor = result.cursor;
			this.#hits = result.sections.map(hit => ({
				section: hit,
				label: sanitizeTerminalLine(
					`[${hit.matchKind}] [${hit.index}] ${hit.path}:${hit.lineStart}-${hit.lineEnd} ${hit.headingPath} · sectionId=${hit.sectionId}`,
				),
			}));
			this.#hitIndex = 0;
			this.#showingHit = false;
			this.#mode = "detail";
			this.#resultSummary = [
				`Section hits: ${result.total} · showing ${result.sections.length ? this.#pageStart + 1 : 0}-${this.#pageStart + result.sections.length}`,
				...(result.technicalName
					? [
							sanitizeTerminalLine(
								`Full name: ${result.technicalName} · exact-name matches: ${result.exactNameMatches}`,
							),
							...(result.exactNameMatches === 0 ? ["未找到完整名称命中"] : []),
						]
					: []),
				result.cursor ? "More results available. Press n for next page." : "Results exhausted.",
			];
			this.#detail = this.#resultSummary;
		});
	}

	#openHit(): void {
		const hit = this.#hits[this.#hitIndex];
		if (!hit) return;
		try {
			const value = hit.section;
			this.#latestError = undefined;
			this.#detail = [
				sanitizeTerminalLine(
					`[${value.matchKind}] [${value.index}] ${value.path}:${value.lineStart}-${value.lineEnd} ${value.headingPath}`,
				),
				sanitizeTerminalLine(`sha256=${value.documentHash} · sectionId=${value.sectionId}`),
				"",
				sanitizeTerminalText(value.text),
			];
			this.#showingHit = true;
		} catch (error) {
			this.#latestError = errorLine(error);
		}
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#wizard) {
			this.#wizard.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.#abort && (data === "c" || matchesKey(data, "escape"))) {
			this.#cancel();
			if (this.#mode === "search") this.#mode = "list";
			this.tui.requestRender();
			return;
		}
		if (this.#mode === "confirm-remove") {
			if (data.toLowerCase() === "y") {
				const name = this.#selectedIndex()?.name;
				if (name) {
					this.#start("Deleting document index…", async (signal, current) => {
						await this.service.remove(name, { signal });
						if (current()) await this.#refresh(signal, current);
					});
				}
				this.#mode = "list";
			} else if (data.toLowerCase() === "n" || matchesKey(data, "escape")) this.#mode = "list";
			this.tui.requestRender();
			return;
		}
		if (this.#mode === "search") {
			if (matchesKey(data, "escape")) this.#mode = "list";
			else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") this.#runSearch();
			else this.#search.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#mode === "detail") {
				this.#mode = "list";
				this.#hits = [];
			} else this.callbacks.onCancel();
			this.tui.requestRender();
			return;
		}
		if (this.#mode === "detail" && !(this.#showingHit && (data === "/" || data === "d" || data === "c"))) {
			if (data === "n") {
				if (this.#nextCursor) this.#runSearch(this.#nextCursor);
			} else if (this.#showingHit && data === "b") {
				this.#showingHit = false;
				this.#detail = this.#resultSummary;
			} else if (!this.#showingHit) {
				if (matchesKey(data, "up")) this.#hitIndex = Math.max(0, this.#hitIndex - 1);
				else if (matchesKey(data, "down")) this.#hitIndex = Math.min(this.#hits.length - 1, this.#hitIndex + 1);
				else if (matchesKey(data, "enter") || data === "\n") this.#openHit();
			}
			this.tui.requestRender();
			return;
		}
		if (data === "n") {
			if (this.#abort) this.#latestError = "Document index operation already in progress.";
			else
				this.#wizard = new DocsAddWizard(
					result => this.#create(result),
					() => {
						this.#wizard = undefined;
					},
				);
		} else if (data === "/") {
			this.#mode = "search";
			this.#search = new Input();
		} else if (data === "d" && this.#selectedIndex() && !this.#abort) this.#mode = "confirm-remove";
		else if (matchesKey(data, "up") && this.#mode !== "detail") this.#selected = Math.max(0, this.#selected - 1);
		else if (matchesKey(data, "down") && this.#mode !== "detail")
			this.#selected = Math.min(this.#indexes.length - 1, this.#selected + 1);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.#wizard) return this.#wizard.render(width);
		const lines = [
			theme.bold(theme.fg("accent", "Document indexes")),
			theme.fg(
				"dim",
				this.#mode === "detail"
					? `${this.#showingHit ? "b back to results" : "↑↓ select  Enter open"}${this.#nextCursor ? "  n next page" : ""}  c cancel  Esc indexes`
					: "n new  / search  d delete  c cancel  Esc close",
			),
		];
		if (this.#mode === "confirm-remove")
			lines.push(theme.fg("warning", `Delete ${sanitizeTerminalLine(this.#selectedIndex()?.name ?? "")}? y/N`));
		else if (this.#mode === "search") lines.push(`Search: ${this.#search.render(Math.max(10, width - 10))[0] ?? ""}`);
		else if (this.#mode === "detail") {
			lines.push(...this.#detail);
			if (!this.#showingHit)
				for (let index = 0; index < this.#hits.length; index++)
					lines.push(`${index === this.#hitIndex ? ">" : " "} ${this.#hits[index].label}`);
		} else if (!this.#listed) {
			if (!this.#busy) lines.push("Document indexes have not been loaded.");
		} else if (this.#indexes.length === 0) lines.push("No document indexes. Press n to add one.");
		else
			for (let index = 0; index < this.#indexes.length; index++) {
				const item = this.#indexes[index];
				lines.push(
					sanitizeTerminalLine(
						`${index === this.#selected ? ">" : " "} ${item.name}  docs=${item.documentCount} sections=${item.sectionCount}`,
					),
					sanitizeTerminalLine(`    ${item.rootPath}`),
				);
			}
		if (this.#busy) lines.push(theme.fg("dim", `${this.#busy}  c cancel`));
		if (this.#progress)
			lines.push(
				"",
				sanitizeTerminalLine(
					`${this.#progress.phase} ${this.#progress.completed}/${this.#progress.total} failed=${this.#progress.failed} ${this.#progress.currentPath ?? ""}`,
				),
				sanitizeTerminalLine(this.#progress.message ?? ""),
			);
		if (this.#latestError) lines.push(theme.fg("error", sanitizeTerminalLine(this.#latestError)));
		return lines.flatMap(line => line.split("\n")).map(line => truncateToWidth(line, width));
	}
}
