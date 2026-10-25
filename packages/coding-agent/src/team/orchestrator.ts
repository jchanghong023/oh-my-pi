/**
 * `/team` code-driven five-stage orchestrator.
 *
 * Every guarantee from openspec/specs/team-discussion/spec.md is mechanical here:
 * - independent investigation: identical inputs fanned out in parallel under
 *   the `task.maxConcurrency` semaphore, no shared digest;
 * - reviewer rotation to the next different participant model; the session
 *   model can review through a fresh child subprocess, but the session agent
 *   itself never reviews;
 * - revision rounds counted in code, third round refused;
 * - recheck reviews triggered by structured flags only;
 * - unresolved blocking findings tracked in code and rendered as
 *   "尚不可采用" regardless of what the synthesis text claims;
 * - alignment/synthesis failures abort the run (no half-finished conclusions);
 * - proposer/reviewer/reviser failures mark that participant failed and the
 *   rest continue, with participation noted.
 */
import * as nodeCrypto from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
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
	TeamCandidate,
	TeamInterpretationDifference,
	TeamFinding,
	TeamParticipant,
	TeamProgressUpdate,
	TeamProposalRecord,
	TeamRevisionFlags,
	TeamReviewOutput,
	TeamReviewRecord,
	TeamRunResult,
	TeamSubagentCall,
	TeamSubagentOutcome,
	TeamSubagentRunner,
	TeamTrackedFinding,
} from "./types";

/** Hard cap: at most two revision(+recheck) rounds per proposal; the third is refused. */
export const TEAM_MAX_REVISION_ROUNDS = 2;

