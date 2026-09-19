/**
 * `/team` orchestrator unit tests with a deterministic stub runner.
 *
 * Covers the mechanical guarantees from docs-zh-CN/team.md §6: stage flow and
 * order, identical proposer inputs, reviewer rotation (incl. single-model
 * fallback), the two-round revision cap, flag-driven rechecks, anonymous
 * review prompts, the blocking gate ("尚不可采用" + recommendation override),
 * budget enforcement, alignment/synthesis failure handling, partial
 * participation, cancellation, and concurrency bounds.
 */
import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	TEAM_CLOSING_CONTRACT,
	assignReviewerParticipant,
	computeUnresolvedBlocking,
	needsRecheck,
	runTeamDiscussion,
	TEAM_MAX_REVISION_ROUNDS,
} from "@oh-my-pi/pi-coding-agent/team";
import type { TeamParticipant, TeamSubagentCall, TeamSubagentRunner } from "@oh-my-pi/pi-coding-agent/team";

function participantOf(model: Model, index: number, isSessionModel = false): TeamParticipant {
	return { index, modelPattern: `${model.provider}/${model.id}`, model, isSessionModel };
}

const MODEL_A = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const MODEL_B = getBundledModel("anthropic", "claude-opus-4-6")!;
const MODEL_C = getBundledModel("openai", "gpt-5")!;
const PATTERN_A = `${MODEL_A.provider}/${MODEL_A.id}`;
const PATTERN_B = `${MODEL_B.provider}/${MODEL_B.id}`;
const PATTERN_C = `${MODEL_C.provider}/${MODEL_C.id}`;

interface ParsedMarker {
	role: string;
	target?: string;
	round?: number;
	recheck: boolean;
}

function parseMarker(task: string): ParsedMarker {
	const match = /\[team-stage:([a-z]+)(?: target=([A-Z]))?(?: round=(\d+))?( recheck)?\]/.exec(task);
	if (!match) throw new Error(`no stage marker in task: ${task.slice(0, 80)}`);
	return { role: match[1], target: match[2], round: match[3] ? Number(match[3]) : undefined, recheck: !!match[4] };
}

function proposalData(label: string): Record<string, unknown> {
	return {
		proposal: `方案 ${label}：扩展现有模块，改动集中在 X。`,
		noViableProposal: false,
		keyAssumptions: [{ content: "接口 Y 稳定", basis: "code", status: "unverified", impactIfWrong: "需要适配层" }],
		risks: ["回归风险"],
		unknowns: [],
		acceptanceCriteria: ["现有测试全绿"],
		ambiguityInterpretations: [{ ambiguity: "并发需求", interpretation: "按单线程实现", impact: "性能上限" }],
		evidence: [{ claim: "模块 X 已存在", source: "src/x.ts" }],
	};
}

function alignmentData(): Record<string, unknown> {
	return {
		unifiedUnderstanding: "统一理解：实现 A 功能并保持兼容。",
		acceptanceCriteria: ["功能可用", "旧接口不破坏"],
		factDifferences: [
			{
				topic: "接口 Z",
				contradiction: "A 说存在，B 说不存在",
				proposalsInvolved: ["A", "B"],
				sourceToCheck: "src/z.ts",
			},
		],
		interpretationDifferences: [
			{
				ambiguity: "并发",
				interpretations: [
					{ view: "需要", impact: "架构不同" },
					{ view: "不需要", impact: "简单" },
				],
				affectsChoice: false,
			},
		],
	};
}

function reviewData(options?: {
	blocking?: number;
	important?: number;
	priorStatus?: string;
}): Record<string, unknown> {
	const findings: Record<string, unknown>[] = [];
	for (let i = 0; i < (options?.blocking ?? 0); i++) {
		findings.push({
			severity: "blocking",
			issue: `阻断问题 ${i + 1}`,
			impact: "方案不能采用",
			evidence: "src/x.ts",
			targetAspect: "核心设计",
		});
	}
	for (let i = 0; i < (options?.important ?? 0); i++) {
		findings.push({
			severity: "important",
			issue: `重要问题 ${i + 1}`,
			impact: "需评估",
			evidence: "wiki",
			targetAspect: "兼容",
		});
	}
	return {
		noSubstantiveIssues: findings.length === 0,
		reviewSummary: "审查完成",
		findings,
		priorBlockingStatus: options?.priorStatus ?? "not-applicable",
	};
}

