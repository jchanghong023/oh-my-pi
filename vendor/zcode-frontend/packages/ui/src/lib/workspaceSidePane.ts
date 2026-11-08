/* eslint-disable max-lines -- Side pane tab 状态集中维护文件、Git 和对话工作流面板。 */
import { createUuid } from "@zcode/shared";
import { inferMediaPreview, isPptxPreviewPath, type CodeViewerSource } from "@/lib/codeViewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";


export interface GitSidePaneTab {
  id: "git";
  type: "git";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface FileManagerTarget {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}

export interface FileManagerSidePaneTab {
  id: string;
  type: "file-manager";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  target: FileManagerTarget;
  source: CodeViewerSource | null;
}

export interface CodeViewerSidePaneTab {
  id: string;
  type: "code-viewer";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source: CodeViewerSource;
  sourceKey: string | null;
}

export type TreemappingSidePaneSource =
  | { kind: "current" }
  | { kind: "message"; messageId: string; turnIndex?: number };

export interface TreemappingSidePaneTab {
  id: "treemapping";
  type: "treemapping";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source?: TreemappingSidePaneSource;
}

export interface WhiteboardSidePaneTab {
  id: string;
  type: "whiteboard";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  boardId: string;
  openedAt?: number;
  title: string;
}

export interface ModelTrajectorySidePaneTab {
  id: string;
  type: "model-trajectory";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  /** 目标 task/session id；model-io 按该 id 匹配。 */
  taskId: string;
  title?: string | null;
}


export interface DeveloperToolsSidePaneTab {
  id: "developer-tools";
  type: "developer-tools";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}



export interface OpenBackgroundBashSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  sessionId: string;
  workId: string;
  title: string;
}

export interface BackgroundBashSidePaneTab extends OpenBackgroundBashSideTabRequest {
  id: string;
  type: "bash-output";
  workspaceKey: string;
  ownerTaskId: string;
  openedAt?: number;
}

export interface SubagentSessionSidePaneTab {
  id: string;
  type: "subagent-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface SubagentDirectorySidePaneTab {
  id: string;
  type: "subagent-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
}

export interface SelectionSideChatPaneTab {
  id: string;
  type: "selection-side-chat";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  ordinal: number;
}

export interface PlanDetailSidePaneTab {
  id: string;
  type: "plan-detail";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

export interface OpenPlanDetailSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

/**
 * workflow run 的详情页 tab。
 *
 * 身份是 **run**（`runId`），不是发起它的工具调用：一次 CreateWorkflow 只启一个 run，
 * 但 run 才是引擎、journal 与 `cancelBackgroundWork {workId}` 三处共用的键
 * （`workId ≡ taskId ≡ runId`）。`toolCallId` 仍要带上——静态因果图在那条工具调用行的
 * display 里，详情页按它在父会话投影里找图。
 *
 * ## 这个 tab 刻意**没有 GC**，别加
 *
 * 看起来很自然的两条回收规则都是错的：
 *
 * - **run 被 `WORKFLOW_RUNS_LIMITS.maxRuns`（8 条）淘汰时不要关它。** 详情页的事件日志读的是
 *   **journal**，不是 `workflowRuns` 投影。被淘汰的 run 丢的只有实时叠加状态，它的事件日志
 *   仍然**完整**——那恰恰是用户会把这个 tab 留着的场景（回看一次已结束的 run 是怎么跑的）。
 *   自动关掉等于亲手销毁一次已完结 run 的唯一持久视图。淘汰只降级成详情页里那块
 *   「已不在实时跟踪范围内」的空态，措辞也必须诚实：丢的是实时状态，run 本身没有消失。
 * - **父会话 edit / retry 时不要关它。** run 身份不会因为对话被改写而失效，最多是那条工具
 *   调用行不在窗口里了——那同样只降级成"没有图可画"，不是"这个 tab 该消失"。
 *
 * 可见性已经按 `parentSessionId` 收窄（同 plan-detail），所以 tab 不会泄漏到别的对话里。
 * `syncSubagentSessionSidePaneTabs` 那套回收只作用于 subagent-session，不要把它扩过来。
 */
export interface WorkflowRunSidePaneTab {
  id: string;
  type: "workflow-run";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  /** 打开时冻结的展示名，仅作投影缺席（run 被淘汰 / 冷启动）时的标题兜底。 */
  workflowName?: string;
  /** 落点：展开这一站、列出全部、节头滚到顶。缺席即停在原处。 */
  focusPhaseId?: string;
}

export interface OpenWorkflowRunSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  /** 落点：详情页展开这一站、列出全部、滚到节头。缺席即停在原处。 */
  phaseId?: string;
  /**
   * 「配置」之后面板跟着工作流走：
   * 把显示这个 run 的 tab **原地**换成新 run 的 tab——同一个位置、沿用它的名字与归属。没有这样的
   * tab（已关掉）就什么都不做：面板不会为此重新打开。
   */
  replaceRunId?: string;
}

/**
 * 一条对话的 workflow run 目录 tab。
 *
 * 身份是**对话**（`parentSessionId`）：一条对话只有一份 run 目录，所以页脚行重复点击幂等地
 * 聚焦同一个 tab——与 `subagent-directory` 同构。
 *
 * 这个 tab 不带任何 run 数据：目录页自己按 `parentSessionId` 读一页 journal（run 目录的
 * 单一信源）。把摘要冻进 tab 会让「重启后打开一个恢复出来的 tab」显示
 * 一份过期名单，而它恰恰就是为重启后那一刻存在的。
 */
