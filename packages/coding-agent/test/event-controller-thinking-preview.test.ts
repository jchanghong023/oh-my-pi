import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext, createSessionStub } from "./helpers/interactive-mode-context";

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
	const session = createSessionStub(SessionManager.inMemory(process.cwd()), settings, {
		isStreaming: message !== null,
		agent: { state: { streamMessage: message, activeThinkingIndex } },
		subscribe(listener) {
			listeners.push(listener);
			return () => {};
		},
		settleInFlightMessagePersistence: async () => {},
		activeToolExecutionUpdates: () => [],
	});
	return {
		session,
		async emit(event: AgentSessionEvent): Promise<void> {
			const listener = listeners.at(-1);
			if (!listener) throw new Error("Session has not been attached");
			await listener(event);
		},
	};
}

const eventControllers: EventController[] = [];
const focusControllers: SessionFocusController[] = [];

function streamingFixture(message: AssistantMessage) {
	const live = liveSession(message, 0);
	const ctx = createInteractiveModeContext({
		session: live.session,
		streamingComponent: new AssistantMessageComponent(),
	});
	const controller = new EventController(ctx);
	eventControllers.push(controller);
	controller.subscribeToAgent();
	return { ctx, live, controller, rendered: () => ctx.thinkingPreview.render(60).join("\n") };
}

function focusFixture() {
	const main = liveSession();
	const ctx = createInteractiveModeContext({ session: main.session });
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
	return {
		ctx,
		focus,
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
		rendered: () => ctx.thinkingPreview.render(60).join("\n"),
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	vi.useFakeTimers();
});

