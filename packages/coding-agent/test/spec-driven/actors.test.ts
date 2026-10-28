import { expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getRunningSubagentBadgeAgentIds } from "@oh-my-pi/pi-tui/overlays/running-subagent-badge";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { AuthStorage } from "../../src/session/auth-storage";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { cfgCompactionEnabled, cfgCompactionThresholdTokens } from "../../src/session/context-settings";
import { ToolRestrictions } from "../../src/session/tool-restrictions";
import { artifactVersion, SpecArtifactStore } from "../../src/spec-driven/artifacts";
import { cancelSpecDescendantJobs, createSpecActor } from "../../src/spec-driven/actors";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession, type CustomTool } from "../../src/sdk";
import { SessionManager } from "../../src/session/session-manager";
import type { SpecAgentInput, SpecStageRole } from "../../src/spec-driven/types";

async function consumer(
	customTools?: CustomTool[],
	role: SpecStageRole = customTools ? "executor" : "requirements",
	hooks: Pick<
		Parameters<typeof createSpecActor>[0],
		"reportPath" | "observeReport" | "checkApproved" | "getStatus" | "beginRepair" | "recoverContext" | "entryMethods"
	> & {
		toolRestrictions?: ToolRestrictions;
		inheritedToolRestrictions?: ToolRestrictions;
		registry?: AgentRegistry;
	} = {},
) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-actor-compaction-"));
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir);
	let text = '{"value":"prior"}';
	let fail = false;
	let onRequest: ((messages: Array<{ role: string; content?: unknown }>) => void | Promise<void>) | undefined;
	let nativeTool: { name: string; args: Record<string, unknown> } | undefined;
	let advertisedTools: string[] = [];
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
			await onRequest?.(body.messages);
			if (fail)
				return Response.json(
					{
						error: {
							message: "This API key has expired. Create a new API key.",
							type: "authentication_error",
							param: "api_key_expired",
						},
						providerPayload: "private-provider-payload",
					},
					{ status: 401 },
				);
			advertisedTools = (body.tools ?? []).map(tool => tool.function.name.replace(/^_/u, ""));
			const queuedTool = nativeTool;
			nativeTool = undefined;
			const pendingTool = queuedTool ?? customTools?.[0];
			const useTool = queuedTool || (pendingTool && !body.messages.some(message => message.role === "tool"));
			const toolName =
				body.tools?.find(tool => tool.function.name.replace(/^_/u, "") === pendingTool?.name)?.function.name ??
				pendingTool?.name;
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
												id: `actor-call-${crypto.randomUUID()}`,
												type: "function",
												function: { name: toolName, arguments: JSON.stringify(queuedTool?.args ?? {}) },
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
	const parent = hooks.inheritedToolRestrictions
		? (
				await createAgentSession({
					cwd,
					agentDir,
					settings,
					model,
					authStorage,
					modelRegistry,
					toolRestrictions: hooks.inheritedToolRestrictions,
					sessionManager: SessionManager.inMemory(),
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
					bindProcessState: false,
					toolNames: ["read", "write", "edit"],
					restrictToolNames: true,
				})
			).session
		: undefined;
	const createActor = (sessionFile?: string) =>
		createSpecActor({
			role,
			...hooks,
			sessionFile,
			sessionDirectory: path.join(cwd, "sessions"),
			methods: [],
			options: {
				toolRestrictions: hooks.toolRestrictions,
				cwd,
				agentDir,
				settings,
				model,
				authStorage,
				modelRegistry,
				agentRegistry: hooks.registry,
				parentAgentId: parent?.getAgentId(),
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
				toolNames: ["read", "grep", "glob", "write", "edit", ...(role === "executor" ? ["bash"] : [])],
				restrictToolNames: true,
				...(customTools
					? {
							toolNames: customTools.map(tool => tool.name),
							allowRestrictedCustomTools: true,
						}
					: {}),
			},
		});
	let actor = await createActor();
	const controller = new AbortController();
	const context = { runId: "actor-compaction", generation: 1, signal: controller.signal };
	const request = (input: Partial<SpecAgentInput> = {}) =>
		actor.request(
			{
				role,
				entry: true,
				request: "请回复当前阶段结果。",
				files: [],
				outputPaths: [],
				...input,
			},
			context,
		);
	return {
		cwd,
		setNativeTool(name: string, args: Record<string, unknown>) {
			nativeTool = { name, args };
		},
		get advertisedTools() {
			return advertisedTools;
		},
		get actor() {
			return actor;
		},
		async reopen(sessionFile: string) {
			actor = await createActor(sessionFile);
		},
		context,
		controller,
		request,
		setText(value: string) {
			text = value;
		},
		fail() {
			fail = true;
		},
		onRequest(callback: (messages: Array<{ role: string; content?: unknown }>) => void | Promise<void>) {
			onRequest = callback;
		},
		async [Symbol.asyncDispose]() {
			try {
				await actor.dispose();
				await parent?.dispose();
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

test("stage badge follows native turns rather than persistent session lifetime", async () => {
	const registry = new AgentRegistry();
	const registrations: string[] = [];
	registry.onChange(event => {
		if (event.type === "registered") registrations.push(event.ref.status);
	});
	await using fixture = await consumer(undefined, "requirements", { registry });
	const id = fixture.actor.id;
	expect(registrations).toEqual(["idle"]);
	expect(getRunningSubagentBadgeAgentIds(registry)).toEqual([]);

	const runTurn = async (start: () => Promise<unknown>) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fixture.onRequest(async () => {
			entered.resolve();
			await release.promise;
		});
		const running = start();
		try {
			await entered.promise;
			expect(getRunningSubagentBadgeAgentIds(registry)).toEqual([fixture.actor.id]);
		} finally {
			release.resolve();
		}
		await running;
		expect(getRunningSubagentBadgeAgentIds(registry)).toEqual([]);
		expect(registry.get(fixture.actor.id)?.status).toBe("idle");
	};
	await runTurn(() => fixture.request());
	// A focused stage session can also be prompted directly, outside actor.request.
	await runTurn(() => fixture.actor.session.prompt("继续"));
	const sessionFile = fixture.actor.session.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persistent stage transcript");
	await fixture.actor.dispose();
	expect(registry.get(id)).toBeUndefined();
	expect(getRunningSubagentBadgeAgentIds(registry)).toEqual([]);
	await fixture.reopen(sessionFile);
	expect(registrations).toEqual(["idle", "idle"]);
	expect(getRunningSubagentBadgeAgentIds(registry)).toEqual([]);
	await runTurn(() => fixture.request({ entry: false, feedback: "恢复后继续" }));
}, 120_000);

test("actor request retains its current ordinary reply through real native compaction", async () => {
	await using fixture = await consumer();
	for (let index = 0; index < 8; index++) expect(await fixture.request()).toEqual({ text: '{"value":"prior"}' });
	const boundary = fixture.actor.session.messages.length;
	let compactions = 0;
	const unsubscribe = fixture.actor.session.subscribe(event => {
		if (event.type === "auto_compaction_end" && event.result && !event.aborted) compactions++;
	});
	try {
		fixture.setText('{"value":"current"}');
		cfgCompactionThresholdTokens.set(fixture.actor.session.settings, 1);
		cfgCompactionEnabled.set(fixture.actor.session.settings, true);
		expect(await fixture.request()).toEqual({ text: '{"value":"current"}' });
		expect(compactions).toBeGreaterThan(0);
		expect(fixture.actor.session.messages.length).toBeLessThan(boundary);
		expect(fixture.actor.session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
	} finally {
		unsubscribe();
	}
}, 120_000);

test("actor request rejects a current provider failure rather than reusing a prior valid assistant", async () => {
	await using fixture = await consumer();
	expect(await fixture.request()).toEqual({ text: '{"value":"prior"}' });
	fixture.fail();
	const error = await fixture.request().catch(error => error);
	expect(error).toBeInstanceOf(Error);
	if (!(error instanceof Error)) throw new Error("Expected current provider failure");
	expect(error.message).toContain("Native requirements");
	expect(error.message).toContain("401");
	expect(error.message).toContain("This API key has expired. Create a new API key.");
	expect(error.message).not.toContain("private-provider-payload");
}, 120_000);

test("actor request retains the missing-result fallback rather than reusing a prior valid assistant", async () => {
	await using fixture = await consumer();
	expect(await fixture.request()).toEqual({ text: '{"value":"prior"}' });
	const prompt = spyOn(fixture.actor.session, "prompt").mockResolvedValue(true);
	try {
		await expect(fixture.request()).rejects.toThrow("Native requirements produced no successful assistant result");
	} finally {
		prompt.mockRestore();
	}
}, 120_000);

test("executor exposes native Goal without creating or rebuilding it per turn", async () => {
	await using fixture = await consumer(undefined, "executor");
	const create = spyOn(fixture.actor.session.goalRuntime, "createGoal");
	const drop = spyOn(fixture.actor.session.goalRuntime, "dropGoal");
	try {
		await fixture.request();
		await fixture.actor.session.goalRuntime.createGoal({ objective: "Manually enabled objective" });
		await fixture.actor.session.goalRuntime.pauseGoal();
		const id = fixture.actor.session.getGoalModeState()!.goal.id;
		await fixture.request({ entry: false, feedback: "解释当前进度", readOnly: true });
		await fixture.request({ entry: false, feedback: "继续相同任务" });
		expect(fixture.actor.session.getGoalModeState()!.goal.id).toBe(id);
		expect(create).toHaveBeenCalledTimes(1);
		expect(drop).not.toHaveBeenCalled();
		await fixture.actor.stop();
		expect(fixture.actor.session.getGoalModeState()!.goal.id).toBe(id);
		expect(fixture.actor.session.getGoalModeState()!.goal.status).toBe("paused");
		await fixture.actor.dispose();
		expect(drop).not.toHaveBeenCalled();
	} finally {
		create.mockRestore();
		drop.mockRestore();
	}
}, 120_000);

test("same-stage continuation sends raw text and native images to the same session", async () => {
	await using fixture = await consumer();
	const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
	const prompt = spyOn(fixture.actor.session, "prompt").mockResolvedValue(true);
	try {
		// Native busy submission returns admission, not a copied assistant reply.
		Object.defineProperty(fixture.actor.session, "isStreaming", { configurable: true, get: () => true });
		try {
			expect(await fixture.request({ entry: false, feedback: "  保留原文\\n不要重发材料 ", images })).toEqual({
				text: "",
			});
			expect(prompt).toHaveBeenCalledWith(
				"  保留原文\\n不要重发材料 ",
				expect.objectContaining({
					images,
					streamingBehavior: "followUp",
					toolDenylist: [],
				}),
			);
		} finally {
			Reflect.deleteProperty(fixture.actor.session, "isStreaming");
		}
	} finally {
		prompt.mockRestore();
	}
}, 120_000);

test("actor accepts ordinary final prose without requiring JSON or yield", async () => {
	await using fixture = await consumer();
	fixture.setText("需求文件已更新，请确认。");
	expect(await fixture.request()).toEqual({ text: "需求文件已更新，请确认。" });
}, 120_000);

test("restricted requirements actor writes only its allowed native proposal and capability files", async () => {
	await using fixture = await consumer();
	const proposal = "openspec/changes/native-guard/proposal.md";
	const spec = "openspec/changes/native-guard/specs/greeting/spec.md";
	const outputPaths = [proposal, "openspec/changes/native-guard/specs/*/spec.md"];
	for (const file of [proposal, spec]) {
		fixture.setNativeTool("write", { path: file, content: `Allowed ${file}` });
		await fixture.request({ outputPaths });
		expect(await fs.readFile(path.join(fixture.cwd, file), "utf8")).toBe(`Allowed ${file}`);
		expect(new Set(fixture.advertisedTools)).toEqual(new Set(["read", "grep", "glob", "write", "edit"]));
	}
}, 120_000);

test("requirements actor preserves an existing mixed-case native capability while rejecting unsafe paths", async () => {
	await using fixture = await consumer();
	const main = "openspec/specs/area/My_API/spec.md";
	const delta = "openspec/changes/native-guard/specs/area/My_API/spec.md";
	const outputPaths = ["openspec/changes/native-guard/specs/**/spec.md"];
	await fs.mkdir(path.dirname(path.join(fixture.cwd, main)), { recursive: true });
	await fs.writeFile(path.join(fixture.cwd, main), "existing authority");
	fixture.setNativeTool("write", { path: delta, content: "first delta" });
	await fixture.request({ outputPaths });
	expect(await fs.readFile(path.join(fixture.cwd, delta), "utf8")).toBe("first delta");
	fixture.setNativeTool("edit", { path: delta, old_string: "first delta", new_string: "updated delta" });
	await fixture.request({ entry: false, feedback: "更新需求", outputPaths });
	expect(await fs.readFile(path.join(fixture.cwd, delta), "utf8")).toBe("updated delta");
	for (const file of [
		"openspec/changes/native-guard/specs/area/New_API/spec.md",
		"openspec/changes/native-guard/specs/.hidden/spec.md",
		"openspec/changes/native-guard/specs/../outside/spec.md",
		"openspec/changes/other/specs/area/My_API/spec.md",
	]) {
		fixture.setNativeTool("write", { path: file, content: "denied" });
		await fixture.request({ entry: false, feedback: "更新需求", outputPaths });
		expect(fixture.actor.session.messages.findLast(message => message.role === "toolResult")).toMatchObject({
			isError: true,
		});
	}
	expect(await fs.readFile(path.join(fixture.cwd, main), "utf8")).toBe("existing authority");
}, 120_000);

test("mixed-case capability writes reject linked, hard-linked and nonregular delta targets", async () => {
	await using fixture = await consumer();
	const root = "openspec/changes/native-guard/specs";
	const outputPaths = [`${root}/**/spec.md`];
	const businessDir = path.join(fixture.cwd, "business");
	const business = path.join(businessDir, "spec.md");
	await fs.mkdir(businessDir);
	await fs.writeFile(business, "business bytes");
	for (const name of ["Link_API", "Hard_API", "Directory_API"]) {
		const main = path.join(fixture.cwd, "openspec/specs", name, "spec.md");
		await fs.mkdir(path.dirname(main), { recursive: true });
		await fs.writeFile(main, "existing authority");
	}
	for (const name of ["Link_API", "Hard_API", "Directory_API"]) {
		const target = path.join(fixture.cwd, root, name, "spec.md");
		await fs.mkdir(path.join(fixture.cwd, root), { recursive: true });
		if (name === "Link_API")
			await fs.symlink(businessDir, path.dirname(target), process.platform === "win32" ? "junction" : "dir");
		else {
			await fs.mkdir(path.dirname(target), { recursive: true });
			if (name === "Hard_API") await fs.link(business, target);
			else await fs.mkdir(target);
		}
		fixture.setNativeTool("write", { path: `${root}/${name}/spec.md`, content: "denied" });
		await fixture.request({ outputPaths });
		expect(fixture.actor.session.messages.findLast(message => message.role === "toolResult")).toMatchObject({
			isError: true,
		});
	}
	expect(await fs.readFile(business, "utf8")).toBe("business bytes");
}, 120_000);

test("read-only pending acceptance executor cannot mutate even when the provider requests native write", async () => {
	await using fixture = await consumer(undefined, "executor");
	const file = "src/accepted.ts";
	await fs.mkdir(path.join(fixture.cwd, "src"));
	await fs.writeFile(path.join(fixture.cwd, file), "original");
	fixture.setNativeTool("write", { path: file, content: "unauthorized change" });
	await fixture.request({ readOnly: true, outputPaths: [file] });
	expect(await fs.readFile(path.join(fixture.cwd, file), "utf8")).toBe("original");
	expect(new Set(fixture.advertisedTools)).toEqual(new Set(["read", "grep", "glob"]));
}, 120_000);

test("actor request rejects current cancellation despite a prior successful reply", async () => {
	await using fixture = await consumer();
	expect(await fixture.request()).toEqual({ text: '{"value":"prior"}' });
	fixture.setText("这次回复不能被当作成功");
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
		expect(getRunningSubagentBadgeAgentIds(AgentRegistry.global())).toContain(fixture.actor.id);
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
	expect(getRunningSubagentBadgeAgentIds(AgentRegistry.global())).not.toContain(fixture.actor.id);
}, 120_000);

test("actor cancellation reaches an idle child agent's background job", async () => {
	await using fixture = await consumer();
	const jobs = fixture.actor.session.asyncJobManager;
	if (!jobs) throw new Error("Actor fixture requires native async jobs");
	const childId = `actor-child-${crypto.randomUUID()}`;
	const childRef = AgentRegistry.global().register({
		id: childId,
		displayName: "idle child",
		kind: "sub",
		parentId: fixture.actor.id,
		session: null,
	});
	const started = Promise.withResolvers<void>();
	const jobId = jobs.register(
		"task",
		"idle child background work",
		async ({ signal }) => {
			started.resolve();
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			return "stopped";
		},
		{ ownerId: childId },
	);
	try {
		await started.promise;
		fixture.onRequest(() => fixture.controller.abort());
		const request = fixture.request().catch(error => error);
		await request;
		expect(jobs.getJob(jobId)?.status).toBe("cancelled");
	} finally {
		jobs.cancelAll({ ownerId: childId });
		await jobs.waitForOwnerJobs(childId).catch(() => {});
		AgentRegistry.global().unregister(childId, childRef);
	}
}, 120_000);
test("cancellation follows unsettled native job lineage after a child leaves the registry", async () => {
	await using fixture = await consumer();
	const jobs = fixture.actor.session.asyncJobManager!;
	const child = `missing-child-${crypto.randomUUID()}`;
	const childAborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const parentId = jobs.register("task", "parent", async () => "done", {
		ownerId: fixture.actor.id,
		agentId: child,
	});
	const childId = jobs.register(
		"task",
		"child",
		async ({ signal }) => {
			signal.addEventListener("abort", () => childAborted.resolve(), { once: true });
			await release.promise;
			return "done";
		},
		{ ownerId: child, foreground: true },
	);
	await jobs.getJob(parentId)!.promise;
	try {
		const stopping = cancelSpecDescendantJobs(jobs, fixture.actor.id);
		await childAborted.promise;
		expect(jobs.getJob(parentId)?.status).toBe("completed");
		expect(jobs.getJob(childId)?.status).toBe("cancelled");
		release.resolve();
		expect(await stopping).toBe(true);
	} finally {
		release.resolve();
	}
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

test("truthful incomplete report enters read-only acceptance and explicit repair revokes it", async () => {
	let awaitingAcceptance = false;
	let repairCount = 0;
	await using fixture = await consumer(undefined, "executor", {
		reportPath: "report.md",
		getStatus: () => ({ phase: "executing", generation: 0, useTeam: false, awaitingAcceptance }),
		observeReport: () => {
			awaitingAcceptance = true;
		},
		beginRepair: async () => {
			repairCount++;
			awaitingAcceptance = false;
		},
	});
	const report =
		"# 完成报告\n\n## 完成情况\n部分实施。\n\n## 验证结果\n测试失败；审查未运行。\n\n## 未完成项\n修复失败测试并完成审查。\n";
	fixture.setNativeTool("bash", {
		command: `bun -e "require('node:fs').writeFileSync('report.md', ${JSON.stringify(report).replaceAll('"', '\\"')})"`,
	});
	await fixture.request({ entry: false, feedback: "提交报告", outputPaths: ["report.md"] });
	expect(awaitingAcceptance).toBe(true);
	const store = new SpecArtifactStore({
		cwd: fixture.cwd,
		changeId: "incomplete",
		paths: { requirements: [], solution: "solution.json", plan: "plan.md", report: "report.md" },
	});
	const validated = await store.readReport();
	expect(validated.content).toBe(report);
	expect(validated.version).toBe(artifactVersion(Buffer.from(report)));
	fixture.setNativeTool("write", { path: "business.ts", content: "not authorized" });
	await fixture.request({ entry: false, feedback: "解释验证限制" });
	await expect(fs.stat(path.join(fixture.cwd, "business.ts"))).rejects.toThrow();
	fixture.setNativeTool("write", { path: "business.ts", content: "question must not authorize" });
	await fixture.request({ entry: false, feedback: "修复这个错误是否会影响现有调用？先解释，不要改代码" });
	expect(repairCount).toBe(0);
	expect(awaitingAcceptance).toBe(true);
	await expect(fs.stat(path.join(fixture.cwd, "business.ts"))).rejects.toThrow();
	for (const feedback of ["修正这个问题需要改哪些文件", "改正这个错误会影响哪些调用", "不要修复，只解释", "好的"]) {
		fixture.setNativeTool("write", { path: "business.ts", content: "not authorized" });
		await fixture.request({ entry: false, feedback });
		expect(repairCount).toBe(0);
		expect(awaitingAcceptance).toBe(true);
		await expect(fs.stat(path.join(fixture.cwd, "business.ts"))).rejects.toThrow();
	}
	fixture.setNativeTool("write", { path: "business.ts", content: "authorized repair" });
	await fixture.request({ entry: false, feedback: "请修正批准范围内的失败测试" });
	expect(repairCount).toBe(1);
	expect(awaitingAcceptance).toBe(false);
	expect(await fs.readFile(path.join(fixture.cwd, "business.ts"), "utf8")).toBe("authorized repair");
}, 120_000);

test("successful native report write closes autonomous writes without parsing the report, explicit repair reopens only its input", async () => {
	let reports = 0;
	await using fixture = await consumer(undefined, "executor", {
		reportPath: "report.md",
		observeReport: () => {
			reports++;
		},
	});
	fixture.setNativeTool("write", { path: "report.md", content: "Not yet structurally valid" });
	await fixture.request({ entry: false, feedback: "提交报告", outputPaths: ["report.md"] });
	expect(reports).toBe(1);
	fixture.setNativeTool("write", { path: "report.md", content: "Forbidden ordinary change" });
	await fixture.request({ entry: false, feedback: "解释如何修复这个报告", readOnly: false });
	expect(await fs.readFile(path.join(fixture.cwd, "report.md"), "utf8")).toBe("Not yet structurally valid");
	fixture.setNativeTool("write", { path: "report.md", content: "Forbidden negated change" });
	await fixture.request({ entry: false, feedback: "不要修复这个报告", readOnly: false });
	expect(await fs.readFile(path.join(fixture.cwd, "report.md"), "utf8")).toBe("Not yet structurally valid");
	fixture.setNativeTool("write", { path: "report.md", content: "Explicit repair" });
	await fixture.request({ entry: false, feedback: "请修复这个报告", readOnly: false });
	const repairResult = fixture.actor.session.messages.findLast(message => message.role === "toolResult");
	expect(repairResult, JSON.stringify(repairResult)).toMatchObject({ isError: false });
	expect(await fs.readFile(path.join(fixture.cwd, "report.md"), "utf8")).toBe("Explicit repair");
	expect(reports).toBe(2);
	fixture.setNativeTool("write", { path: "english-repair.ts", content: "fixed" });
	await fixture.request({ entry: false, feedback: "Please fix the approved failure" });
	expect(await fs.readFile(path.join(fixture.cwd, "english-repair.ts"), "utf8")).toBe("fixed");
}, 120_000);

test("queued repair authorization starts only when delivered and a new report locks the rest of that same input", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let reports = 0;
	await using fixture = await consumer(undefined, "executor", {
		reportPath: "report.md",
		observeReport: () => {
			reports++;
		},
	});
	fixture.setNativeTool("write", { path: "report.md", content: "first report" });
	await fixture.request({ entry: false, feedback: "提交报告", outputPaths: ["report.md"] });
	let hold = true;
	let repairWrites = 0;
	fixture.onRequest(async messages => {
		if (hold) {
			hold = false;
			entered.resolve();
			await release.promise;
			fixture.setNativeTool("write", { path: "report.md", content: "ordinary must stay blocked" });
		} else if (
			JSON.stringify(messages.findLast(message => message.role === "user")?.content ?? "").includes(
				"修复这个报告中的错误",
			)
		) {
			if (repairWrites++ === 0)
				fixture.setNativeTool("write", { path: "report.md", content: "queued explicit repair" });
			else if (repairWrites === 2)
				fixture.setNativeTool("write", { path: "after-report.ts", content: "must not land in same input" });
		}
	});
	const running = fixture.request({ entry: false, feedback: "仅解释当前报告", readOnly: true });
	try {
		await entered.promise;
		await fixture.request({ entry: false, feedback: "修复这个报告中的错误", readOnly: false });
		expect(fixture.actor.session.getQueuedMessages().followUp).toEqual(["修复这个报告中的错误"]);
		expect(await fs.readFile(path.join(fixture.cwd, "report.md"), "utf8")).toBe("first report");
	} finally {
		release.resolve();
	}
	await running;
	expect(await fs.readFile(path.join(fixture.cwd, "report.md"), "utf8")).toBe("queued explicit repair");
	expect(reports).toBe(2);
	await expect(fs.stat(path.join(fixture.cwd, "after-report.ts"))).rejects.toThrow();
	fixture.onRequest(() => {});
	fixture.setNativeTool("write", { path: "report.md", content: "authorization must not persist" });
	await fixture.request({ entry: false, feedback: "后续普通问题", readOnly: false });
	expect(await fs.readFile(path.join(fixture.cwd, "report.md"), "utf8")).toBe("queued explicit repair");
}, 120_000);

test("busy continuation uses the native follow-up queue and retains restrictions on that input only", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await using fixture = await consumer([
		{
			name: "queue_probe",
			label: "Queue probe",
			description: "Hold an actual native tool turn.",
			parameters: type({}),
			async execute() {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "text" as const, text: "released" }] };
			},
		},
	]);
	const running = fixture.request();
	try {
		await entered.promise;
		expect(await fixture.request({ entry: false, feedback: "仅解释下一步", readOnly: true })).toEqual({ text: "" });
		expect(fixture.actor.session.getQueuedMessages().followUp).toEqual(["仅解释下一步"]);
		const queued = fixture.actor.session.getQueuedInputMessages()[0] as { toolDenylist?: string[] };
		expect(queued.toolDenylist).toContain("write");
		const current = fixture.actor.session.messages.findLast(message => message.role === "user") as {
			toolDenylist?: string[];
		};
		expect(current.toolDenylist).toEqual([]);
	} finally {
		release.resolve();
	}
	await running;
}, 120_000);