export interface WorkflowRunDirectorySidePaneTab {
  id: string;
  type: "workflow-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}

export interface OpenWorkflowRunDirectorySideTabRequest {
  parentSessionId: string;
}

/**
 * 一个 dwf actor 实例的 transcript tab。
 *
 * 身份是 **actor 会话**：一个实例一条真实持久会话，所以 `actorSessionId` 就是 tab 身份。
 * `runId` / `siteId` / `ordinal` 一起带上是为了标题、搜索与排查——它们是 journal 的键，
 * 而会话 id 是 run service 按 `(runId, actorRef)` 铸造出来的，不该被 renderer 反解。
 *
 * ## 为什么是**独立类型**，不是给 `subagent-session` 加一个变体标记
 *
 * `syncSubagentSessionSidePaneTabs` 会删掉 `childSessionId` 不在 `validChildSessionIds`
 * 里的 subagent tab，而 actor 会话**永远不在**那个集合里（它不是子智能体的子会话）。复用
 * 那个类型等于：父会话的 subagent 投影每更新一次，这个 tab 就被回收一次。修法只能是教那套
 * 回收认识变体标记，也就是同样的工作量，只是把不变式藏进了回收逻辑里。
 *
 * 另外两处也会打架：subagent tab 的可见性按 `rootSessionId` 收窄（actor tab 要按
 * `parentSessionId`，同 workflow-run），而 `lastActiveSubagentTabByRootRef` 按
 * `rootSessionId` 记忆 active tab——actor tab 没有、也不该有一个 root 会话。
 *
 * ## GC：同 `workflow-run`，**没有**，别加
 *
 * actor 会话在 run 结束后继续存在（这正是持久化落库换来的durable-audit）。run 被 8-run
 * 上限淘汰、父会话 edit/retry、run 结算——三者都不该关掉一份仍然可读的 transcript。
 * 可见性已按 `parentSessionId` 收窄，所以它也不会泄漏到别的对话里。
 */
export interface WorkflowActorSessionSidePaneTab {
  id: string;
  type: "workflow-actor-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /**
   * actor 会话 id：嵌套只读 SessionPane 读的那条会话。**可缺席**——从一枚还没启动的药丸开的
   * tab 打开时没有会话；面板按
   * 槽位在实时投影里找它，找到即自愈。身份不在这里，在 (runId, siteId, ordinal)。
   */
  actorSessionId?: string;
  /** actor 站点 id 与序号：与 runId 一起是 tab 的身份，从不参与命名。 */
  siteId: string;
  ordinal: number;
  /** 脚本里写下的名字（`agent("reviewer")`）；分析拿不到字面量时缺席，标题走本地化兜底。 */
  actorName?: string;
}

export interface OpenWorkflowActorSessionSideTabRequest {
  parentSessionId: string;
  runId: string;
  /** 打开时已知的会话 id；未启动的槽位缺席。 */
  actorSessionId?: string;
  siteId: string;
  ordinal: number;
  actorName?: string;
}

export interface OpenScopedWorkflowActorSessionSideTabRequest extends OpenWorkflowActorSessionSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * 一个 workflow run 的**脚本 transcript** tab：
 * 脚本里 `files.*` / `git.*` / `world.run` 的每一次调用回放成一张工具卡。
 *
 * 与 actor transcript 同一逻辑层级（都是「run 里某个参与者做过什么」），但工作区没有会话，
 * 所以它是自己的类型而不是 actor tab 的变体：面板不嵌 SessionPane，而是拿两条 journal 查询
 * 自己画卡片。身份是 **(workspace, 父会话, run)**——一个 run 一个 tab，从哪一站点开都是它；
 * `focusPhaseId` 只是落点（滚到那一站的第一张卡），每次打开都重新落。
 *
 * GC：同 `workflow-actor-session`，**没有**——journal 行在 run 结束后继续存在，这份回放正是
 * 为事后审计而存在的。可见性按 `parentSessionId` 收窄。
 */
export interface WorkflowWorkspaceSidePaneTab {
  id: string;
  type: "workflow-workspace";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  /** 发起该 run 的工具调用 id：静态图（阶段名、步标签）挂在那条行上，与 workflow-run tab 同一条路。 */
  toolCallId: string;
  runId: string;
  /** 打开时冻结的展示名，仅作投影缺席时的标题兜底。 */
  workflowName?: string;
  /** 落点：滚到这一站的第一张卡；还没到的站落到末尾。缺席即停在原处。 */
  focusPhaseId?: string;
}

export interface OpenWorkflowWorkspaceSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  phaseId?: string;
}

export interface OpenScopedWorkflowWorkspaceSideTabRequest extends OpenWorkflowWorkspaceSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * 一个 dwf **产物**的全尺寸查看 tab。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出（一个文件 / 一段 markdown /
 * 一张 journal 投影出来的看板），**不是**引擎内部 `RunSettlement.artifact` 那个「脚本顶层
 * 返回值」。
 *
 * 身份是 **(run, 产物 id)**，不含版本：同一个产物反复发布是同一件东西的新版本，再点一次
 * 应当**聚焦已开的 tab 并翻到最新版**，而不是并排开出 v1 / v2 两个 tab。`version` 因此只是
 * 打开时的初始落点（通知 chip / 中枢 chip 都不带版本号，缺席即最新版），头部的版本步进器
 * 才是真正的版本导航。
 *
 * ## GC：同 `workflow-run`，**没有**，别加
 *
 * 产物的字节在发布时刻就拷进了 store（发布即钉住的约定），所以一个被 8-run 上限
 * 淘汰、甚至整条对话被 edit 重写的 run，它的产物仍然**完整可读**——那正是用户会把这个 tab
 * 留着的场景。可见性已按 `parentSessionId` 收窄，tab 不会泄漏到别的对话里。
 */
export interface WorkflowArtifactSidePaneTab {
  id: string;
  type: "workflow-artifact";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /** 产物 id（脚本里的编译期字面量，`[A-Za-z0-9_.-]` ≤ 64）。 */
  artifactId: string;
  /** 打开时的初始版本；缺席即最新版。**不进 tab 身份**——见类型上那段注释。 */
  version?: number;
  /** 打开时冻结的展示名，仅作元数据缺席（冷恢复 / 老 CLI）时的标题兜底。 */
  title?: string;
}