afterEach(() => {
	for (const controller of focusControllers.splice(0)) controller.dispose();
	for (const controller of eventControllers.splice(0)) controller.dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("thinking preview event ordering", () => {
	it("consumes a real end even when its snapshot is replaced inside the coalescing window", async () => {
		const message = thinkingMessage("VISIBLE_BEFORE_END");
		const h = streamingFixture(message);
		await h.live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("VISIBLE_BEFORE_END");

		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		await h.live.emit(update(message, "thinking_end"));
		// A focus/replay start carries the same trailing block but is not a live phase.
		await h.live.emit(update(message, "start"));
		expect(Bun.stripANSI(h.rendered())).toBe("… VISIBLE_BEFORE_END");

		vi.advanceTimersByTime(50);
		await flushMicrotasks();
		expect(Bun.stripANSI(h.rendered())).toBe("… VISIBLE_BEFORE_END");
	});

	it("does not reopen thinking when an older queued rebuild resumes after end", async () => {
		const message = thinkingMessage("SUSPENDED_THINKING");
		const h = streamingFixture(message);
		h.ctx.isInitialized = false;
		const gate = Promise.withResolvers<void>();
		h.ctx.init = async () => {
			await gate.promise;
		};
		await h.live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("SUSPENDED_THINKING");
		vi.advanceTimersByTime(50);

		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		await h.live.emit(update(message, "thinking_end"));
		expect(Bun.stripANSI(h.rendered())).toBe("… SUSPENDED_THINKING");
		gate.resolve();
		await flushMicrotasks();
		vi.advanceTimersByTime(66);
		await flushMicrotasks();
		expect(Bun.stripANSI(h.rendered())).toBe("… SUSPENDED_THINKING");
	});

	it("keeps the current stream visible when an older stream shares its timestamp and thinking index", async () => {
		const previous = thinkingMessage("PREVIOUS_STREAM_BODY", 7);
		const current = thinkingMessage("CURRENT_STREAM_BODY", 7);
		const h = streamingFixture(previous);
		await h.live.emit(update(previous, "thinking_delta"));
		expect(h.rendered()).toContain("PREVIOUS_STREAM_BODY");

		h.ctx.viewSession.agent.state.streamMessage = current;
		h.ctx.viewSession.agent.state.activeThinkingIndex = 0;
		await h.live.emit(update(current, "thinking_delta"));
		expect(h.rendered()).toContain("CURRENT_STREAM_BODY");

		await h.live.emit(update(previous, "thinking_delta"));
		expect(h.rendered()).toContain("CURRENT_STREAM_BODY");
		expect(h.rendered()).not.toContain("PREVIOUS_STREAM_BODY");
		await h.live.emit({ type: "message_end", message: previous });
		expect(h.rendered()).toContain("CURRENT_STREAM_BODY");

		vi.advanceTimersByTime(66);
		await flushMicrotasks();
		expect(h.rendered()).toContain("CURRENT_STREAM_BODY");
		expect(h.rendered()).not.toContain("PREVIOUS_STREAM_BODY");
	});

	it("does not resurrect a finished stream from a late thinking delta when runtime state is empty", async () => {
		const previous = thinkingMessage("FINISHED_STREAM_BODY");
		const h = streamingFixture(previous);
		await h.live.emit(update(previous, "thinking_delta"));
		expect(h.rendered()).toContain("FINISHED_STREAM_BODY");

		h.ctx.viewSession.agent.state.streamMessage = null;
		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		// The turn already ended: an empty runtime state keeps nothing, not even a stub.
		(h.ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = false;
		await h.live.emit(update(previous, "thinking_end"));
		expect(h.rendered()).toBe("");

		await h.live.emit(update(previous, "thinking_delta"));
		expect(h.rendered()).toBe("");
		vi.advanceTimersByTime(50);
		await flushMicrotasks();
		expect(h.rendered()).toBe("");
	});
});

describe("thinking preview turn stub", () => {
	it("bridges tool interludes on one stub row and clears it when the turn ends", async () => {
		const message = thinkingMessage("BRIDGE_TOOL_RUN");
		const h = streamingFixture(message);
		await h.live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("BRIDGE_TOOL_RUN");

		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		await h.live.emit(update(message, "thinking_end"));
		expect(Bun.stripANSI(h.rendered())).toBe("… BRIDGE_TOOL_RUN");

		// The turn continues into a tool interlude with no live thinking phase.
		h.ctx.viewSession.agent.state.streamMessage = null;
		await h.live.emit({ type: "message_end", message });
		expect(Bun.stripANSI(h.rendered())).toBe("… BRIDGE_TOOL_RUN");

		(h.ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = false;
		await h.live.emit({ type: "agent_end", messages: [] });
		expect(h.rendered()).toBe("");
	});

	it("clears the stub when answer prose starts instead of bridging the reply", async () => {
		const message = thinkingMessage("THEN_ANSWER");
		const h = streamingFixture(message);
		await h.live.emit(update(message, "thinking_delta"));
		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		await h.live.emit(update(message, "thinking_end"));
		expect(Bun.stripANSI(h.rendered())).toBe("… THEN_ANSWER");

		await h.live.emit(update(message, "text_start"));
		expect(h.rendered()).toBe("");
		vi.advanceTimersByTime(50);
		await flushMicrotasks();
		expect(h.rendered()).toBe("");
	});

	it("returns to the live window when thinking resumes with the same text", async () => {
		const message = thinkingMessage("RESUME_SAME_TEXT");
		const h = streamingFixture(message);
		await h.live.emit(update(message, "thinking_delta"));
		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		await h.live.emit(update(message, "thinking_end"));
		expect(Bun.stripANSI(h.rendered())).toBe("… RESUME_SAME_TEXT");

		h.ctx.viewSession.agent.state.activeThinkingIndex = 0;
		await h.live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("RESUME_SAME_TEXT");
		expect(h.rendered()).not.toContain("… RESUME_SAME_TEXT");
	});

	it("does not retain a stub when the thinking window is hidden", async () => {
		const message = thinkingMessage("HIDDEN_STUB");
		const h = streamingFixture(message);
		await h.live.emit(update(message, "thinking_delta"));
		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		await h.live.emit(update(message, "thinking_end"));
		expect(Bun.stripANSI(h.rendered())).toBe("… HIDDEN_STUB");

		h.ctx.hideThinkingBlock = true;
		await h.live.emit({ type: "message_end", message });
		expect(h.rendered()).toBe("");
	});

	it("clears the stub when a new turn starts", async () => {
		const message = thinkingMessage("NEW_TURN_STUB");
		const h = streamingFixture(message);
		await h.live.emit(update(message, "thinking_delta"));
		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		await h.live.emit(update(message, "thinking_end"));
		expect(Bun.stripANSI(h.rendered())).toBe("… NEW_TURN_STUB");

		await h.live.emit({ type: "agent_start" });
		expect(h.rendered()).toBe("");
	});
});

describe("thinking preview focus restoration", () => {
	it("preserves a thinking stub received while focus waits for persistence (P2-28)", async () => {
		const h = focusFixture();
		const message = thinkingMessage("FOCUS_PERSISTENCE_STUB");
		const worker = liveSession(message, 0);
		const entered = Promise.withResolvers<void>();
		const persistence = Promise.withResolvers<void>();
		worker.session.settleInFlightMessagePersistence = async () => {
			entered.resolve();
			await persistence.promise;
		};
		h.register("Worker", worker);
		const attaching = h.focus.focusAgent("Worker");
		try {
			await entered.promise;
			await worker.emit(update(message, "thinking_delta"));
			expect(h.rendered()).toContain("FOCUS_PERSISTENCE_STUB");
			worker.session.agent.state.activeThinkingIndex = undefined;
			await worker.emit(update(message, "thinking_end"));
			worker.session.agent.state.streamMessage = null;
			await worker.emit({ type: "message_end", message });
			expect(Bun.stripANSI(h.rendered())).toBe("… FOCUS_PERSISTENCE_STUB");

			persistence.resolve();
			await attaching;
			expect(Bun.stripANSI(h.rendered())).toBe("… FOCUS_PERSISTENCE_STUB");

			// A real next turn still clears the old stub; only focus replay is exempt.
			await worker.emit({ type: "agent_start" });
			expect(h.rendered()).toBe("");
		} finally {
			persistence.resolve();
			await attaching;
		}
	});

	it("restores the runtime phase rather than guessing from the last thinking block", async () => {
		const h = focusFixture();
		const ended = liveSession(thinkingMessage("ENDED_TAIL"));
		const active = liveSession(thinkingMessage("ACTIVE_WORKER", 2), 0);
		h.register("Ended", ended);
		h.register("Active", active);

		await h.focus.focusAgent("Ended");
		expect(h.rendered()).toBe("");
		await h.focus.focusAgent("Active");
		expect(h.rendered()).toContain("ACTIVE_WORKER");
		active.session.agent.state.activeThinkingIndex = undefined;
		await h.focus.focusAgent("Ended");
		await h.focus.focusAgent("Active");
		expect(h.rendered()).toBe("");
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
		expect(h.rendered()).toContain("NEW_SESSION");

		// The fixture intentionally retains unsubscribed callbacks to model delivery already in flight.
		await old.emit(update(oldMessage, "thinking_delta"));
		old.session.agent.state.activeThinkingIndex = undefined;
		await old.emit(update(oldMessage, "thinking_end"));
		await old.emit({ type: "message_end", message: oldMessage });
		expect(h.rendered()).toContain("NEW_SESSION");
		expect(h.rendered()).not.toContain("OLD_SESSION");
	});
});

describe("execution-only read group activity", () => {
	it("starts and times a read created by its first execution event (P2-23)", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
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
			const live = group.describe(toolCx).c?.find(child => "k" in child && child.k === "tool");
			expect(live && "p" in live ? live.p : undefined).toMatchObject({ status: "running", age: 0 });

			now = 1350;
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "execution-only-read",
				toolName: "read",
				result: { content: [{ type: "text", text: "export const value = 1;" }] },
				isError: false,
			});
			const done = group.describe(toolCx).c?.find(child => "k" in child && child.k === "tool");
			expect(done && "p" in done ? done.p : undefined).toMatchObject({ status: "done", took: 1250 });
		} finally {
			ctx.chatContainer.disposeChildren();
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		}
	});
});
