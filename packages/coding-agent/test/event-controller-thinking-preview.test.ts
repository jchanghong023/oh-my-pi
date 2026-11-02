import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactThinkingPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-thinking-preview";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Loader } from "@oh-my-pi/pi-tui";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { setShimmerMode } from "@oh-my-pi/pi-tui/theme/shimmer";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createSessionStub } from "./helpers/interactive-mode-context";

function nativeRows(node: NativeNode): readonly string[] {
	if (node.k === "rows" && node.p) return node.p.lines;
	if (node.k !== "col" || !node.c) throw new Error("Expected dock rows or native activity column");
	const text = (child: NativeNode): string => {
		if (child.k === "rows") return child.p?.lines.join("") ?? "";
		if (child.k === "shimmer" || child.k === "text") {
			return child.p?.text ?? child.p?.spans?.map(span => span.t).join("") ?? "";
		}
		if (child.k === "elapsed") return formatDuration(child.p?.stopped ?? child.p?.age ?? 0);
		if (child.k === "row" && child.c) {
			return child.c
				.map(part => {
					if (!("k" in part)) throw new Error("Expected native row node");
					return text(part);
				})
				.join("");
		}
		throw new Error("Expected native activity text");
	};
	return node.c.map(child => {
		if (!("k" in child)) throw new Error("Expected native activity node");
		return text(child);
	});
}

function nativeElapsed(node: NativeNode): Array<{ age: number; stopped?: number }> {
	const found: Array<{ age: number; stopped?: number }> = [];
	const visit = (current: NativeNode) => {
		if (current.k === "elapsed" && current.p) found.push({ age: current.p.age, stopped: current.p.stopped });
		for (const child of current.c ?? []) if ("k" in child) visit(child);
	};
	visit(node);
	return found;
}

function hasNativeKind(node: NativeNode, kind: string): boolean {
	return node.k === kind || (node.c ?? []).some(child => "k" in child && hasNativeKind(child, kind));
}

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;

function thinkingMessage(text: string, timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

function update(
	message: AssistantMessage,
	phase: "thinking_delta" | "thinking_end" | "start" | "text_start",
): MessageUpdate {
	const text = message.content[0];
	if (text?.type !== "thinking") throw new Error("Expected a thinking fixture");
	const assistantMessageEvent: MessageUpdate["assistantMessageEvent"] =
		phase === "start"
			? { type: "start", partial: message }
			: phase === "text_start"
				? { type: "text_start", contentIndex: 0, partial: message }
				: phase === "thinking_end"
					? { type: "thinking_end", contentIndex: 0, content: text.thinking, partial: message }
					: { type: "thinking_delta", contentIndex: 0, delta: text.thinking, partial: message };
	return { type: "message_update", message, assistantMessageEvent };
}

function liveSession(message: AssistantMessage | null = null, activeThinkingIndex?: number) {
	const listeners: Array<(event: AgentSessionEvent) => Promise<void> | void> = [];
	const updates = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_update" }>>();
	const agent = new Agent();
	agent.state.streamMessage = message;
	agent.state.activeThinkingIndex = activeThinkingIndex;
	const session = createSessionStub(SessionManager.inMemory(process.cwd()), settings, {
		isStreaming: message !== null,
		get state() {
			return agent.state;
		},
		subscribe(listener) {
			listeners.push(listener);
			return () => {};
		},
		settleInFlightMessagePersistence: async () => {},
		activeToolExecutionUpdates: () => [...updates.values()],
	});
	Object.defineProperty(session, "agent", { configurable: true, value: agent });
	return {
		session,
		async emit(event: AgentSessionEvent): Promise<void> {
			switch (event.type) {
				case "tool_execution_start":
				case "tool_execution_end":
				case "tool_execution_update":
				case "message_start":
				case "message_update":
				case "message_end":
				case "agent_start":
				case "agent_end":
					agent.emitExternalEvent(event, { stateOnly: true });
			}
			if (event.type === "tool_execution_start") {
				session.sessionManager.appendCustomEntry("tool_execution_start", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					startedAt: new Date().toISOString(),
					intent: event.intent,
				});
				Object.defineProperty(session, "isStreaming", { configurable: true, value: true });
			} else if (event.type === "tool_execution_update") {
				updates.set(event.toolCallId, event);
			} else if (event.type === "tool_execution_end") {
				updates.delete(event.toolCallId);
			} else if (event.type === "agent_end" || event.type === "agent_start") {
				Object.defineProperty(session, "isStreaming", { configurable: true, value: event.type === "agent_start" });
			}
			const listener = listeners.at(-1);
			if (!listener) throw new Error("Session has not been attached");
			await listener(event);
		},
	};
}

const eventControllers: EventController[] = [];
const focusControllers: SessionFocusController[] = [];
const statusLines: StatusLineComponent<AgentSession>[] = [];
let previousDisplayPreferences: typeof chatTranscriptDisplayPreferences;

