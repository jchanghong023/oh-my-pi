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

function update(message: AssistantMessage, phase: "thinking_delta" | "thinking_end" | "start"): MessageUpdate {
	const text = message.content[0];
	if (text?.type !== "thinking") throw new Error("Expected a thinking fixture");
	const assistantMessageEvent: MessageUpdate["assistantMessageEvent"] =
		phase === "start"
			? { type: "start", partial: message }
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
		expect(h.rendered()).toBe("");

		vi.advanceTimersByTime(33);
		await flushMicrotasks();
		expect(h.rendered()).toBe("");
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
		vi.advanceTimersByTime(33);

		h.ctx.viewSession.agent.state.activeThinkingIndex = undefined;
		await h.live.emit(update(message, "thinking_end"));
		expect(h.rendered()).toBe("");
		gate.resolve();
		await flushMicrotasks();
		vi.advanceTimersByTime(66);
		await flushMicrotasks();
		expect(h.rendered()).toBe("");
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
		await h.live.emit(update(previous, "thinking_end"));
		expect(h.rendered()).toBe("");

		await h.live.emit(update(previous, "thinking_delta"));
		expect(h.rendered()).toBe("");
		vi.advanceTimersByTime(33);
		await flushMicrotasks();
		expect(h.rendered()).toBe("");
	});
});

describe("thinking preview focus restoration", () => {
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
