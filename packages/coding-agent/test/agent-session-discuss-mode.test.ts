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

const TOOL_NAMES = ["read", "grep", "ask", "write", "edit", "bash", "eval", "todo", "task", "lsp", "mixed"];

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

describe("AgentSession discuss mode context", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	const calls: Array<{ tools: string[]; messages: string }> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-discuss-");
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
		});
		calls.length = 0;
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("injects discussion semantics and exposes only approved investigation tools", async () => {
		session.setDiscussModeState({ enabled: true });
		await session.setActiveToolsByName(TOOL_NAMES);
		await session.prompt("How should this be designed?");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.tools).toEqual(["read", "grep", "ask"]);
		for (const forbidden of ["write", "edit", "bash", "eval", "todo", "task", "lsp", "mixed"]) {
			expect(calls[0]?.tools).not.toContain(forbidden);
		}
		expect(calls[0]?.messages).toContain("Investigation and discussion only");
		expect(calls[0]?.messages).toContain("NEVER authorizes implementation");
		expect(calls[0]?.messages).toContain("create todos");
		expect(calls[0]?.messages).toContain("write implementation plans");

		session.setDiscussModeState(undefined);
		await session.setActiveToolsByName(TOOL_NAMES);
		await session.prompt("Continue normally");
		expect(calls[1]?.messages).not.toContain("Investigation and discussion only");
		expect(calls[1]?.tools).toEqual(TOOL_NAMES);
	});
});