function revisionData(
	flags: Partial<Record<string, boolean>> = {},
	responses?: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		revisedProposal: "修订后的方案：同上并补充迁移步骤。",
		revisionSummary: "补充迁移",
		responses: responses ?? [{ finding: "阻断问题 1", disposition: "accepted-and-revised", explanation: "已补充" }],
		reviewFlags: {
			changedCoreDesign: false,
			claimsResolvedBlocking: false,
			newEvidenceChangesAssumptions: false,
			disputesBlockingFinding: false,
			...flags,
		},
	};
}

function noViableProposalData(): Record<string, unknown> {
	return {
		proposal: "资料缺失：内部 wiki 无该模块规范，无法形成可行方案。",
		noViableProposal: true,
		keyAssumptions: [],
		risks: [],
		unknowns: ["模块所有者不明"],
		acceptanceCriteria: [],
		ambiguityInterpretations: [],
		evidence: [],
	};
}

function synthesisData(recommended = ""): Record<string, unknown> {
	return {
		reportMarkdown: "### 核心方案\n方案 A 可行。\n\n### 关键依据\n见各方案。",
		recommendedProposal: recommended,
		recommendationReason: recommended ? "改动小且满足全部约束" : "",
		recommendationPreconditions: recommended ? "接口 Y 稳定" : "",
	};
}

interface Script {
	proposal?: (call: TeamSubagentCall) => Record<string, unknown> | { __fail: string };
	review?: (info: { target: string; round: number; recheck: boolean }) => Record<string, unknown> | { __fail: string };
	revision?: (info: { target: string; round: number }) => Record<string, unknown> | { __fail: string };
	alignment?: () => Record<string, unknown> | { __fail: string };
	synthesis?: () => Record<string, unknown> | { __fail: string };
	onCall?: (call: TeamSubagentCall) => void;
}

function createScriptedRunner(script: Script): { runner: TeamSubagentRunner; calls: TeamSubagentCall[] } {
	const calls: TeamSubagentCall[] = [];
	const runner: TeamSubagentRunner = async call => {
		calls.push(call);
		script.onCall?.(call);
		const marker = parseMarker(call.task);
		let outcome: Record<string, unknown> | { __fail: string } | undefined;
		switch (marker.role) {
			case "proposal":
				outcome = script.proposal?.(call) ?? proposalData(call.label.at(-1) ?? "A");
				break;
			case "alignment":
				outcome = script.alignment?.() ?? alignmentData();
				break;
			case "review":
				outcome =
					script.review?.({ target: marker.target!, round: marker.round!, recheck: marker.recheck }) ??
					reviewData();
				break;
			case "revision":
				outcome = script.revision?.({ target: marker.target!, round: marker.round! }) ?? revisionData();
				break;
			case "synthesis":
				outcome = script.synthesis?.() ?? synthesisData();
				break;
		}
		if (!outcome) throw new Error(`unhandled stage ${marker.role}`);
		const failure = outcome as { __fail?: unknown };
		if (typeof failure.__fail === "string") return { ok: false, error: failure.__fail };
		return { ok: true, data: outcome as Record<string, unknown> };
	};
	return { runner, calls };
}

/** Mirrors resolveTeamParticipants: the session model (PATTERN_A here) is always one participant. */
function participants3(): TeamParticipant[] {
	return [participantOf(MODEL_A, 0, true), participantOf(MODEL_B, 1), participantOf(MODEL_C, 2)];
}

async function run(
	script: Script,
	options?: { participants?: TeamParticipant[]; maxConcurrency?: number; signal?: AbortSignal },
) {
	const { runner, calls } = createScriptedRunner(script);
	const result = await runTeamDiscussion({
		question: "如何实现 X？",
		cwd: "/tmp/repo",
		participants: options?.participants ?? participants3(),
		sessionModelPattern: PATTERN_A,
		runner,
		signal: options?.signal ?? new AbortController().signal,
		maxConcurrency: options?.maxConcurrency ?? 8,
	});
	return { result, calls };
}