export interface OpenWorkflowArtifactSideTabRequest {
  parentSessionId: string;
  runId: string;
  artifactId: string;
  version?: number;
  title?: string;
  /**
   * 最新版的 contentType（表面上的摘要带得到就带）。`useAppPanels.handleOpenWorkflowArtifact`
   * 据它决定 html 产物是直接开浏览器 tab 还是开产物 tab；缺席即一律开产物 tab。
   */
  contentType?: string;
  /**
   * 工作区相对的原路径。只有已经合并过 journal 的表面（run 侧板）带得到；缺席时由
   * `handleOpenWorkflowArtifact` 自己查 journal 补齐——摘要刻意不带它（状态帧体积）。
   */
  sourcePath?: string;
}

export interface OpenScopedWorkflowArtifactSideTabRequest extends OpenWorkflowArtifactSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunSideTabRequest extends OpenWorkflowRunSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunDirectorySideTabRequest extends OpenWorkflowRunDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedPlanDetailSideTabRequest extends OpenPlanDetailSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenSelectionSideChatRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  /** active child 已确定不存在时，由宿主原子替换对应旧 tab。 */
  replacesChildSessionId?: string;
}

export interface OpenSubagentSideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface OpenSubagentDirectorySideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
}

export interface OpenScopedSubagentDirectorySideTabRequest extends OpenSubagentDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface SyncSubagentSessionTabsRequest {
  rootSessionId: string;
  parentSessionId: string;
  validChildSessionIds: readonly string[];
}

export interface OpenScopedSubagentSideTabRequest extends OpenSubagentSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface NewTabSidePaneTab {
  id: string;
  type: "new-tab";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export type WorkspaceSidePaneTab =
  | FileManagerSidePaneTab
  | NewTabSidePaneTab
  | BackgroundBashSidePaneTab
  | GitSidePaneTab
  | CodeViewerSidePaneTab
  | TreemappingSidePaneTab
  | WhiteboardSidePaneTab
  | ModelTrajectorySidePaneTab
  | DeveloperToolsSidePaneTab
  | SubagentSessionSidePaneTab
  | SubagentDirectorySidePaneTab
  | SelectionSideChatPaneTab
  | PlanDetailSidePaneTab
  | WorkflowRunSidePaneTab
  | WorkflowRunDirectorySidePaneTab
  | WorkflowActorSessionSidePaneTab
  | WorkflowWorkspaceSidePaneTab
  | WorkflowArtifactSidePaneTab;

/** 后台命令输出需要在面板折叠时继续接收结果。 */
export function shouldMountSidePaneContent(
  isVisible: boolean,
  tabs: readonly WorkspaceSidePaneTab[],
): boolean {
  return isVisible || tabs.some((tab) => tab.type === "bash-output");
}


export interface WorkspaceSidePaneState {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
}

export function normalizeWorkspaceSidePaneState(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  // 已移除的界面不从旧版面板记忆恢复。
  const filteredTabs = current.tabs.filter(
    (tab) =>
      !["treemapping", "terminal", "deploy", "browser", "browser-use", "browser-permissions", "plugin-market", "plugin-ui", "workspace-plugin-preview"].includes(
        tab.type,
      ),
  );
  if (filteredTabs.length === 0) {
    return null;
  }

  // 多开引入 `ordinal` 之前创建的辅助对话 tab（HMR/同窗口旧内存状态）没有该
  // 字段，直接参与 getNextSelectionSideChatOrdinal 会得到 NaN/undefined 并造成标题
  // 编号冲突。这里在状态边界按 parent 分组回填最小可用编号，保持既有编号不变。
  let migratedOrdinal = false;
  const tabs = filteredTabs.map((tab, index, allTabs) => {
    if (tab.type !== "selection-side-chat" || Number.isInteger(tab.ordinal)) {
      return tab;
    }
    // allTabs 中本轮迭代已回填的 tab 被原位替换，天然带整数 ordinal 参与占用判定。
    const used = new Set(
      allTabs.flatMap((candidate) =>
        candidate.type === "selection-side-chat" &&
        candidate.workspaceKey === tab.workspaceKey &&
        candidate.parentSessionId === tab.parentSessionId &&
        Number.isInteger(candidate.ordinal)
          ? [candidate.ordinal]
          : [],
      ),
    );
    let ordinal = 1;
    while (used.has(ordinal)) ordinal += 1;
    migratedOrdinal = true;
    const migrated: SelectionSideChatPaneTab = { ...tab, ordinal };
    allTabs[index] = migrated;
    return migrated;
  });

  const activeTabId =
    current.activeTabId === "" || tabs.some((tab) => tab.id === current.activeTabId)
      ? current.activeTabId
      : tabs[tabs.length - 1]!.id;
  if (
    !migratedOrdinal &&
    tabs.length === current.tabs.length &&
    activeTabId === current.activeTabId
  ) {
    return current;
  }

  return {
    tabs,
    activeTabId,
  };
}



function createGitSidePaneTab(): GitSidePaneTab {
  return { id: "git", type: "git", openedAt: Date.now() };
}

function createTreemappingSidePaneTab(
  source: TreemappingSidePaneSource = { kind: "current" },
): TreemappingSidePaneTab {
  return {
    id: "treemapping",
    type: "treemapping",
    openedAt: Date.now(),
    source,
  };
}

function createModelTrajectorySidePaneTab(options: {
  taskId: string;
  title?: string | null;
}): ModelTrajectorySidePaneTab {
  return {
    // 同一个 task 复用同一个 tab，避免重复打开多份相同轨迹。
    id: `model-trajectory:${options.taskId}`,
    type: "model-trajectory",
    openedAt: Date.now(),
    taskId: options.taskId,
    title: options.title ?? null,
  };
}

function createDeveloperToolsSidePaneTab(): DeveloperToolsSidePaneTab {
  return {
    id: "developer-tools",
    type: "developer-tools",
    openedAt: Date.now(),
  };
}


export function encodeSidePaneTabIdPart(value: string): string {
  return encodeURIComponent(value);
}

export function createSubagentSessionSidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}): SubagentSessionSidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "subagent-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    subagentType: options.subagentType,
    title: options.title.trim(),
  };
}

export function createSubagentDirectorySidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
}): SubagentDirectorySidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "subagent-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
  };
}

