/**
 * `/team` in-process integration test (docs-zh-CN/team.md §6): the real
 * orchestrator drives the real `runSubprocess` executor path end to end; only
 * the model sessions are scripted — `createAgentSession` is stubbed with fake
 * sessions that answer each stage marker with schema-valid yield data. Asserts
 * the full five-stage run reaches a final report, that each child session was
 * pinned to the configured model, and that the read-only tool contract rides
 * through the executor.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
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
} from "@oh-my-pi/pi-coding-agent/team";
import type { TeamParticipant } from "@oh-my-pi/pi-coding-agent/team";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

const MODEL_SESSION = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const MODEL_OTHER = getBundledModel("anthropic", "claude-opus-4-6")!;
const PATTERN_SESSION = `${MODEL_SESSION.provider}/${MODEL_SESSION.id}`;
const PATTERN_OTHER = `${MODEL_OTHER.provider}/${MODEL_OTHER.id}`;

interface RecordedCall {
	modelPattern: string | undefined;
	stage: string;
	toolNames: readonly string[] | undefined;
	outputSchemaMode: unknown;
}

function stageOf(text: string): string {
	const match = /\[team-stage:([a-z]+)/.exec(text);
	if (!match) throw new Error(`no stage marker in prompt: ${text.slice(0, 120)}`);
	return match[1];
}

function scriptedData(stage: string, text?: string): Record<string, unknown> {
	switch (stage) {
		case "proposal":
			return {
				proposal: "方案：扩展现有模块并保持旧接口不变。",
				noViableProposal: false,
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
			// Initial reviews report a blocking finding so revision runs; rechecks
			// clear it so the run can complete as adoptable options.
			if (!text?.includes(" recheck]")) {
				return {
					noSubstantiveIssues: false,
					reviewSummary: "发现阻断问题：缺少迁移步骤。",
					findings: [
						{
							severity: "blocking",
							issue: "缺少迁移步骤",
							impact: "升级时数据不一致",
							evidence: "src/module.ts",
							targetAspect: "迁移",
						},
					],
					priorBlockingStatus: "not-applicable",
				};
			}
			return {
				noSubstantiveIssues: true,
				reviewSummary: "阻断问题已解决。",
				findings: [],
				priorBlockingStatus: "resolved",
			};
		case "revision":
			return {
				revisedProposal: "方案（修订）：补充迁移步骤后同前。",
				revisionSummary: "补充迁移步骤",
				responses: [
					{
						finding: "缺少迁移步骤",
						disposition: "accepted-and-revised",
						explanation: "已补充迁移步骤与回滚说明",
					},
				],
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

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-team-integration-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		settings = Settings.isolated({ "task.maxConcurrency": 4 });

		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (inputOptions?: CreateAgentSessionOptions) => {
			const options = inputOptions as unknown as Record<string, unknown>;
			const model = options.model as { provider: string; id: string } | undefined;
			const modelPattern = model ? `${model.provider}/${model.id}` : undefined;
			const toolNames = options.toolNames as readonly string[] | undefined;
			const outputSchemaMode = options.outputSchemaMode;
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
					const stage = stageOf(text);
					recorded.push({ modelPattern, stage, toolNames, outputSchemaMode });
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: `yield-${recorded.length}`,
							toolName: "yield",
							result: { content: [], details: { status: "success", data: scriptedData(stage, text) } },
							isError: false,
						} as AgentSessionEvent);
					}
				},
			} as unknown as AgentSession;
			const result: CreateAgentSessionResult = {
				session,
				extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
				setToolUIContext: () => {},
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

	it("runs all five stages through the real executor and produces the final report", async () => {
		const participants: TeamParticipant[] = [
			{ index: 0, modelPattern: PATTERN_SESSION, model: MODEL_SESSION, isSessionModel: true },
			{ index: 1, modelPattern: PATTERN_OTHER, model: MODEL_OTHER, isSessionModel: false },
		];
		const runner = createTeamSubagentRunner({
			cwd: tempDir.path(),
			settings,
			modelRegistry,
			authStorage,
			getApiKey: model => `${model.provider}-test-key`,
			sessionFile: null,
			artifactsDir: tempDir.path(),
			parentAgentId: "Main",
		});

		const result = await runTeamDiscussion({
			question: "如何在不破坏旧接口的前提下扩展模块？",
			cwd: tempDir.path(),
			participants,
			sessionModelPattern: PATTERN_SESSION,
			runner,
			signal: new AbortController().signal,
			maxConcurrency: 4,
		});

		expect(result.status).toBe("completed");
		const markdown = result.reportMarkdown!;
		expect(markdown).toContain("### 核心方案");
		expect(markdown).toContain("方案状态（结构化追踪，机械生效）");
		expect(markdown).toContain("【推荐】方案 A");
		expect(markdown).toContain(TEAM_CLOSING_CONTRACT.split("\n")[0]!.slice(2));
		expect(markdown).toContain("✅ 可作为选项");
		// §6 structure: choice-affecting interpretation difference is top-noticed.
		const noticeIndex = markdown.indexOf("请先回答差异、带答案重跑");
		expect(noticeIndex).toBeGreaterThan(-1);
		expect(noticeIndex).toBeLessThan(markdown.indexOf("### 核心方案"));

		// Stage coverage: two proposals, one alignment, reviews (+rechecks),
		// revisions, one synthesis — all five stages.
		const stages = recorded.map(call => call.stage);
		expect(stages.filter(stage => stage === "proposal")).toHaveLength(2);
		expect(stages.filter(stage => stage === "alignment")).toHaveLength(1);
		expect(stages.filter(stage => stage === "review")).toHaveLength(4); // 2 initial + 2 recheck
		expect(stages.filter(stage => stage === "revision")).toHaveLength(2);
		expect(stages.filter(stage => stage === "synthesis")).toHaveLength(1);
		const stageIndex = (stage: string) => stages.indexOf(stage);
		const stageLastIndex = (stage: string) => stages.lastIndexOf(stage);
		expect(stageIndex("proposal")).toBe(0);
		expect(stageIndex("alignment")).toBeGreaterThan(stageLastIndex("proposal"));
		expect(stageIndex("review")).toBeGreaterThan(stageIndex("alignment"));
		expect(stageIndex("revision")).toBeGreaterThan(stageIndex("review"));
		expect(stageIndex("synthesis")).toBeGreaterThan(stageLastIndex("revision"));

		// Model pinning: each child session ran on its configured model.
		const byStage = (stage: string) =>
			recorded
				.filter(call => call.stage === stage)
				.map(call => call.modelPattern)
				.sort();
		expect(byStage("proposal")).toEqual([PATTERN_OTHER, PATTERN_SESSION]);
		expect(byStage("alignment")).toEqual([PATTERN_SESSION]);
		expect(byStage("synthesis")).toEqual([PATTERN_SESSION]);
		// Rotation: proposal A (session model) reviewed by the other model; the
		// session model never reviews, so proposal B falls back to its own
		// model's fresh subagent (sole eligible reviewer). Rechecks reuse the
		// same rotation.
		expect(byStage("review")).toEqual([PATTERN_OTHER, PATTERN_OTHER, PATTERN_OTHER, PATTERN_OTHER]);
		// Reviser is the proposal's own model: B (other), A (session).
		expect(byStage("revision")).toEqual([PATTERN_OTHER, PATTERN_SESSION]);

		// Read-only tool contract and strict schema mode ride through the executor
		// into every child session, mechanically.
		for (const call of recorded) {
			expect(call.outputSchemaMode).toBe("strict");
			// Exact set: the session receives precisely the read-only tools —
			// nothing else (no bash/eval/write/edit/task/hub/MCP) may leak in.
			// `yield` is appended by the executor's required-yield path after
			// these options, so it never appears in `toolNames` here.
			expect([...(call.toolNames ?? [])].sort()).toEqual([...TEAM_READ_ONLY_TOOLS].sort());
		}
	});

	it("exposes only the read-only tool contract to team subagents", () => {
		const tools = [...TEAM_READ_ONLY_TOOLS];
		expect(tools).toContain("read");
		expect(tools).toContain("wiki");
		for (const forbidden of ["bash", "eval", "write", "edit", "task", "hub", "spawn"]) {
			expect(tools).not.toContain(forbidden);
		}
	});
});
