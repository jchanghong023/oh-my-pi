import { beforeAll, describe, expect, it } from "bun:test";
import { TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import {
	DevDecisionPanel,
	type DevDecisionModel,
	type DevDecisionResult,
} from "@oh-my-pi/pi-tui/overlays/dev-decision-panel";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const ENTER = "\r";

function mount(model: DevDecisionModel, columns = 100, rows = 28) {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TUI(terminal);
	const results: (DevDecisionResult | undefined)[] = [];
	const panel = new DevDecisionPanel(tui, model, result => results.push(result));
	panel.focused = true;
	const render = () => panel.render(columns).map(line => Bun.stripANSI(line));
	return { panel, results, render, text: () => render().join("\n") };
}

function model(): DevDecisionModel {
	return {
		title: "需求澄清",
		summary: "当前阶段：澄清；提交答案后进入候选方案评审。",
		actions: [
			{
				id: "answer-internal",
				label: "提交本轮答案",
				group: "decision",
				detail: "问题一：目标平台？\n问题二：兼容范围？",
				fields: [
					{ id: "platform", label: "目标平台", value: "Windows" },
					{ id: "scope", label: "兼容范围", multiline: true },
				],
			},
			{
				id: "inspect-internal",
				label: "查看本轮完整问题",
				group: "material",
				detail: "问题一：目标平台？\n问题二：兼容范围？",
				inspect: true,
			},
			{ id: "blocked-internal", label: "批准执行", group: "manage", disabledReason: "必须先完成评审" },
		],
	};
}

function beginAnswer(h: ReturnType<typeof mount>) {
	h.panel.handleInput(UP);
	h.panel.handleInput(ENTER);
}

describe("DevDecisionPanel", () => {
	it("renders an unchecked checkbox, toggles locally by Space/Enter, and submits only explicitly", () => {
		const h = mount({
			title: "批准需求",
			summary: "仅确认提交才推进。",
			actions: [
				{
					id: "confirm-spec",
					label: "确认需求",
					group: "decision",
					fields: [
						{ id: "useTeam", label: "本次方案启用 Team", kind: "checkbox", value: "false" },
						{ id: "confirmation", label: "确认说明", multiline: true },
					],
				},
			],
		});
		expect(h.text()).toContain("本次方案启用 Team");
		h.panel.handleInput(ENTER);
		h.panel.handleInput(" ");
		h.panel.handleInput(ENTER);
		h.panel.pasteText("true");
		expect(h.results).toEqual([]);
		h.panel.handleInput("\x1b[13;5u");
		expect(h.results).toEqual([{ actionId: "confirm-spec", values: { useTeam: "false", confirmation: "" } }]);
	});

	it("cancels checked boxes without submitting and starts a fresh panel unchecked", () => {
		const decision: DevDecisionModel = {
			title: "批准计划",
			summary: "默认关闭 Goal",
			actions: [
				{
					id: "confirm-plan",
					label: "批准计划",
					group: "decision",
					fields: [{ id: "useGoal", label: "本次执行启用原生 Goal", kind: "checkbox" }],
				},
			],
		};
		const h = mount(decision);
		h.panel.handleInput(ENTER);
		h.panel.handleInput(" ");
		expect(h.results).toEqual([]);
		h.panel.handleInput("\x1b");
		h.panel.handleNativeEvent({ type: "action", key: "submit", act: "submit", mods: [] });
		expect(h.results).toEqual([undefined]);
		const fresh = mount(decision);
		fresh.panel.handleInput("\x1b[13;5u");
		expect(fresh.results).toEqual([{ actionId: "confirm-plan", values: { useGoal: "false" } }]);
	});

	it("toggles native checkbox controls without approving, retaining text fields and explicit submit", () => {
		const h = mount({
			title: "批准计划",
			summary: "同一表单",
			actions: [
				{
					id: "confirm-plan",
					label: "批准计划",
					group: "decision",
					fields: [
						{ id: "useGoal", label: "本次执行启用原生 Goal", kind: "checkbox" },
						{ id: "confirmation", label: "确认说明", value: " 原始说明  " },
					],
				},
			],
		});
		const native = h.panel.describe();
		const checkbox = native.c?.[2];
		if (!checkbox || !("k" in checkbox)) throw new Error("Missing checkbox control");
		expect(checkbox.p?.actions).toEqual({ click: "checkbox-0" });
		h.panel.handleNativeEvent({ type: "action", key: "checkbox-0", act: "checkbox-0", mods: [] });
		expect(h.results).toEqual([]);
		h.panel.handleNativeEvent({ type: "action", key: "submit", act: "submit", mods: [] });
		expect(h.results).toEqual([
			{
				actionId: "confirm-plan",
				values: { useGoal: "true", confirmation: " 原始说明  " },
			},
		]);
	});

	it("defaults to material inspection without dispatching Enter, including repeated Enter", () => {
		const h = mount(model());
		expect(h.text()).toContain("› 【查看材料】查看本轮完整问题");
		expect(h.text()).toContain("当前阶段：澄清");
		expect(h.text()).toContain("问题二：兼容范围");
		h.panel.handleInput(ENTER);
		h.panel.handleInput(ENTER);
		expect(h.results).toEqual([]);
		expect(h.text()).not.toContain("inspect-internal");
	});

	it("shows questions and editable fields together, retaining prefill until explicit submit", () => {
		const h = mount(model());
		beginAnswer(h);
		expect(h.text()).toContain("问题一：目标平台");
		expect(h.text()).toContain("填写 1/2：目标平台");
		expect(h.text()).toContain("Windows");
		h.panel.handleInput(" 中文");
		h.panel.handleInput(ENTER);
		expect(h.text()).toContain("填写 2/2：兼容范围");
		h.panel.handleInput("第一行");
		h.panel.handleInput(ENTER);
		h.panel.handleInput("第二行");
		expect(h.results).toEqual([]);
		h.panel.handleInput(TAB);
		h.panel.handleInput(ENTER);
		expect(h.results).toEqual([
			{ actionId: "answer-internal", values: { platform: "Windows 中文", scope: "第一行\n第二行" } },
		]);
	});

	it("cancels edited fields without returning an action and finishes only once", () => {
		const h = mount(model());
		beginAnswer(h);
		h.panel.pasteText("取消的草稿");
		h.panel.handleInput("\x1b");
		h.panel.handleInput(ENTER);
		h.panel.handleNativeEvent({ type: "action", key: "submit", act: "submit", mods: [] });
		expect(h.results).toEqual([undefined]);
	});

	it("retains field edits when inspecting another action and returning", () => {
		const h = mount(model());
		beginAnswer(h);
		h.panel.handleInput(" ARM");
		// Field 1 → field 2 → submit → actions.
		for (let i = 0; i < 3; i++) h.panel.handleInput(TAB);
		h.panel.handleInput(DOWN);
		h.panel.handleInput(UP);
		h.panel.handleInput(ENTER);
		expect(h.text()).toContain("Windows ARM");
		expect(h.results).toEqual([]);
	});

	it("shows disabled reasons and rejects both keyboard and native submission", () => {
		const h = mount(model());
		h.panel.handleInput(DOWN);
		expect(h.text()).toContain("必须先完成评审");
		h.panel.handleInput(ENTER);
		h.panel.handleNativeEvent({ type: "action", key: "submit", act: "submit", mods: [] });
		expect(h.results).toEqual([]);
	});

	for (const [columns, rows] of [
		[100, 28],
		[120, 36],
	]) {
		it(`keeps long materials, every action and every field reachable at ${columns}x${rows}`, () => {
			const detail = Array.from({ length: 160 }, (_, i) => `材料第${i}行：中文宽度与授权范围。`).join("\n");
			const h = mount(
				{
					title: "完整计划",
					summary: "审批后将执行此计划。",
					actions: Array.from({ length: 30 }, (_, i) => ({
						id: `action-${i}`,
						label: `操作${i}`,
						group: "decision",
						detail,
						fields: Array.from({ length: 12 }, (_, j) => ({
							id: `field-${j}`,
							label: `字段${j}`,
							value: `内容${j}`,
						})),
					})),
				},
				columns,
				rows,
			);
			for (let i = 0; i < 29; i++) h.panel.handleInput(DOWN);
			expect(h.text()).toContain("操作29");
			h.panel.handleInput(TAB);
			h.panel.handleInput("\x1b[F");
			expect(h.text()).toContain("材料第159行");
			h.panel.handleInput(TAB);
			for (let i = 0; i < 11; i++) h.panel.handleInput(TAB);
			expect(h.text()).toContain("字段11");
			expect(h.text()).toContain("内容11");
			const rendered = h.render();
			expect(rendered.length).toBeLessThanOrEqual(rows);
			for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
			expect(h.results).toEqual([]);
		});

		it(`advertises the working multiline submit chord without hiding navigation at ${columns}x${rows}`, () => {
			const h = mount(model(), columns, rows);
			beginAnswer(h);
			h.panel.handleInput(ENTER);
			h.panel.handleInput("第一行");
			h.panel.handleInput(ENTER);
			h.panel.handleInput("第二行");
			const text = h.text();
			for (const hint of ["Ctrl+Enter", "确认提交当前操作", "回车 换行", "Tab 切换", "滚动", "Esc 取消"]) {
				expect(text).toContain(hint);
			}
			expect(h.results).toEqual([]);
			const native = h.panel.describe();
			const actions = native.c?.at(-1);
			if (!actions || !("k" in actions)) throw new Error("Missing native actions");
			const submit = actions.c?.at(-1);
			if (!submit || !("k" in submit)) throw new Error("Missing native submit");
			const keycap = submit.c?.at(-1);
			if (!keycap || !("k" in keycap) || keycap.k !== "kbd") throw new Error("Missing native submit shortcut");
			expect(keycap.p?.keys).toEqual(["ctrl", "enter"]);
			h.panel.handleInput("\x1b[13;5u");
			expect(h.results).toEqual([
				{
					actionId: "answer-internal",
					values: { platform: "Windows", scope: "第一行\n第二行" },
				},
			]);
		});
	}

	it("native selection/activation inspect safely and native submit returns the same fields", () => {
		const h = mount(model());
		h.panel.handleNativeEvent({ type: "activate", key: "choices", item: "choice-1" });
		expect(h.results).toEqual([]);
		h.panel.handleNativeEvent({ type: "select", key: "choices", item: "choice-0" });
		expect(h.text()).toContain("目标平台");
		const description = h.panel.describe();
		expect(description.k).toBe("col");
		expect(description.c?.length).toBe(5);
		const field = description.c?.[2];
		if (!field || !("k" in field)) throw new Error("Missing native field");
		const editor = field.c?.[1];
		if (!editor || !("render" in editor)) throw new Error("Missing native editor");
		editor.handleNativeEvent?.({ type: "edit", key: "", from: 0, to: 7, text: "Linux", cursor: 5, len: 7 });
		h.panel.handleNativeEvent({ type: "action", key: "submit", act: "submit", mods: [] });
		expect(h.results).toEqual([{ actionId: "answer-internal", values: { platform: "Linux", scope: "" } }]);
	});

	it("supports no actions and rejects an unknown native selection", () => {
		const h = mount({ title: "暂无操作", summary: "请等待当前工作完成。", actions: [] });
		h.panel.handleInput(DOWN);
		h.panel.handleInput(ENTER);
		h.panel.handleNativeEvent({ type: "activate", key: "choices", item: "choice-999" });
		expect(h.text()).toContain("请等待当前工作完成");
		expect(h.results).toEqual([]);
		h.panel.handleInput("\x1b");
		expect(h.results).toEqual([undefined]);
	});

	it("submits an explicitly chosen fieldless decision, honoring an initial inspect action", () => {
		const h = mount({
			title: "计划授权",
			summary: "批准后允许执行已列出的修改。",
			initialActionId: "read",
			actions: [
				{ id: "approve", label: "批准计划", group: "decision" },
				{ id: "read", label: "阅读授权", group: "material", inspect: true },
			],
		});
		h.panel.handleInput(ENTER);
		expect(h.results).toEqual([]);
		// Return from material focus to actions, then choose approval.
		h.panel.handleInput("\x1b[Z");
		h.panel.handleInput(UP);
		h.panel.handleInput(ENTER);
		expect(h.results).toEqual([{ actionId: "approve" }]);
	});
});