export function createSelectionSideChatPaneTab(
  options: OpenSelectionSideChatRequest & {
    workspaceKey: string;
    ordinal: number;
  },
): SelectionSideChatPaneTab {
  return {
    id: [
      "selection-side-chat",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "selection-side-chat",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    ordinal: options.ordinal,
  };
}

export function createPlanDetailSidePaneTab(
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): PlanDetailSidePaneTab {
  return {
    id: [
      "plan-detail",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.toolCallId),
    ].join(":"),
    type: "plan-detail",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    markdown: options.markdown,
    ...(options.planFilePath ? { planFilePath: options.planFilePath } : {}),
  };
}

function createWorkflowRunSidePaneTab(
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkflowRunSidePaneTab {
  return {
    // 结构化 id：同一个 run 在同一个 workspace + 会话下永远是同一个 tab，重复点击幂等。
    id: [
      "workflow-run",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-run",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

function createWorkflowRunDirectorySidePaneTab(
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkflowRunDirectorySidePaneTab {
  return {
    // 结构化 id：一条对话只有一份 run 目录，所以页脚行重复点击幂等地聚焦同一个 tab。
    id: [
      "workflow-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "workflow-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
  };
}

function createWorkflowActorSessionSidePaneTab(
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkflowActorSessionSidePaneTab {
  return {
    // 结构化 id：同一个槽位在同一个 workspace + 对话下永远是同一个 tab，重复点击幂等。
    // 身份是 (runId, siteId@ordinal) 而不是会话 id：tab 可以在会话存在之前就开（未启动的
    // 药丸），先后从无会话与有会话两端打开必须落到同一个 tab；runId 在 id 里，两个 run 的
    // 同名实例仍不撞。
    id: [
      "workflow-actor-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(`${options.siteId}@${options.ordinal}`),
    ].join(":"),
    type: "workflow-actor-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    ...(options.actorSessionId ? { actorSessionId: options.actorSessionId } : {}),
    siteId: options.siteId,
    ordinal: options.ordinal,
    ...(options.actorName ? { actorName: options.actorName } : {}),
  };
}

function createWorkflowWorkspaceSidePaneTab(
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkflowWorkspaceSidePaneTab {
  return {
    // 结构化 id：(workspace, 父会话, run)。阶段**不在** id 里——一个 run 一份脚本 transcript，
    // 从 plan 站点开还是从 verify 站点开都是同一个 tab，只是落点不同。
    id: [
      "workflow-workspace",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-workspace",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

function createWorkflowArtifactSidePaneTab(
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkflowArtifactSidePaneTab {
  return {
    // 结构化 id：**不含版本**。同一个产物的 v1 与 v2 是同一件东西的两个时刻，再次点击
    // （通知 chip / 中枢 chip / 侧板卡片）只该聚焦同一个 tab 并翻到新版，不该并排开两个。
    id: [
      "workflow-artifact",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(options.artifactId),
    ].join(":"),
    type: "workflow-artifact",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    artifactId: options.artifactId,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.title ? { title: options.title } : {}),
  };
}

function createWhiteboardSidePaneTab(options: {
  boardId: string;
  title: string;
}): WhiteboardSidePaneTab {
  return {
    id: `whiteboard:${options.boardId}`,
    type: "whiteboard",
    boardId: options.boardId,
    openedAt: Date.now(),
    title: options.title,
  };
}

function getCodeViewerTabSourceKey(source: CodeViewerSource): string | null {
  const workspaceScope = source.workspaceIdentity?.trim()
    ? source.workspaceIdentity.trim()
    : (source.workspacePath ?? "");
  const scopedKeyPrefix = workspaceScope ? `${workspaceScope}:` : "";
  // 文件树把 PPTX 表示为通用 `file` source，引用反向打开则使用带导航意图的
  // `pptx` source。旧 key 直接包含 source.type，导致同一 workspace 路径被拆成两个 tab。
  // source type 只是入口表示，不是文件身份；这里只归一 PPTX，避免扩大其它预览类型的语义。
  const resourceType =
    source.type === "pptx" || (source.type === "file" && isPptxPreviewPath(source.path))
      ? "pptx"
      : source.type === "media" || (source.type === "file" && inferMediaPreview(source.path))
        ? "media"
        : source.type;

  if (
    source.type === "file" ||
    source.type === "code-review" ||
    source.type === "image" ||
    source.type === "media" ||
    source.type === "pdf" ||
    source.type === "pptx"
  ) {
    return `${scopedKeyPrefix}${resourceType}:${source.path}`;
  }

  if (source.type === "text" && source.path) {
    return `${scopedKeyPrefix}${source.type}:${source.path}`;
  }

  if (source.type === "patch") {
    // file diff 之前只按 path 复用 tab，导致同一个文件在不同轮次产生的不同 patch
    // 会互相覆盖，看起来像“diff 面板只能打开一个 tab”。这里把 patch 内容摘要纳入 key，
    // 让不同 diff 可以并排保留，同时同一份 diff 重复点击仍然复用已有 tab。
    return `${scopedKeyPrefix}patch:${source.path ?? source.title}:${hashCodeViewerContent(source.patch)}`;
  }

  if (source.type === "multi-file-diff") {
    return `${scopedKeyPrefix}multi-file-diff:${source.path ?? source.title}:${hashCodeViewerContent(`${source.beforeContent}\0${source.afterContent}`)}`;
  }

  return null;
}

function hashCodeViewerContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function createCodeViewerSidePaneTab(source: CodeViewerSource): CodeViewerSidePaneTab {
  const normalizedSource = normalizeCodeViewerSource(source);
  const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
  return {
    id: sourceKey ? `code-viewer:${sourceKey}` : `code-viewer:${createUuid()}`,
    type: "code-viewer",
    openedAt: Date.now(),
    source: normalizedSource,
    sourceKey,
  };
}

function findTabIndexById(tabs: WorkspaceSidePaneTab[], tabId: string): number {
  return tabs.findIndex((tab) => tab.id === tabId);
}

export function activateSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  if (!current) {
    return {
      tabs: [tab],
      activeTabId: tab.id,
    };
  }

  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const nextTabs = [...current.tabs];
    nextTabs[existingIndex] = tab;
    return {
      tabs: nextTabs,
      activeTabId: tab.id,
    };
  }

  return {
    tabs: [...current.tabs, tab],
    activeTabId: tab.id,
  };
}

export function getActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneTab | null {
  if (!current) {
    return null;
  }

  return current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
}

/** 把草稿态的 null/undefined 归一，供侧栏按对话隔离。 */
export function sidePaneOwnerKey(taskId: string | null | undefined): string {
  return taskId ?? "__draft__";
}

export interface SidePaneVisibilityScope {
  workspaceKey: string | null;
  ownerTaskId: string | null;
}

function sidePaneTabMatchesWorkspace(
  tab: WorkspaceSidePaneTab,
  activeWorkspaceKey: string | null,
): boolean {
  return tab.workspaceKey == null || tab.workspaceKey === activeWorkspaceKey;
}

/**
 * 新建 tab 在提交到共享侧栏状态时统一冻结工作区与对话归属。
 */
export function stampSidePaneTabsOwnership(
  state: WorkspaceSidePaneState | null,
  ownership: {
    ownerTaskId: string | null;
    workspaceKey: string | null;
  },
): WorkspaceSidePaneState | null {
  if (!state) return state;
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.ownerTaskId !== undefined && tab.workspaceKey != null) return tab;
    changed = true;
    return {
      ...tab,
      // 快捷入口可能已写 owner 但未写 workspace；两者独立补齐，否则最近关闭会跨工作区泄漏。
      ownerTaskId: tab.ownerTaskId === undefined ? ownership.ownerTaskId : tab.ownerTaskId,
      workspaceKey: tab.workspaceKey ?? ownership.workspaceKey,
    } as WorkspaceSidePaneTab;
  });
  return changed ? { ...state, tabs } : state;
}

/** 显示与操作必须共用归属判断；旧 parent-only 分支会把新类型误当成公共 tab。 */
export function isSidePaneTabVisibleInScope(
  tab: WorkspaceSidePaneTab,
  scope: SidePaneVisibilityScope,
): boolean {
  if (!sidePaneTabMatchesWorkspace(tab, scope.workspaceKey)) return false;
  switch (tab.type) {
    case "git":
    case "developer-tools":
    case "treemapping":
      return true;
    case "subagent-session":
    case "subagent-directory":
    case "bash-output":
      return tab.rootSessionId === scope.ownerTaskId;
    case "selection-side-chat":
    case "plan-detail":
    case "workflow-run":
    case "workflow-directory":
    case "workflow-actor-session":
    case "workflow-workspace":
    case "workflow-artifact":
      return tab.parentSessionId === scope.ownerTaskId;
    case "file-manager":
    case "code-viewer":
    case "whiteboard":
    case "model-trajectory":
    case "new-tab":
      return sidePaneOwnerKey(tab.ownerTaskId) === sidePaneOwnerKey(scope.ownerTaskId);
  }
}

export function getVisibleSidePaneTabs(
  tabs: readonly WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[] {
  return tabs.filter((tab) => isSidePaneTabVisibleInScope(tab, scope));
}

export function resolveActiveTabForOwner(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): string | null {
  if (!state) return null;
  const visibleTabs = getVisibleSidePaneTabs(state.tabs, scope);
  if (visibleTabs.length === 0) return null;
  if (preferredTabId && visibleTabs.some((tab) => tab.id === preferredTabId)) {
    return preferredTabId;
  }
  if (visibleTabs.some((tab) => tab.id === state.activeTabId)) {
    return state.activeTabId;
  }
  return visibleTabs.at(-1)?.id ?? null;
}

/**
 * 对话 scope 切换时同时解析 active tab 与折叠态。
 *
 * 目标对话没有 preferredTabId 时不能沿用上一个对话的 collapsed 状态，也不能简单地
 * 用“有可见 tab 就展开”覆盖状态。否则用户在 A 主动收起后切到 B 再切回 A，仍会被 A 的可见 tab
 * 自动展开。现在由调用方传入当前对话的主动偏好；没有偏好时才沿用默认的“有 tab 展开、无 tab 收起”。
 */
export function resolveSidePaneScopeState(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
  collapsedPreference?: boolean,
): {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
} {
  const activeTabId = resolveActiveTabForOwner(state, scope, preferredTabId);
  return {
    sidePaneState:
      state && state.activeTabId !== (activeTabId ?? "")
        ? { ...state, activeTabId: activeTabId ?? "" }
        : state,
    // 草稿重新进入时默认收起；空 scope 的历史展开偏好不能生成新标签页。
    isSidePaneCollapsed:
      activeTabId === null || scope.ownerTaskId === null
        ? true
        : (collapsedPreference ?? false),
  };
}

export function restoreSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, {
    ...tab,
    openedAt: tab.openedAt ?? Date.now(),
  });
}

export function openFileManagerSidePane(
  current: WorkspaceSidePaneState | null,
  target: FileManagerTarget,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, {
    id: `file-manager:${createUuid()}`,
    type: "file-manager",
    target,
    source: null,
    openedAt: Date.now(),
  });
}

export function navigateFileManagerSidePane(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  source: CodeViewerSource,
): WorkspaceSidePaneState | null {
  if (!current) return current;
  const normalizedSource = normalizeCodeViewerSource(source);
  return {
    ...current,
    // 导航只更新目标实例，不激活其他 Tab，也不改变实例 id 和任务归属。
    tabs: current.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      if (tab.type === "file-manager") return { ...tab, source: normalizedSource };
      if (tab.type === "code-viewer") {
        return {
          ...tab,
          source: normalizedSource,
          sourceKey: getCodeViewerTabSourceKey(normalizedSource),
        };
      }
      return tab;
    }),
  };
}

export function openCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
  source: CodeViewerSource,
  ownerTaskId?: string | null,
): WorkspaceSidePaneState {
  // 同一个文件/图片在消息里被重复点击时，不能把右侧面板整块替换，
  // 用户刚在别的 pane 里看的内容会直接丢掉。这里按稳定 sourceKey 复用已有 code viewer tab，
  // 既避免重复开一排同名 tab，也能在再次打开时刷新到最新 source。
  const nextTab = createCodeViewerSidePaneTab(source);
  if (!current || nextTab.sourceKey === null) {
    return activateSidePaneTab(current, nextTab);
  }

  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const matchedTab = current.tabs.find(
    (tab): tab is CodeViewerSidePaneTab =>
      tab.type === "code-viewer" &&
      tab.sourceKey === nextTab.sourceKey &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
  );
  // 文件导航后旧实例仍持有原 id；重新打开原路径时必须分配新 id，避免覆盖正在看的文件。
  if (!matchedTab && current.tabs.some((tab) => tab.id === nextTab.id)) {
    nextTab.id = `code-viewer:${createUuid()}`;
  }
  return activateSidePaneTab(
    current,
    matchedTab ? { ...matchedTab, source: nextTab.source } : nextTab,
  );
}

/**
 * 一次性打开一组代码预览 Tab。
 *
 * 自动打开生成产物时不能逐张调用 openCodeViewerSidePane：逐张提交会让右侧
 * 面板经历多次中间状态，并且最后一张会意外成为 active。这里复用单文件
 * 的 sourceKey/owner 规则批量收口，最后按调用方指定的顺序激活一张 Tab。
 */
export function openCodeViewerSidePanes(
  current: WorkspaceSidePaneState | null,
  sources: readonly CodeViewerSource[],
  ownerTaskId?: string | null,
  activeIndex = 0,
): WorkspaceSidePaneState {
  if (sources.length === 0) {
    return current ?? { tabs: [], activeTabId: "" };
  }

  let next: WorkspaceSidePaneState | null = current;
  const openedTabIds: string[] = [];
  const seenSourceKeys = new Set<string>();

  for (const source of sources) {
    const normalizedSource = normalizeCodeViewerSource(source);
    const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
    // sourceKey 是 workspace-scoped 的稳定身份；同一批次重复路径只打开一次。
    if (sourceKey !== null && seenSourceKeys.has(sourceKey)) continue;
    if (sourceKey !== null) seenSourceKeys.add(sourceKey);

    next = openCodeViewerSidePane(next, normalizedSource, ownerTaskId);
    const activeTab = getActiveSidePaneTab(next);
    if (activeTab?.type === "code-viewer") {
      openedTabIds.push(activeTab.id);
    }
  }

  if (!next || openedTabIds.length === 0) {
    return next ?? { tabs: [], activeTabId: "" };
  }

  const safeIndex = Math.min(Math.max(activeIndex, 0), openedTabIds.length - 1);
  return {
    ...next,
    activeTabId: openedTabIds[safeIndex]!,
  };
}

export function activateGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createGitSidePaneTab());
}

