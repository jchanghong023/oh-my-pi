import type { SpecPatch } from "./artifacts";

export type SpecDrivenPhase =
	| "idle"
	| "requirements"
	| "requirements-review"
	| "awaiting-answers"
	| "awaiting-specification"
	| "team"
	| "awaiting-choice"
	| "planning"
	| "plan-review"
	| "awaiting-plan"
	| "executing"
	| "validating"
	| "overall-review"
	| "awaiting-acceptance"
	| "closing"
	| "completed"
	| "cancelled";

export interface SpecDocument {
	path: string;
	content: string;
}
export interface SpecRequirementsDraft {
	proposal: string;
	specs: SpecDocument[];
	/** Stable Requirement IDs and their exact source text; used to retain unrelated task work. */
	requirements: Array<{ id: string; text: string }>;
	questions: string[];
	/** Reviewed exact patches for an existing Markdown authority; bound into the artifact version. */
	sourceMapVersion?: string;
	sourcePatches?: SpecPatch[];
}
export interface SpecRequirements extends SpecRequirementsDraft {
	version: string;
}
export interface SpecCondition {
	id: string;
	description: string;
	command: string;
}
export interface SpecCandidate {
	id: string;
	label: string;
	version: string;
	proposal: string;
	adoptable: boolean;
	reviewSucceeded: boolean;
	recheckSucceeded: boolean;
	unresolvedBlocking: Array<{ id: string; evidence: string }>;
	exclusionReason?: string;
	conditions: Array<{ id: string; description: string; command?: string }>;
}
export interface SpecTeamResult {
	runId: string;
	inputVersion: string;
	status: "completed" | "failed" | "cancelled";
	report: string;
	candidates: SpecCandidate[];
	interpretationDifferences: Array<{ id: string; question: string; affectsChoice: boolean; resolved: boolean }>;
}
export interface SpecTask {
	id: string;
	title: string;
	instructions: string;
	requirementIds: string[];
	dependencies: string[];
	conditionIds: string[];
	ownedPaths: string[];
	/** Exact production files; test writes do not count as the TDD implementation start. */
	implementationPaths: string[];
	/** Explicit interface/state contract. Changes invalidate this task even when its prose is unchanged. */
	solutionBinding: string;
	validation: Array<{ id: string; command: string; behavior: string }>;
	tdd: { mode: "required"; behavior: string } | { mode: "exception"; reason: string; alternativeCommands: string[] };
}
export interface SpecPlanDraft {
	content: string;
	tasks: SpecTask[];
	conditions: SpecCondition[];
	finalValidation: Array<{ id: string; command: string; behavior: string; realEntry: boolean }>;
	closure: { sync: boolean; archive: boolean };
}
export interface SpecPlan extends SpecPlanDraft {
	/** Approval identity binds the artifact to its approved specification and chosen candidate. */
	version: string;
	artifactVersion: string;
	specificationVersion: string;
	candidateVersion: string;
}
export interface SpecFinding {
	id: string;
	severity: "blocking" | "important" | "minor";
	issue: string;
	evidence: string;
	taskIds: string[];
}
export interface SpecReview {
	verdict: "pass" | "revise" | "clarify";
	summary: string;
	findings: SpecFinding[];
	resolutions: Array<{ findingId: string; resolved: boolean; evidence: string }>;
	questions: string[];
	/** Reviewer independently checks test failure semantics, not just the exit code. */
	evidenceChecks: Array<{ recordId: string; behavior: string; valid: boolean; reason: string }>;
}
export type SpecReviewKind = "requirements" | "plan" | "task" | "overall";
export interface SpecReviewSlot {
	id: string;
	kind: SpecReviewKind;
	model: string;
	sameModelIndependent: boolean;
	revision: number;
	findings: SpecFinding[];
	lastReview?: SpecReview;
	reviewedRevision?: number;
}
/** Captured by the trusted native runner, NEVER parsed from a model's yielded JSON. */
export interface SpecToolRecord {
	id: string;
	runId: string;
	generation: number;
	toolCallId: string;
	tool: string;
	args: { command: string; cwd: string };
	startedAt: number;
	finishedAt: number;
	result: { exitCode: number; stdout: string; stderr: string; isError: boolean };
	artifact: { path: string; version: string };
}
export interface SpecExecution {
	changedPaths: string[];
	recordIds: string[];
	redRecordId: string | null;
	greenRecordId: string | null;
	/** Time of the first implementation write, from native tool capture. */
	implementationStartedAt: number | null;
	requestedTddException: string | null;
}
export interface SpecCommitRange {
	base: string;
	head: string;
	taskId: string;
	paths: string[];
	reviewPackage: string;
}
export interface SpecTaskState {
	id: string;
	fingerprint: string;
	specificationVersion: string;
	planVersion: string;
	status: "pending" | "implemented" | "verified" | "completed";
	execution?: SpecExecution;
	records: SpecToolRecord[];
	commits: SpecCommitRange[];
	review?: SpecReviewSlot;
	committedExecutionIds?: string[];
	repairReview?: SpecReview;
	validatedIds?: string[];
}
export interface SpecDrivenStatus {
	phase: SpecDrivenPhase;
	paused: boolean;
	blockedReason?: string;
	generation: number;
	changeId?: string;
	specification?: SpecRequirements;
	plan?: SpecPlan;
	team?: SpecTeamResult;
	selection?: { runId: string; candidateId: string; candidateVersion: string };
	specificationApproval?: string;
	planApproval?: string;
	acceptanceVersion?: string;
	finalApproval?: string;
	questions: string[];
	tasks: SpecTaskState[];
	reviews: SpecReviewSlot[];
	pendingClosure: string[];
}
export interface SpecRunContext {
	runId: string;
	generation: number;
	signal: AbortSignal;
}
export interface SpecReviewInput {
	kind: SpecReviewKind;
	slot: SpecReviewSlot;
	specification: SpecRequirements;
	plan?: SpecPlan;
	task?: SpecTask;
	execution?: SpecExecution;
	records: SpecToolRecord[];
	commits: SpecCommitRange[];
	/** Raw originals and the previous review remain available; no inherited model conversation. */
	previous?: SpecReview;
}
export interface SpecDrivenPorts {
	artifacts: {
		initialize(changeId: string, context: SpecRunContext): Promise<void>;
		writeRequirements(draft: SpecRequirementsDraft, context: SpecRunContext): Promise<{ version: string }>;
		readRequirements(context: SpecRunContext): Promise<{ version: string }>;
		validateRequirements(context: SpecRunContext): Promise<void>;
		writePlan(draft: SpecPlanDraft, context: SpecRunContext): Promise<{ version: string }>;
		readPlan(context: SpecRunContext): Promise<{ version: string }>;
		/** Must atomically recheck approved source identities before sync/archive. */
		close(
			input: {
				specification: SpecRequirements;
				plan: SpecPlan;
				acceptanceVersion: string;
				requirementsReview: SpecReviewSlot;
			},
			context: SpecRunContext,
		): Promise<void>;
	};
	models: {
		requirements(
			input: { request: string; answer?: string; previous?: SpecRequirements; review?: SpecReview },
			context: SpecRunContext,
		): Promise<unknown>;
		plan(
			input: { specification: SpecRequirements; candidate: SpecCandidate; previous?: SpecPlan; review?: SpecReview },
			context: SpecRunContext,
		): Promise<unknown>;
		execute(
			input: {
				specification: SpecRequirements;
				plan: SpecPlan;
				task: SpecTask;
				review?: SpecReview;
				revision: number;
			},
			context: SpecRunContext,
		): Promise<SpecExecution>;
		review(input: SpecReviewInput, context: SpecRunContext): Promise<unknown>;
	};
	team: {
		run(
			input: { specification: SpecRequirements; answer?: string },
			context: SpecRunContext,
		): Promise<SpecTeamResult>;
	};
	git: {
		preflight(input: { specification: SpecRequirements; plan: SpecPlan }, context: SpecRunContext): Promise<void>;
		commit(
			input: { task: SpecTask; changedPaths: string[]; revision: number },
			context: SpecRunContext,
		): Promise<SpecCommitRange>;
	};
	/** Execution records live in a runner-owned ledger. Model output can reference but cannot insert them. */
	evidence: { read(ids: readonly string[], context: SpecRunContext): Promise<SpecToolRecord[]> };
	validation: {
		run(
			input: { command: string; purpose: "condition" | "task" | "final"; id: string },
			context: SpecRunContext,
		): Promise<string>;
	};
}
export interface SpecDrivenOptions {
	currentModel: string;
	/** Already resolved against the model registry, preserving configured order. */
	members?: readonly string[];
	/** Explicit unavailable configured members must be rejected, never silently dropped. */
	unavailableMembers?: readonly string[];
	runId?: string;
}
