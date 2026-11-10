import { expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { getRunningSubagentBadgeAgentIds } from "@oh-my-pi/pi-tui/overlays/running-subagent-badge";
import { isTaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { sessionFilesFromDisk } from "../../src/internal-urls/registry-helpers";
import { KnowledgeService } from "../../src/knowledge/service";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AuthStorage } from "../../src/session/auth-storage";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { cfgCompactionThresholdTokens } from "../../src/session/context-settings";
import { ToolRestrictions } from "../../src/session/tool-restrictions";
import { createDevNativeActor } from "../../src/spec-driven/actors";
import { ensureSpecDrivenResources, loadSpecDrivenSkill } from "../../src/spec-driven/resources";
import type { CustomTool } from "../../src/sdk";
import { SessionManager } from "../../src/session/session-manager";
import { renderSubagentUserPrompt } from "../../src/task/structured-subagent";
import { contentText, createProviderFixture, type ModelRequest, type Reply } from "./provider-fixture";

async function consumer(
	options: {
		customTools?: CustomTool[];
		toolRestrictions?: ToolRestrictions;
		check?: (name: string, input: unknown) => Promise<void>;
		afterTool?: () => Promise<void>;
		afterStop?: () => Promise<void>;
		xdev?: boolean;
		bundledSkills?: boolean;
		reply?: (request: ModelRequest) => Reply;
	} = {},
) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dev-native-actor-"));
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir);
	let text = "prior ordinary reply";
	let failure = false;
	let queuedTool: Reply["tool"];
	let observe: ((request: ModelRequest) => void | Promise<void>) | undefined;
	const provider = createProviderFixture({
		observe: request => observe?.(request),
		reply: request => {
			if (failure)
				return Response.json(
					{
						error: { message: "This API key has expired. Create a new API key.", type: "authentication_error" },
						privatePayload: "private-provider-payload",
					},
					{ status: 401 },
				);
			if (queuedTool) {
				const tool = queuedTool;
				queuedTool = undefined;
				return { tool };
			}
			if (options.reply) return options.reply(request);
			return { text };
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        input: [text, image]\n        contextWindow: 1000000\n`,
	);
	const overrides = {
		modelRoles: { default: "deepseek/chat-a", smol: "deepseek/chat-a" },
		"compaction.enabled": false,
		"compaction.methodOrder": ["soft"],
		"compaction.keepRecentTokens": 1,
		"compaction.asyncEnabled": false,
		"compaction.autoContinue": false,
		"prewalk.enabled": false,
		"tools.xdev": options.xdev ?? false,
		"todo.enabled": false,
		"task.speculativeLaunch": false,
		"task.isolation.enabled": false,
		"task.maxRecursionDepth": 3,
	};
	const settings = options.xdev
		? await Settings.loadIsolated({ agentDir, cwd, inMemory: true, overrides })
		: Settings.isolated(overrides);
	if (options.xdev) {
		await fs.writeFile(path.join(agentDir, "config.yml"), "mnemopi:\n  noEmbeddings: true\n");
		await fs.writeFile(
			path.join(cwd, "indexed.md"),
			"# Native evidence\nactorindexbeacon complete indexed content\n",
		);
		const knowledge = new KnowledgeService({ agentDir, cwd });
		try {
			await knowledge.init(".", "native-actor");
		} finally {
			await knowledge.close();
		}
	}
	const skills = options.bundledSkills
		? await Promise.all(
				(await ensureSpecDrivenResources()).manifest.skills
					.filter(skill => skill.source === "openspec")
					.map(skill => loadSpecDrivenSkill(skill.source, skill.name)),
			)
		: [];
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = modelRegistry.find("deepseek", "chat-a");
	if (!model) throw new Error("Local native actor fixture model unavailable");
	const registry = new AgentRegistry();
	const jobs = new AsyncJobManager({});
	const createActor = async (sessionFile?: string) =>
		createDevNativeActor({
			name: "requirements",
			context: "Exact native actor context Ω",
			check: options.check ?? (async () => {}),
			afterTool: options.afterTool ?? (async () => {}),
			afterStop: options.afterStop,
			options: {
				cwd,
				agentDir,
				settings,
				model,
				authStorage,
				modelRegistry,
				agentRegistry: registry,
				asyncJobManager: jobs,
				sessionManager: await SessionManager.open(
					sessionFile ?? path.join(cwd, "sessions", `${crypto.randomUUID()}.jsonl`),
					path.join(cwd, "sessions"),
					undefined,
					{ initialCwd: cwd },
				),
				toolRestrictions: options.toolRestrictions,
				contextFiles: [],
				rules: [],
				skills,
				promptTemplates: [],
				slashCommands: [],
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				autoTitle: false,
				offline: true,
				customTools: options.customTools,
				toolNames: [
					"read",
					"write",
					"edit",
					...(options.xdev ? ["task", "knowledge_search"] : []),
					...(options.customTools?.map(tool => tool.name) ?? []),
				],
				restrictToolNames: !options.xdev,
				allowRestrictedCustomTools: true,
			},
		});
	let actor = await createActor();
	return {
		cwd,
		registry,
		jobs,
		provider,
		settings,
		get actor() {
			return actor;
		},
		setText(value: string) {
			text = value;
		},
		fail() {
			failure = true;
		},
		setTool(name: string, args: Record<string, unknown>) {
			queuedTool = { name, args };
		},
		onRequest(callback: typeof observe) {
			observe = callback;
		},
		async reopen(sessionFile: string) {
			actor = await createActor(sessionFile);
		},
		async [Symbol.asyncDispose]() {
			try {
				await actor.dispose();
			} finally {
				await jobs.dispose();
				await modelRegistry.awaitBackgroundRefresh();
				authStorage.close();
				await provider[Symbol.asyncDispose]();
				HistoryStorage.close();
				closeSessionIndex();
				AgentStorage.close();
				closeModelCache();
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	};
}

test("preparing and restoring a native actor defers real bundled skill compression", async () => {
	await using fixture = await consumer({ bundledSkills: true });
	expect(fixture.actor.session.skills.some(skill => skill.name.startsWith("openspec"))).toBe(true);
	fixture.actor.session.getContextBreakdown();
	await Bun.sleep(25);
	expect(fixture.provider.requests).toHaveLength(0);
	const file = fixture.actor.session.sessionFile!;
	await fixture.actor.dispose();
	await fixture.reopen(file);
	fixture.actor.session.getContextBreakdown();
	await Bun.sleep(25);
	expect(fixture.provider.requests).toHaveLength(0);
}, 120_000);

test("stop uses cleanup-only settlement without weakening ordinary tool settlement", async () => {
	let locked = false;
	let toolsSettled = 0;
	let stopsSettled = 0;
	await using fixture = await consumer({
		async afterTool() {
			if (locked) throw new Error("actor boundary is locked");
			toolsSettled++;
		},
		async afterStop() {
			stopsSettled++;
		},
	});
	await fixture.actor.prompt("ordinary authorized input");
	expect(toolsSettled).toBe(1);
	expect(stopsSettled).toBe(0);
	locked = true;
	await fixture.actor.stop();
	expect(toolsSettled).toBe(1);
	expect(stopsSettled).toBe(1);
}, 120_000);

test("canonical native index transport reads indexed content without granting disk or other devices", async () => {
	const restrictions = new ToolRestrictions();
	let unsafeCalls = 0;
	await using fixture = await consumer({
		xdev: true,
		toolRestrictions: restrictions,
		customTools: [
			{
				name: "unsafe_read_device",
				label: "Unsafe read device",
				description: "Not a canonical builtin index",
				parameters: Type.Object({}),
				approval: "read",
				async execute() {
					unsafeCalls++;
					return { content: [{ type: "text", text: "must not execute" }] };
				},
			},
		],
		async check(name) {
			if (name === "write" || name === "edit") throw new Error("Phase write denied");
		},
	});
	const search = spyOn(KnowledgeService.prototype, "searchKnowledge");
	const events: string[] = [];
	const unsubscribe = fixture.actor.session.subscribe(event => {
		if (event.type === "tool_execution_start") events.push(event.toolName);
	});
	try {
		fixture.setTool("write", {
			path: "xd://knowledge_search",
			content: JSON.stringify({ query: "actorindexbeacon", mode: "grep" }),
		});
		await fixture.actor.prompt("read indexed evidence");
		expect(events).toContain("write");
		const results = fixture.actor.session.messages.filter(message => message.role === "toolResult");
		expect(JSON.stringify(results)).toContain("complete indexed content");
		expect(results.some(result => result.toolName === "write" && !result.isError)).toBe(true);
		expect(search).toHaveBeenCalledWith("actorindexbeacon", expect.objectContaining({ mode: "grep" }));
		for (const target of ["business.ts", "xd://unsafe_read_device", "xd://eval", "xd://ast_edit", "xd://missing"]) {
			fixture.setTool("write", { path: target, content: "{}" });
			await fixture.actor.prompt(`deny ${target}`);
			const result = fixture.actor.session.messages.findLast(message => message.role === "toolResult");
			expect(result?.isError).toBe(true);
			expect(JSON.stringify(result)).not.toContain("complete indexed content");
		}
		const release = restrictions.beginInput(["knowledge_search"]);
		try {
			search.mockClear();
			fixture.setTool("write", {
				path: "xd://knowledge_search",
				content: JSON.stringify({ query: "actorindexbeacon", mode: "grep" }),
			});
			await fixture.actor.prompt("inactive index must not gain read admission");
			const denied = fixture.actor.session.messages.findLast(message => message.role === "toolResult");
			if (!denied || denied.role !== "toolResult") throw new Error("Missing caller-policy denial");
			expect(denied.toolName).toBe("write");
			expect(denied.isError).toBe(true);
			expect(contentText(denied.content).trim().length).toBeGreaterThan(0);
			expect(JSON.stringify(denied)).not.toContain("complete indexed content");
			expect(search).not.toHaveBeenCalled();
		} finally {
			release();
		}
		expect(unsafeCalls).toBe(0);
		await expect(fs.stat(path.join(fixture.cwd, "business.ts"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(fixture.provider.failures).toEqual([]);
	} finally {
		unsubscribe();
		search.mockRestore();
	}
}, 120_000);

test("real read-only task descendants retain indexed evidence but cannot edit disk", async () => {
	const marker = "ACTOR_READONLY_INDEX_CHILD";
	const childPrompt = renderSubagentUserPrompt(marker);
	// Tiny-model task labels also receive the assignment, but not the native
	// child's rendered user prompt or its advertised tools.
	const isChild = (request: ModelRequest) =>
		Boolean(request.tools?.length) &&
		request.messages.some(message => message.role === "user" && contentText(message.content).includes(childPrompt));
	let delegated = false;
	const query = { query: "actorindexbeacon", mode: "grep" };
	await using fixture = await consumer({
		xdev: true,
		async check(name) {
			if (name === "write" || name === "edit") throw new Error("Phase write denied");
		},
		reply(request) {
			if (isChild(request)) {
				const indexTool = request.tools?.some(item => item.function?.name.replace(/^_/u, "") === "knowledge_search")
					? "knowledge_search"
					: "write";
				const lookup: NonNullable<Reply["tool"]>[] =
					indexTool === "knowledge_search"
						? [{ name: "knowledge_search", args: query }]
						: [
								{ name: "read", args: { i: "Reading indexed device protocol", path: "xd://knowledge_search" } },
								{
									name: "write",
									args: {
										i: "Querying indexed child evidence",
										path: "xd://knowledge_search",
										content: JSON.stringify(query),
									},
								},
							];
				const tool = [
					...lookup,
					{
						name: "write",
						args: { i: "Attempting denied child edit", path: "child-edit.ts", content: "must not land" },
					},
					{ name: "write", args: { i: "Attempting denied eval device", path: "xd://eval", content: "{}" } },
				][request.messages.filter(message => message.role === "tool").length];
				if (!tool) return { text: "read-only evidence complete" };
				const advertised = request.tools?.find(
					item => item.function?.name === tool.name || item.function?.name === `_${tool.name}`,
				)?.function;
				// Unauthorized attempts still go through the native tool loop.
				return { tool: { ...tool, name: advertised?.name ?? tool.name } };
			}
			if (!delegated) {
				delegated = true;
				return {
					tool: {
						name: "task",
						args: {
							i: "Reading descendant evidence",
							context: "Read indexed evidence without editing files.",
							// Native task tools[] passes eval-defined tools, not a capability allowlist.
							// Scout's registered read-only tool declaration supplies the actual restriction.
							tasks: [
								{
									name: "ReadonlyIndexChild",
									agent: "scout",
									task: marker,
									solutionSpace: "read indexed evidence",
								},
							],
						},
					},
				};
			}
			return { text: "descendant settled" };
		},
	});
	// Only the indexed database retains this evidence during the child's run.
	await fs.rm(path.join(fixture.cwd, "indexed.md"));
	await fixture.actor.prompt("delegate a read-only evidence lookup");
	const taskResult = fixture.actor.session.messages.findLast(
		message => message.role === "toolResult" && message.toolName === "task",
	);
	if (!taskResult || taskResult.role !== "toolResult" || !isTaskToolDetails(taskResult.details))
		throw new Error(`Missing native task result: ${JSON.stringify(taskResult)}`);
	expect(taskResult.isError).not.toBe(true);
	const child = taskResult.details.progress?.find(progress => progress.assignment === marker);
	if (!child || !taskResult.details.async)
		throw new Error(`Missing asynchronous native descendant: ${JSON.stringify(taskResult)}`);
	expect(child.agent).toBe("scout");
	const job = fixture.jobs.getJob(taskResult.details.async.jobId);
	if (!job) throw new Error(`Missing native descendant job: ${taskResult.details.async.jobId}`);
	expect(job.agentId).toBe(child.id);
	expect(job.ownerId).toBe(fixture.actor.id);
	// Dispatch feedback is not completion; settle the real child before reading
	// its canonical transcript and the tool results delivered to its provider.
	await job.promise;
	expect(job.status).toBe("completed");
	expect(job.errorText).toBeUndefined();
	expect(job.resultText).toContain("read-only evidence complete");
	if (!isTaskToolDetails(job.latestDetails))
		throw new Error(`Missing completed descendant details: ${JSON.stringify(job.latestDetails)}`);
	expect(job.latestDetails.progress?.find(progress => progress.id === child.id)).toMatchObject({
		agent: "scout",
		assignment: marker,
		status: "completed",
	});
	const childRef = fixture.registry.get(child.id);
	if (!childRef?.session)
		throw new Error(`Completed native descendant ${child.id} is not retained in its actor's registry`);
	expect(childRef.parentId).toBe(fixture.actor.id);
	// Read the canonical transcript without reviving or replacing the retained child.
	const artifactsDir = fixture.actor.session.sessionManager.getArtifactsDir();
	if (!artifactsDir) throw new Error("Missing native actor artifacts directory");
	const sessionFile = (await sessionFilesFromDisk(artifactsDir, { onlyPreferred: true })).get(child.id);
	if (!sessionFile) throw new Error(`Missing retained native transcript for descendant ${child.id}`);
	const history = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: fixture.cwd,
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	try {
		expect(history.getHeader()?.parentSession).toBe(fixture.actor.session.sessionManager.getSessionFile());
		expect(history.getEntries().find(entry => entry.type === "session_init")).toMatchObject({
			agent: "scout",
			readOnly: true,
		});
		const messages = history.buildSessionContext().messages;
		expect(
			messages.some(message => message.role === "user" && contentText(message.content).includes(childPrompt)),
		).toBe(true);
		const childRequest = fixture.provider.requests.findLast(isChild);
		if (!childRequest) throw new Error(`Missing provider payload for descendant ${child.id}`);
		const indexTool = childRequest.tools?.some(item => item.function?.name.replace(/^_/u, "") === "knowledge_search")
			? "knowledge_search"
			: "write";
		const resultFor = (name: string, args: Record<string, unknown>) => {
			const call = messages
				.flatMap(message => (message.role === "assistant" ? message.content : []))
				.find(
					part =>
						part.type === "toolCall" &&
						part.name.replace(/^_/u, "") === name &&
						Object.entries(args).every(([key, value]) => part.arguments[key] === value),
				);
			if (!call || call.type !== "toolCall")
				throw new Error(`Missing native ${name} call ${JSON.stringify(args)} in descendant ${child.id}`);
			const result = messages.find(message => message.role === "toolResult" && message.toolCallId === call.id);
			if (!result || result.role !== "toolResult")
				throw new Error(`Missing native ${name} result ${JSON.stringify(args)} in descendant ${child.id}`);
			const delivered = childRequest.messages.find(
				message => message.role === "tool" && message.tool_call_id === result.toolCallId,
			);
			if (!delivered)
				throw new Error(`Missing provider ${name} result ${JSON.stringify(args)} in descendant ${child.id}`);
			expect(contentText(delivered.content)).toContain(contentText(result.content));
			return result;
		};
		if (indexTool === "write") expect(resultFor("read", { path: "xd://knowledge_search" }).isError).not.toBe(true);
		const indexed =
			indexTool === "knowledge_search"
				? resultFor("knowledge_search", query)
				: resultFor("write", { path: "xd://knowledge_search", content: JSON.stringify(query) });
		if (indexed.isError)
			throw new Error(
				`Native scout ${child.id} could not query indexed evidence: ${JSON.stringify({
					result: indexed,
					advertisedTools: childRequest.tools?.map(tool => tool.function?.name),
					init: history.getEntries().find(entry => entry.type === "session_init"),
				})}`,
			);
		expect(contentText(indexed.content)).toContain("actorindexbeacon complete indexed content");
		if (indexTool === "write")
			expect(indexed.details).toMatchObject({
				xdev: { tool: "knowledge_search", mode: "execute", args: query },
			});
		expect(resultFor("write", { path: "child-edit.ts" }).isError).toBe(true);
		expect(resultFor("write", { path: "xd://eval" }).isError).toBe(true);
		expect(
			childRequest.messages.some(
				message =>
					message.role === "tool" &&
					contentText(message.content).includes("actorindexbeacon complete indexed content"),
			),
		).toBe(true);
		await expect(fs.stat(path.join(fixture.cwd, "child-edit.ts"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await history.close();
	}
	// A completed receipt is not resource disposal: the retained child still owns
	// its indexed worker until the actor explicitly releases its lifecycle tree.
	await fixture.actor.dispose();
	expect(fixture.registry.get(child.id)).toBeUndefined();
	expect(fixture.registry.get(fixture.actor.id)).toBeUndefined();
	expect(fixture.jobs.getUnsettledJobs()).toEqual([]);
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("native actor badge tracks real turns and restored idle sessions", async () => {
	await using fixture = await consumer();
	expect(fixture.registry.get(fixture.actor.id)?.status).toBe("idle");
	expect(getRunningSubagentBadgeAgentIds(fixture.registry)).toEqual([]);
	const turn = async (start: () => Promise<unknown>) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fixture.onRequest(async () => {
			entered.resolve();
			await release.promise;
		});
		const running = start();
		try {
			await entered.promise;
			expect(getRunningSubagentBadgeAgentIds(fixture.registry)).toEqual([fixture.actor.id]);
		} finally {
			release.resolve();
		}
		await running;
		expect(getRunningSubagentBadgeAgentIds(fixture.registry)).toEqual([]);
		expect(fixture.registry.get(fixture.actor.id)?.status).toBe("idle");
	};
	await turn(() => fixture.actor.prompt("first native turn"));
	await turn(() => fixture.actor.session.prompt("direct native turn"));
	const id = fixture.actor.id;
	const file = fixture.actor.session.sessionFile!;
	await fixture.actor.dispose();
	expect(fixture.registry.get(id)).toBeUndefined();
	await fixture.reopen(file);
	expect(fixture.actor.session.sessionFile).toBe(file);
	expect(getRunningSubagentBadgeAgentIds(fixture.registry)).toEqual([]);
	await turn(() => fixture.actor.prompt("restored continuation"));
}, 120_000);

test("native actor keeps the current ordinary reply through real compaction", async () => {
	await using fixture = await consumer();
	const breakdown = fixture.actor.session.getContextBreakdown();
	if (!breakdown) throw new Error("Native actor context breakdown unavailable");
	const fixedTokens =
		breakdown.systemPromptTokens +
		breakdown.systemToolsTokens +
		breakdown.systemContextTokens +
		breakdown.skillsTokens;
	// A one-token threshold is below the immutable prompt/schema budget, so
	// native maintenance correctly refuses that impossible recovery target.
	const threshold = fixedTokens * 2 + 1_024;
	const prior = "Historical conversation detail. ".repeat(Math.ceil(threshold / 24));
	for (let index = 0; index < 8; index++) await fixture.actor.prompt(`prior ${index}: ${prior}`);
	const boundary = fixture.actor.session.messages.length;
	let compactions = 0;
	const unsubscribe = fixture.actor.session.subscribe(event => {
		if (event.type === "auto_compaction_end" && event.result && !event.aborted) compactions++;
	});
	try {
		fixture.setText("current ordinary reply, no JSON or yield required");
		cfgCompactionThresholdTokens.override(fixture.actor.session.settings, threshold);
		expect(cfgCompactionThresholdTokens.get(fixture.actor.session.settings)).toBe(threshold);
		fixture.actor.session.setAutoCompactionEnabled(true);
		expect(fixture.actor.session.autoCompactionEnabled).toBe(true);
		await fixture.actor.prompt("current turn");
		expect(
			JSON.stringify(fixture.actor.session.messages.findLast(message => message.role === "assistant")),
		).toContain("current ordinary reply");
		expect(compactions).toBeGreaterThan(0);
		expect(fixture.actor.session.messages.length).toBeLessThan(boundary);
		expect(fixture.actor.session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
	} finally {
		unsubscribe();
	}
}, 120_000);

test("current provider rejection never reuses a previous successful assistant", async () => {
	await using fixture = await consumer();
	await fixture.actor.prompt("successful turn");
	fixture.fail();
	const error = await fixture.actor.prompt("failing turn").catch(error => error);
	expect(error).toBeInstanceOf(Error);
	expect(error.message).toContain("401");
	expect(error.message).toContain("This API key has expired");
	expect(error.message).not.toContain("private-provider-payload");
}, 120_000);

test("ordinary native continuation preserves raw user text and images in the same history", async () => {
	await using fixture = await consumer();
	await fixture.actor.prompt("first input");
	const id = fixture.actor.session.sessionId;
	const raw = "  保留原文\n完整后续意见 Ω  ";
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
	await fixture.actor.session.prompt(raw, { images: [{ type: "image", data: image, mimeType: "image/png" }] });
	expect(fixture.actor.session.sessionId).toBe(id);
	const user = fixture.actor.session.messages.findLast(message => message.role === "user");
	expect(contentText(user?.content)).toBe(raw);
	const deliveredImage = Array.isArray(user?.content) ? user.content.find(part => part.type === "image") : undefined;
	if (!deliveredImage || deliveredImage.type !== "image") throw new Error("Native user history lost its image");
	const providerInput = fixture.provider.requests
		.at(-1)
		?.messages.findLast(message => message.role === "user" && contentText(message.content) === raw);
	expect(providerInput).toBeDefined();
	expect(providerInput?.content).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "image_url",
				image_url: expect.objectContaining({
					url: `data:${deliveredImage.mimeType};base64,${deliveredImage.data}`,
				}),
			}),
		]),
	);
}, 120_000);

test("native Goal is user-owned and survives continuation and stop without recreation", async () => {
	await using fixture = await consumer();
	await fixture.actor.prompt("ordinary turn");
	expect(fixture.actor.session.getGoalModeState()?.enabled).not.toBe(true);
	await fixture.actor.session.goalRuntime.createGoal({ objective: "Manually enabled objective" });
	await fixture.actor.session.goalRuntime.pauseGoal();
	const id = fixture.actor.session.getGoalModeState()!.goal.id;
	await fixture.actor.prompt("explain progress");
	await fixture.actor.prompt("continue same task");
	expect(fixture.actor.session.getGoalModeState()!.goal.id).toBe(id);
	await fixture.actor.stop();
	expect(fixture.actor.session.getGoalModeState()!.goal.id).toBe(id);
	expect(fixture.actor.session.getGoalModeState()!.goal.status).toBe("paused");
}, 120_000);

test("canonical actor restrictions preserve embedding denylists and enforce the live boundary", async () => {
	const checked: string[] = [];
	let frozen = false;
	await using fixture = await consumer({
		toolRestrictions: new ToolRestrictions({ denylist: ["write"] }),
		async check(name) {
			checked.push(name);
			if (frozen && name !== "dev-input") throw new Error("whole group frozen");
		},
	});
	fixture.setTool("write", { path: "denied.md", content: "must not land" });
	await fixture.actor.prompt("try denied write");
	await expect(fs.stat(path.join(fixture.cwd, "denied.md"))).rejects.toMatchObject({ code: "ENOENT" });
	await fs.writeFile(path.join(fixture.cwd, "existing.md"), "existing bytes");
	frozen = true;
	fixture.setTool("read", { path: "existing.md" });
	await fixture.actor.prompt("try frozen tool");
	expect(checked).toContain("dev-input");
	expect(checked).toContain("read");
	expect(JSON.stringify(fixture.actor.session.messages)).toContain("whole group frozen");
	expect(await fs.readFile(path.join(fixture.cwd, "existing.md"), "utf8")).toBe("existing bytes");
}, 120_000);

test("native follow-up queue delivers exact input without overlapping actor submissions", async () => {
	await using fixture = await consumer();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let first = true;
	fixture.onRequest(async () => {
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
		}
	});
	const running = fixture.actor.prompt("active input");
	try {
		await entered.promise;
		await expect(fixture.actor.prompt("overlapping actor input")).rejects.toThrow();
		await fixture.actor.session.prompt("  queued native feedback Ω  ", { streamingBehavior: "followUp" });
	} finally {
		release.resolve();
	}
	await running;
	expect(
		fixture.actor.session.messages
			.filter(message => message.role === "user")
			.map(message => contentText(message.content)),
	).toContain("  queued native feedback Ω  ");
	expect(fixture.actor.session.isStreaming).toBe(false);
}, 120_000);

