import * as path from "node:path";
import { editDiffString } from "@oh-my-pi/pi-natives";
import { matchesKey, type Component } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { renderDiff } from "@oh-my-pi/pi-tui/chrome/diff";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { rowsText } from "@oh-my-pi/pi-tui/native/spans";
import { replaceTabs, shortenPath, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThemeEpoch, theme } from "@oh-my-pi/pi-tui/theme";
import { editToolRenderer, type EditRenderContext, type EditToolDetails } from "@oh-my-pi/pi-tui/tools/edit";
import { getPaddingX, padding } from "@oh-my-pi/pi-tui/utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TurnFileChange, TurnFileChanges } from "../session/latest-turn-file-changes";
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
	#body?: { files: TurnFileChange[]; cwd: string; theme: number; count: number };

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "ui" | "editor" | "keybindings">,
		private readonly availableRows: () => number,
	) {}

	#source(): TurnFileChanges | undefined {
		return this.ctx.viewSession.getLatestTurnFileChanges();
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
		if (!this.#expanded) return;
		this.#expanded = undefined;
		this.#clearBody();
		if (this.ctx.ui.getFocused() === this) this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	sync(source = this.#source(), availableRows = this.availableRows()): void {
		if (this.#changes?.source !== source) {
			this.#changes = undefined;
			this.#clearBody();
			this.#preview = undefined;
		}
		if (this.#expanded && (source !== this.#expanded.source || availableRows < 2 || !this.#changed(source).latest)) {
			this.close();
		}
	}

	toggle(): boolean {
		if (this.#expanded) {
			this.close();
			return true;
		}
		const source = this.#source();
		const latest = source && this.#changed(source).latest;
		if (!source || !latest) return false;
		const focus = this.ctx.ui.getFocused();
		if (focus !== this.ctx.editor || this.availableRows() < 2) return false;
		this.#expanded = { source, firstKey: latest.key };
		this.#scroll.scrollToTop();
		this.ctx.ui.setFocus(this);
		this.ctx.ui.requestRender();
		return true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.close();
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

	/** Return the shown net diff, or an empty string for the upstream inline deletion row. */
	coveredDiff(file: string, width: number): string | undefined {
		if (!chatTranscriptDisplayPreferences.compactToolActivity || width < 1) return undefined;
		const source = this.#source();
		const height = this.availableRows();
		if (!source?.files.size || height < 2) return undefined;
		const { files, latest } = this.#changed(source);
		if (!latest) return undefined;
		if (this.#expanded?.source === source) {
			const change = files.find(change => path.relative(file, change.path) === "");
			return change?.continuous ? this.#diff(change).diff : undefined;
		}
		const change = latest.file;
		if (!change.continuous || path.relative(file, change.path) !== "") return undefined;
		const inset = Math.min(getPaddingX(1), width - 1);
		const cwd = this.ctx.viewSession.sessionManager.getCwd();
		const previewHeight = height - (change.after === null ? 1 : 2);
		return this.#previewRows(change, cwd, width - inset, previewHeight).length ? this.#diff(change).diff : undefined;
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
		if (file.after !== null) this.#preview.context.diffPreviewRows = height - 2;
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
		if (!chatTranscriptDisplayPreferences.compactToolActivity || width < 1) return [];
		const source = this.#source();
		const maxRows = this.availableRows();
		this.sync(source, maxRows);
		if (!source?.files.size || maxRows < 1) return [];
		const { files, latest } = this.#changed(source);
		if (!latest) {
			this.#preview = undefined;
			return [];
		}
		const left = padding(Math.min(getPaddingX(1), width - 1));
		const bodyWidth = width - left.length;
		const cwd = this.ctx.viewSession.sessionManager.getCwd();
		const expanded = this.#expanded;
		const title = `本轮改动 ${files.length} 文件`;
		const key = appKey(this.ctx.keybindings, "app.tools.expand");
		const hint = expanded ? "↑/↓ 滚动 · Esc 收起" : key ? `${key} 查看全部` : "";
		const head = hint && maxRows > 1 ? `${title} · ${hint}` : title;
		const header = left + theme.fg("accent", truncateToWidth(head, bodyWidth));
		if (maxRows < 2) return [header];
		const epoch = getThemeEpoch();
		if (this.#cachedTheme !== epoch) {
			this.#cachedTheme = epoch;
			this.#diffRows = new WeakMap();
			this.#preview = undefined;
		}
		if (!expanded) {
			const inline = latest.file.after === null;
			const preview = this.#previewRows(latest.file, cwd, bodyWidth, maxRows - (inline ? 1 : 2));
			if (!preview.length) return [header];
			return [header, ...(inline ? [] : [""]), ...preview.map(line => left + line)];
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
			this.#body = { files, cwd, theme: epoch, count: lines.length };
		}
		this.#scroll.setHeight(Math.min(maxRows - 1, this.#body.count));
		return [header, ...this.#scroll.render(bodyWidth).map(line => left + line)];
	}

	describe(cx: DescribeContext): NativeNode {
		return rowsText(this.render(cx.cols));
	}
}
