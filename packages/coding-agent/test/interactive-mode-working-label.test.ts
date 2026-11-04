/**
 * A live (function) working label — the background-job wait row — is re-read
 * on every tick and kept to one terminal row. Without the clamp a long list of
 * job ids wrapped the working row onto a second line at narrow widths.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { setShimmerMode } from "@oh-my-pi/pi-tui/theme/shimmer";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import type { DescribeContext, NativeChild } from "@oh-my-pi/pi-tui/native/node";
import { TempDir } from "@oh-my-pi/pi-utils";
import { DisplayContract, type DisplayFrame } from "../../tui/test/helpers/display-contract";
import { withoutTerminalMultiplexer } from "../../tui/test/helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createAssistantMessage } from "./helpers/agent-session-setup";

withoutTerminalMultiplexer();
const COLUMNS = 40;

const nativeContext: DescribeContext = {
	cols: COLUMNS,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

function nativeRoles(child: NativeChild): string[] {
	const node = "k" in child ? child : child.describe?.(nativeContext);
	if (!node) return [];
	const role = node.p && "role" in node.p ? node.p.role : undefined;
	return [...(role ? [role] : []), ...(node.c ?? []).flatMap(nativeRoles)];
}

interface StageGeometry {
	input: number | undefined;
	cursor: DisplayFrame["cursor"];
	occupied: boolean[];
	anchors: { row: number; line: string }[];
}

describe("InteractiveMode live working label", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let focusedSession: AgentSession;
	let suitePreferences: typeof chatTranscriptDisplayPreferences;
	let previousPreferences: typeof chatTranscriptDisplayPreferences;

	beforeEach(() => {
		previousPreferences = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		cfgDisplayMode.override(mode.settings, "compact");
	});

	afterEach(() => {
		mode.loadingAnimation?.stop();
		mode.loadingAnimation = undefined;
		mode.statusContainer.disposeChildren();
		cfgDisplayMode.clearOverride(mode.settings);
		setChatTranscriptDisplayPreferences(previousPreferences);
		setSystemTime();
	});

	beforeAll(async () => {
		suitePreferences = { ...chatTranscriptDisplayPreferences };
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-working-label-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("ascend", "qwen3.8-flash-next");
		if (!model) throw new Error("Expected retained ascend/qwen3.8-flash-next presentation model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		focusedSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		Object.defineProperty(mode.ui.terminal, "columns", { get: () => COLUMNS, configurable: true });
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		await focusedSession.dispose();
		authStorage.close();
		resetSettingsForTest();
		await tempDir.remove();
		setChatTranscriptDisplayPreferences(suitePreferences);
	});

	it("keeps a long live label on one row", () => {
		const jobs = ["bg_1", "bg_2", "bg_3", "bg_4", "bg_5", "bg_6"];
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage(() => `Waiting for ${jobs.length} background jobs: ${jobs.join(", ")}`);

		const rows = mode.statusContainer
			.render(COLUMNS)
			.map(line => Bun.stripANSI(line).trimEnd())
			.filter(line => line.length > 0);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Waiting for 6 background jobs");
		expect(Bun.stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(COLUMNS);
	});

	it("keeps compact activity synchronized with the status-bar running marker, not the hidden loader", async () => {
		const terminal = new VirtualTerminal(100, 29);
		const composer = new Composer({ terminal, tuiOptions: { renderScheduler: new VirtualRenderScheduler() } });
		const current = new AgentSession({
			agent: new Agent({ initialState: { model: session.model!, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: session.modelRegistry,
		});
		cfgDisplayMode.override(current.settings, "compact");
		const live = new InteractiveMode(current, "test", undefined, undefined, undefined, undefined, composer);
		try {
			await live.init({ suppressWelcomeIntro: true });
			live.ensureLoadingAnimation();
			const thought = createAssistantMessage("");
			thought.content = [{ type: "thinking", thinking: "WORKING_LIFETIME_THOUGHT" }];
			live.noteDisplayableThinkingContent(thought);
			current.agent.state.streamMessage = thought;
			current.agent.state.activeThinkingIndex = 0;
			const activity = () => live.compactThinkingPreview.render(COLUMNS);
			const shimmering = () =>
				live.compactThinkingPreview
					.describe(nativeContext)
					.c?.some(child => "k" in child && child.k === "shimmer") ?? false;
			expect(current.isStreaming).toBe(false);
			expect(live.statusLine.getTurnElapsedMs()).toBeNull();
			expect(shimmering()).toBe(false);
			expect(activity()[0]).toContain(theme.getFgAnsi("dim"));
			setSystemTime(10_000);
			live.statusLine.markActivityStart();
			expect(live.statusLine.getTurnElapsedMs()).toBe(0);
			expect(shimmering()).toBe(true);
			const running = activity();
			setSystemTime(10_500);
			expect(activity().map(line => Bun.stripANSI(line))).toEqual(running.map(line => Bun.stripANSI(line)));
			expect(activity()).not.toEqual(running);
			const ansi = () => Bun.stripANSI(live.statusContainer.render(COLUMNS).join("\n"));
			const roles = () => nativeRoles(live.statusContainer.describe(nativeContext)!);

			expect(live.statusContainer.render(COLUMNS)).toEqual([]);
			expect(roles()).not.toContain("omp.working");
			for (const displayMode of ["clean", "detailed"] as const) {
				cfgDisplayMode.override(current.settings, displayMode);
				await Promise.resolve();
				expect(ansi()).toContain("处理中…");
				expect(roles()).toContain("omp.working");
			}
			cfgDisplayMode.override(current.settings, "compact");
			await Promise.resolve();
			expect(live.statusContainer.render(COLUMNS)).toEqual([]);
			expect(roles()).not.toContain("omp.working");

			// The error path removes the original loader without closing the status-bar window.
			current.agent.state.isStreaming = true;
			expect(live.statusLine.getTurnElapsedMs()).not.toBeNull();
			live.showError("WORKING_LIFETIME_ERROR");
			expect(current.isStreaming).toBe(true);
			expect(live.statusLine.getTurnElapsedMs()).not.toBeNull();
			expect(live.loadingAnimation).toBeUndefined();
			expect(shimmering()).toBe(true);
			const withoutLoader = activity();
			setSystemTime(11_000);
			expect(activity().map(line => Bun.stripANSI(line))).toEqual(withoutLoader.map(line => Bun.stripANSI(line)));
			expect(activity()).not.toEqual(withoutLoader);

			live.ensureLoadingAnimation();
			live.statusLine.markActivityEnd();
			expect(live.loadingAnimation).toBeDefined();
			expect(current.isStreaming).toBe(true);
			expect(live.statusLine.getTurnElapsedMs()).toBeNull();
			expect(shimmering()).toBe(false);
			const stopped = activity();
			expect(stopped[0]).toContain(theme.getFgAnsi("dim"));
			const retained = live.compactThinkingPreview.describe(nativeContext).c?.[0];
			if (!retained || !("k" in retained) || retained.k !== "text") throw new Error("Expected gray thinking text");
			expect(retained.p?.spans).toEqual([{ t: " WORKING_LIFETIME_THOUGHT", s: "dim" }]);
			setSystemTime(11_500);
			expect(activity()).toEqual(stopped);
			expect(live.statusContainer.render(COLUMNS)).toEqual([]);
		} finally {
			live.stop();
			setSystemTime();
			await current.dispose();
		}
	});

	it("repaints an idle tool's elapsed time with shimmer disabled and the compact working row hidden", async () => {
		const terminal = new VirtualTerminal(100, 29);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({ terminal, tuiOptions: { renderScheduler: scheduler } });
		const current = new AgentSession({
			agent: new Agent({ initialState: { model: session.model!, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: session.modelRegistry,
		});
		cfgDisplayMode.override(current.settings, "compact");
		const live = new InteractiveMode(current, "test", undefined, undefined, undefined, undefined, composer);
		const contract = new DisplayContract(2113);
		let fakeTimers = false;
		try {
			await live.init({ suppressWelcomeIntro: true });
			setShimmerMode("disabled");
			vi.useFakeTimers();
			fakeTimers = true;
			setSystemTime(10_000);
			const start = { type: "agent_start" as const };
			current.agent.emitExternalEvent(start, { stateOnly: true });
			await live.eventController.handleEvent(start);
			live.ensureLoadingAnimation();
			const dispatch = {
				type: "tool_execution_start" as const,
				toolCallId: "idle-clock",
				toolName: "bash",
				args: { i: "IDLE_CLOCK_MARKER" },
			};
			current.agent.emitExternalEvent(dispatch, { stateOnly: true });
			await live.eventController.handleEvent(dispatch);
			await scheduler.settle(terminal);
			const before = contract.observe("idle start", terminal).viewport.join("\n");
			expect(before).toContain("IDLE_CLOCK_MARKER");
			expect(before).not.toContain("处理中…");
			for (let tick = 0; tick < 20; tick++) {
				vi.advanceTimersByTime(125);
				await scheduler.advance(terminal, 125);
			}
			const after = contract.observe("idle later", terminal).viewport.join("\n");
			expect(after).toContain("IDLE_CLOCK_MARKER");
			expect(after).not.toContain("处理中…");
			expect(after).not.toEqual(before);
			expect(after).toMatch(/IDLE_CLOCK_MARKER[^\n]*2\.5s/);
			contract.assertHealthy();
		} finally {
			live.stop();
			if (fakeTimers) vi.useRealTimers();
			setSystemTime();
			setShimmerMode("classic");
			await current.dispose();
		}
	});

	it("keeps custom activity visible for a focused agent in compact and detailed modes", async () => {
		session.agent.state.pendingToolCalls.add("parent-call");
		const message = createAssistantMessage("focused reply");
		focusedSession.agent.emitExternalEvent({ type: "message_start", message }, { stateOnly: true });
		Object.defineProperty(mode, "viewSession", { configurable: true, value: focusedSession });
		try {
			mode.ensureLoadingAnimation();
			for (const displayMode of ["compact", "detailed"] as const) {
				cfgDisplayMode.override(mode.settings, displayMode);
				await Promise.resolve();
				mode.setWorkingMessage("custom activity");
				const rendered = Bun.stripANSI(mode.statusContainer.render(COLUMNS).join("\n"));
				expect(rendered).toContain("custom activity");
				expect(nativeRoles(mode.statusContainer.describe(nativeContext)!)).toContain("omp.working");
			}
			cfgDisplayMode.override(mode.settings, "compact");
			mode.setWorkingMessage();
			expect(mode.statusContainer.render(COLUMNS)).toEqual([]);
			expect(nativeRoles(mode.statusContainer.describe(nativeContext)!)).not.toContain("omp.working");
		} finally {
			delete (mode as unknown as { viewSession?: AgentSession }).viewSession;
			session.agent.state.pendingToolCalls.clear();
			focusedSession.agent.emitExternalEvent({ type: "message_end", message }, { stateOnly: true });
		}
	});

	it.each([1, 18])(
		"keeps resumed transcript geometry stable through streamed tool calls (%i old paragraphs)",
		async oldParagraphs => {
			const preferences = { ...chatTranscriptDisplayPreferences };
			setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
			const terminal = new VirtualTerminal(100, 29);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
			});
			const manager = SessionManager.inMemory(tempDir.path());
			const current = new AgentSession({
				agent: new Agent({
					initialState: { model: session.model!, systemPrompt: ["Test"], tools: [], messages: [] },
				}),
				sessionManager: manager,
				settings: Settings.isolated(),
				modelRegistry: session.modelRegistry,
			});
			cfgDisplayMode.override(current.settings, "compact");
			const live = new InteractiveMode(current, "test", undefined, undefined, undefined, undefined, composer);
			const contract = new DisplayContract(2112);
			let unwatch = () => {};
			let fakeTimers = false;
			try {
				const oldAnswer = [
					...Array.from({ length: oldParagraphs - 1 }, (_, i) => `Old response paragraph ${i + 1}.`),
					"OLD_RESUMED_ANSWER",
				].join("\n\n");
				manager.appendMessage(createAssistantMessage(oldAnswer));
				await live.init({ suppressWelcomeIntro: true });
				await live.renderInitialMessages();
				live.showStatus("Resumed session");
				const prompt = { role: "user" as const, content: "NEW_RESUMED_PROMPT", timestamp: Date.now() };
				manager.appendMessage(prompt);
				await live.eventController.handleEvent({ type: "message_start", message: prompt });
				live.editor.setText("DRAFT_INPUT_MARKER");
				await scheduler.settle(terminal);

				// The scheduler clocks TUI writes; fake timers also advance any live activity animation.
				vi.useFakeTimers();
				fakeTimers = true;
				const start = { type: "agent_start" as const };
				current.agent.emitExternalEvent(start, { stateOnly: true });
				await live.eventController.handleEvent(start);
				let phase = "tool stream";
				let phaseBaseline: StageGeometry | undefined;
				let streamingFrames = 0;
				const stageGeometry = (frame: DisplayFrame): StageGeometry => {
					expect(frame.viewport.join("\n")).not.toContain("处理中…");
					const input = frame.viewport.flatMap((line, row) => (line.includes("DRAFT_INPUT_MARKER") ? [row] : []));
					expect(input).toHaveLength(1);
					return {
						input: input[0],
						cursor: frame.cursor,
						// Tool activity may change horizontally; occupied rows and retained transcript text may not.
						occupied: frame.viewport.slice(0, input[0]).map(line => Boolean(line.trim())),
						anchors: frame.viewport.flatMap((line, row) =>
							/Old response paragraph|OLD_RESUMED_ANSWER|Resumed session|NEW_RESUMED_PROMPT/.test(line)
								? [{ row, line }]
								: [],
						),
					};
				};
				unwatch = contract.watch(
					live.ui,
					terminal,
					() => phase,
					frame => {
						streamingFrames++;
						if (phaseBaseline) expect(stageGeometry(frame)).toEqual(phaseBaseline);
					},
				);
				const stablePhase = async (name: string) => {
					phaseBaseline = undefined;
					phase = `${name}: settle`;
					await scheduler.settle(terminal);
					contract.assertHealthy();
					phaseBaseline = stageGeometry(contract.observe(`${name}: baseline`, terminal));
					for (let tick = 0; tick < 3; tick++) {
						phase = `${name}: activity tick ${tick}`;
						vi.advanceTimersByTime(125);
						await scheduler.advance(terminal, 125);
						contract.assertHealthy();
						phase = `${name}: irrelevant update ${tick}`;
						await live.eventController.handleEvent({
							type: "tool_execution_update",
							toolCallId: "already-retired-unrelated",
							toolName: "grep",
							args: {},
							partialResult: { content: [{ type: "text", text: "" }] },
						});
						await scheduler.settle(terminal);
						contract.assertHealthy();
						phase = `${name}: full repaint ${tick}`;
						live.ui.requestRender(true);
						await scheduler.settle(terminal);
						contract.assertHealthy();
					}
					phaseBaseline = undefined;
				};
				const calls: ToolCall[] = [
					{ type: "toolCall", id: "resume-1", name: "grep", arguments: { pattern: "one", i: "EARLY_ONE" } },
					{ type: "toolCall", id: "resume-2", name: "grep", arguments: { pattern: "two", i: "EARLY_TWO" } },
					{ type: "toolCall", id: "resume-3", name: "grep", arguments: { pattern: "three", i: "EARLY_THREE" } },
					{
						type: "toolCall",
						id: "resume-4",
						name: "grep",
						arguments: { pattern: "four", i: "LAST_GREP_MARKER" },
					},
					{ type: "toolCall", id: "resume-5", name: "read", arguments: { path: "last-read-marker.ts" } },
				];
				for (const call of calls) {
					const empty = createAssistantMessage("");
					empty.content = [];
					current.agent.emitExternalEvent({ type: "message_start", message: empty }, { stateOnly: true });
					await live.eventController.handleEvent({ type: "message_start", message: empty });
					await stablePhase(`${call.id} message start`);
					const partialCall: ToolCall = { ...call, arguments: {} };
					setStreamingPartialJson(partialCall, "");
					const partial = createAssistantMessage("");
					partial.content = [partialCall];
					partial.stopReason = "toolUse";
					const callStart = {
						type: "message_update" as const,
						message: partial,
						assistantMessageEvent: { type: "toolcall_start" as const, contentIndex: 0, partial },
					};
					current.agent.emitExternalEvent(callStart, { stateOnly: true });
					await live.eventController.handleEvent(callStart);
					await stablePhase(`${call.id} arguments start`);
					const serialized = JSON.stringify(call.arguments);
					const split = Math.max(1, Math.floor(serialized.length / 2));
					for (const [index, json] of [serialized.slice(0, split), serialized].entries()) {
						partialCall.arguments = index === 0 ? {} : call.arguments;
						setStreamingPartialJson(partialCall, json);
						const delta = {
							type: "message_update" as const,
							message: partial,
							assistantMessageEvent: {
								type: "toolcall_delta" as const,
								contentIndex: 0,
								delta: index === 0 ? json : serialized.slice(split),
								partial,
							},
						};
						current.agent.emitExternalEvent(delta, { stateOnly: true });
						await live.eventController.handleEvent(delta);
						await stablePhase(`${call.id} arguments delta ${index}`);
					}
					const message = createAssistantMessage("");
					message.content = [call];
					message.stopReason = "toolUse";
					const update = {
						type: "message_update" as const,
						message,
						assistantMessageEvent: {
							type: "toolcall_end" as const,
							contentIndex: 0,
							toolCall: call,
							partial: message,
						},
					};
					current.agent.emitExternalEvent(update, { stateOnly: true });
					await live.eventController.handleEvent(update);
					await stablePhase(`${call.id} arguments finalized`);
					manager.appendMessage(message);
					current.agent.emitExternalEvent({ type: "message_end", message }, { stateOnly: true });
					await live.eventController.handleEvent({ type: "message_end", message });
					await stablePhase(`${call.id} message end`);
					const toolStart = {
						type: "tool_execution_start" as const,
						toolCallId: call.id,
						toolName: call.name,
						args: call.arguments,
					};
					current.agent.emitExternalEvent(toolStart, { stateOnly: true });
					await live.eventController.handleEvent(toolStart);
					await stablePhase(`${call.id} execution start`);
					const result = { content: [{ type: "text" as const, text: "completed" }] };
					const toolEnd = {
						type: "tool_execution_end" as const,
						toolCallId: call.id,
						toolName: call.name,
						result,
						isError: false,
					};
					current.agent.emitExternalEvent(toolEnd, { stateOnly: true });
					await live.eventController.handleEvent(toolEnd);
					manager.appendMessage({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						...result,
						isError: false,
						timestamp: Date.now(),
					});
					await stablePhase(`${call.id} execution complete`);
				}
				live.setWorkingMessage();
				live.ui.requestRender();
				await scheduler.settle(terminal);

				const markers = [
					...(oldParagraphs === 1 ? ["OLD_RESUMED_ANSWER"] : []),
					"Resumed session",
					"NEW_RESUMED_PROMPT",
					"last-read-marker.ts",
					"DRAFT_INPUT_MARKER",
				];
				const geometry = (frame: DisplayFrame) => {
					const rows = markers.map(marker => {
						const found = frame.viewport.flatMap((line, index) => (line.includes(marker) ? [index] : []));
						expect(found).toHaveLength(1);
						return found[0]!;
					});
					return { rows, cursor: frame.cursor };
				};
				const baseline = geometry(contract.observe("waiting baseline", terminal));
				expect(baseline.rows).toEqual([...baseline.rows].sort((a, b) => a - b));
				expect(streamingFrames).toBeGreaterThan(0);
				unwatch();
				phase = "working tick";
				let frames = 0;
				unwatch = contract.watch(
					live.ui,
					terminal,
					() => phase,
					frame => {
						frames++;
						expect(geometry(frame)).toEqual(baseline);
					},
				);
				for (let tick = 0; tick < 12; tick++) {
					phase = `activity timer ${tick}`;
					vi.advanceTimersByTime(125);
					await scheduler.advance(terminal, 125);
					contract.assertHealthy();
					phase = `irrelevant tool update ${tick}`;
					await live.eventController.handleEvent({
						type: "tool_execution_update",
						toolCallId: "already-retired-unrelated",
						toolName: "grep",
						args: {},
						partialResult: { content: [{ type: "text", text: "" }] },
					});
					await scheduler.settle(terminal);
					contract.assertHealthy();
					phase = `full repaint ${tick}`;
					live.ui.requestRender(true);
					await scheduler.settle(terminal);
					contract.assertHealthy();
				}
				expect(frames).toBeGreaterThan(0);
			} finally {
				unwatch();
				live.stop();
				if (fakeTimers) vi.useRealTimers();
				await current.dispose();
				setChatTranscriptDisplayPreferences(preferences);
			}
		},
	);
});
