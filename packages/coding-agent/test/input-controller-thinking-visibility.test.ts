import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
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
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, thinkingLevel: Effort.High, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
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

	function stream(message: AssistantMessage, activeThinkingIndex?: number): void {
		session.agent.state.streamMessage = message;
		session.agent.state.activeThinkingIndex = activeThinkingIndex;
		mode.syncThinkingPreview(message, activeThinkingIndex);
	}

	it("shows live thinking in a fresh compact profile and hides/restores only that window", () => {
		const history = assistant([
			{ type: "thinking", thinking: "historical-private-reasoning" },
			{ type: "text", text: "ordinary historical answer" },
		]);
		session.agent.state.messages.push(history);
		mode.addMessageToChat(history);
		const live = assistant([
			{ type: "thinking", thinking: "earlier-live-block" },
			{ type: "text", text: "intervening ordinary text" },
			{ type: "thinking", thinking: "current-live-reasoning" },
		]);
		stream(live, 2);
		expect(render()).toContain("current-live-reasoning");
		expect(render()).toContain("ordinary historical answer");
		expect(render()).not.toContain("historical-private-reasoning");
		expect(render()).not.toContain("earlier-live-block");

		controller.toggleThinkingBlockVisibility();
		expect(cfgHideThinkingBlock.get(session.settings)).toBe(true);
		expect(render()).not.toContain("current-live-reasoning");
		expect(render()).toContain("ordinary historical answer");

		controller.toggleThinkingBlockVisibility();
		expect(cfgHideThinkingBlock.get(session.settings)).toBe(false);
		expect(render()).toContain("current-live-reasoning");
		expect(render()).not.toContain("historical-private-reasoning");
		expect(render()).not.toContain("earlier-live-block");
		expect(session.agent.state.messages).toEqual([history]);
		expect(session.agent.state.streamMessage).toBe(live);
	});

	it("applies live prose settings to the raw snapshot before taking five preview rows", async () => {
		const history = assistant([
			{ type: "thinking", thinking: "historical-prose\n```ts\nhistorical-code\n```" },
			{ type: "text", text: "historical answer remains unchanged" },
		]);
		session.agent.state.messages.push(history);
		mode.addMessageToChat(history);
		const prose = Array.from({ length: 7 }, (_, index) => `preview-prose-${index + 1}`);
		const code = Array.from({ length: 7 }, (_, index) => `preview-code-${index + 1}`);
		const message = assistant([{ type: "thinking", thinking: [...prose, "```ts", ...code, "```"].join("\n") }]);
		const original = structuredClone({ message, history });
		const previewRows = () =>
			render()
				.split("\n")
				.map(line => line.trim().replace(/^│\s*/, ""))
				.filter(line => line.startsWith("preview-") || line === "```");
		stream(message, 0);

		const filteredRows = [...prose.slice(-5, -1), `${prose[6]}...`];
		expect(previewRows()).toEqual(filteredRows);
		expect(render()).not.toContain("preview-code-");
		expect(render()).not.toContain("```");

		cfgProseOnlyThinking.set(session.settings, false);
		await Promise.resolve();
		expect(previewRows()).toEqual([...code.slice(-4), "```"]);
		expect(render()).not.toContain("preview-prose-");

		cfgProseOnlyThinking.set(session.settings, true);
		await Promise.resolve();
		expect(previewRows()).toEqual(filteredRows);
		expect(render()).not.toContain("preview-code-");
		expect(render()).toContain("historical answer remains unchanged");
		expect(render()).not.toContain("historical-prose");
		expect(render()).not.toContain("historical-code");
		expect(session.agent.state.streamMessage).toBe(message);
		expect(session.agent.state.activeThinkingIndex).toBe(0);
		expect(session.agent.state.messages).toEqual([original.history]);
		expect(message).toEqual(original.message);
	});

	it("does not reopen hidden or finished thinking when the prose setting changes", async () => {
		const message = assistant([{ type: "thinking", thinking: "active-prose\n```ts\nactive-code\n```" }]);
		stream(message, 0);
		expect(render()).toContain("active-prose...");
		expect(render()).not.toContain("active-code");

		controller.toggleThinkingBlockVisibility();
		for (const proseOnly of [false, true]) {
			cfgProseOnlyThinking.set(session.settings, proseOnly);
			await Promise.resolve();
			expect(render()).not.toContain("active-prose");
			expect(render()).not.toContain("active-code");
		}
		controller.toggleThinkingBlockVisibility();
		expect(render()).toContain("active-prose...");
		expect(render()).not.toContain("active-code");

		stream(message);
		for (const proseOnly of [false, true]) {
			cfgProseOnlyThinking.set(session.settings, proseOnly);
			await Promise.resolve();
			expect(render()).not.toContain("active-prose");
			expect(render()).not.toContain("active-code");
		}

		stream(message, 0);
		session.agent.state.streamMessage = null;
		session.agent.state.activeThinkingIndex = undefined;
		mode.clearThinkingPreview();
		for (const proseOnly of [false, true]) {
			cfgProseOnlyThinking.set(session.settings, proseOnly);
			await Promise.resolve();
			expect(render()).not.toContain("active-prose");
			expect(render()).not.toContain("active-code");
		}
		expect(session.agent.state.streamMessage).toBeNull();
		expect(message.content).toEqual([{ type: "thinking", thinking: "active-prose\n```ts\nactive-code\n```" }]);
	});

	it("keeps the finished thinking stub through settings refreshes during a running turn", async () => {
		const message = assistant([{ type: "thinking", thinking: "earlier thought\nretained-tool-bridge" }]);
		session.agent.state.isStreaming = true;
		try {
			stream(message, 0);
			session.agent.state.activeThinkingIndex = undefined;
			mode.collapseThinkingPreview();
			cfgProseOnlyThinking.set(session.settings, false);
			await Promise.resolve();
			expect(render()).toContain("… retained-tool-bridge");
			expect(render()).not.toContain("earlier thought");

			stream(message, 0);
			session.agent.state.streamMessage = null;
			session.agent.state.activeThinkingIndex = undefined;
			mode.syncThinkingPreview();
			cfgExpandThinkingBlocks.set(session.settings, true);
			await Promise.resolve();
			expect(render()).toContain("… retained-tool-bridge");
			expect(render()).not.toContain("earlier thought");

			session.agent.state.isStreaming = false;
			mode.syncThinkingPreview();
			expect(render()).not.toContain("retained-tool-bridge");
		} finally {
			session.agent.state.isStreaming = false;
		}
	});

	it("restores the latest active snapshot after hidden streaming, not the previously visible block", () => {
		stream(assistant([{ type: "thinking", thinking: "previously-visible-reasoning" }]), 0);
		controller.toggleThinkingBlockVisibility();
		stream(
			assistant([
				{ type: "thinking", thinking: "previously-visible-reasoning" },
				{ type: "text", text: "a completed text phase" },
				{ type: "thinking", thinking: "newest-hidden-reasoning" },
			]),
			2,
		);
		expect(render()).not.toContain("newest-hidden-reasoning");

		controller.toggleThinkingBlockVisibility();
		expect(render()).toContain("newest-hidden-reasoning");
		expect(render()).not.toContain("previously-visible-reasoning");
	});

	it("does not revive completed thinking when toggled during text or after the stream ends", () => {
		const message = assistant([
			{ type: "thinking", thinking: "finished-reasoning-must-stay-gone" },
			{ type: "text", text: "current answer" },
		]);
		stream(message, 0);
		controller.toggleThinkingBlockVisibility();
		stream(message);
		controller.toggleThinkingBlockVisibility();
		expect(render()).not.toContain("finished-reasoning-must-stay-gone");

		session.agent.state.streamMessage = null;
		session.agent.state.activeThinkingIndex = undefined;
		mode.clearThinkingPreview();
		controller.toggleThinkingBlockVisibility();
		controller.toggleThinkingBlockVisibility();
		expect(render()).not.toContain("finished-reasoning-must-stay-gone");
		expect(cfgHideThinkingBlock.get(session.settings)).toBe(false);
	});

	it("allows hiding and restoring observed live thinking even when the model thinking level is off", () => {
		session.setThinkingLevel("off");
		stream(assistant([{ type: "thinking", thinking: "observed-provider-reasoning" }]), 0);
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
