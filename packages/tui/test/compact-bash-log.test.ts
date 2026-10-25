import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { parksAsBackground, ToolExecutionComponent, stopSharedSpinnerTicker } from "../src/chat/tool-execution";
import { initTheme } from "../src/theme";
import { TranscriptContainer } from "../src/chrome/transcript-container";

let now = 1_000;
const components: ToolExecutionComponent[] = [];

function bash() {
	const ui = {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		resetDisplay: vi.fn(),
	};
	const component = new ToolExecutionComponent("bash", { command: "bun test" }, {}, undefined, ui);
	components.push(component);
	component.setExecutionStarted();
	return { component, ui };
}

function output(component: ToolExecutionComponent, text: string, details?: unknown, partial = true): void {
	component.updateResult({ content: [{ type: "text", text }], details }, partial);
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

describe("compact Bash live logs", () => {
	it("shares one status and the latest five timestamped log lines across tasks", () => {
		now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		const first = bash().component;
		const second = bash().component;
		transcript.addChild(first);
		transcript.addChild(second);
		now = 2_000;
		output(first, "a1\na2\n");
		now = 3_000;
		output(second, "b1\nb2\n");
		now = 32_000;
		output(first, "a1\na2\na3\n");
		now = 33_000;
		output(second, "b1\nb2\nb3\n");
		const rows = (transcript.compactToolActivityBlock()?.render(160) ?? []).map(Bun.stripANSI);
		// Two call previews, followed by the shared six-line log window.
		expect(rows).toHaveLength(8);
		expect(rows[2]).toContain("已运行");
		expect(rows.slice(3)).toEqual(["[任务1] a2", "[任务2] b1", "[任务2] b2", "[任务1] a3", "[任务2] b3"]);
		expect(rows.join("\n")).not.toContain("a1");
	});
	it("projects the original write card with only the latest call auto-expanded", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const edit = new ToolExecutionComponent("edit", { path: "file.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(edit);
		edit.setExecutionStarted();
		edit.updateResult(
			{ content: [{ type: "text", text: "changed" }], details: { diff: "@@ -1 +1 @@\n-old\n+new" } },
			false,
		);
		expect(edit.renderCompactFileWriteRows(80, false)).toEqual(edit.renderOriginalFileWriteRows(80));
		expect(Bun.stripANSI(edit.renderCompactFileWriteRows(80, true).join("\n"))).toContain("+new");
		const folded = edit.describeCompactFileWrite(undefined, false);
		const open = edit.describeCompactFileWrite(undefined, true);
		if (folded.k !== "card" || open.k !== "card") throw new Error("expected upstream edit cards");
		expect(folded.p?.collapsed).toBe(true);
		expect(open.p?.collapsed).toBe(false);
		expect(edit.renderCompactActivityRows(80)).toHaveLength(1);
	});

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
		vi.spyOn(performance, "now").mockImplementation(() => now);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		now += 500;
		component.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);
		expect(Bun.stripANSI(component.compactBashLogRows(80).join("\n"))).toContain("permission denied");
		expect(JSON.stringify(component.compactBashLogNodes(80))).toContain('"s":"error"');
	});

	it("shows input wait immediately in the compact call and log area", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		component.setCompactNeedsUserInput("Confirm command");
		expect(Bun.stripANSI(component.renderCompactActivityRows(80).join("\n"))).toContain("等待用户输入");
		expect(Bun.stripANSI(component.compactBashLogRows(80).join("\n"))).toContain("Confirm command");
		expect(JSON.stringify(component.compactBashLogNodes(80))).toContain('"s":"warning"');
		component.setCompactNeedsUserInput(undefined);
		expect(Bun.stripANSI(component.renderCompactActivityRows(80).join("\n"))).not.toContain("等待用户输入");
	});

	it("shows runtime and explicit no-output or last-output age after the delay", () => {
		vi.spyOn(performance, "now").mockImplementation(() => now);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		now += 30_001;
		expect(Bun.stripANSI(component.compactBashLogRows(80).join("\n"))).toContain("尚无输出");
		expect(Bun.stripANSI(component.compactBashLogRows(80).join("\n"))).toContain("已运行 30s");
		output(component, "progress");
		now += 8_000;
		output(component, "progress");
		const rows = Bun.stripANSI(component.compactBashLogRows(80).join("\n"));
		expect(rows).toContain("progress");
		expect(rows).toContain("距上次输出 8s");
	});

	it("selects only calls that actually started and are still running", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent("bash", { command: "sleep 60" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		expect(component.isCompactToolRunning()).toBe(false);
		component.setExecutionStarted();
		expect(component.isCompactToolRunning()).toBe(true);
		expect(component.renderCompactRunningActivityRows(80)).toHaveLength(1);
		component.updateResult({ content: [] }, false);
		expect(component.isCompactToolRunning()).toBe(false);
	});

	it("never exposes output from a command that finishes before the delay", () => {
		vi.spyOn(performance, "now").mockImplementation(() => now);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		output(component, "short command output");
		now += 29_999;
		output(component, "short command output", undefined, false);
		expect(component.compactBashLogRows(80)).toEqual([]);
		expect(component.compactBashLogNodes(80)).toEqual([]);
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
		expect(component.compactBashCommandRows(80).join("\n")).toContain("echo finished");
	});

	it("waits more than 30 seconds, then follows the latest output without changing the call summary", () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => now);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component, ui } = bash();
		output(component, "old\nrecent one\nrecent two");
		now += 30_000;
		expect(component.compactBashLogRows(80)).toEqual([]);
		now += 1;
		expect(component.compactBashLogRows(80).join("\n")).toContain("recent two");
		expect(component.renderCompactActivityRows(80)).toHaveLength(1);
		output(component, "new one\nnew two");
		expect(component.compactBashLogRows(80).join("\n")).toContain("new two");
		expect(component.compactBashLogRows(80).join("\n")).not.toContain("old");
		vi.advanceTimersByTime(1_000);
		expect(ui.requestComponentRender).toHaveBeenCalled();
		output(component, "final", undefined, false);
		expect(component.compactBashLogRows(80)).toEqual([]);
	});

	it("keeps one Bash log window across foreground to background handoff", () => {
		vi.spyOn(performance, "now").mockImplementation(() => now);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const { component } = bash();
		output(component, "foreground", { async: { state: "running" } });
		now += 30_001;
		expect(component.compactBashLogRows(80).join("\n")).toContain("foreground");
		const running = { async: { state: "running" } };
		expect(parksAsBackground("bash", running)).toBe(true);
		output(component, "handoff", running, parksAsBackground("bash", running));
		component.parkAsBackground();
		expect(component.isCompactBackgroundActive()).toBe(true);
		expect(component.compactBashLogRows(80).join("\n")).toContain("foreground");
		expect(component.compactBashLogRows(80).join("\n")).not.toContain("handoff");
		output(component, "background latest", { async: { state: "running" } });
		expect(component.compactBashLogRows(80).join("\n")).toContain("background latest");
		output(component, "done", { async: { state: "completed" } }, false);
		expect(component.compactBashLogRows(80)).toEqual([]);
	});
});
