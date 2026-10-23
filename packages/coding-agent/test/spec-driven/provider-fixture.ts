import { isRecord } from "@oh-my-pi/pi-utils";

export const MARKER = "OMP_SPEC_PUBLIC_GREETING";
export const CHANGE_ID = "public-greeting";
export const IMPLEMENTATION_PATH = "src/greeting.ts";
export const TEST_PATH = "test/greeting.test.ts";
export const VALIDATION_COMMAND = "bun test test/greeting.test.ts";
export const REQUIREMENT =
	"greet(name) trims outer whitespace, defaults empty names to world, preserves internal whitespace and returns Hello, <name>!.";
export const IMPLEMENTATION = `export function greet(name: string): string {\n  return \`Hello, \${name.trim() || "world"}!\`;\n}\n`;
export const BEHAVIOR_TEST = [
	'import { expect, test } from "bun:test";',
	'import { existsSync } from "node:fs";',
	'const implementation = new URL("../src/greeting.ts", import.meta.url);',
	"// Loading-boundary test: a static import would fail before RED behavior assertions can run.",
	"const greet = existsSync(implementation) ? (await import(implementation.href)).greet : undefined;",
	'test("greeting normalizes outer whitespace", () => { expect(greet?.("  Ada  ")).toBe("Hello, Ada!"); });',
	'test("empty and whitespace names use world", () => { expect(greet?.("")).toBe("Hello, world!"); expect(greet?.("  ")).toBe("Hello, world!"); });',
	'test("internal whitespace is preserved", () => { expect(greet?.(" Ada  Lovelace ")).toBe("Hello, Ada  Lovelace!"); });',
	"",
].join("\n");

