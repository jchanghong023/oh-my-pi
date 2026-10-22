import { describe, expect, it } from "bun:test";
import {
	streamAnthropic,
	streamOpenAICompletions,
	streamOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/register-builtins";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const apis = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
type BoundaryApi = (typeof apis)[number];

function startStream(api: BoundaryApi, baseUrl: string, signal?: AbortSignal) {
	const spec = {
		id: "local-provider-code-test",
		name: "Local provider code test",
		provider: "local-provider-code-test",
		baseUrl,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 128,
	};
	const options = { apiKey: "local-test-key", signal };
	switch (api) {
		case "openai-completions":
			return streamOpenAICompletions(buildModel({ ...spec, api }), context, options);
		case "openai-responses":
			return streamOpenAIResponses(buildModel({ ...spec, api }), context, options);
		case "anthropic-messages":
			return streamAnthropic(buildModel({ ...spec, api }), context, options);
	}
}

async function terminal(api: BoundaryApi, baseUrl: string, signal?: AbortSignal) {
	const stream = startStream(api, baseUrl, signal);
	let terminalMessage: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "error") terminalMessage = event.error;
		if (event.type === "done") terminalMessage = event.message;
	}
	const result = await stream.result();
	expect(terminalMessage).toBeDefined();
	expect(terminalMessage?.providerErrorCode).toBe(result.providerErrorCode);
	return result;
}

function successBody(api: BoundaryApi): string {
	const frames =
		api === "anthropic-messages"
			? [
					{
						type: "message_start",
						message: {
							id: "msg_local",
							type: "message",
							role: "assistant",
							model: "local",
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { output_tokens: 1 },
					},
					{ type: "message_stop" },
				]
			: api === "openai-responses"
				? [
						{ type: "response.created", response: { id: "resp_local", status: "in_progress" } },
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { type: "message", id: "msg_local", role: "assistant", content: [] },
						},
						{
							type: "response.output_text.delta",
							item_id: "msg_local",
							output_index: 0,
							content_index: 0,
							delta: "ok",
						},
						{
							type: "response.completed",
							response: {
								id: "resp_local",
								status: "completed",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						},
					]
				: [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }];
	return (
		frames
			.map(frame => `${"type" in frame ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`)
			.join("") + (api === "openai-completions" ? "data: [DONE]\n\n" : "")
	);
}

describe("provider error codes at the local HTTP boundary", () => {
	for (const api of apis) {
		for (const code of ["Quota.Exact_CASE", 7103]) {
			it(`${api} forwards the actual structured code ${code} without replacing HTTP status`, async () => {
				let requests = 0;
				const server = Bun.serve({
					hostname: "127.0.0.1",
					port: 0,
					fetch() {
						requests++;
						return Response.json(
							{
								type: "error",
								error: { code, type: "invalid_request_error", message: "Provider rejected request" },
							},
							{ status: 400, headers: { "x-should-retry": "false" } },
						);
					},
				});
				try {
					const message = await terminal(api, server.url.origin);
					expect(message.stopReason).toBe("error");
					expect(message.errorStatus).toBe(400);
					expect(message.providerErrorCode).toBe(String(code));
					expect(requests).toBe(1);
				} finally {
					await server.stop(true);
				}
			});
		}

		it(`${api} never promotes a status or message token to provider code`, async () => {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => Response.json({ error: { message: "Quota.Exact_CASE HTTP 400 ECONNRESET" } }, { status: 400 }),
			});
			try {
				const message = await terminal(api, server.url.origin);
				expect(message.errorStatus).toBe(400);
				expect(message.providerErrorCode).toBeUndefined();
			} finally {
				await server.stop(true);
			}
		});

		it(`${api} keeps success separate from provider errors`, async () => {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response(successBody(api), { headers: { "content-type": "text/event-stream" } }),
			});
			try {
				const message = await terminal(api, server.url.origin);
				expect(message.stopReason).toBe("stop");
				expect(message.providerErrorCode).toBeUndefined();
				expect(message.errorStatus).toBeUndefined();
			} finally {
				await server.stop(true);
			}
		});

		it(`${api} does not expose the caller abort reason as a provider code`, async () => {
			const controller = new AbortController();
			const arrived = Promise.withResolvers<void>();
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					arrived.resolve();
					return new Response(
						new ReadableStream({
							start(stream) {
								stream.enqueue(new TextEncoder().encode(": waiting\n\n"));
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			try {
				const pending = terminal(api, server.url.origin, controller.signal);
				await arrived.promise;
				controller.abort(Object.assign(new Error("Quota.Exact_CASE"), { code: "Quota.Exact_CASE" }));
				const message = await pending;
				expect(message.stopReason).toBe("aborted");
				expect(message.providerErrorCode).toBeUndefined();
			} finally {
				await server.stop(true);
			}
		});
	}
});

describe("structured stream errors and recovered requests", () => {
	for (const api of apis) {
		it(`${api} preserves the original code in an HTTP 200 error frame`, async () => {
			const error = { code: "Exact.Stream_CODE", type: "invalid_request_error", message: "Rejected stream" };
			const frame = { type: "error", error };
			const body = `event: error\ndata: ${JSON.stringify(frame)}\n\n`;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
			});
			try {
				const message = await terminal(api, server.url.origin);
				expect(message.stopReason).toBe("error");
				expect(message.errorStatus).toBeUndefined();
				expect(message.providerErrorCode).toBe("Exact.Stream_CODE");
			} finally {
				await server.stop(true);
			}
		});
	}

	it("Anthropic successful HTTP retry does not retain the earlier provider code", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				if (requests === 1) {
					return Response.json(
						{ error: { code: "Temporary.Exact_CODE", type: "overloaded_error", message: "Try again" } },
						{ status: 503, headers: { "retry-after-ms": "0" } },
					);
				}
				return new Response(successBody("anthropic-messages"), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
			const message = await terminal("anthropic-messages", server.url.origin);
			expect(requests).toBe(2);
			expect(message.stopReason).toBe("stop");
			expect(message.providerErrorCode).toBeUndefined();
			expect(message.errorStatus).toBeUndefined();
		} finally {
			await server.stop(true);
		}
	});
});

it("in-band retry classification preserves exact wire code without promoting the event type", async () => {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			const frame =
				requests === 1
					? { type: "error", error: { code: "Throttling.AllocationQuota", message: "Busy" } }
					: { type: "error", status: 429, message: "Busy" };
			return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	try {
		const coded = await terminal("openai-completions", server.url.origin);
		expect(coded.errorStatus).toBe(429);
		expect(coded.providerErrorCode).toBe("Throttling.AllocationQuota");
		const uncoded = await terminal("openai-completions", server.url.origin);
		expect(uncoded.errorStatus).toBe(429);
		expect(uncoded.providerErrorCode).toBeUndefined();
	} finally {
		await server.stop(true);
	}
});
