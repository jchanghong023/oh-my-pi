/** Phase-one frontend presentation contracts. No OMP runtime dependency or execution authority. */
export const DEV_WORKFLOW_VERSION = 1 as const;
export const DEV_WORKFLOW_STAGES = ["solution", "planning", "executing", "pr"] as const;
export type DevWorkflowStage = (typeof DEV_WORKFLOW_STAGES)[number];
export type DevRequirementStatus = "draft" | "reviewing" | "confirmed" | "requirements-pr" | "frozen" | "deleted";
export interface DevObjectRef { projectId: string; irId: string; srId?: string }
export interface DevNativeSessionRef extends DevObjectRef {
  sessionId: string; sessionFile: string; role: "requirements" | "reviewer" | DevWorkflowStage;
  phase: "requirements" | DevWorkflowStage; round: number;
}
export interface DevFileVersion { path: string; sha256: string; size: number }
export interface DevProject {
  id: string; name: string; root: string; commonDir: string; revision: number;
  createdAt: string; updatedAt: string; defaultBranch: string; remote?: string; repositoryId: string;
}
export interface DevRelease { id: string; projectId: string; title: string; createdAt: string }
export interface DevWorktree { path: string; branch: string; baseCommit: string }
export interface DevReview {
  id: string; snapshotDigest: string; passed: boolean; report: string;
  reviewer: DevNativeSessionRef | { sessionId: string; role: "reviewer"; sourceProjectId: string; imported: true }; createdAt: string;
}
export interface DevConfirmation { operationId: string; snapshotDigest: string; confirmedAt: string }
export interface DevRequirementSnapshot {
  version: 1; projectId: string; irId: string; title: string;
  srs: { id: string; title: string; documentPath: string }[]; documentPath: string; files: DevFileVersion[]; digest: string;
}
export interface DevPrFact { url: string; sourceBranch: string; targetBranch: string; recordedAt: string; platformVerified: false }
export interface DevMergeFact { commit: string; branch: string; checkedAt: string; files: DevFileVersion[] }
export interface DevRequirementDeletion { version: 1; operationId: string; deletedAt: string; manualCloseNeeded: boolean; requirementsPrUrl?: string }
export interface DevStageApproval { stage: DevWorkflowStage; round: number; operationId: string; digest: string; files: DevFileVersion[]; approvedAt: string }
export interface DevStageMaterial extends DevFileVersion {
  stage: DevWorkflowStage; kind: "solution" | "plan" | "completion" | "ut" | "st" | "delivery"; round: number; valid: boolean;
}
export interface DevSystemRequirement {
  id: string; projectId: string; irId: string; title: string; documentPath: string;
  status: "pending" | "developing" | "completed"; stage?: DevWorkflowStage; round: number;
  worktree?: DevWorktree; sessions: DevNativeSessionRef[]; approvals: DevStageApproval[];
  materials: DevStageMaterial[]; materialDigest?: string; codePr?: DevPrFact; codeMerge?: DevMergeFact;
}
export interface DevRequirementGroup {
  id: string; projectId: string; releaseId: string; title: string; documentPath: string;
  origin: "local" | "browser" | "import"; status: DevRequirementStatus; revision: number; srIds: string[];
  files: DevFileVersion[]; evidenceFiles?: DevFileVersion[]; retiredFiles?: DevFileVersion[]; worktree?: DevWorktree;
  sessions: DevNativeSessionRef[]; snapshot?: DevRequirementSnapshot; confirmation?: DevConfirmation; review?: DevReview;
  requirementsPr?: DevPrFact; merge?: DevMergeFact; packageId?: string; packageDigest?: string; createdAt: string;
  deletion?: DevRequirementDeletion;
}
export interface DevOperationReceipt {
  operationId: string; commandDigest: string; type: string; status: "running" | "completed" | "failed";
  startedAt: string; completedAt?: string; revision: number; irId?: string; srId?: string;
  steps: { name: string; at: string; detail: string }[]; error?: string; deletion?: DevRequirementDeletion;
}
export interface DevMaterialView extends DevFileVersion {
  projectId: string; irId: string; srId?: string;
  kind: "ir" | "sr" | DevStageMaterial["kind"] | "attachment"; stage?: DevWorkflowStage;
  valid: boolean; content?: string; error?: string;
}
export interface DevChangedFile extends DevFileVersion, DevObjectRef { status: string }
export interface DevWorkflowView {
  version: 1; revision: number; projects: DevProject[]; currentProjectId?: string; releases: DevRelease[];
  groups: DevRequirementGroup[]; drafts: DevRequirementGroup[]; srs: DevSystemRequirement[]; selected?: DevObjectRef;
  materials: DevMaterialView[]; operations: DevOperationReceipt[]; sessions: DevNativeSessionRef[];
  activeSrId?: string; running: DevNativeSessionRef[]; changes?: DevChangedFile[]; error?: string;
}
export interface DevCommandBase { operationId: string; expectedRevision: number; projectId?: string; irId?: string; srId?: string }
export type DevWorkflowCommand = DevCommandBase & (
  | { type: "registerProject"; registrationScope: "target-root"; root: string; name: string }
  | { type: "createRelease"; title: string }
  | { type: "createLocalDraft" | "createBrowserDraft"; releaseId: string }
  | { type: "importPackage"; releaseId: string; packageId: string }
  | { type: "deleteRequirement"; version: 1; projectId: string; irId: string }
  | { type: "confirmRequirements"; snapshotDigest: string }
  | { type: "markRequirementsPrSubmitted" | "markCodePrSubmitted"; url: string }
  | { type: "markRequirementsMerged" | "markCodeMerged" }
  | { type: "startSr" }
  | { type: "approveStage"; stage: DevWorkflowStage; round: number; materialDigest: string }
  | { type: "backStage"; stage: "solution" | "planning" | "executing" }
  | { type: "stop" }
  | { type: "publishMaterials"; scope: "requirements" | "development"; paths: string[]; versions?: DevFileVersion[]; message: string; push: boolean }
);
export type DevAction = DevWorkflowCommand extends infer T ? T extends DevWorkflowCommand ? Omit<T, "operationId" | "expectedRevision"> : never : never;
export interface DevWorkflowResult {
  operationId: string; projectId: string; revision: number; irId?: string; srId?: string;
  status: "completed" | "failed" | "running"; receipt: DevOperationReceipt; view?: DevWorkflowView;
  error?: string; deletion?: DevRequirementDeletion;
}
export interface DevSelection { projectId?: string; irId?: string; srId?: string; stage?: DevWorkflowStage }
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
export interface PrototypePeer {
  id: string; name: string; role: string; status: string; projectId: string;
  materials: { title: string; path: string; content: string }[];
  logs: { id: string; time: string; text: string }[];
}
