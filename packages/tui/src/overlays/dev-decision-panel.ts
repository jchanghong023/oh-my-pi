import { OverlayPanel, PanelRows } from "../chrome/overlay-box";
import { editorKey } from "../chrome/keybinding-hints";
import { Editor } from "../components/editor";
import { Markdown } from "../components/markdown";
import { ScrollView } from "../components/scroll-view";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { matchesKey } from "../keys";
import { col, item, node, span } from "../native/describe";
import type { NativeChild, NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";
import { routeSgrMouseInput } from "../mouse";
import { getEditorTheme, getMarkdownTheme, theme } from "../theme/theme";
import type { Component, Focusable, TUI } from "../tui";
import { Ellipsis, truncateToWidth } from "../utils";

export interface DevDecisionField {
	id: string;
	label: string;
	value?: string;
	multiline?: boolean;
}

export interface DevDecisionAction {
	id: string;
	label: string;
	group: "decision" | "material" | "manage";
	detail?: string;
	disabledReason?: string;
	fields?: DevDecisionField[];
	inspect?: boolean;
}

export interface DevDecisionModel {
	title: string;
	summary: string;
	actions: DevDecisionAction[];
	initialActionId?: string;
}

export interface DevDecisionResult {
	actionId: string;
	values?: Record<string, string>;
}

const GROUPS = { decision: "阶段决策", material: "查看材料", manage: "管理操作" } as const;

/** A local decision surface: it never changes workflow state until an explicit submission. */
export class DevDecisionPanel extends OverlayPanel implements Focusable {
	readonly nativeOverlay: NonNullable<Component["nativeOverlay"]>;
	focused = false;
	readonly #tui: TUI;
	readonly #model: DevDecisionModel;
	readonly #done: (result: DevDecisionResult | undefined) => void;
	readonly #actions: DevDecisionAction[];
	readonly #editors = new Map<DevDecisionAction, Editor[]>();
	readonly #rows = new PanelRows();
	readonly #material: Markdown;
	readonly #view: ScrollView;
	#selected = 0;
	// 0 actions, 1 materials, 2… fields, last explicit submit.
	#focus = 0;
	#visibleField = 0;
	#bodyRows = 5;
	#scroll: NativeScroll | undefined;
	#closed = false;

	constructor(tui: TUI, model: DevDecisionModel, done: (result: DevDecisionResult | undefined) => void) {
		super(model.title, "omp.overlay.dev-decision");
		this.nativeOverlay = { role: "omp.overlay.dev-decision", size: "lg", anchor: "center", head: model.title };
		this.#tui = tui;
		this.#model = model;
		this.#done = done;
		this.#actions = ["decision", "material", "manage"].flatMap(group => model.actions.filter(a => a.group === group));
		const initial = this.#actions.findIndex(a => a.id === model.initialActionId && !a.disabledReason);
		const safe = this.#actions.findIndex(a => !a.disabledReason && (a.inspect || a.group === "material"));
		this.#selected = Math.max(
			0,
			initial >= 0 ? initial : safe >= 0 ? safe : this.#actions.findIndex(a => !a.disabledReason),
		);
		this.#material = new Markdown(this.#materialText(), 0, 0, getMarkdownTheme());
		this.#view = new ScrollView(this.#material, {
			height: this.#bodyRows,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
		});
		this.addChild(this.#rows);
	}

	get #action(): DevDecisionAction | undefined {
		return this.#actions[this.#selected];
	}

	#fields(): Editor[] {
		const action = this.#action;
		if (!action) return [];
		let editors = this.#editors.get(action);
		if (!editors) {
			editors = (action.fields ?? []).map(field => {
				const editor = new Editor(getEditorTheme());
				editor.setText(field.value ?? "");
				editor.setBorderVisible(false);
				editor.setMaxHeight(field.multiline ? 3 : 1);
				// Editor clears its buffer on its own submit path; keep the field
				// intact even when a native host invokes that path directly.
				editor.onSubmit = (text, raw) => {
					editor.setText(raw ?? text);
					this.#setFocus(this.#focus + 1);
				};
				return editor;
			});
			this.#editors.set(action, editors);
		}
		return editors;
	}

	#materialText(): string {
		const action = this.#action;
		return [this.#model.summary, action?.detail, action?.disabledReason ? `不可执行：${action.disabledReason}` : ""]
			.filter(Boolean)
			.join("\n\n");
	}

	#select(index: number): void {
		if (index < 0 || index >= this.#actions.length) return;
		this.#selected = index;
		this.#focus = 0;
		this.#visibleField = 0;
		this.#material.setText(this.#materialText());
		this.#view.scrollToTop();
		this.#scroll = { by: "start", n: (this.#scroll?.n ?? 0) + 1 };
	}

	#setFocus(index: number): void {
		const fields = this.#fields();
		const count = fields.length + 3;
		this.#focus = (index + count) % count;
		if (this.#focus >= 2 && this.#focus < fields.length + 2) this.#visibleField = this.#focus - 2;
		for (let i = 0; i < fields.length; i++) fields[i]!.focused = this.focused && this.#focus === i + 2;
	}

	#finish(result: DevDecisionResult | undefined): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#done(result);
	}

	#submit(): void {
		const action = this.#action;
		if (!action || action.inspect || action.disabledReason) return;
		const editors = this.#fields();
		const values = Object.fromEntries(
			(action.fields ?? []).map((field, i) => [field.id, editors[i]!.getExpandedText()]),
		);
		this.#finish({ actionId: action.id, ...(editors.length ? { values } : {}) });
	}

	#activate(): void {
		if (this.#action?.inspect || this.#action?.disabledReason) this.#setFocus(1);
		else if (this.#fields().length) this.#setFocus(2);
		else this.#submit();
	}

	#scrollBody(by: NativeScroll["by"]): void {
		this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
		if (by === "start") this.#view.scrollToTop();
		else if (by === "end") this.#view.scrollToBottom();
		else
			this.#view.scroll(
				by === "line-up" ? -1 : by === "line-down" ? 1 : by === "page-up" ? -this.#bodyRows : this.#bodyRows,
			);
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (matchesSelectCancel(data)) {
			this.#finish(undefined);
			return;
		}
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel === null) return false;
				this.#view.scroll(event.wheel * 3);
				return true;
			})
		)
			return;
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#setFocus(this.#focus + (matchesKey(data, "shift+tab") ? -1 : 1));
		} else if (matchesKey(data, "ctrl+enter")) this.#submit();
		else if (matchesSelectPageUp(data) || matchesSelectPageDown(data)) {
			this.#scrollBody(matchesSelectPageUp(data) ? "page-up" : "page-down");
		} else if (this.#focus === 0) {
			if (matchesSelectUp(data)) this.#select((this.#selected - 1 + this.#actions.length) % this.#actions.length);
			else if (matchesSelectDown(data)) this.#select((this.#selected + 1) % this.#actions.length);
			else if (getKeybindings().matches(data, "tui.select.confirm")) this.#activate();
		} else if (this.#focus === 1) {
			if (matchesSelectUp(data)) this.#scrollBody("line-up");
			else if (matchesSelectDown(data)) this.#scrollBody("line-down");
			else if (matchesKey(data, "home")) this.#scrollBody("start");
			else if (matchesKey(data, "end")) this.#scrollBody("end");
		} else if (this.#focus < this.#fields().length + 2) {
			const index = this.#focus - 2;
			if (getKeybindings().matches(data, "tui.input.submit")) {
				if (this.#action?.fields?.[index]?.multiline) this.#fields()[index]!.handleInput("\x1b\r");
				else this.#setFocus(this.#focus + 1);
			} else this.#fields()[index]!.handleInput(data);
		} else if (getKeybindings().matches(data, "tui.select.confirm")) this.#submit();
		this.#tui.requestRender();
	}

	pasteText(text: string): void {
		if (!this.#closed && this.#focus >= 2 && this.#focus < this.#fields().length + 2) {
			this.#fields()[this.#focus - 2]!.pasteText(text);
			this.#tui.requestRender();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#view.invalidate();
		for (const editors of this.#editors.values()) {
			for (const editor of editors) editor.invalidate();
		}
	}

	override dispose(): void {
		this.#closed = true;
		super.dispose();
	}

	override render(width: number): readonly string[] {
		const inner = Math.max(1, width - 4);
		const cap = Math.max(1, this.#tui.terminal.rows - 2);
		const editors = this.#fields();
		this.#setFocus(this.#focus);
		const menuHeight = Math.min(5, this.#actions.length);
		const start = Math.max(
			0,
			Math.min(this.#selected - Math.floor(menuHeight / 2), this.#actions.length - menuHeight),
		);
		const rows = [
			theme.fg(
				this.#focus === 0 ? "accent" : "muted",
				`操作（${this.#actions.length ? this.#selected + 1 : 0}/${this.#actions.length}）`,
			),
		];
		for (let i = start; i < start + menuHeight; i++) {
			const action = this.#actions[i]!;
			const label = `${i === this.#selected ? "›" : " "} 【${GROUPS[action.group]}】${action.label}${action.disabledReason ? "（不可执行）" : ""}`;
			rows.push(theme.fg(i === this.#selected ? "accent" : "muted", truncateToWidth(label, inner)));
		}
		rows.push(theme.fg(this.#focus === 1 ? "accent" : "muted", "阶段与完整材料（可滚动）"));
		const field = this.#action?.fields?.[this.#visibleField];
		const fieldRows = field
			? [
					truncateToWidth(`填写 ${this.#visibleField + 1}/${editors.length}：${field.label}`, inner),
					...editors[this.#visibleField]!.render(inner),
				]
			: [];
		const footer = [
			theme.fg(
				this.#focus === editors.length + 2 ? "accent" : "muted",
				this.#action?.inspect
					? "仅查看材料，不会提交"
					: this.#action?.disabledReason
						? "当前操作不可执行"
						: "［Ctrl+Enter 确认提交当前操作］",
			),
			theme.fg(
				"muted",
				truncateToWidth(
					`Tab 切换 · ${editorKey("tui.select.up")}/${editorKey("tui.select.down")} 导航 · ${editorKey("tui.select.pageUp")}/${editorKey("tui.select.pageDown")} 滚动 · 回车 ${field?.multiline && this.#focus >= 2 && this.#focus < editors.length + 2 ? "换行" : "编辑/确认"} · Esc 取消`,
					inner,
				),
			),
		];
		this.#bodyRows = Math.max(1, cap - 2 - rows.length - fieldRows.length - footer.length);
		this.#view.setHeight(this.#bodyRows);
		this.#rows.setLines([...rows, ...this.#view.render(inner), ...fieldRows, ...footer]);
		return super.render(width).slice(0, cap);
	}

	override describe(): NativeNode {
		this.#setFocus(this.#focus);
		const children: NativeChild[] = [
			selectList(
				"choices",
				this.#actions.map((action, index) =>
					item(`choice-${index}`, {
						label: `【${GROUPS[action.group]}】${action.label}${action.disabledReason ? "（不可执行）" : ""}`,
					}),
				),
				{ selected: `choice-${this.#selected}`, max: { lines: 5 } },
			),
			{ ...col([this.#material], { role: "omp.dev-decision.material" }), key: "material", scroll: this.#scroll },
		];
		for (const [i, field] of (this.#action?.fields ?? []).entries()) {
			children.push(
				node(
					"col",
					{ gap: "xs" },
					[node("text", { spans: [span(field.label)] }), this.#fields()[i]!],
					`field-${i}`,
				),
			);
		}
		children.push(
			actionBar([
				actionButton("取消", "cancel", { keys: "escape" }),
				...(this.#action && !this.#action.inspect && !this.#action.disabledReason
					? [actionButton("确认提交当前操作", "submit", { keys: "ctrl+enter", tone: "accent" })]
					: []),
			]),
		);
		return col(children, { gap: "sm", role: this.nativeRole });
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closed) return;
		if (event.type === "select" || event.type === "activate") {
			const match = /^choice-(\d+)$/.exec(event.item);
			if (match && Number(match[1]) < this.#actions.length) {
				this.#select(Number(match[1]));
				if (event.type === "activate") this.#activate();
			}
		} else if (event.type === "action") {
			if (event.act === "cancel") this.#finish(undefined);
			else if (event.act === "submit") this.#submit();
		}
		this.#tui.requestRender();
	}
}
