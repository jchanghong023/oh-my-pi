/**
 * `/team` orchestrator unit tests with a deterministic stub runner.
 *
 * Covers the mechanical guarantees from docs-zh-CN/requirements/team.md §6: stage flow and
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
	resolveTeamParticipants,
} from "@oh-my-pi/pi-coding-agent/team";
import type {
	TeamParticipant,
	TeamProgressUpdate,
	TeamSubagentCall,
	TeamSubagentRunner,
	TeamReviewRecord,
	TeamBlockingResolution,
} from "@oh-my-pi/pi-coding-agent/team";

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
	resolutions?: TeamBlockingResolution[];
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
		blockingResolutions: options?.resolutions ?? [],
	};
}

function revisionData(
	flags: Partial<Record<string, boolean>> = {},
	findingIds: readonly string[] = [],
	responses?: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		revisedProposal: "修订后的方案：同上并补充迁移步骤。",
		revisionSummary: "补充迁移",
		responses:
			responses ??
			findingIds.map(findingId => ({
				findingId,
				disposition: "accepted-and-revised",
				explanation: "已补充",
			})),
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
		hardConstraintViolations: [],
	};
}

function resolutions(ids: readonly string[], status: "resolved" | "unresolved"): TeamBlockingResolution[] {
	return ids.map(findingId => ({
		findingId,
		status,
		basis: status === "resolved" ? "Source confirms the repair" : "The original counterexample still applies",
	}));
}

// Read only the supplied current obligation set, never historical IDs or model output.
function requestedFindingIds(task: string, heading: string): string[] {
	const section = task.indexOf(heading);
	if (section < 0) throw new Error(`Missing finding input: ${heading}`);
	const json = /```json\s*([\s\S]*?)```/.exec(task.slice(section));
	if (!json) throw new Error(`Missing finding JSON: ${heading}`);
	return (JSON.parse(json[1]!) as { id: string }[]).map(finding => finding.id);
}

interface Script {
	proposal?: (call: TeamSubagentCall) => Record<string, unknown> | { __fail: string };
	review?: (info: {
		target: string;
		round: number;
		recheck: boolean;
		blockingIds: string[];
	}) => Record<string, unknown> | { __fail: string };
	revision?: (info: {
		target: string;
		round: number;
		findingIds: string[];
	}) => Record<string, unknown> | { __fail: string };
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
					script.review?.({
						target: marker.target!,
						round: marker.round!,
						recheck: marker.recheck,
						blockingIds: marker.recheck ? requestedFindingIds(call.task, "## 此前未解决的阻断问题") : [],
					}) ?? reviewData();
				break;
			case "revision": {
				const findingIds = requestedFindingIds(
					call.task,
					"## 本轮必须回应的完整问题集（最新审查问题与所有未解决阻断按 ID 合并）",
				);
				outcome =
					script.revision?.({ target: marker.target!, round: marker.round!, findingIds }) ??
					revisionData({}, findingIds);
				break;
			}
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

/** A three-model fixture that explicitly includes the session model (PATTERN_A). */
function participants3(): TeamParticipant[] {
	return [participantOf(MODEL_A, 0, true), participantOf(MODEL_B, 1), participantOf(MODEL_C, 2)];
}

async function run(
	script: Script,
	options?: {
		participants?: TeamParticipant[];
		maxConcurrency?: number;
		signal?: AbortSignal;
		onProgress?: (update: TeamProgressUpdate) => void;
	},
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
		onProgress: options?.onProgress,
	});
	return { result, calls };
}

describe("team malformed-output gates", () => {
	it("does not synthesize when all reviewers omit the structured verdict", async () => {
		const { result, calls } = await run({ review: () => ({ reviewSummary: "Looks fine" }) });
		expect(result.status).toBe("failed");
		expect(calls.some(call => call.role === "synthesizer")).toBe(false);
	});

	it("rejects a review whose summary plus findings exceed the total text budget", async () => {
		const oversizedReview = {
			...reviewData({ blocking: 1 }),
			reviewSummary: "x".repeat(1500),
		};
		const { result, calls } = await run({ review: () => oversizedReview });
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("全部审查子代理失败");
		expect(calls.some(call => call.role === "synthesizer")).toBe(false);
	});

	it("does not install a revision whose recheck flags are missing", async () => {
		const { result, calls } = await run({
			review: () => reviewData({ blocking: 1 }),
			revision: ({ findingIds }) => ({
				...revisionData({}, findingIds),
				revisedProposal: "invalid-revision-marker-43d",
				reviewFlags: {},
			}),
			synthesis: () => synthesisData("A"),
		});
		expect(result.status).toBe("completed");
		expect(result.droppedRecommendation).toBe(true);
		expect(calls.filter(call => call.role === "reviser")).toHaveLength(3);
		expect(calls.filter(call => call.role === "reviewer")).toHaveLength(3);
		const synthesis = calls.find(call => call.role === "synthesizer");
		expect(synthesis?.task).not.toContain("invalid-revision-marker-43d");
	});
});