export interface ModelRequest {
	model: string;
	messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
	tools?: Array<{ type?: string; function?: { name: string; parameters?: unknown } }>;
}
interface Reply {
	text?: string;
	tool?: { name: string; args: Record<string, unknown> };
}
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
	return "";
}
/** Parse only the fixed adapter payload, never role names from prose prompts. */
export function rolePayload(
	request: ModelRequest,
): { specDrivenRole: string; input: Record<string, unknown> } | undefined {
	for (const message of request.messages.filter(item => item.role === "user")) {
		const source = contentText(message.content);
		for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
			let depth = 0;
			let quoted = false;
			let escaped = false;
			for (let end = start; end < source.length; end++) {
				const char = source[end];
				if (quoted) {
					if (escaped) escaped = false;
					else if (char === "\\") escaped = true;
					else if (char === '"') quoted = false;
					continue;
				}
				if (char === '"') quoted = true;
				else if (char === "{") depth++;
				else if (char === "}" && --depth === 0) {
					try {
						const value: unknown = JSON.parse(source.slice(start, end + 1));
						if (isRecord(value) && typeof value.specDrivenRole === "string" && isRecord(value.input))
							return { specDrivenRole: value.specDrivenRole, input: value.input };
					} catch {
						/* An unrelated JSON block is not an adapter payload. */
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
const yieldData = (request: ModelRequest, data: Record<string, unknown>) => tool(request, "yield", { data });
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
/** Provider output only: no filesystem access, processes, Git, orchestration or fabricated tool results. */
export function respond(request: ModelRequest): Reply {
	const payload = rolePayload(request);
	// SDK task labels quote delegated role inputs but are not native role turns.
	// Keep this exact tool-free contract narrow so a real role missing yield fails.
	if (
		!request.tools?.length &&
		request.messages.some(
			message =>
				message.role === "system" &&
				contentText(message.content).startsWith("# Task\nLabel the delegated work in the next user message:") &&
				contentText(message.content).includes("inside `<title>` and `</title>`"),
		)
	)
		return {
			text: `<title>${payload?.specDrivenRole === "reviewer" ? "Review" : "Draft"} greeting specification</title>`,
		};
	const manual = request.messages
		.filter(message => message.role === "user")
		.map(message => contentText(message.content))
		.join("\n")
		.match(/OMP_SPEC_MANUAL_RESOURCE (\{[^\n]+\})/u);
	if (manual && request.tools?.length) {
		const selected: unknown = JSON.parse(manual[1]!);
		if (
			!isRecord(selected) ||
			typeof selected.path !== "string" ||
			!Array.isArray(selected.deniedPaths) ||
			!selected.deniedPaths.every(value => typeof value === "string")
		)
			throw new Error("Invalid selected package resource");
		const executed = calls(request);
		const targets = [selected.path, selected.deniedPaths.join(";")];
		for (const target of targets)
			if (!executed.some(call => call.name === "read" && call.args.path === target))
				return tool(request, "read", { i: "Inspecting packaged resource access", path: target });
		// Completion is not evidence: consumer assertions inspect the correlated native
		// read results, including every denied resource, rather than a model echo.
		return { text: `${MARKER}_CHAT_READY` };
	}
	const schema = JSON.stringify(
		request.tools?.find(item => item.function?.name.replace(/^_/u, "") === "yield")?.function?.parameters ?? {},
	);
	if (schema.includes('"noViableProposal"'))
		return yieldData(request, {
			proposal: `${MARKER}: implement one pure greet(name) export; RED before production creation, then GREEN using actual Bun behavior tests.`,
			noViableProposal: false,
			investigationBlockedReason: "",
			keyAssumptions: [],
			risks: [],
			unknowns: [],
			acceptanceCriteria: [REQUIREMENT],
			ambiguityInterpretations: [],
			evidence: [],
		});
	if (schema.includes('"unifiedUnderstanding"'))
		return yieldData(request, {
			unifiedUnderstanding: REQUIREMENT,
			acceptanceCriteria: [REQUIREMENT],
			factDifferences: [],
			interpretationDifferences: [],
		});
	if (schema.includes('"noSubstantiveIssues"'))
		return yieldData(request, {
			noSubstantiveIssues: true,
			reviewSummary: "Pure greeting and real tests satisfy the approved behavior without shared state.",
			findings: [],
			blockingResolutions: [],
		});
	if (schema.includes('"reportMarkdown"'))
		return yieldData(request, {
			reportMarkdown:
				"## A\nPure greeting function with real RED/GREEN Bun tests.\n## B\nEquivalent normalization and the same behavioral contract.",
			recommendedProposal: "A",
			recommendationReason: "Small pure implementation and verifiable behavior.",
			recommendationPreconditions: "",
			hardConstraintViolations: [],
		});
	if (!payload) return { text: `${MARKER}_CHAT_READY` };
	if (payload.specDrivenRole === "requirements")
		return yieldData(request, {
			proposal: `# ${MARKER}\n\n## Why\nProvide a deterministic greeting.\n\nRequested scope: ${String(payload.input.request ?? "")}\n\n## What Changes\nAdd greet(name) and real Bun behavior tests.\n\n## Capabilities\n### New Capabilities\n- greeting: normalized greeting\n\n## Impact\nOnly ${IMPLEMENTATION_PATH} and ${TEST_PATH}.\n`,
			specs: [
				{
					path: "specs/greeting/spec.md",
					content: `## ADDED Requirements\n\n### Requirement: Normalized greeting\nThe system SHALL expose greet(name). ${REQUIREMENT}\n\n#### Scenario: Outer whitespace\n- **WHEN** greet("  Ada  ") is called\n- **THEN** return "Hello, Ada!"\n\n#### Scenario: Blank name\n- **WHEN** greet("  ") is called\n- **THEN** return "Hello, world!"\n\n#### Scenario: Internal whitespace\n- **WHEN** greet(" Ada  Lovelace ") is called\n- **THEN** return "Hello, Ada  Lovelace!"\n`,
				},
			],
			requirements: [{ id: "R001", text: REQUIREMENT }],
			questions: [],
		});
	if (payload.specDrivenRole === "planner")
		return yieldData(request, {
			content: `# ${MARKER} implementation plan\n\nT001: create ${TEST_PATH}; run ${VALIDATION_COMMAND} RED; create ${IMPLEMENTATION_PATH}; rerun GREEN. OMP commits only task-owned files and independently reviews the range. Final validation uses the real Bun entry. After final user acceptance synchronize specs and archive.\n`,
			tasks: [
				{
					id: "T001",
					title: "Implement normalized greeting with behavioral TDD",
					instructions: `${MARKER}: write real behavior tests, invoke greeting-behavior RED before production writes, implement greet, invoke GREEN.`,
					requirementIds: ["R001"],
					dependencies: [],
					conditionIds: [],
					ownedPaths: [IMPLEMENTATION_PATH, TEST_PATH],
					implementationPaths: [IMPLEMENTATION_PATH],
					solutionBinding: "pure-greeting-v1",
					validation: [{ id: "greeting-behavior", command: VALIDATION_COMMAND, behavior: REQUIREMENT }],
					tdd: { mode: "required", behavior: REQUIREMENT },
				},
			],
			conditions: [],
			finalValidation: [
				{ id: "real-bun-entry", command: VALIDATION_COMMAND, behavior: REQUIREMENT, realEntry: true },
			],
			closure: { sync: true, archive: true },
		});
	if (payload.specDrivenRole === "reviewer") {
		const records = Array.isArray(payload.input.records) ? payload.input.records : [];
		if (payload.input.kind === "task" || payload.input.kind === "overall") {
			// 按 tool_call_id 关联实际读取结果；Provider 收到的是文件正文，
			// 不能要求仅供界面展示的行号或用呈现格式判断读取是否完成。
			const reviewed = (file: string): boolean => {
				const readPath = `${file}:1-80`;
				for (const message of request.messages) {
					if (message.role !== "assistant") continue;
					for (const call of message.tool_calls ?? []) {
						if (!isRecord(call) || typeof call.id !== "string" || !isRecord(call.function)) continue;
						if (typeof call.function.name !== "string" || call.function.name.replace(/^_/u, "") !== "read")
							continue;
						if (typeof call.function.arguments !== "string") continue;
						const args: unknown = JSON.parse(call.function.arguments);
						if (!isRecord(args) || args.path !== readPath) continue;
						const result = request.messages.find(item => item.role === "tool" && item.tool_call_id === call.id);
						if (!result) throw new Error(`Independent review is missing the native read result for ${file}`);
						return true;
					}
				}
				return false;
			};
			if (!reviewed(IMPLEMENTATION_PATH))
				return tool(request, "read", {
					i: "Reviewing actual production behavior",
					path: `${IMPLEMENTATION_PATH}:1-80`,
				});
			if (!reviewed(TEST_PATH))
				return tool(request, "read", { i: "Reviewing actual behavioral assertions", path: `${TEST_PATH}:1-80` });
			if (!records.length) throw new Error("Independent review requires runner-owned validation records");
		}
		const evidenceChecks = records.map(record => {
			if (!isRecord(record) || !isRecord(record.result)) throw new Error("Missing actual validation result");
			const output = `${record.result.stdout ?? ""}\n${record.result.stderr ?? ""}`;
			const green = record.result.exitCode === 0 && output.includes("3 pass");
			const red =
				record.result.exitCode !== 0 &&
				output.includes("Hello, Ada!") &&
				/3 fail|Expected:|expect\(received\)/u.test(output);
			if (!green && !red) throw new Error(`Unrelated or absent validation output: ${record.id}`);
			return {
				recordId: record.id,
				behavior: REQUIREMENT,
				valid: true,
				reason: green
					? "Actual Bun assertions pass all normalization cases."
					: "Actual RED assertions compare missing behavior to required greetings before production creation.",
			};
		});
		return yieldData(request, {
			verdict: "pass",
			summary:
				"Independent review of source, behavior assertions, task-owned range and actual command results passes.",
			findings: [],
			resolutions: [],
			questions: [],
			evidenceChecks,
		});
	}
	if (payload.specDrivenRole === "executor") {
		const executed = calls(request);
		if (!executed.some(call => call.name === "write" && call.args.path === TEST_PATH))
			return tool(request, "write", {
				i: "Writing actual greeting behavior tests",
				path: TEST_PATH,
				content: BEHAVIOR_TEST,
			});
		if (!executed.some(call => call.name === "spec_verify" && call.args.stage === "red"))
			return tool(request, "spec_verify", { validationId: "greeting-behavior", stage: "red" });
		if (!executed.some(call => call.name === "write" && call.args.path === IMPLEMENTATION_PATH))
			return tool(request, "write", {
				i: "Implementing approved greeting behavior",
				path: IMPLEMENTATION_PATH,
				content: IMPLEMENTATION,
			});
		if (!executed.some(call => call.name === "spec_verify" && call.args.stage === "green"))
			return tool(request, "spec_verify", { validationId: "greeting-behavior", stage: "green" });
		return yieldData(request, {
			summary: "Implemented greeting using actual RED and GREEN commands.",
			requestedTddException: "",
		});
	}
	throw new Error(`Unknown native spec role: ${payload.specDrivenRole}`);
}

/** Standard OpenAI SSE; only localhost is accepted and every request is recorded for consumer assertions. */
export function createProviderFixture() {
	const requests: ModelRequest[] = [];
	const failures: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== "/v1/chat/completions") {
				// Unexpected catalog/API routes are failures too; otherwise a public-run stall loses its cause.
				failures.push(`Unexpected provider request: ${request.method} ${url.pathname.slice(0, 200)}`);
				return new Response("Unexpected model/catalog access", { status: 500 });
			}
			try {
				const body = (await request.json()) as ModelRequest;
				requests.push(body);
				const reply = respond(body);
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
