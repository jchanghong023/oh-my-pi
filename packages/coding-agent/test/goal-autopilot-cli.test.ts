import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { escapeXmlText, isRecord, prompt, readJsonl, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { renderOrchestrateNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { denyError, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import unattended from "../src/prompts/goals/goal-auto-orchestrate.md" with { type: "text" };
import titleForkPrompt from "../src/prompts/system/title-fork.md" with { type: "text" };

// Real public cli.ts RPC entries and final HTTP/loopback WebSocket Provider
// inputs. Only responses are scripted; usage is protocol data, not billing.
// TUI/PTY entry coverage is owned by the interactive-mode integration suite.
type Frame = Record<string, unknown>;
type Step = { text?: string; tool?: { name: string; args: object }; error?: number; hold?: boolean; tokens?: number };
const instruction = prompt
	.compile(unattended.trim())({ objective: "", orchestrateRules: "" })
	.trim()
	.split("\n")
	.slice(-4)
	.join("\n");
const objective = `GOAL_AUTO_OBJECTIVE_BEGIN\n${"详细目标 & <section>retain markup</section>\n".repeat(250)}GOAL_AUTO_OBJECTIVE_END`;
const titleRequest = prompt.render(titleForkPrompt, { card: false, nerdFonts: false });

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
}

function assertTaskCompleted(frame: Frame | undefined, provider: string): void {
	expect(frame?.isError).toBe(false);
	if (!frame || !isRecord(frame.result)) throw new Error("Missing task execution result");
	expect(contentText(frame.result.content)).toContain("AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE");
	const details = frame.result.details;
	if (!isRecord(details)) throw new Error("Missing task result details");
	const taskDetails = isRecord(details.xdev) ? details.xdev.inner : details;
	if (!isRecord(taskDetails) || !Array.isArray(taskDetails.results)) throw new Error("Missing settled child");
	expect(taskDetails.results).toHaveLength(1);
	const child = taskDetails.results[0];
	expect(child).toMatchObject({
		agent: "task",
		exitCode: 0,
		output: "AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE",
		resolvedModelIdentity: `${provider}/aux`,
	});
	if (!isRecord(child)) throw new Error("Missing child provenance");
	expect(child.error).toBeUndefined();
	expect(child.aborted).not.toBe(true);
	expect(child.resolvedModelIsFallback).not.toBe(true);
	expect(child.requests).toBeGreaterThan(0);
}

function messages(body: Frame): Frame[] {
	if (!Array.isArray(body.messages)) throw new Error("Provider request has no messages");
	return body.messages.filter(isRecord);
}

function featureBlocks(body: Frame): Frame[] {
	return messages(body).filter(message => contentText(message.content).includes(instruction));
}

function toolNames(body: Frame): string[] {
	if (!Array.isArray(body.tools)) return [];
	return body.tools.flatMap(tool =>
		isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : [],
	);
}

function assertActive(body: Frame, savedObjective = objective, count = 1, constructionTools = toolNames(body)): void {
	const blocks = featureBlocks(body);
	expect(blocks).toHaveLength(count);
	expect(blocks.at(-1)?.role).toBe("user");
	const text = contentText(blocks.at(-1)?.content);
	expect(text.split(savedObjective)).toHaveLength(2);
	expect(text.split(instruction)).toHaveLength(2);
	const rules = renderOrchestrateNotice({ tools: constructionTools }, { authority: "user" });
	if (constructionTools.includes("task")) expect(text).toContain(rules);
	else expect(text).not.toContain(rules);
	for (const message of messages(body).filter(message => message.role === "system" || message.role === "developer")) {
		expect(contentText(message.content)).not.toContain(instruction);
	}
}

function noticePositions(body: Frame): Array<{ index: number; message: Frame }> {
	return messages(body).flatMap((message, index) =>
		contentText(message.content).includes(instruction) ? [{ index, message }] : [],
	);
}

// Stopping changes future work/construction, never old persisted history.
function assertStopped(body: Frame, previous?: Frame): void {
	expect(noticePositions(body)).toEqual(previous ? noticePositions(previous) : []);
}

function assertAuxiliary(body: Frame, inherited: readonly Frame[]): void {
	const old = persistedNotices([...inherited]).map(message => contentText(message.content));
	const actual = featureBlocks(body).map(message => contentText(message.content));
	expect(actual.join("\n").split(instruction).length - 1).toBeLessThanOrEqual(old.length);
	for (const text of actual) expect(old.some(saved => text.includes(saved))).toBe(true);
}

function persistedNotices(values: unknown[]): Frame[] {
	return values.filter(isRecord).flatMap(value => {
		const message = isRecord(value.message) ? value.message : value;
		return (message.role === "custom" || message.type === "custom_message") &&
			contentText(message.content).includes(instruction)
			? [{ customType: message.customType, content: message.content }]
			: [];
	});
}

async function history(client: Client): Promise<Frame[]> {
	const response = await client.request({ type: "get_messages" });
	expect(response.success).toBe(true);
	if (!isRecord(response.data) || !Array.isArray(response.data.messages)) throw new Error("Missing messages");
	return response.data.messages.filter(isRecord);
}

async function entries(client: Client): Promise<Frame[]> {
	const response = await client.request({ type: "get_entries" });
	expect(response.success).toBe(true);
	if (!isRecord(response.data) || !Array.isArray(response.data.entries)) throw new Error("Missing entries");
	return response.data.entries.filter(isRecord);
}

async function assertPersisted(client: Client, expected: number, active = expected): Promise<Frame[]> {
	const current = await history(client);
	const notices = persistedNotices(current);
	expect(notices).toHaveLength(active);
	const canonical = await entries(client);
	const saved = persistedNotices(canonical);
	expect(saved).toHaveLength(expected);
	expect(saved.slice(-active)).toEqual(notices);
	const state = await client.state();
	if (typeof state.sessionFile !== "string") throw new Error("Missing session file");
	const durable: unknown[] = [];
	for await (const value of readJsonl<unknown>(Bun.file(state.sessionFile).stream())) durable.push(value);
	expect(persistedNotices(durable)).toEqual(saved);
	const noticeEntry = (entry: Frame) =>
		entry.type === "custom_message" && contentText(entry.content).includes(instruction);
	const durableEntries = durable.filter(isRecord);
	expect(durableEntries.filter(noticeEntry)).toEqual(canonical.filter(noticeEntry));
	if (expected === 1) {
		// The initial notice is durably before the first response, never moved
		// beside the latest user/tool result to recover a request-only view.
		for (const list of [canonical, durableEntries]) {
			const responseIndex = list.findIndex(entry => isRecord(entry.message) && entry.message.role === "assistant");
			if (responseIndex >= 0) expect(list.findIndex(noticeEntry)).toBeLessThan(responseIndex);
		}
	}
	return current;
}

async function assertPublicDump(client: Client, outputPath: string): Promise<void> {
	const response = await client.request({ type: "export_html", outputPath });
	expect(response).toMatchObject({ success: true, data: { path: outputPath } });
	const html = await Bun.file(outputPath).text();
	const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
	if (!encoded) throw new Error("Public export omitted session data");
	const exported: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	if (!isRecord(exported) || !Array.isArray(exported.entries)) throw new Error("Public export omitted entries");
	expect(exported.entries).toEqual(await entries(client));
	expect(persistedNotices(exported.entries)).toHaveLength(1);
}

function responseItems(body: Frame): Frame[] {
	if (!Array.isArray(body.input)) throw new Error("Codex request has no Responses input");
	return body.input.filter(isRecord);
}

function assertCodexActive(body: Frame, constructionTools = codexToolNames(body), count = 1): void {
	const items = responseItems(body);
	const blocks = items.filter(item => contentText(item.content).includes(instruction));
	expect(blocks).toHaveLength(count);
	expect(blocks.at(-1)?.role).toBe("user");
	const text = contentText(blocks.at(-1)?.content);
	expect(text.split(objective)).toHaveLength(2);
	expect(text.split(instruction)).toHaveLength(2);
	for (const item of items.filter(item => item.role === "system" || item.role === "developer")) {
		expect(contentText(item.content)).not.toContain(instruction);
	}
	expect(contentText(body.instructions)).not.toContain(instruction);

	const rules = renderOrchestrateNotice({ tools: constructionTools }, { authority: "user" });
	expect(contentText(body.instructions)).not.toContain(rules);
	if (constructionTools.includes("task")) {
		expect(text.split(rules)).toHaveLength(2);
		expect(
			items
				.map(item => contentText(item.content))
				.join("\n")
				.split(rules),
		).toHaveLength(2);
	} else {
		expect(codexToolNames(body)).not.toContain("task");
		expect(text).not.toContain(rules);
		expect(text).not.toContain(rules.split("\n")[0]!);
	}
}

function codexToolNames(body: Frame): string[] {
	if (!Array.isArray(body.tools)) throw new Error("Codex request has no tools");
	return body.tools.flatMap(tool => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []));
}

function codexEvents(step: Step, serial: number): Frame[] {
	const id = `resp_goal_${serial}`;
	const item = step.tool
		? {
				type: "function_call",
				id: `fc_goal_${serial}`,
				call_id: `call_goal_${serial}`,
				name: step.tool.name,
				arguments: JSON.stringify(step.tool.args),
				status: "completed",
			}
		: {
				type: "message",
				id: `msg_goal_${serial}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: step.text ?? "FIXTURE_RESULT" }],
			};
	return [
		{ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: step.tool
				? { ...item, status: "in_progress", arguments: "" }
				: { ...item, status: "in_progress", content: [] },
		},
		...(step.tool
			? [
					{
						type: "response.function_call_arguments.delta",
						item_id: item.id,
						output_index: 0,
						delta: JSON.stringify(step.tool.args),
					},
					{
						type: "response.function_call_arguments.done",
						item_id: item.id,
						output_index: 0,
						arguments: JSON.stringify(step.tool.args),
					},
				]
			: [
					{
						type: "response.content_part.added",
						item_id: item.id,
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: "" },
					},
					{
						type: "response.output_text.delta",
						item_id: item.id,
						output_index: 0,
						content_index: 0,
						delta: step.text ?? "FIXTURE_RESULT",
					},
				]),
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id,
				object: "response",
				status: "completed",
				output: [item],
				usage: {
					input_tokens: 20,
					output_tokens: 10,
					total_tokens: 30,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
}

function codexSse(step: Step, serial: number): Response {
	return new Response(
		`${codexEvents(step, serial)
			.map(event => `data: ${JSON.stringify(event)}\n\n`)
			.join("")}`,
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}

interface Client {
	readonly seen: Frame[];
	send(frame: object): void;
	next(predicate: (frame: Frame) => boolean): Promise<Frame>;
	request(frame: { type: string; [key: string]: unknown }): Promise<Frame>;
	prompt(message: string): Promise<void>;
	state(): Promise<Frame>;
	close(): Promise<void>;
}

interface Fixture {
	cwd: string;
	evidencePaths: string[];
	requests: Frame[];
	steps: Step[];
	wsFrames: Frame[];
	wsInputs: Frame[];
	wsOutputs: Frame[][];
	wsErrors: string[];
	httpFallbacks: Frame[];
	httpCalls: Map<Frame, Frame>;
	start(mode?: "rpc" | "rpc-ui", session?: string): Promise<Client>;
	mainSince(index: number): Frame[];
	waitForMain(count: number): Promise<void>;
}

async function withFixture(
	run: (fixture: Fixture) => Promise<void>,
	options: {
		continuation?: boolean;
		magic?: boolean;
		task?: boolean;
		advisor?: boolean;
		codex?: boolean;
		websocket?: boolean;
		retry?: boolean;
		fixtureSkill?: boolean;
	} = {},
): Promise<void> {
	await using root = await TempDir.create("@goal-auto-cli-");
	const cwd = path.resolve(root.join("project"));
	const agentDir = path.resolve(root.join("agent"));
	const sessionDir = path.resolve(root.join("sessions"));
	const home = path.resolve(root.join("home"));
	const configRoot = path.resolve(root.join("config"));
	await Promise.all([cwd, agentDir, sessionDir, home, configRoot].map(dir => fs.mkdir(dir, { recursive: true })));
	await Bun.write(path.join(cwd, "evidence.txt"), "TOOL_ROUNDTRIP_EVIDENCE\n");
	const evidencePaths = Array.from({ length: 10 }, (_, round) => path.join(cwd, `evidence-round-${round + 1}.txt`));
	await Promise.all(
		evidencePaths.map((file, round) => Bun.write(file, `TOOL_ROUNDTRIP_EVIDENCE\nROUND_${round + 1}\n`)),
	);
	if (options.fixtureSkill !== false) {
		await Bun.write(
			path.join(cwd, ".omp", "skills", "goal-auto-fixture", "SKILL.md"),
			"---\nname: goal-auto-fixture\ndescription: Goal auto acceptance fixture.\n---\nSKILL_EXPANSION_EVIDENCE. Preserve the user's supplied scope.\n",
		);
	}
	const provider = options.codex ? "openai-codex" : "goal-recording";
	const requestMessages = options.codex ? responseItems : messages;
	const requests: Frame[] = [];
	const steps: Step[] = [];
	const wsFrames: Frame[] = [];
	const wsInputs: Frame[] = [];
	const wsOutputs: Frame[][] = [];
	const wsErrors: string[] = [];
	const httpFallbacks: Frame[] = [];
	const httpCalls = new Map<Frame, Frame>();
	const completed = new Map<string, { input: Frame[]; output: Frame[] }>();
	const releases: Array<() => void> = [];
	const requestWaiters = new Set<() => void>();
	let serial = 0;
	const modelServer = Bun.serve<{ latest?: string }>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, server) {
			if (options.websocket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				if (!new URL(request.url).pathname.endsWith("/codex/responses"))
					return new Response("Wrong WebSocket endpoint", { status: 404 });
				if (server.upgrade(request, { data: { latest: undefined as string | undefined } })) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}
			if (new URL(request.url).pathname.endsWith("/models")) {
				return Response.json({
					object: "list",
					data: ["main", "aux"].map(id => ({ id, object: "model", owned_by: "goal-recording" })),
				});
			}
			const endpoint = options.codex ? "/codex/responses" : "/chat/completions";
			if (!new URL(request.url).pathname.endsWith(endpoint)) return new Response("not found", { status: 404 });
			const body: unknown = await request.json();
			if (!isRecord(body)) return new Response("invalid request", { status: 400 });
			if (options.websocket) {
				httpFallbacks.push(body);
				console.error(
					"GOAL_WS_HTTP_FALLBACK_JSON",
					JSON.stringify({
						url: request.url,
						method: request.method,
						model: body.model,
						body,
						wsFrameCount: wsFrames.length,
						wsInputCount: wsInputs.length,
						wsOutputCount: wsOutputs.length,
						wsFrames,
						wsOutputs,
					}),
				);
				return new Response("SSE fallback forbidden by this acceptance fixture", { status: 500 });
			}
			requests.push(body);
			for (const resolve of requestWaiters) resolve();
			requestWaiters.clear();
			const title = requestMessages(body).some(message => contentText(message.content).includes("<title-request>"));
			const step = title
				? { text: "Goal fixture title" }
				: body.model === "main"
					? (steps.shift() ?? {})
					: { text: "AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE" };
			if (step.error)
				return Response.json(
					{ error: { message: "fixture temporary overload", type: "server_error" } },
					{ status: step.error },
				);
			if (step.hold) {
				const held = Promise.withResolvers<void>();
				releases.push(held.resolve);
				if (request.signal.aborted) held.resolve();
				else request.signal.addEventListener("abort", () => held.resolve(), { once: true });
				await held.promise;
			}
			if (options.codex) return codexSse(step, ++serial);
			const id = `chatcmpl-goal-${++serial}`;
			const base = { id, object: "chat.completion.chunk", created: 0, model: body.model };
			const text = step.text ?? "FIXTURE_RESULT";
			const call = step.tool
				? {
						id: `call-${serial}`,
						type: "function",
						function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) },
					}
				: undefined;
			if (call) httpCalls.set(body, call);
			const usage = {
				prompt_tokens: step.tokens ?? 20,
				completion_tokens: 10,
				total_tokens: (step.tokens ?? 20) + 10,
			};
			if (!body.stream)
				return Response.json({
					...base,
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: call ? null : text,
								...(call ? { tool_calls: [call] } : {}),
							},
							finish_reason: call ? "tool_calls" : "stop",
						},
					],
					usage,
				});
			const chunks = [
				{
					...base,
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								...(call ? { tool_calls: [{ index: 0, ...call }] } : { content: text }),
							},
							finish_reason: null,
						},
					],
				},
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
				{ ...base, choices: [], usage },
			];
			return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
		websocket: {
			message(socket: ServerWebSocket<{ latest?: string }>, raw) {
				try {
					const parsed: unknown = JSON.parse(String(raw));
					if (!isRecord(parsed) || parsed.type !== "response.create") throw new Error("Expected response.create");
					wsFrames.push(parsed);
					const delta = responseItems(parsed);
					let input = delta;
					if (socket.data.latest) {
						if (parsed.previous_response_id !== socket.data.latest)
							throw new Error(
								`Missing, wrong or stale previous_response_id; full-prefix replay is forbidden: ${JSON.stringify(
									{
										actual: parsed.previous_response_id,
										expected: socket.data.latest,
										delta,
									},
								)}`,
							);
						const previous = completed.get(socket.data.latest);
						if (!previous) throw new Error("Previous response was not completed");
						// A tool continuation appends only the actual function result,
						// not a freshly assembled notice or replayed historical items.
						if (delta.length !== 1 || delta[0]?.type !== "function_call_output")
							throw new Error(
								`Prefix mutation: continuation must contain one delta function_call_output: ${JSON.stringify({
									previous_response_id: parsed.previous_response_id,
									delta,
									completedOutput: previous.output,
								})}`,
							);
						const call = previous.output.find(item => item.type === "function_call");
						if (!call || delta[0]?.call_id !== call.call_id)
							throw new Error(
								`Wrong tool-result call_id: ${JSON.stringify({
									delta,
									completedOutput: previous.output,
								})}`,
							);
						input = [...previous.input, ...previous.output, ...delta];
					} else if (parsed.previous_response_id !== undefined) {
						throw new Error("First inference cannot use a previous response");
					}
					const body: Frame = { ...parsed, input };
					wsInputs.push(body);
					requests.push(body);
					for (const resolve of requestWaiters) resolve();
					requestWaiters.clear();
					if (body.model !== "main") throw new Error("Dedicated protocol fixture permits only main requests");
					const events = codexEvents(steps.shift() ?? {}, ++serial);
					const terminal = events.at(-1)?.response;
					if (!isRecord(terminal) || typeof terminal.id !== "string" || !Array.isArray(terminal.output))
						throw new Error("Invalid scripted completed response");
					const output = terminal.output.filter(isRecord);
					completed.set(terminal.id, { input, output });
					socket.data.latest = terminal.id;
					wsOutputs.push(output);
					for (const event of events) socket.send(JSON.stringify(event));
				} catch (error) {
					wsErrors.push(String(error));
					// Plain JSON strings bypass Bun's truncated assertion-object
					// rendering and remain inspectable in the parent's log artifact.
					console.error(
						"GOAL_WS_PROTOCOL_FAILURE_JSON",
						JSON.stringify({
							error: String(error),
							latest: socket.data.latest,
							frames: wsFrames,
							outputs: wsOutputs,
						}),
					);
					socket.send(
						JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(error) } }),
					);
					socket.close(1008, "Acceptance protocol violation");
				}
			},
		},
	});
	await Bun.write(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			`  ${provider}:`,
			`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
			...(options.codex
				? [
						`    apiKey: aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "goal-fixture" } })).toBase64()}.bbb`,
						"    api: openai-codex-responses",
					]
				: ["    auth: none", "    api: openai-completions"]),
			"    models:",
			...["main", "aux"].flatMap(id => [
				`      - id: ${id}`,
				`        name: ${id}`,
				"        reasoning: false",
				"        contextWindow: 32768",
				"        maxTokens: 4096",
				...(id === "main" ? [`        compactionModel: ${provider}/aux`] : []),
			]),
			"",
		].join("\n"),
	);
	// Pin every auxiliary role used by the real child and its label requests.
	// Device dispatch consults its own approval before approval.write; allowing
	// read/task devices must not lift the separate filesystem-write denial.
	await Bun.write(
		path.join(agentDir, "config.yml"),
		[
			"modelRoles:",
			`  task: [${provider}/aux]`,
			`  smol: [${provider}/aux]`,
			`  tiny: [${provider}/aux]`,
			`  commit: [${provider}/aux]`,
			`  advisor: [${provider}/aux]`,
			"goal:",
			`  continuationModes: ${options.continuation ? "[rpc]" : "[]"}`,
			"magicKeywords:",
			`  enabled: ${options.magic ?? true}`,
			`  orchestrate: ${options.magic ?? true}`,
			"advisor:",
			`  enabled: ${options.advisor ?? false}`,
			"  syncBacklog: strict",
			"  reviewMode: agent-end",
			"compaction:",
			"  enabled: false",
			"  keepRecentTokens: 1",
			"  remoteStreamingV2Enabled: false",
			"retry:",
			`  enabled: ${options.retry ?? true}`,
			"  maxRetries: 2",
			"  baseDelayMs: 1",
			"  maxDelayMs: 5",
			"  modelFallback: false",
			"task:",
			"  batch: true",
			"  structured: false",
			"  isolation:",
			"    enabled: false",
			"  prewalk: false",
			"async:",
			"  enabled: false",
			"tools:",
			"  approval:",
			"    write: deny",
			"    read: allow",
			"    task: allow",
			"skills:",
			"  enableCodexUser: false",
			"  enableClaudeUser: false",
			"  enableClaudeProject: false",
			"  enablePiUser: false",
			"  enablePiProject: true",
			"  enableAgentsUser: false",
			"  enableAgentsProject: false",
			"",
		].join("\n"),
	);
	// The fixture uses the public extension API solely to change the actual
	// enabled tools between requests. It does not transform model context.
	const extension = path.join(agentDir, "fixture.ts");
	await Bun.write(
		extension,
		`export default function(pi) {
		pi.registerCommand("fixture-tools", { description: "Acceptance tool visibility", handler: async args => { await pi.setActiveTools(args.split(",").filter(Boolean)); } });
		pi.registerCommand("fixture-reload", { description: "Acceptance public reload", handler: async (_args, ctx) => { await ctx.reload(); } });
		pi.registerCommand("fixture-title", { description: "Acceptance real title fork side request", handler: async (_args, ctx) => {
			if (!ctx.runEphemeralTurn) throw new Error("Public ephemeral turn API unavailable");
			await ctx.runEphemeralTurn({ promptText: ${JSON.stringify(titleRequest)} });
		} });
	}`,
	);
	const clients: Client[] = [];
	const fixture: Fixture = {
		cwd,
		evidencePaths,
		requests,
		steps,
		wsFrames,
		wsInputs,
		wsOutputs,
		wsErrors,
		httpFallbacks,
		httpCalls,
		mainSince: index =>
			requests
				.slice(index)
				.filter(
					body =>
						body.model === "main" &&
						!requestMessages(body).some(message => contentText(message.content).includes("<title-request>")),
				),
		async waitForMain(count) {
			while (fixture.mainSince(0).length < count) {
				const changed = Promise.withResolvers<void>();
				requestWaiters.add(changed.resolve);
				try {
					await withTimeout(changed.promise, 30_000, `Expected ${count} main HTTP requests`);
				} finally {
					requestWaiters.delete(changed.resolve);
				}
			}
		},
		async start(mode = "rpc-ui", session) {
			const startupStart = requests.length;
			const child = Bun.spawn(
				[
					"bun",
					path.join(import.meta.dir, "..", "src", "cli.ts"),
					"--mode",
					mode,
					"--no-ui",
					"--no-rules",
					"--no-extensions",
					"--trusted-extension",
					extension,
					"--tools",
					options.task === false ? "read,write" : "read,write,task",
					"--session-dir",
					sessionDir,
					"--provider",
					provider,
					"--model",
					"main",
					"--thinking",
					"off",
					...(session ? ["--session", session] : []),
				],
				{
					cwd,
					env: {
						...Bun.env,
						HOME: home,
						USERPROFILE: home,
						OMP_CONFIG_ROOT: configRoot,
						PI_CONFIG_DIR: ".omp",
						OMP_PROFILE: undefined,
						PI_PROFILE: undefined,
						PI_CODING_AGENT_DIR: agentDir,
						PI_NO_TITLE: "1",
						OMP_OFFLINE: "1",
						OMP_JCHTOOLS_DISCOVERY: "0",
						...(options.codex
							? {
									PI_CODEX_WEBSOCKET: options.websocket ? "1" : "0",
									PI_CODEX_ZSTD: "0",
									PI_PROXY: undefined,
									PI_PROXY_OPENAI_CODEX: undefined,
									HTTP_PROXY: undefined,
									http_proxy: undefined,
									HTTPS_PROXY: undefined,
									https_proxy: undefined,
									ALL_PROXY: undefined,
									all_proxy: undefined,
									NO_PROXY: "127.0.0.1,localhost",
									no_proxy: "127.0.0.1,localhost",
								}
							: {}),
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stderr = new Response(child.stderr).text();
			const seen: Frame[] = [];
			const queue: Frame[] = [];
			let done = false;
			let readerError: unknown;
			const frameWaiters = new Set<() => void>();
			const pump = (async () => {
				try {
					for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
						if (!isRecord(frame)) continue;
						seen.push(frame);
						queue.push(frame);
						for (const resolve of frameWaiters) resolve();
						frameWaiters.clear();
					}
				} catch (error) {
					readerError = error;
				} finally {
					done = true;
					for (const resolve of frameWaiters) resolve();
					frameWaiters.clear();
				}
			})();
			let requestId = 0;
			let closed = false;
			const client: Client = {
				seen,
				send: frame => {
					child.stdin.write(`${JSON.stringify(frame)}\n`);
				},
				async next(predicate) {
					for (;;) {
						const index = queue.findIndex(predicate);
						if (index >= 0) return queue.splice(index, 1)[0]!;
						if (done) throw readerError ?? new Error(`RPC stream ended: ${await stderr}`);
						const changed = Promise.withResolvers<void>();
						frameWaiters.add(changed.resolve);
						try {
							await withTimeout(
								changed.promise,
								120_000,
								`Missing RPC frame; observed: ${JSON.stringify(seen.slice(-8))}`,
							);
						} finally {
							frameWaiters.delete(changed.resolve);
						}
					}
				},
				async request(frame) {
					const id = String(frame.id ?? `request-${++requestId}`);
					client.send({ ...frame, id });
					return await client.next(response => response.type === "response" && response.id === id);
				},
				async prompt(message) {
					const id = `prompt-${++requestId}`;
					expect(await client.request({ id, type: "prompt", message })).toMatchObject({ success: true });
					expect(await client.next(frame => frame.type === "prompt_result" && frame.id === id)).toMatchObject({
						status: "completed",
					});
					// get_state waits for queued goal reconciliation and exit work.
					await client.state();
				},
				async state() {
					const response = await client.request({ type: "get_state" });
					expect(response.success).toBe(true);
					if (!isRecord(response.data)) throw new Error("Missing session state");
					return response.data;
				},
				async close() {
					if (closed) return;
					closed = true;
					for (const release of releases.splice(0)) release();
					child.stdin.end();
					try {
						await withTimeout(child.exited, 15_000, "RPC child did not exit after EOF");
					} catch {
						child.kill();
						await child.exited;
					}
					await pump.catch(() => {});
				},
			};
			clients.push(client);
			await client.next(frame => frame.type === "ready");
			expect(await client.request({ type: "negotiate_protocol", protocolVersion: 3 })).toMatchObject({
				success: true,
				data: { protocolVersion: 3 },
			});
			const startupRequests = requests.slice(startupStart);
			expect(startupRequests.every(body => body.model === "aux")).toBe(true);
			const inherited = session
				? persistedNotices(
						(await Bun.file(session).text())
							.trim()
							.split("\n")
							.map(line => JSON.parse(line)),
					).map(message => contentText(message.content))
				: [];
			startupRequests.forEach(body => {
				const actual = requestMessages(body).filter(item => contentText(item.content).includes(instruction));
				expect(actual.length).toBeLessThanOrEqual(inherited.length);
				for (const item of actual) expect(inherited).toContain(contentText(item.content));
			});
			return client;
		},
	};
	try {
		await run(fixture);
	} finally {
		for (const client of clients) await client.close();
		for (const release of releases.splice(0)) release();
		modelServer.stop(true);
	}
}

function goal(state: Frame): Frame | null {
	return isRecord(state.goal) ? state.goal : null;
}

async function local(client: Client, message: string): Promise<void> {
	const starts = client.seen.filter(frame => frame.type === "agent_start").length;
	expect(await client.request({ type: "prompt", message })).toMatchObject({ success: true });
	await client.state();
	expect(client.seen.filter(frame => frame.type === "agent_start")).toHaveLength(starts);
}

describe("goal-autopilot public CLI Provider acceptance", () => {
	for (const mode of ["rpc", "rpc-ui"] as const) {
		test(`${mode} catalogs/completes the command and reuses management/errors without forced continuation`, async () => {
			await withFixture(
				async fixture => {
					const client = await fixture.start(mode);
					const catalog = await client.request({ type: "get_available_commands" });
					if (!isRecord(catalog.data) || !Array.isArray(catalog.data.commands))
						throw new Error("Missing command catalog");
					const entry = catalog.data.commands.find(
						command => isRecord(command) && command.name === "goal-autopilot",
					);
					expect(entry).toMatchObject({ name: "goal-autopilot" });
					expect(
						catalog.data.commands.some(command => isRecord(command) && command.name === "goal-auto-orchestrate"),
					).toBe(false);
					if (!isRecord(entry) || !Array.isArray(entry.subcommands)) throw new Error("Missing goal subcommands");
					expect(entry.subcommands.map(sub => (isRecord(sub) ? sub.name : undefined))).toEqual(
						expect.arrayContaining(["set", "show", "pause", "resume", "drop", "budget"]),
					);
					for (const text of ["/goal-autopilot", "/goal-autopilot pa"]) {
						const completion = await client.request({ type: "complete_command", text, cursor: text.length });
						expect(completion.success).toBe(true);
						if (!isRecord(completion.data) || !Array.isArray(completion.data.items))
							throw new Error("Missing completion");
						expect(completion.data.items).toContainEqual(
							expect.objectContaining({ label: text.endsWith(" pa") ? "pause" : "goal-autopilot" }),
						);
					}
					await local(client, "/goal-autopilot show");
					expect(fixture.mainSince(0)).toHaveLength(0);
					fixture.requests.forEach(body => assertStopped(body));
					expect(
						await client.request({ type: "prompt", message: "/goal-autopilot budget invalid" }),
					).toMatchObject({ success: false });
					await client.prompt(`/goal-autopilot ${objective}`);
					expect(fixture.mainSince(0)).toHaveLength(1);
					assertActive(fixture.mainSince(0)[0]!);
					expect(goal(await client.state())).toMatchObject({
						autoOrchestrate: true,
						goal: { objective, status: "active" },
					});
					for (const command of [
						"/goal budget 100000",
						"/goal-autopilot budget off",
						"/goal show",
						"/goal-autopilot show",
					]) {
						await local(client, command);
						expect(goal(await client.state())?.autoOrchestrate).toBe(true);
					}
					const before = await client.state();
					expect(await client.request({ type: "prompt", message: "/goal-autopilot budget 0" })).toMatchObject({
						success: false,
					});
					expect(goal(await client.state())).toEqual(goal(before));
					await local(client, "/goal pause");
					expect(goal(await client.state())).toMatchObject({
						autoOrchestrate: true,
						enabled: false,
						goal: { status: "paused" },
					});
					let start = fixture.requests.length;
					await client.prompt("Later user says: inspect only; do not edit anything.");
					fixture.mainSince(start).forEach(body => assertStopped(body, fixture.mainSince(0)[0]!));
					await local(client, "/goal-autopilot resume");
					start = fixture.requests.length;
					await client.prompt("Continue with read-only scope from my last instruction.");
					fixture.mainSince(start).forEach(body => assertActive(body));
					expect(
						messages(fixture.mainSince(start)[0]!).some(message =>
							contentText(message.content).includes("inspect only; do not edit anything"),
						),
					).toBe(true);
					await client.prompt("/goal set Ordinary replacement");
					expect(goal(await client.state())?.autoOrchestrate).not.toBe(true);
					assertStopped(fixture.mainSince(0).at(-1)!, fixture.mainSince(0)[0]!);
					await local(client, "/goal-autopilot pause");
					await local(client, "/goal-autopilot resume");
					expect(goal(await client.state())?.autoOrchestrate).not.toBe(true);
					await client.prompt(`/goal-autopilot set ${objective}`);
					expect(goal(await client.state())?.autoOrchestrate).toBe(true);
					assertActive(fixture.mainSince(0).at(-1)!, objective, 2);
					await assertPersisted(client, 2);
				},
				{ magic: false },
			);
		}, 300_000);
	}

	test("explicit mode starts without task or magic keywords and retains objective plus unattended instructions", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start();
				await client.prompt(`/goal-autopilot ${objective}`);
				expect(fixture.mainSince(0)).toHaveLength(1);
				const body = fixture.mainSince(0)[0]!;
				expect(toolNames(body)).not.toContain("task");
				assertActive(body);
				expect(goal(await client.state())?.autoOrchestrate).toBe(true);
			},
			{ task: false, magic: false },
		);
	}, 300_000);

	test("Codex HTTP preserves callable task notice across capability changes until successful public compaction", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start("rpc");
				fixture.steps.push(
					{
						tool: {
							name: "read",
							args: { path: path.join(fixture.cwd, "evidence.txt") },
						},
					},
					{
						tool: {
							name: "write",
							args: {
								path: "xd://task",
								content: JSON.stringify({
									context: "A separately scoped read-only capability fixture.",
									tasks: [
										{
											task: "Return the fixed fixture status. Do not modify any files.",
											solutionSpace: "one fixed response",
										},
									],
								}),
							},
						},
					},
					{ text: "CAPABILITY_ROUNDTRIPS_COMPLETE" },
				);
				await client.prompt(`/goal-autopilot ${objective}`);
				const first = fixture.mainSince(0);
				expect(first).toHaveLength(3);
				first.forEach(body => assertCodexActive(body));
				expect(codexToolNames(first[0]!)).toContain("task");
				expect(codexToolNames(first[0]!)).toContain("write");
				expect(
					responseItems(first[1]!).some(
						item =>
							item.type === "function_call_output" &&
							contentText(item.output).includes("TOOL_ROUNDTRIP_EVIDENCE"),
					),
				).toBe(true);
				expect(
					responseItems(first[2]!).some(
						item =>
							item.type === "function_call_output" &&
							contentText(item.output).includes("AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE"),
					),
				).toBe(true);
				for (const toolName of ["read", "write"]) {
					const results = client.seen.filter(
						frame => frame.type === "tool_execution_end" && frame.toolName === toolName,
					);
					expect(results).toHaveLength(1);
					expect(results[0]?.isError).toBe(false);
				}
				assertTaskCompleted(
					client.seen.find(frame => frame.type === "tool_execution_end" && frame.toolName === "write"),
					"openai-codex",
				);
				const childRequests = fixture.requests.filter(
					body =>
						body.model === "aux" &&
						responseItems(body).some(item =>
							contentText(item.content).includes("A separately scoped read-only capability fixture."),
						),
				);
				expect(childRequests).toHaveLength(1);
				expect(codexToolNames(childRequests[0]!)).toContain("read");
				expect(responseItems(childRequests[0]!).some(item => contentText(item.content).includes(instruction))).toBe(
					false,
				);
				const saved = goal(await client.state());
				if (!saved || !isRecord(saved.goal)) throw new Error("Missing live goal");
				const savedId = saved.goal.id;
				expect(typeof savedId).toBe("string");
				expect(saved).toMatchObject({
					autoOrchestrate: true,
					enabled: true,
					goal: { objective, status: "active" },
				});

				let constructionCount = 1;
				let previous = first.at(-1)!;
				for (const taskEnabled of [false, true]) {
					await local(client, `/fixture-tools read,write,goal${taskEnabled ? ",task" : ""}`);
					const start = fixture.requests.length;
					const seenStart = client.seen.length;
					const auxiliaryStart = fixture.requests.filter(body => body.model === "aux").length;
					fixture.steps.push(
						{
							tool: {
								name: "write",
								args: {
									path: "xd://task",
									content: JSON.stringify({
										context: "Check the current enabled task capability without changing files.",
										tasks: [
											{
												task: "Return the fixed fixture status. Do not modify any files.",
												solutionSpace: "one fixed response",
											},
										],
									}),
								},
							},
						},
						{ text: "CAPABILITY_CHANGE_COMPLETE" },
					);
					await client.prompt("Preserve the current objective and read-only scope.");
					const bodies = fixture.mainSince(start);
					expect(bodies).toHaveLength(2);
					for (const body of bodies) {
						expect(codexToolNames(body).includes("task")).toBe(taskEnabled);
						expect(responseItems(body).filter(item => contentText(item.content).includes(instruction))).toEqual(
							responseItems(previous).filter(item => contentText(item.content).includes(instruction)),
						);
					}
					const results = client.seen
						.slice(seenStart)
						.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "write");
					expect(results).toHaveLength(1);
					expect(results[0]?.isError).toBe(!taskEnabled);
					const auxiliaryCount = fixture.requests.filter(body => body.model === "aux").length - auxiliaryStart;
					if (taskEnabled) {
						expect(auxiliaryCount).toBeGreaterThan(0);
						assertTaskCompleted(results[0], "openai-codex");
						const children = fixture.requests
							.slice(start)
							.filter(
								body =>
									body.model === "aux" &&
									responseItems(body).some(item =>
										contentText(item.content).includes(
											"Check the current enabled task capability without changing files.",
										),
									),
							);
						expect(children).toHaveLength(1);
						expect(codexToolNames(children[0]!)).toContain("read");
					} else {
						expect(auxiliaryCount).toBe(0);
					}
					await assertPersisted(client, constructionCount, 1);
					const compact = await client.request({
						type: "compact",
						customInstructions: "Return only AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE; omit goal and strategy.",
					});
					expect(compact.success).toBe(true);
					const restored = await assertPersisted(client, ++constructionCount, 1);
					expect(contentText(persistedNotices(restored)[0]?.content)).toContain(objective);
					const after = fixture.requests.length;
					await client.prompt("Use the persisted post-compaction capability snapshot.");
					const resumed = fixture.mainSince(after);
					expect(resumed).toHaveLength(1);
					assertCodexActive(resumed[0]!);
					previous = resumed[0]!;
					const current = goal(await client.state());
					expect(current).toMatchObject({
						autoOrchestrate: true,
						enabled: true,
						goal: { id: savedId, objective, status: "active" },
					});
				}
				await assertPersisted(client, 3, 1);
			},
			{ codex: true, magic: false },
		);
	}, 300_000);

	test("HTTP ten actual read rounds keep one persisted initial notice and strict Provider history prefixes", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start("rpc");
				const calls = fixture.evidencePaths.map(file => ({ path: file }));
				fixture.steps.push(...calls.map(args => ({ tool: { name: "read", args } })), {
					text: "TEN_READ_ROUNDS_COMPLETE",
				});
				await client.prompt(`/goal-autopilot ${objective}`);
				const bodies = fixture.mainSince(0);
				expect(bodies).toHaveLength(11);
				for (const body of bodies) {
					assertActive(body);
					assertStopped(body, bodies[0]!);
				}
				for (let round = 1; round < bodies.length; round++) {
					const before = messages(bodies[round - 1]!);
					const after = messages(bodies[round]!);
					expect(after.slice(0, before.length)).toEqual(before);
					const call = fixture.httpCalls.get(bodies[round - 1]!);
					if (!call) throw new Error("Missing recorded successful HTTP tool-call response");
					expect(call).toMatchObject({
						type: "function",
						function: { name: "read", arguments: JSON.stringify(calls[round - 1]) },
					});
					expect(after[before.length]).toMatchObject({
						role: "assistant",
						tool_calls: [call],
					});
					expect(after[before.length + 1]).toMatchObject({ role: "tool", tool_call_id: call.id });
					expect(contentText(after[before.length + 1]?.content)).toContain("TOOL_ROUNDTRIP_EVIDENCE");
					expect(contentText(after[before.length + 1]?.content)).toContain(`ROUND_${round}`);
					expect(after).toHaveLength(before.length + 2);
					expect(bodies[round]?.tools).toEqual(bodies[0]?.tools);
				}
				const results = client.seen.filter(
					frame => frame.type === "tool_execution_end" && frame.toolName === "read",
				);
				expect(results).toHaveLength(10);
				for (const result of results) expect(result.isError).toBe(false);
				const saved = await assertPersisted(client, 1);
				const normalGoal = saved.find(message => message.customType === "goal-mode-context");
				expect(normalGoal).toMatchObject({ role: "custom", attribution: "agent" });
				expect(
					messages(bodies[0]!).filter(
						message => contentText(message.content) === contentText(normalGoal?.content),
					),
				).toHaveLength(1);
				const assistant = saved.filter(message => message.role === "assistant");
				expect(assistant).toHaveLength(11);
				expect(assistant.every(message => message.stopReason !== "error" && message.stopReason !== "aborted")).toBe(
					true,
				);
				expect(contentText(assistant.at(-1)?.content)).toContain("TEN_READ_ROUNDS_COMPLETE");
				const notice = persistedNotices(saved)[0]!;
				expect(contentText(featureBlocks(bodies[0]!)[0]?.content)).toContain(contentText(notice.content));
				expect(contentText(featureBlocks(bodies[0]!)[0]?.content).split(contentText(notice.content))).toHaveLength(
					2,
				);
				const noticeIndex = saved.findIndex(message => message.customType === notice.customType);
				expect(noticeIndex).toBeGreaterThanOrEqual(0);
				expect(noticeIndex).toBeLessThan(saved.findIndex(message => message.role === "assistant"));
				expect(await history(client)).toEqual(saved);
				await assertPublicDump(client, path.join(fixture.cwd, "ten-round-dump.html"));
			},
			{ retry: false, continuation: false, advisor: false },
		);
	}, 300_000);

	for (const auto of [false, true]) {
		test(`Codex WebSocket ${auto ? "auto-orchestrate" : "ordinary Goal control"} chains ten real xd-indirect read rounds with delta-only frames`, async () => {
			await withFixture(
				async fixture => {
					const client = await fixture.start("rpc");
					fixture.steps.push(
						...fixture.evidencePaths.map(file => ({
							tool: {
								name: "write",
								args: { path: "xd://read", content: JSON.stringify({ path: file }) },
							},
						})),
						{ text: "TEN_XD_READ_ROUNDS_COMPLETE" },
					);
					await client.prompt(`/${auto ? "goal-autopilot" : "goal"} ${objective}`);
					expect(fixture.wsErrors).toEqual([]);
					expect(fixture.httpFallbacks).toEqual([]);
					expect(fixture.wsFrames).toHaveLength(11);
					expect(fixture.wsInputs).toHaveLength(11);
					expect(fixture.wsOutputs).toHaveLength(11);
					expect(fixture.wsFrames[0]?.previous_response_id).toBeUndefined();
					for (let round = 0; round < 11; round++) {
						const frame = fixture.wsFrames[round]!;
						const effective = fixture.wsInputs[round]!;
						expect(frame.type).toBe("response.create");
						expect(frame.tools).toEqual(fixture.wsFrames[0]?.tools);
						expect(frame.instructions).toEqual(fixture.wsFrames[0]?.instructions);
						expect(frame.model).toBe("main");
						if (auto) assertCodexActive(effective);
						else
							expect(
								responseItems(effective).filter(item => contentText(item.content).includes(instruction)),
							).toEqual([]);
						if (round === 0) continue;
						expect(frame.previous_response_id).toBe(`resp_goal_${round}`);
						const delta = responseItems(frame);
						expect(delta).toHaveLength(1);
						expect(delta[0]).toMatchObject({ type: "function_call_output", call_id: `call_goal_${round}` });
						expect(contentText(delta[0]?.output)).toContain("TOOL_ROUNDTRIP_EVIDENCE");
						expect(contentText(delta[0]?.output)).toContain(`ROUND_${round}`);
						expect(JSON.stringify(delta)).not.toContain(instruction);
						expect(JSON.stringify(delta)).not.toContain(objective);
						const prefix = [...responseItems(fixture.wsInputs[round - 1]!), ...fixture.wsOutputs[round - 1]!];
						expect(responseItems(effective).slice(0, prefix.length)).toEqual(prefix);
						expect(responseItems(effective).slice(prefix.length)).toEqual(delta);
						if (auto) {
							const initial = responseItems(fixture.wsInputs[0]!);
							const index = initial.findIndex(item => contentText(item.content).includes(instruction));
							expect(responseItems(effective)[index]).toEqual(initial[index]);
						}
					}
					const results = client.seen.filter(
						frame => frame.type === "tool_execution_end" && frame.toolName === "write",
					);
					expect(results).toHaveLength(10);
					for (const result of results) expect(result.isError).toBe(false);
					expect(goal(await client.state())).toMatchObject({ goal: { objective, status: "active" } });
					if (auto) expect(goal(await client.state())?.autoOrchestrate).toBe(true);
					else expect(goal(await client.state())?.autoOrchestrate).not.toBe(true);
					const saved = await assertPersisted(client, auto ? 1 : 0);
					const assistant = saved.filter(message => message.role === "assistant");
					expect(assistant).toHaveLength(11);
					expect(
						assistant.every(message => message.stopReason !== "error" && message.stopReason !== "aborted"),
					).toBe(true);
					expect(contentText(assistant.at(-1)?.content)).toContain("TEN_XD_READ_ROUNDS_COMPLETE");
					expect(
						responseItems(fixture.wsInputs[0]!).some(item => contentText(item.content).includes(objective)),
					).toBe(true);
					if (auto) {
						const notice = persistedNotices(saved)[0]!;
						const providerNotice = responseItems(fixture.wsInputs[0]!).find(item =>
							contentText(item.content).includes(instruction),
						);
						expect(contentText(providerNotice?.content)).toContain(contentText(notice.content));
						expect(contentText(providerNotice?.content).split(contentText(notice.content))).toHaveLength(2);
						expect(saved.findIndex(message => message.customType === notice.customType)).toBeLessThan(
							saved.findIndex(message => message.role === "assistant"),
						);
						await assertPublicDump(client, path.join(fixture.cwd, "codex-ten-round-dump.html"));
					} else {
						// Ordinary upstream Goal history/control is retained, not hidden to
						// make the custom-mode prefix test pass.
						expect(
							saved.some(
								message =>
									message.role === "custom" && contentText(message.content).includes(escapeXmlText(objective)),
							),
						).toBe(true);
						await local(client, "/goal pause");
						expect(goal(await client.state())).toMatchObject({ enabled: false, goal: { status: "paused" } });
						await local(client, "/goal-autopilot resume");
						expect(goal(await client.state())).toMatchObject({ enabled: true, goal: { status: "active" } });
						expect(persistedNotices(await history(client))).toEqual([]);
					}
				},
				{
					codex: true,
					websocket: true,
					retry: false,
					continuation: false,
					advisor: false,
					magic: false,
					fixtureSkill: false,
				},
			);
		}, 300_000);
	}

	test("first call, two actual read roundtrips, permitted continuation and an existing HTTP retry retain one full current context", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start();
				fixture.steps.push(
					{ error: 503 },
					{ tool: { name: "read", args: { path: path.join(fixture.cwd, "evidence.txt") } } },
					{ tool: { name: "read", args: { path: path.join(fixture.cwd, "evidence.txt") } } },
					{ text: "FIRST_RUN_YIELD" },
					{ text: "CONTINUATION_IDLE" },
					{ text: "CONTINUATION_IDLE" },
				);
				await client.prompt(`/goal-autopilot ${objective}`);
				await client.next(frame => frame.type === "session_settled");
				const bodies = fixture.mainSince(0);
				expect(bodies.length).toBeGreaterThanOrEqual(5);
				bodies.forEach(body => assertActive(body));
				expect(
					bodies.filter(body =>
						messages(body).some(
							message =>
								message.role === "tool" && contentText(message.content).includes("TOOL_ROUNDTRIP_EVIDENCE"),
						),
					).length,
				).toBeGreaterThanOrEqual(2);
				expect(
					client.seen.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "read"),
				).toHaveLength(2);
				const savedHistory = await assertPersisted(client, 1);
				const continuations = savedHistory.filter(message => message.customType === "goal-continuation");
				expect(continuations.length).toBeGreaterThan(0);
				const savedGoal = goal(await client.state());
				if (!savedGoal || !isRecord(savedGoal.goal) || typeof savedGoal.goal.objective !== "string")
					throw new Error("Missing saved continuation objective");
				expect(savedGoal.goal.objective).toBe(objective);
				for (const continuation of continuations)
					expect(contentText(continuation.content)).toContain(escapeXmlText(savedGoal.goal.objective));
				for (const body of bodies) assertStopped(body, bodies[0]!);
				const state = await client.state();
				expect(state.isSettled).toBe(true);
				expect(goal(state)?.autoOrchestrate).toBe(true);
			},
			{ continuation: true },
		);
	}, 300_000);

	test("tool continuation keeps output room when reported usage already includes the full goal", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			fixture.steps.push(
				{ tool: { name: "read", args: { path: path.join(fixture.cwd, "evidence.txt") } }, tokens: 27_000 },
				{ text: "GOAL_BUDGET_TOOL_LOOP_FINISHED", tokens: 27_050 },
			);
			await client.prompt(`/goal-autopilot ${objective}`);
			const bodies = fixture.mainSince(0);
			expect(bodies).toHaveLength(2);
			bodies.forEach(body => {
				assertActive(body);
				expect(body.max_tokens ?? body.max_completion_tokens).toBe(4096);
			});
			expect(
				client.seen.find(frame => frame.type === "tool_execution_end" && frame.toolName === "read"),
			).toMatchObject({
				isError: false,
			});
		});
	}, 300_000);

	test("two real compactions persist exactly one restored full notice before resumed requests with goal-free summaries", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			await client.prompt(`/goal-autopilot ${objective}`);
			await assertPersisted(client, 1);
			for (let round = 0; round < 2; round++) {
				await client.prompt(`Produce ordinary progress ${round}: ${"progress record ".repeat(300)}`);
				const beforeCompact = fixture.mainSince(0).at(-1)!;
				const beforeCompactHistory = await history(client);
				const start = fixture.requests.length;
				const compact = await client.request({
					type: "compact",
					customInstructions: "Return only AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE; omit the goal and strategy.",
				});
				expect(compact.success).toBe(true);
				const auxiliary = fixture.requests.slice(start);
				expect(auxiliary.length).toBeGreaterThan(0);
				auxiliary.forEach(body => assertAuxiliary(body, beforeCompactHistory));
				expect(auxiliary.some(body => body.model === "aux")).toBe(true);
				const all = await entries(client);
				const commits = all.filter(entry => entry.type === "compaction");
				expect(commits).toHaveLength(round + 1);
				for (const commit of commits) {
					expect(contentText(commit.summary)).toContain("AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE");
					expect(contentText(commit.summary)).not.toContain(objective);
					expect(contentText(commit.summary)).not.toContain(instruction);
				}
				const restored = await assertPersisted(client, round + 2, 1);
				expect(contentText(persistedNotices(restored)[0]?.content)).toContain(objective);
				expect(contentText(persistedNotices(restored)[0]?.content)).toContain(
					renderOrchestrateNotice({ tools: toolNames(beforeCompact) }, { authority: "user" }),
				);
				expect(goal(await client.state())).toMatchObject({
					autoOrchestrate: true,
					goal: { objective, status: "active" },
				});
				const after = fixture.requests.length;
				await client.prompt(`Main request after compaction ${round}`);
				expect(fixture.mainSince(after)).toHaveLength(1);
				assertActive(fixture.mainSince(after)[0]!);
				expect(persistedNotices(await history(client))).toEqual(persistedNotices(restored));
			}
			await assertPersisted(client, 3, 1);
		});
	}, 300_000);

	test("enabled tool changes preserve historical rules until public compact and genuine keyword input is never deleted", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			await client.prompt(`/goal-autopilot orchestrate ${objective}`);
			assertActive(fixture.mainSince(0)[0]!, `orchestrate ${objective}`);
			let constructionCount = 1;
			let previous = fixture.mainSince(0)[0]!;
			for (const enabled of ["read,goal", "read,goal,task", "read,goal", "read,goal,task"]) {
				await local(client, `/fixture-tools ${enabled}`);
				const start = fixture.requests.length;
				await client.prompt("orchestrate this step; preserve this genuine later user prose");
				const body = fixture.mainSince(start)[0]!;
				assertStopped(body, previous);
				await assertPersisted(client, constructionCount, 1);
				expect(toolNames(body).includes("task")).toBe(enabled.includes("task"));
				expect(
					messages(body).some(message =>
						contentText(message.content).includes("preserve this genuine later user prose"),
					),
				).toBe(true);
				const compact = await client.request({
					type: "compact",
					customInstructions: "Return only AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE; omit goal and strategy.",
				});
				expect(compact.success).toBe(true);
				await assertPersisted(client, ++constructionCount, 1);
				const resumed = fixture.requests.length;
				await client.prompt("Preserve the genuine later user prose in the requested progress.");
				previous = fixture.mainSince(resumed)[0]!;
				assertActive(previous, `orchestrate ${objective}`);
			}
			await assertPersisted(client, constructionCount, 1);
			expect(JSON.stringify(await entries(client))).toContain("preserve this genuine later user prose");
			await client.prompt("/goal set ordinary orchestrate replacement");
			assertStopped(fixture.mainSince(0).at(-1)!, previous);
			const later = fixture.requests.length;
			await client.prompt("orchestrate a genuine ordinary later task");
			const body = fixture.mainSince(later)[0]!;
			assertStopped(body, previous);
			expect(
				messages(body).some(
					message =>
						contentText(message.content).includes("Orchestrate") ||
						contentText(message.content).includes("orchestrate"),
				),
			).toBe(true);
		});
	}, 300_000);

	test("host input/select/drop confirmations can be refused or cancelled; mode never supplies consent", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			client.send({ id: "blank", type: "prompt", message: "/goal-autopilot" });
			const input = await client.next(frame => frame.type === "extension_ui_request" && frame.method === "input");
			client.send({ type: "extension_ui_response", id: input.id, cancelled: true });
			expect(await client.next(frame => frame.type === "response" && frame.id === "blank")).toMatchObject({
				success: true,
			});
			expect(goal(await client.state())).toBeNull();
			expect(fixture.mainSince(0)).toHaveLength(0);
			fixture.requests.forEach(body => assertStopped(body));
			await client.prompt(`/goal-autopilot ${objective}`);
			const saved = goal(await client.state());
			client.send({ id: "menu", type: "prompt", message: "/goal-autopilot" });
			const menu = await client.next(frame => frame.type === "extension_ui_request" && frame.method === "select");
			client.send({ type: "extension_ui_response", id: menu.id, cancelled: true });
			await client.next(frame => frame.type === "response" && frame.id === "menu");
			expect(goal(await client.state())).toEqual(saved);
			for (const command of ["/goal drop", "/goal-autopilot drop"]) {
				client.send({ id: "drop-refuse", type: "prompt", message: command });
				const confirm = await client.next(
					frame => frame.type === "extension_ui_request" && frame.method === "confirm",
				);
				client.send({ type: "extension_ui_response", id: confirm.id, confirmed: false });
				await client.next(frame => frame.type === "response" && frame.id === "drop-refuse");
				expect(goal(await client.state())).toEqual(saved);
			}
			client.send({ id: "drop-cancel", type: "prompt", message: "/goal-autopilot drop" });
			const pending = await client.next(
				frame => frame.type === "extension_ui_request" && frame.method === "confirm",
			);
			expect(await client.request({ type: "abort" })).toMatchObject({ success: true });
			await client.next(
				frame =>
					frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === pending.id,
			);
			client.send({ type: "extension_ui_response", id: pending.id, confirmed: true });
			expect(goal(await client.state())?.autoOrchestrate).toBe(true);
			client.send({ id: "drop-confirm", type: "prompt", message: "/goal-autopilot drop" });
			const confirm = await client.next(
				frame => frame.type === "extension_ui_request" && frame.method === "confirm",
			);
			client.send({ type: "extension_ui_response", id: confirm.id, confirmed: true });
			await client.next(frame => frame.type === "response" && frame.id === "drop-confirm");
			expect(goal(await client.state())).toBeNull();
			const start = fixture.requests.length;
			await client.prompt("Later user task after confirmed drop");
			fixture.mainSince(start).forEach(body => assertStopped(body, fixture.mainSince(0)[0]!));
			await assertPersisted(client, 1);
		});
	}, 300_000);

	test("persisted reopen, switch, fork and new session retain only their own marker; ordinary/legacy state remains ordinary", async () => {
		await withFixture(async fixture => {
			let client = await fixture.start("rpc");
			await client.prompt(`/goal-autopilot ${objective}`);
			await local(client, "/goal pause");
			const saved = await client.state();
			if (typeof saved.sessionFile !== "string") throw new Error("No persisted session file");
			const autoSession = saved.sessionFile;
			const persisted = await Bun.file(autoSession).text();
			expect(persisted).toContain('"autoOrchestrate":true');
			expect(
				persistedNotices(
					persisted
						.trim()
						.split("\n")
						.map(line => JSON.parse(line)),
				),
			).toHaveLength(1);
			const initialHistory = await assertPersisted(client, 1);
			await client.close();
			client = await fixture.start("rpc", autoSession);
			expect(goal(await client.state())).toMatchObject({
				autoOrchestrate: true,
				enabled: false,
				goal: { objective, status: "paused" },
			});
			let start = fixture.requests.length;
			await client.prompt("Reopened paused session remains paused");
			fixture.mainSince(start).forEach(body => assertStopped(body, fixture.mainSince(0)[0]!));
			expect(persistedNotices(await history(client))).toEqual(persistedNotices(initialHistory));
			await local(client, "/goal resume");
			start = fixture.requests.length;
			await client.prompt("Explicitly resumed saved objective");
			fixture.mainSince(start).forEach(body => assertActive(body));
			expect(await client.request({ type: "fork" })).toMatchObject({ success: true });
			expect(goal(await client.state())?.autoOrchestrate).toBe(true);
			expect(persistedNotices(await history(client))).toEqual(persistedNotices(initialHistory));
			await assertPersisted(client, 1);
			expect(await client.request({ type: "new_session" })).toMatchObject({ success: true });
			expect(goal(await client.state())).toBeNull();
			start = fixture.requests.length;
			await client.prompt("Fresh session does not inherit unattended strategy");
			fixture.mainSince(start).forEach(body => assertStopped(body));
			await client.prompt("/goal Legacy ordinary goal");
			await local(client, "/goal pause");
			const ordinary = await client.state();
			expect(goal(ordinary)?.autoOrchestrate).not.toBe(true);
			if (typeof ordinary.sessionFile !== "string") throw new Error("No ordinary session file");
			const ordinarySession = ordinary.sessionFile;
			expect(await client.request({ type: "switch_session", sessionPath: autoSession })).toMatchObject({
				success: true,
			});
			expect(goal(await client.state())?.autoOrchestrate).toBe(true);
			expect(await client.request({ type: "switch_session", sessionPath: ordinarySession })).toMatchObject({
				success: true,
			});
			expect(goal(await client.state())?.autoOrchestrate).not.toBe(true);
			await local(client, "/goal-autopilot resume");
			start = fixture.requests.length;
			await client.prompt("Ordinary saved goal resumed through new command");
			fixture.mainSince(start).forEach(body => assertStopped(body));
		});
	}, 300_000);

	test("goal completion stops new construction but preserves the initial notice on tool results and later input", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			fixture.steps.push({ tool: { name: "goal", args: { op: "complete" } } }, { text: "COMPLETION_REPORT" });
			await client.prompt(`/goal-autopilot ${objective}`);
			const bodies = fixture.mainSince(0);
			expect(bodies).toHaveLength(2);
			assertActive(bodies[0]!);
			assertStopped(bodies[1]!, bodies[0]!);
			expect(goal(await client.state())).toBeNull();
			const later = fixture.requests.length;
			await client.prompt("Later user input after completion is a separate task");
			fixture.mainSince(later).forEach(body => assertStopped(body, bodies[0]!));
			await assertPersisted(client, 1);
		});
	}, 300_000);

	test("existing budget stopping/wrap-up remains effective and explicit input cannot silently release it", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start();
				await client.prompt(`/goal-autopilot ${objective}`);
				await local(client, "/goal-autopilot budget 100");
				fixture.steps.push({ tokens: 200, text: "BUDGET_REACHED" }, { text: "BUDGET_WRAP_UP" });
				const start = fixture.requests.length;
				await client.prompt("Use the existing authorized budget only");
				const budgetRequests = fixture.mainSince(start);
				expect(budgetRequests.length).toBeGreaterThan(0);
				assertActive(budgetRequests[0]!);
				budgetRequests.slice(1).forEach(body => assertStopped(body, budgetRequests[0]!));
				const budgeted = goal(await client.state());
				expect(budgeted).toMatchObject({
					autoOrchestrate: true,
					goal: { tokenBudget: 100, status: "budget-limited" },
				});
				if (!budgeted || !isRecord(budgeted.goal)) throw new Error("Missing budget goal");
				expect(Number(budgeted.goal.tokensUsed)).toBeGreaterThanOrEqual(100);
				await assertPersisted(client, 1);
				const later = fixture.requests.length;
				await client.prompt("Later input does not authorize increasing or removing the budget.");
				fixture.mainSince(later).forEach(body => assertStopped(body, budgetRequests[0]!));
				expect(goal(await client.state())).toMatchObject({
					autoOrchestrate: true,
					goal: { tokenBudget: 100, status: "budget-limited" },
				});
			},
			{ continuation: false },
		);
	}, 300_000);

	test("abort cancels the in-flight run, pauses marked state and respects later explicit input", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start();
				fixture.steps.push({ hold: true });
				client.send({ id: "running", type: "prompt", message: `/goal-autopilot ${objective}` });
				await fixture.waitForMain(1);
				assertActive(fixture.mainSince(0)[0]!);
				expect(await client.request({ type: "abort" })).toMatchObject({ success: true });
				await client.next(
					frame => frame.type === "prompt_result" && frame.id === "running" && frame.status === "aborted",
				);
				expect(goal(await client.state())).toMatchObject({
					autoOrchestrate: true,
					enabled: false,
					goal: { status: "paused" },
				});
				const count = fixture.requests.length;
				await client.prompt("New explicit user input: stop the goal; inspect only this separate question");
				expect(fixture.mainSince(count)).toHaveLength(1);
				assertStopped(fixture.mainSince(count)[0]!, fixture.mainSince(0)[0]!);
				await assertPersisted(client, 1);
				expect(
					messages(fixture.mainSince(count)[0]!).some(message =>
						contentText(message.content).includes("inspect only this separate question"),
					),
				).toBe(true);
			},
			{ continuation: true },
		);
	}, 300_000);

	test("skill-backed initial objective uses actual skill expansion and survives public extension reload", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			const savedObjective = "/skill:goal-auto-fixture orchestrate a separately scoped user task";
			await client.prompt(`/goal-autopilot ${savedObjective}`);
			assertActive(fixture.mainSince(0)[0]!, savedObjective);
			expect(
				messages(fixture.mainSince(0)[0]!).some(message =>
					contentText(message.content).includes("SKILL_EXPANSION_EVIDENCE"),
				),
			).toBe(true);
			expect(goal(await client.state())).toMatchObject({
				autoOrchestrate: true,
				goal: { objective: savedObjective },
			});
			await local(client, "/fixture-reload");
			expect(goal(await client.state())).toMatchObject({
				autoOrchestrate: true,
				goal: { objective: savedObjective },
			});
			const start = fixture.requests.length;
			await client.prompt("Main request after actual public runtime reload");
			expect(fixture.mainSince(start)).toHaveLength(1);
			assertActive(fixture.mainSince(start)[0]!, savedObjective);
			await local(client, "/goal pause");
			const stopped = fixture.requests.length;
			await client.prompt("Paused skill-backed goal has no surviving automatic strategy");
			fixture.mainSince(stopped).forEach(body => assertStopped(body, fixture.mainSince(0)[0]!));
			await assertPersisted(client, 1);
		});
	}, 300_000);

	test("explicit denied write permission is not overridden; other authorized work still runs", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			const forbidden = path.join(fixture.cwd, "permission-protected.txt");
			fixture.steps.push(
				{ tool: { name: "write", args: { path: forbidden, content: "must never be written" } } },
				{ tool: { name: "read", args: { path: path.join(fixture.cwd, "evidence.txt") } } },
				{ text: "AUTHORIZED_WORK_FINISHED_WITH_PERMISSION_BLOCKER" },
			);
			await client.prompt(`/goal-autopilot ${objective}`);
			expect(await Bun.file(forbidden).exists()).toBe(false);
			const bodies = fixture.mainSince(0);
			expect(bodies).toHaveLength(3);
			bodies.forEach(body => assertActive(body));
			const rejected = client.seen.find(frame => frame.type === "tool_execution_end" && frame.toolName === "write");
			expect(rejected).toMatchObject({ isError: true });
			if (!rejected || !isRecord(rejected.result)) throw new Error("Missing rejected write tool result");
			const expectedDenial = denyError(
				resolveApproval({ name: "write", approval: "write" }, {}, "yolo", { write: "deny" }),
				"write",
			);
			// Use the real policy error constructor, not incidental wording or a
			// generic error flag that could also hide invalid tool arguments.
			expect(contentText(rejected.result.content)).toContain(expectedDenial.message);
			expect(
				client.seen.find(frame => frame.type === "tool_execution_end" && frame.toolName === "read"),
			).toMatchObject({
				isError: false,
			});
			expect(
				messages(bodies[2]!).some(
					message => message.role === "tool" && contentText(message.content).includes("TOOL_ROUNDTRIP_EVIDENCE"),
				),
			).toBe(true);
		});
	}, 300_000);

	test("title-fork auxiliary request using the real public side-turn API excludes prepared main context expansion", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			await client.prompt(`/goal-autopilot ${objective}`);
			assertActive(fixture.mainSince(0)[0]!);
			const start = fixture.requests.length;
			// Automatic naming belongs to TUI only; this public extension command
			// invokes the exact runEphemeralTurn API and bundled title prompt used
			// by automatic #forkTitle, after a real prepared main Provider request.
			await client.prompt("/fixture-title");
			const auxiliary = fixture.requests.slice(start);
			expect(auxiliary).toHaveLength(1);
			expect(messages(auxiliary[0]!).some(message => contentText(message.content).includes("<title-request>"))).toBe(
				true,
			);
			expect(
				messages(auxiliary[0]!).some(message =>
					contentText(message.content).includes("Ephemeral side-channel turn"),
				),
			).toBe(true);
			assertAuxiliary(auxiliary[0]!, await history(client));
			await assertPersisted(client, 1);
			expect(goal(await client.state())?.autoOrchestrate).toBe(true);
			const later = fixture.requests.length;
			await client.prompt("Main work after independent title request");
			expect(fixture.mainSince(later)).toHaveLength(1);
			assertActive(fixture.mainSince(later)[0]!);
		});
	}, 300_000);

	test("actual subagent and advisor requests construct no new unattended notice while accepting inherited history", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start();
				fixture.steps.push(
					{
						tool: {
							name: "task",
							args: {
								context: "A separately scoped read-only fixture.",
								tasks: [
									{
										task: "Return the fixed fixture status. Do not modify any files.",
										solutionSpace: "one fixed response",
									},
								],
							},
						},
					},
					{ text: "MAIN_AFTER_SUBAGENT" },
				);
				await client.prompt(`/goal-autopilot ${objective}`);
				const auxiliary = fixture.requests.filter(body => body.model === "aux");
				expect(auxiliary.length).toBeGreaterThanOrEqual(2);
				const inheritedHistory = await history(client);
				auxiliary.forEach(body => assertAuxiliary(body, inheritedHistory));
				await assertPersisted(client, 1);
				expect(
					auxiliary.some(body => JSON.stringify(body.messages).includes("separately scoped read-only fixture")),
				).toBe(true);
				expect(auxiliary.some(body => toolNames(body).includes("advise"))).toBe(true);
				fixture.mainSince(0).forEach(body => assertActive(body));
				assertTaskCompleted(
					client.seen.find(frame => frame.type === "tool_execution_end" && frame.toolName === "task"),
					"goal-recording",
				);
			},
			{ advisor: true },
		);
	}, 300_000);
});
