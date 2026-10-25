import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { AuthStorage } from "../../src/session/auth-storage";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { cfgCompactionEnabled, cfgCompactionThresholdTokens } from "../../src/session/context-settings";
import { createSpecActor } from "../../src/spec-driven/actors";
import type { CustomTool } from "../../src/sdk";

const schema = {
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
};

async function consumer(customTools?: CustomTool[]) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-actor-compaction-"));
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir);
	let text = '{"value":"prior"}';
	let fail = false;
	let onRequest: (() => void) | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions")
				return new Response("Unexpected route", { status: 400 });
			const body = (await request.json()) as {
				messages: Array<{ role: string }>;
				tools?: Array<{ function: { name: string } }>;
			};
			onRequest?.();
			if (fail)
				return Response.json(
					{ error: { message: "actor fixture rejected request", type: "invalid_request_error" } },
					{ status: 400 },
				);
			const pendingTool = customTools?.[0];
			const useTool = pendingTool && !body.messages.some(message => message.role === "tool");
			const toolName = body.tools?.find(tool => tool.function.name.replace(/^_/u, "") === pendingTool?.name)
				?.function.name;
			const chunks = [
				{
					choices: [
						{
							index: 0,
							delta: useTool
								? {
										role: "assistant",
										tool_calls: [
											{
												index: 0,
												id: "blocking-call",
												type: "function",
												function: { name: toolName, arguments: "{}" },
											},
										],
									}
								: { role: "assistant", content: text },
							finish_reason: null,
						},
					],
				},
				{
					choices: [{ index: 0, delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }],
					usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
				},
			];
			return new Response(
				`${chunks.map(chunk => `data: ${JSON.stringify({ id: "actor-fixture", object: "chat.completion.chunk", model: "chat-a", ...chunk })}\n\n`).join("")}data: [DONE]\n\n`,
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	const settings = Settings.isolated({
		modelRoles: { default: "actor-fixture/chat-a", smol: "actor-fixture/chat-a" },
		"compaction.enabled": false,
		"compaction.methodOrder": ["soft"],
		"compaction.keepRecentTokens": 1,
		"compaction.asyncEnabled": false,
		"compaction.autoContinue": false,
		"prewalk.enabled": false,
		"tools.xdev": false,
		"todo.enabled": false,
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  actor-fixture:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n`,
	);
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = modelRegistry.find("actor-fixture", "chat-a");
	if (!model) throw new Error("Local actor fixture model unavailable");
	const asyncJobManager = new AsyncJobManager({});
	const actor = await createSpecActor({
		role: "requirements",
		sessionDirectory: path.join(cwd, "sessions"),
		methods: [],
		options: {
			cwd,
			agentDir,
			settings,
			model,
			authStorage,
			modelRegistry,
			asyncJobManager,
			contextFiles: [],
			rules: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			autoTitle: false,
			offline: true,
			customTools,
			...(customTools
				? {
						toolNames: customTools.map(tool => tool.name),
						restrictToolNames: true,
						allowRestrictedCustomTools: true,
					}
				: {}),
		},
	});
	const controller = new AbortController();
	const context = { runId: "actor-compaction", generation: 1, signal: controller.signal };
	const request = () =>
		actor.request({ payload: { instruction: "Return the requested JSON value." }, documents: [] }, context, schema);
	return {
		actor,
		context,
		controller,
		request,
		setText(value: string) {
			text = value;
		},
		fail() {
			fail = true;
		},
		onRequest(callback: () => void) {
			onRequest = callback;
		},
		async [Symbol.asyncDispose]() {
			try {
				await actor.dispose();
			} finally {
				await asyncJobManager.dispose();
				server.stop(true);
				authStorage.close();
				HistoryStorage.close();
				closeSessionIndex();
				AgentStorage.close();
				closeModelCache();
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	};
}

test("actor request retains its current schema-valid result through real native compaction", async () => {
	await using fixture = await consumer();
	for (let index = 0; index < 8; index++) expect(await fixture.request()).toEqual({ value: "prior" });
	const boundary = fixture.actor.session.messages.length;
	let compactions = 0;
	const unsubscribe = fixture.actor.session.subscribe(event => {
		if (event.type === "auto_compaction_end" && event.result && !event.aborted) compactions++;
	});
	try {
		fixture.setText('{"value":"current"}');
		cfgCompactionThresholdTokens.set(fixture.actor.session.settings, 1);
		cfgCompactionEnabled.set(fixture.actor.session.settings, true);
		expect(await fixture.request()).toEqual({ value: "current" });
		expect(compactions).toBeGreaterThan(0);
		expect(fixture.actor.session.messages.length).toBeLessThan(boundary);
		expect(fixture.actor.session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
	} finally {
		unsubscribe();
	}
}, 120_000);

test("actor request rejects a current provider failure rather than reusing a prior valid assistant", async () => {
	await using fixture = await consumer();
	expect(await fixture.request()).toEqual({ value: "prior" });
	fixture.fail();
	await expect(fixture.request()).rejects.toThrow();
}, 120_000);

test("actor request rejects current cancellation and invalid schema despite a prior valid assistant", async () => {
	await using fixture = await consumer();
	expect(await fixture.request()).toEqual({ value: "prior" });
	fixture.setText('{"wrong":"invalid schema"}');
	await expect(fixture.request()).rejects.toThrow();
	fixture.setText('{"value":"cancelled"}');
	fixture.onRequest(() => fixture.controller.abort());
	await expect(fixture.request()).rejects.toThrow();
}, 120_000);

test("actor cancellation waits for an in-flight native tool to actually settle", async () => {
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let toolStopped = false;
	await using fixture = await consumer([
		{
			name: "blocking_probe",
			label: "Blocking probe",
			description: "Wait for the test-owned external operation to stop.",
			parameters: type({}),
			async execute(_id, _params, _update, _context, signal) {
				signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				entered.resolve();
				await release.promise;
				toolStopped = true;
				return { content: [{ type: "text", text: "External operation stopped" }] };
			},
		},
	]);
	let settled = false;
	const request = fixture.request().then(
		value => {
			settled = true;
			return { value, error: undefined };
		},
		error => {
			settled = true;
			return { value: undefined, error };
		},
	);
	try {
		await entered.promise;
		fixture.controller.abort();
		await aborted.promise;
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		expect(settled).toBe(false);
		expect(toolStopped).toBe(false);
	} finally {
		release.resolve();
	}
	const result = await request;
	expect(result.error).toBeDefined();
	expect(result.value).toBeUndefined();
	expect(toolStopped).toBe(true);
	expect(fixture.actor.session.isStreaming).toBe(false);
}, 120_000);

test("actor cancellation waits for owned background work without cancelling an unrelated owner", async () => {
	await using fixture = await consumer();
	const jobs = fixture.actor.session.asyncJobManager;
	if (!jobs) throw new Error("Actor fixture requires native async jobs");
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const otherRelease = Promise.withResolvers<void>();
	const jobId = jobs.register(
		"task",
		"owned cancellation probe",
		async ({ signal }) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			entered.resolve();
			await release.promise;
			return "Owned work actually stopped";
		},
		{ ownerId: fixture.actor.id },
	);
	const otherId = jobs.register(
		"task",
		"unrelated owner probe",
		async () => {
			await otherRelease.promise;
			return "Unrelated work completed";
		},
		{ ownerId: "unrelated-fixture-owner" },
	);
	await entered.promise;
	fixture.onRequest(() => fixture.controller.abort());
	let settled = false;
	const request = fixture.request().then(
		value => {
			settled = true;
			return { value, error: undefined };
		},
		error => {
			settled = true;
			return { value: undefined, error };
		},
	);
	try {
		await aborted.promise;
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		expect(settled).toBe(false);
		expect(jobs.getJob(otherId)?.status).toBe("running");
	} finally {
		release.resolve();
		otherRelease.resolve();
	}
	const result = await request;
	expect(result.error).toBeDefined();
	expect(result.value).toBeUndefined();
	await jobs.waitForOwnerJobs("unrelated-fixture-owner");
	expect(jobs.getJob(jobId)?.status).toBe("cancelled");
	expect(jobs.getJob(otherId)?.status).toBe("completed");
}, 120_000);
