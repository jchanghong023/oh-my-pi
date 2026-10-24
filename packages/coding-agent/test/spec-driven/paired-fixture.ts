import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import type { SpecRequestMeasurement, SpecRunMeasurement } from "../../src/spec-driven/metrics";
import { SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import { loadSpecDrivenSkill } from "../../src/spec-driven/resources";
import { createSpecDrivenRuntime, type SpecDrivenRuntime } from "../../src/spec-driven/runtime";
import {
	contentText,
	IMPLEMENTATION,
	IMPLEMENTATION_PATH,
	REQUIREMENT,
	respond,
	rolePayload,
	type ModelRequest,
} from "./provider-fixture";

export const PAIRED_CHANGE = "paired-greeting";
export const PAIRED_SPEC_PATH = `openspec/changes/${PAIRED_CHANGE}/specs/greeting/spec.md`;
export const PAIRED_TASK = `${REQUIREMENT} Produce only a proposed greeting specification with explicit trim, blank-name and preserved internal-space scenarios. Do NOT write production code before my explicit specification and implementation approval. Stop awaiting specification approval; no approval is supplied in this run.`;
export const PAIRED_CRITERIA =
	"Observe specification scenarios for trim, blank-name fallback and internal-space preservation; observe whether the attempted pre-approval production write actually mutates src/greeting.ts. No claims about implemented delivery, release quality, or human correction outside this bounded run.";
export const PAIRED_MODELS = {
	currentModel: "spec-fixture/chat-a",
	members: ["spec-fixture/chat-a", "spec-fixture/chat-b"],
	api: "openai-completions",
	reasoning: false,
	contextWindow: 200000,
};

interface CapturedRequest {
	id: string;
	url: string;
	method: string;
	startedAt: number;
	endedAt: number;
	rawBody: string | null;
	body: ModelRequest | null;
	reply: unknown;
	status: number | null;
	error: string | null;
	kind: "auxiliary" | "baseline" | "stage" | "unclassified";
}
const DIRECT_SPEC = `## ADDED Requirements\n\n### Requirement: Normalized greeting\nThe system SHALL expose greet(name). ${REQUIREMENT}\n\n#### Scenario: Outer whitespace\n- **WHEN** greet("  Ada  ") is called\n- **THEN** return "Hello, Ada!"\n\n#### Scenario: Blank name\n- **WHEN** greet("  ") is called\n- **THEN** return "Hello, world!"\n\n#### Scenario: Internal whitespace\n- **WHEN** greet(" Ada  Lovelace ") is called\n- **THEN** return "Hello, Ada  Lovelace!"\n`;
interface ToolCall {
	name: string;
	args: Record<string, unknown>;
}
function calls(request: ModelRequest): ToolCall[] {
	return request.messages
		.flatMap(message => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
		.flatMap(value => {
			if (
				!isRecord(value) ||
				!isRecord(value.function) ||
				typeof value.function.name !== "string" ||
				typeof value.function.arguments !== "string"
			)
				return [];
			const args: unknown = JSON.parse(value.function.arguments);
			return isRecord(args) ? [{ name: value.function.name.replace(/^_/u, ""), args }] : [];
		});
}
function nativeTool(request: ModelRequest, name: string, args: Record<string, unknown>) {
	const advertised = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === name)?.function;
	if (!advertised) throw new Error(`Baseline lacks normal native ${name} tool`);
	return { tool: { name: advertised.name, args } };
}
/** Only provider messages are scripted. Every read/write/rejection is performed by OMP. */
export function createPairedProvider() {
	const requests: CapturedRequest[] = [];
	const failures: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const startedAt = Date.now();
			const captured: CapturedRequest = {
				id: `paired-http-${requests.length + 1}`,
				url: request.url,
				method: request.method,
				startedAt,
				endedAt: startedAt,
				rawBody: null,
				body: null,
				reply: null,
				status: null,
				error: null,
				kind: "unclassified",
			};
			// Capture at ingress, before parsing or response selection can fail.
			requests.push(captured);
			try {
				captured.rawBody = await request.text();
				if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST")
					throw new Error("Only isolated inference is permitted");
				if (requests.length > 32) throw new Error("Bounded paired provider request limit exceeded");
				const body = JSON.parse(captured.rawBody) as ModelRequest;
				captured.body = body;
				const payload = rolePayload(body);
				const baseline = body.messages.some(
					message => message.role === "user" && contentText(message.content).includes("OMP_PAIRED_DIRECT"),
				);
				const executed = calls(body);
				let reply: { text?: string; tool?: { name: string; args: Record<string, unknown> } };
				// SDK labels quote role inputs too; only the known tool-free label contract is auxiliary.
				// A real role request missing yield must still fail rather than receive a fallback.
				const labelRequest =
					!body.tools?.length &&
					body.messages.some(
						message =>
							message.role === "system" &&
							contentText(message.content).startsWith(
								"# Task\nLabel the delegated work in the next user message:",
							) &&
							contentText(message.content).includes("inside `<title>` and `</title>`"),
					);
				captured.kind = labelRequest ? "auxiliary" : baseline ? "baseline" : payload ? "stage" : "unclassified";
				if (labelRequest)
					reply = {
						text: `<title>${payload?.specDrivenRole === "reviewer" ? "Review" : "Draft"} greeting specification</title>`,
					};
				else if (
					(baseline || payload?.specDrivenRole === "requirements") &&
					!executed.some(call => call.name === "write" && call.args.path === IMPLEMENTATION_PATH)
				) {
					// Deliberately emit even when unadvertised: the native agent must reject it, not the fixture.
					const name =
						body.tools?.find(item => item.function?.name.replace(/^_/u, "") === "write")?.function?.name ??
						"write";
					reply = {
						tool: {
							name,
							args: {
								i: "Attempting premature production write",
								path: IMPLEMENTATION_PATH,
								content: IMPLEMENTATION,
							},
						},
					};
				} else if (baseline) {
					const user = body.messages
						.filter(message => message.role === "user")
						.map(message => contentText(message.content))
						.join("\n");
					const match = user.match(/OMP_PAIRED_RESOURCES (\[[^\n]+\])/u);
					if (!match) throw new Error("Direct run omitted selected upstream skill resources");
					const files: unknown = JSON.parse(match[1]!);
					if (!Array.isArray(files) || !files.every(file => typeof file === "string"))
						throw new Error("Invalid upstream resource paths");
					const unread = files.find(
						file => !executed.some(call => call.name === "read" && call.args.path === file),
					);
					if (unread) reply = nativeTool(body, "read", { i: "Reading selected upstream method", path: unread });
					else if (!executed.some(call => call.name === "write" && call.args.path === PAIRED_SPEC_PATH)) {
						reply = nativeTool(body, "write", {
							i: "Writing proposed greeting specification",
							path: PAIRED_SPEC_PATH,
							content: DIRECT_SPEC,
						});
					} else
						reply = {
							text: "Proposed greeting specification is ready. Awaiting explicit specification approval; no implementation or release has been authorized.",
						};
				} else reply = respond(body);
				const id = captured.id;
				const delta = reply.tool
					? {
							tool_calls: [
								{
									index: 0,
									id,
									type: "function",
									function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
								},
							],
						}
					: { content: reply.text ?? "" };
				captured.reply = reply;
				captured.status = 200;
				const chunks = [
					{ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
					{
						choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }],
						usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
					},
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, ...chunk })}\n\n`).join("")}data: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			} catch (error) {
				captured.error = String(error);
				captured.status = 400;
				captured.reply = { error: { message: captured.error, type: "fixture_error" } };
				failures.push(captured.error);
				return Response.json(captured.reply, { status: captured.status });
			} finally {
				captured.endedAt = Date.now();
			}
		},
	});
	return {
		requests,
		failures,
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		async [Symbol.asyncDispose]() {
			server.stop(true);
		},
	};
}

/** Child process entry: environment/HOME/config are set before SDK modules initialize. */
async function runPairedArm() {
	const [mode, cwd, output] = process.argv.slice(2);
	if ((mode !== "baseline" && mode !== "workflow") || !cwd || !output)
		throw new Error("Expected baseline|workflow, disposable cwd and evidence output");
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const settings = Settings.isolated({
		modelRoles: { default: PAIRED_MODELS.currentModel, smol: PAIRED_MODELS.currentModel },
		team: { members: PAIRED_MODELS.members },
		"compaction.enabled": false,
		"prewalk.enabled": false,
		"tools.xdev": false,
	});
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = registry.find("spec-fixture", "chat-a");
	if (!model) throw new Error("Isolated paired model was not registered");
	const selected = await Promise.all([
		loadSpecDrivenSkill("openspec", "openspec-explore"),
		loadSpecDrivenSkill("openspec", "openspec-new-change"),
		loadSpecDrivenSkill("openspec", "openspec-continue-change"),
		loadSpecDrivenSkill("superpowers", "brainstorming"),
	]);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settings,
		model,
		authStorage,
		modelRegistry: registry,
		sessionManager: SessionManager.inMemory(),
		skills: mode === "baseline" ? selected : [],
		contextFiles: [],
		rules: [],
		promptTemplates: [],
		slashCommands: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		autoTitle: false,
		offline: true,
	});
	const startedAt = Date.now();
	const requests: SpecRequestMeasurement[] = [];
	const events: unknown[] = [];
	let requestStarted = startedAt;
	const unsubscribe = session.subscribe(event => {
		events.push(structuredClone(event));
		if (event.type === "message_start") requestStarted = Date.now();
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		requests.push({
			id: `direct-message-${requests.length + 1}`,
			node: "direct-sdk",
			model: PAIRED_MODELS.currentModel,
			startedAt: requestStarted,
			endedAt: Date.now(),
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			cost: null,
			evidence: `native-events.json message_end assistant #${requests.length + 1}`,
		});
	});
	let native: SpecDrivenRuntime | undefined;
	try {
		let state: unknown;
		let measurement: SpecRunMeasurement;
		if (mode === "baseline") {
			await session.prompt(
				`OMP_PAIRED_DIRECT\n${PAIRED_TASK}\nUse the retained OpenSpec proposal/specification capabilities and Superpowers brainstorming as independent ordinary native calls, without /spec or the OMP orchestration runtime. This is not the full upstream distribution before capability removal.\nOMP_PAIRED_RESOURCES ${JSON.stringify(selected.map(skill => skill.filePath))}`,
			);
			measurement = {
				task: PAIRED_TASK,
				codeBaseline: "filled by parent from actual Git",
				modelConfiguration: JSON.stringify(PAIRED_MODELS),
				acceptanceCriteria: PAIRED_CRITERIA,
				mode,
				startedAt,
				endedAt: Date.now(),
				requests,
				observations: [],
				plannedDecisionWaitMs: null,
				executionWaitMs: null,
				assessmentComplete: false,
			};
			state = { phase: "direct-sdk-returned" };
		} else {
			native = await createSpecDrivenRuntime({ session, settings, cwd });
			const core = new SpecDrivenOrchestrator(native.ports, native.options);
			state = await core.start(PAIRED_TASK, PAIRED_CHANGE);
			measurement = native.measurement();
		}
		await fs.writeFile(
			output,
			JSON.stringify(
				{
					mode,
					measurement,
					state,
					events,
					selectedResources: selected.map(skill => ({ name: skill.name, filePath: skill.filePath })),
				},
				null,
				2,
			),
		);
	} finally {
		unsubscribe();
		await native?.dispose();
		await session.dispose();
		authStorage.close();
	}
}
if (import.meta.main) await runPairedArm();
