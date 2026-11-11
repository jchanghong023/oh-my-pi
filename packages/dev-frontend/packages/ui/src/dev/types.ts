/** Phase-one frontend presentation contracts. No OMP runtime dependency or execution authority. */
export const DEV_WORKFLOW_VERSION = 1 as const;
export const DEV_WORKFLOW_STAGES = ["planning", "executing", "pr"] as const;
export type DevWorkflowStage = (typeof DEV_WORKFLOW_STAGES)[number] | "solution";
export type DevRequirementStatus = "draft" | "solution-ready" | "requirements-pr" | "formal" | "frozen" | "deleted" | "reviewing" | "confirmed";
export interface DevObjectRef { projectId: string; irId: string; srId?: string }
export interface DevNativeSessionRef extends DevObjectRef {
  sessionId: string; sessionFile: string; role: "requirements" | "solution" | "reviewer" | "ir-acceptance" | DevWorkflowStage;
  phase: "requirements" | "solution" | "ir-acceptance" | DevWorkflowStage; round: number; modelConfig?: DevAgentModelBinding;
}
export interface DevFileVersion { path: string; sha256: string; size: number }
export interface DevProject {
  id: string; name: string; storageName?: string; root: string; commonDir: string; revision: number;
  createdAt: string; updatedAt: string; defaultBranch: string; remote?: string; repositoryId: string;
}
export interface DevRelease { id: string; projectId: string; title: string; createdAt: string }
export interface DevWorktree { path: string; branch: string; baseCommit: string }
export interface DevReview {
  id: string; snapshotDigest: string; passed: boolean; report: string; modelConfig?: DevAgentModelBinding;
  inputFiles?: DevFileVersion[];
  requestedBy?: string; round?: number; findings?: { id: string; level: "blocking" | "suggestion"; message: string; documentPath: string }[];
  reviewer: DevNativeSessionRef | { sessionId: string; role: "reviewer"; sourceProjectId: string; imported: true }; createdAt: string;
}
export interface DevConfirmation { operationId: string; snapshotDigest: string; confirmedAt: string }
export interface DevRequirementSnapshot {
  version: 1; projectId: string; irId: string; title: string;
  srs: { id: string; title: string; documentPath: string }[]; documentPath: string; files: DevFileVersion[]; digest: string;
}
export interface DevPrFact { url: string; sourceBranch: string; targetBranch: string; recordedAt: string; platformVerified: false }
export interface DevMergeFact { commit: string; branch: string; checkedAt: string; files: DevFileVersion[] }
export interface DevProposalDelivery {
  candidate: string; version: string; files: DevFileVersion[];
  confirmedBy: string; confirmedAt: string;
  pushedCandidate?: string; pushedAt?: string; prCandidate?: string;
}
export interface DevRequirementsDecision {
  reviewId: string; snapshotDigest: string; inputFiles: DevFileVersion[];
  opinion: string; outcome: "supplement" | "maintain" | "defer"; result: string;
  employeeId: string; createdAt: string; review: DevReview;
}
export interface DevProposalRevision {
  reason: string; employeeId: string; startedAt: string; completedAt?: string;
  snapshot: DevRequirementSnapshot; merge: DevMergeFact; materials: DevMaterialView[];
  requirementsPr?: DevPrFact; delivery?: DevProposalDelivery; review?: DevReview;
}
export interface DevRequirementDeletion { version: 1; operationId: string; deletedAt: string; manualCloseNeeded: boolean; requirementsPrUrl?: string }
export interface DevStageApproval { stage: DevWorkflowStage; round: number; operationId: string; digest: string; files: DevFileVersion[]; approvedAt: string; valid?: boolean }
export interface DevStageMaterial extends DevFileVersion {
  stage: DevWorkflowStage; kind: "solution" | "plan" | "completion" | "ut" | "st" | "delivery"; round: number; valid: boolean;
}
export interface DevSrDelivery {
  candidate: string; round: number; defaultCommit: string; inputDigest: string;
  inputs: DevFileVersion[]; files: (DevFileVersion & { category: "code" | "test" | "spec" })[];
  manifestPath: string; sourceChange: string; sourceSpec: string;
  status: "prepared" | "verified" | "implementation-issue" | "git-conflict" | "requirement-conflict";
  verification?: { candidate: string; defaultCommit: string; checkedAt: string };
  pushedCandidate?: string; prCandidate?: string; humanResolution?: { note: string; employeeId: string; resolvedAt: string };
}
export interface DevSystemRequirement {
  ompWebId?: string;
  id: string; projectId: string; irId: string; title: string; documentPath: string;
  status: "pending" | "developing" | "completed"; stage?: DevWorkflowStage | "solution"; round: number;
  delivery?: DevSrDelivery; deliveryHistory?: DevSrDelivery[];
  dependencySrIds?: string[];
  developerEmployeeId?: string; startedAt?: string; developmentRoot?: string;
  worktree?: DevWorktree; sessions: DevNativeSessionRef[]; approvals: DevStageApproval[];
  materials: DevStageMaterial[]; materialDigest?: string; codePrHistory?: DevPrFact[]; codePr?: DevPrFact; codeMerge?: DevMergeFact;
}
export interface DevIrAcceptance {
  status: "reviewing" | "issues" | "passed" | "pr-ready" | "pr-submitted" | "completed";
  employeeId: string; startedAt: string; session: DevNativeSessionRef; worktree: DevWorktree;
  baseCommit: string; candidate: string; revision: number; reportPath?: string;
  reportCandidate?: string; reportBaseCommit?: string; reportVersion?: DevFileVersion; srMergeVersion?: string;
  hasFixes: boolean; finalPrPath?: string; finalPrVersion?: DevFileVersion; pr?: DevPrFact;
  archive?: { sourceRoot: string; targetRoot: string; skipSpecs: boolean; moves: (DevFileVersion & { sourcePath: string })[]; fixes: DevFileVersion[] };
  packageVersion?: string; pushedCandidate?: string; pushedPackageVersion?: string; prCandidate?: string; prPackageVersion?: string;
  history?: { candidate: string; baseCommit: string; status: string; reportPath?: string; finalPrPath?: string; prUrl?: string }[];
  archiveResult?: { sourceAbsent: boolean; targetFiles: DevFileVersion[]; skipSpecs: boolean };
  merge?: DevMergeFact;
}
export interface DevRequirementGroup {
  pendingFirstMessage?: boolean; clientDraftId?: string;
  ompWebId?: string;
  id: string; projectId: string; releaseId: string; title: string; documentPath: string;
  origin: "local" | "browser" | "import"; status: DevRequirementStatus; revision: number; srIds: string[];
  files: DevFileVersion[]; evidenceFiles?: DevFileVersion[]; retiredFiles?: DevFileVersion[]; worktree?: DevWorktree;
  sessions: DevNativeSessionRef[]; snapshot?: DevRequirementSnapshot; confirmation?: DevConfirmation; review?: DevReview; reviewHistory?: DevReview[];
  requirementsPr?: DevPrFact; merge?: DevMergeFact; createdAt: string;
  proposalDelivery?: DevProposalDelivery; proposalDeliveryHistory?: DevProposalDelivery[];
  proposalRevisions?: DevProposalRevision[]; revising?: boolean;
  requirementsDecisions?: DevRequirementsDecision[];
  deletion?: DevRequirementDeletion;
  freeze?: { frozenAt: string; frozenBy: string; title: string; snapshotDigest: string; files: DevFileVersion[]; srIds: string[]; dependencies: Record<string, string[]> };
  developmentStartedAt?: string;
  srDependencies?: Record<string, string[]>;
  acceptance?: DevIrAcceptance;
  proposalStage?: "requirements" | "solution";
  proposalRound?: number;
  developerHandoff?: { employeeId: string; submittedAt: string };
  developerAcceptance?: { employeeId: string; acceptedAt: string; round: number };
  requirementSupplements?: { note: string; employeeId: string; createdAt: string; round?: number }[];
  proposalSolution?: { path: string; employeeId: string; generatedAt: string; round: number; valid: boolean; requirementsDigest?: string };
  returnFeedback?: { employeeId: string; returnedAt: string; reason: string };
  proposalLocation?: { projectName: string; employeeId: string; directory: string };
}
export interface DevOperationReceipt {
  operationId: string; commandDigest: string; type: string; status: "running" | "completed" | "failed";
  startedAt: string; completedAt?: string; revision: number; irId?: string; srId?: string;
  steps: { name: string; at: string; detail: string }[]; error?: string; deletion?: DevRequirementDeletion;
}
export interface DevMaterialView extends DevFileVersion {
  projectId: string; irId: string; srId?: string;
  kind: "ir" | "sr" | "solution" | DevStageMaterial["kind"] | "attachment" | "ir-acceptance-report" | "ir-final-pr" | "sr-delivery-package"; stage?: DevWorkflowStage; round?: number;
  valid: boolean; content?: string; error?: string;
}
export interface DevChangedFile extends DevFileVersion, DevObjectRef { status: string }
export interface DevRepositoryDevelopment {
  repositoryId: string; limit: number; activeSrs: DevSystemRequirement[];
  owners: (DevObjectRef & { title: string })[];
}
export interface DevWorkflowView {
  ompWebId?: string;
  version: 1; revision: number; projects: DevProject[]; currentProjectId?: string; releases: DevRelease[];
  groups: DevRequirementGroup[]; drafts: DevRequirementGroup[]; srs: DevSystemRequirement[]; selected?: DevObjectRef;
  materials: DevMaterialView[]; operations: DevOperationReceipt[]; sessions: DevNativeSessionRef[];
  repositoryDevelopment?: DevRepositoryDevelopment;
  repositoryHeads?: Record<string, string>;
  workspace?: { path: string; identity: string };
  running: DevNativeSessionRef[]; changes?: DevChangedFile[]; error?: string;
}
export interface DevCommandBase { operationId: string; expectedRevision: number; projectId?: string; irId?: string; srId?: string }
export type DevWorkflowCommand = DevCommandBase & (
  | { type: "registerProject"; registrationScope: "target-root"; root: string; name: string }
  | { type: "createRelease"; title: string }
  | { type: "setDevelopmentRoot"; projectId: string; root: string }
  | { type: "setSharedProjectRoot"; projectId: string; root: string }
  | { type: "createProposal"; clientDraftId?: string; releaseId: string }
  | { type: "deleteRequirement"; version: 1; projectId: string; irId: string }
  | { type: "submitProposalReview" }
  | { type: "acceptProposal" }
  | { type: "runRequirementsReview" }
  | { type: "generateRequirements"; note: string }
  | { type: "supplementRequirements"; note: string }
  | { type: "generateProposalSolution" }
  | { type: "returnProposal"; reason: string }
  | { type: "confirmProposal"; version: string }
  | { type: "publishProposal"; candidate: string }
  | { type: "markRequirementsPrSubmitted"; url: string; candidate: string }
  | { type: "markCodePrSubmitted"; url: string }
  | { type: "markRequirementsMerged"; candidate: string; defaultBranchFilesConfirmed: boolean }
  | { type: "beginProposalRevision"; reason: string }
  | { type: "recordRequirementsDecision"; reviewId: string; snapshotDigest: string; opinion: string; outcome: DevRequirementsDecision["outcome"]; result: string }
  | { type: "markCodeMerged"; candidate: string; filesConfirmed: boolean }
  | { type: "prepareSrDelivery" }
  | { type: "publishSrDelivery"; candidate: string }
  | { type: "verifySrDelivery"; candidate: string; defaultCommit: string; outcome: "passed" | "implementation-issue" | "git-conflict" | "requirement-conflict" }
  | { type: "resolveSrDeliveryConflict"; note: string; scopeUnchanged: boolean }
  | { type: "simulateSrDefaultBranchUpdate" }
  | { type: "startSr" }
  | { type: "startIrAcceptance" }
  | { type: "generateIrAcceptanceReport"; outcome: "issues" | "passed" }
  | { type: "repairIrAcceptance" }
  | { type: "prepareIrFinalPr" }
  | { type: "restartIrAcceptance" }
  | { type: "simulateIrDefaultBranchUpdate" }
  | { type: "publishIrFinalPr"; candidate: string }
  | { type: "markIrFinalPrSubmitted"; url: string }
  | { type: "verifyIrFinalMerge"; candidate: string; filesConfirmed: boolean }
  | { type: "generateStageMaterials"; stage: DevWorkflowStage; round: number }
  | { type: "approveStage"; stage: DevWorkflowStage; round: number; materialDigest: string }
  | { type: "backStage"; stage: "planning" | "executing"; fromStage: DevWorkflowStage; round: number }
  | { type: "stop" }
);
export type DevAction = DevWorkflowCommand extends infer T ? T extends DevWorkflowCommand ? Omit<T, "operationId" | "expectedRevision"> : never : never;
export interface DevWorkflowResult {
  operationId: string; projectId: string; revision: number; irId?: string; srId?: string;
  status: "completed" | "failed" | "running"; receipt: DevOperationReceipt; view?: DevWorkflowView;
  error?: string; deletion?: DevRequirementDeletion;
}
export interface DevSelection { freeDraftId?: string; proposalDraftId?: string; proposalDraftReleaseId?: string; irAcceptance?: boolean; freeSessionId?: string; freeFiles?: boolean; projectId?: string; irId?: string; srId?: string; stage?: DevWorkflowStage; stageRound?: number; discussionPhase?: "requirements" | "solution" }
export interface DevNativeSurfaceTarget extends DevObjectRef {
  sessionId: string; phase: DevNativeSessionRef["phase"]; round: number; clientId: string;
}
export type DevNativeUiState =
  | { method: "notify"; value: { message: string; type?: "info" | "warning" | "error" } }
  | { method: "setStatus"; value: { key: string; text: string | undefined } }
  | { method: "setWorkingMessage"; value: string | undefined }
  | { method: "setWidget"; value: { key: string; content: string[] | undefined; options?: { placement?: "aboveEditor" | "belowEditor" } } }
  | { method: "setTitle" | "setEditorText" | "pasteToEditor"; value: string }
  | { method: "rerenderMessage"; value: number }
  | { method: "refreshTranscript"; value: readonly string[] }
  | { method: "setToolsExpanded"; value: boolean }
  | { method: "setHeader" | "setFooter"; value: null };
