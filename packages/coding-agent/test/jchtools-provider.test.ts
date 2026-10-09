import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { JCHTOOLS_API, projectJchToolsContext, streamJchToolsAgent } from "../src/config/jchtools-provider";

const encoder = new TextEncoder();

function model(baseUrl: string): Model<Api> {
	return buildModel({
		id: "backend/actual-agent",
		name: "JchTools 后端 Agent 执行",
		api: JCHTOOLS_API,
		provider: "jchtools",
		baseUrl,
		reasoning: false,
		supportsTools: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	});
}

function assistant(api: Api, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api,
		provider: api === JCHTOOLS_API ? "jchtools" : "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function frame(content: string | null, finish: string | null = null): string {
	return `data: ${JSON.stringify({ choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }] })}\n\n`;
}

const user: Message = { role: "user", content: "inspect the project", timestamp: 1 };

async function consume(
	baseUrl: string,
	context: Context = { messages: [user] },
): Promise<{ result: AssistantMessage; events: AssistantMessageEvent[] }> {
	const stream = streamJchToolsAgent(model(baseUrl), context);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { result: await stream.result(), events };
}

describe("JchTools remote Agent transport", () => {
	test("sends only supported text wire and exposes split UTF-8 increments before completion", async () => {
		const request = Promise.withResolvers<{
			body: unknown;
			url: string;
			method: string;
			authorization: string | null;
			credentialHeader: string | null;
		}>();
		const release = Promise.withResolvers<void>();
		let completed = false;
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				requests++;
				request.resolve({
					body: await req.json(),
					url: new URL(req.url).pathname,
					method: req.method,
					authorization: req.headers.get("authorization"),
					credentialHeader: req.headers.get("x-api-key"),
				});
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							const bytes = encoder.encode(frame("你好"));
							const chinese = bytes.indexOf(0xe4);
							controller.enqueue(bytes.slice(0, chinese + 1));
							await Promise.resolve();
							controller.enqueue(bytes.slice(chinese + 1));
							await release.promise;
							controller.enqueue(encoder.encode(frame(" world") + frame(null, "stop") + "data: [DONE]\n\n"));
							completed = true;
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		try {
			const chosen = {
				...model(server.url.origin),
				headers: { Authorization: "model-secret", "x-api-key": "model-secret" },
			};
			const context = projectJchToolsContext(
				{ systemPrompt: ["frontend local-tool boilerplate"], messages: [user] },
				path.resolve("fixture-project"),
			);
			const stream = streamJchToolsAgent(chosen, context, {
				apiKey: "option-secret",
				temperature: 0.7,
				maxTokens: 10,
				reasoning: Effort.High,
				onPayload: () => ({ tools: [{ name: "must-not-leak" }] }),
			});
			const events: string[] = [];
			for await (const event of stream) {
				events.push(event.type);
				if (event.type === "text_delta" && event.delta === "你好") {
					expect(completed).toBe(false);
					release.resolve();
				}
			}
			const observed = await request.promise;
			expect(observed).toEqual({
				url: "/v1/chat/completions",
				method: "POST",
				authorization: null,
				credentialHeader: null,
				body: {
					model: "backend/actual-agent",
					messages: [
						{ role: "system", content: context.systemPrompt?.[0] },
						{ role: "user", content: "inspect the project" },
					],
					stream: true,
				},
			});
			expect(events).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
			expect((await stream.result()).content).toEqual([{ type: "text", text: "你好 world" }]);
			expect((await stream.result()).stopReason).toBe("stop");
			expect(requests).toBe(1);
		} finally {
			release.resolve();
			await server.stop(true);
		}
	});

	for (const fault of [
		{ name: "malformed JSON", tail: "data: not-json\n\n", detail: "malformed SSE JSON" },
		{ name: "truncated JSON frame", tail: 'data: {"choices":', detail: "malformed SSE JSON" },
		{ name: "EOF without terminal completion", tail: "", detail: "stream ended" },
		{ name: "EOF after finish but before DONE", tail: frame(null, "stop"), detail: "stream ended" },
		{ name: "DONE without finish", tail: "data: [DONE]\n\n", detail: "without a normal finish_reason" },
		{
			name: "backend error object",
			tail: 'data: {"error":{"message":"backend unavailable"}}\n\n',
			detail: "backend unavailable",
		},
		{ name: "named error event", tail: "event: error\ndata: backend failed\n\n", detail: "backend failed" },
		{
			name: "unexpected tool calls",
			tail: 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call"}]},"finish_reason":null}]}\n\n',
			detail: "unexpected frontend tool",
		},
		{
			name: "unsupported reasoning delta",
			tail: 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"secret"},"finish_reason":null}]}\n\n',
			detail: "unsupported nontext",
		},
		{
			name: "nontext content delta",
			tail: 'data: {"choices":[{"index":0,"delta":{"content":[]},"finish_reason":null}]}\n\n',
			detail: "must be text",
		},
		{ name: "tool finish reason", tail: frame(null, "tool_calls"), detail: "unexpected finish_reason" },
	]) {
		test(`${fault.name} fails truthfully while retaining received text`, async () => {
			let requests = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					requests++;
					return new Response(frame("partial result") + fault.tail, {
						headers: { "Content-Type": "text/event-stream" },
					});
				},
			});
			try {
				const { result, events } = await consume(server.url.origin);
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain(fault.detail);
				expect(result.content).toEqual([{ type: "text", text: "partial result" }]);
				expect(events.at(-1)?.type).toBe("error");
				expect(events.some(event => event.type === "done" || event.type.startsWith("toolcall"))).toBe(false);
				expect(requests).toBe(1);
			} finally {
				await server.stop(true);
			}
		});
	}

	test("HTTP backend errors preserve status and do not retry", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return Response.json({ error: { message: "Agent is retiring" } }, { status: 503 });
			},
		});
		try {
			const { result } = await consume(server.url.origin);
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(503);
			expect(result.errorMessage).toContain("Agent is retiring");
			expect(result.content).toEqual([]);
			expect(requests).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("abort disconnects the server and keeps partial text without reporting done", async () => {
		const disconnected = Promise.withResolvers<void>();
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(frame("still working")));
						},
						cancel() {
							disconnected.resolve();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		try {
			const abort = new AbortController();
			const stream = streamJchToolsAgent(model(server.url.origin), { messages: [user] }, { signal: abort.signal });
			const events: string[] = [];
			for await (const event of stream) {
				events.push(event.type);
				if (event.type === "text_delta") abort.abort(new Error("user cancelled task"));
			}
			await disconnected.promise;
			const result = await stream.result();
			expect(result.stopReason).toBe("aborted");
			expect(result.content).toEqual([{ type: "text", text: "still working" }]);
			expect(events.at(-1)).toBe("error");
			expect(events).not.toContain("done");
			expect(requests).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("length finish is reported only after DONE", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(frame("limited") + frame(null, "length") + "data: [DONE]\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		try {
			const { result, events } = await consume(server.url.origin);
			expect(result.stopReason).toBe("length");
			expect(events.at(-1)?.type).toBe("done");
		} finally {
			await server.stop(true);
		}
	});

	test("unsupported media, residual tools, and ordinary assistant history never reach HTTP", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return new Response("unexpected");
			},
		});
		try {
			const contexts: Context[] = [
				{
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "don't drop the attached image" },
								{ type: "image", data: "AA==", mimeType: "image/png" },
							],
							timestamp: 1,
						},
					],
				},
				{
					messages: [user],
					tools: [{ name: "read", description: "local read", parameters: { type: "object", properties: {} } }],
				},
				{ messages: [user, assistant("openai-completions", "ordinary answer")] },
				{
					messages: [
						user,
						{
							role: "toolResult",
							toolCallId: "old",
							toolName: "read",
							content: [{ type: "text", text: "tool output" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ messages: [user, { role: "developer", content: "unsupported instruction role", timestamp: 2 }] },
			];
			for (const context of contexts) {
				const { result } = await consume(server.url.origin, context);
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("input rejected");
			}
			const stream = streamJchToolsAgent(model(server.url.origin), { messages: [user] }, { toolChoice: "none" });
			expect((await stream.result()).stopReason).toBe("error");
			expect(requests).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
});

describe("JchTools context isolation", () => {
	test("cuts dependent ordinary tool history and preserves the canonical transcript across model switches", () => {
		const ordinary = assistant("openai-completions", "ordinary local decision");
		ordinary.content.push({ type: "toolCall", id: "read1", name: "read", arguments: { path: "secret.txt" } });
		const context: Context = {
			systemPrompt: ["frontend tool execution rules"],
			messages: [
				user,
				assistant(JCHTOOLS_API, "old remote epoch"),
				ordinary,
				{
					role: "toolResult",
					toolCallId: "read1",
					toolName: "read",
					content: [{ type: "text", text: "ordinary tool result" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "remote task", timestamp: 3 },
				assistant(JCHTOOLS_API, "remote result"),
				{
					role: "user",
					content: [
						{ type: "text", text: "follow " },
						{ type: "text", text: "up" },
					],
					timestamp: 4,
				},
			],
			tools: [{ name: "read", description: "local read", parameters: { type: "object", properties: {} } }],
		};
		const before = structuredClone(context);
		const cwd = path.resolve("project with spaces");
		const projected = projectJchToolsContext(context, cwd);
		expect(projected.messages.map(message => message.content)).toEqual([
			"remote task",
			[{ type: "text", text: "remote result" }],
			"follow up",
		]);
		expect(projected.systemPrompt?.[0]).toContain(cwd);
		expect(projected.systemPrompt?.[0]).not.toContain("frontend tool execution rules");
		expect(projected.tools).toBeUndefined();
		expect(context).toEqual(before);
		const switched: Context = {
			...context,
			messages: [
				...context.messages,
				assistant("openai-completions", "back to ordinary"),
				{ role: "user", content: "new remote epoch", timestamp: 5 },
			],
		};
		expect(projectJchToolsContext(switched, cwd).messages.map(message => message.content)).toEqual([
			"new remote epoch",
		]);
		expect(context).toEqual(before);
	});

	test("rejects current media instead of silently stripping or discarding the user turn", () => {
		const media: Message = {
			role: "user",
			content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
			timestamp: 1,
		};
		const context: Context = { messages: [media, assistant("openai-completions", "last ordinary response")] };
		const before = structuredClone(context);
		expect(() => projectJchToolsContext(context, path.resolve("project"))).toThrow("image content is unsupported");
		expect(context).toEqual(before);
	});
});