test("changed approved bytes block writes while preserving native read-only explanation", async () => {
	await using fixture = await consumer(undefined, "executor", {
		checkApproved: async () => ({ matches: false, changed: [{ path: "approved.md", reason: "changed" }] }),
	});
	fixture.setNativeTool("write", { path: "production.ts", content: "must not land" });
	fixture.setText("批准材料变化，需要重新确认。");
	expect(await fixture.request({ entry: false, feedback: "解释阻塞原因" })).toEqual({
		text: "批准材料变化，需要重新确认。",
	});
	await expect(fs.stat(path.join(fixture.cwd, "production.ts"))).rejects.toThrow();
}, 120_000);

test("closing explicit repair cannot alter accepted material bytes", async () => {
	await using fixture = await consumer(undefined, "executor", {
		getStatus: () => ({
			phase: "executing",
			generation: 0,
			useTeam: false,
			accepted: { files: [{ path: "accepted.md", version: "approved" }], userReply: "验收" },
		}),
	});
	await fs.writeFile(path.join(fixture.cwd, "accepted.md"), "approved bytes");
	fixture.setNativeTool("write", { path: "accepted.md", content: "replacement" });
	await fixture.request({ entry: false, feedback: "修复这个归档错误" });
	expect(await fs.readFile(path.join(fixture.cwd, "accepted.md"), "utf8")).toBe("approved bytes");
}, 120_000);

