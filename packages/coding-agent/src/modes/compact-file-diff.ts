import * as path from "node:path";
import { UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { renderDiff, wrapDiffRow } from "@oh-my-pi/pi-tui/text/diff";
import { replaceTabs, spaces, truncate } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TurnToolDiff } from "../session/latest-turn-tool-diffs";
import type { EditCard, EditTerm } from "../ui/tools/edit";
import "../ui/styles/tools/block";
import "../ui/styles/tools/edit";
import { shortenPath } from "../utils/render-utils";
import { cfgDisplayMode } from "./settings";
import type { InteractiveModeContext } from "./types";

function displayPath(cwd: string, file: string): string {
	const relative = path.isAbsolute(file) ? path.relative(cwd, file) : file;
	return replaceTabs(
		sanitizeText(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? shortenPath(file) : relative),
	).replace(/[\r\n]+/g, " ");
}

function fileAction(change: TurnToolDiff): string {
	return change.op === "create" ? "Added" : change.op === "delete" ? "Deleted" : "Edited";
}

function filePathLabel(cwd: string, change: TurnToolDiff): string {
	const origin = displayPath(cwd, change.sourcePath ?? change.path);
	return change.move ? `${origin} → ${displayPath(cwd, change.move)}` : origin;
}

/** Editor chrome: its rows can never be retired into terminal history. */
export class CompactFileDiff {
	#offset = 0;
	#maxOffset = 0;
	#page = 0;
	#diffRows = new WeakMap<TurnToolDiff, readonly string[]>();
	#cachedTheme?: ReturnType<typeof currentTheme>;
	#expanded?: readonly TurnToolDiff[];
	#expandedRows?: {
		source: readonly TurnToolDiff[];
		count: number;
		width: number;
		cwd: string;
		theme: ReturnType<typeof currentTheme>;
		rows: string[];
	};
	#preview?: {
		file: TurnToolDiff;
		cwd: string;
		width: number;
		height: number;
		theme: ReturnType<typeof currentTheme>;
		rows: readonly string[];
	};

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "shell" | "composer" | "settings">,
		private readonly availableRows: () => number,
		private readonly onChange: () => void = () => {},
	) {}

	#source(): readonly TurnToolDiff[] | undefined {
		return cfgDisplayMode.get(this.ctx.settings) === "compact"
			? this.ctx.viewSession.getLatestTurnToolDiffs()
			: undefined;
	}

	close(): void {
		if (!this.#expanded) return;
		this.#expanded = undefined;
		this.#offset = 0;
		this.#maxOffset = 0;
		this.onChange();
	}

	clear(): void {
		this.close();
		this.#expandedRows = undefined;
		this.#preview = undefined;
	}

	sync(source = this.#source(), availableRows = this.availableRows()): void {
		if (
			!this.#expanded ||
			source !== this.#expanded ||
			this.ctx.shell.size().columns < 2 ||
			availableRows < 2 ||
			!source.length
		) {
			this.close();
		}
	}

	toggle(): boolean {
		const source = this.#source();
		const availableRows = this.availableRows();
		this.sync(source, availableRows);
		if (this.#expanded) {
			this.close();
			return true;
		}
		if (
			!source ||
			this.ctx.shell.size().columns < 2 ||
			availableRows < 2 ||
			this.ctx.shell.focused() !== this.ctx.composer.field
		)
			return false;
		if (source.length === 0) return false;
		this.#expanded = source;
		this.#offset = 0;
		this.onChange();
		return true;
	}

	handleKey(key: string): boolean {
		this.sync();
		if (!this.#expanded || this.ctx.shell.focused() !== this.ctx.composer.field) return false;
		// Let the focused draft navigate or dismiss its completion before scrolling the diff.
		if (this.ctx.composer.completing()) return false;
		if (key === "escape") {
			this.close();
			return true;
		}
		let next: number;
		switch (key) {
			case "home":
				next = 0;
				break;
			case "end":
				next = this.#maxOffset;
				break;
			case "up":
				next = this.#offset - 1;
				break;
			case "down":
				next = this.#offset + 1;
				break;
			case "pageUp":
				next = this.#offset - this.#page;
				break;
			case "pageDown":
				next = this.#offset + this.#page;
				break;
			default:
				return false;
		}
		next = Math.max(0, Math.min(this.#maxOffset, next));
		if (next !== this.#offset) {
			this.#offset = next;
			this.onChange();
		}
		return true;
	}

	/** The original tool diff accessible in the dock for this call and path. */
	coveredDiff(toolCallId: string, file: string, width: number): string | undefined {
		const source = this.#source();
		if (!source?.length || width < 1) return undefined;
		const height = this.availableRows();
		if (height < 1) return undefined;
		const cwd = this.ctx.viewSession.sessionManager.getCwd();
		const matches = (change: TurnToolDiff) =>
			change.toolCallId === toolCallId && path.relative(file, path.resolve(cwd, change.path)) === "";
		if (this.#expanded === source && height >= 2 && width >= 2) {
			return source.findLast(matches)?.diff;
		}
		const latest = source[source.length - 1]!;
		if (!matches(latest)) return undefined;
		const bodyWidth = width - Math.min(1, width - 1);
		if (!this.#previewRows(latest, cwd, bodyWidth, height).length) return undefined;
		return latest.diff;
	}

	#previewRows(file: TurnToolDiff, cwd: string, width: number, height: number): readonly string[] {
		const theme = currentTheme();
		const cached = this.#preview;
		if (
			cached?.file === file &&
			cached.cwd === cwd &&
			cached.width === width &&
			cached.height === height &&
			cached.theme === theme
		)
			return cached.rows;
		const inline = !file.diff || file.op === "delete";
		if (height < 1 || (!inline && (height < 3 || width < 8))) return [];
		const body: EditCard["body"] = inline
			? []
			: [
					{
						k: "raw",
						text: this.#rows(file)
							.flatMap(line => wrapDiffRow(line, width - 2))
							.slice(0, height - 2)
							.join("\n"),
					},
				];
		const origin = file.sourcePath ?? file.path;
		const card: EditCard = {
			kind: inline ? "inline" : "card",
			title: fileAction(file),
			path: displayPath(cwd, origin),
			rename: file.move ? displayPath(cwd, file.move) : undefined,
			link: {
				path: path.resolve(cwd, origin),
				rename: file.move ? path.resolve(cwd, file.move) : undefined,
				line: file.firstChangedLine,
			},
			icon: file.op === "delete" ? "delete" : file.move ? "move" : "edit",
			phase: "success",
			body,
		};
		const node = new UiNode("tool", {
			role: "omp.tool.edit",
			name: "edit",
			status: "done",
			term: { look: "edit", margin: false, edit: { cards: [card] } satisfies EditTerm },
		});
		const rows = renderBlock(node, width, { env: staticEnvironment(theme) }).rows;
		this.#preview = { file, cwd, width, height, theme, rows };
		return rows;
	}

	#rows(change: TurnToolDiff): readonly string[] {
		const theme = currentTheme();
		if (this.#cachedTheme !== theme) {
			this.#cachedTheme = theme;
			this.#diffRows = new WeakMap();
		}
		let lines = this.#diffRows.get(change);
		if (lines) return lines;
		lines = change.diff ? renderDiff(change.diff, { path: change.path, theme }) : [];
		this.#diffRows.set(change, lines);
		return lines;
	}

	render(width: number): readonly string[] {
		const source = this.#source();
		const maxRows = width < 1 ? 0 : this.availableRows();
		this.sync(source, maxRows);
		if (!source || maxRows < 1) return [];
		const latest = source.at(-1);
		if (!latest) return [];
		const left = spaces(Math.min(1, width - 1));
		const bodyWidth = width - left.length;
		const cwd = this.ctx.viewSession.sessionManager.getCwd();
		const expanded = this.#expanded;
		const theme = currentTheme();
		if (!expanded) {
			const preview = this.#previewRows(latest, cwd, bodyWidth, maxRows);
			return preview.length
				? preview.map(line => left + line)
				: [left + theme.fg("accent", truncate(filePathLabel(cwd, latest), bodyWidth))];
		}
		let entry = this.#expandedRows;
		if (
			!entry ||
			entry.source !== source ||
			entry.count !== source.length ||
			entry.width !== bodyWidth ||
			entry.cwd !== cwd ||
			entry.theme !== theme
		) {
			const rows: string[] = [];
			for (const change of source) {
				rows.push(theme.fg("accent", truncate(`${fileAction(change)} ${filePathLabel(cwd, change)}`, bodyWidth)));
				for (const line of this.#rows(change)) rows.push(...wrapDiffRow(line, bodyWidth));
			}
			entry = { source, count: source.length, width: bodyWidth, cwd, theme, rows };
			this.#expandedRows = entry;
		}
		const { rows: lines } = entry;
		this.#page = Math.min(maxRows, lines.length);
		this.#maxOffset = Math.max(0, lines.length - this.#page);
		this.#offset = Math.min(this.#offset, this.#maxOffset);
		return lines.slice(this.#offset, this.#offset + this.#page).map(line => left + line);
	}
}