export type DevNativeUiStateEvent = DevNativeUiState & { t: "native-ui-state"; target: DevNativeSurfaceTarget; sequence: number };
export interface DevNativePredictionSnapshot { target: DevNativeSurfaceTarget; generation: number; choices: readonly string[] }
export type DevNativePredictionAction =
  | { type: "cancel" } | { type: "draft"; text: string } | { type: "shown"; generation: number }
  | { type: "accepted"; generation: number; rank: number };
export interface DevPeer {
  id: string; name: string; role: string; status: string; projectId: string;
  materials: { title: string; path: string; content: string }[];
  logs: { id: string; time: string; text: string }[];
}

export interface DevAgentModel {
	id: string;
	name: string;
	nameEn: string;
	description: string;
	descriptionEn: string;
	model: string;
	reasoning: string;
}

export interface DevAgentModelSettings {
	defaultModel: string;
	agents: DevAgentModel[];
}

export type DevAgentRole = "requirements" | "requirements-review" | "solution" | "planning" | "execution" | "ir-acceptance" | "skill-design";
export interface DevAgentModelBinding {
 role: DevAgentRole;
 roleName: string;
 modelKey: string;
 modelName: string;
 providerId: string;
 modelId: string;
 reasoning: string;
 inherited: boolean;
 configurationRevision: number;
}

