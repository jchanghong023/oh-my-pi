import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
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

describe("InteractiveMode Primary Agent Tab fallback", () => {
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
	});

	afterEach(async () => {
		mode.stop();
		await session.dispose();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("cycles while idle without changing the draft", async () => {
		mode.editor.setText("draft stays here");
		const firstSwitch = Promise.withResolvers<void>();
		const secondSwitch = Promise.withResolvers<void>();
		let switchCount = 0;
		const previousOnEntryAppended = session.sessionManager.onEntryAppended;
		session.sessionManager.onEntryAppended = entry => {
			previousOnEntryAppended?.(entry);
			if (entry.type !== "primary_agent_change") return;
			(++switchCount === 1 ? firstSwitch : secondSwitch).resolve();
		};
		expect(mode.cyclePrimaryAgentFromTab()).toBe(true);
		await firstSwitch.promise;
		expect(session.getPrimaryAgentId()).toBe("discuss");
		expect(mode.editor.getText()).toBe("draft stays here");
		expect(mode.cyclePrimaryAgentFromTab()).toBe(true);
		await secondSwitch.promise;
		expect(session.getPrimaryAgentId()).toBe("main");
	});

	it("falls through to the base completion pipeline while a workflow blocks switching", () => {
		mode.planModeEnabled = true;
		mode.editor.setText("/he");
		const baseEditorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(mode.editor)) as {
			handleInput(data: string): void;
		};
		const baseHandleInput = vi.spyOn(baseEditorPrototype, "handleInput");
		mode.editor.handleInput("\t");
		expect(session.getPrimaryAgentId()).toBe("main");
		expect(baseHandleInput).toHaveBeenCalledWith("\t");
	});

	it("shows a warning when an accepted switch fails", async () => {
		const warning = vi.spyOn(mode, "showWarning");
		const attempted = Promise.withResolvers<void>();
		vi.spyOn(session, "cyclePrimaryAgent").mockImplementationOnce(async () => {
			attempted.resolve();
			throw new Error("switch failed");
		});
		expect(mode.cyclePrimaryAgentFromTab()).toBe(true);
		await attempted.promise;
		await Promise.resolve();
		expect(session.getPrimaryAgentId()).toBe("main");
		expect(warning).toHaveBeenCalledWith("switch failed");
	});
});