test("native direct repair revokes report eligibility only at delivered turn start", async () => {
	let awaitingAcceptance = true;
	let repairs = 0;
	await using fixture = await consumer(undefined, "executor", {
		getStatus: () => ({ phase: "executing", generation: 0, useTeam: false, awaitingAcceptance }),
		beginRepair: async () => {
			repairs++;
			awaitingAcceptance = false;
		},
	});
	await fixture.actor.session.prompt("继续实施已批准计划", {
		expandPromptTemplates: false,
		runCommands: false,
	});
	expect(repairs).toBe(1);
	expect(awaitingAcceptance).toBe(false);
}, 120_000);

test("missing-history context is loaded once by actual native input, not preparation", async () => {
	let reads = 0;
	await using fixture = await consumer(undefined, "solution", {
		recoverContext: async () => {
			reads++;
			return "历史不可用；真实正式材料和原始批准";
		},
	});
	expect(reads).toBe(0);
	await fixture.actor.session.prompt("  首次主动续聊  ", { expandPromptTemplates: false, runCommands: false });
	expect(reads).toBe(1);
	await fixture.actor.session.prompt("下一句", { expandPromptTemplates: false, runCommands: false });
	expect(reads).toBe(1);
	const recovery = fixture.actor.session.messages.filter(
		message => message.role === "custom" && message.customType === "dev-history-recovery",
	);
	expect(recovery).toHaveLength(1);
	expect(recovery[0]).toMatchObject({ display: false, content: "历史不可用；真实正式材料和原始批准" });
	expect(
		fixture.actor.session.messages.some(
			message => message.role === "custom" && message.customType === "dev-stage-context",
		),
	).toBe(false);
}, 120_000);