describe("team reviewer rotation", () => {
	it("assigns the next different model in proposer order, wrapping around", () => {
		const participants = participants3();
		expect(assignReviewerParticipant(participants, 0)).toBe(participants[1]);
		expect(assignReviewerParticipant(participants, 1)).toBe(participants[2]);
		// Wraps past the session-model participant (index 0) to model B.
		expect(assignReviewerParticipant(participants, 2)).toBe(participants[1]);
	});

	it("never assigns the session-model participant as reviewer", () => {
		const session = participantOf(MODEL_A, 0, true);
		const b = participantOf(MODEL_B, 1);
		const c = participantOf(MODEL_C, 2);
		expect(assignReviewerParticipant([session, b, c], 0)).toBe(b);
		expect(assignReviewerParticipant([session, b, c], 1)).toBe(c);
		expect(assignReviewerParticipant([session, b, c], 2)).toBe(b);
		// With only the session model besides the proposer, the proposer model's
		// own fresh subagent reviews (§2.5 same-model fallback).
		expect(assignReviewerParticipant([session, b], 1)).toBe(b);
	});

	it("skips same-model participants", () => {
		const a1 = participantOf(MODEL_A, 0);
		const a2 = participantOf(MODEL_A, 1);
		const b = participantOf(MODEL_B, 2);
		const participants = [a1, a2, b];
		expect(assignReviewerParticipant(participants, 0)).toBe(b);
		expect(assignReviewerParticipant(participants, 1)).toBe(b);
		expect(assignReviewerParticipant(participants, 2)).toBe(a1);
	});

	it("falls back to the same model when only one distinct model participates", () => {
		const a1 = participantOf(MODEL_A, 0);
		const a2 = participantOf(MODEL_A, 1);
		// Same-model fallback: the reviewer is a fresh subagent of the same model;
		// which same-model participant is named is immaterial.
		expect(assignReviewerParticipant([a1, a2], 0).modelPattern).toBe(a1.modelPattern);
		expect(assignReviewerParticipant([a1], 0)).toBe(a1);
	});
});

describe("team revision flags and blocking tracking", () => {
	it("triggers a recheck only when a flag is set", () => {
		expect(needsRecheck(revisionData().reviewFlags as never)).toBe(false);
		expect(needsRecheck(revisionData({ changedCoreDesign: true }).reviewFlags as never)).toBe(true);
		expect(needsRecheck(revisionData({ claimsResolvedBlocking: true }).reviewFlags as never)).toBe(true);
		expect(needsRecheck(revisionData({ newEvidenceChangesAssumptions: true }).reviewFlags as never)).toBe(true);
		expect(needsRecheck(revisionData({ disputesBlockingFinding: true }).reviewFlags as never)).toBe(true);
	});

	it("keeps initial blocking findings until a recheck reports them resolved", () => {
		const initial = reviewData({ blocking: 1 }) as never;
		expect(computeUnresolvedBlocking([initial])).toHaveLength(1);
		const recheckUnresolved = reviewData({ priorStatus: "unresolved" }) as never;
		expect(computeUnresolvedBlocking([initial, recheckUnresolved])).toHaveLength(1);
		const recheckPartial = reviewData({ priorStatus: "partially-resolved" }) as never;
		expect(computeUnresolvedBlocking([initial, recheckPartial])).toHaveLength(1);
		const recheckResolved = reviewData({ priorStatus: "resolved" }) as never;
		expect(computeUnresolvedBlocking([initial, recheckResolved])).toHaveLength(0);
		const recheckResolvedNewBlocking = reviewData({ blocking: 1, priorStatus: "resolved" }) as never;
		expect(computeUnresolvedBlocking([initial, recheckResolvedNewBlocking])).toHaveLength(1);
	});
});

