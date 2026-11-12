// Existing workspace records remain readable without retaining their retired execution engine.
export interface SpecCloseProgress {
	synced?: boolean;
	archivedChangePath?: string;
	retirementCleanup?: { paths: string[]; diagnostic: string };
	sideEffects?: {
		paths: string[];
		diagnostic: string;
		expectedVersions?: Array<{ path: string; version: string | null }>;
	};
	archiveCleanup?: { path: string; diagnostic: string };
	targetVersions?: Array<{ path: string; version: string | null }>;
	ownership?: { captureId: string; state: "pending" | "settled" };
}
export interface SpecFileVersion {
	path: string;
	version: string;
}
export interface SpecApproval {
	files: SpecFileVersion[];
	userReply: string;
	candidateId?: string;
}
export type AIReqStage = "business" | "requirements" | "solution" | "planning" | "executing" | "st" | "pr" | "testing";
export type AIReqHumanMark = "st-complete" | "pr-submitted" | "pr-merged" | "tested";
export type AIReqLifecycle = "active" | "completed" | "cancelling" | "cancelled";
export interface AIReqPerson {
	name: string;
	source: "local" | "collab";
	peerId?: string;
}
export interface AIReqMaterialRef extends SpecFileVersion {
	id: string;
	kind: "business" | "proposal" | "delta" | "solution" | "plan" | "report";
}
export interface AIReqDecision {
	operationId: string;
	stage: AIReqStage;
	actor: AIReqPerson;
	at: string;
	userReply: string;
	files: SpecFileVersion[];
	candidateId?: string;
}
export interface AIReqPrRef {
	forge: "github" | "gitlab";
	repository: string;
	number: number;
	url: string;
	sourceRef: string;
	baseRef: string;
}
export interface AIReqPrFact {
	pr: AIReqPrRef;
	state: "open" | "closed" | "merged";
	headSha: string;
	baseSha: string;
	mergeSha: string | null;
	observedAt: string;
}
export interface AIReqGitTarget {
	localSourceRef: string;
	sourceRepository: string;
	sourceRef: string;
	baseRepository: string;
	baseRef: string;
	remote: string;
	remoteUrl: string;
	targetRef: string;
	observedTip: string | null;
}
export type AIReqGitAction = AIReqHumanMark | "set-test-state" | "link-fix" | "commit" | "cancel";
export interface AIReqGitOperation {
	operationId: string;
	kind: AIReqGitAction;
	actor: AIReqPerson;
	at: string;
	files: SpecFileVersion[];
	target: AIReqGitTarget;
	authorizedCommits: string[];
	knownCommitShas: string[];
}
export interface AIReqSolutionBasis {
	solutionVersion: string;
	candidateIds: string[];
	usableCandidateIds: string[];
	source: "single-agent" | "team";
	sourceSessionId: string;
	sourceEntryIds: string[];
}
export interface AIReqSyncRevision {
	operationId: string;
	files: SpecFileVersion[];
	mainSpecs: Array<{ path: string; version: string | null }>;
	archivedChangePath: string | null;
	progress: SpecCloseProgress;
}
export interface AIReqRequirementRecord {
	schemaVersion: 1;
	requirementId: string;
	changeId: string;
	branch: string;
	stage: AIReqStage;
	lifecycle: AIReqLifecycle;
	materials: AIReqMaterialRef[];
	decisions: AIReqDecision[];
	marks: Partial<Record<AIReqHumanMark, AIReqDecision>>;
	solutionBasis: AIReqSolutionBasis | null;
	report: { development: SpecApproval | null; st: SpecFileVersion | null };
	syncRevisions: AIReqSyncRevision[];
	gitOperations: AIReqGitOperation[];
	pr: AIReqPrFact | null;
	testing: "not-started" | "in-progress" | "failed" | "retest-pending" | "tested";
	relatedRequirementIds: string[];
}
export interface AIReqStoredRequirement {
	record: AIReqRequirementRecord;
	/** SHA-256 of the actual JSON bytes; never stored inside that JSON. */
	recordVersion: string;
}
