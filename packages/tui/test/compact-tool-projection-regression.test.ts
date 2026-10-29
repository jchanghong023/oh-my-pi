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
function tool(name: string, args: unknown): ToolExecutionComponent {
	const component = new ToolExecutionComponent(name, args, {}, undefined, {
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
function native(root: TranscriptContainer, dataFirst = true): string {
	const document = new TspDocument("s:regression");
	const ops = new Reconciler("s:regression").reconcile(
		{ main: root.nativeBlocks(), dock: [], layer: [] },
		{
			cols: 80,
			reduceMotion: false,
			dark: true,
			supports: kind => dataFirst || kind !== "tool",
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
			expect(view).toContain("工具调用 4 次");
			expect(view).not.toContain("before-status-a.ts");
			expect(view).not.toContain("before-status-b.ts");
			expect(view).toMatch(/after-status-a\.ts[^]*after-status-b\.ts[^]*PROSE_BOUNDARY[^]*after-prose\.ts/);
		}
		expect(output(root)).toMatch(/Viewing agent Review[^]*after-status-a\.ts/);
		status.setMessage("Returned to main session");
		expect(output(root)).toMatch(/Returned to main session[^]*after-status-a\.ts/);
		expect(output(root)).toContain("工具调用 4 次");
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
				expect(view).toContain("工具调用 3 次");
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
			expect(view).toContain("工具调用 4 次");
			expect(view).not.toContain("Message");
		}
		message.updateResult({
			content: [{ type: "text", text: "MESSAGE_DELIVERY_FAILED" }],
			isError: true,
			details: { message: {} },
		});
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 4 次");
			expect(view).not.toContain("MESSAGE_DELIVERY_FAILED");
			expect(view).toContain("latest-command");
		}
	});

	it("keeps process controls and approvals in one run while hiding invocation errors", () => {
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
				expect(view).toContain("工具调用 5 次");
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
			expect(view).toContain("工具调用 5 次");
			expect(view).not.toContain("PROCESS_INPUT_FAILED");
			expect(view).toContain("mode-service");
			expect(view).toContain("kill-job");
			expect(view).toContain("after-process");
		}
	});

	it("keeps configuration approvals in ordinary runs while hiding invocation errors", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		root.addChild(tool("read", { path: "before-config.ts" }));
		const config = tool("write", { path: "cfg://display/compactToolActivity", content: "false" });
		root.addChild(config);
		root.addChild(tool("bash", { command: "echo after-config" }));
		const expectContinuous = () => {
			for (const view of [output(root), native(root)]) {
				expect(view).toContain("工具调用 3 次");
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
			expect(view).toContain("工具调用 4 次");
			expect(view).not.toContain("CONFIG_CHANGE_FAILED");
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
				expect(view).toContain("工具调用 3 次");
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
			expect(view).toContain("工具调用 4 次");
			expect(view).not.toContain("DEVICE_EVAL");
		}
		help.updateResult({
			content: [{ type: "text", text: "edit usage" }],
			details: { xdev: { tool: "edit", mode: "help" } },
		});
		for (const view of [output(root), native(root)]) expect(view).toContain("工具调用 4 次");
		device.updateResult({
			content: [{ type: "text", text: "DEVICE_EXECUTION_FAILED" }],
			isError: true,
			details: { xdev: { tool: "eval", mode: "execute", inner: {} } },
		});
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 4 次");
			expect(view).not.toContain("DEVICE_EXECUTION_FAILED");
		}
	});

	it("hides invocation errors and failure tallies without changing detailed history", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		const read = tool("read", { path: "missing-source.ts" });
		const result = {
			content: [{ type: "text" as const, text: "Path not found: missing-source.ts" }],
			isError: true,
		};
		const original = JSON.stringify(result);
		root.addChild(read);
		read.updateResult(result);
		expect(output(root)).toBe("");
		for (const view of [native(root, false), native(root)]) {
			expect(view).not.toContain("missing-source.ts");
		}
		for (const path of ["latest-a.ts", "latest-b.ts"]) {
			const later = tool("read", { path });
			later.updateResult({ content: [] });
			root.addChild(later);
		}
		for (const view of [output(root), native(root, false), native(root)]) {
			expect(view).not.toContain("Path not found");
			expect(view).not.toContain("失败");
			expect(view).toContain("latest-a.ts");
			expect(view).toContain("latest-b.ts");
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		for (const view of [output(root), native(root, false), native(root)]) {
			expect(view).toContain("Path not found: missing-source.ts");
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

	it("hides grouped-read invocation errors until explicit detail is requested", () => {
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
			expect(view).not.toContain("RAW_READ_ERROR");
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

	it("classifies local files and dispatched coordination by their inner targets", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		for (const scheme of ["local://", ""]) {
			const root = new TranscriptContainer();
			for (const name of ["one", "two", "three", "four"]) {
				const call = tool("write", { path: `${scheme}${name}.txt`, content: `BODY_${name}` });
				call.updateResult({ content: [{ type: "text", text: `written ${name}` }] });
				root.addChild(call);
			}
			for (const view of [output(root), native(root, false), native(root)]) {
				expect(view).not.toContain("BODY_one");
				for (const name of ["two", "three", "four"]) expect(view).toContain(`BODY_${name}`);
			}
		}
		for (const target of ["agent://peer", "proc://job", "cfg://display/test"]) {
			const root = new TranscriptContainer();
			root.addChild(tool("read", { path: "before.ts" }));
			const args = { path: target, content: "payload" };
			const call = tool("write", { path: "xd://write", content: JSON.stringify(args) });
			root.addChild(call);
			root.addChild(tool("bash", { command: "echo after" }));
			expect(call.isCompactWriteCall()).toBe(false);
			expect(root.render(80)).toHaveLength(3);
			const result = {
				content: [{ type: "text" as const, text: "sent" }],
				details: { xdev: { tool: "write", mode: "execute", args, inner: {} } },
			};
			const original = JSON.stringify(result);
			call.updateResult(result);
			expect(call.isCompactActualFileWrite()).toBe(false);
			expect(root.render(80)).toHaveLength(3);
			for (const view of [output(root), native(root, false), native(root)]) {
				expect(view).toContain("工具调用 3 次");
				expect(view).toContain("after");
				expect(view).not.toContain("before.ts");
			}
			expect(JSON.stringify(result)).toBe(original);
		}
		const file = tool("write", {
			path: "xd://write",
			content: JSON.stringify({ path: "local://file.txt", content: "file" }),
		});
		file.updateResult({
			content: [{ type: "text", text: "written" }],
			details: {
				xdev: { tool: "write", mode: "execute", args: { path: "local://file.txt", content: "file" }, inner: {} },
			},
		});
		expect(file.isCompactActualFileWrite()).toBe(true);
	});

	it("retains consumed wait messages and embedded job failures beyond the preview quota", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		for (const details of [
			{ op: "wait", waited: { id: "42", from: "Worker", to: "Main", body: "MESSAGE_BODY", ts: Date.now() - 5000 } },
			{
				op: "wait",
				jobs: [
					{
						id: "failed-job",
						type: "bash",
						status: "failed",
						label: "broken",
						durationMs: 1000,
						errorText: "JOB_DIAGNOSTIC",
					},
				],
			},
			{
				op: "wait",
				jobs: [{ id: "cancelled-job", type: "task", status: "cancelled", label: "stopped", durationMs: 1000 }],
			},
			{
				op: "wait",
				jobs: [
					{
						id: "schema-job",
						type: "task",
						status: "completed",
						label: "schema",
						durationMs: 1000,
						structured: { status: "invalid", error: "SCHEMA_DIAGNOSTIC" },
					},
				],
			},
			{
				op: "wait",
				jobs: [
					{
						id: "artifact-job",
						type: "task",
						status: "completed",
						label: "artifact",
						durationMs: 1000,
						artifactError: "write",
					},
				],
			},
		]) {
			const root = new TranscriptContainer();
			const wait = tool("wait", {});
			const result = { content: [{ type: "text" as const, text: "wait result" }], details };
			const original = JSON.stringify(result);
			wait.updateResult(result);
			root.addChild(wait);
			root.addChild(tool("bash", { command: "echo latest-one" }));
			root.addChild(tool("bash", { command: "echo latest-two" }));
			for (const view of [output(root), native(root, false), native(root)]) {
				expect(view).toContain("工具调用 3 次");
				expect(view).toContain("latest-two");
				if ("waited" in details) {
					expect(view).toContain("Worker");
					expect(view).toContain("MESSAGE_BODY");
				} else {
					expect(view).toContain(details.jobs[0]!.id);
					if ("errorText" in details.jobs[0]!) expect(view).toContain("JOB_DIAGNOSTIC");
					if ("structured" in details.jobs[0]!) expect(view).toContain("SCHEMA_DIAGNOSTIC");
					if ("artifactError" in details.jobs[0]!) expect(view).toContain("artifact write failed");
				}
			}
			expect(JSON.stringify(result)).toBe(original);
		}
	});

	it("handles invalid streamed Eval titles directly and through the device without changing counts", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		for (const device of [false, true]) {
			const root = new TranscriptContainer();
			root.addChild(tool("read", { path: "first.ts" }));
			const args = (title: unknown) =>
				device
					? { path: "xd://eval", content: JSON.stringify({ title, code: "return 1" }) }
					: { title, code: "return 1" };
			const call = tool(device ? "write" : "eval", args({ invalid: true }));
			root.addChild(call);
			root.addChild(tool("bash", { command: "echo last" }));
			for (const view of [output(root), native(root, false), native(root)]) {
				expect(view).toContain("工具调用 3 次");
				expect(view).toContain("Eval");
				expect(view).toContain("last");
			}
			call.updateArgs(args("VALID_TITLE"));
			for (const view of [output(root), native(root, false), native(root)]) {
				expect(view).toContain("工具调用 3 次");
				expect(view).toContain("VALID_TITLE");
			}
		}
	});

	it("keeps task agent failures and cancellations without exposing a tool-failure tally", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		const task = tool("task", { tasks: [] });
		const base = {
			agent: "task",
			agentSource: "bundled",
			task: "investigate",
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 1000,
			tokens: 0,
			requests: 1,
		};
		const result = {
			content: [{ type: "text" as const, text: "subagents returned" }],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 1000,
				results: [
					{ ...base, index: 0, id: "FailedWorker", exitCode: 1, error: "AGENT_FAILURE" },
					{ ...base, index: 1, id: "AbortedWorker", exitCode: 0, aborted: true, abortReason: "AGENT_CANCELLED" },
					{ ...base, index: 2, id: "MergeWorker", exitCode: 0, error: "MERGE_FAILURE" },
				],
			},
		};
		const original = JSON.stringify(result);
		task.updateResult(result);
		root.addChild(task);
		root.addChild(tool("bash", { command: "echo later-one" }));
		root.addChild(tool("bash", { command: "echo later-two" }));
		for (const view of [output(root), native(root, false), native(root)]) {
			expect(view).toContain("工具调用 3 次");
			for (const text of [
				"FailedWorker",
				"AbortedWorker",
				"MergeWorker",
				"AGENT_FAILURE",
				"AGENT_CANCELLED",
				"MERGE_FAILURE",
			]) {
				expect(view).toContain(text);
			}
		}
		expect(JSON.stringify(result)).toBe(original);
	});

	it("continues choosing the running job for ordinary wait summaries", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		const wait = tool("wait", {});
		const result = {
			content: [{ type: "text" as const, text: "ordinary wait" }],
			details: {
				op: "wait",
				jobs: [
					{ id: "done-job", type: "bash", status: "completed", label: "done", durationMs: 100 },
					{ id: "running-job", type: "task", status: "running", label: "RUNNING_LABEL", durationMs: 100 },
				],
			},
		};
		const original = JSON.stringify(result);
		wait.updateResult(result);
		root.addChild(wait);
		for (const view of [output(root), native(root, false), native(root)]) {
			expect(view).toContain("running-job");
			expect(view).toContain("RUNNING_LABEL");
			expect(view).toContain("+1 jobs");
		}
		expect(JSON.stringify(result)).toBe(original);
	});
});
