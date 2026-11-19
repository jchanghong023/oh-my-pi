import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { CompactFileDiff } from "@oh-my-pi/pi-coding-agent/modes/compact-file-diff";
import { CompactThinkingPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-thinking-preview";
import { CompactToolOutputPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-tool-output-preview";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { LatestTurnFileChanges } from "@oh-my-pi/pi-coding-agent/session/latest-turn-file-changes";
import type { LiveToolOutputSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { getKeybindings, setKeybindings, Text, type Component } from "@oh-my-pi/pi-tui";
import { DisplayContract } from "../../tui/test/helpers/display-contract";
import { withoutTerminalMultiplexer } from "../../tui/test/helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createInteractiveModeContext, createSessionStub } from "./helpers/interactive-mode-context";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

withoutTerminalMultiplexer();

const compacted = "Session compacted 2 times";
const returned = "Returned to main session";

// Count only wholly blank rows between the two unique notices. Missing or
// duplicated notices are a different failure, not a spacing observation.
function gap(rows: readonly string[], label: string): number {
	const clean = rows.map(row => Bun.stripANSI(row));
	const first = clean.flatMap((row, index) => (row.includes(compacted) ? [index] : []));
	const second = clean.flatMap((row, index) => (row.includes(returned) ? [index] : []));
	if (first.length !== 1 || second.length !== 1 || first[0]! >= second[0]!) {
		throw new Error(`${label}: notices missing, duplicated or out of order\n${numbered(clean)}`);
	}
	const between = clean.slice(first[0]! + 1, second[0]);
	if (between.some(row => row.trim() !== ""))
		throw new Error(`${label}: nonblank row between notices\n${numbered(clean)}`);
	return between.length;
}

function numbered(rows: readonly string[]): string {
	return rows.map((row, index) => `${String(index).padStart(3, "0")}: ${JSON.stringify(row)}`).join("\n");
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false, "display.mode": "compact" } });
	await initTheme();
});
afterAll(() => resetSettingsForTest());