export function activateTreemappingSidePane(
  current: WorkspaceSidePaneState | null,
  source?: TreemappingSidePaneSource,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createTreemappingSidePaneTab(source));
}

export function openWhiteboardSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    boardId: string;
    title: string;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createWhiteboardSidePaneTab(options));
}

export function openModelTrajectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    taskId: string;
    title?: string | null;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createModelTrajectorySidePaneTab(options));
}



export function activateDeveloperToolsSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createDeveloperToolsSidePaneTab());
}


export function openSubagentSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
    childSessionId: string;
    subagentType: string;
    title: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentSessionSidePaneTab =>
      tab.type === "subagent-session" && tab.id === nextTab.id,
  );
  const nextTitle = options.title.trim();
  return activateSidePaneTab(
    current,
    existing
      ? {
          ...existing,
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
          rootSessionId: options.rootSessionId ?? options.parentSessionId,
          parentSessionId: options.parentSessionId,
          subagentType: options.subagentType,
          // HMR 期间可能复用旧结构的内存 tab；新入口没有 title 时保留已知标题，
          // 但绝不再回退到旧的 type + ordinal 展示规则。
          title: nextTitle || existing.title || "",
        }
      : nextTab,
  );
}

export function openSubagentDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentDirectorySidePaneTab =>
      tab.type === "subagent-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

