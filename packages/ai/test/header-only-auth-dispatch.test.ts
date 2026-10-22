import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { MissingApiKeyError } from "../src/error";
import { streamSimple } from "../src/stream";
import type { Context, SimpleStreamOptions } from "../src/types";

const context: Context = { messages: [{ role: "user", content: "Reply locally", timestamp: 0 }] };
const provider = "header-only-auth-dispatch-local-fixture";
type LocalApi = "openai-completions" | "anthropic-messages";

function localModel(api: LocalApi, baseUrl: string) {
	return buildModel({
		id: `header-only-${api}`,
		name: "Header-only localhost fixture",
		api,
		// An unregistered provider cannot resolve any user's environment credential.
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 128,
	});
}

function completionBody(api: LocalApi, modelId: string, text: string): string {
	if (api === "openai-completions") {
		const chunk = (delta: Record<string, string>, finishReason: string | null) =>
			`data: ${JSON.stringify({
				id: "chatcmpl-header-only",
				object: "chat.completion.chunk",
				created: 0,
				model: modelId,
				choices: [{ index: 0, delta, finish_reason: finishReason }],
			})}\n\n`;
		return chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
	}
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_header_only",
				type: "message",
				role: "assistant",
				model: modelId,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe("generic header-only authentication dispatch", () => {
	// Both native consumers are intentional: OpenAI has its own API-key fallback,
	// while Anthropic builds API-key and bearer headers through a separate client.
	for (const api of ["openai-completions", "anthropic-messages"] as const) {
		it(`${api} completes over HTTP with only explicit request authentication headers`, async () => {
			const expectedText = `localhost completed ${api}`;
			const authorization = api === "openai-completions" ? "Bearer local-header-only-token" : null;
			const apiKey = api === "anthropic-messages" ? "local-header-only-api-key" : null;
			const requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const body = (await request.json()) as Record<string, unknown>;
					requests.push({ path: new URL(request.url).pathname, headers: request.headers, body });
					if (
						request.headers.get("authorization") !== authorization ||
						request.headers.get("x-api-key") !== apiKey ||
						request.headers.has("api-key")
					) {
						return Response.json({ error: { message: "Unexpected authentication material" } }, { status: 401 });
					}
					return new Response(completionBody(api, `header-only-${api}`, expectedText), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			});
			try {
				const model = localModel(api, `${server.url.origin}/v1`);
				const options: SimpleStreamOptions = {
					requestAuth: {
						headers: authorization
							? { aUtHoRiZaTiOn: authorization }
							: { "X-aPi-KeY": "local-header-only-api-key" },
					},
					signal: AbortSignal.timeout(5000),
				};
				expect(options.apiKey).toBeUndefined();
				const stream = streamSimple(model, context, options);
				const terminalEvents: string[] = [];
				for await (const event of stream) {
					if (event.type === "done" || event.type === "error") terminalEvents.push(event.type);
				}
				const result = await stream.result();
				expect(requests).toHaveLength(1);
				expect(requests[0]?.path).toBe(api === "openai-completions" ? "/v1/chat/completions" : "/v1/messages");
				expect(requests[0]?.headers.get("authorization")).toBe(authorization);
				expect(requests[0]?.headers.get("x-api-key")).toBe(apiKey);
				expect(requests[0]?.body.model).toBe(model.id);
				expect(requests[0]?.body.stream).toBe(true);
				expect(terminalEvents).toEqual(["done"]);
				expect(result.stopReason).toBe("stop");
				expect(result.errorMessage).toBeUndefined();
				expect(
					result.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join(""),
				).toBe(expectedText);
			} finally {
				await server.stop(true);
			}
		});
	}

	it("uses nonstandard source headers without leaking an ambient API key", async () => {
		const requests: Headers[] = [];
		const expectedText = "custom host authentication completed locally";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push(request.headers);
				await request.text();
				if (
					request.headers.get("x-host-credential") !== "local-host-secret" ||
					request.headers.has("authorization") ||
					request.headers.has("x-api-key") ||
					request.headers.has("api-key")
				) {
					return Response.json({ error: { message: "Unexpected authentication material" } }, { status: 401 });
				}
				return new Response(completionBody("openai-completions", "header-only-openai-completions", expectedText), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
			const result = await streamSimple(localModel("openai-completions", `${server.url.origin}/v1`), context, {
				requestAuth: { headers: { "X-Host-Credential": "local-host-secret" } },
				apiKey: async () => "fixture-only-ambient-key",
				signal: AbortSignal.timeout(5000),
			}).result();
			expect(requests).toHaveLength(1);
			expect(requests[0]?.get("x-host-credential")).toBe("local-host-secret");
			expect(requests[0]?.has("authorization")).toBe(false);
			expect(requests[0]?.has("x-api-key")).toBe(false);
			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
			expect(
				result.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join(""),
			).toBe(expectedText);
		} finally {
			await server.stop(true);
		}
	});

	it("rejects empty actual authentication despite ambient identity and headers before HTTP", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return Response.json({ error: { message: "Authentication gate was bypassed" } }, { status: 400 });
			},
		});
		try {
			const model = {
				...localModel("openai-completions", `${server.url.origin}/v1`),
				headers: { Authorization: "Bearer ambient-model-token" },
			};
			const options: SimpleStreamOptions = {
				requestAuth: { apiKey: " \t ", headers: { Authorization: "", "x-host-credential": " \t " } },
				apiKey: async () => "fixture-only-ambient-key",
				headers: { "User-Agent": "header-only-fixture", "x-account-id": "local-account", "x-auth-source": "host" },
				credentialId: 17,
				oauthIdentity: { orgId: "local-organization" },
				signal: AbortSignal.timeout(5000),
			};
			await expect((async () => streamSimple(model, context, options).result())()).rejects.toBeInstanceOf(
				MissingApiKeyError,
			);
			expect(requests).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
});
