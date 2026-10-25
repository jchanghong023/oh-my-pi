import type { SpecPatch } from "./artifacts";
import type { SpecNativePublication, SpecNativeSource } from "./git";
import type { SpecDrivenPhase, SpecStageRole } from "./stages";
export type { SpecDrivenPhase, SpecStageRole } from "./stages";

export type SpecInputMode = "chat" | "dev";
export interface SpecConversationRecipient {
	role: SpecStageRole;
	actorId: string;
	sessionId: string;
}
export interface SpecConversationReply {
	text: string;
	requirements?: SpecRequirementsDraft;
	plan?: SpecPlanDraft;
}
export interface SpecControllerAction {
	id: string;
	label: string;
	command: string;
	available: boolean;
	blockedReason?: string;
	requiresInput?: boolean;
	version?: string;
}
export interface SpecUserMessage extends SpecConversationRecipient {
	id: string;
	text: string;
	runId: string;
	generation: number;
	phase: SpecDrivenPhase;
	clarificationId?: string;
	status: "queued" | "processing" | "cancelling" | "cancelled" | "completed" | "failed";
	reply?: string;
	error?: string;
}
export type SpecTextReceipt = { kind: "draft"; text: string } | { kind: "queued"; messageId: string };
export interface SpecInteractionState {
	mode: SpecInputMode;
	draft: string;
	recipient?: SpecConversationRecipient;
	messages: SpecUserMessage[];
	actions: SpecControllerAction[];
	blockedReason?: string;
	clarification?: SpecClarificationRound;
}