export interface DevSkillDesignPreview {
  name: string;
  directory: string;
  revision: number;
  files: { path: string; content: string }[];
}

export interface DevSkillDesignDraft {
	goal: string; when: string; inputs: string; outputs: string;
	boundaries: string; references: string; example: string; notes: string[];
}

export type DevPrHandoffScenario = "current" | "missing-directory" | "wrong-repository" | "change-conflict" | "stale-version";
export interface DevPrHandoffFile {
 path: string;
 sourcePath: string;
 targetPath: string;
 version: string;
 digest: string;
}
export interface DevPrHandoff {
 ready: boolean;
 blockers: string[];
 employeeId: string;
 sourceDirectory: string;
 targetDirectory?: string;
 branch: string;
 targetBranch: string;
 changeRoot: string;
 files: DevPrHandoffFile[];
}
export interface DevPrHandoffInput {
 group: DevRequirementGroup;
 project?: DevProject;
 developmentRoot?: string;
 developmentDirectory?: { path: string; repositoryRoot?: string; git: boolean };
 employeeId: string;
 scenario?: DevPrHandoffScenario;
}

export interface DevWorkspace {
 path?: string;
 identity: string;
 kind: "free" | "proposal" | "development" | "reference" | "unavailable";
 error?: string;
 blockedPath?: string;
}
