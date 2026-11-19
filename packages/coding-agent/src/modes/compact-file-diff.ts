import * as path from "node:path";
import { editDiffString } from "@oh-my-pi/pi-natives";
import { matchesKey, type Component } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { renderDiff } from "@oh-my-pi/pi-tui/chrome/diff";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { rowsText } from "@oh-my-pi/pi-tui/native/spans";
import { replaceTabs, shortenPath, truncateMiddleToWidth, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThemeEpoch, theme } from "@oh-my-pi/pi-tui/theme";
import { getPaddingX, padding, visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TurnFileChange, TurnFileChanges } from "../session/latest-turn-file-changes";
import type { InteractiveModeContext } from "./types";

function displayPath(cwd: string, file: string): string {
	const relative = path.relative(cwd, file);
	return replaceTabs(
		sanitizeText(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? shortenPath(file) : relative),
	).replace(/[\r\n]+/g, " ");
}

/** Editor chrome: its rows can never be retired into terminal history. */
export class CompactFileDiff implements Component {
	readonly #scroll = new ScrollView([], { height: 0, scrollbar: "auto" });
	#diffRows = new WeakMap<TurnFileChange, readonly string[]>();
	#cachedTheme = -1;
	#expanded?: TurnFileChanges;
	#changes?: { source: TurnFileChanges; revision: number; files: TurnFileChange[] };
	#body?: { files: TurnFileChange[]; cwd: string; theme: number; count: number };

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "ui" | "editor" | "keybindings">,
		private readonly availableRows: () => number,
	) {}

	#source(): TurnFileChanges | undefined {
		return this.ctx.viewSession.getLatestTurnFileChanges();
	}

	#changed(source: TurnFileChanges): TurnFileChange[] {
		if (this.#changes?.source === source && this.#changes.revision === source.revision) return this.#changes.files;
		const files = [...source.files.values()].filter(change => !change.continuous || change.before !== change.after);
		this.#changes = { source, revision: source.revision, files };
		return files;
	}

	close(): void {
		if (!this.#expanded) return;
		this.#expanded = undefined;
		this.#body = undefined;
		this.#scroll.setLines([]);
		if (this.ctx.ui.getFocused() === this) this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	sync(source = this.#source(), availableRows = this.availableRows()): void {
		if (this.#changes?.source !== source) this.#changes = undefined;
		if (this.#expanded && (source !== this.#expanded || availableRows < 2 || this.#changed(source).length === 0)) {
			this.close();
		}
	}

	toggle(): boolean {
		if (this.#expanded) {
			this.close();
			return true;
		}
		const source = this.#source();
		if (!source || this.#changed(source).length === 0) return false;
		const focus = this.ctx.ui.getFocused();
		if (focus !== this.ctx.editor || this.availableRows() < 2) return false;
		this.#expanded = source;
		this.#scroll.scrollToTop();
		this.ctx.ui.setFocus(this);
		this.ctx.ui.requestRender();
		return true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.close();
		else if (this.#scroll.handleScrollKey(data)) this.ctx.ui.requestRender();
	}

	#rows(change: TurnFileChange): readonly string[] {
		let lines = this.#diffRows.get(change);
		if (lines) return lines;
		if (!change.continuous) {
			lines = [theme.fg("warning", "两次写入之间内容另有变化，无法确认本轮净差异。")];
		} else {
			const { diff } = editDiffString(change.before ?? "", change.after ?? "", change.path);
			lines = diff ? renderDiff(diff, { filePath: change.path }).split("\n") : [];
		}
		this.#diffRows.set(change, lines);
		return lines;
	}

	render(width: number): readonly string[] {
		if (!chatTranscriptDisplayPreferences.compactToolActivity || width < 1) return [];
		const source = this.#source();
		const maxRows = this.availableRows();
		if (this.#expanded) this.sync(source, maxRows);
		if (!source?.files.size) return [];
		const changes = this.#changed(source);
		if (changes.length === 0 || maxRows < 1) return [];
		const left = padding(Math.min(getPaddingX(1), width - 1));
		const bodyWidth = width - left.length;
		const cwd = this.ctx.viewSession.sessionManager.getCwd();
		const expanded = source === this.#expanded;
		const title = `本轮改动 ${changes.length} 文件`;
		const key = appKey(this.ctx.keybindings, "app.tools.expand");
		const hint = expanded ? "↑/↓ 滚动 · Esc 收起" : key ? `${key} 查看 diff` : "";
		const head = `${title}${hint ? ` · ${hint}` : ""}`;
		const first = displayPath(cwd, changes[0]!.path);
		const remaining = bodyWidth - visibleWidth(head) - 3;
		const header =
			left +
			theme.fg("accent", truncateToWidth(head, bodyWidth)) +
			(!expanded && remaining > 0 ? theme.fg("muted", ` · ${truncateMiddleToWidth(first, remaining)}`) : "");
		if (!expanded || maxRows === 1) return [header];
		const epoch = getThemeEpoch();
		if (this.#cachedTheme !== epoch) {
			this.#cachedTheme = epoch;
			this.#diffRows = new WeakMap();
		}
		if (this.#body?.files !== changes || this.#body.cwd !== cwd || this.#body.theme !== epoch) {
			const lines: string[] = [];
			for (const change of changes) {
				const action = change.before === null ? "新增" : change.after === null ? "删除" : "修改";
				lines.push(theme.fg("accent", `${action} ${displayPath(cwd, change.path)}`));
				for (const line of this.#rows(change)) lines.push(line);
			}
			this.#scroll.setLines(lines);
			this.#body = { files: changes, cwd, theme: epoch, count: lines.length };
		}
		this.#scroll.setHeight(Math.min(maxRows - 1, this.#body.count));
		return [header, ...this.#scroll.render(bodyWidth).map(line => left + line)];
	}

	describe(cx: DescribeContext): NativeNode {
		return rowsText(this.render(cx.cols));
	}
}