export interface TeamOrchestratorOptions {
	question: string;
	/** Workflow callers bind the discussion to this exact confirmed spec version. */
	inputVersion?: string;
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
 * Rotation rule (§2.5 + §2.2): use the next participant in proposer order
 * with a *different* model. The runner creates a fresh reviewer subprocess,
 * so a child using the session model is distinct from the session agent itself;
 * when no different model participates, the proposer's own fresh subagent
 * reviews.
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
 * Mechanically fold accepted reviews by stable finding ID. Only a complete,
 * well-founded set of reviewer decisions can close earlier blockers; author
 * responses and repeated issue text never affect their identity or status.
 */
export function computeUnresolvedBlocking(reviews: readonly TeamReviewRecord[]): TeamTrackedFinding[] {
	const unresolved = new Map<string, TeamTrackedFinding>();
	for (const review of reviews) {
		const decided = new Set<string>();
		const validDecisions =
			review.blockingResolutions.length === unresolved.size &&
			review.blockingResolutions.every(resolution => {
				if (
					!unresolved.has(resolution.findingId) ||
					decided.has(resolution.findingId) ||
					!resolution.basis.trim() ||
					(resolution.status !== "resolved" && resolution.status !== "unresolved")
				)
					return false;
				decided.add(resolution.findingId);
				return true;
			});
		if (validDecisions) {
			for (const resolution of review.blockingResolutions) {
				if (resolution.status === "resolved") unresolved.delete(resolution.findingId);
			}
		}
		for (const finding of review.findings) {
			if (finding.severity === "blocking") unresolved.set(finding.id, finding);
		}
	}
	return [...unresolved.values()];
}

function proposalLabel(index: number): string {
	let label = "";
	do {
		label = String.fromCharCode(65 + (index % 26)) + label;
		index = Math.floor(index / 26) - 1;
	} while (index >= 0);
	return label;
}

function trackFinding(record: TeamProposalRecord, finding: TeamFinding): TeamTrackedFinding {
	return { ...finding, id: `${record.label}-F${record.nextFindingNumber++}` };
}

/** Called only after the complete raw review has passed parsing. */
function trackReview(record: TeamProposalRecord, review: TeamReviewOutput): TeamReviewRecord {
	return { ...review, findings: review.findings.map(finding => trackFinding(record, finding)) };
}

interface TeamCallDiagnosticsOutcome {
	ok: boolean;
	error?: string;
	data?: unknown;
	diagnostics: Record<string, unknown>;
}

type TeamDiscussionOutcome = Omit<TeamRunResult, "runId" | "inputVersion" | "candidates" | "interpretationDifferences">;

interface TeamDiscussionState {
	records: TeamProposalRecord[];
	interpretationDifferences: TeamInterpretationDifference[];
	recommendedProposal: string;
	recommendationPreconditions: string;
}

function contentVersion(content: string): string {
	return nodeCrypto.createHash("sha256").update(content).digest("hex");
}

function buildCandidates(state: TeamDiscussionState, runId: string, completed: boolean): TeamCandidate[] {
	return state.records.map(record => {
		const proposal = record.latestProposal;
		const reviewSucceeded = record.reviews.length > 0 && !record.reviewFailed;
		const recheckSucceeded = !record.pendingRecheck && !record.recheckFailed;
		const adoptable =
			completed &&
			reviewSucceeded &&
			recheckSucceeded &&
			!record.excludedFromOptions &&
			!record.blockedAfterRoundCap &&
			record.unresolvedBlocking.length === 0;
		const text = proposal?.proposal ?? "";
		return {
			id: `${runId}:${record.label}`,
			label: record.label,
			version: contentVersion(text),
			proposal: text,
			adoptable,
			reviewSucceeded,
			recheckSucceeded,
			unresolvedBlocking: record.unresolvedBlocking,
			exclusionReason: record.exclusionReason ?? (!completed ? "讨论未成功完成" : undefined),
			conditions: [
				...(proposal?.keyAssumptions
					.filter(assumption => assumption.status === "unverified")
					.map(
						assumption =>
							`${assumption.content}；待验证依据：${assumption.basis}；若不成立：${assumption.impactIfWrong}`,
					) ?? []),
				...(proposal?.unknowns ?? []),
				...(state.recommendedProposal === record.label && state.recommendationPreconditions.trim()
					? [state.recommendationPreconditions]
					: []),
			],
			assumptions: proposal?.keyAssumptions ?? [],
			evidence: proposal?.evidence ?? [],
		};
	});
}

export async function runTeamDiscussion(options: TeamOrchestratorOptions): Promise<TeamRunResult> {
	const logContext = logger.getLogContext();
	const teamRunId =
		typeof logContext.team_run_id === "string" ? logContext.team_run_id : `team-${crypto.randomUUID()}`;
	const inputVersion = options.inputVersion ?? contentVersion(options.question);
	const state: TeamDiscussionState = {
		records: [],
		interpretationDifferences: [],
		recommendedProposal: "",
		recommendationPreconditions: "",
	};
	const completeResult = (result: TeamDiscussionOutcome): TeamRunResult => ({
		...result,
		runId: teamRunId,
		inputVersion,
		candidates: buildCandidates(state, teamRunId, result.status === "completed"),
		interpretationDifferences: state.interpretationDifferences,
	});
	return logger.withLogContext(
		{ team_run_id: teamRunId, operation_id: logContext.operation_id ?? teamRunId },
		async () => {
			const started = performance.now();
			const diagnostics = { stage: "dispatch", reason: "stage_incomplete" };
			const subagentResults: NonNullable<TeamRunResult["subagentResults"]> = [];
			logger.info("Team discussion started", {
				component: "team.orchestrator",
				event: "team_run_started",
				stage: "dispatch",
				result: "started",
				participant_count: options.participants.length,
				max_concurrency: options.maxConcurrency,
				revision_round_cap: TEAM_MAX_REVISION_ROUNDS,
			});
			try {
				const result = await runTeamDiscussionImpl(options, diagnostics, subagentResults, state);
				result.subagentResults = subagentResults;
				const fields = {
					component: "team.orchestrator",
					event: `team_run_${result.status}`,
					stage: diagnostics.stage,
					result: result.status,
					elapsed_ms: performance.now() - started,
					...(result.status === "failed" ? { failure_category: diagnostics.reason } : {}),
					dropped_recommendation: result.droppedRecommendation ?? false,
				};
				if (result.status === "failed") logger.error("Team discussion failed", fields);
				else logger.info("Team discussion finished", fields);
				return completeResult(result);
			} catch (error) {
				const fields = {
					component: "team.orchestrator",
					event: options.signal.aborted ? "team_run_cancelled" : "team_run_failed",
					stage: diagnostics.stage,
					result: options.signal.aborted ? "cancelled" : "failed",
					elapsed_ms: performance.now() - started,
					...logger.diagnosticError(error),
				};
				if (options.signal.aborted) logger.info("Team discussion interrupted", fields);
				else logger.error("Team discussion threw", fields);
				return completeResult({
					status: options.signal.aborted ? "cancelled" : "failed",
					failureReason: error instanceof Error ? error.message : String(error),
					subagentResults,
				});
			}
		},
	);
}

async function runTeamDiscussionImpl(
	options: TeamOrchestratorOptions,
	diagnostics: { stage: string; reason: string },
	subagentResults: NonNullable<TeamRunResult["subagentResults"]>,
	state: TeamDiscussionState,
): Promise<TeamDiscussionOutcome> {
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
		if (diagnostics.stage !== stage) {
			logger.info("Team stage started", {
				component: "team.orchestrator",
				event: "team_stage_started",
				stage,
				result: "started",
			});
		}
		diagnostics.stage = stage;
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
		context: { stage: string; member_index?: number; proposal_label?: string; round?: number; recheck?: boolean },
	): Promise<TeamCallDiagnosticsOutcome> => {
		const fields = {
			...context,
			call_id: `team-call-${crypto.randomUUID()}`,
			role: call.role,
			label: call.label,
			requested_model: call.modelPattern.slice(0, 192),
		};
		const retainOutcome = (outcome: TeamSubagentOutcome): TeamCallDiagnosticsOutcome => {
			subagentResults.push({ role: call.role, modelPattern: call.modelPattern, label: call.label, outcome });
			return { ...outcome, diagnostics: fields };
		};
		return logger.withLogContext(fields, async () => {
			const started = performance.now();
			logger.info("Team call started", {
				component: "team.orchestrator",
				event: "team_call_started",
				stage: "concurrency_wait",
				result: "started",
				team_stage: context.stage,
			});
			try {
				await semaphore.acquire(signal);
			} catch (error) {
				logger.info("Team call cancelled while waiting", {
					component: "team.orchestrator",
					event: "team_call_cancelled",
					stage: "concurrency_wait",
					result: "cancelled",
					elapsed_ms: performance.now() - started,
					...logger.diagnosticError(error),
				});
				return retainOutcome({ ok: false, error: "cancelled while waiting for a concurrency slot" });
			}
			try {
				logger.info("Team runner started", {
					component: "team.orchestrator",
					event: "team_runner_started",
					stage: "runner",
					result: "started",
				});
				const outcome = await runner(call, signal);
				// Retain the original yield before stage parsers trim or budget it.
				const retained = retainOutcome(outcome);
				const result = signal.aborted ? "cancelled" : outcome.ok ? "completed" : "failed";
				const terminal = {
					component: "team.orchestrator",
					event: `team_call_${result}`,
					stage: "runner",
					result,
					elapsed_ms: performance.now() - started,
					...(result === "failed" ? { failure_category: "runner_rejected" } : {}),
				};
				if (result === "failed") logger.warn("Team call failed", terminal);
				else logger.info("Team call finished", terminal);
				return retained;
			} catch (error) {
				const terminal = {
					component: "team.orchestrator",
					event: signal.aborted ? "team_call_cancelled" : "team_call_failed",
					stage: "runner",
					result: signal.aborted ? "cancelled" : "failed",
					elapsed_ms: performance.now() - started,
					...logger.diagnosticError(error),
				};
				if (signal.aborted) logger.info("Team call interrupted", terminal);
				else logger.warn("Team runner threw", terminal);
				// A throwing runner remains a failed participant, not a rejected run.
				return retainOutcome({
					ok: false,
					error: signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error),
				});
			} finally {
				semaphore.release();
			}
		});
	};
	const logSchema = (outcome: TeamCallDiagnosticsOutcome, valid: boolean, elapsedMs: number): void => {
		if (!outcome.ok) return;
		const fields = {
			...outcome.diagnostics,
			component: "team.orchestrator",
			event: valid ? "team_schema_completed" : "team_schema_rejected",
			stage: "schema_parse",
			result: valid ? "completed" : "failed",
			team_stage: outcome.diagnostics.stage,
			output_contract: outcome.diagnostics.role,
			elapsed_ms: elapsedMs,
			...(valid ? {} : { rejection_category: "team_output_contract" }),
		};
		if (valid) logger.info("Team output parsed", fields);
		else logger.warn("Team output rejected", fields);
	};

	if (signal.aborted) return { status: "cancelled" };

	// ── Stage 1: independent investigation ──────────────────────────────────
	emitProgress("investigation", "阶段一：独立调查");
	const records: TeamProposalRecord[] = participants.map((participant, index) => ({
		label: proposalLabel(index),
		participant,
		reviews: [],
		revisionHistory: [],
		roundsUsed: 0,
		nextFindingNumber: 1,
		unresolvedBlocking: [],
		proposerFailed: false,
		reviewFailed: false,
		recheckFailed: false,
		pendingRecheck: false,
		revisionFailed: false,
		excludedFromOptions: false,
		blockedAfterRoundCap: false,
	}));
	state.records = records;
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
			const outcome = await runCall(call, {
				stage: "investigation",
				member_index: record.participant.index,
				proposal_label: record.label,
				round: 0,
				recheck: false,
			});
			if (signal.aborted) return;
			const parseStarted = performance.now();
			const proposal = outcome.ok
				? parseTeamProposal(outcome.data, reason => {
						record.exclusionReason = reason;
					})
				: undefined;
			logSchema(outcome, Boolean(proposal), performance.now() - parseStarted);
			if (!proposal) {
				record.proposerFailed = true;
				record.excludedFromOptions = true;
				record.exclusionReason = outcome.ok
					? (record.exclusionReason ?? "提案输出不符合结构化要求")
					: `提案子代理失败：${outcome.error}`;
				trackParticipant(record.label, "proposer", "failed");
				emitProgress("investigation", `阶段一：独立调查（${record.label} 失败）`);
				return;
			}
			record.originalProposal = proposal;
			record.latestProposal = proposal;
			if (proposal.investigationBlockedReason) {
				record.excludedFromOptions = true;
				record.exclusionReason = proposal.investigationBlockedReason;
				trackParticipant(record.label, "proposer", "failed");
				emitProgress("investigation", `阶段一：独立调查（${record.label} 必要调查受阻）`);
				return;
			}
			if (proposal.noViableProposal) {
				// The proposer itself reported no viable plan (§2.5): the record
				// stays visible to alignment/synthesis as information, but is
				// never a final-option candidate and needs no review rounds.
				record.excludedFromOptions = true;
				record.exclusionReason = "必要调查已完成，提案者报告未形成可行方案";
			}
			trackParticipant(record.label, "proposer", "completed");
			emitProgress("investigation", `阶段一：独立调查（${record.label} 完成）`);
		}),
	);
	if (signal.aborted) return { status: "cancelled" };
	const blocked = records.filter(record => record.latestProposal?.investigationBlockedReason);
	if (blocked.length > 0) {
		diagnostics.reason = "investigation_blocked";
		return {
			status: "failed",
			failureReason: `必要调查未完成：${blocked
				.map(record => `${record.label}：${record.latestProposal!.investigationBlockedReason}`)
				.join("；")}。请补齐资料或访问条件后重跑 /team；不输出半成品结论`,
		};
	}

	const viable = records.filter(record => !record.proposerFailed);
	if (viable.length === 0) {
		diagnostics.reason = "all_proposers_failed";
		return {
			status: "failed",
			failureReason: `所有提案子代理均失败，独立调查阶段无法完成（不输出半成品结论）：${records
				.map(record => `${record.label}：${record.exclusionReason ?? "提案输出不符合结构化要求"}`)
				.join("；")}`,
		};
	}

	// ── Stage 2: alignment (session model) ──────────────────────────────────
	trackParticipant("alignment", "aligner", "running");
	emitProgress("alignment", "阶段二：对齐与比较");
	const alignmentOutcome = await runCall(
		{
			role: "aligner",
			modelPattern: options.sessionModelPattern,
			label: "team-alignment",
			task: buildAlignmentTask({ question, cwd, proposals: viable }),
			schema: TEAM_ALIGNMENT_SCHEMA,
		},
		{ stage: "alignment", round: 0, recheck: false },
	);
	if (signal.aborted) return { status: "cancelled" };
	const alignmentParseStarted = performance.now();
	const alignment = alignmentOutcome.ok ? parseTeamAlignment(alignmentOutcome.data) : undefined;
	logSchema(alignmentOutcome, Boolean(alignment), performance.now() - alignmentParseStarted);
	if (!alignment) {
		diagnostics.reason = "alignment_rejected";
		trackParticipant("alignment", "aligner", "failed");
		emitProgress("alignment", "阶段二：对齐与比较（对齐子调用失败）");
		return {
			status: "failed",
			failureReason: `对齐子调用失败（${alignmentOutcome.error ?? "输出不符合结构化要求"}），流程未完成，不输出半成品结论`,
		};
	}
	trackParticipant("alignment", "aligner", "completed");
	state.interpretationDifferences = alignment.interpretationDifferences;

	// Initial review and recheck read the same question/proposal context; the
	// fields a review sees must not drift between the two rounds.
	const reviewTaskBase = (record: TeamProposalRecord) => ({
		question,
		cwd,
		alignment,
		targetLabel: record.label,
		proposalText: record.latestProposal!.proposal,
		keyAssumptions: record.latestProposal!.keyAssumptions,
		risks: record.latestProposal!.risks,
		unknowns: record.latestProposal!.unknowns,
		evidence: record.latestProposal!.evidence,
		ambiguityInterpretations: record.latestProposal!.ambiguityInterpretations,
	});

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
				const reviewOutcome = await runCall(
					{
						role: "reviewer",
						modelPattern: reviewer.modelPattern,
						label: `team-review-${record.label}`,
						task: buildReviewTask({ ...reviewTaskBase(record), round: 1, recheck: false }),
						schema: TEAM_REVIEW_SCHEMA,
					},
					{
						stage: "review",
						member_index: reviewer.index,
						proposal_label: record.label,
						round: 1,
						recheck: false,
					},
				);
				if (signal.aborted) return;
				const parseStarted = performance.now();
				const review = reviewOutcome.ok ? parseTeamReview(reviewOutcome.data) : undefined;
				logSchema(reviewOutcome, Boolean(review), performance.now() - parseStarted);
				if (!review) {
					record.reviewFailed = true;
					record.excludedFromOptions = true;
					record.exclusionReason = reviewOutcome.ok
						? "审查输出不符合结构化要求，未经审查不可作为最终选项"
						: `审查子代理失败：${reviewOutcome.error}`;
					trackParticipant(`review-${record.label}`, "reviewer", "failed");
					emitProgress("review", `阶段三：交叉审查（${record.label} 失败）`);
					return;
				}
				record.reviews.push(trackReview(record, review));
				record.unresolvedBlocking = computeUnresolvedBlocking(record.reviews);
				logger.info("Team review blocking state", {
					component: "team.orchestrator",
					event: "team_blocking_updated",
					stage: "review",
					result: "completed",
					proposal_label: record.label,
					member_index: reviewer.index,
					round: 1,
					recheck: false,
					finding_count: review.findings.length,
					unresolved_blocking_count: record.unresolvedBlocking.length,
				});
				reviewed.push(record);
				trackParticipant(`review-${record.label}`, "reviewer", "completed");
				emitProgress("review", `阶段三：交叉审查（${record.label} 完成）`);
			}),
		);
		if (signal.aborted) return { status: "cancelled" };

		if (reviewed.length === 0) {
			diagnostics.reason = "all_reviewers_failed";
			return {
				status: "failed",
				failureReason: "全部审查子代理失败，无法完成必要审查（不静默改成单模型并宣称团队流程完成）",
			};
		}
	}

	emitProgress("revision", "阶段四：修订与复核");
	// No cross-record coupling: each per-proposal loop reads and writes only
	// its own record, so the loops fan out concurrently exactly like stages 1
	// and 3, under the same semaphore (§5.4 bounds concurrency; §2.5 orders no
	// per-proposal revision sequence against another). Progress lines may
	// interleave; each is still emitted whole.
	await Promise.all(
		reviewed.map(async record => {
			if (signal.aborted) return;
			const hasFindings = record.reviews[0]!.findings.length > 0;
			if (!hasFindings) return; // nothing to revise; no padding rounds
			// Failed rechecks leave this audited baseline and all later deltas
			// pending, so a subsequent reviewer cannot overlook an earlier change.
			let previousProposal = record.latestProposal!;
			let pendingRevisions: TeamProposalRecord["revisionHistory"] = [];
			for (let round = 1; round <= TEAM_MAX_REVISION_ROUNDS; round++) {
				if (signal.aborted) return;
				record.roundsUsed = round;
				trackParticipant(`revision-${record.label}`, "reviser", "running");
				emitProgress("revision", `阶段四：修订与复核（${record.label} 第 ${round} 轮）`);
				const expectedFindingIds = [
					...new Set([
						...record.reviews.at(-1)!.findings.map(finding => finding.id),
						...record.unresolvedBlocking.map(finding => finding.id),
					]),
				];
				const revisionOutcome = await runCall(
					{
						role: "reviser",
						modelPattern: record.participant.modelPattern,
						label: `team-revision-${record.label}-${round}`,
						task: buildRevisionTask({
							question,
							cwd,
							targetLabel: record.label,
							round,
							alignment,
							proposal: record.latestProposal!,
							review: record.reviews.at(-1)!,
							unresolvedBlocking: record.unresolvedBlocking,
						}),
						schema: TEAM_REVISION_SCHEMA,
					},
					{
						stage: "revision",
						member_index: record.participant.index,
						proposal_label: record.label,
						round,
						recheck: false,
					},
				);
				if (signal.aborted) return;
				const parseStarted = performance.now();
				const revision = revisionOutcome.ok
					? parseTeamRevision(revisionOutcome.data, expectedFindingIds)
					: undefined;
				logSchema(revisionOutcome, Boolean(revision), performance.now() - parseStarted);
				if (!revision) {
					record.revisionFailed = true;
					trackParticipant(`revision-${record.label}`, "reviser", "failed");
					emitProgress("revision", `阶段四：修订与复核（${record.label} 修订失败）`);
					break; // conservative: unresolved state stands as-is
				}
				const revisionRecord: TeamProposalRecord["revisionHistory"][number] = {
					round,
					revision,
					recheckFailed: false,
				};
				record.revisionHistory.push(revisionRecord);
				pendingRevisions.push(revisionRecord);
				if (revision.revisedProposal.trim())
					record.latestProposal = { ...record.latestProposal!, proposal: revision.revisedProposal };
				trackParticipant(`revision-${record.label}`, "reviser", "completed");
				emitProgress("revision", `阶段四：修订与复核（${record.label} 修订完成）`);

				logger.info("Team recheck decision", {
					component: "team.orchestrator",
					event: "team_recheck_decided",
					stage: "revision",
					result: "completed",
					proposal_label: record.label,
					round,
					recheck_required: needsRecheck(revision.reviewFlags),
					changed_core_design: revision.reviewFlags.changedCoreDesign,
					claims_resolved_blocking: revision.reviewFlags.claimsResolvedBlocking,
					new_evidence_changes_assumptions: revision.reviewFlags.newEvidenceChangesAssumptions,
					disputes_blocking_finding: revision.reviewFlags.disputesBlockingFinding,
				});
				if (needsRecheck(revision.reviewFlags)) {
					trackParticipant(`recheck-${record.label}`, "reviewer", "running");
					const recheckOutcome = await runCall(
						{
							role: "reviewer",
							modelPattern: record.reviewer!.modelPattern,
							label: `team-recheck-${record.label}-${round}`,
							task: buildReviewTask({
								...reviewTaskBase(record),
								round,
								recheck: true,
								unresolvedBlocking: record.unresolvedBlocking,
								recheckContext: { previousProposal, revisions: pendingRevisions, reviews: record.reviews },
							}),
							schema: TEAM_REVIEW_SCHEMA,
						},
						{
							stage: "revision",
							member_index: record.reviewer!.index,
							proposal_label: record.label,
							round,
							recheck: true,
						},
					);
					if (signal.aborted) return;
					const parseStarted = performance.now();
					const recheck = recheckOutcome.ok
						? parseTeamReview(
								recheckOutcome.data,
								record.unresolvedBlocking.map(finding => finding.id),
							)
						: undefined;
					logSchema(recheckOutcome, Boolean(recheck), performance.now() - parseStarted);
					if (!recheck) {
						// Recheck failure cannot confirm resolution; the blocking state
						// stands and is reported as incomplete participation. The revised
						// version itself also stays unverified (pendingRecheck): it must
						// not ride on the pre-revision review's adoptable status.
						revisionRecord.recheckFailed = true;
						record.recheckFailed = true;
						record.pendingRecheck = true;
						trackParticipant(`recheck-${record.label}`, "reviewer", "failed");
						emitProgress("revision", `阶段四：修订与复核（${record.label} 复核失败）`);
					} else {
						const trackedRecheck = trackReview(record, recheck);
						revisionRecord.recheck = trackedRecheck;
						previousProposal = record.latestProposal!;
						pendingRevisions = [];
						record.reviews.push(trackedRecheck);
						record.pendingRecheck = false;
						// Recovery clears the current eligibility failure, not the paired
						// historical failure retained in revisionHistory.
						record.recheckFailed = false;
						trackParticipant(`recheck-${record.label}`, "reviewer", "completed");
						emitProgress("revision", `阶段四：修订与复核（${record.label} 复核完成）`);
					}
				}
				record.unresolvedBlocking = computeUnresolvedBlocking(record.reviews);
				logger.info("Team revision blocking state", {
					component: "team.orchestrator",
					event: "team_blocking_updated",
					stage: "revision",
					result: "completed",
					proposal_label: record.label,
					round,
					unresolved_blocking_count: record.unresolvedBlocking.length,
					pending_recheck: record.pendingRecheck,
				});
				// A successful recheck may close the last blocker while introducing
				// nonblocking findings. Route those new IDs to the author too, without
				// changing their severity or extending the two-round limit.
				const hasUnansweredFindings = record.reviews
					.at(-1)!
					.findings.some(finding => !revision.responses.some(response => response.findingId === finding.id));
				if (record.unresolvedBlocking.length === 0 && !record.pendingRecheck && !hasUnansweredFindings) break;
				// Without a recheck the blocking state cannot change mechanically
				// (§2.5: 全部为假时不复核，不强凑修订轮次); rerunning the identical
				// revision prompt would only pad rounds. An incomplete recheck is the
				// one exception: the round cap still binds, and a next round's recheck
				// can yet verify the revised version.
				if (!needsRecheck(revision.reviewFlags)) break;
			}
			// Once both allowed rounds are used, unresolved blockers stay gated even
			// when round two did not request another recheck or its reviser failed.
			if (record.roundsUsed === TEAM_MAX_REVISION_ROUNDS && record.unresolvedBlocking.length > 0) {
				record.blockedAfterRoundCap = true;
			}
			// A revision whose required recheck never completed has not been reviewed
			// in its current form; "no recorded blocking findings" from the initial
			// review is not a review of this version, so it cannot stay adoptable.
			if (record.pendingRecheck && !record.excludedFromOptions) {
				record.excludedFromOptions = true;
				record.exclusionReason = "修订后必需复核未完成（子代理失败或输出无效），当前版本未经复核确认";
			}
		}),
	);
	if (signal.aborted) return { status: "cancelled" };
	for (const record of records) {
		logger.info("Team proposal eligibility", {
			component: "team.orchestrator",
			event: "team_eligibility_evaluated",
			stage: "revision",
			result: "completed",
			proposal_label: record.label,
			member_index: record.participant.index,
			rounds_used: record.roundsUsed,
			round_cap_reached: record.roundsUsed === TEAM_MAX_REVISION_ROUNDS,
			blocked_after_round_cap: record.blockedAfterRoundCap,
			unresolved_blocking_count: record.unresolvedBlocking.length,
			pending_recheck: record.pendingRecheck,
			excluded_from_options: record.excludedFromOptions,
			eligible: !record.excludedFromOptions && !record.pendingRecheck && record.unresolvedBlocking.length === 0,
			proposer_failed: record.proposerFailed,
			review_failed: record.reviewFailed,
			revision_failed: record.revisionFailed,
			recheck_failed: record.recheckFailed,
		});
	}

	// ── Stage 5: synthesis (session model) ──────────────────────────────────
	trackParticipant("synthesis", "synthesizer", "running");
	emitProgress("synthesis", "阶段五：汇总方案");
	const synthesisOutcome = await runCall(
		{
			role: "synthesizer",
			modelPattern: options.sessionModelPattern,
			label: "team-synthesis",
			// Synthesis sees every non-failed record — candidates with their review
			// processing, and no-viable/failed ones with their exclusion reasons —
			// so it can explain why an option is not offered instead of guessing.
			task: buildSynthesisTask({ question, cwd, alignment, proposals: viable }),
			schema: TEAM_SYNTHESIS_SCHEMA,
		},
		{ stage: "synthesis", round: 0, recheck: false },
	);
	if (signal.aborted) return { status: "cancelled" };
	const synthesisParseStarted = performance.now();
	const synthesis = synthesisOutcome.ok ? parseTeamSynthesis(synthesisOutcome.data) : undefined;
	logSchema(synthesisOutcome, Boolean(synthesis), performance.now() - synthesisParseStarted);
	if (!synthesis) {
		diagnostics.reason = "synthesis_rejected";
		trackParticipant("synthesis", "synthesizer", "failed");
		emitProgress("synthesis", "阶段五：汇总方案（综合子调用失败）");
		return {
			status: "failed",
			failureReason: `综合子调用失败（${synthesisOutcome.error ?? "输出不符合结构化要求"}），流程未完成，不输出半成品结论`,
		};
	}
	for (const violation of synthesis.hardConstraintViolations) {
		const record = records.find(candidate => candidate.label === violation.proposalLabel && candidate.latestProposal);
		if (!record) {
			diagnostics.reason = "unknown_hard_constraint_proposal";
			trackParticipant("synthesis", "synthesizer", "failed");
			return {
				status: "failed",
				failureReason: `综合结果无效（硬约束违例指向不存在的方案 ${violation.proposalLabel}），流程未完成`,
			};
		}
		record.unresolvedBlocking.push(
			trackFinding(record, {
				severity: "blocking",
				issue: violation.issue,
				impact: "违反已确认的适用硬约束，修复前不可采用该方案",
				evidence: violation.evidence,
				targetAspect: "原始需求与已确认的适用硬约束",
			}),
		);
		logger.info("Team synthesis tightened eligibility", {
			component: "team.orchestrator",
			event: "team_eligibility_tightened",
			stage: "synthesis",
			result: "completed",
			proposal_label: record.label,
			unresolved_blocking_count: record.unresolvedBlocking.length,
			eligible: false,
		});
	}
	trackParticipant("synthesis", "synthesizer", "completed");
	state.recommendedProposal = synthesis.recommendedProposal.trim();
	state.recommendationPreconditions = synthesis.recommendationPreconditions;

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

	const report = assembleTeamReport({ alignment, synthesis, proposals: records, participationNotes });
	if (!report.ok) {
		diagnostics.reason = "report_contract_rejected";
		logger.error("Team report rejected", {
			component: "team.orchestrator",
			event: "team_report_rejected",
			stage: "report_assembly",
			result: "failed",
			rejection_category: "synthesis_report_contract",
		});
		return {
			status: "failed",
			failureReason: `综合结果无效（${report.error}），流程未完成，不输出半成品结论`,
		};
	}
	// "done" is announced only after the assembled report is confirmed valid:
	// a synthesis-body conflict fails the run below, and a failed run must not
	// have already told the user the discussion completed.
	emitProgress("done", "讨论完成");
	return { status: "completed", reportMarkdown: report.markdown, droppedRecommendation: report.droppedRecommendation };
}
