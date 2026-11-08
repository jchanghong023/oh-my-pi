import type { IServiceAccessor } from "@zcode/services";
import type { AppSettings, WebRemoteControlWorkspaceListResult } from "@zcode/shared";
import type { WebRemoteControlWorkspaceSwitcherApi } from "../packages/ui/src/root/types.js";

export const previewWorkspacePath = "/preview/interface-only";
export const previewProjectId = "interface-preview";
export const previewUnavailableMessage = "仅界面预览，未连接 OMP：此功能不可用。";

export function rejectPreviewAction(action: string): never {
  const message = `${previewUnavailableMessage} (${action})`;
  const status = document.getElementById("preview-status");
  if (status) {
    status.textContent = message;
    status.title = message;
  }
  throw new Error(message);
}

// Only display reads are admitted. Unknown commands cannot pretend that a backend action succeeded.
const emptyEvent = () => ({ dispose() {} });
type DisplayMethod = (...args: any[]) => unknown;
function displayService<K extends keyof IServiceAccessor>(
  name: K,
  reads: Record<string, DisplayMethod> = {},
): NonNullable<IServiceAccessor[K]> {
  return new Proxy(reads, {
    get(target, property) {
      if (typeof property !== "string" || property === "then") return undefined;
      if (Object.hasOwn(target, property)) return target[property];
      // Match the source service contract: onDynamicX(params) returns an Event;
      // onX itself is an Event. These events never claim a remote connection exists.
      if (/^onDynamic[A-Z]/.test(property)) return () => emptyEvent;
      if (/^on[A-Z]/.test(property)) return emptyEvent;
      return async () => rejectPreviewAction(`${name}.${property}`);
    },
  }) as NonNullable<IServiceAccessor[K]>;
}

const settings: AppSettings = {
  locale: "zh-CN",
  theme: "zai-light",
  recentProjects: [],
  onboardingOccupation: "other",
  providerFamilyDomainMigrated: true,
};
const emptyProviderView = { revision: 0, providers: [] };
// Same project/readTree data contract as remote-task-open.mjs, without fabricated tasks.
const previewProject = {
  id: previewProjectId,
  hostId: "local",
  name: "界面预览（无真实目录）",
  roots: [{ rootPath: previewWorkspacePath, position: 0, isPrimary: true }],
  nameOverridden: true,
  pinned: false,
  deleted: false,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
};
const emptyGitSummary = (workspacePath = previewWorkspacePath) => ({
  workspacePath,
  repoRoot: workspacePath,
  workspaceInRepoPath: ".",
  autoRefreshWatchPaths: [],
  branchName: null,
  trackingBranchName: null,
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: false,
  isGitAvailable: false,
  isRepository: false,
});
const unavailableWorkspace = (params: { workspacePath?: string; workspaceIdentity?: string } = {}) => ({
  available: false,
  workspaceKey: params.workspaceIdentity || params.workspacePath || previewWorkspacePath,
  reason: previewUnavailableMessage,
});

