import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { personalCommandProtocolModel } from "../helpers/personal-command-model";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand, executeRpcBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import type { RpcSlashCommandRuntime } from "../../src/slash-commands/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const tools: AgentTool[] = ["task", "eval"].map(name => ({
	name,
	label: name,
	description: "Available capability",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text", text: "not requested" }] }),
}));

describe("personal prompt commands reach the provider", () => {
	it.each([
		["/minimal task-marker-5bc", undefined],
		["/jchime task-marker-5bc", undefined],
		["/jch-workflowzbatch 12 2 task-marker-5bc\n    preserve indentation  ", "workflow-notice"],
		["/ultrathink task-marker-5bc", "ultrathink-notice"],
		["/orchestrate task-marker-5bc", "orchestrate-notice"],
		["/workflowz task-marker-5bc", "workflow-notice"],
	])("delivers %s as an ordinary expanded user message with native notices", async (command, notice) => {
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("anthropic", "test-key");
		const provider = createMockModel({ responses: [{ content: ["received"] }] });
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			initialState: { model: personalCommandProtocolModel(), systemPrompt: ["Test"], tools },
			streamFn: provider.stream,
			convertToLlm,
			getApiKey: () => "test-key",
		});
		const session = new AgentSession({
			agent,
			settings,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(auth),
		});
		try {
			const runtime = { session, settings, output: () => {} } as unknown as RpcSlashCommandRuntime;
			const expanded = await executeRpcBuiltinSlashCommand(command, runtime);
			const acp = await executeAcpBuiltinSlashCommand(command, runtime);
			expect(acp).toEqual(expanded);
			if (!expanded || !("prompt" in expanded)) throw new Error("Expected a model prompt");
			expect(expanded.prompt).toContain("task-marker-5bc");
			await session.prompt(expanded.prompt);
			expect(provider.calls).toHaveLength(1);
			const users = provider.calls[0]!.context.messages.filter(message => message.role === "user");
			const user = users.at(-1)!;
			const text =
				typeof user.content === "string"
					? user.content
					: user.content
							.filter(part => part.type === "text")
							.map(part => (part.type === "text" ? part.text : ""))
							.join("\n");
			expect(text).toBe(expanded.prompt);
			if (notice)
				expect(session.agent.state.messages).toContainEqual(expect.objectContaining({ customType: notice }));
		} finally {
			await session.dispose();
			auth.close();
		}
	});
});
