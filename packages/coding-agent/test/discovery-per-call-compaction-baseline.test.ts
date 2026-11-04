import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("request-only context compaction consumer", () => {
	// Exercise the real response annotation, journal snapshot, and context breakdown used by pre-prompt compaction.
	it("keeps temporary provider context out of the next prompt's stored-history baseline", async () => {
		const temporary: Message = { role: "user", content: "x".repeat(72), timestamp: 0 };
		markPerCallContextMessage(temporary, "temporary");
		const mock = createMockModel({
			responses: [{ content: ["answer"], usage: { input: 1_000, output: 0 } }],
			contextWindow: 128_000,
			maxTokens: 2_048,
		});
		const agent = new Agent({
			initialState: { model: mock.model, tools: [] },
			convertToLlm,
			transformProviderContext: context => ({ ...context, messages: [...context.messages, temporary] }),
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: { getApiKey: async () => "test-key" } as unknown as ModelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		});
		try {
			await session.prompt("question");
			await session.waitForIdle();

			const assistant = session.sessionManager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			expect(assistant).toMatchObject({
				message: {
					usage: { input: 1_000, output: 0 },
					perCallContextTokens: 18,
					perCallContextTokensBySource: { temporary: 18 },
				},
			});
			expect(session.messages).not.toContain(temporary);
			const baseline = session.getContextBreakdown({ contextWindow: 128_000 });
			expect(baseline).toMatchObject({ anchored: true, usedTokens: 982 });
			const pending = session.getContextBreakdown({
				contextWindow: 128_000,
				pendingMessages: [{ role: "user", content: "n".repeat(40), timestamp: Date.now() }],
			});
			expect(pending).toMatchObject({ anchored: true, usedTokens: 992 });
		} finally {
			await session.dispose();
		}
	});
});