// Fixed presentation data, not a ZCode/OMP service implementation. No RPC, account,
// relay, filesystem, HTTP or model client is created by this preview adapter.
export const previewServices: IServiceAccessor = {
  projectService: displayService("projectService", {
    readTree: async (params) => ({
      projects: !params?.hostId || params.hostId === "local" ? [previewProject] : [],
      tasks: [],
    }),
    getProject: async () => previewProject,
  }),
  remoteProjectService: displayService("remoteProjectService", {
    readDirectory: async () => ({ hosts: [], entries: [] }),
  }),
  taskGroupService: displayService("taskGroupService", {
    read: async () => ({ groups: [], members: [], order: [] }),
  }),
  fileService: displayService("fileService", {
    readdir: async () => [],
    checkFilesExist: async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({ path, exists: false })),
    searchWorkspaceFiles: async () => [],
    listWorkspaceFilesLength: async () => 0,
    listWorkspaceFilesRange: async () => "",
  }),
  gitService: displayService("gitService", {
    getRepositorySummary: async (params) => emptyGitSummary(params?.workspacePath),
    getWorkspaceSummary: async (params) => emptyGitSummary(params?.workspacePath),
    getWorkspaceRepositoryInfo: async () => ({ repositories: [] }),
    getLocalBranches: async () => ({ branches: [], currentBranch: null }),
    getChanges: async () => [],
    getIgnoredPaths: async () => [],
    getDiff: async () => ({ sections: [], files: [] }),
    getBranchComparison: async () => ({ baseRef: null, headRef: null, comparisonLabel: null, changes: [] }),
    getIdentity: async () => ({ userName: null, userEmail: null, nameSource: null, emailSource: null, scopeLabel: null }),
  }),
  gitCheckpointService: displayService("gitCheckpointService"),
  systemService: displayService("systemService"),
  terminalService: displayService("terminalService"),
  settingService: displayService("settingService", { get: async () => settings }),
  credentialService: displayService("credentialService", { load: async () => null }),
  broadcastService: displayService("broadcastService"),
  zcodeTaskService: displayService("zcodeTaskService", {
    initialize: async () => unavailableWorkspace(),
    releaseWorkspacePreparation: async () => undefined,
    listTasks: async () => [],
    listPinnedTaskIds: async () => [],
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
    listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
    getTaskMeta: async () => null,
    getTaskSnapshot: async () => null,
    getTaskSnapshotWithEtag: async () => ({ snapshot: null }),
    getTaskSnapshotBody: async () => null,
    getTaskSnapshotRef: async () => null,
  }),
  zcodeAgentService: displayService("zcodeAgentService", {
    initialize: async (params) => unavailableWorkspace(params),
    disposeAll: () => undefined,
    getMcpServers: async () => [],
    getCustomAgents: async () => [],
    getCommands: async () => [],
    getSkills: async () => [],
    getBuiltinCommands: async () => [],
  }),
  zcodeSessionService: displayService("zcodeSessionService", {
    initializeWorkspace: async (params) => unavailableWorkspace(params),
  }),
  conversationShareService: displayService("conversationShareService"),
  botsService: displayService("botsService"),
  fileWatcherService: displayService("fileWatcherService", {
    watch: async () => ({ dispose() {} }),
  }),
  oauthService: displayService("oauthService", {
    getProviders: async () => [],
    getActiveProvider: async () => null,
    restoreCachedSession: async () => null,
    restoreCachedSessionState: async () => ({ status: "signed-out" }),
    restoreSession: async () => null,
  }),
  providerSettingsService: displayService("providerSettingsService", {
    getView: async () => emptyProviderView,
    refresh: async () => emptyProviderView,
  }),
  modelSelectionService: displayService("modelSelectionService", {
    getView: async () => emptyProviderView,
  }),
  sourceServerWorkspaceService: displayService("sourceServerWorkspaceService"),
  usageStatsService: displayService("usageStatsService"),
  codingPlanSubscriptionService: displayService("codingPlanSubscriptionService"),
  clientConfigService: displayService("clientConfigService", {
    getSnapshot: async () => ({ pluginStoreOrder: null, zsrcUrl: null, uiPluginRecommendations: [] }),
  }),
  clientScenesService: displayService("clientScenesService", {
    list: async () => ({ code: 0, msg: "", data: [] }),
  }),
  offPeakTaskService: displayService("offPeakTaskService"),
  highspeedCardService: displayService("highspeedCardService"),
  skillsService: displayService("skillsService", {
    list: async () => ({ skills: [], capability: { userScopeAvailable: false, userScopeReason: "desktop_only" }, diagnostics: [] }),
  }),
  skillSyncService: displayService("skillSyncService"),
  mcpSyncService: displayService("mcpSyncService"),
  pluginSyncService: displayService("pluginSyncService"),
  userConfigSyncService: displayService("userConfigSyncService"),
  pluginsService: displayService("pluginsService", { list: async () => [] }),
  pluginManagementService: displayService("pluginManagementService"),
  subagentsService: displayService("subagentsService", {
    list: async () => ({ agents: [], capability: { supported: false } }),
  }),
  commandsService: displayService("commandsService", {
    list: async () => ({ commands: [], userCommands: [], pluginCommands: [], capability: { userScopeAvailable: false, userScopeReason: "desktop_only" } }),
  }),
  hooksService: displayService("hooksService", {
    loadHooks: async () => ({ hooks: [], hooksEnabled: false }),
  }),
  memoryService: displayService("memoryService", {
    loadMemory: async () => ({ memory: null }),
    listProjectMemories: async () => [],
  }),
  outputStyleService: displayService("outputStyleService", {
    listStyles: async () => ({ styles: [] }),
    getUserStylesDirectory: async () => ({ path: "" }),
  }),
  settingsSyncService: displayService("settingsSyncService", {
    getFirstRunPromptState: async () => ({ handled: true }),
    shouldOnboard: async () => null,
  }),
  feedbackService: displayService("feedbackService"),
  promptAttachmentTransferService: displayService("promptAttachmentTransferService"),
};

const workspaceList: WebRemoteControlWorkspaceListResult = {
  workspaces: [{ workspacePath: previewWorkspacePath, kind: "local", label: "界面预览（无真实目录）" }],
};

export const previewWorkspaceSwitcher: WebRemoteControlWorkspaceSwitcherApi = {
  deviceNavigation: {
    deviceName: "界面预览 · 未连接设备",
    chooseOtherDevice() {
      window.alert(previewUnavailableMessage);
    },
  },
  listWorkspaces: async () => workspaceList,
  switchWorkspace: async () => rejectPreviewAction("switchWorkspace"),
  openProjectDraft: async () => rejectPreviewAction("openProjectDraft"),
  reconnectWorkspace: async () => rejectPreviewAction("reconnectWorkspace"),
  startDraft: async () => rejectPreviewAction("startDraft"),
};
