/**
 * `/team` code-driven five-stage orchestrator.
 *
 * Every guarantee from docs-zh-CN/team.md is mechanical here:
 * - independent investigation: identical inputs fanned out in parallel under
 *   the `task.maxConcurrency` semaphore, no shared digest;
 * - reviewer rotation to the next different model (same model only when there
 *   is exactly one distinct model);
 * - revision rounds counted in code, third round refused;
 * - recheck reviews triggered by structured flags only;
 * - unresolved blocking findings tracked in code and rendered as
 *   "尚不可采用" regardless of what the synthesis text claims;
 * - alignment/synthesis failures abort the run (no half-finished conclusions);
 * - proposer/reviewer/reviser failures mark that participant failed and the
 *   rest continue, with participation noted.
 */
import { Semaphore } from "../task/parallel";
import {
	TEAM_ALIGNMENT_SCHEMA,
	TEAM_PROPOSAL_SCHEMA,
	TEAM_REVIEW_SCHEMA,
	TEAM_REVISION_SCHEMA,
	TEAM_SYNTHESIS_SCHEMA,
	parseTeamAlignment,
	parseTeamProposal,
	parseTeamReview,
	parseTeamRevision,
	parseTeamSynthesis,
} from "./schemas";
import {
	buildAlignmentTask,
	buildProposalTask,
	buildReviewTask,
	buildRevisionTask,
	buildSynthesisTask,
} from "./prompts";
import { assembleTeamReport } from "./report";
import type {
	TeamParticipant,
	TeamProgressUpdate,
	TeamProposalRecord,
	TeamRevisionFlags,
	TeamReviewOutput,
	TeamRunResult,
	TeamSubagentCall,
	TeamSubagentRunner,
} from "./types";

/** Hard cap: at most two revision(+recheck) rounds per proposal; the third is refused. */
export const TEAM_MAX_REVISION_ROUNDS = 2;

export interface TeamOrchestratorOptions {
	question: string;
	cwd: string;
	participants: readonly TeamParticipant[];
	/** Exact pattern of the session model; alignment and synthesis run on it. */
	sessionModelPattern: string;
	runner: TeamSubagentRunner;
	signal: AbortSignal;
	/** `task.maxConcurrency`; bounds parallel subagents in every fan-out stage. */
	maxConcurrency: number;
	onProgress?: (update: TeamProgressUpdate) => void;
}

/**
 * Rotation rule (§2.5): the reviewer for proposal i is the next participant
 * with a *different* model in proposer order; with a single distinct model the
 * same model's fresh subagent reviews.
 */
export function assignReviewerParticipant(
	participants: readonly TeamParticipant[],
	proposalIndex: number,
): TeamParticipant {
	const proposer = participants[proposalIndex];
	if (!proposer) throw new Error(`assignReviewerParticipant: invalid proposal index ${proposalIndex}`);
	const count = participants.length;
	for (let offset = 1; offset < count; offset++) {
		const candidate = participants[(proposalIndex + offset) % count];
		if (candidate.modelPattern !== proposer.modelPattern) return candidate;
	}
	return proposer;
}

/** A recheck review runs iff any structured flag is set. */
export function needsRecheck(flags: TeamRevisionFlags): boolean {
	return (
		flags.changedCoreDesign ||
		flags.claimsResolvedBlocking ||
		flags.newEvidenceChangesAssumptions ||
		flags.disputesBlockingFinding
	);
}

/**
 * Mechanically recompute the unresolved blocking list from the review chain:
 * the initial review's blocking findings stand until a recheck reports them
 * resolved; recheck-added blocking findings join the list. Reviews that never
 * happened (skipped recheck) leave the prior state untouched.
 */
export function computeUnresolvedBlocking(reviews: readonly TeamReviewOutput[]): string[] {
	const initial = reviews[0];
	if (!initial) return [];
	const initialBlocking = initial.findings
		.filter(finding => finding.severity === "blocking")
		.map(finding => finding.issue);
	const rechecks = reviews.slice(1);
	if (rechecks.length === 0) return initialBlocking;
	const last = rechecks[rechecks.length - 1];
	const newBlocking = last.findings.filter(finding => finding.severity === "blocking").map(finding => finding.issue);
	if (last.priorBlockingStatus === "resolved") return [...new Set(newBlocking)];
	return [...new Set([...initialBlocking, ...newBlocking])];
}

