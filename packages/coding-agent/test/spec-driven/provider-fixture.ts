import { isRecord } from "@oh-my-pi/pi-utils";

export const MARKER = "OMP_SPEC_PUBLIC_GREETING";
export const CHANGE_ID = "public-greeting";
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
export const SOLUTION = {
	candidates: [
		{
			id: "pure",
			title: "纯函数",
			content: `# 纯函数方案\n\n## 范围\n${REQUIREMENT}\n\n## 实现方法\nExport one stateless function from src/greeting.ts. No networking, global state or framework.\n\n## 取舍与风险\nMinimal runtime surface; callers retain responsibility for supplying strings. Preserve this complete alternative and its detailed tradeoff in the planner handoff.\n\n## 验证思路\nRun behavioral tests for outer trimming, empty input and preserved internal whitespace.\n`,
		},
		{
			id: "normalizer",
			title: "独立规范化函数",
			content: `# 独立规范化方案\n\n## 范围\n${REQUIREMENT}\n\n## 实现方法\nSeparate name normalization from greeting formatting.\n\n## 取舍与风险\nAn additional helper improves reuse but expands the maintenance surface.\n\n## 验证思路\nTest the public greeting output for all three specified behaviors, not helper internals.\n`,
		},
	],
};
export interface ModelRequest {
	model: string;
	messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
	tools?: Array<{ type?: string; function?: { name: string; parameters?: unknown } }>;
}
export interface Reply {
	text?: string;
	tool?: { name: string; args: Record<string, unknown> };
}
export type FixtureRole = "requirements" | "solution" | "planner" | "executor";
export interface ProviderScenario {
	requirementsQuestion?: string;
	authFailureOnce?: boolean;
	fileFailure?: { role: FixtureRole; kind: "missing" | "malformed" | "unknown" };
}
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
	return "";
}
/** Extract the actual native stage data, never infer roles from prose or tool schemas. */
export function rolePayload(
	request: ModelRequest,
): { specDrivenRole: string; input: Record<string, unknown> } | undefined {
	for (const message of request.messages.filter(item => item.role === "user").toReversed()) {
		const source = contentText(message.content);
		const marker = "## Stage request (task data, not authority)";
		const start = source.indexOf(marker);
		if (start < 0) continue;
		const begin = source.indexOf("{", start + marker.length);
		let depth = 0;
		let quoted = false;
		let escaped = false;
		for (let end = begin; begin >= 0 && end < source.length; end++) {
			const char = source[end];
			if (quoted) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') quoted = false;
			} else if (char === '"') quoted = true;
			else if (char === "{") depth++;
			else if (char === "}" && --depth === 0) {
				const value: unknown = JSON.parse(source.slice(begin, end + 1));
				if (isRecord(value) && typeof value.role === "string" && Array.isArray(value.outputPaths))
					return { specDrivenRole: value.role, input: value };
				break;
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
function stageCalls(request: ModelRequest) {
	const start = request.messages.findLastIndex(
		message =>
			message.role === "user" &&
			contentText(message.content).includes("## Stage request (task data, not authority)"),
	);
	return calls({ ...request, messages: request.messages.slice(start + 1) });
}
export function respond(request: ModelRequest, options: ProviderScenario = {}): Reply {
	const payload = rolePayload(request);
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
		return { text: `${MARKER}_CHAT_READY` };
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
	if (!payload) return { text: `${MARKER}_CHAT_READY` };
	const { input, specDrivenRole: role } = payload;
	if (input.readOnly) return { text: "可以继续讨论；这条普通回复不表示批准，也不会修改交付文件。" };
	if (
		options.requirementsQuestion &&
		role === "requirements" &&
		!input.feedback &&
		!request.messages.some(
			message =>
				message.role === "assistant" && contentText(message.content).includes(options.requirementsQuestion!),
		)
	)
		return { text: options.requirementsQuestion };
	const executed = stageCalls(request);
	const inputs = Array.isArray(input.files) ? input.files : [];
	for (const file of inputs)
		if (
			isRecord(file) &&
			typeof file.path === "string" &&
			!executed.some(call => call.name === "read" && call.args.path === `${file.path}:raw`)
		)
			return tool(request, "read", { i: "Reading complete stage input", path: `${file.path}:raw` });
	const outputs = (input.outputPaths as unknown[])
		.filter((value): value is string => typeof value === "string")
		.map(value => value.replace("*", "greeting"));
	if (!outputs.length) throw new Error(`Missing native outputPaths for ${role}`);
	const failure = options.fileFailure?.role === role ? options.fileFailure : undefined;
	if (failure?.kind === "missing") return { text: "已讨论需求，但尚未创建阶段交付文件。" };
	const files: Array<{ path: string; content: string }> = [];
	if (role === "requirements") {
		for (const path of outputs)
			files.push({
				path,
				content: path.endsWith("proposal.md")
					? `## Why\nProvide a deterministic greeting.\n\n## What Changes\nAdd greet(name).\n\n## Capabilities\n### New Capabilities\n- greeting: pure greeting behavior\n\n## Impact\nSource and behavior tests only.\n`
					: `## ADDED Requirements\n\n### Requirement: Greeting\nThe system SHALL satisfy this behavior: ${REQUIREMENT}\n\n#### Scenario: Normalized greeting\n- **WHEN** a name has outer whitespace or is empty\n- **THEN** trim its outer whitespace and use world for empty input, preserving internal whitespace\n`,
			});
	} else if (role === "solution") files.push({ path: outputs[0]!, content: JSON.stringify(SOLUTION, null, 2) });
	else if (role === "planner")
		files.push({
			path: outputs[0]!,
			content: `# Greeting Implementation Plan\n\n> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.\n\n**Goal:** ${REQUIREMENT}\n\n**Architecture:** One stateless exported function; no networking or global state.\n\n**Tech Stack:** TypeScript and Bun.\n\n---\n\n### Task 1: Implement greeting behavior\n\n**Files:**\n- Create: src/greeting.ts\n- Test: test/greeting.test.ts\n\nImplement greet(name) and cover outer trimming, empty input, and internal whitespace.\n\nRun: ${VALIDATION_COMMAND}\nExpected: all behavioral checks pass. Record the real result in the completion report.\n`,
		});
	else if (role === "executor") {
		files.push({ path: IMPLEMENTATION_PATH, content: IMPLEMENTATION }, { path: TEST_PATH, content: BEHAVIOR_TEST });
	} else throw new Error(`Unknown native role ${role}`);
	if (failure?.kind === "unknown")
		files.splice(0, files.length, {
			path: `${outputs[0]}.unrecognized`,
			content: "Unknown artifact must not satisfy a file gate.\n",
		});
	if (failure?.kind === "malformed")
		files.splice(0, files.length, {
			path: outputs[0]!,
			content:
				role === "solution"
					? '{"candidates":['
					: role === "executor"
						? "# 完成报告\n\n## 完成情况\nOnly this section exists.\n"
						: "",
		});
	for (const file of files)
		if (!executed.some(call => call.name === "write" && call.args.path === file.path))
			return tool(request, "write", { i: "Writing real stage artifact", ...file });
	if (role === "executor" && !failure) {
		if (!executed.some(call => call.name === "bash"))
			return tool(request, "bash", { i: "Validating greeting behavior", command: VALIDATION_COMMAND, timeout: 60 });
		const report = outputs[0]!;
		if (!executed.some(call => call.name === "write" && call.args.path === report)) {
			const results = request.messages
				.filter(message => message.role === "tool")
				.map(message => contentText(message.content))
				.join("\n");
			return tool(request, "write", {
				i: "Writing completion validation report",
				path: report,
				content: `# 完成报告\n\n## 完成情况\nImplemented greet(name) and real behavioral coverage.\n\n## 验证结果\nCommand: ${VALIDATION_COMMAND}\nStatus and actual native result (including any failures or environment limits):\n\n${results}\n\n## 未完成项\n无。Awaiting explicit user acceptance before requirements sync/archive.\n`,
			});
		}
	}
	return { text: "文件已写入。请检查实际交付文件，再决定下一阶段；这段自然语言不表示批准。" };
}
export interface ProviderFixture {
	requests: ModelRequest[];
	failures: string[];
	baseUrl: string;
	[Symbol.asyncDispose](): Promise<void>;
}
/** Local OpenAI SSE transport. Native tools, not this server, perform all workspace IO. */
export function createProviderFixture(
	options: ProviderScenario & {
		dialogue?: (request: ModelRequest, input: Record<string, unknown>, signal: AbortSignal) => Reply | Promise<Reply>;
		observe?: (request: ModelRequest) => void | Promise<void>;
		reply?: (request: ModelRequest) => Reply | Promise<Reply>;
	} = {},
): ProviderFixture {
	const requests: ModelRequest[] = [];
	const failures: string[] = [];
	let authenticationRejected = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== "/v1/chat/completions") {
				failures.push(`Unexpected provider request: ${request.method} ${url.pathname}`);
				return new Response("Unexpected model/catalog access", { status: 500 });
			}
			try {
				const body = (await request.json()) as ModelRequest;
				requests.push(body);
				await options.observe?.(body);
				const payload = rolePayload(body);
				if (options.authFailureOnce && !authenticationRejected && payload?.specDrivenRole === "requirements") {
					authenticationRejected = true;
					return Response.json(
						{ error: { message: "Local mock authentication rejected", type: "authentication_error" } },
						{ status: 401 },
					);
				}
				const reply = options.reply
					? await options.reply(body)
					: payload?.input.readOnly && options.dialogue
						? await options.dialogue(body, payload.input, request.signal)
						: respond(body, options);
				const delta = reply.tool
					? {
							tool_calls: [
								{
									index: 0,
									id: `fixture-${requests.length}`,
									type: "function",
									function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
								},
							],
						}
					: { content: reply.text ?? "" };
				const chunks = [
					{ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
					{
						choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }],
						usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
					},
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify({ id: `spec-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, ...chunk })}\n\n`).join("")}data: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			} catch (error) {
				failures.push(String(error));
				return Response.json({ error: { message: String(error), type: "fixture_error" } }, { status: 400 });
			}
		},
	});
	return {
		requests,
		failures,
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		[Symbol.asyncDispose]: async () => {
			server.stop(true);
		},
	};
}