test("entry handoff is hidden native context and ordinary feedback does not replay it", async () => {
	await using fixture = await consumer();
	await fixture.request({
		request: "完整原始需求",
		files: [{ path: "original.md", version: "bytes", content: "# 完整材料" }],
	});
	const session = fixture.actor.session;
	const context = session.messages.filter(
		message => message.role === "custom" && message.customType === "dev-stage-context",
	);
	expect(context).toHaveLength(1);
	expect(context[0]).toMatchObject({ role: "custom", display: false });
	expect(JSON.stringify(context[0])).toContain("# 完整材料");
	const firstUser = session.messages.find(message => message.role === "user");
	expect(JSON.stringify(firstUser)).toContain("完整原始需求");
	expect(JSON.stringify(firstUser)).not.toContain("## Stage request");
	await fixture.request({ entry: false, feedback: "  原文追问  " });
	expect(
		session.messages.filter(message => message.role === "custom" && message.customType === "dev-stage-context"),
	).toHaveLength(1);
	expect(JSON.stringify(session.messages.findLast(message => message.role === "user"))).toContain("  原文追问  ");
}, 120_000);

test("native conversation receives real closing diagnostics as hidden lifecycle facts without rewriting user text", async () => {
	await using fixture = await consumer(undefined, "executor", {
		getStatus: () => ({
			phase: "executing",
			generation: 0,
			useTeam: false,
			blockedReason: "Native archive validation failed: missing config",
			closing: { synced: true },
			accepted: { files: [], userReply: "验收" },
		}),
	});
	await fixture.request({ entry: false, feedback: "  请解释当前真实故障  ", readOnly: true });
	const messages = fixture.actor.session.messages;
	const facts = messages.findLast(
		message => message.role === "custom" && message.customType === "dev-lifecycle-facts",
	);
	expect(facts).toMatchObject({ display: false });
	expect(JSON.stringify(facts)).toContain("Native archive validation failed: missing config");
	expect(JSON.stringify(facts)).toContain("synced");
	const user = messages.findLast(message => message.role === "user");
	expect(JSON.stringify(user)).toContain("  请解释当前真实故障  ");
	expect(JSON.stringify(user)).not.toContain("missing config");
}, 120_000);

