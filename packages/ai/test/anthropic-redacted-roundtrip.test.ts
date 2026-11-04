import { describe, expect, test } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function response() {
	return new Response(
		[
			frame("message_start", {
				type: "message_start",
				message: { id: "redacted-roundtrip", usage: { input_tokens: 4, output_tokens: 0 } },
			}),
			frame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
			frame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "reasoning" },
			}),
			frame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "original-signature" },
			}),
			frame("content_block_stop", { type: "content_block_stop", index: 0 }),
			frame("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: { type: "redacted_thinking", data: "opaque+/=\u0000payload" },
			}),
			frame("content_block_stop", { type: "content_block_stop", index: 1 }),
			frame("content_block_start", {
				type: "content_block_start",
				index: 2,
				content_block: { type: "text", text: "" },
			}),
			frame("content_block_delta", {
				type: "content_block_delta",
				index: 2,
				delta: { type: "text_delta", text: "answer" },
			}),
			frame("content_block_stop", { type: "content_block_stop", index: 2 }),
			frame("content_block_start", {
				type: "content_block_start",
				index: 3,
				content_block: { type: "redacted_thinking", data: "trailing-opaque" },
			}),
			frame("content_block_stop", { type: "content_block_stop", index: 3 }),
			frame("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 3 },
			}),
			frame("message_stop", { type: "message_stop" }),
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("Anthropic event-less redacted thinking wire roundtrip", () => {
	// Drive provider decoding, the local stream projector and the next request serializer together.
	test("preserves middle and trailing opaque blocks through persisted JSON and the next request", async () => {
		const model = buildModel({
			id: "claude-sonnet-4-5",
			name: "Compatible endpoint",
			provider: "ascend",
			api: "anthropic-messages",
			baseUrl: "http://compatible.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		});
		const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
		const fetchFixture: FetchImpl = async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return response();
		};
		const context: Context = { messages: [{ role: "user", content: "first", timestamp: 0 }] };
		const first = await stream(model, context, { apiKey: "fixture-key", fetch: fetchFixture }).result();
		expect(first.stopReason).toBe("stop");
		expect(first.content.map(block => block.type)).toEqual([
			"thinking",
			"redactedThinking",
			"text",
			"redactedThinking",
		]);
		expect(first.content[1]).toEqual({ type: "redactedThinking", data: "opaque+/=\u0000payload" });
		expect(first.content[3]).toEqual({ type: "redactedThinking", data: "trailing-opaque" });
		// Journals serialize messages as JSON; replay must not depend on in-memory block symbols.
		const persisted = JSON.parse(JSON.stringify(first));
		const next = await stream(
			model,
			{
				messages: [...context.messages, persisted, { role: "user", content: "continue", timestamp: 1 }],
			},
			{ apiKey: "fixture-key", fetch: fetchFixture },
		).result();
		expect(next.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		const replay = requests[1]?.messages.find(message => message.role === "assistant");
		expect(replay?.content).toEqual([
			{ type: "thinking", thinking: "reasoning", signature: "original-signature" },
			{ type: "redacted_thinking", data: "opaque+/=\u0000payload" },
			{ type: "text", text: "answer" },
			{ type: "redacted_thinking", data: "trailing-opaque" },
		]);
	});
});
