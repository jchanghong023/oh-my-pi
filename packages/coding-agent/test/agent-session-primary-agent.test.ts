import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const TOOL_NAMES = ["read", "grep", "ask", "write", "edit", "bash", "eval", "todo", "task", "mcp__test", "unknown"];

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

describe("AgentSession Primary Agent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let failRebuild = false;
	const calls: Array<{ tools: string[]; messages: string; systemPrompt: string }> = [];

	beforeEach(async () => {
		failRebuild = false;
		tempDir = TempDir.createSync("@pi-agent-session-primary-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const tools = TOOL_NAMES.map(stubTool);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				calls.push({
					tools: (context.tools ?? []).map(tool => tool.name),
					messages: JSON.stringify(context.messages),
					systemPrompt: (context.systemPrompt ?? []).join("\n"),
				});
				const response = createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.eager": "default", "task.eager": "off" }),
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: TOOL_NAMES,
			rebuildSystemPrompt: async () => {
				if (failRebuild) throw new Error("rebuild failed");
				return { systemPrompt: ["Test"] };
			},
		});
		await session.setActiveToolsByName(TOOL_NAMES);
		calls.length = 0;
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("switches profiles on one session while preserving history, model, and the latest base slate", async () => {
		const identity = session;
		const model = session.model;
		await session.prompt("Remember this Main turn");
		await session.setPrimaryAgent("discuss");
		expect(session).toBe(identity);
		expect(session.model).toBe(model);
		expect(session.getActiveToolNames()).toEqual(["read", "grep", "ask"]);
		expect(session.getBaseActiveToolNames()).toEqual(TOOL_NAMES);
		await session.setActiveToolsByName(["write", "read", "task", "ask", "grep"]);
		expect(session.getActiveToolNames()).toEqual(["read", "ask", "grep"]);
		await session.prompt("Discuss the prior turn");
		expect(calls[1]?.messages).toContain("Remember this Main turn");
		expect(calls[1]?.systemPrompt).toContain("Discuss primary agent is active");

		await session.setPrimaryAgent("main");
		expect(session.getActiveToolNames()).toEqual(["write", "read", "task", "ask", "grep"]);
		await session.prompt("Continue in Main");
		expect(calls[2]?.messages).toContain("Discuss the prior turn");
		expect(calls[2]?.systemPrompt).not.toContain("Discuss primary agent is active");
	});

	it("rejects a stale forbidden tool at execution time", async () => {
		const staleWrite = session.agent.state.tools.find(tool => tool.name === "write");
		if (!staleWrite) throw new Error("Expected active write tool");
		await session.setPrimaryAgent("discuss");
		await expect(staleWrite.execute("stale", {}, undefined, () => {}, undefined as never)).rejects.toThrow(
			"unavailable to the Discuss primary agent",
		);
	});
	it("rolls back the profile and does not persist when projection fails", async () => {
		const entriesBefore = session.sessionManager.getEntries().length;
		failRebuild = true;
		await expect(session.setPrimaryAgent("discuss")).rejects.toThrow("rebuild failed");
		expect(session.getPrimaryAgentId()).toBe("main");
		expect(session.getActiveToolNames()).toEqual(TOOL_NAMES);
		expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
	});

	it("serializes rapid cycle intents in input order", async () => {
		const first = session.cyclePrimaryAgent();
		const second = session.cyclePrimaryAgent();
		await expect(Promise.all([first, second])).resolves.toEqual(["discuss", "main"]);
		expect(session.getPrimaryAgentId()).toBe("main");
		expect(
			session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "primary_agent_change")
				.map(entry => entry.primaryAgent),
		).toEqual(["discuss", "main"]);
	});

	it("persists successful profile changes with a dedicated entry", async () => {
		await session.setPrimaryAgent("discuss");
		expect(session.sessionManager.buildSessionContext().primaryAgent).toBe("discuss");
		expect(session.sessionManager.getEntries().at(-1)).toMatchObject({
			type: "primary_agent_change",
			primaryAgent: "discuss",
		});
	});
});
