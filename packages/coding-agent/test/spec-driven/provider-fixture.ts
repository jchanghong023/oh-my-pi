import { isRecord } from "@oh-my-pi/pi-utils";

export const MARKER = "OMP_SPEC_PUBLIC_GREETING";
export const IMPLEMENTATION_PATH = "src/greeting.ts";
export const TEST_PATH = "test/greeting.test.ts";
export const VALIDATION_COMMAND = "bun test test/greeting.test.ts";
export const REQUIREMENT =
	"greet(name) trims outer whitespace, defaults empty names to world, preserves internal whitespace and returns Hello, <name>!.";
export const IMPLEMENTATION =
	'export function greet(name: string): string {\n  return `Hello, ${name.trim() || "world"}!`;\n}\n';
export const BEHAVIOR_TEST = `import { expect, test } from "bun:test";
import { greet } from "../src/greeting";
test("greeting behavior", () => {
  expect(greet("  Ada  ")).toBe("Hello, Ada!");
  expect(greet("   ")).toBe("Hello, world!");
  expect(greet("Ada  Lovelace")).toBe("Hello, Ada  Lovelace!");
});
`;
const TEAM_PROPOSAL = `# Pure greeting function\n\n${REQUIREMENT}\n\nExport one stateless function with no networking, global state or framework. Verify outer trimming, empty input and preserved internal whitespace.`;
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
export type FixtureRole = "requirements" | "solution" | "planner" | "executor";
export interface ProviderScenario {
	/** Hold selected native requests without replacing HTTP/SSE or tool execution. */
	delay?: (request: ModelRequest, signal: AbortSignal) => Promise<void>;
	/** Terminal provider rejection seam; callers can release it for same-session reentry. */
	fail?: (request: ModelRequest) => string | undefined;
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
/** Extract the actual native stage data, never infer roles from prose or tool schemas. */
export function rolePayload(
	request: ModelRequest,
): { specDrivenRole: string; input: Record<string, unknown> } | undefined {
	for (const message of request.messages.filter(item => !["assistant", "tool"].includes(item.role)).toReversed()) {
		const source = contentText(message.content);
		for (let begin = source.indexOf("{"); begin >= 0; begin = source.indexOf("{", begin + 1)) {
			let depth = 0;
			let quoted = false;
			let escaped = false;
			for (let end = begin; end < source.length; end++) {
				const char = source[end];
				if (quoted) {
					if (escaped) escaped = false;
					else if (char === "\\") escaped = true;
					else if (char === '"') quoted = false;
				} else if (char === '"') quoted = true;
				else if (char === "{") depth++;
				else if (char === "}" && --depth === 0) {
					try {
						const value: unknown = JSON.parse(source.slice(begin, end + 1));
						if (
							isRecord(value) &&
							isRecord(value.binding) &&
							typeof value.role === "string" &&
							Array.isArray(value.outputPaths) &&
							typeof value.outputContract === "string"
						)
							return { specDrivenRole: value.role, input: value };
					} catch {
						/* Other JSON fragments are not the native workflow context. */
					}
					break;
				}
			}
		}
	}
	return undefined;
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

function teamReply(request: ModelRequest, stage: string): Reply {
	if (!request.tools?.some(item => item.function?.name.replace(/^_/u, "") === "yield"))
		return { text: "结构化讨论结果已提交。" };
	let data: Record<string, unknown>;
	switch (stage) {
		case "proposal":
			data = {
				proposal: TEAM_PROPOSAL,
				noViableProposal: false,
				investigationBlockedReason: "",
				keyAssumptions: [],
				risks: ["Only string inputs are in scope."],
				unknowns: [],
				acceptanceCriteria: [REQUIREMENT],
				ambiguityInterpretations: [],
				evidence: [],
			};
			break;
		case "alignment":
			data = {
				unifiedUnderstanding: REQUIREMENT,
				acceptanceCriteria: [REQUIREMENT],
				factDifferences: [],
				interpretationDifferences: [],
			};
			break;
		case "review":
			data = {
				noSubstantiveIssues: true,
				reviewSummary: "The stateless function satisfies the confirmed behavior.",
				findings: [],
				blockingResolutions: [],
			};
			break;
		case "synthesis":
			data = {
				reportMarkdown: "## 方案比较\n全部候选均使用纯函数，无额外依赖。",
				recommendedProposal: "A",
				recommendationReason: "保持最小范围。",
				recommendationPreconditions: "",
				hardConstraintViolations: [],
			};
			break;
		default:
			throw new Error(`Unexpected Team fixture stage ${stage}`);
	}
	return tool(request, "yield", { data });
}

export function respond(request: ModelRequest): Reply {
	const payload = rolePayload(request);
	const stage = teamStage(request);
	if (stage) return teamReply(request, stage);
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
	if (!payload && ordinary.includes("OMP_SPEC_IMPLEMENT_CHILD") && request.tools?.length) {
		const executed = calls(request);
		if (!executed.some(call => call.name === "write" && call.args.path === TEST_PATH))
			return tool(request, "write", { i: "Writing behavior test", path: TEST_PATH, content: BEHAVIOR_TEST });
		if (!executed.some(call => call.name === "bash"))
			return tool(request, "bash", { i: "Running failing test", command: VALIDATION_COMMAND, timeout: 60 });
		if (!executed.some(call => call.name === "write" && call.args.path === IMPLEMENTATION_PATH))
			return tool(request, "write", {
				i: "Implementing greeting",
				path: IMPLEMENTATION_PATH,
				content: IMPLEMENTATION,
			});
		if (executed.filter(call => call.name === "bash").length < 2)
			return tool(request, "bash", { i: "Running completed test", command: VALIDATION_COMMAND, timeout: 60 });
		return { text: "Implementation and behavior tests completed." };
	}
	if (!payload && ordinary.includes("OMP_SPEC_REVIEW_CHILD") && request.tools?.length) {
		if (!calls(request).some(call => call.name === "read"))
			return tool(request, "read", { i: "Reviewing implementation", path: IMPLEMENTATION_PATH });
		if (request.tools?.some(item => item.function?.name.replace(/^_/u, "") === "yield"))
			return tool(request, "yield", {
				type: "result",
				data: { overall_correctness: "correct", explanation: "Reviewed the implementation.", confidence: 1 },
			});
		return { text: "Reviewed the implementation." };
	}
	if (!payload && ordinary.includes("OMP_SPEC_ORDINARY_CHILD")) return { text: "OMP_SPEC_ORDINARY_CHILD_DONE" };
	if (!payload && ordinary.includes("OMP_SPEC_ORDINARY_CONTROL") && request.tools?.length) {
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
	options: ProviderScenario & {
		observe?: (request: ModelRequest) => void | Promise<void>;
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
				await options.observe?.(body);
				await options.delay?.(body, request.signal);
				const failure = options.fail?.(body);
				if (failure)
					return Response.json({ error: { message: failure, type: "fixture_failure" } }, { status: 400 });
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
