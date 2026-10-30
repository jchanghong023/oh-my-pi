import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactThinkingPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-thinking-preview";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sessions: AgentSession[] = [];
const components: AssistantMessageComponent[] = [];
const authStorages: AuthStorage[] = [];
let previousPreferences = { ...chatTranscriptDisplayPreferences };

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	previousPreferences = { ...chatTranscriptDisplayPreferences };
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
});

afterEach(async () => {
	for (const component of components.splice(0)) component.dispose();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	setChatTranscriptDisplayPreferences(previousPreferences);
	resetSettingsForTest();
});

function makeSession(): AgentSession {
	const authStorage = createInMemoryAuthStorage();
	authStorages.push(authStorage);
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
				systemPrompt: ["Test"],
				tools: [],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
	});
	sessions.push(session);
	return session;
}

function update(session: AgentSession, id: string, text: string, details: unknown = {}, toolName = "bash"): void {
	session.agent.emitExternalEvent({
		type: "tool_execution_update",
		toolCallId: id,
		toolName,
		args: { command: "hidden command", intent: "hidden description" },
		partialResult: { content: [{ type: "text", text }], details } satisfies AgentToolResult<unknown>,
	});
}

function fixture() {
	const session = makeSession();
	const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, undefined, false);
	components.push(component);
	const ctx = { viewSession: session, streamingComponent: component, effectiveHideThinkingBlock: false };
	const dock = new CompactThinkingPreview(ctx);
	return { session, ctx, dock, plain: (width = 40) => Bun.stripANSI(dock.render(width)[0] ?? "").trim() };
}

describe("compact thinking row live tool output", () => {
	it("follows the latest output across interleaved tools and keeps raw output to one safe row", () => {
		const { session, dock, plain } = fixture();
		update(session, "first", "old line\nstep 1\n");
		expect(plain()).toBe("step 1");
		update(session, "second", "step 2\n");
		expect(plain()).toBe("step 2");
		update(session, "first", "obsolete\r\u001b[31m进度\t3/4\u001b[0m\n\n");
		expect(plain().replace(/\s+/gu, " ")).toBe("进度 3/4");
		const rows = dock.render(9);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toBe("");
		expect(Bun.stringWidth(rows[0]!)).toBeLessThanOrEqual(9);
		expect(rows[0]).not.toContain("\t");
	});

	it("keeps live thinking unchanged and falls back only when there is no visible thinking text", () => {
		const { session, ctx, dock, plain } = fixture();
		update(session, "first", "live stdout\n");
		const message = createAssistantMessage("");
		message.content = [{ type: "thinking", thinking: "" }];
		session.agent.emitExternalEvent(
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
			},
			{ stateOnly: true },
		);
		ctx.streamingComponent.updateContent(message, { transient: true });
		expect(plain()).toBe("live stdout");
		message.content = [{ type: "thinking", thinking: "actual reasoning" }];
		ctx.streamingComponent.updateContent(message, { transient: true });
		const thinkingRows = ctx.streamingComponent.renderCompactThinkingPreview(40);
		expect(dock.render(40)).toEqual([thinkingRows[0]!, ""]);
		expect(plain()).toBe("actual reasoning");
		ctx.effectiveHideThinkingBlock = true;
		expect(plain()).toBe("live stdout");
	});

	it("never replays completed, empty, or other-session output and retains existing display-mode boundaries", async () => {
		const { session, ctx, dock, plain } = fixture();
		expect(dock.render(40)).toEqual(["", ""]);
		update(session, "first", "\u001b[31m\u001b[0m\n\t");
		expect(dock.render(40)).toEqual(["", ""]);
		update(session, "unrelated", "tool status, not stdout", {}, "task");
		expect(dock.render(40)).toEqual(["", ""]);
		update(session, "eval", "backend notice", { notice: "backend notice" }, "eval");
		expect(dock.render(40)).toEqual(["", ""]);
		update(
			session,
			"eval",
			"backend notice\n\nreal stdout",
			{
				cells: [{ index: 0, code: "", status: "running", output: "real stdout" }],
			},
			"eval",
		);
		expect(plain()).toBe("real stdout");
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "eval",
			toolName: "eval",
			result: { content: [], details: {} },
		});
		update(session, "first", "visible progress\n");
		expect(plain()).toBe("visible progress");
		ctx.viewSession = makeSession();
		expect(dock.render(40)).toEqual(["", ""]);
		ctx.viewSession = session;
		expect(plain()).toBe("visible progress");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(dock.render(40)).toEqual([]);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		expect(dock.render(40)).toEqual([]);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "first",
			toolName: "bash",
			result: { content: [{ type: "text", text: "final result must not be replayed" }], details: {} },
		});
		expect(dock.render(40)).toEqual(["", ""]);
		update(session, "background", "finished background output", { async: { state: "completed" } });
		expect(dock.render(40)).toEqual(["", ""]);
		update(session, "background", "new session must clear this", { async: { state: "running" } });
		expect(plain()).toBe("new session must clear this");
		await session.newSession();
		expect(dock.render(40)).toEqual(["", ""]);
	});
});
