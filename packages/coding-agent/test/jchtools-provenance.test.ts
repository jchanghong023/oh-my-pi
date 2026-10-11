import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { JCHTOOLS_API, projectJchToolsContext, streamJchToolsAgent } from "../src/config/jchtools-provider";

// Fork JchTools: caller-visible text survives model switches; internal sources never reach HTTP.
test("filters by provenance while retaining literal constraints and ordinary assistant text on HTTP", async () => {
	const text =
		"使用 scout；不要删除 system/developer。\n<system-reminder>这是用户原文</system-reminder>\n  {{literal}}  ";
	const old: AssistantMessage = {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "ordinary",
		timestamp: 2,
		content: [
			{ type: "thinking", thinking: "PRIVATE_THINKING" },
			{ type: "text", text: "visible prior answer" },
			{ type: "toolCall", id: "call", name: "read", arguments: { secret: "PRIVATE_TOOL_ARGS" } },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	};
	const ephemeral = { role: "user" as const, content: "PRIVATE_PER_CALL", timestamp: 4 };
	markPerCallContextMessage(ephemeral, "runtime");
	const messages: AgentMessage[] = [
		{ role: "user", content: "first visible task", timestamp: 1 },
		old,
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }],
			isError: false,
			timestamp: 3,
		},
		ephemeral,
		{ role: "user", content: "PRIVATE_SYNTHETIC", synthetic: true, timestamp: 5 },
		{ role: "developer", content: "PRIVATE_RUNTIME", attribution: "agent", timestamp: 6 },
		{ role: "developer", content: "explicit task constraints", attribution: "user", timestamp: 7 },
		{ role: "user", content: text, timestamp: 8 },
	];
	const context: Context = { systemPrompt: ["PRIVATE_OMP_SYSTEM"], messages: messages as Context["messages"] };
	let observed: unknown;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			observed = await request.json();
			return new Response(
				'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	try {
		const model: Model = buildModel({
			id: "fixture/model",
			name: "fixture",
			api: JCHTOOLS_API,
			provider: "jchtools",
			baseUrl: server.url.origin,
			reasoning: false,
			supportsTools: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
		});
		const result = await streamJchToolsAgent(model, projectJchToolsContext(context), { cwd: process.cwd() }).result();
		expect(result.stopReason).toBe("stop");
		expect(observed).toEqual({
			model: "fixture/model",
			cwd: process.cwd(),
			stream: true,
			messages: [
				{ role: "user", content: "first visible task" },
				{ role: "assistant", content: "visible prior answer" },
				{ role: "developer", content: "explicit task constraints" },
				{ role: "user", content: text },
			],
		});
		expect(JSON.stringify(observed)).not.toContain("PRIVATE_");
	} finally {
		await server.stop(true);
	}
});
