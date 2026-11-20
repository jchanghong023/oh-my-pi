import * as path from "node:path";
import { editDiffString } from "@oh-my-pi/pi-natives";
import { type Component, matchesKey } from "@oh-my-pi/pi-tui";
import { renderDiff } from "@oh-my-pi/pi-tui/chrome/diff";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { rowsText } from "@oh-my-pi/pi-tui/native/spans";
import { replaceTabs, shortenPath, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThemeEpoch, theme } from "@oh-my-pi/pi-tui/theme";
import { editToolRenderer, type EditRenderContext, type EditToolDetails } from "@oh-my-pi/pi-tui/tools/edit";
import { getPaddingX, padding } from "@oh-my-pi/pi-tui/utils";
import { normalizePathForComparison, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TurnFileChange, TurnFileChanges } from "../session/latest-turn-file-changes";
import { cfgDisplayMode } from "./settings";
import type { InteractiveModeContext } from "./types";

function displayPath(cwd: string, file: string): string {
	const relative = path.relative(cwd, file);
	return replaceTabs(
		sanitizeText(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? shortenPath(file) : relative),
	).replace(/[\r\n]+/g, " ");
}

function fileAction(change: TurnFileChange): string {
	return change.before === null ? "新增" : change.after === null ? "删除" : "修改";
}

interface VisibleTurnChanges {
	source: TurnFileChanges;
	revision: number;
	files: TurnFileChange[];
	latest?: { key: string; file: TurnFileChange };
}