describe("team orchestrator", () => {
	it("runs the five stages in order with identical proposer inputs and rotating reviewers", async () => {
		const { result, calls } = await run({});
		expect(result.status).toBe("completed");
		const roles = calls.map(call => parseMarker(call.task).role);
		const index = (role: string) => roles.findIndex(r => r === role);
		const lastIndex = (role: string) => roles.length - 1 - [...roles].reverse().indexOf(role);
		expect(index("proposal")).toBe(0);
		expect(index("alignment")).toBeGreaterThan(lastIndex("proposal"));
		expect(index("review")).toBeGreaterThan(lastIndex("alignment"));
		expect(index("synthesis")).toBe(roles.length - 1);

		const proposalTasks = calls.filter(call => parseMarker(call.task).role === "proposal").map(call => call.task);
		expect(proposalTasks).toHaveLength(3);
		for (const task of proposalTasks.slice(1)) expect(task).toBe(proposalTasks[0]);

		// Rotation: proposal A reviewed by model B, B→C, C→B (the session model
		// never reviews, so C wraps past it).
		const reviewCalls = calls.filter(call => parseMarker(call.task).role === "review");
		expect(reviewCalls.map(call => call.modelPattern)).toEqual([PATTERN_B, PATTERN_C, PATTERN_B]);
		// Review prompts are anonymous: no author model name appears.
		const authorPatterns = [PATTERN_A, PATTERN_B, PATTERN_C, MODEL_A.id, MODEL_B.id, MODEL_C.id];
		for (const call of reviewCalls) {
			for (const pattern of authorPatterns) expect(call.task).not.toContain(pattern);
		}
		// No findings → no revision rounds are padded.
		expect(calls.filter(call => parseMarker(call.task).role === "revision")).toHaveLength(0);
	});

	it("emits the closing contract and structured tracking sections in the final report", async () => {
		const { result } = await run({});
		expect(result.status).toBe("completed");
		const markdown = result.reportMarkdown!;
		expect(markdown).toContain(TEAM_CLOSING_CONTRACT.split("\n")[0]!.slice(2));
		expect(markdown).toContain("方案状态（结构化追踪，机械生效）");
		expect(markdown).toContain("team-result");
	});

	it("puts choice-affecting interpretation differences at the top and hints a re-run", async () => {
		const { result } = await run({
			alignment: () => ({
				...alignmentData(),
				interpretationDifferences: [
					{
						ambiguity: "是否需要并发",
						interpretations: [{ view: "需要", impact: "架构不同" }],
						affectsChoice: true,
					},
				],
			}),
		});
		const markdown = result.reportMarkdown!;
		const noticeIndex = markdown.indexOf("请先回答差异、带答案重跑");
		const reportIndex = markdown.indexOf("### 核心方案");
		expect(noticeIndex).toBeGreaterThan(-1);
		expect(noticeIndex).toBeLessThan(reportIndex);
	});

	it("runs revision rounds and rechecks when findings exist, resolving blocking after a recheck", async () => {
		let reviewCalls = 0;
		const { result, calls } = await run({
			review: ({ recheck }) => {
				reviewCalls++;
				if (!recheck) return reviewData({ blocking: 1 });
				return reviewData({ priorStatus: "resolved" });
			},
			revision: () => revisionData({ claimsResolvedBlocking: true }),
		});
		expect(result.status).toBe("completed");
		const revisions = calls.filter(call => parseMarker(call.task).role === "revision");
		const rechecks = calls.filter(call => parseMarker(call.task).role === "review" && parseMarker(call.task).recheck);
		expect(revisions).toHaveLength(3);
		expect(rechecks).toHaveLength(3);
		// Rechecks run on the rotation-assigned reviewer model (same as initial).
		expect(rechecks.map(call => call.modelPattern)).toEqual([PATTERN_B, PATTERN_C, PATTERN_B]);
		// Blocking resolved: report has no 尚不可采用 entries.
		expect(result.reportMarkdown).not.toContain("尚不可采用 — 未解决阻断问题");
		expect(reviewCalls).toBe(6);
	});

	it("refuses a third revision round and marks the proposal 尚不可采用", async () => {
		const { result, calls } = await run({
			review: ({ recheck }) => reviewData({ blocking: 1, priorStatus: recheck ? "unresolved" : "not-applicable" }),
			revision: () => revisionData({ claimsResolvedBlocking: true }),
		});
		expect(result.status).toBe("completed");
		expect(TEAM_MAX_REVISION_ROUNDS).toBe(2);
		for (const target of ["A", "B", "C"]) {
			const rounds = calls.filter(call => {
				const marker = parseMarker(call.task);
				return marker.role === "revision" && marker.target === target;
			});
			expect(rounds).toHaveLength(2);
			expect(rounds.map(call => parseMarker(call.task).round)).toEqual([1, 2]);
		}
		expect(result.reportMarkdown).toContain("尚不可采用 — 未解决阻断问题（两轮修订后仍未解决）");
	});

	it("skips the recheck when all revision flags are false but keeps blocking tracked", async () => {
		const { result, calls } = await run({
			review: () => reviewData({ blocking: 1 }),
			revision: () => revisionData(),
		});
		const rechecks = calls.filter(call => parseMarker(call.task).recheck);
		expect(rechecks).toHaveLength(0);
		// Without a recheck the blocking state cannot change (§2.5: 不强凑修订
		// 轮次): one revision round per proposal, then it stays blocked.
		const revisions = calls.filter(call => parseMarker(call.task).role === "revision");
		expect(revisions).toHaveLength(3);
		expect(result.reportMarkdown).toContain("尚不可采用 — 未解决阻断问题");
	});

	it("drops a recommendation that structured tracking rejects", async () => {
		const { result } = await run({
			review: ({ recheck }) => reviewData({ blocking: 1, priorStatus: recheck ? "unresolved" : "not-applicable" }),
			revision: () => revisionData({ claimsResolvedBlocking: true }),
			synthesis: () => synthesisData("A"),
		});
		expect(result.status).toBe("completed");
		expect(result.droppedRecommendation).toBe(true);
		expect(result.reportMarkdown).toContain("结构化追踪否决了综合子调用对“A”的推荐");
		expect(result.reportMarkdown).not.toContain("【推荐】");
	});

	it("renders a valid recommendation with reason and preconditions", async () => {
		const { result } = await run({ synthesis: () => synthesisData("A") });
		expect(result.droppedRecommendation).toBeFalsy();
		expect(result.reportMarkdown).toContain("【推荐】方案 A");
		expect(result.reportMarkdown).toContain("前提：接口 Y 稳定");
	});

	it("fails without half conclusions when the alignment sub-call fails", async () => {
		const { result, calls } = await run({ alignment: () => ({ __fail: "alignment boom" }) });
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("对齐子调用失败");
		expect(result.failureReason).toContain("不输出半成品结论");
		expect(calls.filter(call => parseMarker(call.task).role === "review")).toHaveLength(0);
	});

	it("fails without half conclusions when the synthesis sub-call fails", async () => {
		const { result } = await run({ synthesis: () => ({ __fail: "synthesis boom" }) });
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("综合子调用失败");
		expect(result.reportMarkdown).toBeUndefined();
	});

	it("fails when every proposer fails", async () => {
		const { result, calls } = await run({ proposal: () => ({ __fail: "proposer boom" }) });
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("所有提案子代理均失败");
		expect(calls.filter(call => parseMarker(call.task).role === "alignment")).toHaveLength(0);
	});

	it("treats a throwing runner as a failed call instead of a rejected run", async () => {
		const runner: TeamSubagentRunner = async () => {
			throw new Error("runner exploded");
		};
		const result = await runTeamDiscussion({
			question: "异常路径测试",
			cwd: "/tmp/repo",
			participants: participants3(),
			sessionModelPattern: PATTERN_A,
			runner,
			signal: new AbortController().signal,
			maxConcurrency: 8,
		});
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("所有提案子代理均失败");
	});

	it("continues with the remaining proposals when one proposer fails and notes the gap", async () => {
		const { result, calls } = await run({
			proposal: call => (call.label.endsWith("B") ? { __fail: "boom" } : proposalData("A")),
		});
		expect(result.status).toBe("completed");
		expect(result.reportMarkdown).toContain("方案 B 提案子代理失败");
		// Only A and C reach review; B never gets reviewed.
		const reviewTargets = calls
			.filter(call => parseMarker(call.task).role === "review")
			.map(call => parseMarker(call.task).target);
		expect(reviewTargets).toEqual(["A", "C"]);
	});

	it("excludes proposals whose review failed and fails the run when all reviews fail", async () => {
		const allFailed = await run({ review: () => ({ __fail: "reviewer boom" }) });
		expect(allFailed.result.status).toBe("failed");
		expect(allFailed.result.failureReason).toContain("全部审查子代理失败");

		const partial = await run({
			review: ({ target }) => (target === "A" ? { __fail: "boom" } : reviewData()),
		});
		expect(partial.result.status).toBe("completed");
		expect(partial.result.reportMarkdown).toContain("方案 A 审查子代理失败");
		expect(partial.result.reportMarkdown).toContain("未经审查不可作为最终选项");
	});

	it("stops before later stages once cancelled", async () => {
		const controller = new AbortController();
		const { result, calls } = await run({ onCall: () => controller.abort() }, { signal: controller.signal });
		expect(result.status).toBe("cancelled");
		expect(calls.filter(call => parseMarker(call.task).role === "alignment")).toHaveLength(0);
	});

	it("feeds the full review processing narrative to the synthesis stage", async () => {
		const { result, calls } = await run({
			review: ({ recheck }) => (recheck ? reviewData({ priorStatus: "resolved" }) : reviewData({ blocking: 1 })),
			revision: () =>
				revisionData({ claimsResolvedBlocking: true }, [
					{
						finding: "阻断问题 1",
						disposition: "rejected-with-evidence",
						explanation: "接口 Z 实际存在（src/z.ts:12），该质疑不成立",
					},
				]),
		});
		expect(result.status).toBe("completed");
		const synthesisCall = calls.find(call => parseMarker(call.task).role === "synthesis")!;
		const task = synthesisCall.task;
		// Initial findings with their evidence reach the synthesis input.
		expect(task).toContain("阻断问题 1");
		expect(task).toContain("方案不能采用");
		expect(task).toContain("src/x.ts");
		// The proposer's per-finding response with its disposition and evidence.
		expect(task).toContain("举证不接受");
		expect(task).toContain("接口 Z 实际存在（src/z.ts:12）");
		// The recheck's adjudication of the prior blocking finding.
		expect(task).toContain("此前阻断问题 resolved");
	});

	it("excludes a no-viable proposal from options and review targets", async () => {
		const { result, calls } = await run({
			proposal: call => (call.label.endsWith("B") ? noViableProposalData() : proposalData("A")),
		});
		expect(result.status).toBe("completed");
		const reviewTargets = calls
			.filter(call => parseMarker(call.task).role === "review")
			.map(call => parseMarker(call.task).target);
		expect(reviewTargets).toEqual(["A", "C"]);
		const markdown = result.reportMarkdown!;
		expect(markdown).toContain("提案者报告未形成可行方案");
		// B's status row must not read as an adoptable option.
		const bRow = markdown.split("\n").find(line => line.includes("| 方案 B |"))!;
		expect(bRow).toContain("尚不可采用");
		// The declaration is visible to alignment and synthesis inputs.
		const alignmentTask = calls.find(call => parseMarker(call.task).role === "alignment")!.task;
		expect(alignmentTask).toContain("提案者声明：未形成可行方案");
		const synthesisTask = calls.find(call => parseMarker(call.task).role === "synthesis")!.task;
		expect(synthesisTask).toContain("提案者声明：依据不足");
	});

	it("completes with an explanation when every proposal reports no viable plan", async () => {
		const { result, calls } = await run({ proposal: () => noViableProposalData() });
		expect(result.status).toBe("completed");
		expect(calls.filter(call => parseMarker(call.task).role === "review")).toHaveLength(0);
		expect(calls.filter(call => parseMarker(call.task).role === "revision")).toHaveLength(0);
		expect(calls.filter(call => parseMarker(call.task).role === "synthesis")).toHaveLength(1);
		expect(result.reportMarkdown).toContain("提案者报告未形成可行方案");
		expect(result.reportMarkdown).not.toContain("✅ 可作为选项");
	});

	it("enforces the concurrency semaphore across the proposal fan-out", async () => {
		let active = 0;
		let peak = 0;
		const { runner } = createScriptedRunner({
			proposal: call => {
				return proposalData(call.label.at(-1) ?? "A");
			},
		});
		const wrapped: TeamSubagentRunner = async (call, signal) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise(resolve => setTimeout(resolve, 15));
			active--;
			return runner(call, signal);
		};
		const result = await runTeamDiscussion({
			question: "并发测试",
			cwd: "/tmp/repo",
			participants: participants3(),
			sessionModelPattern: PATTERN_A,
			runner: wrapped,
			signal: new AbortController().signal,
			maxConcurrency: 2,
		});
		expect(result.status).toBe("completed");
		expect(peak).toBeLessThanOrEqual(2);
	});
});