test("actor clones the supplied parent tool policy without lifting its denylist", async () => {
	await using fixture = await consumer(undefined, "executor", {
		toolRestrictions: new ToolRestrictions({ denylist: ["write"] }),
	});
	fixture.setNativeTool("write", { path: "denied.ts", content: "blocked by parent" });
	await fixture.request();
	await expect(fs.stat(path.join(fixture.cwd, "denied.ts"))).rejects.toThrow();
}, 120_000);

test("actual new executor entry clears the previous report turn boundary", async () => {
	await using fixture = await consumer(undefined, "executor", { reportPath: "report.md" });
	fixture.setNativeTool("write", { path: "report.md", content: "first report" });
	await fixture.request({ outputPaths: ["report.md"] });
	fixture.setNativeTool("write", { path: "implementation.ts", content: "new approved entry" });
	await fixture.request({ entry: true, outputPaths: ["report.md"] });
	expect(await fs.readFile(path.join(fixture.cwd, "implementation.ts"), "utf8")).toBe("new approved entry");
}, 120_000);

test("explicit closing repair uses native bash for a real filesystem obstruction and checks accepted bytes before and after", async () => {
	let checks = 0;
	let reports = 0;
	let accepted = false;
	await using fixture = await consumer(undefined, "executor", {
		reportPath: "accepted.md",
		observeReport: () => {
			reports++;
		},
		getStatus: () => ({
			phase: "executing",
			generation: 0,
			useTeam: false,
			awaitingAcceptance: accepted,
			...(accepted
				? {
						accepted: { files: [{ path: "accepted.md", version: "approved" }], userReply: "验收" },
						closing: { synced: true },
						blockedReason: "Native archive destination is obstructed",
					}
				: {}),
		}),
		checkApproved: async () => {
			checks++;
			const matches =
				!accepted || (await fs.readFile(path.join(fixture.cwd, "accepted.md"), "utf8")) === "approved bytes";
			return { matches, changed: matches ? [] : ["accepted.md"] };
		},
	});
	fixture.setNativeTool("write", { path: "accepted.md", content: "approved bytes" });
	await fixture.request({ entry: false, feedback: "提交报告", outputPaths: ["accepted.md"] });
	expect(reports).toBe(1);
	accepted = true;
	await fs.writeFile(path.join(fixture.cwd, "accepted.md"), "externally changed bytes");
	await fs.writeFile(path.join(fixture.cwd, "accepted.md"), "approved bytes");
	await fs.writeFile(path.join(fixture.cwd, "obstruction"), "blocks the native destination");
	fixture.setNativeTool("bash", { command: `bun -e "require('node:fs').unlinkSync('obstruction')"` });
	await fixture.request({ entry: false, feedback: "repair closing 明确只移除同步路径障碍，不修改已批准材料" });
	await expect(fs.stat(path.join(fixture.cwd, "obstruction"))).rejects.toThrow();
	expect(await fs.readFile(path.join(fixture.cwd, "accepted.md"), "utf8")).toBe("approved bytes");
	expect(reports).toBe(1);
	expect(checks).toBeGreaterThanOrEqual(2);
}, 120_000);

