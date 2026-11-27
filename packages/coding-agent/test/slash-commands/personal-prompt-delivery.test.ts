import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { personalCommandProtocolModel } from "../helpers/personal-command-model";

const tools: AgentTool[] = ["task", "eval"].map(name => ({
	name,
	label: name,
	description: "Available capability",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text", text: "not requested" }] }),
}));

describe("personal prompt commands reach the provider", () => {
	it.each([
		["minimal", undefined],
		["jchime", undefined],
		["ultrathink", "ultrathink-notice"],
		["orchestrate", "orchestrate-notice"],
		["workflowz", "workflow-notice"],
	])("delivers /%s as an expanded user message", async (name, noticeType) => {
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
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			settings,
			sessionManager,
			modelRegistry: new ModelRegistry(auth),
		});
		try {
			const task = "task-marker-5bc";
			const command = `/${name} ${task}`;
			let prompt: string;
			if (noticeType) {
				const ctx = createInteractiveModeContext({ session, sessionManager, settings });
				const expanded = await executeBuiltinSlashCommand(command, { ctx });
				if (typeof expanded !== "string") throw new Error(`Expected a TUI model prompt for /${name}`);
				prompt = expanded;
			} else {
				const runtime: SlashCommandRuntime = {
					session,
					sessionManager,
					settings,
					cwd: sessionManager.getCwd(),
					output: () => {},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				};
				const expanded = await executeAcpBuiltinSlashCommand(command, runtime);
				if (!expanded || !("prompt" in expanded)) throw new Error(`Expected an ACP model prompt for /${name}`);
				expect(expanded.prompt).toContain(task);
				expect(expanded.prompt).not.toBe(command);
				expect(expanded.prompt).not.toBe(task);
				prompt = expanded.prompt;
			}

			expect(await session.prompt(prompt)).toBe(true);
			expect(provider.calls).toHaveLength(1);
			const messages = provider.calls[0]!.context.messages;
			const users = messages.filter(message => message.role === "user");
			expect(users).toEqual([
				expect.objectContaining({
					attribution: "user",
					content: [{ type: "text", text: prompt }],
				}),
			]);

			if (noticeType) {
				const notice = session.agent.state.messages.find(
					message => message.role === "custom" && message.customType === noticeType,
				);
				if (notice?.role !== "custom" || typeof notice.content !== "string") {
					throw new Error(`Expected a ${noticeType} message`);
				}
				expect(notice).toMatchObject({ display: false, attribution: "user" });
				expect(notice.content).toMatch(/\S/);
				expect(messages.slice(0, messages.indexOf(users[0]!))).toContainEqual(
					expect.objectContaining({
						role: "developer",
						attribution: "user",
						content: [{ type: "text", text: notice.content }],
					}),
				);
			}
		} finally {
			await session.dispose();
			auth.close();
		}
	});
});
