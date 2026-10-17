import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import { Text } from "../src/components/text";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { md } from "../src/native/describe";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { initTheme } from "../src/theme";
import { Container } from "../src/tui";
import { setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import type { CoordinationDetails } from "../src/tools/wait";

const toolCx: DescribeContext = {
	cols: 80,
	reduceMotion: false,
	dark: true,
	supports: kind => kind === "tool" || kind === "media",
	feature: () => true,
};
const components: Container[] = [];
const originalImageProtocol = TERMINAL.imageProtocol;
const image: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function nodes(root: NativeNode): NativeNode[] {
	const result = [root];
	for (const child of root.c ?? []) {
		if ("k" in child) result.push(...nodes(child));
	}
	return result;
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const component of components.splice(0)) component.dispose();
	stopSharedSpinnerTicker();
	setChatTranscriptDisplayPreferences({ compactToolActivity: false });
	setTerminalImageProtocol(originalImageProtocol);
});

describe("compact transcript activity", () => {
	it("keeps failure causes and file identities visible in narrow rows on both render paths", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const path = `F:/projects/${"deep/".repeat(30)}missing.ts:2-4`;
		const result = {
			content: [{ type: "text" as const, text: `Path '${path}' not found\nPRIVATE_BODY` }],
			isError: true,
		};
		const component = new ToolExecutionComponent("read", { path }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.updateResult(result);
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		components.push(group);
		group.updateArgs({ path }, "missing");
		group.updateResult(result, false, "missing");
		for (const block of [component, group]) {
			const row = Bun.stripANSI(block.render(70)[0]);
			expect(row).toContain("文件或路径不存在");
			expect(row).toContain("missing.ts:2-4");
			expect(row).not.toContain("deep/");
			const native = JSON.stringify(block.describe(toolCx));
			expect(native).toContain("文件或路径不存在");
			expect(native).toContain("missing.ts:2-4");
			expect(native).not.toContain("PRIVATE_BODY");
		}
	});

	it("uses intent or executable for shell summaries without exposing the script", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		for (const [args, expected] of [
			[{ command: 'bun -e "PRIVATE_SCRIPT"', i: "检查本地输出" }, "检查本地输出"],
			[{ command: 'bun -e "PRIVATE_SCRIPT"' }, "bun"],
		] as const) {
			const component = new ToolExecutionComponent("bash", args, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateArgs({ command: args.command });
			expect(Bun.stripANSI(component.render(70)[0])).toContain(expected);
			expect(component.render(70)[0]).not.toContain("PRIVATE_SCRIPT");
			expect(JSON.stringify(component.describe(toolCx))).toContain(expected);
			expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_SCRIPT");
		}
	});

	it("retains each grouped read intent after execution args omit it", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		components.push(group);
		const streamed = { path: "src/settings.ts", i: "检查用户配置" };
		group.updateArgs(streamed, "settings");
		group.updateArgs({ path: "src/settings.ts" }, "settings");
		group.updateArgs({ path: "src/fallback.ts" }, "fallback");
		group.updateResult({ content: [{ type: "text", text: "PRIVATE_READ_BODY" }] }, false, "settings");
		const rows = group.render(70).map(row => Bun.stripANSI(row));
		expect(rows[0]).toContain("检查用户配置");
		expect(rows[1]).toContain("fallback.ts");
		expect(rows[1]).not.toContain("检查用户配置");
		const native = JSON.stringify(group.describe(toolCx));
		expect(native).toContain("检查用户配置");
		expect(native).toContain("fallback.ts");
		expect(native).not.toContain("PRIVATE_READ_BODY");
	});

	it("keeps source and destination names in compact edit rename summaries", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent(
			"edit",
			{ path: "src/old.ts", rename: "other/new.ts" },
			{},
			undefined,
			{
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			},
		);
		components.push(component);
		component.updateResult({ content: [{ type: "text", text: "PRIVATE_EDIT_BODY" }] });
		expect(Bun.stripANSI(component.render(70)[0])).toContain("old.ts → new.ts");
		expect(JSON.stringify(component.describe(toolCx))).toContain("old.ts → new.ts");
		expect(component.render(70)[0]).not.toContain("PRIVATE_EDIT_BODY");
	});

	it("counts folded successes separately from visible failures and staged proposals", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const make = (name: string, details = {}, isError = false) => {
			const component = new ToolExecutionComponent(name, {}, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateResult({
				content: [{ type: "text", text: isError ? "Permission denied" : "receipt" }],
				details,
				isError,
			});
			transcript.addChild(component);
			return component;
		};
		const proposal = make("ast_edit", { applied: false, totalReplacements: 1 });
		const failure = make("read", {}, true);
		for (let i = 0; i < 5; i++) make("write");
		const rows = transcript.render(100).map(row => Bun.stripANSI(row));
		expect(rows.join("\n")).toContain("已收起 2 次成功调用 · 失败 1 次（保留）");
		expect(rows.some(row => row.includes("待确认") && !row.includes("done"))).toBe(true);
		expect(rows.some(row => row.includes("Permission denied"))).toBe(true);
		expect(failure.getCompactToolFailureCount()).toBe(1);
		const pending = proposal.describe(toolCx);
		expect(JSON.stringify(pending)).toContain("待确认");
		expect(nodes(pending).find(node => node.k === "tool")?.p?.status).toBe("pending");
		const applied = make("write", {
			xdev: { tool: "resolve", inner: { action: "apply", sourceToolName: "ast_edit" } },
		});
		expect(Bun.stripANSI(applied.render(70)[0])).toContain("已应用");
		expect(JSON.stringify(applied.describe(toolCx))).toContain("已应用");
	});

	it("repaints detailed spinner frames without reshaping the body, including after a compact result update", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		let shapes = 0;
		const tool = {
			name: "animated",
			label: "Animated",
			renderResult(result: { content: Array<{ type: string; text?: string }> }, state: { spinnerFrame?: number }) {
				shapes++;
				const output = result.content.map(block => block.text ?? "").join("");
				return { render: () => [`${output} · frame ${state.spinnerFrame ?? 0}`] };
			},
		};
		const component = new ToolExecutionComponent("animated", {}, {}, tool as unknown as AgentTool, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.updateResult({ content: [{ type: "text", text: "FIRST_PROGRESS" }] }, true);
		const initialShapes = shapes;
		for (let frame = 1; frame <= 3; frame++) {
			component.tickSpinner(frame);
			expect(component.render(80).join("\n")).toContain(`FIRST_PROGRESS · frame ${frame}`);
		}
		expect(shapes).toBe(initialShapes);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		component.updateResult({ content: [{ type: "text", text: "NEW_PROGRESS" }] }, true);
		expect(component.render(80).join("\n")).not.toContain("NEW_PROGRESS");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(component.render(80).join("\n")).toContain("NEW_PROGRESS");
		const restoredShapes = shapes;
		component.tickSpinner(4);
		expect(component.render(80).join("\n")).toContain("NEW_PROGRESS · frame 4");
		expect(shapes).toBe(restoredShapes);
	});

	it("bypasses custom output renderers through pending, progress, failure and expansion, then restores detail", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		let renders = 0;
		const tool = {
			name: "custom",
			label: "Custom\noperation",
			renderCall() {
				renders++;
				return new Text("PRIVATE_ARGUMENTS", 0, 0);
			},
			renderResult() {
				renders++;
				return new Text("PRIVATE_OUTPUT", 0, 0);
			},
			describeCall() {
				renders++;
				return { body: [md("PRIVATE_ARGUMENTS")] };
			},
			describeResult() {
				renders++;
				return { body: [md("PRIVATE_OUTPUT")] };
			},
		};
		const component = new ToolExecutionComponent(
			"custom",
			{ path: "target.ts\ncontinued", payload: "PRIVATE_ARGUMENTS" },
			{},
			tool as unknown as AgentTool,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(component);
		expect(component.render(80)).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80)[0])).toContain("pending");
		component.setExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "PRIVATE_PROGRESS" }] }, true);
		expect(Bun.stripANSI(component.render(80)[0])).toContain("running");
		component.updateResult({
			content: [{ type: "text", text: "Permission denied\nPRIVATE_OUTPUT" }, image],
			isError: true,
		});
		component.setExpanded(true);
		component.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		for (const width of [12, 80]) {
			const rows = component.render(width);
			expect(rows).toHaveLength(1);
			expect(rows[0]).not.toContain("\n");
			expect(Bun.stringWidth(rows[0])).toBeLessThanOrEqual(width);
			expect(rows[0]).not.toContain("PRIVATE_");
		}
		expect(Bun.stripANSI(component.render(80)[0])).toContain("Permission denied");
		for (const cx of [toolCx, undefined]) {
			const described = component.describe(cx);
			expect(JSON.stringify(described)).not.toContain("PRIVATE_");
			expect(nodes(described).some(node => node.k === "md" || node.k === "image")).toBe(false);
			if (described.k === "tool") {
				expect(described.p?.status).toBe("error");
				expect(described.p?.collapsible).toBe(false);
				expect(described.c ?? []).toHaveLength(0);
				expect(described.p?.took).toBeNumber();
			}
		}
		expect(renders).toBe(0);
		component.setToolActivityVisible(false);
		expect(component.render(80)).toEqual([]);
		expect(component.describe(toolCx).p?.hidden).toBe(true);
		component.setToolActivityVisible(true);
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		component.invalidate();
		expect(component.render(80).join("\n")).toContain("PRIVATE_OUTPUT");
		expect(JSON.stringify(component.describe(toolCx))).toContain("PRIVATE_OUTPUT");
	});

	it("keeps LSP device writes on one line while streaming and settled, restoring references in detailed mode", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const args = { action: "references", file: "target.ts", line: 1, symbol: "targetSymbol" };
		const component = new ToolExecutionComponent("write", {}, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.updateArgs({ path: "xd://lsp", content: JSON.stringify(args) });
		expect(component.render(80)).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80)[0])).toContain("references targetSymbol");
		component.setExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "PRIVATE_PROGRESS" }] }, true);
		expect(component.render(80)).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80)[0])).toContain("running");
		component.updateResult({
			content: [{ type: "text", text: "2 reference(s)\nPRIVATE_REFERENCE.ts:10:2\nPRIVATE_REFERENCE.ts:20:4" }],
			details: { xdev: { tool: "lsp", mode: "execute", args, inner: { action: "references", success: true } } },
		});
		component.setExpanded(true);
		component.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		for (const width of [12, 80]) {
			const rows = component.render(width);
			expect(rows).toHaveLength(1);
			expect(Bun.stringWidth(rows[0])).toBeLessThanOrEqual(width);
			expect(rows[0]).not.toContain("PRIVATE_");
		}
		expect(Bun.stripANSI(component.render(80)[0])).toContain("done");
		for (const cx of [toolCx, undefined]) {
			const described = component.describe(cx);
			expect(JSON.stringify(described)).not.toContain("PRIVATE_");
			if (described.k === "tool") {
				expect(described.p?.collapsible).toBe(false);
				expect(described.c ?? []).toHaveLength(0);
			}
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("PRIVATE_REFERENCE.ts");
		expect(JSON.stringify(component.describe(toolCx))).toContain("PRIVATE_REFERENCE.ts");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		expect(component.render(80)).toHaveLength(1);
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_REFERENCE.ts");
	});

	it("keeps file writes on one line despite expansion and restores detailed previews", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent(
			"write",
			{ path: "/tmp/preview.ts", content: Array.from({ length: 40 }, (_, i) => `WRITE_LINE_${i + 1};`).join("\n") },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(component);
		expect(component.render(80)).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80)[0])).toContain("preview.ts");
		expect(component.render(80).join("\n")).not.toContain("WRITE_LINE_");
		component.setExpanded(true);
		expect(component.render(80)).toHaveLength(1);
		expect(component.render(80).join("\n")).not.toContain("WRITE_LINE_");
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("WRITE_LINE_");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("WRITE_LINE_1;");
		expect(JSON.stringify(component.describe(toolCx))).toContain("WRITE_LINE_40;");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		component.setToolActivityVisible(false);
		expect(component.render(80)).toEqual([]);
		expect(component.describe(toolCx).p?.hidden).toBe(true);
	});

	it("hides completed edit diffs on compact ANSI and native surfaces while restoring detailed content", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent("edit", { path: "/tmp/preview.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.updateResult({
			content: [{ type: "text", text: "Edited /tmp/preview.ts" }],
			details: { diff: "-1|const BEFORE_EDIT = 1;\n+1|const AFTER_EDIT = 2;", firstChangedLine: 1 },
		});
		for (const compactToolActivity of [true, false, true]) {
			setChatTranscriptDisplayPreferences({ compactToolActivity });
			component.invalidate();
			const rows = component.render(80);
			const rendered = Bun.stripANSI(rows.join("\n"));
			const described = JSON.stringify(component.describe(toolCx));
			if (compactToolActivity) {
				expect(rows).toHaveLength(1);
				expect(rendered).toContain("preview.ts");
				expect(rendered).not.toContain("BEFORE_EDIT");
				expect(rendered).not.toContain("AFTER_EDIT");
				expect(described).not.toContain("BEFORE_EDIT");
				expect(described).not.toContain("AFTER_EDIT");
			} else {
				expect(rendered).toContain("BEFORE_EDIT");
				expect(rendered).toContain("AFTER_EDIT");
				expect(described).toContain("BEFORE_EDIT");
				expect(described).toContain("AFTER_EDIT");
			}
		}
	});

	it("shows waited job commands on compact ANSI and native rows as progress changes without exposing output", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent("wait", {}, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.setExecutionStarted();
		const job: NonNullable<CoordinationDetails["jobs"]>[number] = {
			id: "bg_11",
			type: "bash",
			status: "running",
			label: "bun run slowtest\nPRIVATE_ARGUMENTS",
			durationMs: 27_200,
			resultText: "PRIVATE_OUTPUT",
		};
		const progress = (jobs: CoordinationDetails["jobs"], isPartial = true) =>
			component.updateResult(
				{
					content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
					details: { op: "wait", jobs } satisfies CoordinationDetails,
				},
				isPartial,
			);
		progress([job]);
		expect(Bun.stripANSI(component.render(100)[0])).toContain("[bash] bg_11 bun run slowtest");
		for (const cx of [toolCx, undefined]) {
			const view = JSON.stringify(component.describe(cx));
			expect(view).toContain("[bash] bg_11 bun run slowtest");
			expect(view).not.toContain("PRIVATE_");
		}
		component.setExpanded(true);
		for (const width of [18, 100]) {
			const rows = component.render(width);
			expect(rows).toHaveLength(1);
			expect(Bun.stringWidth(rows[0])).toBeLessThanOrEqual(width);
			expect(rows[0]).not.toContain("PRIVATE_");
		}
		progress([
			{ ...job, status: "completed" },
			{ ...job, id: "bg_12", label: "bun run check:tools" },
		]);
		const updated = Bun.stripANSI(component.render(100)[0]);
		expect(updated).toContain("[bash] bg_12 bun run check:tools");
		expect(updated).toContain("+1");
		expect(updated).not.toContain("slowtest");
		expect(JSON.stringify(component.describe(toolCx))).toContain("bg_12 bun run check:tools");
		progress([{ ...job, status: "completed" }], false);
		expect(Bun.stripANSI(component.render(100)[0])).toContain("bg_11 bun run slowtest");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("bg_11");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		progress([], false);
		expect(component.render(100).join("\n")).not.toContain("bg_11");
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("bg_11");
	});

	it("retains a single row for long built-in calls, successful output and sealed calls", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent(
			"bash",
			{ command: `echo ${"long ".repeat(200)}\nPRIVATE_ARGUMENTS` },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(component);
		component.setExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "PRIVATE_OUTPUT\n".repeat(2000) }] });
		for (const width of [8, 80]) {
			const rendered = component.render(width);
			expect(rendered).toHaveLength(1);
			expect(Bun.stringWidth(rendered[0])).toBeLessThanOrEqual(width);
		}
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_");
		const queued = new ToolExecutionComponent("custom", {}, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(queued);
		queued.seal();
		expect(Bun.stripANSI(queued.render(80)[0])).toContain("cancelled");
	});

	it("keeps each grouped read identity through completion, finalization, sealing and mode changes", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		components.push(group);
		for (const id of ["first", "second"]) {
			group.updateArgs({ path: "same.ts:1-3" }, id);
			group.setExecutionStarted(id);
		}
		expect(group.render(40)).toHaveLength(2);
		group.updateResult({ content: [{ type: "text", text: "PRIVATE_PROGRESS" }] }, true, "first");
		expect(group.render(40)).toHaveLength(2);
		expect(JSON.stringify(group.describe(toolCx))).not.toContain("PRIVATE_PROGRESS");
		group.updateResult({ content: [{ type: "text", text: "PRIVATE_READ_BODY" }] }, false, "first");
		group.updateResult(
			{ content: [{ type: "text", text: "Denied\nPRIVATE_READ_ERROR" }], isError: true },
			false,
			"second",
		);
		group.finalize();
		group.setExpanded(true);
		group.handleNativeEvent({ type: "toggle", key: "pfirst", collapsed: false });
		const compactVersion = group.getTranscriptBlockVersion();
		for (const cx of [toolCx, undefined]) {
			const description = group.describe(cx);
			expect(description.c).toHaveLength(2);
			expect(description.c?.map(child => ("k" in child ? child.key : undefined))).toEqual(["first", "second"]);
			expect(JSON.stringify(description)).not.toContain("PRIVATE_");
		}
		const rows = group.render(80).map(row => Bun.stripANSI(row));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("done");
		expect(rows[1]).toContain("error");
		expect(rows[1]).toContain("Denied");
		group.updateArgs({ path: "unfinished.ts" }, "third");
		group.seal();
		expect(Bun.stripANSI(group.render(80)[2])).toContain("cancelled");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		group.invalidate();
		expect(group.getTranscriptBlockVersion()).not.toBe(compactVersion);
		expect(group.render(80).join("\n")).toContain("PRIVATE_READ_BODY");
		expect(JSON.stringify(group.describe(toolCx))).toContain("PRIVATE_READ_BODY");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		group.setToolActivityVisible(false);
		expect(group.render(80)).toEqual([]);
		expect(group.describe(toolCx).p?.hidden).toBe(true);
	});

	it("never sends hidden thinking markdown to native expansion and keeps its ANSI pulse on one row", () => {
		const component = new AssistantMessageComponent(undefined, true);
		components.push(component);
		const message = assistant([{ type: "thinking", thinking: "PRIVATE_THINKING\ncontinued" }]);
		component.updateContent(message, { transient: true });
		component.handleNativeEvent({ type: "toggle", key: "k0", collapsed: false });
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_THINKING");
		expect(nodes(component.describe(toolCx)).some(node => node.k === "elapsed")).toBe(true);
		const rows = component.render(12).filter(row => Bun.stripANSI(row).trim());
		expect(rows).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toMatch(/Thinking \d+s/);
		component.setHideThinkingBlock(false);
		component.invalidate();
		expect(component.render(80).join("\n")).toContain("PRIVATE_THINKING");
		expect(JSON.stringify(component.describe(toolCx))).toContain("PRIVATE_THINKING");
		component.setHideThinkingBlock(true);
		component.markTranscriptBlockFinalized();
		component.invalidate();
		expect(component.render(80).join("\n")).not.toContain("PRIVATE_THINKING");
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_THINKING");
	});

	it("suppresses tool-result images without suppressing model-authored images, reversibly", () => {
		setTerminalImageProtocol(null);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new AssistantMessageComponent(assistant([image]));
		components.push(component);
		component.setToolResultImages("read", [image], "/repo/tool-only.png");
		component.setToolResultImagesVisible(true);
		const compactImages = nodes(component.describe(toolCx)).filter(node => node.k === "image" || node.k === "media");
		expect(compactImages).toHaveLength(1);
		expect(component.render(80).join("\n")).not.toContain("tool-only.png");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		component.invalidate();
		expect(nodes(component.describe(toolCx)).filter(node => node.k === "image" || node.k === "media")).toHaveLength(
			2,
		);
	});
});
