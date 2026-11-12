/** AIReq's transport contracts. No native runtime or server dependencies. */
export const AIREQ_WORKFLOW_VERSION = 1 as const;
export const AIREQ_WORKFLOW_STAGES = ["solution", "planning", "executing", "pr"] as const;
export type AIReqWorkflowStage = (typeof AIREQ_WORKFLOW_STAGES)[number];
export type AIReqRequirementStatus = "draft" | "reviewing" | "confirmed" | "requirements-pr" | "frozen" | "deleted";
export interface AIReqObjectRef {
	projectId: string;
	irId: string;
	srId?: string;
}
export interface AIReqNativeSessionRef extends AIReqObjectRef {
	sessionId: string;
	sessionFile: string;
	role: "requirements" | "reviewer" | AIReqWorkflowStage;
	phase: "requirements" | AIReqWorkflowStage;
	round: number;
}
export interface AIReqFileVersion {
	path: string;
	sha256: string;
	size: number;
}
export interface AIReqDocument {
	path: string;
	content: string;
}
export interface AIReqAttachment {
	path: string;
	content: string | Uint8Array;
}
export interface AIReqProject {
	id: string;
	name: string;
	root: string;
	commonDir: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	defaultBranch: string;
	remote?: string;
	repositoryId: string;
}
export interface AIReqRelease {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
}
export interface AIReqWorktree {
	path: string;
	branch: string;
	baseCommit: string;
}
export interface AIReqReview {
	id: string;
	snapshotDigest: string;
	passed: boolean;
	report: string;
	reviewer: AIReqNativeSessionRef | { sessionId: string; role: "reviewer"; sourceProjectId: string; imported: true };
	createdAt: string;
}
export interface AIReqConfirmation {
	operationId: string;
	snapshotDigest: string;
	confirmedAt: string;
}
export interface AIReqRequirementSnapshot {
	version: 1;
	projectId: string;
	irId: string;
	title: string;
	srs: { id: string; title: string; documentPath: string }[];
	documentPath: string;
	files: AIReqFileVersion[];
	digest: string;
}
export interface AIReqPrFact {
	url: string;
	sourceBranch: string;
	targetBranch: string;
	recordedAt: string;
	/** Human declaration only, not a claim of platform verification. */
	platformVerified: false;
}
export interface AIReqMergeFact {
	commit: string;
	branch: string;
	checkedAt: string;
	files: AIReqFileVersion[];
}
/** Navigation/admission tombstone only; retained files, Git and native history are untouched. */
export interface AIReqRequirementDeletion {
	version: 1;
	operationId: string;
	deletedAt: string;
	manualCloseNeeded: boolean;
	requirementsPrUrl?: string;
}
export interface AIReqStageApproval {
	stage: AIReqWorkflowStage;
	round: number;
	operationId: string;
	digest: string;
	files: AIReqFileVersion[];
	approvedAt: string;
}
export interface AIReqStageMaterial {
	stage: AIReqWorkflowStage;
	kind: "solution" | "plan" | "completion" | "ut" | "st" | "delivery";
	path: string;
	sha256: string;
	size: number;
	round: number;
	valid: boolean;
}
export interface AIReqSystemRequirement {
	id: string;
	projectId: string;
	irId: string;
	title: string;
	documentPath: string;
	status: "pending" | "developing" | "completed";
	stage?: AIReqWorkflowStage;
	round: number;
	worktree?: AIReqWorktree;
	sessions: AIReqNativeSessionRef[];
	approvals: AIReqStageApproval[];
	materials: AIReqStageMaterial[];
	materialDigest?: string;
	codePr?: AIReqPrFact;
	codeMerge?: AIReqMergeFact;
}
export interface AIReqRequirementGroup {
	id: string;
	projectId: string;
	releaseId: string;
	title: string;
	documentPath: string;
	origin: "local" | "browser" | "import";
	status: AIReqRequirementStatus;
	revision: number;
	srIds: string[];
	files: AIReqFileVersion[];
	evidenceFiles?: AIReqFileVersion[];
	retiredFiles?: AIReqFileVersion[];
	worktree?: AIReqWorktree;
	sessions: AIReqNativeSessionRef[];
	snapshot?: AIReqRequirementSnapshot;
	confirmation?: AIReqConfirmation;
	review?: AIReqReview;
	requirementsPr?: AIReqPrFact;
	merge?: AIReqMergeFact;
	packageId?: string;
	packageDigest?: string;
	createdAt: string;
	deletion?: AIReqRequirementDeletion;
}
export interface AIReqOperationReceipt {
	operationId: string;
	commandDigest: string;
	type: string;
	status: "running" | "completed" | "failed";
	startedAt: string;
	completedAt?: string;
	revision: number;
	irId?: string;
	srId?: string;
	steps: { name: string; at: string; detail: string }[];
	error?: string;
	deletion?: AIReqRequirementDeletion;
}
export interface AIReqProjectState {
	version: 1;
	project: AIReqProject;
	revision: number;
	releases: AIReqRelease[];
	groups: AIReqRequirementGroup[];
	srs: AIReqSystemRequirement[];
	activeSrId?: string;
	operations: AIReqOperationReceipt[];
	/** A crashed/foreign owner is never taken over automatically. */
	owner?: { hostname: string; processId: number; token: string; acquiredAt: string };
}
export interface AIReqMaterialView extends AIReqFileVersion {
	projectId: string;
	irId: string;
	srId?: string;
	kind: "ir" | "sr" | AIReqStageMaterial["kind"] | "attachment";
	stage?: AIReqWorkflowStage;
	valid: boolean;
	content?: string;
	error?: string;
}
export interface AIReqChangedFile extends AIReqFileVersion, AIReqObjectRef {
	status: string;
}
export interface AIReqWorkflowView {
	version: 1;
	revision: number;
	projects: AIReqProject[];
	currentProjectId?: string;
	releases: AIReqRelease[];
	groups: AIReqRequirementGroup[];
	drafts: AIReqRequirementGroup[];
	srs: AIReqSystemRequirement[];
	selected?: AIReqObjectRef;
	/** Native working directory for the exact selected object, never a client-side path guess. */
	workspace?: { path: string; identity: string };
	materials: AIReqMaterialView[];
	operations: AIReqOperationReceipt[];
	sessions: AIReqNativeSessionRef[];
	activeSrId?: string;
	running: AIReqNativeSessionRef[];
	changes?: AIReqChangedFile[];
	error?: string;
}
export interface AIReqCommandBase {
	operationId: string;
	expectedRevision: number;
	projectId?: string;
	irId?: string;
	srId?: string;
}
export type AIReqWorkflowCommand = AIReqCommandBase &
	(
		| { type: "registerProject"; registrationScope: "target-root"; root: string; name: string }
		| { type: "createRelease"; title: string }
		| { type: "createLocalDraft" | "createBrowserDraft"; releaseId: string }
		| { type: "importPackage"; releaseId: string; packageId: string }
		| { type: "deleteRequirement"; version: 1; projectId: string; irId: string }
		| { type: "confirmRequirements"; snapshotDigest: string }
		| { type: "markRequirementsPrSubmitted" | "markCodePrSubmitted"; url: string }
		| { type: "markRequirementsMerged" | "markCodeMerged" }
		| { type: "startSr" }
		| { type: "approveStage"; stage: AIReqWorkflowStage; round: number; materialDigest: string }
		| { type: "backStage"; stage: "solution" | "planning" | "executing" }
		| { type: "stop" }
		| {
				type: "publishMaterials";
				scope: "requirements" | "development";
				paths: string[];
				versions?: AIReqFileVersion[];
				message: string;
				push: boolean;
		  }
	);
export interface AIReqWorkflowResult {
	operationId: string;
	projectId: string;
	revision: number;
	irId?: string;
	srId?: string;
	status: "completed" | "failed" | "running";
	receipt: AIReqOperationReceipt;
	view?: AIReqWorkflowView;
	error?: string;
	deletion?: AIReqRequirementDeletion;
}
export interface AIReqRequirementContent {
	title: string;
	document: AIReqDocument;
	srs: { id: string; title: string; document: AIReqDocument }[];
	attachments: AIReqAttachment[];
}
export interface AIReqPackageManifest {
	format: "omp-aireq-requirements";
	version: 1;
	packageId: string;
	sourceProjectId: string;
	repositoryId: string;
	irId: string;
	releaseId: string;
	createdAt: string;
	snapshot: AIReqRequirementSnapshot;
	confirmation: AIReqConfirmation;
	review: Omit<AIReqReview, "reviewer"> & { reviewer: { sessionId: string; role: "reviewer" } };
	files: AIReqFileVersion[];
}
export interface AIReqDecodedPackage {
	manifest: AIReqPackageManifest;
	files: Map<string, Uint8Array>;
	digest: string;
}