export function syncSubagentSessionSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  options: SyncSubagentSessionTabsRequest,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const validChildSessionIds = new Set(options.validChildSessionIds);
  const removedTabs = current.tabs.filter(
    (tab) =>
      tab.type === "subagent-session" &&
      tab.rootSessionId === options.rootSessionId &&
      tab.parentSessionId === options.parentSessionId &&
      !validChildSessionIds.has(tab.childSessionId),
  );
  if (removedTabs.length === 0) return current;
  const removedIds = new Set(removedTabs.map((tab) => tab.id));
  const tabs = current.tabs.filter((tab) => !removedIds.has(tab.id));
  if (tabs.length === 0) return null;
  if (!removedIds.has(current.activeTabId)) return { ...current, tabs };
  const directory = tabs.find(
    (tab) => tab.type === "subagent-directory" && tab.rootSessionId === options.rootSessionId,
  );
  if (directory) return { tabs, activeTabId: directory.id };
  const removedIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
  const previous = tabs[Math.max(0, Math.min(removedIndex - 1, tabs.length - 1))];
  return { tabs, activeTabId: previous?.id ?? tabs.at(-1)!.id };
}

export function openSelectionSideChatPane(
  current: WorkspaceSidePaneState | null,
  options: OpenSelectionSideChatRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const existing = current?.tabs.find(
    (tab): tab is SelectionSideChatPaneTab =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === options.workspaceKey &&
      tab.parentSessionId === options.parentSessionId &&
      tab.childSessionId === options.childSessionId,
  );
  const ordinal =
    existing?.ordinal ??
    getNextSelectionSideChatOrdinal(
      current?.tabs ?? [],
      options.workspaceKey,
      options.parentSessionId,
    );
  const nextTab = createSelectionSideChatPaneTab({ ...options, ordinal });
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

function getNextSelectionSideChatOrdinal(
  tabs: readonly WorkspaceSidePaneTab[],
  workspaceKey: string,
  parentSessionId: string,
): number {
  const used = new Set(
    tabs.flatMap((tab) =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === workspaceKey &&
      tab.parentSessionId === parentSessionId
        ? [tab.ordinal]
        : [],
    ),
  );
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  return ordinal;
}

export function getActiveSelectionSideChatTab(
  current: WorkspaceSidePaneState | null,
  scope: { workspaceKey: string; parentSessionId: string },
): SelectionSideChatPaneTab | null {
  const active = getActiveSidePaneTab(current);
  return active?.type === "selection-side-chat" &&
    active.workspaceKey === scope.workspaceKey &&
    active.parentSessionId === scope.parentSessionId
    ? active
    : null;
}

export function openPlanDetailSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createPlanDetailSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is PlanDetailSidePaneTab => tab.type === "plan-detail" && tab.id === nextTab.id,
  );
  // 同一个 toolCall 只保留一个 tab；再次点击用卡片当前正文刷新 fallback，
  // 详情组件的实时正文仍以父 conversation projection 为权威。
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * 打开或复用一个 workflow run 详情 tab。
 *
 * 复用规则与 plan-detail 同构（结构化 id 幂等），刻意也**同样没有 GC**：事件日志读的是
 * journal，而 `workflowRuns` 投影只留最近 8 个 run，所以一个被淘汰的 run 仍有完整可读的
 * 事件日志——那正是用户会把这个 tab 留着的场景。投影缺席退化成详情页的空态，不关 tab。
 */