describe("compaction and focus status spacing", () => {
	it("reserves a status notice's boundary under emergency pressure", () => {
		const transcript = new TranscriptContainer();
		const first = new StatusNotice(compacted);
		const second = new StatusNotice(returned);
		transcript.addChild(new Text("older content", 0, 0));
		transcript.addChild(first);
		transcript.addChild(second);
		const frame = { tick: 0, now: 0 };
		const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row).trim());
		// Three available rows fit the pair and their semantic separator, not
		// the older block as well. The separator is not owned by either notice.
		expect(plain(transcript.renderViewport(80, 3, frame))).toEqual([compacted, "", returned]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 1 },
			{ component: second, start: 2, end: 3 },
		]);
		// With only two rows the pair and its separator cannot all fit, so
		// retain the newer notice rather than draw a false zero-gap pair.
		expect(plain(transcript.renderViewport(80, 2, frame))).toEqual([returned]);
	});

	it("keeps the source-derived gap through live rendering, retirement and display replay", async () => {
		const preferences = { ...chatTranscriptDisplayPreferences };
		const keys = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		const terminal = new VirtualTerminal(160, 48);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const ctx = createInteractiveModeContext({ composer, ui: composer.ui, editor: composer.editor });
		ctx.present = (content: Component | readonly Component[]) => {
			for (const component of Array.isArray(content) ? content : [content as Component])
				ctx.chatContainer.addChild(component);
			ctx.ui.requestRender();
		};
		const helpers = new UiHelpers(ctx);
		ctx.showStatus = helpers.showStatus.bind(helpers);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
		ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
		ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
		ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
		const events = new EventController(ctx);
		ctx.eventController = events;
		const auth = createInMemoryAuthStorage();
		const model = getBundledModel("ascend", "qwen3.8-flash-next");
		if (!model) throw new Error("Expected retained ascend/qwen3.8-flash-next presentation model");
		const hudSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
		});
		const mode = new InteractiveMode(hudSession, "test");
		mode.setTodos([
			{
				name: "截图回归：先复现",
				tasks: [
					{ content: "图1：复现后台Bash失败、两个Wait、IRC、调用统计与TODO同屏混排并取得红例", status: "pending" },
					{ content: "图2：复现带图用户消息打断、Read回执与新IRC交接并取得红例", status: "pending" },
					{ content: "图3：复现连续带图消息和工具更新后助手多行正文仅余尾句或乱序并取得红例", status: "pending" },
					{ content: "三图复现成立后修复对应根因并验证三图回归转绿", status: "pending" },
				],
			},
		]);
		const thinkingDock = new CompactThinkingPreview(ctx);
		const main = ctx.session;
		const kept = ctx.sessionManager.appendMessage({ role: "user", content: "Status spacing journey", timestamp: 1 });
		ctx.sessionManager.appendCompaction("First summary", undefined, kept, 100);
		ctx.sessionManager.appendCompaction("Second summary", undefined, kept, 100);
		const workerManager = SessionManager.inMemory(process.cwd());
		const worker = createSessionStub(workerManager, ctx.settings);
		for (const session of [main, worker]) {
			session.settleInFlightMessagePersistence = async () => {};
			session.activeToolExecutionUpdates = () => [];
			session.buildTranscriptSessionContext = options =>
				session.sessionManager.buildSessionContext({
					transcript: true,
					collapseCompactedHistory: options?.collapseCompactedHistory,
				});
		}
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		registry.register({
			id: "ScreenOracle",
			displayName: "ScreenOracle",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: worker,
			status: "running",
		});
		const focus = new SessionFocusController(ctx, registry, () => lifecycle);
		Object.defineProperty(ctx, "viewSession", { configurable: true, get: () => focus.target ?? main });
		let ircTimestamp = 10;
		const irc = async (body: string) => {
			await events.handleEvent({
				type: "irc_message",
				message: {
					role: "custom",
					customType: "irc:incoming",
					content: body,
					display: true,
					details: { id: `irc-${ircTimestamp}`, from: "ScreenOracle", message: body },
					timestamp: ircTimestamp++,
				},
			});
		};
		// Match the view-only part of InteractiveMode.clearTransientSessionUi:
		// focus changes drop the old stream and pending handles before replay.
		ctx.clearTransientSessionUi = () => {
			ctx.pendingShellContainer.disposeChildren();
			ctx.pendingMessagesContainer.disposeChildren();
			ctx.streamingComponent = undefined;
			ctx.streamingMessage = undefined;
			ctx.pendingTools.clear();
		};
		composer.setRuntimeChildren(
			[ctx.chatContainer, mode.todoContainer, ctx.statusContainer, thinkingDock, composer.editor],
			{
				selfClearingChrome: [mode.todoContainer],
				transientChrome: [thinkingDock, composer.editor],
			},
		);
		composer.ui.setFocus(composer.editor);
		composer.start({ playWelcomeIntro: false });
		const contract = new DisplayContract(2112);
		let event = "initial";
		let before = "";
		let expectedGap: number | undefined;
		let eligibleFrames = 0;
		const unwatch = contract.watch(
			composer.ui,
			terminal,
			() => event,
			frame => {
				if (expectedGap === undefined) return;
				const view = frame.viewport.join("\n");
				if (!view.includes(compacted) || !view.includes(returned)) return;
				eligibleFrames++;
				compare(`frame ${event}`, expectedGap, frame.viewport);
			},
		);
		const paint = async (name: string, resize = false) => {
			event = name;
			composer.ui.requestRender();
			if (resize) await scheduler.advance(terminal, 300);
			else await scheduler.settle(terminal);
			contract.assertHealthy();
			contract.observe(`${name} settled`, terminal);
		};
		const compare = (label: string, expected: number, rows: readonly string[]) => {
			try {
				expect(gap(rows, label)).toBe(expected);
			} catch (error) {
				throw new Error(
					`${String(error)}\nBefore:\n${before}\nCurrent ${label}:\n${numbered(rows)}\n${contract.evidence()}`,
					{ cause: error },
				);
			}
		};
		try {
			await paint("initial");
			await focus.focusAgent("ScreenOracle");
			// The journal does not persist focus switches or transient notices.
			// Exercise the real attach path while the main session is running:
			// it restores an in-flight assistant after the compaction notice and
			// before emitting the return notice, without inventing an IRC eviction.
			Object.defineProperty(main, "isStreaming", { configurable: true, value: true });
			Object.assign(main.agent.state, {
				streamMessage: {
					role: "assistant",
					content: [],
					api: "cursor",
					provider: "cursor",
					model: "cursor-model",
					stopReason: "stop",
					timestamp: 1,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			});
			await focus.unfocus();
			await paint("return to streaming main session");
			const semantic = ctx.chatContainer.renderTail(160, 1000);
			const expected = gap(semantic, "semantic transcript");
			before = numbered(terminal.getViewport());
			compare("live focus frame", expected, terminal.getViewport());
			expectedGap = expected;
			// Sweep through real dock pressure while these two notices are the
			// newest visible semantic rows. Check every completed frame even when
			// the renderer chooses its emergency projection: if both rows fit,
			// that projection must not silently change their mutual gap.
			for (const rows of [35, 28, 24, 20, 16, 14, 12, 10, 8]) {
				event = `focus-return pressure ${rows} rows`;
				terminal.resize(160, rows);
				await paint(event, true);
			}
			event = "restore before recorded activity";
			terminal.resize(160, 48);
			await paint(event, true);
			// Names, intents and order are from the same session's 10:47:24–
			// 10:48:50 tool records; the ScreenOracle IRC arrived between the
			// two Bash calls. Only the final Bash is still executing.
			const calls = [
				{ name: "write", args: { i: "修复明确物理补位的点击映射回归", path: "agent://ScreenLayout" } },
				{
					name: "read",
					args: { i: "读取用户消息图片真实组件接口", path: "packages/tui/src/chat/user-message.ts:1-155" },
				},
				{
					name: "read",
					args: {
						i: "读取真实叙述流与工具交接回归设施",
						path: "packages/coding-agent/test/event-controller-mixed-assistant-render.test.ts:1-125",
					},
				},
				{ name: "write", args: { i: "提供图3真实正文与分工", path: "agent://ScreenOracle" } },
				{ name: "task", args: { i: "并行编写第二三图复现红例" } },
				{
					name: "bash",
					args: {
						i: "重验历史物理补位与语义接缝",
						command:
							"bun test test/composer-inline-shrink.test.ts test/display-contract.test.ts test/compact-user-journey.test.ts test/transcript-container.test.ts test/transcript-seam-loss.test.ts test/history-frame-plan.test.ts test/resize-preserved-clear.test.ts test/resize-conpty-warp.test.ts",
					},
				},
				{
					name: "bash",
					args: {
						i: "先运行截图活动组合真实CLI复现",
						command: "bun test test/spec-driven/tui-compact-mixed.e2e.test.ts",
					},
				},
			];
			for (const [i, call] of calls.entries()) {
				if (i === 6) await irc("图1测试已写入，真实 Composer、Bash/Wait、IRC、todo renderer");
				const id = `recorded-${i}`;
				await events.handleEvent({
					type: "tool_execution_start",
					toolCallId: id,
					toolName: call.name,
					args: call.args,
				});
				if (i !== 6)
					await events.handleEvent({
						type: "tool_execution_end",
						toolCallId: id,
						toolName: call.name,
						result: { content: [] },
						isError: false,
					});
				await paint(`recorded ${call.name} ${i}`);
			}
			compare("semantic after recorded activity", expected, ctx.chatContainer.renderTail(160, 1000));
			terminal.resize(160, 28);
			await paint("TODO and active work under viewport pressure", true);
			// Cropped notices are not a spacing assertion; every completed frame
			// that still shows both is checked, including emergency projections.
			terminal.resize(160, 48);
			await paint("restore viewport", true);
			composer.ui.resetDisplay();
			await paint("replay committed history");
			const history = terminal.getScrollBuffer();
			if (history.some(row => row.includes(compacted)) && history.some(row => row.includes(returned))) {
				compare("history after replay", expected, history);
			}
			await focus.focusAgent("ScreenOracle");
			await focus.unfocus();
			await paint("focus return rebuild");
			compare("rebuilt semantic transcript", expected, ctx.chatContainer.renderTail(160, 1000));
			compare("rebuilt focus frame", expected, terminal.getViewport());
			expect(eligibleFrames).toBeGreaterThan(0);
		} finally {
			unwatch();
			focus.dispose();
			events.dispose();
			ctx.chatContainer.dispose();
			composer.stop();
			mode.stop();
			await hudSession.dispose();
			auth.close();
			setChatTranscriptDisplayPreferences(preferences);
			setKeybindings(keys);
		}
	});

	it("releases only the temporary Output rows and prioritizes input on small terminals", async () => {
		const preferences = { ...chatTranscriptDisplayPreferences };
		const keys = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		const terminal = new VirtualTerminal(80, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const ctx = createInteractiveModeContext({ composer, ui: composer.ui, editor: composer.editor });
		let terminalAt: number | undefined;
		const result = { content: [{ type: "text" as const, text: "TEMPORARY_OUTPUT_ONLY" }] };
		ctx.session.getLiveToolOutputSnapshot = () => [
			{
				toolCallId: "temporary",
				toolName: "bash",
				dispatchOrder: 1,
				args: { command: "echo preview" },
				result,
				terminalAt,
				expiresAt: terminalAt === undefined ? undefined : terminalAt + 3000,
			},
		];
		const summary = new CompactThinkingPreview(ctx);
		const output: CompactToolOutputPreview = new CompactToolOutputPreview(ctx, () =>
			Math.max(0, terminal.rows - Math.max(composer.rowsBelow(output) ?? 0, composer.editor.renderedRows + 4)),
		);
		composer.setRuntimeChildren([ctx.chatContainer, output, summary, composer.editor], {
			selfClearingChrome: [output],
			transientChrome: [composer.editor],
		});
		composer.editor.setText("INPUT_PRIORITY");
		composer.ui.setFocus(composer.editor);
		composer.start({ playWelcomeIntro: false });
		const contract = new DisplayContract(2212);
		const unwatch = contract.watch(composer.ui, terminal, () => "temporary Output layout");
		const paint = async () => {
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			contract.assertHealthy();
			expect(terminal.getViewport().join("\n")).toContain("INPUT_PRIORITY");
		};
		try {
			await paint();
			expect(output.render(80)).toHaveLength(2);
			expect(summary.render(80)).toHaveLength(3);
			for (const rows of [12, 8, 6]) {
				terminal.resize(80, rows);
				await scheduler.advance(terminal, 300);
				await paint();
				expect(output.render(80).length).toBeLessThanOrEqual(6);
			}
			terminal.resize(80, 24);
			await scheduler.advance(terminal, 300);
			await paint();
			terminalAt = Date.now() - 3001;
			output.restore();
			await paint();
			expect(output.render(80)).toEqual([]);
			expect(summary.render(80)).toHaveLength(3);
			expect(terminal.getScrollBuffer().join("\n")).not.toContain("TEMPORARY_OUTPUT_ONLY");
		} finally {
			unwatch();
			output.clear();
			composer.stop();
			setChatTranscriptDisplayPreferences(preferences);
			setKeybindings(keys);
		}
	});

	it("hides duplicate file output only when the matching diff can be shown", () => {
		const preferences = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		const ctx = createInteractiveModeContext();
		const cwd = ctx.sessionManager.getCwd();
		const id = ctx.sessionManager.getSessionId();
		const source = new LatestTurnFileChanges();
		const file = `${cwd}/covered.txt`;
		const other = `${cwd}/other.txt`;
		ctx.session.getLatestTurnFileChanges = () => source.get(id);
		source.record(id, { tool: "edit", path: other, before: "OTHER_BEFORE\n", after: "DUPLICATE_TEXT\n" });
		source.record(id, { tool: "edit", path: file, before: "BEFORE\n", after: "DUPLICATE_TEXT\n" });
		let maxRows = 8;
		const diff = new CompactFileDiff(ctx, () => maxRows);
		const output = new CompactToolOutputPreview(
			ctx,
			() => 6,
			(target, width) => diff.coveredDiff(target, width),
		);
		let call: LiveToolOutputSnapshot;
		ctx.session.getLiveToolOutputSnapshot = () => [call];
		const show = (toolName: string, text: string, details: unknown, isError = false) => {
			call = {
				toolName,
				args: { path: "covered.txt" },
				toolCallId: "file-output",
				dispatchOrder: 1,
				terminalAt: Date.now(),
				result: { content: [{ type: "text", text }], details, isError },
			};
			return Bun.stripANSI(output.render(100).join("\n"));
		};
		try {
			const editDetails = { path: file, diff: "-1|BEFORE\n+1|DUPLICATE_TEXT" };
			expect(show("edit", "[covered.txt#ABCD]\n1:DUPLICATE_TEXT", editDetails)).toBe("");
			const notEqual = show("edit", "[covered.txt#ABCD]\n1:DUPLICATE_TEXT_IN_PREVIOUS_EDIT", editDetails);
			expect(notEqual).toContain("DUPLICATE_TEXT_IN_PREVIOUS_EDIT");
			const warnings = show("edit", "[covered.txt#ABCD]\n1:DUPLICATE_TEXT\nWarnings:\nA real warning", editDetails);
			expect(warnings).not.toContain("DUPLICATE_TEXT");
			expect(warnings).toContain("A real warning");
			const multi = show("edit", "[covered.txt#ABCD]\n1:DUPLICATE_TEXT\n[other.txt#1234]\n1:DUPLICATE_TEXT", {
				perFileResults: [editDetails, { path: other, diff: "-1|OTHER_BEFORE\n+1|DUPLICATE_TEXT" }],
			});
			expect(multi).toContain("[other.txt#1234]");
			expect(multi).not.toContain("[covered.txt#ABCD]");
			expect(multi.match(/1:DUPLICATE_TEXT/g)).toHaveLength(1);
			const patch = show("apply_patch", "Success. Updated the following files:\nM covered.txt\nM other.txt", {
				perFileResults: [editDetails, { path: other, diff: "-1|OTHER_BEFORE\n+1|DUPLICATE_TEXT" }],
			});
			expect(patch).toContain("M other.txt");
			expect(patch).not.toContain("M covered.txt");
			expect(show("edit", "[covered.txt#ABCD]\n1:DUPLICATE_TEXT", editDetails, true)).toContain("DUPLICATE_TEXT");
			const receipt = "Successfully wrote 15 bytes to covered.txt";
			expect(show("write", receipt, { resolvedPath: file })).toBe("");
			expect(show("write", `${receipt}\nNotice: Made executable`, { resolvedPath: file })).toContain(
				"Notice: Made executable",
			);
			maxRows = 3;
			expect(show("write", receipt, { resolvedPath: file })).toContain(receipt);
			source.start(id);
			source.record(id, { tool: "edit", path: file, before: "REMOVED\n", after: null });
			const deletion = { path: file, op: "delete", diff: "" };
			expect(show("edit", "Deleted covered.txt", deletion)).toBe("");
			expect(show("edit", "Deleted covered.txt\nWarnings:\nDeletion warning", deletion)).toContain(
				"Deletion warning",
			);
			maxRows = 1;
			expect(show("edit", "Deleted covered.txt", deletion)).toContain("Deleted covered.txt");
		} finally {
			output.clear();
			setChatTranscriptDisplayPreferences(preferences);
		}
	});

	it("previews the latest net diff without taking input focus or publishing to scrollback", async () => {
		const preferences = { ...chatTranscriptDisplayPreferences };
		const keys = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		const terminal = new VirtualTerminal(80, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, completeScrollback: true },
		});
		const ctx = createInteractiveModeContext({ composer, ui: composer.ui, editor: composer.editor });
		const changes = new LatestTurnFileChanges();
		const id = ctx.sessionManager.getSessionId();
		ctx.session.getLatestTurnFileChanges = () => changes.get(id);
		let rows = 6;
		const dock = new CompactFileDiff(ctx, () => rows);
		const file = (name: string) => `${ctx.sessionManager.getCwd()}/${name}`;
		const record = (name: string, before: string, after: string) =>
			changes.record(id, { tool: "write", path: file(name), before, after });
		record("target.txt", "ORIGINAL_VALUE\n", "INTERMEDIATE_VALUE\n");
		record("./target.txt", "INTERMEDIATE_VALUE\n", "FINAL_VALUE\n");
		record("revert.txt", "UNCHANGED\n", "TEMP_VALUE\n");
		record("revert.txt", "TEMP_VALUE\n", "UNCHANGED\n");
		composer.setRuntimeChildren([ctx.chatContainer, dock, composer.editor], {
			selfClearingChrome: [dock],
			transientChrome: [composer.editor],
		});
		composer.editor.setText("KEPT_DRAFT");
		composer.ui.setFocus(composer.editor);
		composer.start({ playWelcomeIntro: false });
		const prose = Array.from({ length: 30 }, (_, i) => `Prose_${String(i).padStart(2, "0")}`);
		const view = () => Bun.stripANSI(terminal.getViewport().join("\n"));
		try {
			for (const paragraph of prose) ctx.chatContainer.addChild(new Text(paragraph, 0, 0));
			const long = Array.from({ length: 100 }, (_, i) => `LONG_DIFF_${String(i).padStart(2, "0")}\n`).join("");
			record("second.txt", "", long);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(view()).toMatch(/本轮改动 2 文件[^\n]*\n[ \t]*\n[ \t]*[╭┌].*Edit.*second\.txt.*\+100/);
			expect(view()).toContain("LONG_DIFF_00");
			expect(view()).toContain("more lines");
			expect(dock.render(80)).toHaveLength(rows);
			expect(dock.render(80).at(-1)).toMatch(/[╰└]/);
			expect(view()).not.toMatch(/target\.txt|FINAL_VALUE|LONG_DIFF_99/);
			expect(composer.ui.getFocused()).toBe(composer.editor);

			dock.toggle();
			await scheduler.settle(terminal);
			dock.handleInput("\x1b[6~");
			await scheduler.settle(terminal);
			expect(view()).not.toContain("LONG_DIFF_00");
			dock.handleInput("\x1b[F");
			await scheduler.settle(terminal);
			expect(view()).toContain("LONG_DIFF_99");
			expect(view()).toContain("FINAL_VALUE");
			dock.handleInput("\x1b");

			// Revisiting an existing path must move the preview, not leave it on the last inserted path.
			record("target.txt", "FINAL_VALUE\n", "LATEST_VALUE\n");
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(view()).toContain("ORIGINAL_VALUE");
			expect(view()).toContain("LATEST_VALUE");
			expect(view()).not.toMatch(/FINAL_VALUE|second\.txt|LONG_DIFF/);
			expect(composer.ui.getFocused()).toBe(composer.editor);

			record("second.txt", long, "");
			dock.toggle();
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(view().match(/修改 target\.txt/gu)).toHaveLength(1);
			expect(view()).toContain("ORIGINAL_VALUE");
			expect(view()).toContain("LATEST_VALUE");
			expect(view()).not.toMatch(/INTERMEDIATE_VALUE|revert\.txt/);

			rows = 1;
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(view()).toContain("本轮改动 1 文件");
			expect(view()).not.toContain("LATEST_VALUE");
			expect(composer.ui.getFocused()).toBe(composer.editor);

			rows = 6;
			dock.toggle();
			record("target.txt", "LATEST_VALUE\n", "ORIGINAL_VALUE\n");
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(view()).not.toContain("本轮改动");
			expect(composer.ui.getFocused()).toBe(composer.editor);

			record("target.txt", "ORIGINAL_VALUE\n", "FINAL_VALUE\n");
			record("target.txt", "EXTERNAL_VALUE\n", "EXTERNAL_VALUE\n");
			dock.toggle();
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(view()).toContain("无法确认本轮净差异");
			expect(view()).not.toMatch(/ORIGINAL_VALUE|FINAL_VALUE|EXTERNAL_VALUE/);

			changes.start(id);
			dock.sync();
			changes.record(id, { tool: "edit", path: file("deleted.txt"), before: "REMOVED_CONTENT\n", after: null });
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const deletionIcon = Bun.stripANSI(theme.styledSymbol("tool.delete", "accent"));
			expect(view()).toContain(`${deletionIcon} Delete:`);
			expect(dock.render(80)).toHaveLength(2);
			expect(view()).not.toContain("REMOVED_CONTENT");
			dock.toggle();
			await scheduler.settle(terminal);
			expect(view()).toContain(`${deletionIcon} 删除 deleted.txt`);
			expect(view()).not.toContain("REMOVED_CONTENT");

			changes.start(id);
			dock.sync();
			terminal.resize(64, 18);
			await scheduler.advance(terminal, 300);
			await scheduler.settle(terminal);
			expect(view()).toContain("KEPT_DRAFT");
			expect(view()).not.toContain("本轮改动");
			const history = Bun.stripANSI(terminal.getScrollBuffer().join("\n"));
			expect(history).not.toMatch(
				/ORIGINAL_VALUE|FINAL_VALUE|LATEST_VALUE|LONG_DIFF|REMOVED_CONTENT|target\.txt|second\.txt/,
			);
			expect(Array.from(history.matchAll(/Prose_\d\d/gu), match => match[0])).toEqual(prose);
		} finally {
			dock.close();
			composer.stop();
			setChatTranscriptDisplayPreferences(preferences);
			setKeybindings(keys);
		}
	});
});
