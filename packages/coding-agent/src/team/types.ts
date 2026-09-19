/**
 * `/team` multi-model discussion: shared types.
 *
 * The command runs a code-driven five-stage orchestrator (independent
 * investigation → alignment → cross review → revision/recheck → synthesis)
 * over read-only subagents. See `docs-zh-CN/team.md` for the contract; every
 * mechanical guarantee from that document is enforced here in code, not in
 * prompts.
 */
import type { Model } from "@oh-my-pi/pi-ai";

/** One participating model. Proposers are labelled A, B, ... in this order. */
export interface TeamParticipant {
	index: number;
	/** Exact `provider/id` pattern pinned for this participant's subagents. */
	modelPattern: string;
	model: Model;
	/** True for the participant whose model is the session model, however it joined. */
	isSessionModel: boolean;
}

export type TeamSeverity = "blocking" | "important" | "minor";

export interface TeamAssumption {
	content: string;
	basis: string;
	status: "verified" | "unverified" | "falsified";
	impactIfWrong: string;
}

export interface TeamAmbiguityInterpretation {
	ambiguity: string;
	interpretation: string;
	impact: string;
}

export interface TeamEvidenceItem {
	claim: string;
	source: string;
}

/** Structured output of a proposal subagent (stage 1). */
export interface TeamProposalOutput {
	/** The proposal document proper; budget ≤ 4000 chars, mechanically enforced. */
	proposal: string;
	noViableProposal: boolean;
	keyAssumptions: TeamAssumption[];
	risks: string[];
	unknowns: string[];
	acceptanceCriteria: string[];
	ambiguityInterpretations: TeamAmbiguityInterpretation[];
	evidence: TeamEvidenceItem[];
}

export interface TeamFinding {
	severity: TeamSeverity;
	issue: string;
	impact: string;
	evidence: string;
	targetAspect: string;
}

/**
 * Structured output of a review subagent (stage 3, and stage-4 rechecks).
 * `priorBlockingStatus` adjudicates the previous round's blocking findings and
 * is only meaningful on rechecks (`not-applicable` on the initial review).
 */
export interface TeamReviewOutput {
	noSubstantiveIssues: boolean;
	/** Review narrative; budget ≤ 1500 chars, mechanically enforced. */
	reviewSummary: string;
	findings: TeamFinding[];
	priorBlockingStatus: "resolved" | "partially-resolved" | "unresolved" | "not-applicable";
}

export type TeamDisposition = "accepted-and-revised" | "rejected-with-evidence" | "genuine-tradeoff" | "unresolved";

export interface TeamRevisionResponse {
	finding: string;
	disposition: TeamDisposition;
	explanation: string;
}

/**
 * Structured flags that mechanically decide whether a recheck review runs.
 * `disputesBlockingFinding` is the fork's fourth flag beyond the three listed
 * in the spec: a proposer rejecting a blocking criticism with evidence also
 * needs a fresh reviewer to adjudicate, otherwise unfounded criticism would
 * veto a proposal with no appeal path ("无依据意见不自动否决方案").
 */
export interface TeamRevisionFlags {
	changedCoreDesign: boolean;
	claimsResolvedBlocking: boolean;
	newEvidenceChangesAssumptions: boolean;
	disputesBlockingFinding: boolean;
}

/** Structured output of a revision subagent (stage 4). */
export interface TeamRevisionOutput {
	revisedProposal: string;
	revisionSummary: string;
	responses: TeamRevisionResponse[];
	reviewFlags: TeamRevisionFlags;
}

export interface TeamFactDifference {
	topic: string;
	contradiction: string;
	proposalsInvolved: string[];
	sourceToCheck: string;
}

export interface TeamInterpretationView {
	view: string;
	impact: string;
}

export interface TeamInterpretationDifference {
	ambiguity: string;
	interpretations: TeamInterpretationView[];
	affectsChoice: boolean;
}

/** Structured output of the alignment sub-call (stage 2, session model). */
export interface TeamAlignmentOutput {
	unifiedUnderstanding: string;
	acceptanceCriteria: string[];
	factDifferences: TeamFactDifference[];
	interpretationDifferences: TeamInterpretationDifference[];
}

/** Structured output of the synthesis sub-call (stage 5, session model). */
export interface TeamSynthesisOutput {
	reportMarkdown: string;
	/** Proposal label ("A", "B", ...) or "" for no recommendation. */
	recommendedProposal: string;
	recommendationReason: string;
	recommendationPreconditions: string;
}

export type TeamRole = "proposer" | "reviewer" | "reviser" | "aligner" | "synthesizer";

/** One programmatic subagent invocation requested by the orchestrator. */
export interface TeamSubagentCall {
	role: TeamRole;
	/** Exact `provider/id` pattern; the runner pins the child session to it. */
	modelPattern: string;
	/** Short registry/UI label, e.g. `team-proposal-A`. */
	label: string;
	task: string;
	schema: unknown;
}

export type TeamSubagentOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/**
 * Executes one subagent call. The default implementation drives
 * `runSubprocess`; tests inject deterministic stub runners.
 */
export type TeamSubagentRunner = (call: TeamSubagentCall, signal: AbortSignal) => Promise<TeamSubagentOutcome>;

/** Orchestrator stage names, in execution order. */
export type TeamStage = "investigation" | "alignment" | "review" | "revision" | "synthesis" | "done";

/** Stage-level progress payload surfaced through the existing job/status mechanisms. */
export interface TeamProgressUpdate {
	stage: TeamStage;
	/** Human-readable line naming the stage and settled participants. */
	text: string;
	participants: ReadonlyArray<TeamParticipantStatus>;
}

export interface TeamParticipantStatus {
	/** Proposal label for proposer runs; role label otherwise. */
	label: string;
	role: TeamRole;
	state: "pending" | "running" | "completed" | "failed";
}

/** Per-proposal bookkeeping after each stage settles. */
export interface TeamProposalRecord {
	label: string;
	participant: TeamParticipant;
	originalProposal?: TeamProposalOutput;
	latestProposal?: TeamProposalOutput;
	revision?: TeamRevisionOutput;
	reviews: TeamReviewOutput[];
	/** Reviewer participant (rotation-resolved); audit only, never enters prompts. */
	reviewer?: TeamParticipant;
	roundsUsed: number;
	/** Mechanically tracked unresolved blocking finding descriptions. */
	unresolvedBlocking: string[];
	proposerFailed: boolean;
	reviewFailed: boolean;
	recheckFailed: boolean;
	revisionFailed: boolean;
	/** True when the proposal cannot be offered as a final option. */
	excludedFromOptions: boolean;
	exclusionReason?: string;
	/** True when the two-round cap was hit with blocking findings outstanding. */
	blockedAfterRoundCap: boolean;
}

export interface TeamRunResult {
	status: "completed" | "failed" | "cancelled";
	/** Final assembled markdown (completed runs only). */
	reportMarkdown?: string;
	failureReason?: string;
	/** Set when a recommendation was mechanically dropped by structured tracking. */
	droppedRecommendation?: boolean;
}
