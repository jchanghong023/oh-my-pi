import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { CURRENT_SESSION_VERSION } from "../../src/session/session-entries";
import { closeSessionIndex } from "../../src/session/session-index";
import { SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import { createSpecDrivenRuntime, type SpecDrivenRuntime } from "../../src/spec-driven/runtime";
import { collectSpecDrivenResources } from "../../src/spec-driven/resource-inventory";
import type { SpecSavedRun } from "../../src/spec-driven/types";
import * as teamOrchestrator from "../../src/team/orchestrator";
import {
	contentText,
	createProviderFixture,
	isScoutProbeRequest,
	rolePayload,
	scoutProbeReply,
} from "./provider-fixture";
import { cfgTeamMembers } from "../../src/team/settings";
import { cfgTaskIsolationEnabled, cfgTaskMaxRecursionDepth } from "../../src/task/settings";
import * as isolationRunner from "../../src/task/isolation-runner";
import { cfgAsyncEnabled } from "../../src/tools/settings";

async function consumer(
	options: Parameters<typeof createProviderFixture>[0] = {},
	setup?: (cwd: string) => Promise<void>,
) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-four-native-"));
	const agentDir = path.join(cwd, ".isolated-agent");
	await fs.mkdir(agentDir);
	const provider = createProviderFixture(options);
	const authStorage = await AuthStorage.create(":memory:");
	let session: AgentSession | undefined;
	let runtime: SpecDrivenRuntime | undefined;
	const dispose = async () => {
		await runtime?.dispose();
		await session?.dispose();
		authStorage.close();
		await provider[Symbol.asyncDispose]();
		HistoryStorage.close();
		closeSessionIndex();
		AgentStorage.close();
		closeModelCache();
		await fs.rm(cwd, { recursive: true, force: true });
	};
	try {
		await setup?.(cwd);
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  spec-fixture:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n      - id: chat-b\n        reasoning: false\n        contextWindow: 1000000\n`,
		);
		const settings = Settings.isolated({
			modelRoles: { default: "spec-fixture/chat-a", smol: "spec-fixture/chat-a" },
			"compaction.enabled": false,
			"prewalk.enabled": false,
			"tools.xdev": false,
			"async.enabled": false,
			"todo.enabled": false,
		});
		const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
		const model = registry.find("spec-fixture", "chat-a");
		if (!model) throw new Error("Local runtime fixture model unavailable");
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			settings,
			model,
			authStorage,
			modelRegistry: registry,
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
		}));
		runtime = await createSpecDrivenRuntime({ session, settings, cwd });
		return {
			cwd,
			settings,
			runtime,
			session,
			registry,
			provider,
			orchestrator: new SpecDrivenOrchestrator(runtime.ports, {
				...runtime.options,
				getUseTeam: () => false,
				persist: async () => {},
			}),
			[Symbol.asyncDispose]: dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

test("preparation creates four persistent native sessions without calling the model", async () => {
	await using fixture = await consumer();
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	await fixture.runtime.ports.artifacts.initialize("prepared-native", context);
	for (const role of ["requirements", "solution", "planner", "executor"] as const) {
		await fixture.runtime.ports.agents.prepare(role, context);
		const native = fixture.runtime.nativeSession(role)!;
		expect(native).toBeDefined();
		await fixture.runtime.ports.agents.prepare(role, context);
		expect(fixture.runtime.nativeSession(role)).toBe(native);
		expect(fixture.runtime.sessionRefs()[role]?.sessionFile).toBe(native.sessionFile);
	}
	expect(fixture.provider.requests).toHaveLength(0);
	expect(new Set(Object.values(fixture.runtime.sessionRefs()).map(ref => ref?.sessionId)).size).toBe(4);
}, 120_000);

test("original request remains in native requirements history, not saved workspace state", async () => {
	await using fixture = await consumer({ reply: () => ({ text: "请补充验收条件。" }) });
	const request = "  原始需求\n保留完整正文和空格  ";
	await fixture.orchestrator.start(request, "native-request");
	expect(fixture.runtime.originalRequest()).toBe(request);
	const saved = fixture.orchestrator.save();
	expect(JSON.stringify(saved)).not.toContain(request);
	expect(saved.sessions.requirements?.sessionFile).toBe(fixture.runtime.nativeSession("requirements")?.sessionFile);
}, 120_000);

test("ordinary solution follow-up never reruns Team or validates missing solution files", async () => {
	await using fixture = await consumer({ reply: () => ({ text: "仍在澄清。" }) });
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	await fixture.runtime.ports.artifacts.initialize("followup-native", context);
	const discussion = spyOn(teamOrchestrator, "runTeamDiscussion");
	try {
		await fixture.runtime.ports.agents.run(
			{
				role: "solution",
				entry: false,
				request: "",
				files: [],
				outputPaths: [],
				useTeam: true,
				feedback: "只解释这个风险",
			},
			context,
		);
		expect(discussion).not.toHaveBeenCalled();
		const user = fixture.runtime.nativeSession("solution")!.messages.findLast(message => message.role === "user");
		expect(JSON.stringify(user)).toContain("只解释这个风险");
		expect(JSON.stringify(user)).not.toContain("## Stage request");
	} finally {
		discussion.mockRestore();
	}
}, 120_000);

test("missing native transcript prepares the stage without model work", async () => {
	await using fixture = await consumer();
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	await fixture.runtime.ports.artifacts.initialize("missing-native-history", context);
	await fixture.runtime.ports.agents.prepare("requirements", context, {
		role: "requirements",
		actorId: "old",
		sessionId: "missing",
		sessionFile: path.join(fixture.cwd, "missing.jsonl"),
	});
	expect(fixture.runtime.nativeSession("requirements")).toBeDefined();
	expect(fixture.runtime.originalRequest()).toBe("");
	expect(fixture.provider.requests).toHaveLength(0);
}, 120_000);

test("missing native history reconstructs real materials and saved approval only on the first active continuation", async () => {
	await using fixture = await consumer({ reply: () => ({ text: "依据正式文件继续澄清。" }) });
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	const paths = await fixture.runtime.ports.artifacts.initialize("recover-real-materials", context);
	const proposal = paths.requirements[0]!;
	await fs.writeFile(path.join(fixture.cwd, proposal), "# 当前正式需求\n正文不得由聊天副本替代");
	await fs.mkdir(path.dirname(path.join(fixture.cwd, paths.solution)), { recursive: true });
	await fs.writeFile(path.join(fixture.cwd, paths.solution), "尚未结构合格的真实方案正文");
	const missingSession = path.join(fixture.cwd, "lost-native.jsonl");
	const saved: SpecSavedRun = {
		runId: context.runId,
		phase: "solution",
		changeId: "recover-real-materials",
		paths,
		approvals: {
			requirements: {
				files: [{ path: proposal, version: "saved-approved-version" }],
				userReply: "  原始批准\n保留空格  ",
			},
		},
		sessions: { solution: { role: "solution", actorId: "old", sessionId: "lost", sessionFile: missingSession } },
	};
	await fixture.runtime.dispose();
	const restored = await createSpecDrivenRuntime({
		session: fixture.session,
		settings: fixture.settings,
		cwd: fixture.cwd,
		saved,
		getSavedRun: () => saved,
	});
	const discussion = spyOn(teamOrchestrator, "runTeamDiscussion");
	try {
		await restored.ports.agents.prepare("solution", context, saved.sessions.solution);
		const native = restored.nativeSession("solution")!;
		expect(fixture.provider.requests).toHaveLength(0);
		expect(native.messages).toHaveLength(0);
		// Preparation did not snapshot bodies; recovery must read what is actually on disk now.
		await fs.writeFile(path.join(fixture.cwd, proposal), "# 当前正式需求\n准备后更新的真实正文");
		await restored.ports.agents.run(
			{
				role: "solution",
				entry: false,
				request: "",
				files: [],
				outputPaths: [paths.solution],
				feedback: "  请依据现有材料继续  ",
				useTeam: true,
			},
			context,
		);
		const recovered = native.messages.filter(
			message => message.role === "custom" && message.customType === "dev-history-recovery",
		);
		expect(recovered).toHaveLength(1);
		const content = JSON.parse((recovered[0] as { content: string }).content);
		expect(content.unavailableSessionFile).toBe(missingSession);
		expect(content.approvals).toEqual(saved.approvals);
		expect(content.materials).toContainEqual(
			expect.objectContaining({ path: proposal, content: "# 当前正式需求\n准备后更新的真实正文" }),
		);
		expect(content.materials).toContainEqual(
			expect.objectContaining({ path: paths.solution, content: "尚未结构合格的真实方案正文" }),
		);
		expect(content.materials).toContainEqual(
			expect.objectContaining({ path: paths.plan, error: expect.any(String) }),
		);
		expect(JSON.stringify(native.messages.findLast(message => message.role === "user"))).toContain(
			"  请依据现有材料继续  ",
		);
		await restored.ports.agents.run(
			{
				role: "solution",
				entry: false,
				request: "",
				files: [],
				outputPaths: [paths.solution],
				feedback: "下一句普通追问",
				useTeam: true,
			},
			context,
		);
		expect(
			native.messages.filter(message => message.role === "custom" && message.customType === "dev-history-recovery"),
		).toHaveLength(1);
		expect(
			native.messages.some(message => message.role === "custom" && message.customType === "dev-stage-context"),
		).toBe(false);
		expect(discussion).not.toHaveBeenCalled();
	} finally {
		discussion.mockRestore();
		await restored.dispose();
	}
}, 120_000);

test("Team receives complete entry materials exactly once and follow-ups reuse the native solution session", async () => {
	await using fixture = await consumer({ reply: () => ({ text: "方案讨论完成。" }) });
	cfgTeamMembers.set(
		fixture.settings,
		Array.from({ length: 4 }, () => "spec-fixture/chat-a"),
	);
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	const paths = await fixture.runtime.ports.artifacts.initialize("team-entry-native", context);
	const discussion = spyOn(teamOrchestrator, "runTeamDiscussion").mockResolvedValue({
		runId: "discussion",
		inputVersion: "v1",
		status: "completed",
		reportMarkdown: "# 真实协作结果",
		interpretationDifferences: [],
		candidates: [
			{
				id: "chosen",
				label: "候选",
				version: "v1",
				proposal: "完整候选方案",
				adoptable: true,
				reviewSucceeded: true,
				recheckSucceeded: true,
				unresolvedBlocking: [],
				conditions: [],
				assumptions: [],
				evidence: [],
			},
			{
				id: "excluded",
				label: "不可采用",
				version: "v1",
				proposal: "不可采用候选",
				adoptable: false,
				reviewSucceeded: false,
				recheckSucceeded: false,
				unresolvedBlocking: [],
				conditions: [],
				assumptions: [],
				evidence: [],
			},
		],
	});
	try {
		const input = {
			role: "solution" as const,
			entry: true,
			request: "完整原始需求",
			files: [{ path: "requirement.md", version: "bytes", content: "# 完整材料\n末尾也必须保留" }],
			outputPaths: ["solution.json"],
			userReply: " 原文批准\n保留 ",
			useTeam: true,
		};
		await fixture.runtime.ports.agents.run(input, context);
		const native = fixture.runtime.nativeSession("solution");
		await fixture.runtime.ports.agents.run({ ...input, entry: false, feedback: "解释风险" }, context);
		expect(fixture.runtime.nativeSession("solution")).toBe(native);
		expect(discussion).toHaveBeenCalledTimes(1);
		expect(JSON.parse(discussion.mock.calls[0]![0].question)).toEqual(input);
		const writeSolution = async (id: string, content: string) => {
			await fs.mkdir(path.dirname(path.join(fixture.cwd, paths.solution)), { recursive: true });
			await fs.writeFile(
				path.join(fixture.cwd, paths.solution),
				JSON.stringify({ candidates: [{ id, title: "候选", content }], recommendedCandidateId: id }),
			);
		};
		await writeSolution("excluded", "不可采用候选");
		await expect(fixture.runtime.ports.artifacts.readSolution(context)).rejects.toThrow("不是本轮 Team 可采用");
		await writeSolution("invented", "完整候选方案");
		await expect(fixture.runtime.ports.artifacts.readSolution(context)).rejects.toThrow("不是本轮 Team 可采用");
		await writeSolution("chosen", "被替换的正文");
		await expect(fixture.runtime.ports.artifacts.readSolution(context)).rejects.toThrow("不是本轮 Team 可采用");
		await writeSolution("chosen", "完整候选方案\n条件与风险补充");
		expect((await fixture.runtime.ports.artifacts.readSolution(context)).candidates[0]!.id).toBe("chosen");
		const saved: SpecSavedRun = {
			runId: context.runId,
			changeId: "team-entry-native",
			phase: "solution",
			paths,
			approvals: {},
			sessions: fixture.runtime.sessionRefs(),
		};
		await fixture.runtime.dispose();
		const restored = await createSpecDrivenRuntime({
			session: fixture.session,
			settings: fixture.settings,
			cwd: fixture.cwd,
			saved,
		});
		try {
			expect((await restored.ports.artifacts.readSolution(context)).candidates[0]!.id).toBe("chosen");
			await writeSolution("excluded", "不可采用候选");
			await expect(restored.ports.artifacts.readSolution(context)).rejects.toThrow("不是本轮 Team 可采用");
			expect(discussion).toHaveBeenCalledTimes(1);
		} finally {
			await restored.dispose();
		}
	} finally {
		discussion.mockRestore();
	}
}, 120_000);

test("solution Team uses the visible session model for participant slots and synthesis", async () => {
	await using fixture = await consumer({ reply: () => ({ text: "方案讨论完成。" }) });
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	await fixture.runtime.ports.artifacts.initialize("team-model-owner", context);
	await fixture.runtime.ports.agents.prepare("solution", context);
	const solution = fixture.runtime.nativeSession("solution")!;
	const selected = fixture.registry.find("spec-fixture", "chat-b");
	if (!selected) throw new Error("Solution fixture model unavailable");
	await solution.setModelTemporary(selected);
	expect(fixture.session.model?.id).toBe("chat-a");
	expect(solution.model?.id).toBe("chat-b");
	const realDiscussion = teamOrchestrator.runTeamDiscussion;
	const calls: Array<{ role: string; modelPattern: string }> = [];
	const discussion = spyOn(teamOrchestrator, "runTeamDiscussion").mockImplementation(options =>
		realDiscussion({
			...options,
			runner: async call => {
				calls.push({ role: call.role, modelPattern: call.modelPattern });
				switch (call.role) {
					case "proposer":
						return {
							ok: true,
							data: {
								proposal: "完整候选方案",
								noViableProposal: false,
								investigationBlockedReason: "",
								keyAssumptions: [],
								risks: [],
								unknowns: [],
								acceptanceCriteria: [],
								ambiguityInterpretations: [],
								evidence: [],
							},
						};
					case "aligner":
						return {
							ok: true,
							data: {
								unifiedUnderstanding: "确认需求",
								acceptanceCriteria: [],
								factDifferences: [],
								interpretationDifferences: [],
							},
						};
					case "reviewer":
						return {
							ok: true,
							data: {
								noSubstantiveIssues: true,
								reviewSummary: "审查完成",
								findings: [],
								blockingResolutions: [],
							},
						};
					case "reviser":
						return {
							ok: true,
							data: {
								revisedProposal: "完整候选方案",
								revisionSummary: "无须修改",
								responses: [],
								reviewFlags: {
									changedCoreDesign: false,
									claimsResolvedBlocking: false,
									newEvidenceChangesAssumptions: false,
									disputesBlockingFinding: false,
								},
							},
						};
					case "synthesizer":
						return {
							ok: true,
							data: {
								reportMarkdown: "## 方案\n完整候选方案。",
								recommendedProposal: "",
								recommendationReason: "",
								recommendationPreconditions: "",
								hardConstraintViolations: [],
							},
						};
					default:
						throw new Error(`Unexpected Team role: ${call.role}`);
				}
			},
		}),
	);
	try {
		const input = {
			role: "solution" as const,
			entry: true,
			request: "完整需求",
			files: [],
			outputPaths: ["solution.json"],
			useTeam: true,
		};
		await fixture.runtime.ports.agents.run(input, context);
		expect(calls.filter(call => call.role === "proposer")).toHaveLength(3);
		expect(calls.some(call => call.role === "aligner")).toBe(true);
		expect(calls.some(call => call.role === "synthesizer")).toBe(true);
		expect(calls.every(call => call.modelPattern === "spec-fixture/chat-b")).toBe(true);
		await fixture.runtime.ports.agents.run({ ...input, entry: false, feedback: "解释风险" }, context);
		expect(fixture.runtime.nativeSession("solution")).toBe(solution);
		expect(discussion).toHaveBeenCalledTimes(1);
	} finally {
		discussion.mockRestore();
	}
}, 120_000);

test("saved session references reopen native history without model calls", async () => {
	await using fixture = await consumer({ reply: () => ({ text: "澄清需求。" }) });
	await fixture.orchestrator.start("原始需求只保存在原生历史", "restored-native");
	const saved = fixture.orchestrator.save();
	const count = fixture.provider.requests.length;
	await fixture.runtime.dispose();
	const restored = await createSpecDrivenRuntime({
		session: fixture.session,
		settings: fixture.settings,
		cwd: fixture.cwd,
		saved,
	});
	try {
		const core = new SpecDrivenOrchestrator(restored.ports, {
			...restored.options,
			getUseTeam: () => false,
			persist: async () => {},
		});
		await core.restore(saved);
		expect(core.status().phase).toBe("requirements");
		expect(restored.originalRequest()).toBe("原始需求只保存在原生历史");
		expect(restored.nativeSession("requirements")?.sessionFile).toBe(saved.sessions.requirements?.sessionFile);
		expect(fixture.provider.requests).toHaveLength(count);
		const native = restored.nativeSession("requirements")!;
		const handoffs = native.messages.filter(
			message => message.role === "custom" && message.customType === "dev-stage-context",
		).length;
		await core.converse("历史有效时直接追问");
		expect(
			native.messages.filter(message => message.role === "custom" && message.customType === "dev-stage-context"),
		).toHaveLength(handoffs);
		expect(
			native.messages.some(message => message.role === "custom" && message.customType === "dev-history-recovery"),
		).toBe(false);
	} finally {
		await restored.dispose();
	}
}, 120_000);

test("archived executing recovery prepares old roles without active change instructions or automatic turns", async () => {
	await using fixture = await consumer({ reply: () => ({ text: "恢复后的只读说明。" }) });
	await fixture.orchestrator.start("归档前的原始需求", "archived-recovery");
	const saved = fixture.orchestrator.save();
	const archivedChangePath = "openspec/changes/archive/2026-10-26-archived-recovery";
	const proposal = saved.paths!.requirements[0]!;
	await fs.writeFile(path.join(fixture.cwd, proposal), "# 真实归档需求");
	await fs.mkdir(path.dirname(path.join(fixture.cwd, archivedChangePath)), { recursive: true });
	await fs.rename(
		path.join(fixture.cwd, "openspec/changes/archived-recovery"),
		path.join(fixture.cwd, archivedChangePath),
	);
	saved.phase = "executing";
	saved.closing = { synced: true, archivedChangePath };
	saved.approvals.executor = { files: [], userReply: "原始验收" };
	const count = fixture.provider.requests.length;
	await fixture.runtime.dispose();
	for (const missing of [false, true]) {
		const recovery = structuredClone(saved);
		if (missing) recovery.sessions.requirements!.sessionFile = path.join(fixture.cwd, "missing-history.jsonl");
		const restored = await createSpecDrivenRuntime({
			session: fixture.session,
			settings: fixture.settings,
			cwd: fixture.cwd,
			saved: recovery,
		});
		try {
			const core = new SpecDrivenOrchestrator(restored.ports, {
				...restored.options,
				getUseTeam: () => false,
				persist: async () => {},
			});
			await core.restore(recovery);
			expect(core.status().phase).toBe("executing");
			expect(core.status().closing).toEqual(saved.closing);
			expect(fixture.provider.requests).toHaveLength(count);
			if (!missing) expect(restored.originalRequest()).toBe("归档前的原始需求");
			else {
				const context = { runId: saved.runId, generation: 1, signal: new AbortController().signal };
				await restored.ports.agents.run(
					{
						role: "requirements",
						entry: false,
						request: "",
						files: [],
						outputPaths: [],
						feedback: "解释归档材料",
					},
					context,
				);
				const native = restored.nativeSession("requirements")!;
				const recovered = native.messages.find(
					message => message.role === "custom" && message.customType === "dev-history-recovery",
				);
				expect(recovered).toBeDefined();
				expect(JSON.stringify(recovered)).toContain("# 真实归档需求");
				expect(JSON.stringify(recovered)).toContain(archivedChangePath);
			}
			const closing = spyOn(restored.ports.artifacts, "close").mockResolvedValue({ archivedChangePath });
			try {
				const requestsBeforeRetry = fixture.provider.requests.length;
				await core.next();
				expect(core.status().phase).toBe("idle");
				expect(closing).toHaveBeenCalledTimes(1);
				expect(closing.mock.calls[0]![0].progress).toEqual(saved.closing);
				expect(fixture.provider.requests).toHaveLength(requestsBeforeRetry);
			} finally {
				closing.mockRestore();
			}
		} finally {
			await restored.dispose();
		}
	}
}, 120_000);

test("stage scout uses native read-only capabilities even when the project overrides scout and the child requests writes", async () => {
	await using fixture = await consumer(
		{ reply: request => scoutProbeReply(request, true) ?? { text: "scout parent completed" } },
		async cwd => {
			await fs.mkdir(path.join(cwd, ".omp/agents"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp/agents/scout.md"),
				"---\nname: scout\ndescription: writable impostor\ntools: read, write, bash, task\n---\nPROJECT_SCOUT_OVERRIDE\n",
			);
			await fs.writeFile(path.join(cwd, "scout-probe.txt"), "scout-visible-bytes");
		},
	);
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	cfgTaskIsolationEnabled.set(fixture.settings, true);
	cfgAsyncEnabled.override(fixture.settings, true);
	await fixture.runtime.ports.artifacts.initialize("scout-boundary", context);
	await fixture.runtime.ports.agents.run(
		{ role: "requirements", entry: true, request: "Inspect the project", files: [], outputPaths: ["proposal.md"] },
		context,
	);
	const childRequests = fixture.provider.requests.filter(isScoutProbeRequest);
	expect(childRequests.length).toBeGreaterThanOrEqual(3);
	for (const request of childRequests) {
		const tools = (request.tools ?? []).map(tool => tool.function?.name.replace(/^_/u, ""));
		expect(tools).toContain("read");
		for (const forbidden of ["write", "edit", "bash", "task", "eval"]) expect(tools).not.toContain(forbidden);
		expect(JSON.stringify(request.messages)).not.toContain("PROJECT_SCOUT_OVERRIDE");
	}
	expect(
		childRequests.some(request =>
			request.messages.some(
				message => message.role === "tool" && contentText(message.content).includes("scout-visible-bytes"),
			),
		),
	).toBe(true);
	for (const forbidden of ["write", "task"]) {
		expect(
			childRequests.some(request =>
				request.messages.some(
					message =>
						message.role === "tool" && contentText(message.content).includes(`Tool ${forbidden} not found`),
				),
			),
		).toBe(true);
	}
	const parent = fixture.provider.requests.find(
		request =>
			rolePayload(request)?.specDrivenRole === "requirements" &&
			request.messages.some(
				message => message.role === "tool" && contentText(message.content).includes("scout-visible-bytes"),
			),
	);
	expect(parent).toBeDefined();
	expect(cfgTaskIsolationEnabled.get(fixture.settings)).toBe(true);
	expect(cfgAsyncEnabled.get(fixture.settings)).toBe(true);
	expect(await fs.readFile(path.join(fixture.cwd, "scout-probe.txt"), "utf8")).toBe("scout-visible-bytes");
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("executor delegates writable work to a native task child within the stage tool boundary", async () => {
	const marker = "OMP_EXECUTOR_WRITE_PROBE";
	let dispatched = false;
	await using fixture = await consumer({
		reply(request) {
			const child = request.messages.some(
				message =>
					message.role === "user" &&
					contentText(message.content).includes(`Complete assignment thoroughly:\n\n${marker}`),
			);
			if (child) {
				if (!request.messages.some(message => message.role === "tool"))
					return {
						tool: { name: "write", args: { i: "Writing probe", path: "probe.txt", content: "child wrote this" } },
					};
				return { text: "wrote the probe" };
			}
			if (rolePayload(request)?.specDrivenRole === "executor" && !dispatched) {
				dispatched = true;
				return {
					tool: {
						name: "task",
						args: {
							i: "Delegating probe",
							context: "Write the probe in the current workspace.",
							tasks: [{ agent: "task", task: marker, solutionSpace: "write one file" }],
						},
					},
				};
			}
			return { text: "finished" };
		},
	});
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	await fixture.runtime.ports.artifacts.initialize("executor-child", context);
	await fixture.runtime.ports.agents.run(
		{ role: "executor", entry: true, request: "Write a probe", files: [], outputPaths: ["completion.md"] },
		context,
	);
	expect(await fs.readFile(path.join(fixture.cwd, "probe.txt"), "utf8")).toBe("child wrote this");
	const child = fixture.provider.requests.find(request =>
		request.messages.some(
			message =>
				message.role === "user" &&
				contentText(message.content).includes(`Complete assignment thoroughly:\n\n${marker}`),
		),
	);
	const tools = (child?.tools ?? []).map(tool => tool.function?.name.replace(/^_/u, ""));
	expect(tools).toContain("write");
	expect(tools).not.toContain("eval");
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("Superpowers discovery and reads follow the executor through recursive task children only", async () => {
	const skill = "requesting-code-review";
	const childMarker = "OMP_EXECUTION_SKILL_CHILD";
	const grandchildMarker = "OMP_EXECUTION_SKILL_GRANDCHILD";
	const scoutMarker = "OMP_REQUIREMENTS_SKILL_SCOUT";
	const ordinaryMarker = "OMP_ORDINARY_SKILL_ROOT";
	const ordinaryChildMarker = "OMP_ORDINARY_SKILL_CHILD";
	const actions = new Set<string>();
	await using fixture = await consumer({
		reply(request) {
			const assignment = (marker: string) =>
				request.messages.some(
					message =>
						message.role === "user" &&
						contentText(message.content).includes(`Complete assignment thoroughly:\n\n${marker}`),
				);
			const role = assignment(grandchildMarker)
				? "grandchild"
				: assignment(childMarker)
					? "child"
					: assignment(scoutMarker)
						? "scout"
						: assignment(ordinaryChildMarker)
							? "ordinary-child"
							: request.messages.some(
										message =>
											message.role === "user" && contentText(message.content).includes(ordinaryMarker),
								  )
								? "ordinary"
								: rolePayload(request)?.specDrivenRole;
			if (!role) return { text: "finished" };
			if (!actions.has(`${role}:read`)) {
				actions.add(`${role}:read`);
				return { tool: { name: "read", args: { i: "Reading skill", path: `skill://${skill}:raw` } } };
			}
			const next =
				role === "ordinary"
					? { marker: ordinaryChildMarker, agent: "task" }
					: role === "requirements"
						? { marker: scoutMarker, agent: "scout" }
						: role === "executor"
							? { marker: childMarker, agent: "task" }
							: role === "child"
								? { marker: grandchildMarker, agent: "task" }
								: undefined;
			if (next && !actions.has(`${role}:task`)) {
				actions.add(`${role}:task`);
				return {
					tool: {
						name: "task",
						args: {
							i: "Delegating skill probe",
							context: "Inspect the skill access boundary.",
							tasks: [{ agent: next.agent, task: next.marker, solutionSpace: "read one skill" }],
						},
					},
				};
			}
			return { text: "probe complete" };
		},
	});
	cfgTaskMaxRecursionDepth.set(fixture.settings, 5);
	await fixture.session.prompt(ordinaryMarker);
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	await fixture.runtime.ports.artifacts.initialize("recursive-skill-visibility", context);
	for (const role of ["requirements", "solution", "planner", "executor"] as const) {
		await fixture.runtime.ports.agents.run(
			{ role, entry: true, request: "Inspect skill access", files: [], outputPaths: ["probe.md"] },
			context,
		);
	}

	for (const role of [
		"ordinary",
		"ordinary-child",
		"requirements",
		"solution",
		"planner",
		"executor",
		"scout",
		"child",
		"grandchild",
	] as const) {
		const marker =
			role === "scout"
				? scoutMarker
				: role === "child"
					? childMarker
					: role === "grandchild"
						? grandchildMarker
						: role === "ordinary-child"
							? ordinaryChildMarker
							: undefined;
		const requests = fixture.provider.requests.filter(request =>
			marker
				? request.messages.some(
						message =>
							message.role === "user" &&
							contentText(message.content).includes(`Complete assignment thoroughly:\n\n${marker}`),
					)
				: role === "ordinary"
					? request.messages.some(
							message => message.role === "user" && contentText(message.content).includes(ordinaryMarker),
						)
					: rolePayload(request)?.specDrivenRole === role,
		);
		expect(requests.length).toBeGreaterThanOrEqual(2);
		const system = requests[0]!.messages
			.filter(message => message.role === "system")
			.map(message => contentText(message.content))
			.join("\n");
		const toolResults = requests.flatMap(request =>
			request.messages.filter(message => message.role === "tool").map(message => contentText(message.content)),
		);
		if (role === "executor" || role === "child" || role === "grandchild") {
			expect(system).toContain(`- ${skill}:`);
			expect(toolResults.some(text => text.includes("# Requesting Code Review"))).toBe(true);
		} else {
			expect(system).not.toContain(`- ${skill}:`);
			expect(toolResults.some(text => text.includes(`Skill access denied: ${skill}`))).toBe(true);
		}
	}
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("executor seance discovers and reads all bundled Superpowers without changing ordinary seance isolation", async () => {
	const { manifest } = await collectSpecDrivenResources(
		path.resolve(import.meta.dir, "../../src/spec-driven/vendor/resources"),
	);
	const skills = manifest.skills.filter(entry => entry.source === "superpowers").map(entry => entry.name);
	expect(skills.length).toBeGreaterThan(0);
	const executorMarker = "OMP_EXECUTOR_SEANCE_SKILLS";
	const ordinaryMarker = "OMP_ORDINARY_SEANCE_SKILLS";
	const ordinaryRoot = "OMP_ORDINARY_SEANCE_ROOT";
	const nextSkill = new Map<string, number>();
	const dispatched = new Set<string>();
	let sourceFile = "";
	let sourceText = "";
	await using fixture = await consumer(
		{
			reply(request) {
				const assignment = (marker: string) =>
					request.messages.some(
						message =>
							message.role === "user" &&
							contentText(message.content).includes(`Complete assignment thoroughly:\n\n${marker}`),
					);
				const seance = assignment(executorMarker)
					? executorMarker
					: assignment(ordinaryMarker)
						? ordinaryMarker
						: undefined;
				if (seance) {
					const index = nextSkill.get(seance) ?? 0;
					if (index < skills.length) {
						nextSkill.set(seance, index + 1);
						return { tool: { name: "read", args: { i: "Reading skill", path: `skill://${skills[index]}:raw` } } };
					}
					return { text: "Historical skill probe complete" };
				}
				const parent =
					rolePayload(request)?.specDrivenRole === "executor"
						? executorMarker
						: request.messages.some(
									message => message.role === "user" && contentText(message.content).includes(ordinaryRoot),
							  )
							? ordinaryMarker
							: undefined;
				if (parent && !dispatched.has(parent)) {
					dispatched.add(parent);
					return {
						tool: {
							name: "task",
							args: {
								i: "Consulting history",
								context: "Inspect the historical skill access boundary.",
								tasks: [
									{
										agent: "seance",
										task: parent,
										solutionSpace: "inspect historical context",
										sourceSession: sourceFile,
										model: ["spec-fixture/chat-a"],
									},
								],
							},
						},
					};
				}
				return { text: "finished" };
			},
		},
		async cwd => {
			sourceFile = path.join(cwd, "source.jsonl");
			sourceText =
				[
					{
						type: "session",
						version: CURRENT_SESSION_VERSION,
						id: "skill-source",
						timestamp: "2026-10-01T00:00:00.000Z",
						cwd,
					},
					{
						type: "message",
						id: "source-user",
						parentId: null,
						timestamp: "2026-10-01T00:00:01.000Z",
						message: { role: "user", content: "Historical source request", timestamp: 1 },
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n") + "\n";
			await fs.writeFile(sourceFile, sourceText);
		},
	);
	await fixture.session.prompt(ordinaryRoot);
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	await fixture.runtime.ports.artifacts.initialize("seance-skill-visibility", context);
	await fixture.runtime.ports.agents.run(
		{ role: "executor", entry: true, request: "Consult history", files: [], outputPaths: ["probe.md"] },
		context,
	);

	const toolSets: string[][] = [];
	for (const [marker, allowed] of [
		[executorMarker, true],
		[ordinaryMarker, false],
	] as const) {
		const requests = fixture.provider.requests.filter(request =>
			request.messages.some(
				message =>
					message.role === "user" &&
					contentText(message.content).includes(`Complete assignment thoroughly:\n\n${marker}`),
			),
		);
		expect(requests.length).toBeGreaterThan(skills.length);
		const first = requests[0]!;
		const last = requests.at(-1)!;
		const system = first.messages
			.filter(message => message.role === "system")
			.map(message => contentText(message.content))
			.join("\n");
		const tools = (first.tools ?? []).map(tool => tool.function?.name.replace(/^_/u, "") ?? "").toSorted();
		toolSets.push(tools);
		expect(tools).toContain("read");
		for (const name of ["write", "bash", "task"]) expect(tools).not.toContain(name);
		const calls = last.messages.flatMap(message => (message.role === "assistant" ? (message.tool_calls ?? []) : []));
		for (const name of skills) {
			if (allowed) expect(system).toContain(`- ${name}:`);
			else expect(system).not.toContain(`- ${name}:`);
			const target = `skill://${name}:raw`;
			const call = calls.find(item => {
				if (
					!isRecord(item) ||
					!isRecord(item.function) ||
					typeof item.function.name !== "string" ||
					typeof item.function.arguments !== "string"
				)
					return false;
				return (
					item.function.name.replace(/^_/u, "") === "read" && JSON.parse(item.function.arguments).path === target
				);
			});
			expect(isRecord(call) && typeof call.id === "string").toBe(true);
			if (!isRecord(call) || typeof call.id !== "string") throw new Error(`Missing read call for ${target}`);
			const result = last.messages.find(message => message.role === "tool" && message.tool_call_id === call.id);
			expect(result).toBeDefined();
			const text = contentText(result?.content);
			if (allowed) {
				expect(text).not.toContain("Skill access denied:");
				expect(parseFrontmatter(text, { source: target, repair: false, level: "off" }).frontmatter.name).toBe(name);
			} else {
				expect(text).toContain(`Skill access denied: ${name}`);
			}
		}
	}
	expect(toolSets[0]).toEqual(toolSets[1]);
	expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
	expect(fixture.provider.failures).toEqual([]);
}, 300_000);

for (const [label, tasks] of [
	["non-scout", [{ agent: "task", task: "Modify the project", solutionSpace: "write" }]],
	[
		"mixed batch",
		[
			{ agent: "scout", task: "Inspect", solutionSpace: "read only" },
			{ agent: "task", task: "Modify", solutionSpace: "write" },
		],
	],
	["tool injection", [{ agent: "scout", task: "Inspect", solutionSpace: "read only", tools: ["write"] }]],
] as const) {
	test(`stage task rejects ${label} before spawning any child`, async () => {
		let issued = false;
		await using fixture = await consumer({
			reply(request) {
				if (!rolePayload(request)) return { text: "unexpected child" };
				if (!issued) {
					issued = true;
					const task = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === "task")?.function;
					if (!task) throw new Error("Stage did not advertise native task");
					return { tool: { name: task.name, args: { i: "Testing stage restrictions", context: "test", tasks } } };
				}
				return { text: "stage continued after rejection" };
			},
		});
		const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
		await fixture.runtime.ports.artifacts.initialize(`reject-${label.replaceAll(" ", "-")}`, context);
		await fixture.runtime.ports.agents.run(
			{ role: "planner", entry: true, request: "Investigate", files: [], outputPaths: ["plan.md"] },
			context,
		);
		const result = fixture.runtime
			.nativeSession("planner")!
			.messages.findLast(message => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(fixture.provider.requests.every(request => rolePayload(request)?.specDrivenRole === "planner")).toBe(true);
		expect(fixture.provider.failures).toEqual([]);
	}, 120_000);
}

test("stage ignores an undeclared batch isolation field without creating a worktree", async () => {
	let issued = false;
	await using fixture = await consumer({
		reply(request) {
			if (isScoutProbeRequest(request)) return { text: "scout completed in the shared checkout" };
			if (!rolePayload(request)) return { text: "stage title" };
			if (!issued) {
				issued = true;
				const task = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === "task")?.function;
				if (!task) throw new Error("Stage did not advertise native task");
				return {
					tool: {
						name: task.name,
						args: {
							i: "Testing stage isolation",
							context: "test",
							tasks: [
								{
									agent: "scout",
									task: "OMP_SPEC_SCOUT_READ_PROBE",
									solutionSpace: "read only",
									isolated: true,
								},
							],
						},
					},
				};
			}
			return { text: "stage continued after scout" };
		},
	});
	cfgTaskIsolationEnabled.set(fixture.settings, true);
	const prepareIsolation = spyOn(isolationRunner, "prepareIsolationContext");
	try {
		const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
		await fixture.runtime.ports.artifacts.initialize("ignored-batch-isolation", context);
		await fixture.runtime.ports.agents.run(
			{ role: "planner", entry: true, request: "Investigate", files: [], outputPaths: ["plan.md"] },
			context,
		);
		const result = fixture.runtime
			.nativeSession("planner")!
			.messages.findLast(message => message.role === "toolResult");
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).toContain("scout completed in the shared checkout");
		expect(fixture.provider.requests.some(isScoutProbeRequest)).toBe(true);
		expect(prepareIsolation).not.toHaveBeenCalled();
		expect(cfgTaskIsolationEnabled.get(fixture.settings)).toBe(true);
		expect(fixture.provider.failures).toEqual([]);
	} finally {
		prepareIsolation.mockRestore();
	}
}, 120_000);

test("stopping a stage aborts and settles its actual in-flight scout without delivering a late result", async () => {
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	await using fixture = await consumer({
		reply: request => scoutProbeReply(request) ?? { text: "late scout parent result" },
		async delay(request, signal) {
			if (!isScoutProbeRequest(request)) return;
			entered.resolve();
			await new Promise<void>(resolve => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			aborted.resolve();
		},
	});
	const context = { runId: fixture.runtime.options.runId, generation: 1, signal: new AbortController().signal };
	await fixture.runtime.ports.artifacts.initialize("stop-scout", context);
	const run = fixture.runtime.ports.agents
		.run({ role: "requirements", entry: true, request: "Inspect", files: [], outputPaths: ["proposal.md"] }, context)
		.then(
			() => undefined,
			error => error,
		);
	await entered.promise;
	await fixture.runtime.stop();
	await aborted.promise;
	expect(await run).toBeDefined();
	const native = fixture.runtime.nativeSession("requirements")!;
	expect(native.isStreaming).toBe(false);
	expect(JSON.stringify(native.messages)).not.toContain("late scout parent result");
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);
