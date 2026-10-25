import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayCompactToolActivity, cfgDisplayHideToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgExpandThinkingBlocks,
	cfgHideThinkingBlock,
	cfgProseOnlyThinking,
} from "@oh-my-pi/pi-coding-agent/session/settings";
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

describe("InputController thinking visibility", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let controller: InputController;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-thinking-visibility-");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true, "display.smoothStreaming": false },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		// AgentSession owns the effective level and normalizes the agent's initial state.
		session.setThinkingLevel(Effort.High);
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });
		controller = new InputController(mode);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	function render(): string {
		return Bun.stripANSI(mode.ui.render(120).join("\n"));
	}

	async function stream(message: AssistantMessage, activeThinkingIndex = 0): Promise<void> {
		session.agent.state.isStreaming = true;
		session.agent.state.streamMessage = message;
		session.agent.state.activeThinkingIndex = activeThinkingIndex;
		const started = assistant([]);
		await mode.eventController.handleEvent({ type: "message_start", message: started });
		const thinkingStart = assistant([{ type: "thinking", thinking: "" }]);
		await mode.eventController.handleEvent({
			type: "message_update",
			message: thinkingStart,
			assistantMessageEvent: { type: "thinking_start", contentIndex: activeThinkingIndex, partial: thinkingStart },
		});
		const thinking = message.content[activeThinkingIndex];
		if (thinking?.type !== "thinking") throw new Error("Expected a live thinking block");
		await mode.eventController.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: activeThinkingIndex,
				delta: thinking.thinking,
				partial: message,
			},
		});
	}

	it("toggles live thinking visibility without modifying stored reasoning", async () => {
		cfgExpandThinkingBlocks.set(session.settings, true);
		const history = assistant([
			{ type: "thinking", thinking: "historical-private-reasoning" },
			{ type: "text", text: "ordinary historical answer" },
		]);
		session.agent.state.messages.push(history);
		mode.addMessageToChat(history);
		const live = assistant([{ type: "thinking", thinking: "current-live-reasoning" }]);
		await stream(live);
		expect(render()).toContain("current-live-reasoning");
		controller.toggleThinkingBlockVisibility();
		expect(cfgHideThinkingBlock.get(session.settings)).toBe(true);
		expect(render()).not.toContain("current-live-reasoning");
		expect(render()).not.toContain("historical-private-reasoning");
		expect(render()).toContain("ordinary historical answer");
		controller.toggleThinkingBlockVisibility();
		expect(render()).toContain("current-live-reasoning");
		expect(session.agent.state.messages).toEqual([history]);
		expect(session.agent.state.streamMessage).toBe(live);
	});

	it("preserves reasoning and answers across compact, clean and detailed rebuilds", async () => {
		const history = assistant([
			{ type: "thinking", thinking: "historical reasoning" },
			{ type: "text", text: "historical answer" },
		]);
		session.agent.state.messages.push(history);
		session.sessionManager.appendMessage(history);
		mode.addMessageToChat(history);
		expect(render()).toContain("historical answer");
		cfgExpandThinkingBlocks.set(session.settings, true);
		const original = structuredClone(history);
		for (const [compact, hidden] of [
			[true, false],
			[true, true],
			[false, false],
		] as const) {
			cfgDisplayCompactToolActivity.set(session.settings, compact);
			cfgDisplayHideToolActivity.set(session.settings, hidden);
			await Promise.resolve();
			const rendered = render();
			expect(rendered).toContain("historical answer");
		}
		expect(history).toEqual(original);
		expect(session.agent.state.messages).toEqual([original]);
	});

	it("applies prose filtering before clipping inline reasoning without modifying its source", async () => {
		const prose = Array.from({ length: 7 }, (_, index) => `preview-prose-${index + 1}`);
		const code = Array.from({ length: 7 }, (_, index) => `preview-code-${index + 1}`);
		const message = assistant([{ type: "thinking", thinking: [...prose, "```ts", ...code, "```"].join("\n") }]);
		const original = structuredClone(message);
		await stream(message);
		expect(render()).toContain("preview-prose-7");
		expect(render()).not.toContain("preview-prose-1");
		expect(render()).not.toContain("preview-code-");
		cfgProseOnlyThinking.set(session.settings, false);
		await Promise.resolve();
		expect(render()).toContain("preview-code-7");
		expect(render()).not.toContain("preview-prose-");
		controller.toggleThinkingBlockVisibility();
		cfgProseOnlyThinking.set(session.settings, true);
		await Promise.resolve();
		expect(render()).not.toContain("preview-prose-");
		expect(render()).not.toContain("preview-code-");
		expect(message).toEqual(original);
	});

	it("allows hiding and restoring observed live thinking even when the model thinking level is off", async () => {
		session.setThinkingLevel("off");
		await stream(assistant([{ type: "thinking", thinking: "observed-provider-reasoning" }]), 0);
		expect(render()).toContain("observed-provider-reasoning");
		controller.toggleThinkingBlockVisibility();
		expect(cfgHideThinkingBlock.get(session.settings)).toBe(true);
		expect(render()).not.toContain("observed-provider-reasoning");
		controller.toggleThinkingBlockVisibility();
		expect(cfgHideThinkingBlock.get(session.settings)).toBe(false);
		expect(render()).toContain("observed-provider-reasoning");
	});

	for (const hidden of [false, true]) {
		it(`preserves the ${hidden ? "hidden" : "visible"} preference while thinking is off without live content`, () => {
			session.setThinkingLevel("off");
			if (hidden) cfgHideThinkingBlock.set(session.settings, true);
			mode.hideThinkingBlock = hidden;
			const showStatus = vi.spyOn(mode, "showStatus");
			controller.toggleThinkingBlockVisibility();
			expect(cfgHideThinkingBlock.get(session.settings)).toBe(hidden);
			expect(cfgHideThinkingBlock.isConfigured(session.settings)).toBe(hidden);
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Thinking is off"));
		});
	}

	it("uses the focused session's thinking level rather than the root session's", () => {
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			settings,
			session: { thinkingLevel: "high" },
			viewSession: { thinkingLevel: "off" },
			hasDisplayableThinkingContent: false,
			showStatus,
		} as unknown as InteractiveModeContext;
		new InputController(ctx).toggleThinkingBlockVisibility();
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Thinking is off"));
	});
});
