import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, prompt, readJsonl, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { renderOrchestrateNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { denyError, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import unattended from "../src/prompts/goals/goal-auto-orchestrate.md" with { type: "text" };
import titleForkPrompt from "../src/prompts/system/title-fork.md" with { type: "text" };

// Real public cli.ts RPC entries and final HTTP Provider bodies. Only the
// Provider response is scripted: it never echoes the instructions under test.
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

function assertActive(body: Frame, savedObjective = objective): void {
	const blocks = featureBlocks(body);
	expect(blocks).toHaveLength(1);
	expect(blocks[0]?.role).toBe("user");
	const text = contentText(blocks[0]?.content);
	expect(text.split(savedObjective)).toHaveLength(2);
	expect(text.split(instruction)).toHaveLength(2);
	const tools = toolNames(body);
	if (tools.includes("task")) expect(text).toContain(renderOrchestrateNotice({ tools }, { authority: "user" }));
	else expect(text).not.toContain(renderOrchestrateNotice({ tools }, { authority: "user" }));
	expect(text).not.toContain("<system-notice>");
	expect(text).not.toContain("<system-reminder>");
	for (const message of messages(body).filter(message => message.role === "system" || message.role === "developer")) {
		expect(contentText(message.content)).not.toContain(instruction);
	}
}

function assertStopped(body: Frame): void {
	expect(featureBlocks(body)).toHaveLength(0);
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
	requests: Frame[];
	steps: Step[];
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
	await Bun.write(
		path.join(cwd, ".omp", "skills", "goal-auto-fixture", "SKILL.md"),
		"---\nname: goal-auto-fixture\ndescription: Goal auto acceptance fixture.\n---\nSKILL_EXPANSION_EVIDENCE. Preserve the user's supplied scope.\n",
	);
	const requests: Frame[] = [];
	const steps: Step[] = [];
	const releases: Array<() => void> = [];
	const requestWaiters = new Set<() => void>();
	let serial = 0;
	const modelServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname.endsWith("/models")) {
				return Response.json({
					object: "list",
					data: ["main", "aux"].map(id => ({ id, object: "model", owned_by: "goal-recording" })),
				});
			}
			if (!new URL(request.url).pathname.endsWith("/chat/completions"))
				return new Response("not found", { status: 404 });
			const body: unknown = await request.json();
			if (!isRecord(body)) return new Response("invalid request", { status: 400 });
			requests.push(body);
			for (const resolve of requestWaiters) resolve();
			requestWaiters.clear();
			const title = messages(body).some(message => contentText(message.content).includes("<title-request>"));
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
			if (step.hold)
				await new Promise<void>(resolve => {
					releases.push(resolve);
					if (request.signal.aborted) resolve();
					else request.signal.addEventListener("abort", () => resolve(), { once: true });
				});
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
	});
	await Bun.write(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  goal-recording:",
			`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			...["main", "aux"].flatMap(id => [
				`      - id: ${id}`,
				`        name: ${id}`,
				"        reasoning: false",
				"        contextWindow: 32768",
				"        maxTokens: 4096",
				...(id === "main" ? ["        compactionModel: goal-recording/aux"] : []),
			]),
			"",
		].join("\n"),
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		[
			"modelRoles:",
			"  task: [goal-recording/aux]",
			"  smol: [goal-recording/aux]",
			"  advisor: [goal-recording/aux]",
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
			"  enabled: true",
			"  maxRetries: 2",
			"  baseDelayMs: 1",
			"  maxDelayMs: 5",
			"  modelFallback: false",
			"task:",
			"  isolation:",
			"    enabled: false",
			"  prewalk: false",
			"async:",
			"  enabled: false",
			"tools:",
			"  approval:",
			"    write: deny",
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
		requests,
		steps,
		mainSince: index =>
			requests
				.slice(index)
				.filter(
					body =>
						body.model === "main" &&
						!messages(body).some(message => contentText(message.content).includes("<title-request>")),
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
					"goal-recording",
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
					await client.next(frame => frame.type === "prompt_result" && frame.id === id);
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
			startupRequests.forEach(assertStopped);
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

describe("goal-auto-orchestrate public CLI Provider acceptance", () => {
	for (const mode of ["rpc", "rpc-ui"] as const) {
		test(`${mode} catalogs/completes the command and reuses management/errors without forced continuation`, async () => {
			await withFixture(
				async fixture => {
					const client = await fixture.start(mode);
					const catalog = await client.request({ type: "get_available_commands" });
					if (!isRecord(catalog.data) || !Array.isArray(catalog.data.commands))
						throw new Error("Missing command catalog");
					const entry = catalog.data.commands.find(
						command => isRecord(command) && command.name === "goal-auto-orchestrate",
					);
					expect(entry).toMatchObject({ name: "goal-auto-orchestrate" });
					if (!isRecord(entry) || !Array.isArray(entry.subcommands)) throw new Error("Missing goal subcommands");
					expect(entry.subcommands.map(sub => (isRecord(sub) ? sub.name : undefined))).toEqual(
						expect.arrayContaining(["set", "show", "pause", "resume", "drop", "budget"]),
					);
					for (const text of ["/goal-auto-orchestrate", "/goal-auto-orchestrate pa"]) {
						const completion = await client.request({ type: "complete_command", text, cursor: text.length });
						expect(completion.success).toBe(true);
						if (!isRecord(completion.data) || !Array.isArray(completion.data.items))
							throw new Error("Missing completion");
						expect(completion.data.items).toContainEqual(
							expect.objectContaining({ label: text.endsWith(" pa") ? "pause" : "goal-auto-orchestrate" }),
						);
					}
					await local(client, "/goal-auto-orchestrate show");
					expect(fixture.mainSince(0)).toHaveLength(0);
					fixture.requests.forEach(assertStopped);
					expect(
						await client.request({ type: "prompt", message: "/goal-auto-orchestrate budget invalid" }),
					).toMatchObject({ success: false });
					await client.prompt(`/goal-auto-orchestrate ${objective}`);
					expect(fixture.mainSince(0)).toHaveLength(1);
					assertActive(fixture.mainSince(0)[0]!);
					expect(goal(await client.state())).toMatchObject({
						autoOrchestrate: true,
						goal: { objective, status: "active" },
					});
					for (const command of [
						"/goal budget 100000",
						"/goal-auto-orchestrate budget off",
						"/goal show",
						"/goal-auto-orchestrate show",
					]) {
						await local(client, command);
						expect(goal(await client.state())?.autoOrchestrate).toBe(true);
					}
					const before = await client.state();
					expect(
						await client.request({ type: "prompt", message: "/goal-auto-orchestrate budget 0" }),
					).toMatchObject({ success: false });
					expect(goal(await client.state())).toEqual(goal(before));
					await local(client, "/goal pause");
					expect(goal(await client.state())).toMatchObject({
						autoOrchestrate: true,
						enabled: false,
						goal: { status: "paused" },
					});
					let start = fixture.requests.length;
					await client.prompt("Later user says: inspect only; do not edit anything.");
					fixture.mainSince(start).forEach(assertStopped);
					await local(client, "/goal-auto-orchestrate resume");
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
					assertStopped(fixture.mainSince(0).at(-1)!);
					await local(client, "/goal-auto-orchestrate pause");
					await local(client, "/goal-auto-orchestrate resume");
					expect(goal(await client.state())?.autoOrchestrate).not.toBe(true);
					await client.prompt(`/goal-auto-orchestrate set ${objective}`);
					expect(goal(await client.state())?.autoOrchestrate).toBe(true);
					assertActive(fixture.mainSince(0).at(-1)!);
				},
				{ magic: false },
			);
		}, 300_000);
	}

	test("explicit mode starts without task or magic keywords and retains objective plus unattended instructions", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start();
				await client.prompt(`/goal-auto-orchestrate ${objective}`);
				expect(fixture.mainSince(0)).toHaveLength(1);
				const body = fixture.mainSince(0)[0]!;
				expect(toolNames(body)).not.toContain("task");
				assertActive(body);
				expect(goal(await client.state())?.autoOrchestrate).toBe(true);
			},
			{ task: false, magic: false },
		);
	}, 300_000);

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
				await client.prompt(`/goal-auto-orchestrate ${objective}`);
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
				const history = await client.request({ type: "get_messages" });
				expect(JSON.stringify(history.data)).not.toContain(instruction);
				expect(JSON.stringify(history.data)).not.toContain("goal-auto-orchestrate-context");
				expect(JSON.stringify(history.data)).toContain("goal-auto-orchestrate-continuation");
				const state = await client.state();
				expect(state.isSettled).toBe(true);
				expect(goal(state)?.autoOrchestrate).toBe(true);
			},
			{ continuation: true },
		);
	}, 300_000);

	test("two real compactions omit unattended strategy from auxiliary requests and rebuild the objective on later main requests", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			await client.prompt(`/goal-auto-orchestrate ${objective}`);
			for (let round = 0; round < 2; round++) {
				await client.prompt(`Produce ordinary progress ${round}: ${"progress record ".repeat(300)}`);
				const start = fixture.requests.length;
				const compact = await client.request({
					type: "compact",
					customInstructions: "Return only AUXILIARY_SUMMARY_WITHOUT_OBJECTIVE; omit the goal and strategy.",
				});
				expect(compact.success).toBe(true);
				const auxiliary = fixture.requests.slice(start);
				expect(auxiliary.length).toBeGreaterThan(0);
				auxiliary.forEach(assertStopped);
				expect(auxiliary.some(body => body.model === "aux")).toBe(true);
				const after = fixture.requests.length;
				await client.prompt(`Main request after compaction ${round}`);
				expect(fixture.mainSince(after)).toHaveLength(1);
				assertActive(fixture.mainSince(after)[0]!);
			}
			const entries = await client.request({ type: "get_entries" });
			expect(JSON.stringify(entries.data)).not.toContain(instruction);
			expect(JSON.stringify(entries.data)).not.toContain("goal-auto-orchestrate-context");
		});
	}, 300_000);

	test("actual enabled task removal/restoration dynamically renders rules and preserves genuine keyword input without transient history growth", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			await client.prompt(`/goal-auto-orchestrate orchestrate ${objective}`);
			assertActive(fixture.mainSince(0)[0]!, `orchestrate ${objective}`);
			for (const enabled of ["read,goal", "read,goal,task", "read,goal", "read,goal,task"]) {
				await local(client, `/fixture-tools ${enabled}`);
				const start = fixture.requests.length;
				await client.prompt("orchestrate this step; preserve this genuine later user prose");
				const body = fixture.mainSince(start)[0]!;
				assertActive(body, `orchestrate ${objective}`);
				expect(toolNames(body).includes("task")).toBe(enabled.includes("task"));
				expect(
					messages(body).some(message =>
						contentText(message.content).includes("preserve this genuine later user prose"),
					),
				).toBe(true);
			}
			const history = await client.request({ type: "get_messages" });
			expect(JSON.stringify(history.data)).not.toContain(instruction);
			expect(JSON.stringify(history.data)).not.toContain("goal-auto-orchestrate-context");
			expect(JSON.stringify(history.data)).toContain("preserve this genuine later user prose");
			await client.prompt("/goal set ordinary orchestrate replacement");
			assertStopped(fixture.mainSince(0).at(-1)!);
			const later = fixture.requests.length;
			await client.prompt("orchestrate a genuine ordinary later task");
			const body = fixture.mainSince(later)[0]!;
			assertStopped(body);
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
			client.send({ id: "blank", type: "prompt", message: "/goal-auto-orchestrate" });
			const input = await client.next(frame => frame.type === "extension_ui_request" && frame.method === "input");
			client.send({ type: "extension_ui_response", id: input.id, cancelled: true });
			expect(await client.next(frame => frame.type === "response" && frame.id === "blank")).toMatchObject({
				success: true,
			});
			expect(goal(await client.state())).toBeNull();
			expect(fixture.mainSince(0)).toHaveLength(0);
			fixture.requests.forEach(assertStopped);
			await client.prompt(`/goal-auto-orchestrate ${objective}`);
			const saved = goal(await client.state());
			client.send({ id: "menu", type: "prompt", message: "/goal-auto-orchestrate" });
			const menu = await client.next(frame => frame.type === "extension_ui_request" && frame.method === "select");
			client.send({ type: "extension_ui_response", id: menu.id, cancelled: true });
			await client.next(frame => frame.type === "response" && frame.id === "menu");
			expect(goal(await client.state())).toEqual(saved);
			for (const command of ["/goal drop", "/goal-auto-orchestrate drop"]) {
				client.send({ id: "drop-refuse", type: "prompt", message: command });
				const confirm = await client.next(
					frame => frame.type === "extension_ui_request" && frame.method === "confirm",
				);
				client.send({ type: "extension_ui_response", id: confirm.id, confirmed: false });
				await client.next(frame => frame.type === "response" && frame.id === "drop-refuse");
				expect(goal(await client.state())).toEqual(saved);
			}
			client.send({ id: "drop-cancel", type: "prompt", message: "/goal-auto-orchestrate drop" });
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
			client.send({ id: "drop-confirm", type: "prompt", message: "/goal-auto-orchestrate drop" });
			const confirm = await client.next(
				frame => frame.type === "extension_ui_request" && frame.method === "confirm",
			);
			client.send({ type: "extension_ui_response", id: confirm.id, confirmed: true });
			await client.next(frame => frame.type === "response" && frame.id === "drop-confirm");
			expect(goal(await client.state())).toBeNull();
			const start = fixture.requests.length;
			await client.prompt("Later user task after confirmed drop");
			fixture.mainSince(start).forEach(assertStopped);
		});
	}, 300_000);

	test("persisted reopen, switch, fork and new session retain only their own marker; ordinary/legacy state remains ordinary", async () => {
		await withFixture(async fixture => {
			let client = await fixture.start("rpc");
			await client.prompt(`/goal-auto-orchestrate ${objective}`);
			await local(client, "/goal pause");
			const saved = await client.state();
			if (typeof saved.sessionFile !== "string") throw new Error("No persisted session file");
			const autoSession = saved.sessionFile;
			const persisted = await Bun.file(autoSession).text();
			expect(persisted).toContain('"autoOrchestrate":true');
			expect(persisted).not.toContain(instruction);
			await client.close();
			client = await fixture.start("rpc", autoSession);
			expect(goal(await client.state())).toMatchObject({
				autoOrchestrate: true,
				enabled: false,
				goal: { objective, status: "paused" },
			});
			let start = fixture.requests.length;
			await client.prompt("Reopened paused session remains paused");
			fixture.mainSince(start).forEach(assertStopped);
			await local(client, "/goal resume");
			start = fixture.requests.length;
			await client.prompt("Explicitly resumed saved objective");
			fixture.mainSince(start).forEach(body => assertActive(body));
			expect(await client.request({ type: "fork" })).toMatchObject({ success: true });
			expect(goal(await client.state())?.autoOrchestrate).toBe(true);
			expect(await client.request({ type: "new_session" })).toMatchObject({ success: true });
			expect(goal(await client.state())).toBeNull();
			start = fixture.requests.length;
			await client.prompt("Fresh session does not inherit unattended strategy");
			fixture.mainSince(start).forEach(assertStopped);
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
			await local(client, "/goal-auto-orchestrate resume");
			start = fixture.requests.length;
			await client.prompt("Ordinary saved goal resumed through new command");
			fixture.mainSince(start).forEach(assertStopped);
		});
	}, 300_000);

	test("goal completion stops injection on the tool-result request and later input", async () => {
		await withFixture(async fixture => {
			const client = await fixture.start();
			fixture.steps.push({ tool: { name: "goal", args: { op: "complete" } } }, { text: "COMPLETION_REPORT" });
			await client.prompt(`/goal-auto-orchestrate ${objective}`);
			const bodies = fixture.mainSince(0);
			expect(bodies).toHaveLength(2);
			assertActive(bodies[0]!);
			assertStopped(bodies[1]!);
			expect(goal(await client.state())).toBeNull();
			const later = fixture.requests.length;
			await client.prompt("Later user input after completion is a separate task");
			fixture.mainSince(later).forEach(assertStopped);
		});
	}, 300_000);

	test("existing budget stopping/wrap-up remains effective and explicit input cannot silently release it", async () => {
		await withFixture(
			async fixture => {
				const client = await fixture.start();
				await client.prompt(`/goal-auto-orchestrate ${objective}`);
				await local(client, "/goal-auto-orchestrate budget 100");
				fixture.steps.push({ tokens: 200, text: "BUDGET_REACHED" }, { text: "BUDGET_WRAP_UP" });
				const start = fixture.requests.length;
				await client.prompt("Use the existing authorized budget only");
				const budgetRequests = fixture.mainSince(start);
				expect(budgetRequests.length).toBeGreaterThan(0);
				assertActive(budgetRequests[0]!);
				budgetRequests.slice(1).forEach(assertStopped);
				const budgeted = goal(await client.state());
				expect(budgeted).toMatchObject({
					autoOrchestrate: true,
					goal: { tokenBudget: 100, status: "budget-limited" },
				});
				if (!budgeted || !isRecord(budgeted.goal)) throw new Error("Missing budget goal");
				expect(Number(budgeted.goal.tokensUsed)).toBeGreaterThanOrEqual(100);
				const history = await client.request({ type: "get_messages" });
				expect(JSON.stringify(history.data)).not.toContain(instruction);
				const later = fixture.requests.length;
				await client.prompt("Later input does not authorize increasing or removing the budget.");
				fixture.mainSince(later).forEach(assertStopped);
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
				client.send({ id: "running", type: "prompt", message: `/goal-auto-orchestrate ${objective}` });
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
				assertStopped(fixture.mainSince(count)[0]!);
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
			await client.prompt(`/goal-auto-orchestrate ${savedObjective}`);
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
			fixture.mainSince(stopped).forEach(assertStopped);
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
			await client.prompt(`/goal-auto-orchestrate ${objective}`);
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
			await client.prompt(`/goal-auto-orchestrate ${objective}`);
			assertActive(fixture.mainSince(0)[0]!);
			const start = fixture.requests.length;
			// Automatic naming belongs to TUI only; this public extension command
			// invokes the exact runEphemeralTurn API and bundled title prompt used
			// by automatic #forkTitle, after a real prepared main Provider request.
			await local(client, "/fixture-title");
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
			assertStopped(auxiliary[0]!);
			expect(goal(await client.state())?.autoOrchestrate).toBe(true);
			const later = fixture.requests.length;
			await client.prompt("Main work after independent title request");
			expect(fixture.mainSince(later)).toHaveLength(1);
			assertActive(fixture.mainSince(later)[0]!);
		});
	}, 300_000);

	test("actual subagent and advisor requests do not receive the main unattended expansion", async () => {
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
										agent: "sonic",
										task: "Return the fixed fixture status. Do not modify any files.",
										solutionSpace: "one fixed response",
									},
								],
							},
						},
					},
					{ text: "MAIN_AFTER_SUBAGENT" },
				);
				await client.prompt(`/goal-auto-orchestrate ${objective}`);
				const auxiliary = fixture.requests.filter(body => body.model === "aux");
				expect(auxiliary.length).toBeGreaterThanOrEqual(2);
				auxiliary.forEach(assertStopped);
				expect(
					auxiliary.some(body => JSON.stringify(body.messages).includes("separately scoped read-only fixture")),
				).toBe(true);
				expect(auxiliary.some(body => toolNames(body).includes("advise"))).toBe(true);
				fixture.mainSince(0).forEach(body => assertActive(body));
				expect(client.seen.some(frame => frame.type === "tool_execution_end" && frame.toolName === "task")).toBe(
					true,
				);
			},
			{ advisor: true },
		);
	}, 300_000);
});