test("actor stop waits for actual native tool cleanup and rejects late completion", async () => {
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let cleaned = false;
	await using fixture = await consumer({
		customTools: [
			{
				name: "blocking_probe",
				label: "Blocking probe",
				description: "Wait for external cleanup",
				parameters: Type.Object({}),
				async execute(_id, _params, _update, _context, signal) {
					signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
					entered.resolve();
					await release.promise;
					cleaned = true;
					return { content: [{ type: "text", text: "late tool completion" }] };
				},
			},
		],
	});
	fixture.setTool("blocking_probe", {});
	const running = fixture.actor.prompt("start blocking operation").catch(error => error);
	await entered.promise;
	let stopped = false;
	const stopping = fixture.actor.stop().then(() => {
		stopped = true;
	});
	try {
		await aborted.promise;
		await Promise.resolve();
		expect(stopped).toBe(false);
		expect(cleaned).toBe(false);
	} finally {
		release.resolve();
	}
	await stopping;
	expect(await running).toBeInstanceOf(Error);
	expect(cleaned).toBe(true);
	expect(fixture.actor.session.isStreaming).toBe(false);
	await expect(fixture.actor.prompt("late input")).rejects.toThrow();
}, 120_000);

test("actor stop settles idle recursive descendants without cancelling unrelated owners", async () => {
	await using fixture = await consumer();
	const child = `child-${crypto.randomUUID()}`;
	const grandchild = `grandchild-${crypto.randomUUID()}`;
	fixture.registry.register({ id: child, displayName: child, kind: "sub", parentId: fixture.actor.id, session: null });
	fixture.registry.register({ id: grandchild, displayName: grandchild, kind: "sub", parentId: child, session: null });
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const unrelatedRelease = Promise.withResolvers<void>();
	const owned = fixture.jobs.register(
		"task",
		"idle descendant work",
		async ({ signal }) => {
			entered.resolve();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await release.promise;
			return "settled";
		},
		{ ownerId: grandchild },
	);
	const unrelated = fixture.jobs.register(
		"task",
		"unrelated work",
		async () => {
			await unrelatedRelease.promise;
			return "unrelated";
		},
		{ ownerId: "unrelated-owner" },
	);
	await entered.promise;
	let returned = false;
	const stopping = fixture.actor.stop().then(() => {
		returned = true;
	});
	try {
		await aborted.promise;
		expect(fixture.jobs.getJob(owned)?.status).toBe("cancelled");
		expect(fixture.jobs.getJob(owned)?.endTime).toBeUndefined();
		expect(fixture.jobs.getJob(unrelated)?.status).toBe("running");
		expect(returned).toBe(false);
	} finally {
		release.resolve();
	}
	await stopping;
	expect(fixture.jobs.getJob(owned)?.endTime).toBeDefined();
	unrelatedRelease.resolve();
	await fixture.jobs.waitForOwnerJobs("unrelated-owner");
}, 120_000);

