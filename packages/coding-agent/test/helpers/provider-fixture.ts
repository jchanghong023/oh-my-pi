import { isRecord } from "@oh-my-pi/pi-utils";

export const MARKER = "OMP_TEST_PROVIDER";

export interface ModelRequest {
	model: string;
	messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
	tools?: Array<{ type?: string; function?: { name: string; parameters?: unknown } }>;
}
export interface Reply {
	text?: string;
	tool?: { name: string; args: Record<string, unknown> };
	tools?: Array<{ name: string; args: Record<string, unknown> }>;
}
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const text: string[] = [];
		for (const part of content) if (isRecord(part) && typeof part.text === "string") text.push(part.text);
		return text.join("\n");
	}
	return "";
}
export interface ProviderFixture {
	/** All chat-completion inference, including background skill-description work; never discounted as probes. */
	requests: ModelRequest[];
	failures: string[];
	failure: Promise<never>;
	baseUrl: string;
	[Symbol.asyncDispose](): Promise<void>;
}
/** Local OpenAI SSE transport. Native tools, not this server, perform all workspace IO. */
export function createProviderFixture(options: {
	reply: (request: ModelRequest) => Reply | Response | Promise<Reply | Response>;
}): ProviderFixture {
	const requests: ModelRequest[] = [];
	const failures: string[] = [];
	const failed = Promise.withResolvers<never>();
	void failed.promise.catch(() => {});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
				failures.push(`Unexpected provider request: ${request.method} ${url.pathname}`);
				failed.reject(new Error(failures.at(-1)!));
				return new Response("Unexpected model/catalog access", { status: 500 });
			}
			try {
				const body = (await request.json()) as ModelRequest;
				requests.push(body);
				const reply = await options.reply(body);
				// Selected journeys may supply a real, gated SSE response.
				if (reply instanceof Response) return reply;
				const tools = reply.tools ?? (reply.tool ? [reply.tool] : []);
				const delta = {
					...(reply.text === undefined ? {} : { content: reply.text }),
					...(tools.length
						? {
								tool_calls: tools.map((tool, index) => ({
									index,
									id: `fixture-${requests.length}-${index}`,
									type: "function",
									function: { name: tool.name, arguments: JSON.stringify(tool.args) },
								})),
							}
						: {}),
				};
				const chunks = [
					{ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
					{
						choices: [{ index: 0, delta: {}, finish_reason: tools.length ? "tool_calls" : "stop" }],
						usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
					},
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify({ id: `spec-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, ...chunk })}\n\n`).join("")}data: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			} catch (error) {
				// Native Stop aborts the actual HTTP request. Cancellation is not a
				// provider malfunction and must not obscure subsequent failure evidence.
				if (request.signal.aborted) return new Response(null, { status: 499 });
				failures.push(String(error));
				failed.reject(error);
				return Response.json({ error: { message: String(error), type: "fixture_error" } }, { status: 400 });
			}
		},
	});
	return {
		requests,
		failures,
		failure: failed.promise,
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		[Symbol.asyncDispose]: async () => {
			server.stop(true);
		},
	};
}
