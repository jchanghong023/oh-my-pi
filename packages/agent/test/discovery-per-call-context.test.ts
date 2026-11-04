import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { Agent } from "../src/agent";
import { estimateTranscriptTokens } from "../src/compaction/transcript-tokens";
import { Tokenizer } from "../src/tokenizer";

describe("request-only context discovery contract", () => {
	// Named producers are counted independently on the reply, but never committed as history.
	it("records named producers on the assistant and does not carry them into the next request", async () => {
		const first: Message = { role: "user", content: "x".repeat(44), timestamp: 0 };
		const second: Message = { role: "user", content: "y".repeat(28), timestamp: 0 };
		markPerCallContextMessage(first, "first-producer");
		markPerCallContextMessage(second, "second-producer");
		const requests: Context[] = [];
		const mock = createMockModel({
			responses: [
				{ content: ["first answer"], usage: { input: 1_000, output: 0 } },
				{ content: ["second answer"], usage: { input: 100, output: 0 } },
			],
		});
		let transforms = 0;
		const agent = new Agent({
			initialState: { model: mock.model, tools: [] },
			transformProviderContext: context => ({
				...context,
				messages: ++transforms === 1 ? [...context.messages, first, second] : context.messages,
			}),
			streamFn: (model, context, options) => {
				requests.push(context);
				return mock.stream(model, context, options);
			},
		});

		await agent.prompt("initial question");
		const reply = agent.state.messages.find((message): message is AssistantMessage => message.role === "assistant");
		expect(reply).toMatchObject({
			perCallContextTokens: 18,
			perCallContextTokensBySource: { "first-producer": 11, "second-producer": 7 },
		});
		expect(agent.state.messages.filter(message => message.role === "user").map(message => message.content)).toEqual([
			[{ type: "text", text: "initial question" }],
		]);
		await agent.prompt("next question");
		expect(requests).toHaveLength(2);
		expect(requests[0].messages).toContain(first);
		expect(requests[0].messages).toContain(second);
		expect(requests[1].messages).not.toContain(first);
		expect(requests[1].messages).not.toContain(second);
		const lastReply = agent.state.messages.findLast(message => message.role === "assistant");
		expect(lastReply).not.toHaveProperty("perCallContextTokens");
		expect(lastReply).not.toHaveProperty("perCallContextTokensBySource");
	});

	// The prior provider report includes request-only bytes; stored-history compaction must not.
	it("removes request-only tokens from the later compaction baseline", async () => {
		const temporary: Message = { role: "user", content: "x".repeat(72), timestamp: 0 };
		markPerCallContextMessage(temporary, "temporary");
		const mock = createMockModel({ responses: [{ content: ["answer"], usage: { input: 1_000, output: 0 } }] });
		const agent = new Agent({
			initialState: { model: mock.model, tools: [] },
			transformProviderContext: context => ({ ...context, messages: [...context.messages, temporary] }),
			streamFn: mock.stream,
		});

		await agent.prompt("question");

		expect(agent.state.messages.find(message => message.role === "assistant")).toMatchObject({
			perCallContextTokens: 18,
			perCallContextTokensBySource: { temporary: 18 },
		});
		expect(estimateTranscriptTokens(agent.state.messages, new Tokenizer())).toBe(982);
	});
});
