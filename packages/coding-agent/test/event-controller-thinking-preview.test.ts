import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactThinkingPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-thinking-preview";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
	const dock = new CompactThinkingPreview(ctx);
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
		rendered: () => Bun.stripANSI(dock.render(60).join("\n")),
	};
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	vi.useFakeTimers();
	setChatTranscriptDisplayPreferences({ hideToolActivity: false, compactToolActivity: true });
});

afterEach(() => {
	for (const controller of focusControllers.splice(0)) controller.dispose();
	for (const controller of eventControllers.splice(0)) controller.dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
	setChatTranscriptDisplayPreferences({ hideToolActivity: false, compactToolActivity: false });
	resetSettingsForTest();
});

describe("compact thinking dock focus restoration", () => {
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

	it("clears on thinking end and message completion without keeping a dock snapshot", async () => {
		const h = focusFixture();
		const message = thinkingMessage("ACTIVE_DOCK_THOUGHT");
		const live = liveSession(message, 0);
		h.register("Thinking", live);
		await h.focus.focusAgent("Thinking");
		expect(h.rendered()).toContain("ACTIVE_DOCK_THOUGHT");

		live.session.agent.state.activeThinkingIndex = undefined;
		await live.emit(update(message, "thinking_end"));
		expect(h.rendered()).toBe("");

		live.session.agent.state.activeThinkingIndex = 0;
		await live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("ACTIVE_DOCK_THOUGHT");
		await live.emit({ type: "message_end", message });
		expect(h.rendered()).toBe("");
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
		expect(h.rendered()).toBe("");
		setChatTranscriptDisplayPreferences({ hideToolActivity: false, compactToolActivity: true });
		expect(h.rendered()).toContain("VISIBLE_DOCK_THOUGHT");
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