function focusFixture() {
	const main = liveSession();
	const statusLine = new StatusLineComponent<AgentSession>(main.session, statusLineHost);
	statusLines.push(statusLine);
	const ctx = createInteractiveModeContext({ session: main.session, statusLine });
	ctx.ensureLoadingAnimation = () => {
		if (ctx.loadingAnimation) return;
		const loader = new Loader(
			ctx.ui,
			value => value,
			value => value,
		);
		loader.stop();
		ctx.loadingAnimation = loader;
	};
	ctx.clearTransientSessionUi = () => {
		ctx.loadingAnimation?.stop();
		ctx.loadingAnimation = undefined;
	};
	ctx.hideToolActivity = true;
	ctx.chatContainer.setToolActivityVisible(false);
	const controller = new EventController(ctx);
	eventControllers.push(controller);
	ctx.eventController = controller;
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const focus = new SessionFocusController(ctx, registry, () => lifecycle);
	Object.defineProperty(ctx, "viewSession", {
		configurable: true,
		get: () => focus.target ?? ctx.session,
	});
	focusControllers.push(focus);
	const dock = new CompactThinkingPreview(ctx);
	Object.assign(ctx, { compactThinkingPreview: dock });
	return {
		ctx,
		focus,
		dock,
		register(id: string, live: { session: typeof main.session }) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: live.session,
				status: "running",
			});
		},
		rendered: () => Bun.stripANSI(dock.render(60).join("\n")).trimEnd(),
		nativeRendered: () => {
			const node = dock.describe({
				cols: 60,
				reduceMotion: false,
				dark: true,
				supports: () => true,
				feature: () => true,
			});
			return Bun.stripANSI(nativeRows(node).join("\n")).trimEnd();
		},
		rows: () => dock.render(60),
	};
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	previousDisplayPreferences = { ...chatTranscriptDisplayPreferences };
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	vi.useFakeTimers();
	setChatTranscriptDisplayPreferences({ hideToolActivity: true, compactToolActivity: true });
});

afterEach(() => {
	for (const controller of focusControllers.splice(0)) controller.dispose();
	for (const controller of eventControllers.splice(0)) controller.dispose();
	for (const statusLine of statusLines.splice(0)) statusLine.dispose();
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
	setShimmerMode("classic");
	setChatTranscriptDisplayPreferences(previousDisplayPreferences);
	resetSettingsForTest();
});

