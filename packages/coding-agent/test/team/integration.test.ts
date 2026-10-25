/**
 * `/team` in-process integration test (openspec/specs/team-discussion/spec.md §6): the real
 * orchestrator drives the real `runSubprocess` executor path end to end; only
 * the model sessions are scripted — `createAgentSession` is stubbed with fake
 * sessions that answer each stage marker with schema-valid yield data. Asserts
 * the full five-stage run reaches a final report, that each child session was
 * pinned to the configured model, and that the read-only tool contract rides
 * through the executor.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	TEAM_CLOSING_CONTRACT,
	TEAM_READ_ONLY_TOOLS,
	createTeamSubagentRunner,
	runTeamDiscussion,
	resolveTeamParticipants,
	TEAM_PROPOSAL_SCHEMA,
} from "@oh-my-pi/pi-coding-agent/team";
import type { TeamSubagentCall } from "@oh-my-pi/pi-coding-agent/team";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

const MODEL_SESSION = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const MODEL_OTHER = getBundledModel("anthropic", "claude-opus-4-6")!;
const MODEL_THIRD = getBundledModel("openai", "gpt-5")!;
const PATTERN_SESSION = `${MODEL_SESSION.provider}/${MODEL_SESSION.id}`;
const PATTERN_OTHER = `${MODEL_OTHER.provider}/${MODEL_OTHER.id}`;
const PATTERN_THIRD = `${MODEL_THIRD.provider}/${MODEL_THIRD.id}`;

interface RecordedCall {
	modelPattern: string | undefined;
	agentId: string;
	stage: string;
	target: string | undefined;
	recheck: boolean;
	findingIds: string[];
	sessionId: string | undefined;
	sessionManager: CreateAgentSessionOptions["sessionManager"];
	initialMessages: readonly unknown[];
	toolNames: readonly string[] | undefined;
	outputSchemaMode: unknown;
}

function stageOf(text: string): string {
	const match = /\[team-stage:([a-z]+)/.exec(text);
	if (!match) throw new Error(`no stage marker in prompt: ${text.slice(0, 120)}`);
	return match[1];
}

// Interpret only the explicit current obligation block supplied by the real handoff.
function inputFindingIds(text: string, heading: string): string[] {
	const section = text.indexOf(heading);
	if (section < 0) throw new Error(`Missing finding input: ${heading}`);
	const match = /```json\s*([\s\S]*?)```/.exec(text.slice(section));
	if (!match) throw new Error(`Missing finding JSON: ${heading}`);
	return (JSON.parse(match[1]!) as { id: string }[]).map(finding => finding.id);
}

function scriptedData(stage: string, text?: string): Record<string, unknown> {
	switch (stage) {
		case "proposal":
			return {
				proposal: "方案：扩展现有模块并保持旧接口不变。",
				noViableProposal: false,
				investigationBlockedReason: "",
				keyAssumptions: [
					{ content: "旧接口稳定", basis: "src/api.ts", status: "unverified", impactIfWrong: "需要适配层" },
				],
				risks: ["回归风险"],
				unknowns: [],
				acceptanceCriteria: ["现有测试全绿", "旧接口行为不变"],
				ambiguityInterpretations: [{ ambiguity: "并发要求", interpretation: "单线程即可", impact: "吞吐上限" }],
				evidence: [{ claim: "模块存在", source: "src/module.ts" }],
			};
		case "alignment":
			return {
				unifiedUnderstanding: "统一理解：实现新功能且不破坏旧接口。",
				acceptanceCriteria: ["功能可用", "旧接口不破坏"],
				factDifferences: [],
				interpretationDifferences: [
					{
						ambiguity: "并发",
						interpretations: [{ view: "需要", impact: "架构不同" }],
						affectsChoice: true,
					},
				],
			};
		case "review":
			// Two independent blockers require two rechecks; a clean new-findings
			// verdict does not close the second pending blocker.
			if (!text?.includes(" recheck]")) {
				return {
					noSubstantiveIssues: false,
					reviewSummary: "发现阻断问题：缺少迁移步骤。",
					findings: ["缺少迁移步骤", "缺少回滚验证"].map(issue => ({
						severity: "blocking",
						issue,
						impact: "升级时数据不一致",
						evidence: "src/module.ts",
						targetAspect: "迁移",
					})),
					blockingResolutions: [],
				};
			}
			return {
				noSubstantiveIssues: true,
				reviewSummary: "逐项复核迁移与回滚依据。",
				findings: [],
				blockingResolutions: inputFindingIds(text!, "## 此前未解决的阻断问题").map((findingId, index) => ({
					findingId,
					status: text!.includes("round=1 ") && index === 1 ? "unresolved" : "resolved",
					basis:
						text!.includes("round=1 ") && index === 1 ? "回滚反例仍成立" : "src/module.ts confirms this repair",
				})),
			};
		case "revision":
			return {
				revisedProposal: "方案（修订）：补充迁移步骤后同前。",
				revisionSummary: "补充迁移步骤",
				responses: inputFindingIds(
					text!,
					"## 本轮必须回应的完整问题集（最新审查问题与所有未解决阻断按 ID 合并）",
				).map(findingId => ({
					findingId,
					disposition: "accepted-and-revised",
					explanation: "已补充迁移步骤与回滚说明",
				})),
				reviewFlags: {
					changedCoreDesign: false,
					claimsResolvedBlocking: true,
					newEvidenceChangesAssumptions: false,
					disputesBlockingFinding: false,
				},
			};
		case "synthesis":
			return {
				reportMarkdown: "### 核心方案\n扩展现有模块。\n\n### 主要取舍\n与独立模块相比改动更小。",
				recommendedProposal: "A",
				recommendationReason: "满足全部验收标准且改动最小",
				recommendationPreconditions: "旧接口稳定",
				hardConstraintViolations: [],
			};
		default:
			throw new Error(`unhandled stage ${stage}`);
	}
}

describe("team in-process integration", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let settings: Settings;
	const recorded: RecordedCall[] = [];

	let script = scriptedData;
	let inspectChild: ((options: CreateAgentSessionOptions) => Promise<void>) | undefined;
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-team-integration-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		settings = Settings.isolated({ "task.maxConcurrency": 4 });

		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (inputOptions?: CreateAgentSessionOptions) => {
			const options = inputOptions as unknown as Record<string, unknown>;
			const model = options.model as { provider: string; id: string } | undefined;
			const modelPattern = model ? `${model.provider}/${model.id}` : undefined;
			const toolNames = options.toolNames as readonly string[] | undefined;
			const outputSchemaMode = options.outputSchemaMode;
			const sessionManager = inputOptions?.sessionManager;
			const initialMessages = sessionManager?.buildSessionContext().messages ?? [];
			const listeners: Array<(event: AgentSessionEvent) => void> = [];
			const session = {
				...createSessionDefaults(),
				state: { messages: [] },
				agent: { state: { systemPrompt: ["test"] } },
				model,
				extensionRunner: undefined,
				sessionManager: { appendSessionInit: () => {} },
				getActiveToolNames: () => ["yield"],
				getEnabledToolNames: () => ["yield"],
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.push(listener);
					return () => {};
				},
				prompt: async (text: string) => {
					if (inputOptions) await inspectChild?.(inputOptions);
					const stage = stageOf(text);
					recorded.push({
						modelPattern,
						agentId: options.agentId as string,
						stage,
						target: /\btarget=([A-Z]+)\b/.exec(text)?.[1],
						recheck: text.includes(" recheck]"),
						findingIds:
							stage === "revision"
								? inputFindingIds(text, "## 本轮必须回应的完整问题集（最新审查问题与所有未解决阻断按 ID 合并）")
								: stage === "review" && text.includes(" recheck]")
									? inputFindingIds(text, "## 此前未解决的阻断问题")
									: [],
						sessionId: sessionManager?.getSessionId(),
						sessionManager,
						initialMessages,
						toolNames,
						outputSchemaMode,
					});
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: `yield-${recorded.length}`,
							toolName: "yield",
							result: { content: [], details: { status: "success", data: script(stage, text) } },
							isError: false,
						} as AgentSessionEvent);
					}
				},
			} as unknown as AgentSession;
			const result: CreateAgentSessionResult = {
				session,
				extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
				setToolUIContext: () => {},
				getToolContext: () => {
					throw new Error("Native tool context is unavailable in this fixture");
				},
				eventBus: new EventBus(),
			};
			return result;
		});
	});

	afterAll(() => {
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	const runnerDeps = () => ({
		cwd: tempDir.path(),
		settings,
		modelRegistry,
		authStorage,
		getApiKey: (model: Model) => `${model.provider}-test-key`,
		sessionFile: null,
		artifactsDir: tempDir.path(),
		parentAgentId: "Main",
	});

	for (const scenario of [
		{
			name: "runs three independent same-model slots through every executor stage",
			configuredMembers: [PATTERN_OTHER],
			expectedModels: [PATTERN_OTHER, PATTERN_OTHER, PATTERN_OTHER],
			reviewerModels: [PATTERN_OTHER, PATTERN_OTHER, PATTERN_OTHER],
			blockedLabel: undefined,
			residualLabel: undefined,
		},
		{
			name: "runs AB as ABA without adding the session model to the proposer roster",
			configuredMembers: [PATTERN_OTHER, PATTERN_THIRD],
			expectedModels: [PATTERN_OTHER, PATTERN_THIRD, PATTERN_OTHER],
			reviewerModels: [PATTERN_THIRD, PATTERN_OTHER, PATTERN_THIRD],
			blockedLabel: "C",
			residualLabel: "A",
		},
	]) {
		it(scenario.name, async () => {
			recorded.length = 0;
			script = (stage, text) => {
				const data = scriptedData(stage, text);
				if (stage === "review" && text?.includes(`target=${scenario.residualLabel} round=2 recheck]`)) {
					data.blockingResolutions = (data.blockingResolutions as Record<string, unknown>[]).map(decision => ({
						...decision,
						status: "unresolved",
						basis: "Rollback counterexample is still reachable",
					}));
				}
				if (stage === "synthesis" && scenario.blockedLabel) {
					data.hardConstraintViolations = [
						{
							proposalLabel: scenario.blockedLabel,
							issue: "破坏旧接口兼容",
							evidence: "src/api.ts 与共同验收标准冲突",
						},
					];
				}
				return data;
			};
			const roster = resolveTeamParticipants({
				configuredMembers: scenario.configuredMembers,
				sessionModel: MODEL_SESSION,
				availableModels: [MODEL_SESSION, MODEL_OTHER, MODEL_THIRD],
			});
			expect(roster.ok).toBe(true);
			if (!roster.ok) throw new Error(roster.error);
			expect(roster.participants.map(participant => participant.modelPattern)).toEqual(scenario.expectedModels);
			expect(roster.participants.every(participant => !participant.isSessionModel)).toBe(true);

			const result = await runTeamDiscussion({
				question: "如何在不破坏旧接口的前提下扩展模块？",
				inputVersion: "confirmed-spec:compatibility-7",
				cwd: tempDir.path(),
				participants: roster.participants,
				sessionModelPattern: PATTERN_SESSION,
				runner: createTeamSubagentRunner(runnerDeps()),
				signal: new AbortController().signal,
				maxConcurrency: 2,
			});

			expect(result.status).toBe("completed");
			expect(result.inputVersion).toBe("confirmed-spec:compatibility-7");
			expect(result.interpretationDifferences.some(difference => difference.affectsChoice)).toBe(true);
			expect(result.candidates.map(candidate => candidate.label)).toEqual(["A", "B", "C"]);
			for (const candidate of result.candidates) {
				expect(candidate.reviewSucceeded).toBe(true);
				expect(candidate.recheckSucceeded).toBe(true);
				expect(candidate.adoptable).toBe(
					candidate.label !== scenario.blockedLabel && candidate.label !== scenario.residualLabel,
				);
				expect(candidate.conditions.some(condition => condition.includes("旧接口稳定"))).toBe(true);
				if (candidate.label === scenario.blockedLabel) {
					expect(candidate.unresolvedBlocking).toContainEqual(
						expect.objectContaining({ id: `${candidate.label}-F3`, issue: "破坏旧接口兼容" }),
					);
				}
				if (candidate.label === scenario.residualLabel) {
					expect(candidate.unresolvedBlocking.map(finding => finding.id)).toContain(`${candidate.label}-F2`);
				}
			}
			const markdown = result.reportMarkdown!;
			expect(markdown).toContain("### 核心方案");
			expect(markdown).toContain("方案状态（结构化追踪，机械生效）");
			if (scenario.residualLabel) {
				expect(result.droppedRecommendation).toBe(true);
				expect(markdown).not.toContain("【推荐】");
				expect(markdown).toContain(`${scenario.residualLabel}-F2`);
			} else {
				expect(markdown).toContain("【推荐】方案 A");
			}
			expect(markdown).toContain(TEAM_CLOSING_CONTRACT.split("\n")[0]!.slice(2));
			expect(markdown).not.toContain("[object Object]");
			for (const label of ["A", "B", "C"]) {
				expect(markdown).toContain(
					`| 方案 ${label} | ${label === scenario.blockedLabel || label === scenario.residualLabel ? "⛔ 尚不可采用" : "✅ 可作为选项"}`,
				);
			}
			if (scenario.blockedLabel) {
				expect(markdown).toContain("破坏旧接口兼容");
				expect(markdown).toContain("src/api.ts");
				expect(markdown).toContain(`${scenario.blockedLabel}-F3`);
			}
			// Choice-affecting interpretation differences remain top-noticed.
			const noticeIndex = markdown.indexOf("请先回答差异、带答案重跑");
			expect(noticeIndex).toBeGreaterThan(-1);
			expect(noticeIndex).toBeLessThan(markdown.indexOf("### 核心方案"));

			const stages = recorded.map(call => call.stage);
			expect(stages.filter(stage => stage === "proposal")).toHaveLength(3);
			expect(stages.filter(stage => stage === "alignment")).toHaveLength(1);
			expect(stages.filter(stage => stage === "review")).toHaveLength(9);
			expect(stages.filter(stage => stage === "revision")).toHaveLength(6);
			expect(stages.filter(stage => stage === "synthesis")).toHaveLength(1);
			const stageIndex = (stage: string) => stages.indexOf(stage);
			const stageLastIndex = (stage: string) => stages.lastIndexOf(stage);
			expect(stageIndex("proposal")).toBe(0);
			expect(stageIndex("alignment")).toBeGreaterThan(stageLastIndex("proposal"));
			expect(stageIndex("review")).toBeGreaterThan(stageIndex("alignment"));
			expect(stageIndex("revision")).toBeGreaterThan(stageIndex("review"));
			expect(stageIndex("synthesis")).toBeGreaterThan(stageLastIndex("revision"));
			expect(stageIndex("synthesis")).toBeGreaterThan(stageLastIndex("review"));

			// Every logical slot survives through revision under its own label.
			for (const [index, label] of ["A", "B", "C"].entries()) {
				for (const callLabel of [`team-proposal-${label}`, `team-revision-${label}-1`]) {
					const outcome = result.subagentResults!.find(entry => entry.label === callLabel)!;
					expect(outcome.modelPattern).toBe(scenario.expectedModels[index]);
					expect(outcome.outcome.ok).toBe(true);
				}
				const revision = recorded.filter(call => call.stage === "revision" && call.target === label);
				expect(revision.map(call => call.modelPattern)).toEqual([
					scenario.expectedModels[index],
					scenario.expectedModels[index],
				]);
				expect(revision.map(call => call.findingIds)).toEqual([[`${label}-F1`, `${label}-F2`], [`${label}-F2`]]);
				const rechecks = recorded.filter(call => call.stage === "review" && call.target === label && call.recheck);
				expect(rechecks.map(call => call.findingIds)).toEqual([[`${label}-F1`, `${label}-F2`], [`${label}-F2`]]);
				for (const recheck of [false, true]) {
					const review = recorded.filter(
						call => call.stage === "review" && call.target === label && call.recheck === recheck,
					);
					expect(review.map(call => call.modelPattern)).toEqual(
						Array(recheck ? 2 : 1).fill(scenario.reviewerModels[index]),
					);
				}
			}
			const byStage = (stage: string) =>
				recorded.filter(call => call.stage === stage).map(call => call.modelPattern);
			expect(byStage("proposal").sort()).toEqual([...scenario.expectedModels].sort());
			expect(byStage("alignment")).toEqual([PATTERN_SESSION]);
			expect(byStage("synthesis")).toEqual([PATTERN_SESSION]);
			expect(recorded.filter(call => call.modelPattern === PATTERN_SESSION).map(call => call.stage)).toEqual([
				"alignment",
				"synthesis",
			]);

			// Even repeated models get distinct empty child contexts, not a shared session.
			expect(new Set(recorded.map(call => call.agentId)).size).toBe(recorded.length);
			expect(new Set(recorded.map(call => call.sessionId)).size).toBe(recorded.length);
			expect(new Set(recorded.map(call => call.sessionManager)).size).toBe(recorded.length);
			for (const call of recorded) {
				expect(call.sessionId).toBeDefined();
				expect(call.sessionManager).toBeDefined();
				expect(call.initialMessages).toHaveLength(0);
				expect(call.outputSchemaMode).toBe("strict");
				// The executor appends required yield separately; no writable tools leak in.
				expect([...(call.toolNames ?? [])].sort()).toEqual([...TEAM_READ_ONLY_TOOLS].sort());
			}
		});
	}

	it.each([
		["proposal heading", "### 方案 A\n\n可以采用。"],
		["paragraph label and list", "方案 A：\n- 可以采用。"],
		["paragraph label and blockquote", "方案 A：\n> 可以采用。"],
	])("rejects blocked adoption through the executor: %s", async (_name, reportMarkdown) => {
		recorded.length = 0;
		script = (stage, text) => {
			const data = scriptedData(stage, text);
			if (stage === "review" && text?.includes(" recheck]")) {
				data.blockingResolutions = (data.blockingResolutions as Record<string, unknown>[]).map(decision => ({
					...decision,
					status: "unresolved",
					basis: "迁移与回滚反例仍成立",
				}));
			}
			if (stage === "synthesis") {
				data.reportMarkdown = reportMarkdown;
				data.recommendedProposal = "";
				data.recommendationReason = "";
				data.recommendationPreconditions = "";
			}
			return data;
		};
		const roster = resolveTeamParticipants({
			configuredMembers: [PATTERN_OTHER],
			sessionModel: MODEL_SESSION,
			availableModels: [MODEL_SESSION, MODEL_OTHER, MODEL_THIRD],
		});
		if (!roster.ok) throw new Error(roster.error);
		const result = await runTeamDiscussion({
			question: "如何在不破坏旧接口的前提下扩展模块？",
			cwd: tempDir.path(),
			participants: roster.participants,
			sessionModelPattern: PATTERN_SESSION,
			runner: createTeamSubagentRunner(runnerDeps()),
			signal: new AbortController().signal,
			maxConcurrency: 2,
		});
		expect(recorded.filter(call => call.stage === "synthesis")).toHaveLength(1);
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("尚不可采用");
		expect(result.reportMarkdown).toBeUndefined();
	});

	it("routes new nonblocking finding IDs through the executor after closing all old blockers", async () => {
		recorded.length = 0;
		script = (stage, text) => {
			const data = scriptedData(stage, text);
			if (stage === "review" && text?.includes(" recheck]")) {
				data.noSubstantiveIssues = false;
				data.findings = ["important", "minor"].map(severity => ({
					severity,
					issue: `${severity} 迁移说明问题`,
					impact: "作者需要说明迁移取舍",
					evidence: "src/migration.ts",
					targetAspect: "迁移说明",
				}));
				data.blockingResolutions = (data.blockingResolutions as Record<string, unknown>[]).map(decision => ({
					...decision,
					status: "resolved",
					basis: "src/migration.ts 已覆盖原始反例",
				}));
			}
			if (stage === "revision" && text?.includes("round=2]")) {
				data.reviewFlags = {
					changedCoreDesign: false,
					claimsResolvedBlocking: false,
					newEvidenceChangesAssumptions: false,
					disputesBlockingFinding: false,
				};
			}
			return data;
		};
		const roster = resolveTeamParticipants({
			configuredMembers: [PATTERN_OTHER],
			sessionModel: MODEL_SESSION,
			availableModels: [MODEL_SESSION, MODEL_OTHER, MODEL_THIRD],
		});
		if (!roster.ok) throw new Error(roster.error);
		const result = await runTeamDiscussion({
			question: "如何在不破坏旧接口的前提下扩展模块？",
			cwd: tempDir.path(),
			participants: roster.participants,
			sessionModelPattern: PATTERN_SESSION,
			runner: createTeamSubagentRunner(runnerDeps()),
			signal: new AbortController().signal,
			maxConcurrency: 2,
		});
		for (const label of ["A", "B", "C"]) {
			const revisions = recorded.filter(call => call.stage === "revision" && call.target === label);
			expect(revisions.map(call => call.findingIds)).toEqual([
				[`${label}-F1`, `${label}-F2`],
				[`${label}-F3`, `${label}-F4`],
			]);
			expect(revisions.map(call => call.modelPattern)).toEqual([PATTERN_OTHER, PATTERN_OTHER]);
			const secondRevision = result.subagentResults!.find(entry => entry.label === `team-revision-${label}-2`);
			expect(secondRevision?.outcome).toMatchObject({
				ok: true,
				data: {
					responses: [
						{ findingId: `${label}-F3`, disposition: "accepted-and-revised" },
						{ findingId: `${label}-F4`, disposition: "accepted-and-revised" },
					],
				},
			});
			expect(result.reportMarkdown).toContain(`| 方案 ${label} | ✅ 可作为选项`);
		}
		expect(recorded.filter(call => call.recheck)).toHaveLength(3);
		expect(result.status).toBe("completed");
		expect(result.reportMarkdown).toContain("【推荐】方案 A");
	});

	for (const persisted of [false, true]) {
		it(`isolates actual child filesystem consumers across ${persisted ? "persisted" : "temporary"} leases`, async () => {
			recorded.length = 0;
			script = scriptedData;
			const leases: string[] = [];
			const ready = Promise.withResolvers<void>();
			const checked = Promise.withResolvers<void>();
			let inspected = 0;
			inspectChild = async options => {
				const local = options.localProtocolOptions;
				const own = local?.getArtifactsDir?.();
				if (!own || !local) throw new Error("Runner did not bind the child artifact identity");
				await fs.mkdir(path.join(own, "local"), { recursive: true });
				await fs.writeFile(`${own}.md`, `PRIVATE_DRAFT_${leases.length}\n`);
				await fs.writeFile(path.join(own, "local", "own.md"), "OWN_CHILD_NOTES\n");
				leases.push(own);
				if (leases.length === 2) ready.resolve();
				await ready.promise;
				try {
					const peer = leases.find(entry => entry !== own);
					if (!peer) throw new Error("Missing independent child peer");
					const childSession: ToolSession = {
						cwd: tempDir.path(),
						hasUI: false,
						settings,
						skipPythonPreflight: true,
						restrictToolNames: true,
						getSessionFile: () => options.sessionManager?.getSessionFile() ?? null,
						getSessionSpawns: () => "*",
						localProtocolOptions: local,
					};
					const tools = await createTools(childSession, ["read", "grep", "glob"]);
					const read = tools.find(tool => tool.name === "read");
					const grep = tools.find(tool => tool.name === "grep");
					const glob = tools.find(tool => tool.name === "glob");
					if (!read || !grep || !glob) throw new Error("Missing real filesystem consumers");
					const ownResult = await read.execute("own-child-notes", { path: "local://own.md" });
					expect(
						ownResult.content.some(block => block.type === "text" && block.text.includes("OWN_CHILD_NOTES")),
					).toBe(true);
					await expect(read.execute("peer-child-draft", { path: `${peer}.md` })).rejects.toThrow(
						"Team read isolation",
					);
					await expect(
						grep.execute("peer-child-search", { pattern: "PRIVATE_DRAFT", path: path.dirname(peer) }),
					).rejects.toThrow("Team read isolation");
					await expect(glob.execute("peer-child-glob", { path: `${path.dirname(peer)}/**/*` })).rejects.toThrow(
						"Team read isolation",
					);
				} finally {
					if (++inspected === 2) checked.resolve();
					// Hold both leases until neither consumer can race peer cleanup.
					await checked.promise;
				}
			};
			try {
				const runner = createTeamSubagentRunner({
					...runnerDeps(),
					sessionFile: persisted ? path.join(tempDir.path(), "isolation-parent.jsonl") : null,
				});
				const outcomes = await Promise.all(
					["A", "B"].map(label =>
						runner(
							{
								role: "proposer",
								modelPattern: PATTERN_SESSION,
								label: `team-proposal-${label}`,
								task: "[team-stage:proposal]",
								schema: TEAM_PROPOSAL_SCHEMA,
							},
							new AbortController().signal,
						),
					),
				);
				expect(outcomes.every(outcome => outcome.ok)).toBe(true);
				expect(leases).toHaveLength(2);
			} finally {
				inspectChild = undefined;
			}
		});
	}

	it("keeps concurrent discussions with identical stage labels in separate child namespaces", async () => {
		recorded.length = 0;
		script = scriptedData;
		const call: TeamSubagentCall = {
			role: "proposer",
			modelPattern: PATTERN_SESSION,
			label: "team-proposal-A",
			task: "[team-stage:proposal]",
			schema: TEAM_PROPOSAL_SCHEMA,
		};
		const parallelResults = await Promise.all(
			[createTeamSubagentRunner(runnerDeps()), createTeamSubagentRunner(runnerDeps())].map(nextRunner =>
				nextRunner(call, new AbortController().signal),
			),
		);
		expect(parallelResults.every(outcome => outcome.ok)).toBe(true);
		expect(recorded).toHaveLength(2);
		expect(new Set(recorded.map(entry => entry.agentId)).size).toBe(recorded.length);
		expect(new Set(recorded.map(entry => entry.sessionId)).size).toBe(recorded.length);
	});
});
