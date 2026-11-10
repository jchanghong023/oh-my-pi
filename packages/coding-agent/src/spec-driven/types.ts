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
export type DevStage = "business" | "requirements" | "solution" | "planning" | "executing" | "st" | "pr" | "testing";
export type DevHumanMark = "st-complete" | "pr-submitted" | "pr-merged" | "tested";
export type DevLifecycle = "active" | "completed" | "cancelling" | "cancelled";
export interface DevPerson {
	name: string;
	source: "local" | "collab";
	peerId?: string;
}
export interface DevMaterialRef extends SpecFileVersion {
	id: string;
	kind: "business" | "proposal" | "delta" | "solution" | "plan" | "report";
}
export interface DevDecision {
	operationId: string;
	stage: DevStage;
	actor: DevPerson;
	at: string;
	userReply: string;
	files: SpecFileVersion[];
	candidateId?: string;
}
export interface DevPrRef {
	forge: "github" | "gitlab";
	repository: string;
	number: number;
	url: string;
	sourceRef: string;
	baseRef: string;
}
export interface DevPrFact {
	pr: DevPrRef;
	state: "open" | "closed" | "merged";
	headSha: string;
	baseSha: string;
	mergeSha: string | null;
	observedAt: string;
}
export interface DevGitTarget {
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
export type DevGitAction = DevHumanMark | "set-test-state" | "link-fix" | "commit" | "cancel";
export interface DevGitOperation {
	operationId: string;
	kind: DevGitAction;
	actor: DevPerson;
	at: string;
	files: SpecFileVersion[];
	target: DevGitTarget;
	authorizedCommits: string[];
	knownCommitShas: string[];
}
export interface DevSolutionBasis {
	solutionVersion: string;
	candidateIds: string[];
	usableCandidateIds: string[];
	source: "single-agent" | "team";
	sourceSessionId: string;
	sourceEntryIds: string[];
}
export interface DevSyncRevision {
	operationId: string;
	files: SpecFileVersion[];
	mainSpecs: Array<{ path: string; version: string | null }>;
	archivedChangePath: string | null;
	progress: SpecCloseProgress;
}
export interface DevRequirementRecord {
	schemaVersion: 1;
	requirementId: string;
	changeId: string;
	branch: string;
	stage: DevStage;
	lifecycle: DevLifecycle;
	materials: DevMaterialRef[];
	decisions: DevDecision[];
	marks: Partial<Record<DevHumanMark, DevDecision>>;
	solutionBasis: DevSolutionBasis | null;
	report: { development: SpecApproval | null; st: SpecFileVersion | null };
	syncRevisions: DevSyncRevision[];
	gitOperations: DevGitOperation[];
	pr: DevPrFact | null;
	testing: "not-started" | "in-progress" | "failed" | "retest-pending" | "tested";
	relatedRequirementIds: string[];
}
export interface DevStoredRequirement {
	record: DevRequirementRecord;
	/** SHA-256 of the actual JSON bytes; never stored inside that JSON. */
	recordVersion: string;
}