describe("compact thinking dock focus restoration", () => {
	it("reserves two content rows and a bottom gap through idle, thinking, completion, hiding, cancellation, and session switching", async () => {
		const h = focusFixture();
		expect(h.rows()).toEqual(["", "", ""]);
		const message = thinkingMessage("old\nfirst\nlatest");
		const live = liveSession(message, 0);
		h.register("Thinking", live);
		await h.focus.focusAgent("Thinking");
		expect(h.rows()).toHaveLength(3);
		expect(h.rows()[2]).toBe("");
		expect(h.rendered()).toContain("latest");
		expect(h.rendered()).toContain("first");
		expect(h.rendered()).not.toContain("old");

		live.session.agent.state.activeThinkingIndex = undefined;
		await live.emit(update(message, "thinking_end"));
		expect(h.rendered()).toContain("latest");
		live.session.agent.state.activeThinkingIndex = 0;
		await live.emit(update(message, "thinking_delta"));
		h.ctx.hideThinkingBlock = true;
		h.ctx.eventController.refreshThinkingVisibility();
		expect(h.rows()).toEqual(["", "", ""]);
		h.ctx.hideThinkingBlock = false;
		h.ctx.eventController.refreshThinkingVisibility();
		expect(h.rendered()).toContain("latest");
		await h.focus.focusAgent(MAIN_AGENT_ID);
		expect(h.rows()).toEqual(["", "", ""]);

		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(h.rows()).toEqual([]);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		expect(h.rows()).toEqual(["", "", ""]);
	});

	it("ignores late delta and end callbacks from the previously focused session", async () => {
		const h = focusFixture();
		const oldMessage = thinkingMessage("OLD_SESSION");
		const newMessage = thinkingMessage("NEW_SESSION", 2);
		const old = liveSession(oldMessage, 0);
		const current = liveSession(newMessage, 0);
		h.register("Old", old);
		h.register("Current", current);

		await h.focus.focusAgent("Old");
		expect(h.rendered()).toContain("OLD_SESSION");
		await h.focus.focusAgent("Current");
		expect(h.nativeRendered()).toContain("NEW_SESSION");
		expect(h.rendered()).toContain("NEW_SESSION");

		// The fixture intentionally retains unsubscribed callbacks to model delivery already in flight.
		await old.emit(update(oldMessage, "thinking_delta"));
		old.session.agent.state.activeThinkingIndex = undefined;
		await old.emit(update(oldMessage, "thinking_end"));
		await old.emit({ type: "message_end", message: oldMessage });
		expect(h.rendered()).toContain("NEW_SESSION");
		expect(h.rendered()).not.toContain("OLD_SESSION");
		expect(h.nativeRendered()).toContain("NEW_SESSION");
		expect(h.nativeRendered()).not.toContain("OLD_SESSION");
	});

	it("retains only the rendered thought and respects hiding after completion", async () => {
		const h = focusFixture();
		const message = thinkingMessage("VISIBLE_THOUGHT");
		const live = liveSession(message, 0);
		h.register("Thinking", live);
		await h.focus.focusAgent("Thinking");
		expect(h.rendered()).toContain("VISIBLE_THOUGHT");
		message.content = [{ type: "thinking", thinking: "UNSEEN_FINAL_THOUGHT" }];
		live.session.agent.state.activeThinkingIndex = undefined;
		live.session.agent.state.streamMessage = null;
		await live.emit({ type: "message_end", message });
		await live.emit({ type: "agent_end", messages: [] });
		expect(h.rendered()).toContain("VISIBLE_THOUGHT");
		expect(h.rendered()).not.toContain("UNSEEN_FINAL_THOUGHT");
		h.ctx.hideThinkingBlock = true;
		h.ctx.eventController.refreshThinkingVisibility();
		expect(h.rendered()).toBe("");
		h.ctx.hideThinkingBlock = false;
		h.ctx.eventController.refreshThinkingVisibility();
		expect(h.rendered()).toContain("VISIBLE_THOUGHT");
	});

	it("follows thinking visibility and display preferences without replaying history into the dock", async () => {
		const h = focusFixture();
		const message = thinkingMessage("VISIBLE_DOCK_THOUGHT");
		const live = liveSession(message, 0);
		h.register("Thinking", live);
		await h.focus.focusAgent("Thinking");
		expect(h.rendered()).toContain("VISIBLE_DOCK_THOUGHT");

		h.ctx.hideThinkingBlock = true;
		h.ctx.eventController.refreshThinkingVisibility();
		expect(h.rendered()).toBe("");
		h.ctx.hideThinkingBlock = false;
		h.ctx.eventController.refreshThinkingVisibility();
		expect(h.rendered()).toContain("VISIBLE_DOCK_THOUGHT");

		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(h.rendered()).toBe("");
		setChatTranscriptDisplayPreferences({ hideToolActivity: true, compactToolActivity: true });
		expect(h.rendered()).toContain("VISIBLE_DOCK_THOUGHT");
	});

	it("selects the latest two dispatches despite returns, output, and argument updates", async () => {
		const h = focusFixture();
		const message = thinkingMessage("reasoning first\nreasoning second");
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "lookup",
			args: { i: "FIRST_INTENT" },
		});
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "lookup",
			args: { i: "SECOND_INTENT" },
		});
		expect(h.rendered()).toContain("reasoning second");
		expect(h.rendered()).not.toContain("SECOND_INTENT");
		live.session.agent.state.activeThinkingIndex = undefined;
		await live.emit(update(message, "thinking_end"));
		const expectPair = (first: string, second: string) => {
			for (const rows of [h.rows(), h.nativeRendered().split("\n")]) {
				expect(Bun.stripANSI(rows[0]!)).toContain(first);
				expect(Bun.stripANSI(rows[1]!)).toContain(second);
			}
		};
		expectPair("FIRST_INTENT", "SECOND_INTENT");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "b",
			toolName: "lookup",
			result: { content: [{ type: "text", text: "B_RESULT" }] },
			isError: false,
		});
		expectPair("FIRST_INTENT", "SECOND_INTENT");
		const native = h.dock.describe({
			cols: 60,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		});
		const firstRow = native.c?.[0];
		const secondRow = native.c?.[1];
		if (native.k !== "col" || !firstRow || !secondRow || !("k" in firstRow) || !("k" in secondRow)) {
			throw new Error("Expected two native tool rows");
		}
		expect(hasNativeKind(firstRow, "shimmer")).toBe(true);
		expect(hasNativeKind(secondRow, "shimmer")).toBe(true);
		const preparing = { type: "toolCall" as const, id: "c", name: "preparing", arguments: { title: "PREPARING" } };
		message.content.push(preparing);
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: message },
		});
		expectPair("FIRST_INTENT", "SECOND_INTENT");
		expect(h.rendered()).not.toContain("PREPARING");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "c",
			toolName: "lookup",
			args: { i: "THIRD_INTENT" },
		});
		expectPair("SECOND_INTENT", "THIRD_INTENT");
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "a",
			toolName: "lookup",
			args: { i: "LATE_FIRST" },
			partialResult: { content: [{ type: "text", text: "LATE_OUTPUT" }] },
		});
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "b",
			toolName: "lookup",
			args: { i: "SECOND_INTENT" },
			partialResult: { content: [{ type: "text", text: "BACKGROUND_OUTPUT" }] },
		});
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "lookup",
			result: { content: [] },
			isError: false,
		});
		expectPair("SECOND_INTENT", "THIRD_INTENT");
		expect(h.rendered()).not.toMatch(/LATE_FIRST|LATE_OUTPUT|BACKGROUND_OUTPUT|B_RESULT/);
	});

	it("retains the last rendered tool snapshot after return or cancellation without inventing a canceled result", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "custom_tool",
			args: { title: "VISIBLE_TARGET" },
		});
		expect(h.rendered()).toContain("VISIBLE_TARGET");
		await live.emit({ type: "session_abort" });
		expect(h.rendered()).toContain("custom_tool");
		expect(h.rendered()).not.toMatch(/已取消|cancelled|canceled/i);
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "a",
			toolName: "custom_tool",
			args: {},
			partialResult: { content: [{ type: "text", text: "UNSEEN_UPDATE" }] },
		});
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "custom_tool",
			result: { content: [{ type: "text", text: "UNSEEN_RESULT" }] },
			isError: false,
		});
		await live.emit({ type: "agent_end", messages: [] });
		expect(h.rendered()).toContain("VISIBLE_TARGET");
		expect(h.rendered()).not.toContain("UNSEEN_UPDATE");
		expect(h.rendered()).not.toContain("UNSEEN_RESULT");
		expect(h.rendered()).not.toMatch(/已取消|cancelled|canceled/i);
		await live.emit({ type: "message_start", message: { role: "user", content: "new turn", timestamp: 2 } });
		expect(h.rendered()).toContain("VISIBLE_TARGET");
	});

	it("shows intent before the raw command without letting long intent hide the command or showing output", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "bash",
			args: { i: "THE_INTENT", command: "THE_COMMAND", path: "THE_TARGET" },
		});
		for (const rows of [h.rows(), h.nativeRendered().split("\n")]) {
			expect(Bun.stripANSI(rows[0]!)).toContain("bash");
			expect(Bun.stripANSI(rows[0]!)).toContain("THE_INTENT · THE_COMMAND");
			expect(rows[1] ?? "").toBe("");
		}
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "a",
			toolName: "bash",
			args: { i: "THE_INTENT", command: "THE_COMMAND", path: "THE_TARGET" },
			partialResult: { content: [{ type: "text", text: "OUTPUT_MUST_NOT_APPEAR" }] },
		});
		expect(h.rendered()).toContain("THE_INTENT · THE_COMMAND");
		expect(h.rendered()).not.toMatch(/THE_TARGET|OUTPUT_MUST_NOT_APPEAR/);
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "a",
			toolName: "bash",
			args: { i: `核对${"很长的说明".repeat(20)}`, command: "echo begin; git diff --stat" },
			partialResult: { content: [] },
		});
		for (const text of [h.rendered(), h.nativeRendered()]) {
			expect(text.indexOf("核对")).toBeLessThan(text.indexOf("echo begin"));
			expect(text).toContain("echo begin ; …");
			expect(text).not.toContain("git diff");
		}
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "a",
			toolName: "bash",
			args: { i: "检查", command: `printf 'a;b' 2>&1 && echo hidden` },
			partialResult: { content: [] },
		});
		for (const text of [h.rendered(), h.nativeRendered()]) {
			expect(text).toContain("printf 'a;b' 2>&1 && …");
			expect(text).not.toContain("echo hidden");
		}
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "a",
			toolName: "bash",
			args: { i: "检查", command: `find /${"long-directory/".repeat(8)}target` },
			partialResult: { content: [] },
		});
		for (const text of [h.rendered(), h.nativeRendered()]) {
			expect(text).toContain("find /long-directory/");
			expect(text).toContain("…");
			expect(text).not.toContain("target");
		}
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "bash",
			args: { i: 42, intent: {}, title: "", command: "RAW_COMMAND", path: "OTHER_TARGET" },
		});
		expect(h.rendered()).toContain("RAW_COMMAND");
		expect(h.rendered()).not.toContain("OTHER_TARGET");
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "b",
			toolName: "bash",
			args: { command: "RAW_COMMAND" },
			partialResult: { content: [{ type: "text", text: "COMMAND_OUTPUT" }] },
		});
		expect(h.rendered()).toContain("RAW_COMMAND");
		expect(h.rendered()).not.toContain("COMMAND_OUTPUT");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "c",
			toolName: "extension_probe",
			args: { title: 42, command: {}, query: "TARGET_QUERY" },
		});
		expect(h.rendered()).toContain("TARGET_QUERY");
		expect(h.nativeRendered()).toContain("TARGET_QUERY");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "d",
			toolName: "identity_only",
			args: { i: [], title: 7, command: false, path: {} },
		});
		expect(h.rendered()).toContain("identity_only");
		expect(h.nativeRendered()).toContain("identity_only");
	});

	it("links wait to the running job and distinguishes frozen submission time from waiting time", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		setSystemTime(10_000);
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "shell",
			toolName: "bash",
			args: { i: "检查", command: "bun run fulltest" },
		});
		h.rows();
		setSystemTime(10_002);
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "shell",
			toolName: "bash",
			result: { content: [], details: { async: { state: "running", jobId: "bg_1", type: "bash" } } },
		});
		for (const text of [h.rendered(), h.nativeRendered()]) {
			expect(text).toContain("bun run fulltest");
			expect(text).toContain(`bg_1 · 提交 ${formatDuration(2)}`);
		}
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "waiting",
			toolName: "wait",
			args: { i: "等待检查" },
		});
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "waiting",
			toolName: "wait",
			args: { i: "等待检查" },
			partialResult: {
				content: [{ type: "text", text: "OUTPUT_MUST_NOT_APPEAR" }],
				details: {
					op: "wait",
					jobs: [
						{ id: "old", type: "bash", status: "completed", label: "OLD_COMMAND", durationMs: 1 },
						{ id: "bg_1", type: "bash", status: "running", label: "bun run fulltest", durationMs: 0 },
					],
				},
			},
		});
		setSystemTime(15_002);
		for (const rows of [h.rows(), h.nativeRendered().split("\n")]) {
			expect(Bun.stripANSI(rows[0]!)).toContain(`bg_1 · 提交 ${formatDuration(2)}`);
			const waiting = Bun.stripANSI(rows[1]!);
			expect(waiting).toContain("wait · 等待检查 · [bash] bg_1 bun run fulltest");
			expect(waiting).toContain(" · 等待 ");
			expect(waiting).toEndWith(formatDuration(5000));
			expect(waiting).not.toMatch(/OLD_COMMAND|OUTPUT_MUST_NOT_APPEAR/);
		}
	});

	it("keeps wide multiline tool details and elapsed within their own ANSI and native rows", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		setSystemTime(10_000);
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "wide_tool",
			args: { i: "\u001b[31m宽字符多行意图宽字符多行意图\u001b[0m\n下一行\t内容" },
		});
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "other",
			args: { command: "printf hello" },
		});
		setSystemTime(15_000);
		const cx: DescribeContext = {
			cols: 32,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		for (const rows of [h.dock.render(32), nativeRows(h.dock.describe(cx))]) {
			expect(rows).toHaveLength(3);
			expect(rows[2]).toBe("");
			expect(Bun.stripANSI(rows[0]!)).toStartWith(" wide_tool");
			expect(Bun.stripANSI(rows[1]!)).toStartWith(" other");
			expect(Bun.stripANSI(rows[0]!)).toContain("宽字符");
			expect(Bun.stripANSI(rows[1]!)).toContain("printf hello");
			expect(Bun.stripANSI(rows[0]!).trimEnd()).toEndWith(formatDuration(5000));
			expect(Bun.stripANSI(rows[1]!).trimEnd()).toEndWith(formatDuration(5000));
			expect(rows.every(row => Bun.stringWidth(row) <= 32)).toBe(true);
		}
		for (const width of [0, 1]) {
			for (const rows of [h.dock.render(width), nativeRows(h.dock.describe({ ...cx, cols: width }))]) {
				expect(rows.every(row => Bun.stringWidth(row) <= width)).toBe(true);
			}
		}
	});

	it("ages each execution independently, freezes actual returns, and preserves origin across focus and rebuild", async () => {
		setSystemTime(10_000);
		setShimmerMode("disabled");
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { i: "CLOCK_A" } });
		setSystemTime(12_000);
		await live.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { i: "CLOCK_B" } });
		setSystemTime(15_000);
		const check = (first: number, second: number) => {
			for (const rows of [h.rows(), h.nativeRendered().split("\n")]) {
				expect(Bun.stripANSI(rows[0]!).trimEnd()).toEndWith(formatDuration(first));
				expect(Bun.stripANSI(rows[1]!).trimEnd()).toEndWith(formatDuration(second));
			}
		};
		check(5000, 3000);
		await live.emit({ type: "session_abort" });
		setSystemTime(16_000);
		check(6000, 4000);
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "b",
			toolName: "bash",
			result: { content: [{ type: "text", text: "background job bg_1" }] },
			isError: false,
		});
		setSystemTime(19_000);
		check(9000, 4000);
		const cx: DescribeContext = {
			cols: 60,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		expect(nativeElapsed(h.dock.describe(cx))).toEqual([
			{ age: 9000, stopped: undefined },
			{ age: 4000, stopped: 4000 },
		]);
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "b",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "background still running" }] },
		});
		check(9000, 4000);
		await h.focus.focusAgent(MAIN_AGENT_ID);
		setSystemTime(21_000);
		await h.focus.focusAgent("Worker");
		check(11000, 4000);
		const rebuilt = new CompactThinkingPreview(h.ctx);
		expect(Bun.stripANSI(rebuilt.render(60)[0]!).trimEnd()).toEndWith(formatDuration(11000));
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		await live.emit({ type: "agent_end", messages: [] });
		const retained = h.rows().map(row => Bun.stripANSI(row));
		setSystemTime(30_000);
		expect(h.rows().map(row => Bun.stripANSI(row))).toEqual(retained);
	});

	it("does not invent execution time for a recovered pending call with no start fact", async () => {
		const h = focusFixture();
		const message = thinkingMessage("");
		message.content = [{ type: "toolCall", id: "unknown", name: "probe", arguments: { i: "NO_CLOCK" } }];
		const live = liveSession(message);
		live.session.agent.emitExternalEvent(
			{ type: "tool_execution_start", toolCallId: "unknown", toolName: "probe", args: { i: "NO_CLOCK" } },
			{ stateOnly: true },
		);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const first = h.rows().map(row => Bun.stripANSI(row));
		expect(first[0]).toContain("NO_CLOCK");
		setSystemTime(Date.now() + 10_000);
		expect(h.rows().map(row => Bun.stripANSI(row))).toEqual(first);
		expect(h.nativeRendered()).not.toMatch(/\b\d+(?:\.\d+)?(?:ms|s|m)\b/);
		const cx: DescribeContext = {
			cols: 60,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		expect(nativeElapsed(h.dock.describe(cx))).toEqual([]);
	});

	it("isolates retained content by logical session even across reconstructed session objects", async () => {
		const h = focusFixture();
		const message = thinkingMessage("OLD_LOGICAL_SESSION");
		const old = liveSession(message, 0);
		const restored = liveSession();
		const untouched = liveSession();
		untouched.session.agent.state.messages.push(thinkingMessage("UNSEEN_TRANSCRIPT"));
		vi.spyOn(restored.session.sessionManager, "getSessionId").mockReturnValue(
			old.session.sessionManager.getSessionId(),
		);
		h.register("Old", old);
		h.register("Restored", restored);
		h.register("Untouched", untouched);
		await h.focus.focusAgent("Old");
		expect(h.rendered()).toContain("OLD_LOGICAL_SESSION");
		old.session.agent.state.activeThinkingIndex = undefined;
		old.session.agent.state.streamMessage = null;
		await old.emit({ type: "agent_end", messages: [] });
		await h.focus.focusAgent("Untouched");
		expect(h.rows()).toEqual(["", "", ""]);
		await old.emit(update(message, "thinking_delta"));
		expect(h.rows()).toEqual(["", "", ""]);
		await h.focus.focusAgent("Restored");
		expect(h.nativeRendered()).toContain("OLD_LOGICAL_SESSION");
		const reconstructed = new CompactThinkingPreview(h.ctx);
		expect(Bun.stripANSI(reconstructed.render(60).join("\n"))).toContain("OLD_LOGICAL_SESSION");
		await h.focus.focusAgent("Untouched");
		expect(h.rows()).toEqual(["", "", ""]);
	});

	it("keeps thinking animated through the loop and freezes it only after the loop ends", async () => {
		const h = focusFixture();
		const live = liveSession(thinkingMessage("older\nfirst original line\nlatest original line"), 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		setShimmerMode("classic");
		setSystemTime(0);
		const first = h.rows();
		expect(first.map(row => Bun.stripANSI(row))).toEqual([" first original line", " latest original line", ""]);
		setSystemTime(500);
		expect(h.rows()).not.toEqual(first);
		expect(
			h.dock.describe({
				cols: 60,
				reduceMotion: false,
				dark: true,
				supports: () => true,
				feature: () => true,
			}).k,
		).toBe("col");
		setShimmerMode("disabled");
		const disabled = h.rows();
		setSystemTime(1000);
		expect(h.rows()).toEqual(disabled);
		setShimmerMode("classic");
		live.session.agent.state.activeThinkingIndex = undefined;
		const retainedDuringLoop = h.rows();
		setSystemTime(1250);
		expect(h.rows().map(row => Bun.stripANSI(row))).toEqual(retainedDuringLoop.map(row => Bun.stripANSI(row)));
		expect(h.rows()).not.toEqual(retainedDuringLoop);
		live.session.agent.state.streamMessage = null;
		await live.emit({ type: "agent_end", messages: [] });
		const retained = h.rows();
		setSystemTime(1500);
		expect(h.rows()).toEqual(retained);
		expect(h.rendered()).toContain("latest original line");
	});

	it("keeps the last two nonblank wrapped thinking rows through whitespace updates and completion", async () => {
		const h = focusFixture();
		const message = thinkingMessage("older\n\nfirst\n \t \nlatest\n\n");
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const check = (expected: string[], cols = 60) => {
			const cx: DescribeContext = {
				cols,
				reduceMotion: false,
				dark: true,
				supports: () => true,
				feature: () => true,
			};
			for (const rows of [h.dock.render(cols), nativeRows(h.dock.describe(cx))]) {
				expect(rows.map(row => Bun.stripANSI(row))).toEqual(expected);
			}
		};
		check([" first", " latest", ""]);

		message.content = [{ type: "thinking", thinking: "older\n\nfirst\n \t \nlatest\n\n \t \n" }];
		await live.emit(update(message, "thinking_delta"));
		check([" first", " latest", ""]);

		message.content = [{ type: "thinking", thinking: "older\n\nabcdefghijklmnopqr\n \t \n\n" }];
		await live.emit(update(message, "thinking_delta"));
		check([" abcdefghi", " jklmnopqr", ""], 10);

		message.content = [{ type: "thinking", thinking: "only\n \t \n\n" }];
		await live.emit(update(message, "thinking_delta"));
		check([" only", "", ""]);
		live.session.agent.state.activeThinkingIndex = undefined;
		live.session.agent.state.streamMessage = null;
		await live.emit({ type: "agent_end", messages: [] });
		check([" only", "", ""]);
	});

	it("never clears displayed activity on empty thinking, tool transitions, or loop completion", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const message = thinkingMessage("PERSIST_THOUGHT");
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const cx: DescribeContext = {
			cols: 60,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		const check = (content: string, running = true) => {
			expect(h.rendered()).toContain(content);
			expect(h.nativeRendered()).toContain(content);
			expect(hasNativeKind(h.dock.describe(cx), "shimmer")).toBe(running);
		};
		check("PERSIST_THOUGHT");
		message.content = [{ type: "thinking", thinking: "\x1b[31m\x1b[0m" }];
		await live.emit(update(message, "thinking_delta"));
		check("PERSIST_THOUGHT");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "persistent",
			toolName: "read",
			args: { i: "PERSIST_TOOL", path: "source.ts" },
		});
		check("read · PERSIST_TOOL");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "persistent",
			toolName: "read",
			result: { content: [] },
			isError: false,
		});
		check("read · PERSIST_TOOL");
		await live.emit({ type: "message_start", message: thinkingMessage("", 2) });
		check("read · PERSIST_TOOL");
		await live.emit({ type: "agent_end", messages: [] });
		check("read · PERSIST_TOOL", false);
		expect(h.rows()[0]).toContain(theme.getFgAnsi("dim"));
	});

	it("reserves the left inset before wrapping and does not duplicate it on retained content", async () => {
		const h = focusFixture();
		const live = liveSession(thinkingMessage("abcdefghijklmnopqr"), 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const cx: DescribeContext = {
			cols: 10,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		for (const rows of [h.dock.render(10), nativeRows(h.dock.describe(cx))]) {
			expect(rows.map(row => Bun.stripANSI(row).trimEnd())).toEqual([" abcdefghi", " jklmnopqr", ""]);
		}
		live.session.agent.state.activeThinkingIndex = undefined;
		live.session.agent.state.streamMessage = null;
		await live.emit({ type: "agent_end", messages: [] });
		for (const rows of [h.dock.render(60), nativeRows(h.dock.describe({ ...cx, cols: 60 }))]) {
			expect(rows.map(row => Bun.stripANSI(row))).toEqual([" abcdefghi", " jklmnopqr", ""]);
		}
		for (const width of [0, 1]) {
			for (const rows of [h.dock.render(width), nativeRows(h.dock.describe({ ...cx, cols: width }))]) {
				expect(rows.every(row => Bun.stringWidth(row) <= width)).toBe(true);
			}
		}
	});

	it("keeps returned tool text animated until loop end without advancing its frozen elapsed time", async () => {
		const h = focusFixture();
		const live = liveSession(thinkingMessage(""));
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		setSystemTime(10_000);
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "animated",
			toolName: "bash",
			args: { i: "animated tool" },
		});
		setShimmerMode("classic");
		const cx: DescribeContext = {
			cols: 60,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		expect(h.dock.describe(cx).k).toBe("col");
		setSystemTime(80_000);
		const first = h.rows();
		setSystemTime(80_500);
		expect(h.rows().map(row => Bun.stripANSI(row))).toEqual(first.map(row => Bun.stripANSI(row)));
		expect(h.rows()).not.toEqual(first);
		setShimmerMode("disabled");
		const disabled = h.rows();
		setSystemTime(82_000);
		expect(h.rows()).not.toEqual(disabled);
		setShimmerMode("classic");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "animated",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		const returned = h.rows();
		setSystemTime(82_500);
		expect(h.rows().map(row => Bun.stripANSI(row))).toEqual(returned.map(row => Bun.stripANSI(row)));
		expect(h.rows()).not.toEqual(returned);
		const native = h.dock.describe(cx);
		expect(hasNativeKind(native, "shimmer")).toBe(true);
		expect(nativeElapsed(native)).toEqual([{ age: 72_000, stopped: 72_000 }]);
		const firstRow = native.c?.[0];
		if (!firstRow || !("k" in firstRow)) throw new Error("Expected native tool row");
		const label = firstRow.c?.[0];
		if (!label || !("k" in label) || label.k !== "shimmer") throw new Error("Expected tool shimmer");
		expect(label.p?.palette).toEqual({ low: "dim", mid: "muted", high: "success" });
		await live.emit({ type: "agent_end", messages: [] });
		const history = h.rows();
		expect(history[0]).toContain(theme.getFgAnsi("dim"));
		const retainedRow = h.dock.describe(cx).c?.[0];
		if (!retainedRow || !("k" in retainedRow)) throw new Error("Expected retained tool row");
		const retainedLabel = retainedRow.c?.[0];
		if (!retainedLabel || !("k" in retainedLabel) || retainedLabel.k !== "text") {
			throw new Error("Expected gray tool text");
		}
		expect(retainedLabel.p?.spans?.[0]?.s).toBe("dim");
		setSystemTime(83_000);
		expect(h.rows()).toEqual(history);
		expect(h.nativeRendered()).toContain("animated tool");
	});

	it("does not reactivate retained activity on late async results, but does on a new loop in that session", async () => {
		const h = focusFixture();
		const worker = liveSession(thinkingMessage("ASYNC_WORKER_THOUGHT"), 0);
		const idle = liveSession(thinkingMessage("IDLE_SESSION_THOUGHT"), 0);
		h.register("Worker", worker);
		h.register("Idle", idle);
		const cx: DescribeContext = {
			cols: 60,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		await h.focus.focusAgent("Idle");
		h.rows();
		await idle.emit({ type: "agent_end", messages: [] });
		await h.focus.focusAgent("Worker");
		expect(hasNativeKind(h.dock.describe(cx), "shimmer")).toBe(true);
		await h.focus.focusAgent("Idle");
		const retained = h.rows();
		setSystemTime(Date.now() + 500);
		expect(h.rows()).toEqual(retained);
		expect(hasNativeKind(h.dock.describe(cx), "shimmer")).toBe(false);

		const lateResult: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "late-async-result",
			toolName: "task",
			result: { content: [{ type: "text", text: "ASYNC_RESULT" }] },
			isError: false,
		};
		await idle.emit(lateResult);
		expect(h.rows()).toEqual(retained);
		expect(hasNativeKind(h.dock.describe(cx), "shimmer")).toBe(false);
		await idle.emit({ type: "agent_start" });
		const restarted = h.rows();
		setSystemTime(Date.now() + 500);
		expect(h.rows().map(row => Bun.stripANSI(row))).toEqual(restarted.map(row => Bun.stripANSI(row)));
		expect(h.rows()).not.toEqual(restarted);
		expect(hasNativeKind(h.dock.describe(cx), "shimmer")).toBe(true);
		await idle.emit({ type: "agent_end", messages: [] });
		expect(hasNativeKind(h.dock.describe(cx), "shimmer")).toBe(false);
		await h.focus.focusAgent("Worker");
		expect(hasNativeKind(h.dock.describe(cx), "shimmer")).toBe(true);
		expect(h.rendered()).toContain("ASYNC_WORKER_THOUGHT");
	});

	it("shows raw streamed targets immediately and preserves preparation ordering", async () => {
		const h = focusFixture();
		const message = thinkingMessage("");
		const first = { type: "toolCall" as const, id: "first", name: "read", arguments: {} };
		setStreamingPartialJson(first, '{"path":"src/宽字符.ts"');
		message.content = [first];
		const live = liveSession(message);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		// Focus recovery reads the same raw prefix even before another event.
		expect(h.rendered()).toContain("src/宽字符.ts");

		const emitDelta = async (contentIndex: number) =>
			live.emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex, delta: "", partial: message },
			});
		await emitDelta(0);
		expect(first.arguments).toEqual({});
		expect(h.rendered()).toContain("src/宽字符.ts");

		const second = { type: "toolCall" as const, id: "second", name: "extension_search", arguments: {} };
		setStreamingPartialJson(second, '{"query":"查找目标');
		message.content.push(second);
		await emitDelta(1);
		expect(h.rendered()).toContain("extension_search");
		expect(h.rendered()).toContain("查找目标");
		setStreamingPartialJson(first, '{"path":"newer-first.ts"');
		await emitDelta(0);
		expect(h.rendered()).toContain("查找目标");
		expect(h.rendered()).not.toContain("newer-first.ts");

		const rows = h.dock.render(24);
		expect(rows).toHaveLength(3);
		expect(rows.every(row => Bun.stringWidth(row) <= 24)).toBe(true);
	});

	it("uses only actual string fields from incomplete tool JSON", async () => {
		const h = focusFixture();
		const message = thinkingMessage("");
		const call = {
			type: "toolCall" as const,
			id: "streamed",
			name: "extension_probe",
			arguments: { title: "stale title" },
		};
		setStreamingPartialJson(call, '{"title":42');
		message.content = [call];
		const live = liveSession(message);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const emitDelta = async () =>
			live.emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
			});
		await emitDelta();
		expect(h.rendered()).toContain("extension_probe");
		setStreamingPartialJson(call, '{"title":');
		await emitDelta();
		expect(h.rendered()).toContain("extension_probe");
		setStreamingPartialJson(call, '{"title":{"nested":"not a target"}');
		await emitDelta();
		expect(h.rendered()).toContain("extension_probe");
		setStreamingPartialJson(call, "not json");
		await emitDelta();
		expect(h.rendered()).toContain("extension_probe");
		setStreamingPartialJson(call, '{"title":"检查\\u5bbd字符');
		await emitDelta();
		expect(h.rendered()).toContain("检查宽字符");
		expect(h.rendered()).not.toContain("stale title");
	});

	it("uses valid inner device arguments without treating wrong-type titles as intent", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "device",
			toolName: "write",
			args: {
				path: "xd://eval",
				content: JSON.stringify({
					title: { invalid: true },
					command: "DEVICE_RAW_COMMAND",
					query: "DEVICE_TARGET",
				}),
			},
		});
		for (const text of [h.rendered(), h.nativeRendered()]) {
			expect(text).toContain("write");
			expect(text).toContain("DEVICE_RAW_COMMAND");
			expect(text).not.toContain("DEVICE_TARGET");
		}
	});

	it("keeps live thinking ahead of raw streamed tool activity", async () => {
		const h = focusFixture();
		const message = thinkingMessage("still thinking");
		const call = { type: "toolCall" as const, id: "call", name: "read", arguments: {} };
		setStreamingPartialJson(call, '{"path":"target.ts"');
		message.content.push(call);
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "", partial: message },
		});
		expect(h.rendered()).toContain("still thinking");
		expect(h.rendered()).not.toContain("target.ts");
		live.session.agent.state.activeThinkingIndex = undefined;
		await live.emit(update(message, "thinking_end"));
		expect(h.rendered()).toContain("target.ts");
	});

	it("handles different streamed tools and treats custom raw input as opaque", async () => {
		for (const { name, raw, detail, customWireName } of [
			{ name: "write", raw: '{"i":"保存目标","path":"file.ts","content":"not output', detail: "保存目标" },
			{ name: "bash", raw: '{"command":"git status', detail: "git status" },
			{ name: "mcp_lookup", raw: '{"url":"https://example.test', detail: "https://example.test" },
			{ name: "native_custom", raw: '{"path":"not a JSON argument"}', detail: "", customWireName: "native_custom" },
		]) {
			const h = focusFixture();
			const message = thinkingMessage("");
			const call = { type: "toolCall" as const, id: name, name, arguments: {}, customWireName };
			setStreamingPartialJson(call, raw);
			message.content = [call];
			const live = liveSession(message);
			h.register("Worker", live);
			await h.focus.focusAgent("Worker");
			await live.emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
			});
			expect(h.rendered()).toContain(name);
			if (detail) expect(h.rendered()).toContain(detail);
			expect(h.rendered()).not.toContain("not output");
		}
	});

	it("updates a streamed unknown tool from incomplete arguments without inventing a result", async () => {
		const h = focusFixture();
		const message = thinkingMessage("");
		message.content = [{ type: "toolCall", id: "streamed", name: "extension_probe", arguments: { title: 42 } }];
		const live = liveSession(message);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
		});
		expect(h.rendered()).toContain("extension_probe");
		message.content = [
			{
				type: "toolCall",
				id: "streamed",
				name: "extension_probe",
				arguments: { title: "检查宽字符目标\n下一行" },
			},
		];
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
		});
		const rows = h.dock.render(24);
		expect(rows).toHaveLength(3);
		expect(h.rendered()).toContain("检查宽字符目标");
		expect(Bun.stripANSI(rows[0]!)).toContain("extension_probe");
		expect(rows[1]).toBe("");
		expect(rows.every(row => Bun.stringWidth(row) <= 24)).toBe(true);
	});
});