test("stage inherits an actual SDK embedding root deny policy without an explicit child policy", async () => {
	await using fixture = await consumer(undefined, "executor", {
		inheritedToolRestrictions: new ToolRestrictions({ denylist: ["write"] }),
	});
	fixture.setNativeTool("write", { path: "inherited-denied.ts", content: "must remain denied" });
	await fixture.request();
	await expect(fs.stat(path.join(fixture.cwd, "inherited-denied.ts"))).rejects.toThrow();
}, 120_000);

test("requirements instructions load only for real stage entry, never preparation or follow-up", async () => {
	let reads = 0;
	await using fixture = await consumer(undefined, "requirements", {
		entryMethods: async () => {
			reads++;
			return ["完整原始 OpenSpec instructions"];
		},
	});
	const context = { runId: "lazy-instructions", generation: 1, signal: new AbortController().signal };
	const input: SpecAgentInput = {
		role: "requirements",
		entry: false,
		request: "",
		files: [],
		outputPaths: [],
		feedback: "恢复后澄清",
	};
	expect(reads).toBe(0);
	await fixture.actor.request(input, context);
	expect(reads).toBe(0);
	await fixture.actor.request({ ...input, entry: true, request: "真正阶段进入" }, context);
	expect(reads).toBe(1);
	const handoff = fixture.actor.session.messages.find(
		message => message.role === "custom" && message.customType === "dev-stage-context",
	);
	expect(JSON.stringify(handoff)).toContain("完整原始 OpenSpec instructions");
	await fixture.actor.request(input, context);
	expect(reads).toBe(1);
}, 120_000);

