import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("InteractiveMode thinking preview session ownership", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessions: AgentSession[];
	let focused: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-thinking-owner-");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		sessions = Array.from(
			{ length: 2 },
			() =>
				new AgentSession({
					agent: new Agent({
						initialState: { model, thinkingLevel: Effort.High, systemPrompt: ["Test"], tools: [], messages: [] },
					}),
					sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
					settings,
					modelRegistry,
				}),
		);
		focused = sessions[0]!;
		mode = new InteractiveMode(focused, "test");
		await mode.init({ suppressWelcomeIntro: true });
		// Drive the actual mode consumer with the session selected by focus, without
		// duplicating its private preview/owner state in a controller fixture.
		Object.defineProperty(mode, "viewSession", { configurable: true, get: () => focused });
	});

	afterEach(async () => {
		mode?.stop();
		for (const session of sessions ?? []) await session.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	function render(): string {
		return Bun.stripANSI(mode.ui.render(120).join("\n"));
	}

	function showFirstOwner(): void {
		focused.agent.state.isStreaming = true;
		const message = assistant([{ type: "thinking", thinking: "OWNER_A_FIRST_ROW\nOWNER_A_LAST_ROW" }]);
		focused.agent.state.streamMessage = message;
		focused.agent.state.activeThinkingIndex = 0;
		mode.syncThinkingPreview(message, 0);
		expect(render()).toContain("OWNER_A_FIRST_ROW");
		expect(render()).toContain("OWNER_A_LAST_ROW");
	}

	it("clears the old two-row tail when the newly focused streaming turn has no thought", () => {
		showFirstOwner();
		focused = sessions[1]!;
		focused.agent.state.isStreaming = true;
		focused.agent.state.messages.push(assistant([{ type: "thinking", thinking: "B_PREVIOUS_TURN_ONLY" }]), {
			role: "user",
			content: "new B turn",
			timestamp: 1,
		});
		// Session-context replay registers observed reasoning before restoring the dock.
		for (const message of focused.agent.state.messages) mode.noteDisplayableThinkingContent(message);
		const text = assistant([{ type: "text", text: "B is working without thinking" }]);
		focused.agent.state.streamMessage = text;
		mode.syncThinkingPreview(text);
		expect(render()).not.toContain("OWNER_A_");
		expect(render()).not.toContain("B_PREVIOUS_TURN_ONLY");
		mode.syncThinkingPreview();
		expect(render()).not.toContain("OWNER_A_");
	});

	it.each([false, true])("restores the new owner's current-turn thought with liveSteered=%s", liveSteered => {
		showFirstOwner();
		focused = sessions[1]!;
		focused.agent.state.isStreaming = true;
		focused.agent.state.messages.push(
			{ role: "user", content: "B turn", timestamp: 1 },
			assistant([{ type: "thinking", thinking: "OWNER_B_FIRST_ROW\nOWNER_B_LAST_ROW" }]),
			...(liveSteered
				? [{ role: "user" as const, content: "B midturn steering", liveSteered: true, timestamp: 2 }]
				: []),
		);
		for (const message of focused.agent.state.messages) mode.noteDisplayableThinkingContent(message);
		const text = assistant([{ type: "text", text: "B tool phase" }]);
		focused.agent.state.streamMessage = text;
		mode.syncThinkingPreview(text);
		expect(render()).toContain("OWNER_B_FIRST_ROW");
		expect(render()).toContain("OWNER_B_LAST_ROW");
		expect(render()).not.toContain("OWNER_A_");
	});

	it("does not restore previous-run thinking across a genuine user-invoked Skill boundary", () => {
		showFirstOwner();
		focused = sessions[1]!;
		focused.agent.state.isStreaming = true;
		focused.agent.state.messages.push(assistant([{ type: "thinking", thinking: "B_PREVIOUS_SKILL_RUN" }]), {
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "new Skill request",
			display: true,
			attribution: "user",
			timestamp: 1,
		});
		for (const message of focused.agent.state.messages) mode.noteDisplayableThinkingContent(message);
		mode.syncThinkingPreview();
		expect(render()).not.toContain("OWNER_A_");
		expect(render()).not.toContain("B_PREVIOUS_SKILL_RUN");
	});

	it("retains the same owner's two rows through text, tools and retries until the run ends", () => {
		showFirstOwner();
		focused.agent.state.activeThinkingIndex = undefined;
		const text = assistant([{ type: "text", text: "continuing" }]);
		focused.agent.state.streamMessage = text;
		mode.syncThinkingPreview(text);
		focused.agent.state.streamMessage = null;
		mode.syncThinkingPreview();
		mode.syncThinkingPreview(assistant([]));
		expect(render()).toContain("OWNER_A_FIRST_ROW");
		expect(render()).toContain("OWNER_A_LAST_ROW");
		focused.agent.state.isStreaming = false;
		mode.syncThinkingPreview();
		expect(render()).not.toContain("OWNER_A_");
	});
});
