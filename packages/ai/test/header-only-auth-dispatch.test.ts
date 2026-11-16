import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { MissingApiKeyError } from "../src/error";
import { streamAnthropic } from "../src/providers/anthropic";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import { streamSimple } from "../src/stream";
import type { Context, SimpleStreamOptions, StreamOptions } from "../src/types";

const context: Context = { messages: [{ role: "user", content: "Reply locally", timestamp: 0 }] };
const provider = "header-only-auth-dispatch-local-fixture";
type LocalApi = "openai-completions" | "openai-responses" | "anthropic-messages";

function localModel<TApi extends LocalApi>(api: TApi, baseUrl: string) {
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
	if (api === "openai-responses") {
		const events = [
			{ type: "response.created", response: { id: "resp_header_only" } },
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_header_only", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: text },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_header_only",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_header_only",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		];
		return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
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
	// OpenAI transports have their own API-key fallback, while Anthropic builds
	// API-key and bearer headers through a separate client.
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		it(`${api} completes over HTTP with only explicit request authentication headers`, async () => {
			const expectedText = `localhost completed ${api}`;
			const authorization = api !== "anthropic-messages" ? "Bearer local-header-only-token" : null;
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
				expect(requests[0]?.path).toBe(
					api === "openai-completions"
						? "/v1/chat/completions"
						: api === "openai-responses"
							? "/v1/responses"
							: "/v1/messages",
				);
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

function directStream(api: LocalApi, baseUrl: string, options: StreamOptions, headers: Record<string, string>) {
	switch (api) {
		case "openai-completions":
			return streamOpenAICompletions({ ...localModel(api, baseUrl), headers }, context, options);
		case "openai-responses":
			return streamOpenAIResponses({ ...localModel(api, baseUrl), headers }, context, {
				...options,
				preferWebsockets: false,
			});
		case "anthropic-messages":
			return streamAnthropic({ ...localModel(api, baseUrl), headers }, context, options);
	}
}

describe("direct provider request authentication", () => {
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		for (const mode of ["headers", "api-key", "custom-headers"] as const) {
			it(`${api} sends explicit ${mode} authentication without ambient credentials`, async () => {
				const expectedText = `direct ${api} ${mode}`;
				const authorization =
					mode === "api-key"
						? "Bearer local-explicit-api-key"
						: mode === "headers" && api !== "anthropic-messages"
							? "Bearer local-header-token"
							: null;
				const apiKey = mode === "headers" && api === "anthropic-messages" ? "local-header-api-key" : null;
				const hostCredential = mode === "api-key" ? null : "local-host-secret";
				const requests: Array<{ path: string; headers: Headers }> = [];
				const server = Bun.serve({
					hostname: "127.0.0.1",
					port: 0,
					async fetch(request) {
						await request.text();
						requests.push({ path: new URL(request.url).pathname, headers: request.headers });
						if (
							request.headers.get("authorization") !== authorization ||
							request.headers.get("x-api-key") !== apiKey ||
							request.headers.get("x-host-credential") !== hostCredential ||
							request.headers.has("api-key")
						) {
							return Response.json(
								{ error: { message: "Unexpected authentication material" } },
								{ status: 401 },
							);
						}
						return new Response(completionBody(api, `header-only-${api}`, expectedText), {
							headers: { "content-type": "text/event-stream" },
						});
					},
				});
				try {
					const authHeader = api === "anthropic-messages" ? "x-api-key" : "authorization";
					const modelHeaders: Record<string, string> =
						mode === "headers" ? { [authHeader]: "model-auth-conflict" } : {};
					const headers: Record<string, string> =
						mode === "headers" ? { [authHeader.toUpperCase()]: "options-auth-conflict" } : {};
					if (hostCredential) {
						modelHeaders["x-host-credential"] = "model-host-conflict";
						headers["X-HOST-CREDENTIAL"] = "options-host-conflict";
					}
					const requestAuth: StreamOptions["requestAuth"] =
						mode === "api-key"
							? { apiKey: "local-explicit-api-key" }
							: {
									headers: {
										"X-Host-Credential": hostCredential!,
										...(mode === "headers"
											? apiKey
												? { "X-aPi-KeY": apiKey }
												: { aUtHoRiZaTiOn: authorization! }
											: {}),
									},
								};
					const result = await directStream(
						api,
						`${server.url.origin}/v1`,
						{
							apiKey: "fixture-only-ambient-key",
							headers,
							requestAuth,
							signal: AbortSignal.timeout(5000),
						},
						modelHeaders,
					).result();
					expect(requests).toHaveLength(1);
					expect(requests[0]?.path).toBe(
						api === "openai-completions"
							? "/v1/chat/completions"
							: api === "openai-responses"
								? "/v1/responses"
								: "/v1/messages",
					);
					expect(requests[0]?.headers.get("authorization")).toBe(authorization);
					expect(requests[0]?.headers.get("x-api-key")).toBe(apiKey);
					expect(requests[0]?.headers.get("x-host-credential")).toBe(hostCredential);
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
	}
});