/** Editor chrome: its rows can never be retired into terminal history. */
export class CompactFileDiff implements Component {
	readonly #scroll = new ScrollView([], { height: 0, scrollbar: "auto" });
	readonly #diffs = new WeakMap<TurnFileChange, Pick<EditToolDetails, "diff" | "firstChangedLine">>();
	#diffRows = new WeakMap<TurnFileChange, readonly string[]>();
	#cachedTheme = -1;
	#expanded?: { source: TurnFileChanges; firstKey: string };
	#changes?: VisibleTurnChanges;
	#preview?: { file: TurnFileChange; cwd: string; context: EditRenderContext; card: Component };
	#body?: { files: TurnFileChange[]; cwd: string; theme: number; rows: number };

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "ui" | "editor" | "settings">,
		private readonly availableRows: () => number,
	) {}

	#source(): TurnFileChanges | undefined {
		return cfgDisplayMode.get(this.ctx.settings) === "compact"
			? this.ctx.viewSession.getLatestTurnFileChanges()
			: undefined;
	}

	#changed(source: TurnFileChanges): VisibleTurnChanges {
		if (this.#changes?.source === source && this.#changes.revision === source.revision) return this.#changes;
		const files: TurnFileChange[] = [];
		let latest: { key: string; file: TurnFileChange } | undefined;
		for (const [key, file] of source.files) {
			if (file.continuous && file.before === file.after) continue;
			files.push(file);
			if (!latest || file.revision > latest.file.revision) latest = { key, file };
		}
		return (this.#changes = { source, revision: source.revision, files, latest });
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
		this.#changes = undefined;
		this.#preview = undefined;
	}

	sync(source = this.#source(), availableRows = this.availableRows()): void {
		if (this.#changes?.source !== source) {
			this.#changes = undefined;
			this.#clearBody();
			this.#preview = undefined;
		}
		if (
			!this.#expanded ||
			source !== this.#expanded.source ||
			this.ctx.ui.terminal.columns < 2 ||
			availableRows < 2 ||
			!this.#changed(source).latest
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
		const latest = this.#changed(source).latest;
		if (!latest) return false;
		this.#expanded = { source, firstKey: latest.key };
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

	#diff(change: TurnFileChange): Pick<EditToolDetails, "diff" | "firstChangedLine"> {
		let diff = this.#diffs.get(change);
		if (!diff) {
			diff = change.after === null ? { diff: "" } : editDiffString(change.before ?? "", change.after, change.path);
			this.#diffs.set(change, diff);
		}
		return diff;
	}

	/** A confirmed net diff currently represented by the dock; "" denotes a deletion. */
	coveredDiff(file: string, width: number): string | undefined {
		const source = this.#source();
		if (!source || width < 1) return undefined;
		const height = this.availableRows();
		const { latest } = this.#changed(source);
		if (!latest || height < 1) return undefined;
		if (this.#expanded?.source === source && height >= 2 && width >= 2) {
			const change = source.files.get(normalizePathForComparison(file));
			return change?.continuous && change.before !== change.after ? this.#diff(change).diff : undefined;
		}
		const change = latest.file;
		if (!change.continuous || path.relative(file, change.path) !== "") return undefined;
		const bodyWidth = width - Math.min(getPaddingX(1), width - 1);
		const cwd = this.ctx.viewSession.sessionManager.getCwd();
		return this.#previewRows(change, cwd, bodyWidth, height).length ? this.#diff(change).diff : undefined;
	}

	#previewRows(file: TurnFileChange, cwd: string, width: number, height: number): readonly string[] {
		if (height < 1) return [];
		if (!file.continuous) {
			this.#preview = undefined;
			return [];
		}
		// Only framed edits need space for two borders and a body row.
		if (file.after !== null && height < 3) return [];
		if (this.#preview?.file !== file || this.#preview.cwd !== cwd) {
			const context: EditRenderContext = {
				renderDiff: diff => renderDiff(diff, { filePath: file.path }),
				compactDiffPreviewRows: Math.max(1, height - 2),
			};
			const card = editToolRenderer.renderResult(
				{
					content: [],
					details: {
						...this.#diff(file),
						path: file.path,
						op: file.before === null ? "create" : file.after === null ? "delete" : undefined,
					},
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

	#rows(change: TurnFileChange): readonly string[] {
		let lines = this.#diffRows.get(change);
		if (lines) return lines;
		if (!change.continuous) {
			lines = [theme.fg("warning", "本轮差异不可用")];
		} else {
			const { diff } = this.#diff(change);
			lines = diff ? renderDiff(diff, { filePath: change.path }).split("\n") : [];
		}
		this.#diffRows.set(change, lines);
		return lines;
	}

	render(width: number): readonly string[] {
		const source = this.#source();
		const maxRows = width < 1 ? 0 : this.availableRows();
		this.sync(source, maxRows);
		if (!source || maxRows < 1) return [];
		const { files, latest } = this.#changed(source);
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
			const preview = this.#previewRows(latest.file, cwd, bodyWidth, maxRows);
			return preview.length
				? preview.map(line => left + line)
				: [left + theme.fg("accent", truncateToWidth(displayPath(cwd, latest.file.path), bodyWidth))];
		}
		if (this.#body?.files !== files || this.#body.cwd !== cwd || this.#body.theme !== epoch) {
			const lines: string[] = [];
			const first = source.files.get(expanded.firstKey);
			const append = (change: TurnFileChange) => {
				const icon = change.after === null ? `${theme.styledSymbol("tool.delete", "accent")} ` : "";
				lines.push(`${icon}${theme.fg("accent", `${fileAction(change)} ${displayPath(cwd, change.path)}`)}`);
				for (const line of this.#rows(change)) lines.push(line);
			};
			if (first && (!first.continuous || first.before !== first.after)) append(first);
			for (const change of files) {
				if (change !== first) append(change);
			}
			this.#scroll.setLines(lines);
			this.#body = { files, cwd, theme: epoch, rows: lines.length };
		}
		this.#scroll.setHeight(Math.min(maxRows, this.#body.rows));
		return this.#scroll.render(bodyWidth).map(line => left + line);
	}

	describe(cx: DescribeContext): NativeNode {
		return rowsText(this.render(cx.cols));
	}
}
