import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import { Text } from "../src/components/text";
import { md } from "../src/native/describe";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { initTheme } from "../src/theme";
import { Container } from "../src/tui";
import { setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";

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