export interface SpecClarificationRound {
	id: string;
	/** Complete native question text, including numbering, recommendation and rationale. */
	questions: string[];
}
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
	/** Existing prerequisite inputs, approved independently of files that dependent tasks will create. */
	inputPaths: string[];
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
export interface SpecSolutionDraft {
	specificationVersion: string;
	runId: string;
	candidateId: string;
	candidateVersion: string;
	proposal: string;
	conditions: SpecCandidate["conditions"];
}
export interface SpecSolution extends SpecSolutionDraft {
	version: string;
	artifactVersion: string;
}
export interface SpecValidation {
	id: string;
	command: string;
	behavior: string;
	inputPaths: string[];
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
	validation: SpecValidation[];
	tdd: { mode: "required"; behavior: string } | { mode: "exception"; reason: string; alternativeCommands: string[] };
}
export interface SpecPlanDraft {
	content: string;
	workspace: { executionPath: string; isolation: "none" | "native"; integration: "native" };
	tasks: SpecTask[];
	conditions: SpecCondition[];
	finalValidation: Array<SpecValidation & { realEntry: boolean }>;
	closure: { sync: boolean; archive: boolean };
}
export interface SpecPlan extends SpecPlanDraft {
	/** Approval identity binds the artifact to its approved specification and chosen candidate. */
	version: string;
	artifactVersion: string;
	specificationVersion: string;
	candidateVersion: string;
	solutionVersion: string;
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
	repairLimit: number;
	findings: SpecFinding[];
	lastReview?: SpecReview;
	reviewedRevision?: number;
}
export interface SpecEvidenceBinding {
	actorId: string;
	taskId: string | null;
	workspace: string;
	specificationVersion: string;
	planVersion: string;
}
export interface SpecInputIdentity {
	id: string;
	runId: string;
	generation: number;
	binding: SpecEvidenceBinding;
	inputPaths: string[];
	entries: Array<{
		path: string;
		canonicalPath: string;
		kind: "file" | "directory" | "missing";
		digest?: string;
		members?: string[];
	}>;
	version: string;
	complete: boolean;
}
export interface SpecEvidenceInputs {
	inputPaths: readonly string[];
	/** Distinguishes independent obligations owned by the same task. */
	validationId: string;
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
	binding: SpecEvidenceBinding | null;
	inputsBefore: SpecInputIdentity | null;
	inputsAfter: SpecInputIdentity | null;
	conditions: {
		platform: NodeJS.Platform;
		shell: string;
		runtime: string;
		runtimeVersion: string;
		inputCaptureError?: string;
	};
	obligation: {
		validationId: string;
		approvedCommand: string;
		stage?: "red" | "green";
	} | null;
	result: {
		status: "completed" | "cancelled" | "unknown";
		exitCode: number | null;
		stdout: string;
		stderr: string;
		isError: boolean;
	};
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
	/** Actual owned-file content identity; runtime supplies it even for tasks without TDD records. */
	contentVersion?: string;
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
export interface SpecExecutionControl {
	status(): SpecTaskState[];
	start(taskId: string): Promise<SpecTask>;
	checkpoint(taskId: string, execution: SpecExecution): Promise<SpecTaskState>;
}
export interface SpecReviewArtifact {
	slotId: string;
	actorId: string;
	sessionId: string | null;
	model: string | null;
	path: string;
	version: string;
}
export interface SpecGitEvidence {
	baselines: Array<{
		planVersion: string;
		workspace: string;
		head: string;
		status: string;
		dirtyPaths: string[];
		observedAt: number;
	}>;
	current: {
		workspace: string;
		head: string | null;
		status: string | null;
		observedAt: number;
		error?: string;
	} | null;
}
export interface SpecDrivenStatus {
	phase: SpecDrivenPhase;
	paused: boolean;
	blockedReason?: string;
	generation: number;
	changeId?: string;
	/** Actual native archive location; persisted observations use it to resolve retained materials. */
	archivedChangePath?: string;
	specification?: SpecRequirements;
	plan?: SpecPlan;
	solution?: SpecSolution;
	team?: SpecTeamResult;
	selection?: { runId: string; candidateId: string; candidateVersion: string };
	specificationApproval?: string;
	planApproval?: string;
	executionMode?: "normal" | "goal";
	handoffs?: SpecHandoff[];
	executionEvidence?: { sources: SpecNativeSource[]; publications: SpecNativePublication[] };
	reviewArtifacts?: SpecReviewArtifact[];
	gitEvidence?: SpecGitEvidence;
	acceptanceVersion?: string;
	finalApproval?: string;
	questions: string[];
	clarification?: SpecClarificationRound;
	tasks: SpecTaskState[];
	reviews: SpecReviewSlot[];
	pendingClosure: string[];
}
export interface SpecRunContext {
	runId: string;
	generation: number;
	signal: AbortSignal;
}

export interface SpecActorInput {
	documents: SpecDocument[];
	handoff?: SpecHandoff;
	payload: unknown;
}
export type SpecHandoffTransition = "requirements-to-solution" | "solution-to-plan" | "plan-to-execution";
export interface SpecHandoffInput {
	transition: SpecHandoffTransition;
	documents: (SpecDocument & { version: string })[];
	decision: unknown;
	path: string;
}
export interface SpecHandoff {
	actorId: string;
	sessionId: string;
	role: SpecStageRole;
	runId: string;
	generation: number;
	transition: SpecHandoffTransition;
	path: string;
	digest: string;
	body: string;
	versions: Record<string, string>;
}
export interface SpecReviewInput {
	kind: SpecReviewKind;
	answer?: string;
	slot: SpecReviewSlot;
	specification: SpecRequirements;
	plan?: SpecPlan;
	solution?: SpecSolution;
	task?: SpecTask;
	execution?: SpecExecution;
	records: SpecToolRecord[];
	commits: SpecCommitRange[];
	/** Raw originals and the previous review remain available; no inherited model conversation. */
	previous?: SpecReview;
}
export interface SpecDrivenPorts {
	conversation?: {
		recipient(role: SpecStageRole): SpecConversationRecipient | undefined;
		respond(
			input: { text: string; role: SpecStageRole; status: SpecDrivenStatus; messageId: string },
			context: SpecRunContext,
		): Promise<SpecConversationReply>;
		repairScope?(input: { text: string; status: SpecDrivenStatus }, context: SpecRunContext): Promise<string[]>;
	};
	handoff(
		input: {
			transition: SpecHandoffTransition;
			specification: SpecRequirements;
			solution?: SpecSolution;
			plan?: SpecPlan;
			decision: unknown;
		},
		context: SpecRunContext,
	): Promise<SpecHandoff>;
	artifacts: {
		initialize(changeId: string, context: SpecRunContext): Promise<void>;
		writeRequirements(draft: SpecRequirementsDraft, context: SpecRunContext): Promise<{ version: string }>;
		readRequirements(context: SpecRunContext): Promise<{ version: string }>;
		validateRequirements(context: SpecRunContext): Promise<void>;
		writeSolution(draft: SpecSolutionDraft, context: SpecRunContext): Promise<{ version: string }>;
		readSolution(context: SpecRunContext): Promise<{ version: string }>;
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
			input: {
				specification: SpecRequirements;
				candidate: SpecCandidate;
				solution: SpecSolution;
				previous?: SpecPlan;
				amendment?: string;
				review?: SpecReview;
			},
			context: SpecRunContext,
		): Promise<unknown>;
		execute(
			input: {
				specification: SpecRequirements;
				plan: SpecPlan;
				solution: SpecSolution;
				tasks: SpecTaskState[];
				mode: "normal" | "goal";
				repair?: { text: string; taskIds: string[] };
			},
			context: SpecRunContext,
			control: SpecExecutionControl,
		): Promise<void>;
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
		/** Null means native Git observed no publishable difference; it never establishes a first commit range. */
		commit(
			input: { task: SpecTask; changedPaths: string[]; revision: number },
			context: SpecRunContext,
		): Promise<SpecCommitRange | null>;
	};
	/** Execution records live in a runner-owned ledger. Model output can reference but cannot insert them. */
	evidence: {
		read(ids: readonly string[], context: SpecRunContext): Promise<SpecToolRecord[]>;
		revalidate(context: SpecRunContext): Promise<{ taskIds: string[]; reasons: string[]; overall: boolean }>;
		flush(status: SpecDrivenStatus, context: SpecRunContext): Promise<void>;
	};
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
	/** In-process observations only; listener failures never affect native execution or evidence. */
	onStatusChange?: (status: SpecDrivenStatus) => void;
	/** Shared native admission guard, rechecked after awaited transition preparation. */
	assertTransitionAllowed?: () => void;
}
