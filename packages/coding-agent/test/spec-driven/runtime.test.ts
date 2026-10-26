import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import { createSpecDrivenRuntime, type SpecDrivenRuntime } from "../../src/spec-driven/runtime";
import * as teamOrchestrator from "../../src/team/orchestrator";
import type { TeamRunResult } from "../../src/team/types";
import { cfgTeamMembers } from "../../src/team/settings";
import {
	createProviderFixture,
	MARKER,
	REQUIREMENT,
	SOLUTION,
	respond,
	rolePayload,
	type ModelRequest,
	type Reply,
} from "./provider-fixture";

async function consumer(options: Parameters<typeof createProviderFixture>[0] = {}) {
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
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  spec-fixture:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n`,
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
			provider,
			orchestrator: new SpecDrivenOrchestrator(runtime.ports, runtime.options),
			[Symbol.asyncDispose]: dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

function lastInput(requests: ModelRequest[], role: string) {
	return requests.map(rolePayload).findLast(item => item?.specDrivenRole === role)?.input;
}

test("four real SDK actors write files, preserve full choice input and wait for acceptance", async () => {
	await using fixture = await consumer();
	const flow = fixture.orchestrator;
	let status = await flow.start(`${MARKER}: ${REQUIREMENT}`, "runtime-files");
	expect(status.phase, status.blockedReason).toBe("awaiting-specification");
	const requirementsActor = flow.recipient();
	status = await flow.confirmSpecification(" 原始需求确认\n保留原文 ");
	expect(status.phase, status.blockedReason).toBe("awaiting-choice");
	const fullSolution = status.solution!.content;
	const rawChoice = "  选用 pure，完整方案原文照办\n不要删去其他候选。  ";
	status = await flow.chooseCandidate("pure", rawChoice);
	expect(status.phase, status.blockedReason).toBe("awaiting-plan");
	const planner = lastInput(fixture.provider.requests, "planner");
	expect(planner?.userReply).toBe(rawChoice);
	expect(planner?.candidateId).toBe("pure");
	expect(JSON.stringify(planner?.files)).toContain("normalizer");
	expect(JSON.stringify(planner?.files)).toContain(JSON.stringify(fullSolution));
	status = await flow.confirmPlan("确认此完整计划");
	expect(status.phase, status.blockedReason).toBe("awaiting-acceptance");
	expect(await fs.readFile(path.join(fixture.cwd, "src/greeting.ts"), "utf8")).toContain("export function greet");
	const paths = status.paths!;
	const materialDirectory = path.join(fixture.cwd, path.dirname(paths.plan));
	expect((await fs.readdir(materialDirectory)).sort()).toEqual(
		[paths.solution, paths.plan, paths.report].map(file => path.basename(file)).sort(),
	);
	const executionBytes = await Promise.all(
		[paths.solution, paths.plan, paths.report].map(file => fs.readFile(path.join(fixture.cwd, file), "utf8")),
	);
	expect(
		new Set(
			fixture.provider.requests
				.map(rolePayload)
				.filter(Boolean)
				.map(item => item!.specDrivenRole),
		),
	).toEqual(new Set(["requirements", "solution", "planner", "executor"]));
	expect(requirementsActor?.actorId).not.toBe(flow.recipient()?.actorId);
	status = await flow.accept();
	expect(status.phase, status.blockedReason).toBe("completed");
	expect(status.archivedChangePath).toContain("openspec/changes/archive/");
	expect(
		await Promise.all(
			[paths.solution, paths.plan, paths.report].map(file => fs.readFile(path.join(fixture.cwd, file), "utf8")),
		),
	).toEqual(executionBytes);
	expect(fixture.provider.failures).toEqual([]);
}, 120_000);

test("missing actual stage files never advance from successful chat text", async () => {
	await using fixture = await consumer({ fileFailure: { role: "requirements", kind: "missing" } });
	const status = await fixture.orchestrator.start(`${MARKER}: ${REQUIREMENT}`, "missing-files");
	expect(status.phase).toBe("requirements");
	expect(status.blockedReason).toBeTruthy();
}, 120_000);

test("requirements and solution Wiki access never permits native writes to production code", async () => {
	const attempted = new Set<string>();
	const attack = (request: ModelRequest): Reply => {
		const role = rolePayload(request)?.specDrivenRole;
		if ((role === "requirements" || role === "solution") && !attempted.has(role)) {
			attempted.add(role);
			const write = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "write")?.function?.name;
			if (!write) throw new Error("Native write must be advertised for actual stage files");
			return {
				tool: {
					name: write,
					args: { path: `src/unauthorized-${role}.ts`, content: "export const unauthorized = true;" },
				},
			};
		}
		return respond(request);
	};
	await using fixture = await consumer({ reply: attack });
	let status = await fixture.orchestrator.start(`${MARKER}: ${REQUIREMENT}`, "guarded-files");
	expect(status.phase, status.blockedReason).toBe("awaiting-specification");
	status = await fixture.orchestrator.confirmSpecification();
	expect(status.phase, status.blockedReason).toBe("awaiting-choice");
	for (const role of ["requirements", "solution"]) {
		await expect(fs.stat(path.join(fixture.cwd, "src", `unauthorized-${role}.ts`))).rejects.toThrow();
		const request = fixture.provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === role)!;
		expect(JSON.stringify(request.messages)).toContain("未授权的阶段文件写入");
	}
	expect(attempted).toEqual(new Set(["requirements", "solution"]));
}, 120_000);

function discussionResult(adoptable = true): TeamRunResult {
	return {
		runId: "discussion-fixture",
		inputVersion: "confirmed-requirements",
		status: "completed",
		reportMarkdown: "# 完整 Team 报告\n所有原始方向与审查记录。",
		interpretationDifferences: [],
		candidates: SOLUTION.candidates.map(candidate => ({
			id: candidate.id,
			label: candidate.title,
			version: "reviewed-proposal",
			proposal: candidate.content,
			adoptable,
			reviewSucceeded: adoptable,
			recheckSucceeded: adoptable,
			unresolvedBlocking: [],
			conditions: [],
			assumptions: [],
			evidence: [],
		})),
	};
}

test("Team opt-in supplies complete originals and real configured participants, then keeps the solution actor and choice gate", async () => {
	const discussion = spyOn(teamOrchestrator, "runTeamDiscussion").mockResolvedValue(discussionResult());
	try {
		await using fixture = await consumer();
		cfgTeamMembers.set(
			fixture.settings,
			Array.from({ length: 4 }, () => "spec-fixture/chat-a"),
		);
		let status = await fixture.orchestrator.start(`${MARKER}: ${REQUIREMENT}`, "team-solutions");
		const original = status.specification!.files;
		const approval = " 原始需求确认\n所有条件保持 ";
		status = await fixture.orchestrator.confirmSpecification(approval, { useTeam: true });
		expect(status.phase, status.blockedReason).toBe("awaiting-choice");
		expect(discussion).toHaveBeenCalledTimes(1);
		const call = discussion.mock.calls[0]![0];
		expect(JSON.parse(call.question).files).toEqual(original);
		expect(JSON.parse(call.question).userReply).toBe(approval);
		expect(call.participants).toHaveLength(4);
		expect(call.participants.every(member => member.modelPattern.includes("spec-fixture/chat-a"))).toBe(true);
		expect(typeof call.runner).toBe("function");
		expect(call.signal.aborted).toBe(false);
		const actor = fixture.orchestrator.recipient();
		expect(actor?.role).toBe("solution");
		expect(JSON.stringify(fixture.provider.requests)).toContain("完整 Team 报告");
		status = await fixture.orchestrator.answer("请解释风险，并保留所有候选");
		expect(status.phase, status.blockedReason).toBe("awaiting-choice");
		expect(fixture.orchestrator.recipient()?.actorId).toBe(actor?.actorId);
		expect(discussion).toHaveBeenCalledTimes(2);
		expect(JSON.parse(discussion.mock.calls[1]![0].question).feedback).toBe("请解释风险，并保留所有候选");
		expect(fixture.session.getGoalModeState()).toBeUndefined();
	} finally {
		discussion.mockRestore();
	}
}, 120_000);

test("failed Team and ineligible directions never become usable solo candidates", async () => {
	const discussion = spyOn(teamOrchestrator, "runTeamDiscussion");
	try {
		let smuggleIneligible = false;
		await using fixture = await consumer({
			reply(request) {
				const reply = respond(request);
				if (
					smuggleIneligible &&
					rolePayload(request)?.specDrivenRole === "solution" &&
					reply.tool?.name.replace(/^_/u, "") === "write"
				)
					reply.tool.args.content = JSON.stringify(SOLUTION);
				return reply;
			},
		});
		await fixture.orchestrator.start(`${MARKER}: ${REQUIREMENT}`, "team-failure");
		discussion.mockResolvedValueOnce({ ...discussionResult(), status: "failed", failureReason: "review failed" });
		await expect(fixture.orchestrator.confirmSpecification("确认", { useTeam: true })).rejects.toThrow(
			"review failed",
		);
		let status = fixture.orchestrator.status();
		expect(status.phase).toBe("solution");
		expect(status.blockedReason).toContain("review failed");
		expect(lastInput(fixture.provider.requests, "solution")).toBeUndefined();
		discussion.mockResolvedValueOnce(discussionResult(false));
		await expect(fixture.orchestrator.answer("重新讨论")).rejects.toThrow("未产生可采用候选");
		status = fixture.orchestrator.status();
		expect(status.phase).toBe("solution");
		expect(status.blockedReason).toContain("未产生可采用候选");
		expect(lastInput(fixture.provider.requests, "solution")).toBeUndefined();
		const mixed = discussionResult();
		mixed.candidates[1]!.adoptable = false;
		discussion.mockResolvedValueOnce(mixed);
		smuggleIneligible = true;
		await expect(fixture.orchestrator.answer("再次讨论")).rejects.toThrow("normalizer");
		status = fixture.orchestrator.status();
		expect(status.phase).toBe("solution");
		expect(status.blockedReason).toContain("normalizer");
	} finally {
		discussion.mockRestore();
	}
}, 120_000);

test("cancelling a Team request aborts discussion and never invokes the solution writer", async () => {
	const entered = Promise.withResolvers<void>();
	const discussion = spyOn(teamOrchestrator, "runTeamDiscussion").mockImplementation(async options => {
		entered.resolve();
		const aborted = Promise.withResolvers<void>();
		options.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		await aborted.promise;
		return { ...discussionResult(), status: "cancelled" };
	});
	try {
		await using fixture = await consumer();
		await fixture.orchestrator.start(`${MARKER}: ${REQUIREMENT}`, "team-cancel");
		const pending = fixture.orchestrator.confirmSpecification("确认", { useTeam: true }).catch(error => error);
		await entered.promise;
		const status = await fixture.orchestrator.cancel();
		expect(await pending).toBeInstanceOf(Error);
		expect(status.phase).toBe("cancelled");
		expect(lastInput(fixture.provider.requests, "solution")).toBeUndefined();
	} finally {
		discussion.mockRestore();
	}
}, 120_000);
