import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const TOOL_NAMES = ["read", "write", "bash", "todo", "ask", "task", "unknown"];

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

describe("InteractiveMode Primary Agent Ctrl+0 shortcut", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-primary-agent-toggle-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		setKittyProtocolActive(true);
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model");
		const tools = TOOL_NAMES.map(stubTool);
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools, messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: TOOL_NAMES,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
		await session.setActiveToolsByName(TOOL_NAMES);
		// Bind editor actions without starting a real terminal.
		mode.setEditorComponent(undefined);
	});

	afterEach(async () => {
		mode.stop();
		await session.dispose();
		setKittyProtocolActive(false);
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("cycles both directions with Ctrl+0 while preserving the draft", async () => {
		mode.editor.setText("draft stays here");
		const cycle = vi.spyOn(session, "cyclePrimaryAgent");
		const firstSwitch = Promise.withResolvers<void>();
		const secondSwitch = Promise.withResolvers<void>();
		const switches = [firstSwitch, secondSwitch];
		const previousOnEntryAppended = session.sessionManager.onEntryAppended;
		session.sessionManager.onEntryAppended = entry => {
			previousOnEntryAppended?.(entry);
			if (entry.type !== "primary_agent_change") return;
			switches.shift()?.resolve();
		};
		expect(mode.keybindings.getKeys("app.primaryAgent.cycle")).toEqual(["ctrl+0"]);
		expect(mode.editor.onClear).toBeDefined();
		expect(mode.editor.onCyclePrimaryAgent).toBeDefined();
		mode.editor.handleInput("\x1b[48;5u");
		expect(cycle).toHaveBeenCalledTimes(1);
		await firstSwitch.promise;
		expect(session.getPrimaryAgentId()).toBe("discuss");
		expect(mode.editor.getText()).toBe("draft stays here");
		mode.editor.handleInput("\x1b[48;5u");
		await secondSwitch.promise;
		expect(session.getPrimaryAgentId()).toBe("main");
	});

	it("keeps Tab in the base completion pipeline", () => {
		mode.editor.setText("/he");
		const baseEditorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(mode.editor)) as {
			handleInput(data: string): void;
		};
		const baseHandleInput = vi.spyOn(baseEditorPrototype, "handleInput");
		mode.editor.handleInput("\t");
		expect(session.getPrimaryAgentId()).toBe("main");
		expect(baseHandleInput).toHaveBeenCalledWith("\t");
	});

	it("blocks Ctrl+0 while streaming or a workflow is enabled or paused", () => {
		const cycle = vi.spyOn(session, "cyclePrimaryAgent");
		const blockedStates: Array<readonly [string, () => void, () => void]> = [
			["streaming", () => (session.agent.state.isStreaming = true), () => (session.agent.state.isStreaming = false)],
			["plan", () => (mode.planModeEnabled = true), () => (mode.planModeEnabled = false)],
			["paused plan", () => (mode.planModePaused = true), () => (mode.planModePaused = false)],
			["goal", () => (mode.goalModeEnabled = true), () => (mode.goalModeEnabled = false)],
			["paused goal", () => (mode.goalModePaused = true), () => (mode.goalModePaused = false)],
			["vibe", () => (mode.vibeModeEnabled = true), () => (mode.vibeModeEnabled = false)],
		];
		for (const [name, enable, disable] of blockedStates) {
			enable();
			mode.editor.handleInput("\x1b[48;5u");
			disable();
			expect(cycle, name).not.toHaveBeenCalled();
		}
	});

	it("refreshes the status-line primary agent after a transcript replay", async () => {
		const status = vi.spyOn(mode.statusLine, "setPrimaryAgentStatus");
		await session.setPrimaryAgent("discuss");
		await mode.renderInitialMessages();
		expect(status).toHaveBeenLastCalledWith("discuss");
	});

	it("shows a warning when an accepted switch fails", async () => {
		const warning = vi.spyOn(mode, "showWarning");
		const attempted = Promise.withResolvers<void>();
		vi.spyOn(session, "cyclePrimaryAgent").mockImplementationOnce(async () => {
			attempted.resolve();
			throw new Error("switch failed");
		});
		expect(mode.cyclePrimaryAgentFromShortcut()).toBe(true);
		await attempted.promise;
		await Promise.resolve();
		expect(session.getPrimaryAgentId()).toBe("main");
		expect(warning).toHaveBeenCalledWith("switch failed");
	});
});
