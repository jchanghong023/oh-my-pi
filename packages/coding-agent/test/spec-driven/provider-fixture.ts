import { isRecord } from "@oh-my-pi/pi-utils";

export const MARKER = "OMP_SPEC_PUBLIC_GREETING";
export const IMPLEMENTATION_PATH = "src/greeting.ts";
export const IMPLEMENTATION =
	'export function greet(name: string): string {\n  return `Hello, ${name.trim() || "world"}!`;\n}\n';

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
function tool(request: ModelRequest, name: string, args: Record<string, unknown>): Reply {
	const advertised = request.tools?.find(
		item => item.function?.name === name || item.function?.name === `_${name}`,
	)?.function;
	if (!advertised) throw new Error(`Provider fixture requires advertised native ${name}`);
	return { tool: { name: advertised.name, args } };
}
function calls(request: ModelRequest): Array<{ name: string; args: Record<string, unknown> }> {
	return request.messages
		.flatMap(message => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
		.flatMap(call => {
			if (
				!isRecord(call) ||
				!isRecord(call.function) ||
				typeof call.function.name !== "string" ||
				typeof call.function.arguments !== "string"
			)
				return [];
			const args: unknown = JSON.parse(call.function.arguments);
			return isRecord(args) ? [{ name: call.function.name.replace(/^_/u, ""), args }] : [];
		});
}
export function teamStage(request: ModelRequest): string | undefined {
	for (const message of request.messages.filter(item => item.role === "user").toReversed()) {
		const match = /^\[team-stage:([a-z]+)[^\]]*\]/mu.exec(contentText(message.content));
		if (match) return match[1];
	}
	return undefined;
}

export function respond(request: ModelRequest): Reply {
	const ordinary = request.messages
		.filter(message => message.role === "user")
		.map(message => contentText(message.content))
		.join("\n");
	const manual = ordinary.match(/OMP_SPEC_MANUAL_RESOURCE (\{[^\n]+\})/u);
	if (manual && request.tools?.length) {
		const selected: unknown = JSON.parse(manual[1]!);
		if (!isRecord(selected) || typeof selected.path !== "string" || !Array.isArray(selected.deniedPaths))
			throw new Error("Invalid selected resource");
		const targets = [
			selected.path,
			...(Array.isArray(selected.allowedPaths) ? selected.allowedPaths : []),
			selected.deniedPaths.join(";"),
		];
		for (const target of targets)
			if (!calls(request).some(call => call.name === "read" && call.args.path === target))
				return tool(request, "read", { i: "Inspecting packaged resource access", path: target });
		return {
			text: typeof selected.turn === "string" ? `${MARKER}_RESOURCE_READY_${selected.turn}` : `${MARKER}_CHAT_READY`,
		};
	}
	if (ordinary.includes("OMP_SPEC_REVIEW_CHILD") && request.tools?.length) {
		if (!calls(request).some(call => call.name === "read"))
			return tool(request, "read", { i: "Reviewing implementation", path: IMPLEMENTATION_PATH });
		if (request.tools?.some(item => item.function?.name.replace(/^_/u, "") === "yield"))
			return tool(request, "yield", {
				type: "result",
				data: { overall_correctness: "correct", explanation: "Reviewed the implementation.", confidence: 1 },
			});
		return { text: "Reviewed the implementation." };
	}
	if (ordinary.includes("OMP_SPEC_ORDINARY_CHILD")) return { text: "OMP_SPEC_ORDINARY_CHILD_DONE" };
	if (ordinary.includes("OMP_SPEC_ORDINARY_CONTROL") && request.tools?.length) {
		const executed = calls(request);
		if (!executed.some(call => call.name === "write"))
			return tool(request, "write", {
				i: "Writing ordinary session control",
				path: "ordinary-note.txt",
				content: "ordinary session remains writable\n",
			});
		if (!executed.some(call => call.name === "read"))
			return tool(request, "read", { i: "Reading ordinary session control", path: "ordinary-note.txt" });
		if (!executed.some(call => call.name === "task"))
			return tool(request, "task", {
				context: "ordinary native control",
				tasks: [
					{
						name: "OrdinaryControl",
						task: "OMP_SPEC_ORDINARY_CHILD",
						solutionSpace: "ordinary native response only",
					},
				],
			});
		return { text: "OMP_SPEC_ORDINARY_CONTROL_DONE" };
	}
	return { text: `${MARKER}_CHAT_READY` };
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
export function createProviderFixture(
	options: {
		reply?: (request: ModelRequest) => Reply | Response | Promise<Reply | Response>;
	} = {},
): ProviderFixture {
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
				const reply = options.reply ? await options.reply(body) : respond(body);
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
