import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import { StatusNotice } from "../src/chrome/status-notice";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { Text } from "../src/components/text";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";
import { initTheme } from "../src/theme";

const preferences = { ...chatTranscriptDisplayPreferences };
const components: ToolExecutionComponent[] = [];
function tool(name: string, args: unknown, compactToolActivity?: boolean): ToolExecutionComponent {
	const component = new ToolExecutionComponent(name, args, { compactToolActivity }, undefined, {
		requestRender() {},
		requestComponentRender() {},
		resetDisplay() {},
	});
	components.push(component);
	return component;
}
function output(root: TranscriptContainer): string {
	return Bun.stripANSI(root.render(80).join("\n"));
}
function native(root: TranscriptContainer): string {
	const document = new TspDocument("s:regression");
	const ops = new Reconciler("s:regression").reconcile(
		{ main: root.nativeBlocks(), dock: [], layer: [] },
		{
			cols: 80,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		},
	);
	expect(document.applyFrame({ sf: "s:regression", s: 1, ops })).toEqual([]);
	return JSON.stringify(document.snapshot());
}
beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	for (const component of components.splice(0)) component.dispose();
	stopSharedSpinnerTicker();
	setChatTranscriptDisplayPreferences(preferences);
	vi.restoreAllMocks();
});

describe("compact tool component integration", () => {
	it("restores a background row from the job start instead of restarting at zero on replay", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		let now = 61_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		vi.spyOn(Date, "now").mockImplementation(() => 1_000_000 + now);
		const bash = tool("bash", { command: "long-running-command" });
		bash.setExecutionStarted(undefined, 1_001_000);
		bash.updateResult(
			{
				content: [],
				details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
			},
			true,
		);
		bash.parkAsBackground();
		expect(Bun.stripANSI(bash.render(100).join("\n"))).toMatch(/60s$/);
		now = 63_000;
		bash.setExecutionStarted();
		expect(Bun.stripANSI(bash.render(100).join("\n"))).toMatch(/62s$/);
	});

	it("omits synthetic waits without counting them as actual calls", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		for (const path of ["first.ts", "second.ts"]) {
			const read = tool("read", { path });
			read.updateResult({ content: [{ type: "text", text: "read result" }] });
			root.addChild(read);
		}
		const wait = tool("wait", { jobs: ["bg_1"] });
		wait.updateResult({
			content: [{ type: "text", text: "internal retry guidance" }],
			isError: true,
			details: { source: "interrupt_skipped", __synthetic: true },
		});
		root.addChild(wait);
		expect(output(root)).toMatch(/first\.ts[^]*second\.ts/);
		expect(output(root)).not.toContain("工具调用");
		expect(output(root)).not.toContain("internal retry guidance");
	});

	it("keeps tool runs continuous across visible status notices without crossing prose", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		for (const path of ["before-status-a.ts", "before-status-b.ts"]) root.addChild(tool("read", { path }));
		const status = new StatusNotice("Viewing agent Review");
		root.addChild(status);
		for (const path of ["after-status-a.ts", "after-status-b.ts"]) root.addChild(tool("read", { path }));
		root.addChild(new Text("PROSE_BOUNDARY", 0, 0));
		root.addChild(tool("read", { path: "after-prose.ts" }));
		for (const view of [output(root), native(root)]) {
			expect(view.match(/工具调用/g)).toHaveLength(1);
			expect(view).toContain("工具调用 4 次 · 失败 0 次");
			expect(view).not.toContain("before-status-a.ts");
			expect(view).not.toContain("before-status-b.ts");
			expect(view).toMatch(/after-status-a\.ts[^]*after-status-b\.ts[^]*PROSE_BOUNDARY[^]*after-prose\.ts/);
		}
		expect(output(root)).toMatch(/Viewing agent Review[^]*after-status-a\.ts/);
		status.setMessage("Returned to main session");
		expect(output(root)).toMatch(/Returned to main session[^]*after-status-a\.ts/);
		expect(output(root)).toContain("工具调用 4 次 · 失败 0 次");
	});

	it("keeps Agent messages in ordinary tool runs through pending, delivery, and failure", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		root.addChild(tool("read", { path: "before-message.ts" }));
		const message = tool("write", { path: "agent://peer", content: "coordination payload" });
		root.addChild(message);
		root.addChild(tool("bash", { command: "echo after-message" }));
		const expectContinuous = () => {
			for (const view of [output(root), native(root)]) {
				expect(view).toContain("工具调用 3 次 · 失败 0 次");
				expect(view).not.toContain("before-message.ts");
				expect(view).toContain("Message");
				expect(view).toContain("after-message");
			}
			expect(root.render(80)).toHaveLength(3);
		};
		expectContinuous();
		message.updateResult({ content: [{ type: "text", text: "delivered" }], details: { message: {} } });
		expectContinuous();
		message.updateArgs({ file_path: "[agent://all#ABCD]", content: "broadcast payload" });
		expectContinuous();
		root.addChild(tool("bash", { command: "echo latest-command" }));
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 4 次 · 失败 0 次");
			expect(view).not.toContain("Message");
		}
		message.updateResult({
			content: [{ type: "text", text: "MESSAGE_DELIVERY_FAILED" }],
			isError: true,
			details: { message: {} },
		});
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 4 次 · 失败 1 次");
			expect(view).toContain("MESSAGE_DELIVERY_FAILED");
			expect(view).toContain("latest-command");
		}
	});

	it("keeps process input, mode, and cancellation in one run without hiding critical feedback", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		root.addChild(tool("read", { path: "before-process.ts" }));
		const input = tool("write", { path: "proc://input-service", content: "input payload" });
		const mode = tool("write", { file_path: "[proc://mode-service/mode#ABCD]", content: "persist" });
		const kill = tool("write", { path: "proc://kill-job/kill" });
		for (const process of [input, mode, kill]) root.addChild(process);
		root.addChild(tool("bash", { command: "echo after-process" }));
		const expectContinuous = () => {
			for (const view of [output(root), native(root)]) {
				expect(view).toContain("工具调用 5 次 · 失败 0 次");
				expect(view).not.toContain("before-process.ts");
				expect(view).not.toContain("input-service");
				expect(view).not.toContain("mode-service");
				expect(view).toContain("kill-job");
				expect(view).toContain("after-process");
			}
			expect(root.render(80)).toHaveLength(3);
		};
		expectContinuous();
		for (const process of [input, mode, kill])
			process.updateResult({ content: [{ type: "text", text: "operation complete" }] });
		expectContinuous();
		input.updateResult({ content: [{ type: "text", text: "PROCESS_INPUT_FAILED" }], isError: true });
		mode.setCompactNeedsUserInput("Confirm mode change");
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 5 次 · 失败 1 次");
			expect(view).toContain("PROCESS_INPUT_FAILED");
			expect(view).toContain("mode-service");
			expect(view).toContain("kill-job");
			expect(view).toContain("after-process");
		}
	});

	it("keeps configuration changes in ordinary runs while retaining approval and failure feedback", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		root.addChild(tool("read", { path: "before-config.ts" }));
		const config = tool("write", { path: "cfg://display/compactToolActivity", content: "false" });
		root.addChild(config);
		root.addChild(tool("bash", { command: "echo after-config" }));
		const expectContinuous = () => {
			for (const view of [output(root), native(root)]) {
				expect(view).toContain("工具调用 3 次 · 失败 0 次");
				expect(view).not.toContain("before-config.ts");
				expect(view).toContain("Config");
				expect(view).toContain("after-config");
			}
			expect(root.render(80)).toHaveLength(3);
		};
		expectContinuous();
		config.updateResult({ content: [{ type: "text", text: "configuration applied" }] });
		expectContinuous();
		root.addChild(tool("bash", { command: "echo latest-config" }));
		expect(output(root)).not.toContain("Config");
		config.setCompactNeedsUserInput("Approve configuration");
		for (const view of [output(root), native(root)]) expect(view).toContain("compactToolActivity");
		config.setCompactNeedsUserInput();
		config.updateResult({ content: [{ type: "text", text: "CONFIG_CHANGE_FAILED" }], isError: true });
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 4 次 · 失败 1 次");
			expect(view).toContain("CONFIG_CHANGE_FAILED");
			expect(view).toContain("latest-config");
		}
	});

	it("groups non-file devices and device help without treating their write transport as a boundary", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		root.addChild(tool("read", { path: "before-device.ts" }));
		const device = tool("write", {
			file_path: "[xd://eval#ABCD]",
			content: JSON.stringify({ title: "DEVICE_EVAL", code: "return 1" }),
		});
		root.addChild(device);
		root.addChild(tool("bash", { command: "echo after-device" }));
		const expectContinuous = () => {
			for (const view of [output(root), native(root)]) {
				expect(view).toContain("工具调用 3 次 · 失败 0 次");
				expect(view).not.toContain("before-device.ts");
				expect(view).toContain("DEVICE_EVAL");
				expect(view).toContain("after-device");
			}
			expect(root.render(80)).toHaveLength(3);
		};
		expectContinuous();
		device.updateResult({
			content: [{ type: "text", text: "1" }],
			details: { xdev: { tool: "eval", mode: "execute", inner: {} } },
		});
		expectContinuous();
		const help = tool("write", { path: "xd://edit", content: "?" });
		root.addChild(help);
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 4 次 · 失败 0 次");
			expect(view).not.toContain("DEVICE_EVAL");
		}
		help.updateResult({
			content: [{ type: "text", text: "edit usage" }],
			details: { xdev: { tool: "edit", mode: "help" } },
		});
		for (const view of [output(root), native(root)]) expect(view).toContain("工具调用 4 次 · 失败 0 次");
		device.updateResult({
			content: [{ type: "text", text: "DEVICE_EXECUTION_FAILED" }],
			isError: true,
			details: { xdev: { tool: "eval", mode: "execute", inner: {} } },
		});
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 4 次 · 失败 1 次");
			expect(view).toContain("DEVICE_EXECUTION_FAILED");
		}
	});

	it("preserves raw structured Bash errors outside the ordinary preview quota", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		const bash = tool("bash", { command: "failing-command" });
		const result = {
			content: [{ type: "text" as const, text: '{"error":{"code":"RAW_DIAGNOSTIC","detail":["reason"]}}' }],
			isError: true,
		};
		const original = JSON.stringify(result);
		bash.updateResult(result);
		root.addChild(bash);
		for (const path of ["latest-a.ts", "latest-b.ts"]) {
			const read = tool("read", { path });
			read.updateResult({ content: [] });
			root.addChild(read);
		}
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("RAW_DIAGNOSTIC");
			expect(view).toContain("latest-a.ts");
			expect(view).toContain("latest-b.ts");
			expect(view).toContain("工具调用 3 次 · 失败 1 次");
		}
		expect(JSON.stringify(result)).toBe(original);
	});

	it("retains input-wait feedback immediately when newer calls arrive", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		const bash = tool("bash", { command: "needs-input" });
		bash.setCompactNeedsUserInput("INPUT_REQUIRED");
		root.addChild(bash);
		for (const command of ["new-one", "new-two", "new-three"]) root.addChild(tool("bash", { command }));
		expect(output(root)).toContain("needs-input");
		expect(bash.hasCompactCriticalFeedback()).toBe(true);
	});

	it("shares per-entry read selection across groups and preserves identity on provider rename", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		const group = new ReadToolGroupComponent();
		for (const id of ["read-a", "read-b", "read-c"]) group.updateArgs({ path: `${id}.ts` }, id);
		const identities = group.getCompactToolCalls().map(call => call.id);
		root.addChild(group);
		expect(output(root)).not.toContain("read-a.ts");
		group.renameEntry("read-c", "corrected-provider-id");
		group.updateArgs({ path: "renamed.ts" }, "corrected-provider-id");
		expect(group.getCompactToolCalls().map(call => call.id)).toEqual(identities);
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 3 次");
			expect(view).toContain("read-b.ts");
			expect(view).toContain("renamed.ts");
			expect(view).not.toContain("read-a.ts");
		}
		root.addChild(tool("bash", { command: "last-command" }));
		expect(output(root)).not.toContain("read-b.ts");
		expect(output(root)).toContain("renamed.ts");
		expect(output(root)).toContain("last-command");
	});

	it("keeps original grouped-read error details rather than an extracted failure line", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		// Upstream ANSI/fallback read groups show result bodies only with content previews enabled.
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "missing.ts" }, "missing");
		group.updateResult(
			{ content: [{ type: "text", text: "RAW_READ_ERROR: missing source file" }], isError: true },
			false,
			"missing",
		);
		for (const id of ["later-a", "later-b", "later-c"]) group.updateArgs({ path: `${id}.ts` }, id);
		root.addChild(group);
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("RAW_READ_ERROR");
			expect(view).toContain("later-b.ts");
			expect(view).toContain("later-c.ts");
			expect(view).not.toContain("later-a.ts");
		}
		group.setExpanded(true);
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("RAW_READ_ERROR: missing source file");
			expect(view).toContain("later-a.ts");
		}
	});

	it("keeps explicit detailed components outside compact quotas", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		const detailed = tool("bash", { command: "explicit-detail" }, false);
		detailed.updateResult({ content: [{ type: "text", text: "FULL_DETAIL" }] });
		root.addChild(detailed);
		root.addChild(new Text("PROSE", 0, 0));
		for (const command of ["old", "one", "two"]) root.addChild(tool("bash", { command }));
		expect(output(root)).toContain("FULL_DETAIL");
	});

	it("retains only the last three conflict file diffs and keeps partial failure details", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		const calls = ["one", "two", "three", "four"].map((name, index) => {
			const call = tool("write", { path: `conflict://${index + 1}`, content: "@ours" });
			call.updateResult({
				content: [{ type: "text", text: `resolved ${name}` }],
				details: { conflictChanges: [{ path: `${name}.ts`, diff: `-1 old_${name}\n+1 new_${name}` }] },
			});
			root.addChild(call);
			return call;
		});
		for (const view of [output(root), native(root)]) {
			expect(view).not.toContain("old_one");
			expect(view).toContain("old_two");
			expect(view).toContain("new_four");
		}
		calls[0]!.updateResult({
			content: [{ type: "text", text: "FAILED_CONFLICT_FILE" }],
			isError: true,
			details: { conflictChanges: [{ path: "one.ts", diff: "-1 old_one\n+1 new_one" }] },
		});
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("FAILED_CONFLICT_FILE");
			expect(view).toContain("new_one");
			expect(view).toContain("new_four");
		}
	});

	it("retains device-dispatched edit cards without changing their results", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const edit = tool("write", { path: "xd://edit", content: JSON.stringify({ path: "sample.ts" }) });
		const root = new TranscriptContainer();
		root.addChild(tool("read", { path: "before-file-device.ts" }));
		root.addChild(edit);
		root.addChild(tool("bash", { command: "echo after-file-device" }));
		for (const view of [output(root), native(root)]) {
			expect(view).not.toContain("工具调用");
			expect(view).toContain("before-file-device.ts");
			expect(view).toContain("after-file-device");
		}
		const result = {
			content: [{ type: "text" as const, text: "edit complete" }],
			details: {
				xdev: {
					tool: "edit",
					mode: "execute",
					inner: { path: "sample.ts", diff: "@@ -1 +1 @@\n-old_value\n+new_value" },
				},
			},
		};
		const original = JSON.stringify(result);
		edit.updateResult(result);
		expect(edit.isCompactActualFileWrite()).toBe(true);
		expect(output(root)).toContain("new_value");
		expect(native(root)).toContain("sample.ts");
		expect(output(root)).not.toContain("工具调用");
		expect(JSON.stringify(result)).toBe(original);
	});
});