test("actor stop follows durable job lineage after a child leaves the registry", async () => {
	await using fixture = await consumer();
	const missingChild = `missing-${crypto.randomUUID()}`;
	const aborted = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let childSettled = false;
	const release = Promise.withResolvers<void>();
	const parent = fixture.jobs.register("task", "completed parent", async () => "done", {
		ownerId: fixture.actor.id,
		agentId: missingChild,
	});
	const child = fixture.jobs.register(
		"task",
		"unregistered child",
		async ({ signal }) => {
			entered.resolve();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await release.promise;
			childSettled = true;
			return "settled";
		},
		{ ownerId: missingChild, foreground: true },
	);
	const parentJob = fixture.jobs.getJob(parent);
	if (!parentJob) throw new Error("Registered parent job is unavailable before completion");
	await parentJob.promise;
	await entered.promise;
	expect(fixture.jobs.getAgentParentLinks().get(missingChild)).toBe(fixture.actor.id);
	let stopped = false;
	const stopping = fixture.actor.stop().then(() => {
		stopped = true;
	});
	try {
		await aborted.promise;
		expect(childSettled).toBe(false);
		expect(stopped).toBe(false);
		expect(fixture.jobs.getJob(child)?.endTime).toBeUndefined();
		expect(fixture.jobs.getJob(child)?.status).toBe("cancelled");
	} finally {
		release.resolve();
	}
	await stopping;
	expect(childSettled).toBe(true);
	expect(fixture.jobs.getJob(child)?.endTime).toBeDefined();
}, 120_000);