describe("execution-only read group activity", () => {
	it("starts and times a read created by its first execution event (P2-23)", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		eventControllers.push(controller);
		const toolCx: DescribeContext = {
			cols: 80,
			reduceMotion: false,
			dark: true,
			supports: kind => kind === "tool",
			feature: () => true,
		};
		try {
			// No message_update preview precedes this event (e.g. focus/join mid-tool).
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: "execution-only-read",
				toolName: "read",
				args: { path: "src/execution-only.ts" },
			});
			const group = ctx.pendingTools.get("execution-only-read");
			if (!(group instanceof ReadToolGroupComponent)) throw new Error("Expected a grouped read");
			const live = group.describe(toolCx);
			expect(live.k).toBe("tool");
			expect(live.k === "tool" ? live.p : undefined).toMatchObject({ status: "running", age: 0 });
			now = 600;
			const elapsed = group.describe(toolCx);
			expect(elapsed.k === "tool" ? elapsed.p : undefined).toMatchObject({ status: "running", age: 500 });
			group.setToolActivityVisible(false);
			expect(group.render(80)).toEqual([]);
			const hidden = group.describe(toolCx);
			expect(hidden.k === "tool" ? hidden.p : undefined).toMatchObject({
				hidden: true,
				status: "running",
				age: 500,
			});
			group.setToolActivityVisible(true);
			const visible = group.describe(toolCx);
			expect(visible.k === "tool" ? visible.p : undefined).toMatchObject({ status: "running", age: 500 });
			expect(visible.k === "tool" ? visible.p?.hidden : undefined).not.toBe(true);

			now = 1350;
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "execution-only-read",
				toolName: "read",
				result: { content: [{ type: "text", text: "export const value = 1;" }] },
				isError: false,
			});
			const done = group.describe(toolCx);
			expect(done.k).toBe("tool");
			expect(done.k === "tool" ? done.p : undefined).toMatchObject({ status: "done", took: 1250 });
			now = 2000;
			const frozen = group.describe(toolCx);
			expect(frozen.k === "tool" ? frozen.p : undefined).toMatchObject({ status: "done", took: 1250 });
		} finally {
			ctx.chatContainer.disposeChildren();
		}
	});
	it("keeps one timer across concurrent reads and freezes it when sealed", () => {
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const group = new ReadToolGroupComponent();
		const toolCx: DescribeContext = {
			cols: 80,
			reduceMotion: false,
			dark: true,
			supports: kind => kind === "tool",
			feature: () => true,
		};
		group.updateArgs({ path: "first.ts" }, "first");
		group.setExecutionStarted("first");
		now = 250;
		group.updateArgs({ path: "second.ts" }, "second");
		group.setExecutionStarted("second");
		now = 400;
		group.updateResult({ content: [{ type: "text", text: "first" }] }, false, "first");
		let node = group.describe(toolCx);
		expect(node.k === "tool" ? node.p : undefined).toMatchObject({ status: "running", age: 300 });
		now = 700;
		group.seal();
		now = 1000;
		node = group.describe(toolCx);
		expect(node.k === "tool" ? node.p : undefined).toMatchObject({ status: "cancelled", took: 600 });
	});
});
