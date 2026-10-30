import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ToolExecutionComponent, stopSharedSpinnerTicker } from "../src/chat/tool-execution";
import { initTheme } from "../src/theme";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";

const components: ToolExecutionComponent[] = [];

function bash(toolCallId?: string, command = "bun test") {
	const ui = {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		resetDisplay: vi.fn(),
	};
	const component = new ToolExecutionComponent("bash", { command }, {}, undefined, ui, undefined, toolCallId);
	components.push(component);
	component.setExecutionStarted();
	return { component, ui };
}

function output(component: ToolExecutionComponent, text: string, details?: unknown, partial = true): void {
	component.updateResult({ content: [{ type: "text", text }], details }, partial);
}

function nativeActivity(component: ToolExecutionComponent): string {
	return JSON.stringify(
		component.describe({
			cols: 80,
			dark: true,
			reduceMotion: false,
			supports: () => true,
			feature: () => true,
		}),
	);
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const component of components.splice(0)) component.dispose();
	stopSharedSpinnerTicker();
	setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("compact upstream tool feedback", () => {
	it("counts only an applied file change as an edit-like write", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const patch = new ToolExecutionComponent("apply_patch", {}, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(patch);
		patch.updateResult({ content: [], details: { perFileResults: [] } }, false);
		expect(patch.isCompactActualFileWrite()).toBe(false);
		patch.updateResult({ content: [], details: { perFileResults: [{ path: "file.ts", diff: "+new" }] } }, false);
		expect(patch.isCompactActualFileWrite()).toBe(true);
	});

	it("shows invocation errors without a process failure or user action", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		component.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("permission denied");
		expect(nativeActivity(component)).toContain("permission denied");
	});

	it("previews literal error tails while retaining structured diagnostics in detailed mode", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		const original = '{\n  "error": "permission denied"\n}\n]\n,\n\nCommand exited with code 1';
		component.updateResult(
			{ content: [{ type: "text", text: original }], isError: true, details: { exitCode: 1 } },
			false,
		);
		const rows = component.render(80).map(Bun.stripANSI);
		expect(rows.join("\n")).not.toContain("permission denied");
		expect(rows.some(row => row.includes("]"))).toBe(true);
		expect(nativeActivity(component)).not.toContain("permission denied");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		const detailed = Bun.stripANSI(component.render(80).join("\n"));
		expect(detailed).toContain("permission denied");
		expect(detailed).toContain("}");
		expect(detailed).toContain("]");
		expect(nativeActivity(component)).toContain("permission denied");
	});

	it("bounds failed heredocs to one command row and the last two nonblank output rows", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const command = "python3 - <<'EOF'\nprint('script body')\nEOF";
		const { component } = bash(undefined, command);
		const original = [
			"code units: ['0xd83d', '0xdda5']",
			"Traceback (most recent call last):",
			'  File "<stdin>", line 4, in <module>',
			"",
			`UnicodeEncodeError: surrogates not allowed ${"x".repeat(150)}`,
			"  ",
			"\u001b[31m \u001b[0m",
			"Command exited with code 1",
		].join("\n");
		component.updateResult(
			{ content: [{ type: "text", text: original }], isError: true, details: { exitCode: 1 } },
			false,
		);
		const rows = component.render(80).map(Bun.stripANSI);
		const compact = rows.join("\n");
		expect(compact).toContain("python3");
		expect(compact).not.toContain("script body");
		expect(compact).not.toContain("Traceback");
		expect(compact).not.toContain("code units");
		expect(rows.filter(row => row.includes("<stdin>") || row.includes("UnicodeEncodeError"))).toHaveLength(2);
		expect(compact).not.toContain("x".repeat(150));
		expect(compact).not.toContain("Failed");
		expect(compact).not.toContain("Exit: 1");
		expect(nativeActivity(component)).not.toContain("Traceback");
		expect(nativeActivity(component)).toContain("UnicodeEncodeError");
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(80).join("\n"));
		expect(expanded).toContain("Traceback");
		expect(expanded).toContain("script body");
		expect(nativeActivity(component)).toContain("code units");
		component.setExpanded(false);
		expect(component.render(80).map(Bun.stripANSI)).toEqual(rows);
	});

	it("applies compact error previews to Bash dispatched through write across mode and expansion changes", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const command = "python3 - <<'EOF'\nprint('script body')\nEOF";
		const write = new ToolExecutionComponent(
			"write",
			{ path: "xd://bash", content: JSON.stringify({ command }) },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(write);
		write.setExecutionStarted();
		write.updateResult(
			{
				content: [
					{
						type: "text",
						text: "first output\nsecond output\n\n\u001b[31m \u001b[0m\nthird output\nCommand exited with code 1",
					},
				],
				isError: true,
				details: { xdev: { tool: "bash", mode: "execute", args: { command }, inner: { exitCode: 1 } } },
			},
			false,
		);
		const render = () => Bun.stripANSI(write.render(80).join("\n"));
		const compact = render();
		expect(compact).toContain("python3");
		expect(compact).not.toContain("script body");
		expect(compact).not.toContain("first output");
		expect(compact).toContain("second output");
		expect(compact).toContain("third output");
		expect(compact).not.toContain("Failed");
		expect(compact).not.toContain("Exit: 1");

		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(render()).toContain("script body");
		expect(render()).toContain("first output");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		expect(render()).toBe(compact);
		write.setExpanded(true);
		expect(render()).toContain("script body");
		expect(render()).toContain("first output");
		write.setExpanded(false);
		expect(render()).toBe(compact);
	});

	it("retains an input-blocked call outside the two normal previews", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const blocked = bash().component;
		output(blocked, "ORIGINAL_BLOCKED_OUTPUT: Confirm command");
		blocked.setCompactNeedsUserInput("Confirm command");
		transcript.addChild(blocked);
		transcript.addChild(bash().component);
		transcript.addChild(bash().component);
		expect(blocked.hasCompactCriticalFeedback()).toBe(true);
		expect(Bun.stripANSI(transcript.render(80).join("\n"))).toContain("ORIGINAL_BLOCKED_OUTPUT: Confirm command");
		const document = new TspDocument("s:input-blocked");
		const ops = new Reconciler("s:input-blocked").reconcile(
			{ main: transcript.nativeBlocks(), dock: [], layer: [] },
			{
				cols: 80,
				dark: true,
				reduceMotion: false,
				supports: () => true,
				feature: () => true,
			},
		);
		expect(document.applyFrame({ sf: "s:input-blocked", s: 1, ops })).toEqual([]);
		expect(JSON.stringify(document.snapshot())).toContain("ORIGINAL_BLOCKED_OUTPUT: Confirm command");
		blocked.setCompactNeedsUserInput(undefined);
		expect(blocked.hasCompactCriticalFeedback()).toBe(false);
	});

	it("offers the complete multi-line command through the existing expand control", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const command = `bun test ${"x".repeat(600)}\necho finished`;
		const component = new ToolExecutionComponent("bash", { command }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		const summary = JSON.stringify(component.describe());
		expect(summary).not.toContain("echo finished");
		component.setExpanded(true);
		const expanded = JSON.stringify(component.describe());
		expect(expanded).toContain("echo finished");
		expect(expanded).toContain("x".repeat(600));
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("echo finished");
		component.updateResult({ content: [{ type: "text", text: "raw process output" }] }, false);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("raw process output");
		expect(nativeActivity(component)).toContain("raw process output");
	});

	it("keeps the same actual-call identity after a provider ID correction", () => {
		const { component } = bash("provisional");
		const identity = component.getCompactToolCalls()[0]!.id;
		component.updateToolCallId("corrected");
		expect(component.getCompactToolCalls()[0]!.id).toBe(identity);
		expect(component.toolCallId).toBe("corrected");
	});

	it("keeps upstream write collapse and expansion controls", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const content = Array.from({ length: 80 }, (_, index) => `const line${index} = ${index};`).join("\n");
		const write = new ToolExecutionComponent("write", { path: "output.ts", content }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(write);
		write.updateResult({ content: [{ type: "text", text: "Wrote output.ts" }] }, false);
		expect(write.isCompactActualFileWrite()).toBe(true);
		const collapsed = write.render(100).length;
		const collapsedNative = JSON.stringify(write.describe());
		write.setExpanded(true);
		expect(write.render(100).length).toBeGreaterThan(collapsed);
		expect(JSON.stringify(write.describe())).not.toBe(collapsedNative);
		write.setExpanded(false);
		expect(write.render(100)).toHaveLength(collapsed);
		expect(JSON.stringify(write.describe())).toBe(collapsedNative);
	});
});
