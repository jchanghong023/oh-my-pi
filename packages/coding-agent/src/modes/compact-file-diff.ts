import * as path from "node:path";
import { type Component, matchesKey } from "@oh-my-pi/pi-tui";
import { renderDiff } from "@oh-my-pi/pi-tui/chrome/diff";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { rowsText } from "@oh-my-pi/pi-tui/native/spans";
import { replaceTabs, shortenPath, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThemeEpoch, theme } from "@oh-my-pi/pi-tui/theme";
import { editToolRenderer, type EditRenderContext } from "@oh-my-pi/pi-tui/tools/edit";
import { getPaddingX, padding } from "@oh-my-pi/pi-tui/utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TurnToolDiff } from "../session/latest-turn-tool-diffs";
import { cfgDisplayMode } from "./settings";
import type { InteractiveModeContext } from "./types";

function displayPath(cwd: string, file: string): string {
	const relative = path.isAbsolute(file) ? path.relative(cwd, file) : file;
	return replaceTabs(
		sanitizeText(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? shortenPath(file) : relative),
	).replace(/[\r\n]+/g, " ");
}

function fileAction(change: TurnToolDiff): string {
	return change.op === "create" ? "新增" : change.op === "delete" ? "删除" : "修改";
}

/** Editor chrome: its rows can never be retired into terminal history. */
export class CompactFileDiff implements Component {
	readonly #scroll = new ScrollView([], { height: 0, scrollbar: "auto" });
	#diffRows = new WeakMap<TurnToolDiff, readonly string[]>();
	#cachedTheme = -1;
	#expanded?: readonly TurnToolDiff[];
	#lastSource?: readonly TurnToolDiff[];
	#preview?: { file: TurnToolDiff; cwd: string; context: EditRenderContext; card: Component };
	#body?: { count: number; cwd: string; theme: number; rows: number };

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "ui" | "editor" | "settings">,
		private readonly availableRows: () => number,
	) {}

	#source(): readonly TurnToolDiff[] | undefined {
		return cfgDisplayMode.get(this.ctx.settings) === "compact"
			? this.ctx.viewSession.getLatestTurnToolDiffs()
			: undefined;
	}

	#clearBody(): void {
		if (!this.#body) return;
		this.#body = undefined;
		this.#scroll.setLines([]);
	}

	close(): void {
		const focused = this.ctx.ui.getFocused() === this;
		if (!this.#expanded && !focused) return;
		this.#expanded = undefined;
		this.#clearBody();
		if (focused) this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	clear(): void {
		this.close();
		this.#lastSource = undefined;
		this.#preview = undefined;
	}

	sync(source = this.#source(), availableRows = this.availableRows()): void {
		if (this.#lastSource !== source) {
			this.#lastSource = source;
			this.#clearBody();
			this.#preview = undefined;
		}
		if (
			!this.#expanded ||
			source !== this.#expanded ||
			this.ctx.ui.terminal.columns < 2 ||
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
			this.ctx.ui.terminal.columns < 2 ||
			availableRows < 2 ||
			this.ctx.ui.getFocused() !== this.ctx.editor
		)
			return false;
		if (source.length === 0) return false;
		this.#expanded = source;
		this.#scroll.scrollToTop();
		this.ctx.ui.setFocus(this);
		this.ctx.ui.requestRender();
		return true;
	}

	handleInput(data: string): void {
		// An overlay can restore its prior focus after the underlying turn changed.
		this.sync();
		if (!this.#expanded) {
			this.ctx.editor.handleInput(data);
		} else if (matchesKey(data, "escape")) this.close();
		else if (this.#scroll.handleScrollKey(data)) this.ctx.ui.requestRender();
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
		if (path.relative(file, path.resolve(cwd, latest.path)) !== "") return undefined;
		const bodyWidth = width - Math.min(getPaddingX(1), width - 1);
		if (!this.#previewRows(latest, cwd, bodyWidth, height).length) return undefined;
		return latest.toolCallId === toolCallId ? latest.diff : source.findLast(matches)?.diff;
	}

	#previewRows(file: TurnToolDiff, cwd: string, width: number, height: number): readonly string[] {
		if (height < 1) return [];
		// Only framed edits need space for two borders and a body row.
		if (file.op !== "delete" && height < 3) return [];
		if (this.#preview?.file !== file || this.#preview.cwd !== cwd) {
			const context: EditRenderContext = {
				renderDiff: diff => renderDiff(diff, { filePath: file.path }),
				compactDiffPreviewRows: Math.max(1, height - 2),
			};
			const card = editToolRenderer.renderResult(
				{
					content: [],
					details: file,
				},
				{ expanded: false, isPartial: false, renderContext: context },
				theme,
				{ path: displayPath(cwd, file.path) },
			);
			this.#preview = { file, cwd, context, card };
		}
		this.#preview.context.compactDiffPreviewRows = Math.max(1, height - 2);
		const rows = this.#preview.card.render(width);
		// Extremely narrow widths may wrap the code gutter itself. Never split the frame.
		return rows.length <= height ? rows : [];
	}

	#rows(change: TurnToolDiff): readonly string[] {
		let lines = this.#diffRows.get(change);
		if (lines) return lines;
		lines = change.diff ? renderDiff(change.diff, { filePath: change.path }).split("\n") : [];
		this.#diffRows.set(change, lines);
		return lines;
	}

	render(width: number): readonly string[] {
		const source = this.#source();
		const maxRows = width < 1 ? 0 : this.availableRows();
		this.sync(source, maxRows);
		if (!source || maxRows < 1) return [];
		const latest = source.at(-1);
		if (!latest) {
			this.#preview = undefined;
			return [];
		}
		const left = padding(Math.min(getPaddingX(1), width - 1));
		const bodyWidth = width - left.length;
		const cwd = this.ctx.viewSession.sessionManager.getCwd();
		const expanded = this.#expanded;
		const epoch = getThemeEpoch();
		if (this.#cachedTheme !== epoch) {
			this.#cachedTheme = epoch;
			this.#diffRows = new WeakMap();
			this.#preview = undefined;
		}
		if (!expanded) {
			const preview = this.#previewRows(latest, cwd, bodyWidth, maxRows);
			return preview.length
				? preview.map(line => left + line)
				: [left + theme.fg("accent", truncateToWidth(displayPath(cwd, latest.path), bodyWidth))];
		}
		if (this.#body?.count !== source.length || this.#body.cwd !== cwd || this.#body.theme !== epoch) {
			const lines: string[] = [];
			for (const change of source) {
				const icon = change.op === "delete" ? `${theme.styledSymbol("tool.delete", "accent")} ` : "";
				lines.push(`${icon}${theme.fg("accent", `${fileAction(change)} ${displayPath(cwd, change.path)}`)}`);
				for (const line of this.#rows(change)) lines.push(line);
			}
			this.#scroll.setLines(lines);
			this.#body = { count: source.length, cwd, theme: epoch, rows: lines.length };
		}
		this.#scroll.setHeight(Math.min(maxRows, this.#body.rows));
		return this.#scroll.render(bodyWidth).map(line => left + line);
	}

	describe(cx: DescribeContext): NativeNode {
		return rowsText(this.render(cx.cols));
	}
}