function proposalLabel(index: number): string {
	return String.fromCodePoint("A".codePointAt(0)! + index);
}

export async function runTeamDiscussion(options: TeamOrchestratorOptions): Promise<TeamRunResult> {
	const { question, cwd, participants, runner, signal } = options;
	const semaphore = new Semaphore(options.maxConcurrency);
	const participantStatus = new Map<
		string,
		{
			role: TeamProgressUpdate["participants"][number]["role"];
			state: TeamProgressUpdate["participants"][number]["state"];
		}
	>();
	const emitProgress = (stage: TeamProgressUpdate["stage"], text: string): void => {
		options.onProgress?.({
			stage,
			text,
			participants: [...participantStatus].map(([label, status]) => ({ label, ...status })),
		});
	};
	const trackParticipant = (
		label: string,
		role: TeamProgressUpdate["participants"][number]["role"],
		state: TeamProgressUpdate["participants"][number]["state"],
	): void => {
		participantStatus.set(label, { role, state });
	};

	/** Run one subagent call under the concurrency semaphore. */
	const runCall = async (
		call: TeamSubagentCall,
	): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> => {
		try {
			await semaphore.acquire(signal);
		} catch {
			return { ok: false, error: "cancelled while waiting for a concurrency slot" };
		}
		try {
			const outcome = await runner(call, signal);
			return outcome.ok ? { ok: true, data: outcome.data } : { ok: false, error: outcome.error };
		} finally {
			semaphore.release();
		}
	};

	if (signal.aborted) return { status: "cancelled" };

	// ── Stage 1: independent investigation ──────────────────────────────────
	emitProgress("investigation", "阶段一：独立调查");
	const records: TeamProposalRecord[] = participants.map((participant, index) => ({
		label: proposalLabel(index),
		participant,
		reviews: [],
		roundsUsed: 0,
		unresolvedBlocking: [],
		proposerFailed: false,
		reviewFailed: false,
		recheckFailed: false,
		revisionFailed: false,
		excludedFromOptions: false,
		blockedAfterRoundCap: false,
	}));
	await Promise.all(
		records.map(async record => {
			trackParticipant(record.label, "proposer", "running");
			emitProgress("investigation", `阶段一：独立调查（${record.label} 运行中）`);
			const call: TeamSubagentCall = {
				role: "proposer",
				modelPattern: record.participant.modelPattern,
				label: `team-proposal-${record.label}`,
				task: buildProposalTask({ question, cwd }),
				schema: TEAM_PROPOSAL_SCHEMA,
			};
			const outcome = await runCall(call);
			if (signal.aborted) return;
			const proposal = outcome.ok ? parseTeamProposal(outcome.data) : undefined;
			if (!proposal) {
				record.proposerFailed = true;
				record.excludedFromOptions = true;
				record.exclusionReason = outcome.ok ? "提案输出不符合结构化要求" : `提案子代理失败：${outcome.error}`;
				trackParticipant(record.label, "proposer", "failed");
				return;
			}
			record.originalProposal = proposal;
			record.latestProposal = proposal;
			if (proposal.noViableProposal) {
				// The proposer itself reported no viable plan (§2.5): the record
				// stays visible to alignment/synthesis as information, but is
				// never a final-option candidate and needs no review rounds.
				record.excludedFromOptions = true;
				record.exclusionReason = "提案者报告未形成可行方案（依据不足）";
			}
			trackParticipant(record.label, "proposer", "completed");
			emitProgress("investigation", `阶段一：独立调查（${record.label} 完成）`);
		}),
	);
	if (signal.aborted) return { status: "cancelled" };

	const viable = records.filter(record => !record.proposerFailed);
	if (viable.length === 0) {
		return {
			status: "failed",
			failureReason: "所有提案子代理均失败，独立调查阶段无法完成（不输出半成品结论）",
		};
	}

	// ── Stage 2: alignment (session model) ──────────────────────────────────
	emitProgress("alignment", "阶段二：对齐与比较");
	trackParticipant("alignment", "aligner", "running");
	const alignmentOutcome = await runCall({
		role: "aligner",
		modelPattern: options.sessionModelPattern,
		label: "team-alignment",
		task: buildAlignmentTask({ question, cwd, proposals: viable }),
		schema: TEAM_ALIGNMENT_SCHEMA,
	});
	if (signal.aborted) return { status: "cancelled" };
	const alignment = alignmentOutcome.ok ? parseTeamAlignment(alignmentOutcome.data) : undefined;
	if (!alignment) {
		return {
			status: "failed",
			failureReason: `对齐子调用失败（${alignmentOutcome.error ?? "输出不符合结构化要求"}），流程未完成，不输出半成品结论`,
		};
	}
	trackParticipant("alignment", "aligner", "completed");

	// ── Stage 3 + 4: cross review, then revision/recheck rounds ─────────────
	// Only proposals intended as final options get reviewed (§2.5); no-viable
	// and failed proposals remain in the alignment/synthesis inputs instead.
	const candidates = viable.filter(record => !record.excludedFromOptions);
	const reviewed: TeamProposalRecord[] = [];
	if (candidates.length > 0) {
		emitProgress("review", "阶段三：交叉审查");
		await Promise.all(
			candidates.map(async record => {
				const reviewer = assignReviewerParticipant(participants, record.participant.index);
				record.reviewer = reviewer;
				trackParticipant(`review-${record.label}`, "reviewer", "running");
				const reviewOutcome = await runCall({
					role: "reviewer",
					modelPattern: reviewer.modelPattern,
					label: `team-review-${record.label}`,
					task: buildReviewTask({
						question,
						cwd,
						alignment,
						targetLabel: record.label,
						proposalText: record.latestProposal!.proposal,
						keyAssumptions: record.latestProposal!.keyAssumptions,
						round: 1,
						recheck: false,
					}),
					schema: TEAM_REVIEW_SCHEMA,
				});
				if (signal.aborted) return;
				const review = reviewOutcome.ok ? parseTeamReview(reviewOutcome.data) : undefined;
				if (!review) {
					record.reviewFailed = true;
					record.excludedFromOptions = true;
					record.exclusionReason = reviewOutcome.ok
						? "审查输出不符合结构化要求，未经审查不可作为最终选项"
						: `审查子代理失败：${reviewOutcome.error}`;
					trackParticipant(`review-${record.label}`, "reviewer", "failed");
					return;
				}
				record.reviews.push(review);
				record.unresolvedBlocking = computeUnresolvedBlocking(record.reviews);
				reviewed.push(record);
				trackParticipant(`review-${record.label}`, "reviewer", "completed");
			}),
		);
		if (signal.aborted) return { status: "cancelled" };

		if (reviewed.length === 0) {
			return {
				status: "failed",
				failureReason: "全部审查子代理失败，无法完成必要审查（不静默改成单模型并宣称团队流程完成）",
			};
		}
	}

	emitProgress("revision", "阶段四：修订与复核");
	for (const record of reviewed) {
		if (signal.aborted) return { status: "cancelled" };
		const hasFindings = record.reviews[0]!.findings.length > 0;
		if (!hasFindings) continue; // nothing to revise; no padding rounds
		for (let round = 1; round <= TEAM_MAX_REVISION_ROUNDS; round++) {
			if (signal.aborted) return { status: "cancelled" };
			record.roundsUsed = round;
			trackParticipant(`revision-${record.label}`, "reviser", "running");
			emitProgress("revision", `阶段四：修订与复核（${record.label} 第 ${round} 轮）`);
			const revisionOutcome = await runCall({
				role: "reviser",
				modelPattern: record.participant.modelPattern,
				label: `team-revision-${record.label}-${round}`,
				task: buildRevisionTask({
					question,
					cwd,
					targetLabel: record.label,
					round,
					proposalText: record.latestProposal!.proposal,
					review: record.reviews.at(-1)!,
					unresolvedBlocking: record.unresolvedBlocking,
				}),
				schema: TEAM_REVISION_SCHEMA,
			});
			if (signal.aborted) return { status: "cancelled" };
			const revision = revisionOutcome.ok ? parseTeamRevision(revisionOutcome.data) : undefined;
			if (!revision) {
				record.revisionFailed = true;
				trackParticipant(`revision-${record.label}`, "reviser", "failed");
				break; // conservative: unresolved state stands as-is
			}
			record.revision = revision;
			if (revision.revisedProposal.trim())
				record.latestProposal = { ...record.latestProposal!, proposal: revision.revisedProposal };
			trackParticipant(`revision-${record.label}`, "reviser", "completed");

			if (needsRecheck(revision.reviewFlags)) {
				trackParticipant(`recheck-${record.label}`, "reviewer", "running");
				const recheckOutcome = await runCall({
					role: "reviewer",
					modelPattern: record.reviewer!.modelPattern,
					label: `team-recheck-${record.label}-${round}`,
					task: buildReviewTask({
						question,
						cwd,
						alignment,
						targetLabel: record.label,
						proposalText: record.latestProposal!.proposal,
						keyAssumptions: record.latestProposal!.keyAssumptions,
						round,
						recheck: true,
						unresolvedBlocking: record.unresolvedBlocking,
					}),
					schema: TEAM_REVIEW_SCHEMA,
				});
				if (signal.aborted) return { status: "cancelled" };
				const recheck = recheckOutcome.ok ? parseTeamReview(recheckOutcome.data) : undefined;
				if (!recheck) {
					// Recheck failure cannot confirm resolution; the blocking state
					// stands and is reported as incomplete participation.
					record.recheckFailed = true;
					trackParticipant(`recheck-${record.label}`, "reviewer", "failed");
				} else {
					record.reviews.push(recheck);
					trackParticipant(`recheck-${record.label}`, "reviewer", "completed");
				}
			}
			record.unresolvedBlocking = computeUnresolvedBlocking(record.reviews);
			if (record.unresolvedBlocking.length === 0) break;
			if (round === TEAM_MAX_REVISION_ROUNDS) {
				record.blockedAfterRoundCap = true; // third round is refused by the loop bound
			}
		}
	}
	if (signal.aborted) return { status: "cancelled" };

	// ── Stage 5: synthesis (session model) ──────────────────────────────────
	emitProgress("synthesis", "阶段五：汇总方案");
	trackParticipant("synthesis", "synthesizer", "running");
	const synthesisOutcome = await runCall({
		role: "synthesizer",
		modelPattern: options.sessionModelPattern,
		label: "team-synthesis",
		// Synthesis sees every non-failed record — candidates with their review
		// processing, and no-viable/failed ones with their exclusion reasons —
		// so it can explain why an option is not offered instead of guessing.
		task: buildSynthesisTask({ question, cwd, alignment, proposals: viable }),
		schema: TEAM_SYNTHESIS_SCHEMA,
	});
	if (signal.aborted) return { status: "cancelled" };
	const synthesis = synthesisOutcome.ok ? parseTeamSynthesis(synthesisOutcome.data) : undefined;
	if (!synthesis) {
		return {
			status: "failed",
			failureReason: `综合子调用失败（${synthesisOutcome.error ?? "输出不符合结构化要求"}），流程未完成，不输出半成品结论`,
		};
	}
	trackParticipant("synthesis", "synthesizer", "completed");
	emitProgress("done", "讨论完成");

	const participationNotes: string[] = [];
	for (const record of records) {
		const issues = [
			record.proposerFailed ? `方案 ${record.label} 提案子代理失败（${record.participant.modelPattern}）` : "",
			record.reviewFailed ? `方案 ${record.label} 审查子代理失败，未经审查不可作为最终选项` : "",
			record.recheckFailed ? `方案 ${record.label} 复核子代理失败，阻断问题是否解决未能确认` : "",
			record.revisionFailed ? `方案 ${record.label} 修订子代理失败，保留修订前状态` : "",
		].filter(Boolean);
		participationNotes.push(...issues);
	}
	if (alignment.factDifferences.some(difference => !difference.sourceToCheck.trim())) {
		participationNotes.push("存在未标注回查来源的事实差异，相应约束未核实。");
	}

	const report = assembleTeamReport({ question, alignment, synthesis, proposals: records, participationNotes });
	return { status: "completed", reportMarkdown: report.markdown, droppedRecommendation: report.droppedRecommendation };
}