test("missing solution provenance blocks next until a genuine stage reentry establishes its source", async () => {
	await using fixture = await consumer(undefined, "solution");
	const candidates = [{ id: "solo", title: "方案", content: "真实方案" }];
	expect(() => fixture.actor.checkSolutionCandidates(candidates)).toThrow("方案来源无法");
	const context = { runId: "source-reentry", generation: 1, signal: new AbortController().signal };
	await fixture.actor.request(
		{ role: "solution", entry: false, request: "", files: [], outputPaths: [], feedback: "澄清" },
		context,
	);
	expect(() => fixture.actor.checkSolutionCandidates(candidates)).toThrow("方案来源无法");
	await fixture.actor.request(
		{ role: "solution", entry: true, request: "重入", files: [], outputPaths: [], useTeam: false },
		context,
	);
	expect(() => fixture.actor.checkSolutionCandidates(candidates)).not.toThrow();
}, 120_000);

test("stage write allowlist rejects an unrelated exact path even without readOnly and permits its designated output", async () => {
	await using fixture = await consumer(undefined, "planner");
	fixture.setNativeTool("write", { path: "business.ts", content: "must not land" });
	await fixture.request({ outputPaths: ["plan.md"], readOnly: false });
	await expect(fs.stat(path.join(fixture.cwd, "business.ts"))).rejects.toThrow();
	const denied = fixture.actor.session.messages.findLast(message => message.role === "toolResult");
	expect(JSON.stringify(denied)).toContain("未授权的阶段文件写入");
	fixture.setNativeTool("write", { path: "plan.md", content: "designated plan" });
	await fixture.request({ entry: false, feedback: "完善计划", readOnly: false });
	expect(await fs.readFile(path.join(fixture.cwd, "plan.md"), "utf8")).toBe("designated plan");
	fixture.setNativeTool("edit", { path: "plan.md", old_string: "designated plan", new_string: "updated plan" });
	await fixture.request({ entry: false, feedback: "更新计划", readOnly: false });
	expect(await fs.readFile(path.join(fixture.cwd, "plan.md"), "utf8")).toBe("updated plan");
}, 120_000);

