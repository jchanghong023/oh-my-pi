import { isRecord } from "@oh-my-pi/pi-utils";

export const MARKER = "OMP_SPEC_PUBLIC_GREETING";
export const CHANGE_ID = "public-greeting";
export const IMPLEMENTATION_PATH = "src/greeting.ts";
export const HANDOFF_MARKER = "OMP_SPEC_NATIVE_HANDOFF";
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
export interface Reply {
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
	for (const message of request.messages.filter(item => item.role === "user").toReversed()) {
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
const yieldData = (request: ModelRequest, data: Record<string, unknown>): Reply =>
	request.tools?.some(item => item.function?.name.replace(/^_/u, "") === "yield")
		? tool(request, "yield", { data })
		: { text: JSON.stringify(data) };
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

const parallelCoverage = [
	{ id: "T002", path: "test/greeting-empty.test.ts", name: "blank input", values: ["", " ", "\t\n"] },
	{ id: "T003", path: "test/greeting-spacing.test.ts", name: "outer whitespace", values: [" Ada ", "\tAda\n", "Ada"] },
];
function coverageTest(task: (typeof parallelCoverage)[number]): string {
	return [
		'import { expect, test } from "bun:test";',
		'import { greet } from "../src/greeting";',
		...task.values.map(
			(value, index) =>
				`test(${JSON.stringify(`${task.name} ${index}`)}, () => expect(greet(${JSON.stringify(value)})).toBe(${JSON.stringify(task.id === "T002" ? "Hello, world!" : "Hello, Ada!")}));`,
		),
		"",
	].join("\n");
}
function taskResult(request: ModelRequest, action: string): Record<string, unknown> | undefined {
	for (const message of request.messages.toReversed()) {
		if (message.role !== "assistant") continue;
		for (const call of message.tool_calls ?? []) {
			if (!isRecord(call) || !isRecord(call.function) || typeof call.function.arguments !== "string") continue;
			if (typeof call.function.name !== "string" || call.function.name.replace(/^_/u, "") !== "spec_task") continue;
			const args: unknown = JSON.parse(call.function.arguments);
			if (!isRecord(args) || args.action !== action) continue;
			const result = request.messages.find(item => item.role === "tool" && item.tool_call_id === call.id);
			if (!result) continue;
			const text = contentText(result.content);
			try {
				const value: unknown = JSON.parse(text);
				if (isRecord(value)) return value;
			} catch {
				/* Tool presentation may surround JSON; never infer success from prose. */
			}
		}
	}
	return undefined;
}
function childResponse(request: ModelRequest, id: string): Reply {
	const selected = parallelCoverage.find(task => task.id === id);
	if (!selected) throw new Error(`Unknown native fixture task ${id}`);
	const executed = calls(request);
	if (!executed.some(call => call.name === "spec_task" && call.args.action === "start"))
		return tool(request, "spec_task", { action: "start", taskId: id });
	if (!executed.some(call => call.name === "write" && call.args.path === selected.path))
		return tool(request, "write", {
			i: "Writing independent greeting coverage",
			path: selected.path,
			content: coverageTest(selected),
		});
	if (!executed.some(call => call.name === "spec_verify"))
		return tool(request, "spec_verify", { validationId: `${id}-coverage`, stage: "green" });
	if (!executed.some(call => call.name === "spec_task" && call.args.action === "checkpoint"))
		return tool(request, "spec_task", { action: "checkpoint", taskId: id });
	return { text: `Actual ${id} source checkpoint completed; parent must integrate and validate target.` };
}

/** The native maintenance prompt, not a model-authored mention of a transition. */
export function isNativeHandoff(request: ModelRequest): boolean {
	const lastUser = request.messages.findLast(message => message.role === "user");
	return contentText(lastUser?.content).includes("Write a handoff document for another instance of yourself.");
}
/** Provider output only: no filesystem access, processes, Git, orchestration or fabricated tool results. */
export function respond(request: ModelRequest, options?: { requirementsQuestion?: string }): Reply {
	const payload = rolePayload(request);
	if (isNativeHandoff(request))
		return {
			text: `## Goal\n${HANDOFF_MARKER}: ${payload?.specDrivenRole ?? "unknown"}\n\nContinue the approved greeting work using the supplied formal documents and user decisions.`,
		};
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
		const allowedPaths = selected.allowedPaths ?? [];
		if (!Array.isArray(allowedPaths) || !allowedPaths.every(value => typeof value === "string"))
			throw new Error("Invalid selected package resource");
		const executed = calls(request);
		const targets = [selected.path, ...allowedPaths, selected.deniedPaths.join(";")];
		for (const target of targets)
			if (!executed.some(call => call.name === "read" && call.args.path === target))
				return tool(request, "read", { i: "Inspecting packaged resource access", path: target });
		// Completion is not evidence: consumer assertions inspect the correlated native
		// read results, including every denied resource, rather than a model echo.
		return { text: `${MARKER}_CHAT_READY` };
	}
	const child = request.messages
		.filter(message => message.role === "user")
		.map(message => contentText(message.content))
		.join("\n")
		.match(/OMP_SPEC_CHILD_TASK (T00[23])/u);
	if (child && request.tools?.length) return childResponse(request, child[1]!);
	const ordinary = request.messages
		.filter(message => message.role === "user")
		.map(message => contentText(message.content))
		.join("\n");
	if (ordinary.includes("OMP_SPEC_ORDINARY_CHILD") && request.tools?.length)
		return { text: "OMP_SPEC_ORDINARY_CHILD_DONE" };
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
		if (
			request.tools?.some(item => item.function?.name.replace(/^_/u, "") === "goal") &&
			!executed.some(call => call.name === "goal" && call.args.op === "complete")
		)
			return tool(request, "goal", { op: "complete" });
		return { text: "OMP_SPEC_ORDINARY_CONTROL_DONE" };
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
	const originals = isRecord(payload.input.originals) ? payload.input.originals : undefined;
	const mappedEntries = Array.isArray(originals?.entries) ? originals.entries : [];
	const greetingSource = mappedEntries.find(
		entry =>
			isRecord(entry) &&
			entry.path === "docs/requirements/greeting.md" &&
			Array.isArray(entry.headingPath) &&
			entry.headingPath.at(-1) === "R001 Greeting",
	);
	if (
		greetingSource &&
		(!isRecord(greetingSource) ||
			typeof greetingSource.id !== "string" ||
			typeof greetingSource.original !== "string" ||
			typeof originals?.version !== "string")
	)
		throw new Error("Existing Markdown fixture requires runtime-provided source IDs, original text and map version");
	const sourcePatches = isRecord(greetingSource)
		? [
				{
					operation: "modify",
					sourceId: greetingSource.id,
					replacement:
						String(greetingSource.original).replace(
							"greet(name) returns Hello, <name>! without normalizing outer whitespace or empty names.",
							REQUIREMENT,
						) +
						'\n### Scenario: Outer whitespace\nCalling greet("  Ada  ") returns "Hello, Ada!".\n\n### Scenario: Blank name\nCalling greet("  ") returns "Hello, world!".\n',
				},
			]
		: undefined;
	if (payload.specDrivenRole === "requirements")
		return yieldData(request, {
			...(sourcePatches ? { sourceMapVersion: originals!.version, sourcePatches } : {}),
			document: {
				path: "requirements.md",
				content: `# ${MARKER} requirements\n\n## Goal and scope\nProvide normalized greetings using the existing Bun entry with independent blank-input and whitespace coverage.\n\n## Constraints\nOnly change ${[IMPLEMENTATION_PATH, TEST_PATH, ...parallelCoverage.map(task => task.path)].join(", ")}.\n\n## R001\n${REQUIREMENT}\n\n## Acceptance\nOuter whitespace is trimmed, blank names use world, and internal whitespace is preserved. Independent coverage must be integrated and validated on the target.\n`,
			},
			proposal: `# ${MARKER}\n\n## Why\nProvide a deterministic greeting.\n\nRequested scope: ${String(payload.input.request ?? "")}\n\n## What Changes\nAdd greet(name), real Bun behavior tests and independent blank-input/whitespace coverage.\n\n## Capabilities\n### New Capabilities\n- greeting: normalized greeting\n\n## Impact\nOnly ${[IMPLEMENTATION_PATH, TEST_PATH, ...parallelCoverage.map(task => task.path)].join(", ")}.\n`,
			specs: [
				{
					path: "specs/greeting/spec.md",
					content: `## ADDED Requirements\n\n### Requirement: Normalized greeting\nThe system SHALL expose greet(name). ${REQUIREMENT}\n\n#### Scenario: Outer whitespace\n- **WHEN** greet("  Ada  ") is called\n- **THEN** return "Hello, Ada!"\n\n#### Scenario: Blank name\n- **WHEN** greet("  ") is called\n- **THEN** return "Hello, world!"\n\n#### Scenario: Internal whitespace\n- **WHEN** greet(" Ada  Lovelace ") is called\n- **THEN** return "Hello, Ada  Lovelace!"\n`,
				},
			],
			requirements: [{ id: "R001", text: REQUIREMENT }],
			questions: options?.requirementsQuestion && !payload.input.answer ? [options.requirementsQuestion] : [],
		});
	// The solution actor organizes the existing native Team. It cannot manufacture
	// candidate IDs/proposals; the schema-driven Team responses above remain authoritative.
	if (payload.specDrivenRole === "solution") return yieldData(request, { questions: [] });
	if (payload.specDrivenRole === "planner")
		return yieldData(request, {
			content: `# ${MARKER} implementation plan\n\nT001: implement inline; create ${TEST_PATH}; run ${VALIDATION_COMMAND} RED; create ${IMPLEMENTATION_PATH}; rerun GREEN and checkpoint. T002 and T003 depend on T001's stable greet interface, are independent of one another and must run concurrently in isolated native tasks. Each writes only its own approved coverage file, runs GREEN and seals its genuine source checkpoint. The retained executor integrates each opaque source and checkpoints the actual target. OMP commits only task-owned files and independently reviews each parent range in one seat. Final validation uses the real Bun entry. After final user acceptance synchronize specs and archive.\n`,
			workspace: { executionPath: ".", isolation: "native", integration: "native" },
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
					validation: [
						{
							id: "greeting-behavior",
							command: VALIDATION_COMMAND,
							behavior: REQUIREMENT,
							inputPaths: [IMPLEMENTATION_PATH, TEST_PATH],
						},
					],
					tdd: { mode: "required", behavior: REQUIREMENT },
				},
				...parallelCoverage.map(task => ({
					id: task.id,
					title: `Independently extend ${task.name} coverage`,
					instructions: `Add three real ${task.name} behavior cases in ${task.path}; retain the approved greet interface.`,
					requirementIds: ["R001"],
					dependencies: ["T001"],
					conditionIds: [],
					ownedPaths: [task.path],
					implementationPaths: [],
					solutionBinding: `independent-${task.id}-coverage`,
					validation: [
						{
							id: `${task.id}-coverage`,
							command: `bun test ${task.path}`,
							behavior: REQUIREMENT,
							inputPaths: [IMPLEMENTATION_PATH, task.path],
						},
					],
					tdd: {
						mode: "exception",
						reason: "Test-only expansion of already implemented behavior; no production change.",
						alternativeCommands: [`bun test ${task.path}`],
					},
				})),
			],
			conditions: [],
			finalValidation: [
				{
					id: "real-bun-entry",
					command: VALIDATION_COMMAND,
					behavior: REQUIREMENT,
					inputPaths: [IMPLEMENTATION_PATH, TEST_PATH],
					realEntry: true,
				},
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
			for (const task of parallelCoverage) {
				const selectedTask = isRecord(payload.input.task) ? payload.input.task : undefined;
				if (payload.input.kind !== "overall" && selectedTask?.id !== task.id) continue;
				if (!reviewed(task.path))
					return tool(request, "read", {
						i: "Reviewing independently integrated coverage",
						path: `${task.path}:1-80`,
					});
			}
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
					: record.obligation && isRecord(record.obligation) && record.obligation.stage === "red"
						? "Actual RED assertions expose missing required greeting behavior before production creation."
						: "Actual failed validation exposes the externally corrupted expectation; current successful GREEN and inspected repaired source are required separately.",
			};
		});
		if (payload.input.kind === "requirements" && sourcePatches && isRecord(greetingSource)) {
			const specification = payload.input.specification;
			const patches =
				isRecord(specification) && Array.isArray(specification.sourcePatches) ? specification.sourcePatches : [];
			const patch = patches[0];
			if (
				!isRecord(specification) ||
				specification.sourceMapVersion !== originals!.version ||
				patches.length !== 1 ||
				!isRecord(patch) ||
				patch.operation !== "modify" ||
				patch.sourceId !== greetingSource.id ||
				patch.replacement !== sourcePatches[0]!.replacement
			)
				throw new Error("Independent requirements review did not receive the exact mapped greeting patch");
			for (const entry of mappedEntries) {
				if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.original !== "string")
					throw new Error("Requirements review requires actual mapped source text");
				const replacement = sourcePatches[0]!.replacement;
				if (
					entry.id === greetingSource.id &&
					(!replacement.includes(REQUIREMENT) ||
						!replacement.includes('### Scenario: Named greeting\nCalling greet("Ada") returns "Hello, Ada!".') ||
						!replacement.includes(
							'### Scenario: Internal whitespace\nCalling greet("Ada  Lovelace") returns "Hello, Ada  Lovelace!".',
						))
				)
					throw new Error("Mapped greeting patch loses the approved behavior or existing scenarios");
				evidenceChecks.push({
					recordId: entry.id,
					behavior: REQUIREMENT,
					valid: true,
					reason:
						entry.id === greetingSource.id
							? "Inspected mapped original and exact replacement: only outer/blank normalization changes; existing named and internal-whitespace scenarios remain."
							: "Inspected mapped original; the sole greeting-section patch leaves unrelated text and enclosing document content intact.",
				});
			}
		}
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
		const currentTasks = Array.isArray(payload.input.tasks) ? payload.input.tasks : [];
		const latestInput = request.messages.findLastIndex(
			message =>
				message.role === "user" && rolePayload({ ...request, messages: [message] })?.specDrivenRole === "executor",
		);
		// Resume is bound to current host task state, not transcript survival after compaction/generation changes.
		const repairing = currentTasks.some(
			task =>
				isRecord(task) &&
				task.status !== "completed" &&
				(isRecord(task.execution) || (Array.isArray(task.records) && task.records.length > 0)),
		);
		if (repairing) {
			const repairCalls = calls({ ...request, messages: request.messages.slice(latestInput + 1) });
			for (const state of currentTasks) {
				if (!isRecord(state) || state.status === "completed" || typeof state.id !== "string") continue;
				const taskId = state.id;
				if (
					!repairCalls.some(
						call => call.name === "spec_task" && call.args.action === "start" && call.args.taskId === taskId,
					)
				)
					return tool(request, "spec_task", { action: "start", taskId });
				const validationId = taskId === "T001" ? "greeting-behavior" : `${taskId}-coverage`;
				const validations = repairCalls.filter(
					call => call.name === "spec_verify" && call.args.validationId === validationId,
				);
				if (!validations.length) return tool(request, "spec_verify", { validationId, stage: "green" });
				if (taskId === "T001" && !repairCalls.some(call => call.name === "write"))
					return tool(request, "write", {
						i: "Repairing invalidated behavior assertions",
						path: TEST_PATH,
						content: BEHAVIOR_TEST,
					});
				if (taskId === "T001" && validations.length < 2)
					return tool(request, "spec_verify", { validationId, stage: "green" });
				if (
					!repairCalls.some(
						call => call.name === "spec_task" && call.args.action === "checkpoint" && call.args.taskId === taskId,
					)
				)
					return tool(request, "spec_task", { action: "checkpoint", taskId });
			}
			return yieldData(request, {
				summary: "Current target revalidated after scoped repair; host must issue a fresh acceptance version.",
			});
		}
		if (
			!executed.some(
				call => call.name === "spec_task" && call.args.action === "start" && call.args.taskId === "T001",
			)
		)
			return tool(request, "spec_task", { action: "start", taskId: "T001" });
		for (const [name, reason] of [
			["T999", "unknown"],
			["T002", "non-ready"],
			["T001", "overlap"],
		] as const) {
			if (!executed.some(call => call.name === "task" && call.args.context === `OMP_SPEC_REJECT_${reason}`))
				return tool(request, "task", {
					context: `OMP_SPEC_REJECT_${reason}`,
					tasks: [
						{
							name,
							task: `OMP_SPEC_FORBIDDEN_${reason}: must be rejected before native effects.`,
							solutionSpace: "admission refusal probe",
							isolated: true,
						},
					],
				});
		}
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
		if (
			!executed.some(
				call => call.name === "spec_task" && call.args.action === "checkpoint" && call.args.taskId === "T001",
			)
		)
			return tool(request, "spec_task", { action: "checkpoint", taskId: "T001" });
		const checkpoint = taskResult(request, "checkpoint");
		if (isRecord(checkpoint?.task) && checkpoint.task.status !== "completed" && checkpoint.task.id === "T001")
			throw new Error(`Actual inline checkpoint refused: ${JSON.stringify(checkpoint)}`);
		const mode = payload.input.mode;
		const continuation = request.messages.some(
			message => message.role === "user" && contentText(message.content).includes("Continue active goal."),
		);
		if (mode === "goal" && !continuation)
			return yieldData(request, {
				summary:
					"Inline checkpoint is complete; continue the active approved goal with independent native coverage tasks.",
			});
		if (!executed.some(call => call.name === "task" && call.args.context === "OMP_SPEC_PARALLEL_COVERAGE"))
			return tool(request, "task", {
				i: "Dispatching independent native coverage",
				context: "OMP_SPEC_PARALLEL_COVERAGE",
				tasks: parallelCoverage.map(task => ({
					name: task.id,
					task: `OMP_SPEC_CHILD_TASK ${task.id}\nImplement approved test-only coverage, invoke ${task.id}-coverage GREEN, checkpoint the actual native source, then return.`,
					solutionSpace: "one approved test-only coverage task; no production changes",
					isolated: true,
				})),
			});
		const status = taskResult(request, "status");
		if (!status) return tool(request, "spec_task", { action: "status" });
		const sources = Array.isArray(status.sources) ? status.sources : [];
		for (const task of parallelCoverage) {
			if (
				!executed.some(
					call => call.name === "spec_task" && call.args.action === "integrate" && call.args.taskId === task.id,
				)
			) {
				const ids = sources
					.filter(source => isRecord(source) && source.taskId === task.id)
					.map(source => (isRecord(source) ? source.sourceId : undefined));
				if (!ids.length || !ids.every(id => typeof id === "string"))
					throw new Error(`Native ${task.id} did not expose a genuine frozen source: ${JSON.stringify(status)}`);
				return tool(request, "spec_task", { action: "integrate", taskId: task.id, sourceIds: ids });
			}
			if (
				!executed.some(
					call => call.name === "spec_task" && call.args.action === "checkpoint" && call.args.taskId === task.id,
				)
			)
				return tool(request, "spec_task", { action: "checkpoint", taskId: task.id });
		}
		return yieldData(request, {
			summary:
				"All approved tasks have actual target checkpoints; host must perform final validation, review and user acceptance.",
		});
	}
	throw new Error(`Unknown native spec role: ${payload.specDrivenRole}`);
}

export interface ProviderFixture {
	requests: ModelRequest[];
	handoffs: ModelRequest[];
	failures: string[];
	baseUrl: string;
	[Symbol.asyncDispose](): Promise<void>;
}
/** Standard OpenAI SSE; only localhost is accepted and every request is recorded for consumer assertions. */
export function createProviderFixture(
	options: {
		handoff?: (request: ModelRequest, ordinal: number) => Reply | Promise<Reply>;
		requirementsQuestion?: string;
		observe?: (request: ModelRequest) => void | Promise<void>;
	} = {},
): ProviderFixture {
	const requests: ModelRequest[] = [];
	const failures: string[] = [];
	const handoffs: ModelRequest[] = [];
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
				await options.observe?.(body);
				let reply: Reply;
				if (isNativeHandoff(body)) {
					handoffs.push(body);
					reply = options.handoff
						? await options.handoff(body, handoffs.length)
						: { text: `${respond(body).text}\n\nNative response identity: ${HANDOFF_MARKER}-${handoffs.length}` };
				} else reply = respond(body, options);
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
		handoffs,
		failures,
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		[Symbol.asyncDispose]: async () => {
			server.stop(true);
		},
	};
}
