import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { LocalAgentSessionEvent as AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";
import { initTheme } from "../../../src/ui/theme/service";

function createContext() {
	const setWorkingMessage = vi.fn();
	const sessionState = { isAborting: false };
	const ctx = createInteractiveModeContext({
		settings: Settings.isolated({ "display.mode": "detailed" }),
		setWorkingMessage,
		session: {
			get isAborting() {
				return sessionState.isAborting;
			},
		},
	});
	return { ctx, setWorkingMessage, sessionState };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;

/** A `tool_execution_start` that drives the intent-to-working-message path. */
function toolStartWithIntent(toolCallId: string, intent: string): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName: "grep",
		args: {},
		intent,
	} as unknown as AgentSessionEvent;
}

describe("EventController aborted-turn working messages", () => {
	beforeAll(async () => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("preserves playback across internal continuations and clears it for a user message", async () => {
		const { ctx } = createContext();
		// Wiring the session's model source stops prior playback; only turn events are under test.
		const controller = new EventController(ctx);
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ type: "turn_start" });
		expect(clear).not.toHaveBeenCalled();

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "new prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});
		expect(clear).toHaveBeenCalledTimes(1);
	});

	it("suppresses late intent-driven working-message updates while aborting", async () => {
		const { ctx, setWorkingMessage, sessionState } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		setWorkingMessage.mockClear();
		sessionState.isAborting = true;
		await controller.handleEvent(toolStartWithIntent("late-call", "Reticulating splines"));

		expect(setWorkingMessage).not.toHaveBeenCalled();
	});

	it("resumes intent updates once aborting clears", async () => {
		const { ctx, setWorkingMessage, sessionState } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		sessionState.isAborting = true;

		await controller.handleEvent(toolStartWithIntent("late-call", "Reticulating splines"));
		setWorkingMessage.mockClear();
		sessionState.isAborting = false;
		await controller.handleEvent(toolStartWithIntent("call-2", "Editing module"));

		expect(setWorkingMessage).toHaveBeenCalledTimes(1);
		expect(setWorkingMessage.mock.calls[0]?.[0]).toContain("Editing module");
	});

	it("reconciles an optimistic user row without adding another message", async () => {
		const { ctx } = createContext();
		ctx.optimisticUserMessageSignature = "follow up\u00000";
		const add = vi.spyOn(ctx, "addMessageToChat");
		const clear = vi.spyOn(ctx, "clearOptimisticUserMessage");
		await new EventController(ctx).handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "follow up" }],
				attribution: "user",
				timestamp: 1,
			},
		});
		expect(add).not.toHaveBeenCalled();
		expect(clear).toHaveBeenCalledTimes(1);
	});

	it("keeps a pending ask off the transcript and shows its completed result", async () => {
		const { ctx } = createContext();
		cfgDisplayMode.override(ctx.settings, "detailed");
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "question-1",
			toolName: "ask",
			args: { html: '<form><label>Confirm the action? <input name="confirm"></label></form>' },
		});
		const ask = ctx.pendingTools.get("question-1");
		expect(renderTranscript(ctx).join("\n")).not.toContain("Confirm the action?");
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "question-1",
			toolName: "ask",
			result: { content: [{ type: "text", text: "confirmed" }] },
			isError: false,
		});
		ask?.call?.setExpanded(true);
		expect(renderTranscript(ctx).join("\n")).toContain("confirmed");
	});

	it("keeps tool intent out of the clean working line", async () => {
		const { ctx, setWorkingMessage } = createContext();
		cfgDisplayMode.override(ctx.settings, "clean");
		ctx.hideToolActivity = true;
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		setWorkingMessage.mockClear();
		await controller.handleEvent(toolStartWithIntent("clean-call", "Inspect a private path"));
		expect(setWorkingMessage).not.toHaveBeenCalled();
		expect(renderTranscript(ctx).join("\n")).not.toContain("Inspect a private path");
	});
});