test("requirements write cannot follow an allowed capability directory into a business directory", async () => {
	await using fixture = await consumer();
	const business = path.join(fixture.cwd, "src");
	const specs = path.join(fixture.cwd, "openspec/changes/linked-stage/specs");
	await fs.mkdir(business);
	await fs.mkdir(specs, { recursive: true });
	await fs.writeFile(path.join(business, "spec.md"), "business bytes");
	await fs.symlink(business, path.join(specs, "sample"), process.platform === "win32" ? "junction" : "dir");
	fixture.setNativeTool("write", {
		path: "openspec/changes/linked-stage/specs/sample/spec.md",
		content: "unauthorized replacement",
	});
	await fixture.request({ outputPaths: ["openspec/changes/linked-stage/specs/*/spec.md"] });
	expect(await fs.readFile(path.join(business, "spec.md"), "utf8")).toBe("business bytes");
	expect(fixture.actor.session.messages.findLast(message => message.role === "toolResult")).toMatchObject({
		isError: true,
	});
}, 120_000);

test("solution write rejects a dangling linked parent before creating a business file", async () => {
	await using fixture = await consumer(undefined, "solution");
	const business = path.join(fixture.cwd, "not-created");
	await fs.symlink(business, path.join(fixture.cwd, "solutions"), process.platform === "win32" ? "junction" : "dir");
	fixture.setNativeTool("write", { path: "solutions/candidates.json", content: "unauthorized creation" });
	await fixture.request({ outputPaths: ["solutions/candidates.json"] });
	await expect(fs.stat(path.join(business, "candidates.json"))).rejects.toThrow();
	expect(fixture.actor.session.messages.findLast(message => message.role === "toolResult")).toMatchObject({
		isError: true,
	});
}, 120_000);

test("planner edit cannot modify a business file through an allowed hard-linked document", async () => {
	await using fixture = await consumer(undefined, "planner");
	const business = path.join(fixture.cwd, "business.md");
	const plan = path.join(fixture.cwd, "plan.md");
	await fs.writeFile(business, "business bytes");
	await fs.link(business, plan);
	fixture.setNativeTool("edit", { path: "plan.md", old_string: "business bytes", new_string: "unauthorized edit" });
	await fixture.request({ outputPaths: ["plan.md"] });
	expect(await fs.readFile(business, "utf8")).toBe("business bytes");
	expect(await fs.readFile(plan, "utf8")).toBe("business bytes");
	expect(fixture.actor.session.messages.findLast(message => message.role === "toolResult")).toMatchObject({
		isError: true,
	});
}, 120_000);

for (const boundary of ["mismatch", "rejected-check", "accepted", "awaitingAcceptance", "approved"] as const) {
	test(`native spawn guard returns a fail-closed decision for ${boundary}`, async () => {
		await using fixture = await consumer(undefined, "executor", {
			checkApproved: async () => {
				if (boundary === "rejected-check") throw new Error("approval read failed");
				return { matches: boundary !== "mismatch", changed: [] };
			},
			getStatus: () => ({
				phase: "executing",
				generation: 0,
				useTeam: false,
				awaitingAcceptance: boundary === "awaitingAcceptance",
				accepted: boundary === "accepted" ? { files: [], userReply: "验收" } : undefined,
			}),
		});
		const runner = fixture.actor.session.extensionRunner;
		expect(runner).toBeDefined();
		const result = await runner!.emitBeforeSubagentSpawn({
			type: "before_subagent_spawn",
			agent: "task",
			invocationKind: "task",
			patterns: [],
		});
		if (boundary === "approved") expect(result?.block).not.toBe(true);
		else expect(result).toMatchObject({ block: true, reason: expect.any(String) });
	}, 120_000);
}

for (const failure of ["mismatch", "rejected-check"] as const) {
	test(`accepted-material ${failure} after a modifying tool aborts before the next write without hook self-wait`, async () => {
		let modified = false;
		let writes = 0;
		let requests = 0;
		await using fixture = await consumer(
			[
				{
					name: "bash",
					label: "Closing repair",
					description: "Simulate a closing command with an indirect accepted-material side effect.",
					parameters: type({}),
					async execute() {
						writes++;
						modified = true;
						return { content: [{ type: "text" as const, text: "modified accepted material" }] };
					},
				},
			],
			"executor",
			{
				getStatus: () => ({
					phase: "executing",
					generation: 0,
					useTeam: false,
					accepted: { files: [{ path: "accepted.md", version: "approved" }], userReply: "验收" },
				}),
				checkApproved: async () => {
					if (modified && failure === "rejected-check") throw new Error("accepted check failed");
					return { matches: !modified, changed: [] };
				},
			},
		);
		fixture.onRequest(() => {
			requests++;
			if (requests <= 2) fixture.setNativeTool("bash", {});
		});
		await fixture.request({ entry: false, feedback: "repair closing obstruction" }).then(
			() => {},
			() => {},
		);
		expect(modified).toBe(true);
		expect(writes).toBe(1);
		expect(requests).toBe(1);
	}, 120_000);
}