describe("team visible participant settlement", () => {
	it("publishes proposer and reviewer failure in their own stage rather than waiting for the next stage", async () => {
		const updates: TeamProgressUpdate[] = [];
		await run(
			{
				proposal: call => (call.label.endsWith("A") ? { __fail: "unavailable" } : proposalData(call.label.at(-1)!)),
				review: ({ target }) => (target === "C" ? { __fail: "review failed" } : reviewData()),
			},
			{ onProgress: update => updates.push(update) },
		);
		expect(
			updates.some(
				update =>
					update.stage === "investigation" &&
					update.participants.some(participant => participant.label === "A" && participant.state === "failed"),
			),
		).toBe(true);
		expect(
			updates.some(
				update =>
					update.stage === "review" &&
					update.participants.some(
						participant => participant.label === "review-C" && participant.state === "failed",
					),
			),
		).toBe(true);
	});

	it("announces done only after the assembled report is confirmed valid", async () => {
		// A synthesis body conflicting with structured tracking fails the run
		// after the synthesis call already succeeded; the progress stream must
		// not have claimed 讨论完成 for a run that ends failed.
		const conflictedUpdates: TeamProgressUpdate[] = [];
		const conflicted = await run(
			{
				review: () => reviewData({ blocking: 1 }),
				revision: ({ findingIds }) => revisionData({}, findingIds),
				synthesis: () => ({ ...synthesisData("A"), reportMarkdown: "### 核心方案\n**【推荐】方案 A**" }),
			},
			{ onProgress: update => conflictedUpdates.push(update) },
		);
		expect(conflicted.result.status).toBe("failed");
		expect(conflictedUpdates.some(update => update.stage === "done")).toBe(false);

		// Control: a valid run still announces done exactly once.
		const completedUpdates: TeamProgressUpdate[] = [];
		const completed = await run({}, { onProgress: update => completedUpdates.push(update) });
		expect(completed.result.status).toBe("completed");
		expect(completedUpdates.filter(update => update.stage === "done")).toHaveLength(1);
	});
});

