import { type Component, Input, matchesKey, type TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { DocsService } from "../../docs/service";
import type { DocsIndexSummary, DocsProgress, DocsSearchResult } from "../../docs/types";
import { theme } from "../theme/theme";
import { DocsAddWizard, type DocsAddWizardResult } from "./docs-add-wizard";

export interface DocsHubCallbacks {
	onCancel: () => void;
}
type HubMode = "list" | "search" | "detail" | "confirm-remove" | "confirm-cancel-close";
type SearchHit = { kind: "entity"; id: number; label: string } | { kind: "section"; id: number; label: string };

function sanitizeTerminalText(text: string): string {
	return sanitizeText(text).replaceAll("\t", "    ");
}

function sanitizeTerminalLine(text: string): string {
	return sanitizeTerminalText(text).replace(/\n+/g, " ");
}

export class DocsHubComponent implements Component {
	#indexes: DocsIndexSummary[] = [];
	#selected = 0;
	#mode: HubMode = "list";
	#detail: string[] = [];
	#search = new Input();
	#hits: SearchHit[] = [];
	#hitIndex = 0;
	#wizard?: DocsAddWizard;
	#abort?: AbortController;
	#progress?: DocsProgress;
	#latestError?: string;
	#disposed = false;
	#work?: Promise<void>;

	private constructor(
		private readonly tui: TUI,
		private readonly service: DocsService,
		private readonly callbacks: DocsHubCallbacks,
	) {}

	static async create(
		tui: TUI,
		cwd: string,
		settings: Settings,
		modelRegistry: ModelRegistry,
		callbacks: DocsHubCallbacks,
	): Promise<DocsHubComponent> {
		const hub = new DocsHubComponent(
			tui,
			new DocsService({
				agentDir: settings.getAgentDir(),
				cwd,
				settings,
				modelRegistry,
				maxConcurrency: settings.get("task.maxConcurrency"),
			}),
			callbacks,
		);
		hub.#refresh();
		return hub;
	}

	invalidate(): void {}

	dispose(): void {
		this.#disposed = true;
		this.#abort?.abort();
		if (this.#work) void this.#work.finally(() => this.service.close());
		else this.service.close();
	}

	#refresh(): void {
		this.#indexes = this.service.list();
		this.#selected = Math.max(0, Math.min(this.#selected, this.#indexes.length - 1));
		this.tui.requestRender();
	}

	#selectedIndex(): DocsIndexSummary | undefined {
		return this.#indexes[this.#selected];
	}

	#start(work: (signal: AbortSignal) => Promise<unknown>): void {
		if (this.#abort) return;
		const controller = new AbortController();
		this.#abort = controller;
		this.#latestError = undefined;
		const pending = work(controller.signal)
			.then(() => undefined)
			.catch(error => {
				if (!(error instanceof Error && error.name === "AbortError")) {
					this.#latestError = sanitizeTerminalLine(error instanceof Error ? error.message : String(error));
				}
			})
			.finally(() => {
				if (this.#abort === controller) this.#abort = undefined;
				if (this.#work === pending) this.#work = undefined;
				this.#progress = undefined;
				if (!this.#disposed) this.#refresh();
			});
		this.#work = pending;
	}

	#create(result: DocsAddWizardResult): void {
		this.#wizard = undefined;
		this.#start(signal =>
			this.service.init(result.directory, result.name, result.schema, {
				mode: result.mode,
				signal,
				onProgress: progress => {
					this.#progress = progress;
					this.tui.requestRender();
				},
			}),
		);
	}

	#reinit(): void {
		const index = this.#selectedIndex();
		if (!index) return;
		this.#start(signal =>
			this.service.reinit(index.name, {
				signal,
				onProgress: progress => {
					this.#progress = progress;
					this.tui.requestRender();
				},
			}),
		);
	}

	#runSearch(): void {
		const query = this.#search.getValue().trim();
		if (!query) return;
		try {
			const result: DocsSearchResult = this.service.search(query, { index: this.#selectedIndex()?.name, limit: 20 });
			this.#hits = [
				...result.entities.map(hit => ({
					kind: "entity" as const,
					id: hit.entityId,
					label: sanitizeTerminalLine(`[entity] ${hit.kind} ${hit.displayName} (${hit.entityId})`),
				})),
				...result.sections.map(hit => ({
					kind: "section" as const,
					id: hit.sectionId,
					label: sanitizeTerminalLine(`[section] ${hit.path}:${hit.lineStart}-${hit.lineEnd} ${hit.headingPath}`),
				})),
			];
			this.#hitIndex = 0;
			this.#mode = "detail";
			this.#detail = [`Entity hits: ${result.entities.length}`, `Section hits: ${result.sections.length}`];
		} catch (error) {
			this.#latestError = sanitizeTerminalLine(error instanceof Error ? error.message : String(error));
		}
		this.tui.requestRender();
	}

	#openHit(): void {
		const hit = this.#hits[this.#hitIndex];
		if (!hit) return;
		try {
			if (hit.kind === "section") {
				const value = this.service.read({ sectionId: hit.id });
				if ("rawMarkdown" in value)
					this.#detail = [
						sanitizeTerminalLine(
							`[${value.index}] ${value.path}:${value.lineStart}-${value.lineEnd} ${value.headingPath}`,
						),
						"",
						sanitizeTerminalText(value.rawMarkdown),
					];
			} else {
				const entities = this.service.lookup(String(hit.id), { index: this.#selectedIndex()?.name });
				this.#detail = entities.flatMap(entity => [
					sanitizeTerminalLine(`[${entity.index}] ${entity.kind} ${entity.displayName} id=${entity.entityId}`),
					sanitizeTerminalLine(`key=${entity.key}`),
					...entity.assertions.map(assertion =>
						sanitizeTerminalLine(`${assertion.field}=${JSON.stringify(assertion.value)}`),
					),
				]);
			}
			this.#hits = [];
		} catch (error) {
			this.#latestError = sanitizeTerminalLine(error instanceof Error ? error.message : String(error));
		}
		this.tui.requestRender();
	}

	#showInfo(): void {
		const index = this.#selectedIndex();
		if (!index) return;
		const conflicts = this.service.conflicts({ index: index.name, limit: 20 });
		this.#detail = [
			`${index.name} ${index.state} schema=${index.schemaId}@${index.schemaVersion}`,
			`root=${index.rootPath}`,
			`mode=${index.mode} documents=${index.documentCount} partial=${index.partialCount} sections=${index.sectionCount}`,
			`entities=${index.entityCount} assertions=${index.assertionCount} relations=${index.relationCount}`,
			...(index.lastError ? [`error=${index.lastError}`] : []),
			"",
			`Conflicts: ${conflicts.length}`,
			...conflicts.map(
				conflict =>
					`${conflict.subjectName} ${conflict.predicate}: ${conflict.values.map(value => JSON.stringify(value.value)).join(" <> ")}`,
			),
		].map(sanitizeTerminalLine);
		this.#mode = "detail";
	}

	#showSchema(): void {
		const index = this.#selectedIndex();
		if (!index) return;
		const stored = this.service.storage.get(index.name);
		this.#detail = [
			sanitizeTerminalLine(`${index.schemaId}@${index.schemaVersion} ${index.schemaHash}`),
			"",
			sanitizeTerminalText(JSON.stringify(JSON.parse(stored?.schemaJson ?? "{}"), null, 2)),
		];
		this.#mode = "detail";
	}

	handleInput(data: string): void {
		if (this.#wizard) {
			this.#wizard.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.#mode === "confirm-remove") {
			if (data.toLowerCase() === "y") {
				const name = this.#selectedIndex()?.name;
				if (name) this.service.remove(name);
				this.#mode = "list";
				this.#refresh();
			} else if (data.toLowerCase() === "n" || matchesKey(data, "escape")) this.#mode = "list";
			return;
		}
		if (this.#mode === "confirm-cancel-close") {
			if (data.toLowerCase() === "y") {
				this.#abort?.abort();
				void (this.#work ?? Promise.resolve()).finally(() => this.callbacks.onCancel());
			} else if (data.toLowerCase() === "n" || matchesKey(data, "escape")) this.#mode = "list";
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
			} else if (this.#abort) this.#mode = "confirm-cancel-close";
			else this.callbacks.onCancel();
			this.tui.requestRender();
			return;
		}
		if (this.#mode === "detail" && this.#hits.length > 0) {
			if (matchesKey(data, "up")) this.#hitIndex = Math.max(0, this.#hitIndex - 1);
			else if (matchesKey(data, "down")) this.#hitIndex = Math.min(this.#hits.length - 1, this.#hitIndex + 1);
			else if (matchesKey(data, "enter") || data === "\n") this.#openHit();
			this.tui.requestRender();
			return;
		}
		if (data === "n")
			this.#wizard = new DocsAddWizard(
				result => this.#create(result),
				() => {
					this.#wizard = undefined;
				},
			);
		else if (data === "r") this.#reinit();
		else if (data === "/") {
			this.#mode = "search";
			this.#search = new Input();
		} else if (data === "i") this.#showInfo();
		else if (data === "v") this.#showSchema();
		else if (data === "d" && this.#selectedIndex() && !this.#abort) this.#mode = "confirm-remove";
		else if (data === "c" && this.#abort) this.#abort.abort();
		else if (matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
		else if (matchesKey(data, "down")) this.#selected = Math.min(this.#indexes.length - 1, this.#selected + 1);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.#wizard) return this.#wizard.render(width);
		const lines = [
			theme.bold(theme.fg("accent", "Document indexes")),
			theme.fg("dim", "n new  r reinit  / search  i info  v schema  d delete  c cancel  Esc close"),
		];
		if (this.#mode === "confirm-remove")
			lines.push(theme.fg("warning", `Delete ${sanitizeTerminalLine(this.#selectedIndex()?.name ?? "")}? y/N`));
		else if (this.#mode === "confirm-cancel-close")
			lines.push(theme.fg("warning", "Indexing active. Cancel and close? y/N"));
		else if (this.#mode === "search") lines.push(`Search: ${this.#search.render(Math.max(10, width - 10))[0] ?? ""}`);
		else if (this.#mode === "detail") {
			lines.push(...this.#detail);
			for (let index = 0; index < this.#hits.length; index++)
				lines.push(`${index === this.#hitIndex ? ">" : " "} ${this.#hits[index].label}`);
		} else if (this.#indexes.length === 0) lines.push("No document indexes. Press n to add one.");
		else
			for (let index = 0; index < this.#indexes.length; index++) {
				const item = this.#indexes[index];
				lines.push(
					sanitizeTerminalLine(
						`${index === this.#selected ? ">" : " "} ${item.name}  ${item.schemaId}@${item.schemaVersion}  ${item.mode}  ${item.state}  docs=${item.documentCount} partial=${item.partialCount}`,
					),
					sanitizeTerminalLine(`    ${item.rootPath}  updated=${item.indexedAt ?? item.updatedAt}`),
				);
			}
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