export function openWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunSidePaneTab => tab.type === "workflow-run" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // 落点每次都重算（与脚本 transcript tab 同一条规则）：请求带 phaseId 就落到它，不带就显式删键；
  // `openedAt` 随每次打开刷新，面板据此在同一站上再点一次也重新滚。
  const merged: WorkflowRunSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 * 「配置」被接受后的原地替换：旧 run 的 tab 换成新 run 的 tab，位置、名字、归属照旧；它原来是活动
 * tab 才让新 tab 成为活动 tab。新 run 的 tab 已经开着时，关掉旧的、聚焦已有的那一个（不出两个）。
 * 旧 tab 不在（用户已关掉）即原样返回——替换不是打开；结果里的 run 就是被替换的那一个（就地生效的
 * 修订没有后继）时同理，这个 tab 已经是它了。
 */
export function replaceWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string; replaceRunId: string },
): WorkspaceSidePaneState | null {
  if (current === null) return current;
  const nextTab = createWorkflowRunSidePaneTab(options);
  const replaceRunId = options.replaceRunId;
  const index = current.tabs.findIndex(
    (tab) =>
      tab.type === "workflow-run" &&
      tab.workspaceKey === nextTab.workspaceKey &&
      tab.parentSessionId === nextTab.parentSessionId &&
      tab.runId === replaceRunId,
  );
  const previous = current.tabs[index];
  if (index < 0 || previous?.type !== "workflow-run") return current;
  // 就地生效的修订（只改并发上限、run 又在飞：docs/dynamic-workflow/concurrency.md）没有后继，
  // 结果里的 runId 就是被替换的这一个。tab 的 id 只由 runId 铸，所以不挡在这里的话，下面那支
  // 「新 tab 已经开着」会认出它自己、把这个 tab 关掉，只留一个指向已不存在 tab 的 activeTabId。
  if (nextTab.id === previous.id) return current;
  const wasActive = current.activeTabId === previous.id;
  const existingIndex = findTabIndexById(current.tabs, nextTab.id);
  if (existingIndex >= 0) {
    const tabs = current.tabs.filter((_, tabIndex) => tabIndex !== index);
    return { tabs, activeTabId: wasActive ? nextTab.id : current.activeTabId };
  }
  const replaced: WorkflowRunSidePaneTab = {
    ...nextTab,
    ...(previous.ownerTaskId === undefined ? {} : { ownerTaskId: previous.ownerTaskId }),
    ...(nextTab.workflowName === undefined && previous.workflowName !== undefined
      ? { workflowName: previous.workflowName }
      : {}),
  };
  const tabs = [...current.tabs];
  tabs[index] = replaced;
  return { tabs, activeTabId: wasActive ? replaced.id : current.activeTabId };
}

/**
 * 打开或复用一条对话的 run 目录 tab。身份是对话，所以页脚行重复点击只是聚焦。
 *
 * GC 同样**没有**（与 workflow-run 同一条理由链）：目录页每次挂载自己重读一页 journal，
 * 所以一个被恢复出来的旧 tab 不会显示过期名单，也就没有该回收的东西。
 */
export function openWorkflowRunDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunDirectorySidePaneTab =>
      tab.type === "workflow-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * 打开或复用一个 actor transcript tab。
 *
 * 复用规则与 workflow-run 同构（结构化 id 幂等），GC 同样**没有**：actor 会话在 run 结束
 * 之后继续可读，那正是把它落成真实持久会话换来的东西。见类型上那段注释。
 *
 * 合并时新请求里缺席的键不覆盖旧值：先从未启动的药丸开（无会话 id）、后从已启动的药丸再开
 * （带会话 id）补上会话；反过来再开一次不带会话的请求也不会把已知的会话 id 抹掉。
 */
export function openWorkflowActorSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowActorSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowActorSessionSidePaneTab =>
      tab.type === "workflow-actor-session" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * 打开或复用一个 run 的脚本 transcript tab。
 *
 * 落点**每次都重算**：再点一枚脚本药丸的意思是「带我去那一站」，所以请求带 phaseId 就落到
 * 它，不带就不落（显式删键，同 `openWorkflowArtifactSidePane` 对 version 的处理）。`openedAt`
 * 随每次打开刷新，面板据此在同一站上再点一次也重新滚动。
 */
export function openWorkflowWorkspaceSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowWorkspaceSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowWorkspaceSidePaneTab =>
      tab.type === "workflow-workspace" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  const merged: WorkflowWorkspaceSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 * 打开或复用一个产物的全尺寸 tab。
 *
 * 复用时**不把旧 tab 的 version 保留下来**：再次点击一枚 chip 的意思是「让我看这个产物」，
 * 而 chip 从不带版本号，所以合并结果里 `version` 缺席即回到最新版。反过来，若请求显式带了
 * 版本（例如将来某处要跳到某一版），那一版才是落点。
 */
export function openWorkflowArtifactSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowArtifactSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowArtifactSidePaneTab =>
      tab.type === "workflow-artifact" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // 合并时**丢掉旧 tab 上的 version**：`...nextTab` 里缺席的键不会覆盖旧值，而那正好是
  // 「chip 不带版本号 ⇒ 回到最新版」这条语义会被悄悄破坏的地方（旧 tab 停在 v1，再点一次
  // 仍然停在 v1）。显式删键，让缺席真的是缺席。
  const merged: WorkflowArtifactSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.version === undefined) delete merged.version;
  return activateSidePaneTab(current, merged);
}

export function selectSidePaneTabsForScope(
  current: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current.tabs, scope);
  if (visibleTabs.length === 0) {
    return current.activeTabId === "" ? current : { ...current, activeTabId: "" };
  }
  const preferred = preferredTabId
    ? visibleTabs.find((tab) => tab.id === preferredTabId)
    : undefined;
  const currentActive = visibleTabs.find((tab) => tab.id === current.activeTabId);
  const nextActive =
    currentActive ??
    preferred ??
    visibleTabs.findLast(
      (tab) =>
        tab.type === "subagent-session" ||
        tab.type === "subagent-directory" ||
        tab.type === "selection-side-chat" ||
        tab.type === "plan-detail" ||
        tab.type === "workflow-run" ||
        tab.type === "workflow-actor-session" ||
        tab.type === "workflow-workspace" ||
        tab.type === "workflow-artifact",
    ) ??
    visibleTabs.at(-1);
  return nextActive && nextActive.id !== current.activeTabId
    ? { ...current, activeTabId: nextActive.id }
    : current;
}

/** 关闭时只处理已选中的 id，避免异步 authority 返回后误关新打开的标签。 */
export function closeSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  tabIds: readonly string[],
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  const next = tabIds.reduce(closeSidePaneTab, current);
  return selectSidePaneTabsForScope(next, scope, preferredTabId);
}

export function closeSidePaneTabForScope(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  return closeSidePaneTabs(current, [tabId], scope, preferredTabId);
}

export function closeSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  const closingIndex = findTabIndexById(current.tabs, tabId);
  if (closingIndex < 0) {
    return current;
  }

  const nextTabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (nextTabs.length === 0) {
    return null;
  }

  if (current.activeTabId !== tabId) {
    return {
      tabs: nextTabs,
      activeTabId: current.activeTabId,
    };
  }

  const fallbackIndex = Math.min(closingIndex, nextTabs.length - 1);
  return {
    tabs: nextTabs,
    activeTabId: nextTabs[fallbackIndex]!.id,
  };
}

export function closeOtherSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  const targetTab = current.tabs.find((tab) => tab.id === tabId);
  if (!targetTab || current.tabs.length <= 1) {
    return current;
  }

  return {
    // 交互说明：右键“关闭其他标签”以当前被操作的 tab 为保留对象，
    // 即使它原本不是激活项，也要同步激活，避免内容区指向一个已被移除的 activeTabId。
    tabs: [targetTab],
    activeTabId: targetTab.id,
  };
}

export function closeAllSidePaneTabs(): WorkspaceSidePaneState | null {
  return null;
}

export function setActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current || !current.tabs.some((tab) => tab.id === tabId)) {
    return current;
  }

  return {
    ...current,
    activeTabId: tabId,
  };
}

export function reorderSidePaneTab(
  current: WorkspaceSidePaneState | null,
  activeTabId: string,
  overTabId: string,
): WorkspaceSidePaneState | null {
  if (!current || activeTabId === overTabId) {
    return current;
  }

  const activeIndex = findTabIndexById(current.tabs, activeTabId);
  const overIndex = findTabIndexById(current.tabs, overTabId);
  if (activeIndex < 0 || overIndex < 0) {
    return current;
  }

  const nextTabs = [...current.tabs];
  const [movedTab] = nextTabs.splice(activeIndex, 1);
  if (!movedTab) {
    return current;
  }

  nextTabs.splice(overIndex, 0, movedTab);
  return {
    ...current,
    tabs: nextTabs,
  };
}



export function toggleGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "git") {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateGitSidePane(current);
}

export function closeCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  return activeTab?.type === "code-viewer" ? closeSidePaneTab(current, activeTab.id) : current;
}

export function closeGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  return closeSidePaneTab(current, "git");
}

export function openBackgroundBashSidePane(
  current: WorkspaceSidePaneState | null,
  target: OpenBackgroundBashSideTabRequest,
): WorkspaceSidePaneState {
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const id =
    "bash-output:" +
    [
      workspaceKey,
      target.remoteSessionId ?? "",
      target.rootSessionId,
      target.sessionId,
      target.workId,
    ]
      .map(encodeSidePaneTabIdPart)
      .join(":");
  const existing = current?.tabs.find((tab) => tab.id === id);
  return activateSidePaneTab(
    current,
    existing ?? {
      ...target,
      id,
      type: "bash-output",
      workspaceKey,
      ownerTaskId: target.rootSessionId,
      openedAt: Date.now(),
    },
  );
}

export function activateNewTabSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, { id: createUuid(), type: "new-tab", openedAt: Date.now() });
}

/** 展开面板始终有真实标签；只为当前对话补入口，不改变其他对话的标签。 */
export function ensureSidePaneTab(
  current: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneState {
  if (current && getVisibleSidePaneTabs(current.tabs, scope).length > 0) return current;
  return activateSidePaneTab(current, {
    id: createUuid(),
    type: "new-tab",
    openedAt: Date.now(),
    ...scope,
  });
}
