import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { filterDiscussToolNames } from "@oh-my-pi/pi-coding-agent/discuss-mode/state";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const TOOL_NAMES = ["read", "write", "bash", "todo", "ask", "lsp", "mystery"];

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

describe("InteractiveMode discuss mode lifecycle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let streamFn: StreamFn | undefined;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-discuss-toggle-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const tools = TOOL_NAMES.map(stubTool);
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (...args) => {
					if (!streamFn) throw new Error("No test stream configured");
					return streamFn(...args);
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: TOOL_NAMES,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
		await session.setActiveToolsByName(TOOL_NAMES);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("filters every active-tool update and restores the exact previous tools", async () => {
		await mode.handleDiscussModeCommand();

		expect(mode.discussModeEnabled).toBe(true);
		expect(session.getActiveToolNames()).toEqual(filterDiscussToolNames(TOOL_NAMES));
		expect(session.getActiveToolNames()).not.toContain("write");

		await session.setActiveToolsByName(["write", "bash", "read", "ask", "mystery"]);
		expect(session.getActiveToolNames()).toEqual(["read", "ask"]);

		await mode.handleDiscussModeCommand("on");
		expect(mode.discussModeEnabled).toBe(true);
		await mode.handleDiscussModeCommand("status");
		expect(mode.discussModeEnabled).toBe(true);

		await mode.handleDiscussModeCommand("off");
		expect(mode.discussModeEnabled).toBe(false);
		expect(session.getActiveToolNames()).toEqual(TOOL_NAMES);
	});

	it("restores a legitimate empty tool snapshot", async () => {
		await session.setActiveToolsByName([]);
		await mode.handleDiscussModeCommand("on");
		await mode.handleDiscussModeCommand("off");
		expect(session.getActiveToolNames()).toEqual([]);
	});

	it("rolls back state and tools when entry fails", async () => {
		vi.spyOn(session, "setActiveToolsByName").mockRejectedValueOnce(new Error("apply failed"));

		await expect(mode.handleDiscussModeCommand("on")).rejects.toThrow("apply failed");
		expect(mode.discussModeEnabled).toBe(false);
		expect(session.getDiscussModeState()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(TOOL_NAMES);
	});

	it("interrupts an active turn before applying the read-only tools", async () => {
		const started = Promise.withResolvers<void>();
		streamFn = (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				options?.signal?.addEventListener(
					"abort",
					() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
					{ once: true },
				);
				started.resolve();
			});
			return stream;
		};
		const prompt = session.prompt("Explain this");
		await started.promise;

		await mode.handleDiscussModeCommand("on");
		await prompt;

		expect(session.isStreaming).toBe(false);
		expect(session.getActiveToolNames()).toEqual(filterDiscussToolNames(TOOL_NAMES));
	});

	it("rehydrates the read-only mode and its restoration snapshot", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleDiscussModeCommand("on");
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(mode.discussModeEnabled).toBe(true);
		expect(session.getActiveToolNames()).toEqual(filterDiscussToolNames(TOOL_NAMES));

		await mode.handleDiscussModeCommand("off");
		expect(session.getActiveToolNames()).toEqual(TOOL_NAMES);
	});
});
