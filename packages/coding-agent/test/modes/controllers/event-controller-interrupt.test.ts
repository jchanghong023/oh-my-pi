import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function createContext() {
	const setWorkingMessage = vi.fn();
	const sessionState = { isAborting: false };
	const ctx = createInteractiveModeContext({
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
	let previousDisplayPreferences = { ...chatTranscriptDisplayPreferences };
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		previousDisplayPreferences = { ...chatTranscriptDisplayPreferences };
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		setChatTranscriptDisplayPreferences(previousDisplayPreferences);
	});

	it("preserves playback across internal continuations and clears it for a user message", async () => {
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		const { ctx } = createContext();
		const controller = new EventController(ctx);

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

	it("reconciles an optimistic user row without adding another message", async () => {
		const prompt = "follow up";
		const { ctx } = createContext();
		ctx.optimisticUserMessageSignature = `${prompt}\u00000`;
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: prompt }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});

		expect(ctx.addMessageToChat).not.toHaveBeenCalled();
		expect(ctx.clearOptimisticUserMessage).toHaveBeenCalledTimes(1);
	});

	it("shows a blocked tool's user-input state until its completion", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const { ctx } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "question-1",
			toolName: "ask",
			args: { questions: [{ question: "Confirm the action?" }] },
		} as AgentSessionEvent);
		const component = ctx.pendingTools.get("question-1");
		expect(component).toBeInstanceOf(ToolExecutionComponent);
		expect((component as ToolExecutionComponent).hasCompactCriticalFeedback()).toBe(true);
		expect(ctx.chatContainer.render(100).length).toBeGreaterThan(0);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "question-1",
			toolName: "ask",
			result: { content: [{ type: "text", text: "confirmed" }] },
			isError: false,
		} as AgentSessionEvent);
		expect((component as ToolExecutionComponent).hasCompactCriticalFeedback()).toBe(false);
		(component as ToolExecutionComponent).setExpanded(true);
		expect(Bun.stripANSI(ctx.chatContainer.render(100).join("\n"))).toContain("confirmed");
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

	it("keeps tool intent out of the clean working line", async () => {
		const { ctx, setWorkingMessage } = createContext();
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		setWorkingMessage.mockClear();
		await controller.handleEvent(toolStartWithIntent("clean-call", "PRIVATE_TOOL_INTENT"));
		expect(setWorkingMessage).toHaveBeenCalledWith(undefined);
		expect(setWorkingMessage.mock.calls.flat()).not.toContain("PRIVATE_TOOL_INTENT");
	});

	it("resumes intent updates once aborting clears", async () => {
		const { ctx, setWorkingMessage, sessionState } = createContext();
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
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
});
