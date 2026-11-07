import type { ComposerPort, ImageContent, SubmitResult } from "@oh-my-pi/pi-wire";
import type { SpecDrivenPhase, SpecStageRole } from "./stages";
export type { SpecDrivenPhase, SpecStageRole } from "./stages";

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
export interface SpecConversationRecipient {
	role: SpecStageRole;
	actorId: string;
	sessionId: string;
	sessionFile?: string;
}
export interface SpecConversationReply {
	text: string;
}
export interface SpecFileVersion {
	path: string;
	version: string;
}
export interface SpecDocument extends SpecFileVersion {
	content: string;
}
export interface SpecRequirements {
	files: SpecDocument[];
	version: string;
}
export interface SpecCandidate {
	id: string;
	title: string;
	content: string;
}
export interface SpecSolution extends SpecDocument {
	candidates: SpecCandidate[];
	recommendedCandidateId: string;
}
export interface SpecArtifactPaths {
	business?: string;
	requirements: string[];
	solution: string;
	plan: string;
	report: string;
}
export interface SpecRunContext {
	runId: string;
	generation: number;
	signal: AbortSignal;
}
export interface SpecAgentInput {
	role: SpecStageRole;
	entry: boolean;
	request: string;
	files: SpecDocument[];
	outputPaths: string[];
	userReply?: string;
	candidateId?: string;
	feedback?: string;
	readOnly?: boolean;
	useTeam?: boolean;
	decisions?: Partial<Record<SpecStageRole, string>>;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
}
export interface SpecVersionCheck {
	matches: boolean;
	changed: { path: string; reason: string }[];
}
export interface SpecApproval {
	files: SpecFileVersion[];
	userReply: string;
	candidateId?: string;
}
export interface SpecDrivenStatus {
	phase: SpecDrivenPhase;
	entryPhase?: "business" | "requirements";
	business?: SpecDocument;
	generation: number;
	changeId?: string;
	blockedReason?: string;
	paths?: SpecArtifactPaths;
	specification?: SpecRequirements;
	solution?: SpecSolution;
	selection?: { candidateId: string; userReply: string };
	plan?: SpecDocument;
	report?: SpecDocument;
	awaitingAcceptance?: boolean;
	accepted?: SpecApproval;
	closing?: SpecCloseProgress;
	archivedChangePath?: string;
	useTeam: boolean;
	record?: DevRequirementRecord;
	solutionBasis?: DevSolutionBasis;
	repairPaths?: string[];
	pendingGitOperationId?: string;
	observedPr?: DevPrFact;
}
/** Only durable references and explicit decisions; native session files own all conversation text. */
export interface SpecSavedRun {
	runId: string;
	phase: SpecDrivenPhase;
	entryPhase?: "business" | "requirements";
	changeId?: string;
	paths?: SpecArtifactPaths;
	approvals: Partial<Record<SpecStageRole, SpecApproval>>;
	sessions: Partial<Record<SpecStageRole, SpecConversationRecipient>>;
	awaitingAcceptance?: boolean;
	reportNeedsUpdate?: boolean;
	closing?: SpecCloseProgress;
	archivedChangePath?: string;
}
export interface SpecDrivenPorts {
	agents: {
		prepare(role: SpecStageRole, context: SpecRunContext, saved?: SpecConversationRecipient): Promise<void>;
		prepareConversation?(input: SpecAgentInput, context: SpecRunContext): Promise<void>;
		recipient(role: SpecStageRole): SpecConversationRecipient | undefined;
		originalRequest(): string;
		run(input: SpecAgentInput, context: SpecRunContext): Promise<SpecConversationReply>;
		solutionBasis?(solution: SpecSolution): Promise<DevSolutionBasis>;
	};
	artifacts: {
		initialize(changeId: string, context: SpecRunContext, businessPath?: string): Promise<SpecArtifactPaths>;
		readBusiness(context: SpecRunContext): Promise<SpecDocument>;
		readRequirements(context: SpecRunContext): Promise<SpecRequirements>;
		readSolution(context: SpecRunContext): Promise<SpecSolution>;
		readPlan(context: SpecRunContext): Promise<SpecDocument>;
		readReport(context: SpecRunContext): Promise<SpecDocument>;
		checkVersions(files: readonly SpecFileVersion[], archivedChangePath?: string): Promise<SpecVersionCheck>;
		close(
			input: {
				acceptedVersions: readonly SpecFileVersion[];
				progress?: SpecCloseProgress;
				onProgress?: (progress: SpecCloseProgress) => void | Promise<void>;
			},
			context: SpecRunContext,
		): Promise<{ archivedChangePath: string }>;
	};
}
export interface SpecDrivenOptions {
	runId?: string;
	getUseTeam: () => boolean;
	persist: (run: SpecSavedRun) => Promise<void>;
	onStatusChange?: (status: SpecDrivenStatus) => void;
	assertTransitionAllowed?: () => void;
	getSolutionBasis?: () => DevSolutionBasis | null;
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
export interface DevActionBinding {
	requirementId: string;
	expectedRecordVersion: string;
	expectedStage: DevStage;
	files: SpecFileVersion[];
	operationId: string;
	expectedGeneration: number | null;
}
export interface DevRuntimeState {
	requirementId: string;
	generation: number;
	execution: "idle" | "running" | "waiting" | "stopping" | "interrupted" | "failed";
	recipient: SpecConversationRecipient | null;
	history: "available" | "unavailable" | "not-created";
	blockedReason?: string;
}
export interface DevStoredRequirement {
	record: DevRequirementRecord;
	/** SHA-256 of the actual JSON bytes; never stored inside that JSON. */
	recordVersion: string;
}
export interface DevRequirementSnapshot extends DevStoredRequirement {
	runtime: DevRuntimeState | null;
	actions: Array<{ id: string; available: boolean; blockedReason?: string }>;
}
export type DevActionIntent =
	| { kind: "next"; candidateId?: string }
	| { kind: "back" }
	| { kind: "sync-archive" }
	| { kind: "commit" }
	| { kind: "mark"; mark: DevHumanMark }
	| { kind: "cancel" }
	| { kind: "set-test-state"; state: "in-progress" | "failed" | "retest-pending" }
	| { kind: "link-fix"; fixRequirementId: string };
export type DevAction = DevActionIntent & {
	binding: DevActionBinding;
	previewId: string | null;
	userReply: string;
};
export interface DevActionPreview {
	action: DevActionIntent & { binding: DevActionBinding; previewId: string | null };
	confirmationToken: string;
	git: DevGitPreview | null;
	cancelPlan?: DevCancelPlan | null;
}
export type DevEffectStatus = "not-started" | "succeeded" | "failed" | "unknown";
export interface DevActionResult {
	snapshot: DevRequirementSnapshot;
	persistence: {
		save: DevEffectStatus;
		commit: { status: DevEffectStatus; sha: string | null; indexReconciled: boolean };
		push: { status: DevEffectStatus; target: DevGitTarget | null };
		error?: string;
	};
}
export interface DevGitPreview {
	previewId: string;
	binding: DevActionBinding;
	headSha: string;
	indexVersion: string;
	files: SpecFileVersion[];
	paths?: string[];
	patch?: string;
	patchHash: string;
	target: DevGitTarget;
	proposedTree: string;
	commitsToPublish: string[];
	operation: DevGitAction;
	cancellation?: {
		committedShas: string[];
		changes: DevCancellationChange[];
		materials: string[];
		mainSpecs: string[];
		archivePaths: string[];
		conflicts: Array<{ path: string; reason: string }>;
	};
}
export interface DevCancellationChange {
	id: string;
	path: string;
	paths?: string[];
	layer: "committed" | "staged" | "unstaged" | "untracked";
	patch: string;
	beforeVersion: string | null;
	afterVersion: string | null;
	commitSha: string | null;
	parentSha: string | null;
}
export interface DevCancelPlan {
	preview: DevGitPreview;
	committedShas: string[];
	paths: string[];
	conflicts: Array<{ path: string; reason: string }>;
	pr: DevPrFact | null;
}
export interface DevNativeUiRequest {
	requestId: string;
	requirementId: string;
	sessionId: string;
	generation: number;
	kind: "select" | "editor" | "confirm" | "ask" | "approve";
	title: string;
	options?: Array<string | { label: string; description?: string }>;
	prefill?: string;
	secret?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		header?: string;
		options: Array<{ label: string; description?: string; preview?: string }>;
		multi?: boolean;
		recommended?: number;
	}>;
	approval?: {
		full: string;
		compact: string;
		session?: string;
		grants?: readonly { scope: "folder" | "target"; label: string; alwaysLabel: string }[];
	};
}
export interface DevNativeUiResponse {
	requestId: string;
	requirementId: string;
	sessionId: string;
	generation: number;
	value:
		| string
		| boolean
		| null
		| { grant: "folder" | "target"; always: boolean }
		| { kind: "chat" }
		| {
				kind: "submit";
				results: Array<{
					id: string;
					question: string;
					options: string[];
					multi: boolean;
					selectedOptions: string[];
					customInput?: string;
					customInputImages?: ImageContent[];
					note?: string;
					noteImages?: ImageContent[];
					noteOption?: string;
					timedOut?: boolean;
				}>;
		  };
}
export type DevNativeUiState =
	| { method: "notify"; value: { message: string; type?: "info" | "warning" | "error" } }
	| { method: "setStatus"; value: { key: string; text: string | undefined } }
	| { method: "setWorkingMessage"; value: string | undefined }
	| {
			method: "setWidget";
			value: { key: string; content: string[] | undefined; options?: { placement?: "aboveEditor" | "belowEditor" } };
	  }
	| { method: "setTitle"; value: string }
	| { method: "setEditorText"; value: string }
	| { method: "pasteToEditor"; value: string }
	| { method: "rerenderMessage"; value: number }
	| { method: "refreshTranscript"; value: readonly string[] }
	| { method: "setToolsExpanded"; value: boolean }
	| { method: "setHeader" | "setFooter"; value: null };
export type DevNativeUiStateEvent = DevNativeUiState & {
	t: "native-ui-state";
	target: DevSessionTarget;
};
export interface DevNativeCommand {
	name: string;
	description?: string;
}
export type DevSubmitResult = Exclude<SubmitResult, { kind: "sent" }>;
export type DevComposerPort = ComposerPort<DevSubmitResult>;
export interface DevSessionTarget {
	requirementId: string | null;
	sessionId: string;
	generation: number;
}
export interface DevGuestSessionTarget {
	kind: "collab";
	peerId: string;
	roomId: string;
	sessionId: string;
	generation: number;
}
export type DevInputTarget = DevSessionTarget | DevGuestSessionTarget;