describe("team reviewer rotation", () => {
	it("assigns the next different model in proposer order, wrapping around", () => {
		const participants = participants3();
		expect(assignReviewerParticipant(participants, 0)).toBe(participants[1]);
		expect(assignReviewerParticipant(participants, 1)).toBe(participants[2]);
		// Wraps to the session-model participant, which runs as a fresh reviewer subprocess.
		expect(assignReviewerParticipant(participants, 2)).toBe(participants[0]);
	});

	it("uses the session-model participant as a reviewer subprocess when it is next and different", () => {
		const session = participantOf(MODEL_A, 0, true);
		const b = participantOf(MODEL_B, 1);
		const c = participantOf(MODEL_C, 2);
		expect(assignReviewerParticipant([session, b, c], 0)).toBe(b);
		expect(assignReviewerParticipant([session, b, c], 1)).toBe(c);
		expect(assignReviewerParticipant([session, b, c], 2)).toBe(session);
		// With two distinct models, B is reviewed by a fresh child using session model A.
		expect(assignReviewerParticipant([session, b], 1)).toBe(session);
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

	it("closes blockers by exact ID, retaining identical issues and newly discovered blockers", () => {
		const finding = reviewData({ blocking: 1 }).findings as TeamReviewRecord["findings"];
		const first = { ...finding[0]!, id: "A-F1" };
		const second = { ...finding[0]!, id: "A-F2" };
		const initial = { ...reviewData({ blocking: 2 }), findings: [first, second] } as TeamReviewRecord;
		expect(computeUnresolvedBlocking([initial])).toEqual([first, second]);
		const partial = {
			...reviewData(),
			blockingResolutions: [...resolutions(["A-F1"], "resolved"), ...resolutions(["A-F2"], "unresolved")],
		} as TeamReviewRecord;
		expect(computeUnresolvedBlocking([initial, partial])).toEqual([second]);
		const third = { ...first, id: "A-F3" };
		const final = {
			...reviewData({ blocking: 1 }),
			findings: [third],
			blockingResolutions: resolutions(["A-F2"], "resolved"),
		} as TeamReviewRecord;
		expect(computeUnresolvedBlocking([initial, partial, final])).toEqual([third]);
	});
});

describe("team per-finding closure", () => {
	it.each(["resolved", "unresolved"] as const)(
		"carries only the remaining blocker into round two (%s)",
		async status => {
			const reviewInputs: string[][] = [];
			const revisionInputs: string[][] = [];
			const { result, calls } = await run(
				{
					review: ({ recheck, round, blockingIds }) => {
						if (!recheck) return reviewData({ blocking: 2 });
						reviewInputs.push(blockingIds);
						return reviewData({
							important: round === 1 ? 1 : 0,
							resolutions:
								round === 1
									? [...resolutions(["A-F1"], "resolved"), ...resolutions(["A-F2"], "unresolved")]
									: resolutions(blockingIds, status),
						});
					},
					revision: ({ findingIds }) => {
						revisionInputs.push(findingIds);
						return revisionData({ claimsResolvedBlocking: true }, findingIds);
					},
					synthesis: () => synthesisData("A"),
				},
				{ participants: [participantOf(MODEL_A, 0, true)] },
			);
			expect(result.status).toBe("completed");
			expect(reviewInputs).toEqual([["A-F1", "A-F2"], ["A-F2"]]);
			expect(revisionInputs).toEqual([
				["A-F1", "A-F2"],
				["A-F3", "A-F2"],
			]);
			expect(calls.filter(call => call.role === "reviser")).toHaveLength(2);
			if (status === "resolved") {
				expect(result.reportMarkdown).toContain("| 方案 A | ✅ 可作为选项");
				expect(result.reportMarkdown).toContain("【推荐】方案 A");
			} else {
				const row = result.reportMarkdown!.split("\n").find(line => line.startsWith("| 方案 A |"))!;
				expect(row).toContain("A-F2");
				expect(row).not.toContain("A-F1");
				expect(result.droppedRecommendation).toBe(true);
				expect(result.reportMarkdown).not.toContain("【推荐】");
			}
			expect(result.reportMarkdown).not.toContain("[object Object]");
		},
	);

	it.each(["unknown", "duplicate", "missing", "baseless"] as const)(
		"does not let a %s decision unlock blockers or buy a third round",
		async kind => {
			const inputs: string[][] = [];
			const { result, calls } = await run(
				{
					review: ({ recheck, blockingIds }) => {
						if (!recheck) return reviewData({ blocking: 2 });
						inputs.push(blockingIds);
						const decisions = resolutions(blockingIds, "resolved");
						if (kind === "unknown") decisions[1]!.findingId = "A-F999";
						if (kind === "duplicate") decisions[1]!.findingId = decisions[0]!.findingId;
						if (kind === "missing") decisions.pop();
						if (kind === "baseless") decisions[1]!.basis = " ";
						return reviewData({ resolutions: decisions });
					},
					revision: ({ findingIds }) => revisionData({ claimsResolvedBlocking: true }, findingIds),
					synthesis: () => synthesisData("A"),
				},
				{ participants: [participantOf(MODEL_A, 0, true)] },
			);
			expect(inputs).toEqual([
				["A-F1", "A-F2"],
				["A-F1", "A-F2"],
			]);
			expect(calls.filter(call => call.role === "reviser")).toHaveLength(2);
			expect(result.status).toBe("completed");
			expect(result.droppedRecommendation).toBe(true);
			expect(result.reportMarkdown).toContain("修订后必需复核未完成");
			expect(result.reportMarkdown).toContain("A-F1");
			expect(result.reportMarkdown).toContain("A-F2");
			expect(result.reportMarkdown).not.toContain("【推荐】");
		},
	);

	it("recovers from invalid required recheck without allocating IDs for discarded findings", async () => {
		const inputs: string[][] = [];
		const { result, calls } = await run(
			{
				review: ({ recheck, round, blockingIds }) => {
					if (!recheck) return reviewData({ blocking: 1 });
					inputs.push(blockingIds);
					if (round === 1) return reviewData({ blocking: 1, resolutions: resolutions(["A-F999"], "resolved") });
					return reviewData({ blocking: 1, resolutions: resolutions(blockingIds, "resolved") });
				},
				revision: ({ findingIds }) => revisionData({ claimsResolvedBlocking: true }, findingIds),
				synthesis: () => synthesisData("A"),
			},
			{ participants: [participantOf(MODEL_A, 0, true)] },
		);
		expect(inputs).toEqual([["A-F1"], ["A-F1"]]);
		expect(calls.filter(call => call.role === "reviser")).toHaveLength(2);
		expect(result.status).toBe("completed");
		const row = result.reportMarkdown!.split("\n").find(line => line.startsWith("| 方案 A |"))!;
		expect(row).toContain("A-F2");
		expect(row).not.toContain("A-F1");
		expect(row).not.toContain("A-F3");
		expect(result.reportMarkdown).not.toContain("修订后必需复核未完成");
		expect(result.droppedRecommendation).toBe(true);
	});

	it("keeps a new blocker with repeated issue text distinct from the resolved original", async () => {
		const inputs: string[][] = [];
		const { result } = await run(
			{
				review: ({ recheck, round, blockingIds }) => {
					if (!recheck) return reviewData({ blocking: 1 });
					inputs.push(blockingIds);
					return reviewData({
						blocking: round === 1 ? 1 : 0,
						resolutions: resolutions(blockingIds, round === 1 ? "resolved" : "unresolved"),
					});
				},
				revision: ({ findingIds }) => revisionData({ claimsResolvedBlocking: true }, findingIds),
				synthesis: () => synthesisData("A"),
			},
			{ participants: [participantOf(MODEL_A, 0, true)] },
		);
		expect(inputs).toEqual([["A-F1"], ["A-F2"]]);
		const row = result.reportMarkdown!.split("\n").find(line => line.startsWith("| 方案 A |"))!;
		expect(row).toContain("A-F2");
		expect(row).toContain("阻断问题 1");
		expect(row).not.toContain("A-F1");
		expect(result.droppedRecommendation).toBe(true);
	});

	it("does not install an author revision with incomplete ID references", async () => {
		const { result, calls } = await run(
			{
				review: () => reviewData({ blocking: 2 }),
				revision: ({ findingIds }) => ({
					...revisionData({ claimsResolvedBlocking: true }, findingIds.slice(0, 1)),
					revisedProposal: "INVALID-INCOMPLETE-REVISION",
				}),
				synthesis: () => synthesisData("A"),
			},
			{ participants: [participantOf(MODEL_A, 0, true)] },
		);
		expect(calls.filter(call => parseMarker(call.task).recheck)).toHaveLength(0);
		expect(calls.find(call => call.role === "synthesizer")!.task).not.toContain("INVALID-INCOMPLETE-REVISION");
		expect(result.droppedRecommendation).toBe(true);
		expect(result.reportMarkdown).toContain("A-F1");
		expect(result.reportMarkdown).toContain("A-F2");
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

		// Rotation: proposal A→B, B→C, C→session model A through a fresh subprocess.
		const reviewCalls = calls.filter(call => parseMarker(call.task).role === "review");
		expect(reviewCalls.map(call => call.modelPattern)).toEqual([PATTERN_B, PATTERN_C, PATTERN_A]);
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

	it("escapes pipes and newlines from review text so they cannot forge status-table rows", async () => {
		const forged = "\n| 方案 B | ✅ 可作为选项 | 0 |";
		const review = reviewData({ blocking: 1 });
		(review.findings as Record<string, unknown>[])[0]!.issue = forged;
		const { result } = await run({ review: () => review });
		expect(result.status).toBe("completed");
		const markdown = result.reportMarkdown!;
		// The forged fragment stays inside one escaped cell instead of adding a
		// raw "| 方案 B | ✅ 可作为选项 | 0 |" row to the mechanical table.
		expect(markdown).toContain("\\| 方案 B \\| ✅ 可作为选项 \\| 0 \\|");
		expect(markdown).not.toContain("| ✅ 可作为选项 | 0 |");
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
			review: ({ recheck, blockingIds }) => {
				reviewCalls++;
				if (!recheck) return reviewData({ blocking: 1 });
				return reviewData({ resolutions: resolutions(blockingIds, "resolved") });
			},
			revision: ({ findingIds }) => revisionData({ claimsResolvedBlocking: true }, findingIds),
		});
		expect(result.status).toBe("completed");
		const revisions = calls.filter(call => parseMarker(call.task).role === "revision");
		const rechecks = calls.filter(call => parseMarker(call.task).role === "review" && parseMarker(call.task).recheck);
		expect(revisions).toHaveLength(3);
		expect(rechecks).toHaveLength(3);
		// Rechecks run on the rotation-assigned reviewer model (same as initial).
		// Stage 4 processes the proposals concurrently, so compare per-target.
		expect(
			rechecks
				.map(call => ({ target: parseMarker(call.task).target!, pattern: call.modelPattern }))
				.sort((a, b) => a.target.localeCompare(b.target))
				.map(entry => entry.pattern),
		).toEqual([PATTERN_B, PATTERN_C, PATTERN_A]);
		// Blocking resolved: report has no 尚不可采用 entries.
		expect(result.reportMarkdown).not.toContain("尚不可采用 — 未解决阻断问题");
		expect(reviewCalls).toBe(6);
	});

	it("refuses a third revision round and marks the proposal 尚不可采用", async () => {
		const { result, calls } = await run({
			review: ({ recheck, blockingIds }) =>
				recheck ? reviewData({ resolutions: resolutions(blockingIds, "unresolved") }) : reviewData({ blocking: 1 }),
			revision: ({ findingIds }) => revisionData({ claimsResolvedBlocking: true }, findingIds),
		});
		expect(result.status).toBe("completed");
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
			revision: ({ findingIds }) => revisionData({}, findingIds),
			synthesis: () => synthesisData("A"),
		});
		const rechecks = calls.filter(call => parseMarker(call.task).recheck);
		expect(rechecks).toHaveLength(0);
		// Without a recheck the blocking state cannot change (§2.5: 不强凑修订
		// 轮次): one revision round per proposal, then it stays blocked.
		const revisions = calls.filter(call => parseMarker(call.task).role === "revision");
		expect(revisions).toHaveLength(3);
		expect(result.reportMarkdown).toContain("尚不可采用 — 未解决阻断问题");
		expect(result.droppedRecommendation).toBe(true);
		expect(result.reportMarkdown).toContain("A-F1");
		expect(result.reportMarkdown).not.toContain("【推荐】");
	});

	it("marks the two-round cap when round two leaves a blocking finding unresolved", async () => {
		const { result, calls } = await run({
			review: ({ recheck, blockingIds }) =>
				recheck ? reviewData({ resolutions: resolutions(blockingIds, "unresolved") }) : reviewData({ blocking: 1 }),
			revision: ({ round, findingIds }) =>
				revisionData(round === 1 ? { claimsResolvedBlocking: true } : {}, findingIds),
		});
		const revisions = calls.filter(call => parseMarker(call.task).role === "revision");
		expect(revisions).toHaveLength(6);
		expect(result.reportMarkdown).toContain("尚不可采用 — 未解决阻断问题（两轮修订后仍未解决）");
	});

	it("marks a recheck-failed revision 尚不可采用 instead of riding the initial review's clean status", async () => {
		const { result, calls } = await run({
			// Initial review finds only important issues — no recorded blocking —
			// so the unverified revision must not inherit an adoptable status.
			review: ({ recheck }) => (recheck ? { __fail: "recheck boom" } : reviewData({ important: 1 })),
			revision: ({ findingIds }) => revisionData({ changedCoreDesign: true }, findingIds),
			synthesis: () => synthesisData("A"),
		});
		expect(result.status).toBe("completed");
		expect(result.reportMarkdown).toContain("修订后必需复核未完成");
		expect(result.reportMarkdown).not.toContain("✅ 可作为选项");
		expect(result.reportMarkdown).toContain("复核子代理失败");
		// The unverified version must not be recommended either.
		expect(result.droppedRecommendation).toBe(true);
		expect(result.reportMarkdown).not.toContain("【推荐】");
		// Both rounds are spent trying to verify the revised version: 2 revision
		// rounds and 2 recheck attempts per proposal.
		const revisions = calls.filter(call => parseMarker(call.task).role === "revision");
		const rechecks = calls.filter(call => parseMarker(call.task).recheck);
		expect(revisions).toHaveLength(6);
		expect(rechecks).toHaveLength(6);
	});

	it("lets a later round's successful recheck verify the revision after an earlier failure", async () => {
		const { result, calls } = await run({
			review: ({ recheck, round }) => {
				if (!recheck) return reviewData({ important: 1 });
				if (round === 1) return { __fail: "recheck boom" };
				return reviewData();
			},
			revision: ({ findingIds }) => revisionData({ changedCoreDesign: true }, findingIds),
			synthesis: () => synthesisData("A"),
		});
		expect(result.status).toBe("completed");
		// The round-2 recheck verified the revised version, so it is adoptable
		// and recommendable again despite the round-1 failure.
		expect(result.reportMarkdown).toContain("✅ 可作为选项");
		expect(result.droppedRecommendation).toBeFalsy();
		expect(result.reportMarkdown).toContain("【推荐】方案 A");
		const rechecks = calls.filter(call => parseMarker(call.task).recheck);
		expect(rechecks).toHaveLength(6); // one failed + one successful per proposal
		// Recovery removes the current failure note without deleting the
		// failed first attempt from the historical review/revision pairing.
		expect(result.reportMarkdown).not.toContain("复核子代理失败，阻断问题是否解决未能确认");
		const synthesisTask = calls.find(call => call.role === "synthesizer")!.task;
		expect(synthesisTask).not.toContain("参与不完整");
	});

	it.each([false, true])(
		"keeps V0 as the reviewed baseline across an unverified V1 and rechecks the cumulative V2 changes (recovery=%s)",
		async recovery => {
			const original = "V0: use the existing durable queue";
			const firstChange = "V1: replace the queue with an in-memory handoff";
			const secondChange = "V2: add a handoff timeout";
			const firstEvidence = "docs/queue-contract.md:84 proves durability is required";
			const firstRebuttal = "The caller retries after process restart; keep the durability objection open";
			const { result, calls } = await run(
				{
					proposal: () => ({ ...proposalData("A"), proposal: original }),
					review: ({ recheck, round }) => {
						if (!recheck) return reviewData({ important: 1 });
						if (round === 1 || !recovery) return { __fail: "review process unavailable" };
						return reviewData();
					},
					revision: ({ round, findingIds }) => ({
						...revisionData(
							{ changedCoreDesign: true },
							findingIds,
							findingIds.map(findingId => ({
								findingId,
								disposition: round === 1 ? "rejected-with-evidence" : "accepted-and-revised",
								explanation: round === 1 ? firstEvidence : "Bound waiting",
							})),
						),
						revisedProposal: round === 1 ? firstChange : secondChange,
						revisionSummary: round === 1 ? firstRebuttal : "Add timeout only",
					}),
					synthesis: () => ({ ...synthesisData("A"), reportMarkdown: "Compare durability and timeout evidence." }),
				},
				{ participants: [participantOf(MODEL_A, 0, true)] },
			);
			const rechecks = calls.filter(call => parseMarker(call.task).recheck);
			expect(rechecks).toHaveLength(2);
			expect(rechecks[0]!.task).toContain(original);
			// V1 never completed review. The next reviewer must compare V2 to
			// V0, not merely inspect the timeout delta from unreviewed V1.
			expect(rechecks[1]!.task).toContain(original);
			expect(rechecks[1]!.task).toContain(firstChange);
			expect(rechecks[1]!.task).toContain(secondChange);
			expect(rechecks[1]!.task).toContain(firstEvidence);
			expect(rechecks[1]!.task).toContain(firstRebuttal);
			const synthesisTask = calls.find(call => call.role === "synthesizer")!.task;
			expect(synthesisTask).toContain(firstEvidence);
			expect(synthesisTask).toContain(firstRebuttal);
			expect(synthesisTask).toContain(firstChange);
			expect(synthesisTask).toContain(secondChange);
			expect(result.status).toBe("completed");
			if (recovery) {
				expect(result.reportMarkdown).toContain("| 方案 A | ✅ 可作为选项");
				expect(result.reportMarkdown).toContain("【推荐】方案 A");
				expect(result.droppedRecommendation).toBeFalsy();
			} else {
				expect(result.reportMarkdown).toContain("| 方案 A | ⛔ 尚不可采用");
				expect(result.reportMarkdown).toContain("修订后必需复核未完成");
				expect(result.droppedRecommendation).toBe(true);
			}
		},
	);

	it("advances the recheck baseline only after success while keeping earlier responses at synthesis", async () => {
		const firstEvidence = "src/legacy-reader.ts:41 accepts the previous wire format";
		const { result, calls } = await run(
			{
				proposal: () => ({ ...proposalData("A"), proposal: "V0: current wire format" }),
				review: ({ recheck, round, blockingIds }) =>
					!recheck
						? reviewData({ blocking: 1 })
						: reviewData({ resolutions: resolutions(blockingIds, round === 1 ? "unresolved" : "resolved") }),
				revision: ({ round, findingIds }) => ({
					...revisionData(
						{ claimsResolvedBlocking: true },
						findingIds,
						findingIds.map(findingId => ({
							findingId,
							disposition: "accepted-and-revised",
							explanation: round === 1 ? firstEvidence : "Preserve both versions",
						})),
					),
					revisedProposal: round === 1 ? "V1: versioned wire format" : "V2: dual format reader",
					revisionSummary: round === 1 ? "Introduce version tags" : "Restore compatibility",
				}),
				synthesis: () => ({ ...synthesisData("A"), reportMarkdown: "Evaluate both wire format revisions." }),
			},
			{ participants: [participantOf(MODEL_A, 0, true)] },
		);
		const secondRecheck = calls.filter(call => parseMarker(call.task).recheck)[1]!.task;
		expect(secondRecheck).toContain("V1: versioned wire format");
		expect(secondRecheck).not.toContain("V0: current wire format");
		expect(secondRecheck).not.toContain(firstEvidence);
		const synthesisTask = calls.find(call => call.role === "synthesizer")!.task;
		expect(synthesisTask).toContain(firstEvidence);
		expect(synthesisTask).toContain("Introduce version tags");
		expect(synthesisTask).toContain("Restore compatibility");
		expect(result.status).toBe("completed");
		expect(result.droppedRecommendation).toBeFalsy();
	});

	it("drops a recommendation that structured tracking rejects", async () => {
		const { result } = await run({
			review: ({ recheck, blockingIds }) =>
				recheck ? reviewData({ resolutions: resolutions(blockingIds, "unresolved") }) : reviewData({ blocking: 1 }),
			revision: ({ findingIds }) => revisionData({ claimsResolvedBlocking: true }, findingIds),
			synthesis: () => synthesisData("A"),
		});
		expect(result.status).toBe("completed");
		expect(result.droppedRecommendation).toBe(true);
		expect(result.reportMarkdown).toContain("结构化追踪否决了综合子调用对“A”的推荐");
		expect(result.reportMarkdown).not.toContain("【推荐】");
	});

	it("tightens eligibility when synthesis discovers a hard-constraint violation", async () => {
		const { result } = await run({
			review: ({ target }) => reviewData({ important: target === "A" ? 1 : 0 }),
			synthesis: () => ({
				...synthesisData("A"),
				hardConstraintViolations: [
					{ proposalLabel: "A", issue: "破坏旧接口兼容", evidence: "src/x.ts:10 与共同验收标准冲突" },
				],
			}),
		});
		expect(result.status).toBe("completed");
		expect(result.reportMarkdown).toContain("| 方案 A | ⛔ 尚不可采用");
		expect(result.reportMarkdown).toContain("破坏旧接口兼容");
		expect(result.reportMarkdown).toContain("src/x.ts:10");
		expect(result.reportMarkdown).toContain("A-F2");
		expect(result.reportMarkdown).toContain("| 方案 B | ✅ 可作为选项");
		expect(result.droppedRecommendation).toBe(true);
		expect(result.reportMarkdown).not.toContain("【推荐】");
	});

	it("rejects synthesis violations naming a nonexistent candidate", async () => {
		const { result } = await run({
			synthesis: () => ({
				...synthesisData("A"),
				hardConstraintViolations: [{ proposalLabel: "Z", issue: "破坏兼容", evidence: "src/x.ts:10" }],
			}),
		});
		expect(result.status).toBe("failed");
		expect(result.reportMarkdown).toBeUndefined();
		expect(result.failureReason).toContain("不存在的方案 Z");
	});

	it("rejects a body that adopts a proposal blocked by synthesis itself", async () => {
		const { result } = await run({
			synthesis: () => ({
				...synthesisData("A"),
				reportMarkdown: "方案 A，可以采用。",
				hardConstraintViolations: [{ proposalLabel: "A", issue: "破坏兼容", evidence: "src/x.ts:10" }],
			}),
		});
		expect(result.status).toBe("failed");
		expect(result.reportMarkdown).toBeUndefined();
		expect(result.failureReason).toContain("尚不可采用");
	});

	it("checks separated adoption claims without rejecting negation or guarded adoption", async () => {
		const script = {
			review: ({ target }: { target: string }) => reviewData({ blocking: target === "A" ? 1 : 0 }),
			revision: ({ findingIds }: { findingIds: string[] }) => revisionData({}, findingIds),
		};
		for (const [reportMarkdown, expectedStatus] of [
			["方案 A，可以采用。", "failed"],
			["方案 A\n可以采用。", "failed"],
			["建议采用方案 A。", "failed"],
			["方案 A 建议采用。", "failed"],
			["方案 A 使用 v1.0 接口，可以采用。", "failed"],
			["方案 A 修改 reader.ts，可以采用。", "failed"],
			["方案 A 使用 src/reader.ts，推荐。", "failed"],
			["方案 A 使用 api.v1.reader，可以采用。", "failed"],
			["方案 A 不再推荐。", "completed"],
			["方案 A 不予推荐。", "completed"],
			["方案 A 不再推荐，不过当前可采用。", "failed"],
			["方案 A 不予推荐，仍可作为选项。", "failed"],
			["不建议采用方案 A。", "completed"],
			["问题解决后，建议采用方案 A。", "completed"],
			["方案 A 不作为首选。", "completed"],
			["问题解决后，方案 A 即可采用。", "completed"],
		] as const) {
			const { result } = await run({
				...script,
				synthesis: () => ({ ...synthesisData("B"), reportMarkdown }),
			});
			expect(result.status).toBe(expectedStatus);
			if (expectedStatus === "failed") {
				expect(result.reportMarkdown).toBeUndefined();
				expect(result.failureReason).toContain("尚不可采用");
			} else {
				expect(result.reportMarkdown).toContain("【推荐】方案 B");
				expect(result.reportMarkdown).toContain("| 方案 A | ⛔ 尚不可采用");
			}
		}
	});

	it("does not publish a synthesis body that recommends a blocked proposal", async () => {
		const script = {
			review: () => reviewData({ blocking: 1 }),
			revision: ({ findingIds }: { findingIds: string[] }) => revisionData({}, findingIds),
		};
		for (const body of [
			"### 核心方案\n**【推荐】方案 A**",
			"### 核心方案\n方案 A 可采用。",
			"### 核心方案\n方案 A 可作为选项。",
			"### 核心方案\n方案 A 可以作为最终选项。",
		] as const) {
			const { result } = await run({
				...script,
				synthesis: () => ({ ...synthesisData("A"), reportMarkdown: body }),
			});
			expect(result.status).toBe("failed");
			expect(result.failureReason).toContain("综合结果无效");
			expect(result.reportMarkdown).toBeUndefined();
		}

		const { result } = await run({
			...script,
			synthesis: () => ({
				...synthesisData("A"),
				reportMarkdown: "### 主要取舍\n方案 A 不可采用，方案 B 不可作为选项，方案 C 不可以作为最终选项。",
			}),
		});
		expect(result.status).toBe("completed");
		expect(result.droppedRecommendation).toBe(true);
	});

	it("keeps an eligible sibling's recommendation separate from a blocked proposal in comparisons", async () => {
		for (const body of [
			"方案 A（尚不可采用）劣于可作为选项的方案 B。",
			"推荐方案 B 而不是尚不可采用的方案 A。",
			"本次推荐，方案 A 的阻断问题源于旧接口缺少迁移。",
		]) {
			const { result } = await run({
				review: ({ target }) => reviewData({ blocking: target === "A" ? 1 : 0 }),
				revision: ({ findingIds }) => revisionData({}, findingIds),
				synthesis: () => ({ ...synthesisData("B"), reportMarkdown: body }),
			});
			expect(result.status).toBe("completed");
			expect(result.reportMarkdown).toContain("【推荐】方案 B");
			expect(result.reportMarkdown).toContain("尚不可采用 — 未解决阻断问题");
		}
	});

	it("still rejects adoption of a blocked proposal next to an eligible sibling", async () => {
		for (const body of [
			"方案 A 和方案 B 可以作为选项。",
			"推荐方案 B 和方案 A。",
			"方案 A 可作为选项优于方案 B。",
			"方案 A 当前仍有未解决阻断问题，推荐。",
		]) {
			const { result } = await run({
				review: ({ target }) => reviewData({ blocking: target === "A" ? 1 : 0 }),
				revision: ({ findingIds }) => revisionData({}, findingIds),
				synthesis: () => ({ ...synthesisData("B"), reportMarkdown: body }),
			});
			expect(result.status).toBe("failed");
			expect(result.failureReason).toContain("尚不可采用");
			expect(result.reportMarkdown).toBeUndefined();
		}
	});

	it("accepts conditional adoption statements about blocked proposals (§2.7 未采纳方向)", async () => {
		const script = {
			review: () => reviewData({ blocking: 1 }),
			revision: ({ findingIds }: { findingIds: string[] }) => revisionData({}, findingIds),
		};
		// Explaining *when* a blocked proposal could become adoptable is expected
		// synthesis content and must not be mistaken for a tracking override.
		for (const body of [
			"### 未采纳方向\n方案 A 在阻断问题 1 解决后即可采用。方案 B 不可作为选项。",
			"### 未采纳方向\n方案 A 待阻断问题 1 修复后即可采用。",
			"### 未采纳方向\n方案 A 若前提满足即可采用。",
			"### 未采纳方向\n方案 A 阻断问题解除之后可推荐。",
			"### 未采纳方向\n若干问题确认后方可采用方案 A。",
			"### 未采纳方向\n方案 A 在阻断问题 1 解决后即可作为选项。",
			"### 未采纳方向\n方案 A 若前提满足可以作为最终选项。",
		] as const) {
			const { result } = await run({
				...script,
				synthesis: () => ({ ...synthesisData(), reportMarkdown: body }),
			});
			expect(result.status).toBe("completed");
		}
		// An unconditional adoption claim still invalidates the run.
		const unconditional = await run({
			...script,
			synthesis: () => ({ ...synthesisData(), reportMarkdown: "### 核心方案\n方案 A 可采用。" }),
		});
		expect(unconditional.result.status).toBe("failed");
		// “推荐解决方案 A” reads as "recommend solution A" (no posteriority
		// marker follows 解决), so it must not be stripped as a conditional
		// clause either.
		const solutionPhrase = await run({
			...script,
			synthesis: () => ({
				...synthesisData(),
				reportMarkdown: "### 核心方案\n推荐解决方案 A。",
			}),
		});
		expect(solutionPhrase.result.status).toBe("failed");
		const backendClaim = await run({
			...script,
			synthesis: () => ({
				...synthesisData(),
				reportMarkdown: "### 核心方案\n方案 A 已解决后端问题可以采用。",
			}),
		});
		expect(backendClaim.result.status).toBe("failed");
		expect(backendClaim.result.reportMarkdown).toBeUndefined();
	});

	it("renders a valid recommendation with reason and preconditions", async () => {
		const { result } = await run({ synthesis: () => synthesisData("A") });
		expect(result.droppedRecommendation).toBeFalsy();
		expect(result.reportMarkdown).toContain("【推荐】方案 A");
		expect(result.reportMarkdown).toContain("前提：接口 Y 稳定");
	});

	it.each(["", " \t\n"])(
		"fails synthesis without publishing a recommendation when its reason is blank: %j",
		async reason => {
			const updates: TeamProgressUpdate[] = [];
			const { result } = await run(
				{ synthesis: () => ({ ...synthesisData("A"), recommendationReason: reason }) },
				{ onProgress: update => updates.push(update) },
			);
			expect(result.status).toBe("failed");
			expect(result.failureReason).toContain("综合子调用失败");
			expect(result.reportMarkdown).toBeUndefined();
			expect(updates.at(-1)?.participants.find(participant => participant.label === "synthesis")?.state).toBe(
				"failed",
			);
			expect(updates.some(update => update.stage === "done")).toBe(false);
		},
	);

	it("fails without half conclusions when the alignment sub-call fails", async () => {
		const updates: TeamProgressUpdate[] = [];
		const { result, calls } = await run(
			{ alignment: () => ({ __fail: "alignment boom" }) },
			{ onProgress: update => updates.push(update) },
		);
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("对齐子调用失败");
		expect(result.failureReason).toContain("不输出半成品结论");
		expect(calls.filter(call => parseMarker(call.task).role === "review")).toHaveLength(0);
		expect(
			updates.some(
				update =>
					update.stage === "alignment" &&
					update.participants.some(
						participant => participant.label === "alignment" && participant.state === "running",
					),
			),
		).toBe(true);
		expect(updates.at(-1)?.participants.find(participant => participant.label === "alignment")?.state).toBe("failed");
	});

	it("fails without half conclusions when the synthesis sub-call fails", async () => {
		const updates: TeamProgressUpdate[] = [];
		const { result } = await run(
			{ synthesis: () => ({ __fail: "synthesis boom" }) },
			{ onProgress: update => updates.push(update) },
		);
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("综合子调用失败");
		expect(result.reportMarkdown).toBeUndefined();
		expect(
			updates.some(
				update =>
					update.stage === "synthesis" &&
					update.participants.some(
						participant => participant.label === "synthesis" && participant.state === "running",
					),
			),
		).toBe(true);
		expect(updates.at(-1)?.participants.find(participant => participant.label === "synthesis")?.state).toBe("failed");
	});

	it("fails when every proposer fails", async () => {
		const { result, calls } = await run({ proposal: () => ({ __fail: "proposer boom" }) });
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("所有提案子代理均失败");
		expect(calls.filter(call => parseMarker(call.task).role === "alignment")).toHaveLength(0);
	});

	it("refuses oversized initial proposals before alignment or review", async () => {
		const { result, calls } = await run({
			proposal: () => ({
				...proposalData("A"),
				proposal: "p".repeat(3999),
				evidence: [{ claim: "evidence", source: "source" }],
			}),
		});
		expect(result.status).toBe("failed");
		expect(result.failureReason).toContain("所有提案子代理均失败");
		expect(calls.every(call => call.role === "proposer")).toBe(true);
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

	for (const maxConcurrency of [1, 2]) {
		it(`queues all repeated roster slots with maxConcurrency=${maxConcurrency}`, async () => {
			let active = 0;
			let peak = 0;
			const { runner, calls } = createScriptedRunner({});
			const firstWave = Promise.withResolvers<void>();
			const wrapped: TeamSubagentRunner = async (call, signal) => {
				active++;
				peak = Math.max(peak, active);
				if (active === maxConcurrency) firstWave.resolve();
				try {
					await firstWave.promise;
					return await runner(call, signal);
				} finally {
					active--;
				}
			};
			const roster = resolveTeamParticipants({
				configuredMembers: [PATTERN_B, PATTERN_C],
				sessionModel: MODEL_A,
				availableModels: [MODEL_A, MODEL_B, MODEL_C],
			});
			expect(roster.ok).toBe(true);
			if (!roster.ok) throw new Error(roster.error);
			const result = await runTeamDiscussion({
				question: "并发测试",
				cwd: "/tmp/repo",
				participants: roster.participants,
				sessionModelPattern: PATTERN_A,
				runner: wrapped,
				signal: new AbortController().signal,
				maxConcurrency,
			});
			expect(result.status).toBe("completed");
			expect(peak).toBe(maxConcurrency);
			expect(active).toBe(0);
			const proposals = calls.filter(call => call.role === "proposer");
			expect(proposals.map(call => call.label).sort()).toEqual([
				"team-proposal-A",
				"team-proposal-B",
				"team-proposal-C",
			]);
			expect(proposals.map(call => call.modelPattern)).toEqual([PATTERN_B, PATTERN_C, PATTERN_B]);
			const reviews = calls
				.filter(call => call.role === "reviewer")
				.map(call => ({ target: parseMarker(call.task).target, model: call.modelPattern }))
				.sort((left, right) => left.target!.localeCompare(right.target!));
			expect(reviews).toEqual([
				{ target: "A", model: PATTERN_C },
				{ target: "B", model: PATTERN_B },
				{ target: "C", model: PATTERN_C },
			]);
			expect(calls.filter(call => call.modelPattern === PATTERN_A).map(call => call.role)).toEqual([
				"aligner",
				"synthesizer",
			]);
			for (const label of ["A", "B", "C"]) {
				expect(result.reportMarkdown).toContain(`| 方案 ${label} | ✅ 可作为选项`);
			}
		});
	}
});
