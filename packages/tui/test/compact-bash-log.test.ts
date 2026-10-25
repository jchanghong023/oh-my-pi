import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ToolExecutionComponent, stopSharedSpinnerTicker } from "../src/chat/tool-execution";
import { initTheme } from "../src/theme";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";

const components: ToolExecutionComponent[] = [];

function bash(toolCallId?: string) {
	const ui = {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		resetDisplay: vi.fn(),
	};
	const component = new ToolExecutionComponent(
		"bash",
		{ command: "bun test" },
		{},
		undefined,
		ui,
		undefined,
		toolCallId,
	);
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

	it("shows a short failure reason immediately", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		component.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("permission denied");
		const native = nativeActivity(component);
		expect(native).toContain("permission denied");
	});

	it("keeps a structured failure cause visible without changing detailed output", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		const original = '{\n  "error": "permission denied"\n}\n]\n,\n\nCommand exited with code 1';
		component.updateResult(
			{ content: [{ type: "text", text: original }], isError: true, details: { exitCode: 1 } },
			false,
		);
		const rows = component.render(80).map(Bun.stripANSI);
		expect(rows.join("\n")).toContain("permission denied");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		const detailed = Bun.stripANSI(component.render(80).join("\n"));
		expect(detailed).toContain("permission denied");
		expect(detailed).toContain("}");
		expect(detailed).toContain("]");
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
