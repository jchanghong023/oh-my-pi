import { stageV4ComposerDraftAttachments } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { readProjectSidebarView } from "@/project-sidebar/index.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  remoteHostIdFromWorkspaceIdentity,
  type IPlatformService,
  type ZCodeTaskClientMode,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type {
  CreateTaskOptions,
  CreateTaskRequest,
} from "@/app-shell/types.js";
import { useConnectRemote } from "@/hooks/usePlatform.js";
import type { WorkspaceRemoteNavigationProps, RemoteWorkspaceRecoveryStatus } from "@/app-shell/types.js";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  clearRemoteWorkspaceConnectionState,
  getRemoteWorkspaceSession,
  setRemoteWorkspaceConnectionState,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  resolveComposerScope,
  ensurePendingTaskDraft,
  bindPendingTaskDraft,
  rememberComposerWorkspaceScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";
import { openFolderFromWorkspaceEntry } from "@/root/openWorkspaceFolderEntry.js";
import { useConversationWorkspaceActions } from "@/root/useConversationWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { notifyTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { type TabStore, type TabStoreState } from "@/store/tabStore.js";
import type { RootProps } from "@/root/types.js";
import {
  hadPersistedPaneLayoutAtModuleLoad,
  INITIAL_PANE_LAYOUT,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import type { WorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";

/** 新任务落点：identity 缺省一律归一化为 null，供只读校验、focus/addTab 统一消费。 */
export interface NewTaskTargetResolution {
  workspacePath: string;
  workspaceIdentity: string | null;
}

/**
 * 解析新任务落点：请求显式带 targetWorkspace 时（跨项目发起已保存工作流）直接采用它，不再询问 workbench 焦点；
 * 否则惰性回退到 resolveWorkbenchNewTaskTarget。identity 缺省归一化为 null。
 */
export function resolveNewTaskTargetFromRequest(
  request: CreateTaskRequest | undefined,
  resolveFallback: () => WorkbenchNewTaskTarget | null,
): NewTaskTargetResolution | null {
  const targetWorkspace =
    typeof request === "string" || !request ? undefined : request.targetWorkspace;
  if (targetWorkspace) {
    return {
      workspacePath: targetWorkspace.workspacePath,
      workspaceIdentity: targetWorkspace.workspaceIdentity ?? null,
    };
  }
  const fallback = resolveFallback();
  if (!fallback) {
    return null;
  }
  return {
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity ?? null,
  };
}

export function useRootWorkspaceActions({
  intl,
  platform,
  services,
  tabStoreApi,
  addTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  supportsSettings,
  isDesktop = false,
  allowOpenWorkspace,
  preferDirectoryBrowser,
  openDirectoryBrowser,
  workbenchGroupClientMode = "desktop-continuous",
}: {
  intl: IntlInstance;
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  addTab: TabStoreState["addTab"];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  supportsSettings: boolean;
  isDesktop?: boolean;
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  preferDirectoryBrowser: boolean;
  openDirectoryBrowser?: () => void;
  workbenchGroupClientMode?: ZCodeTaskClientMode;
}) {
  const navigationSequence = useRef(0);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const handleConnectRemote = useConnectRemote();
  const [remoteWorkspaceRecoveryByWorkspaceKey, setRemoteWorkspaceRecovery] = useState<
    Record<string, RemoteWorkspaceRecoveryStatus>
  >({});
  const [remoteWorkspaceErrorByWorkspaceKey, setRemoteWorkspaceErrors] = useState<
    Record<string, string>
  >({});
  const reconnectingRemoteWorkspaceKeys = useMemo(
    () => Object.keys(remoteWorkspaceRecoveryByWorkspaceKey),
    [remoteWorkspaceRecoveryByWorkspaceKey],
  );
  const reconnectFlights = useRef(new Map<string, Promise<void>>());
  const clearRemoteRecovery = useCallback((workspaceKey: string) => {
    clearRemoteWorkspaceConnectionState(workspaceKey);
    setRemoteWorkspaceRecovery((current) => {
      const next = { ...current };
      delete next[workspaceKey];
      return next;
    });
    setRemoteWorkspaceErrors((current) => {
      const next = { ...current };
      delete next[workspaceKey];
      return next;
    });
  }, []);
  const handleCancelRemoteProject = useCallback(async (sessionId: string) => {
    try {
      await platform.disposeRemoteSession(sessionId);
    } finally {
      unregisterRemoteWorkspaceSession(sessionId);
    }
  }, [platform]);
  const handleSelectRemoteProject = useCallback<
    WorkspaceRemoteNavigationProps["onSelectRemoteProject"]
  >(async (sessionId, path, localWorkspacePath, preparedWorkspaceIdentity, isCurrent) => {
    const assertCurrent = async () => {
      if (isCurrent && !(await isCurrent())) throw new Error("project.navigation-cancelled");
    };
    await assertCurrent();
    const session = getRemoteWorkspaceSession(sessionId);
    if (!session) throw new Error(`Remote workspace session not found: ${sessionId}`);
    const canonicalPath = await session.services.fileService.resolvePath({ path });
    await assertCurrent();
    const previousTab = tabStoreApi.getState().tabs.find(
      (tab) => isWorkspaceTab(tab) && tab.workspacePath === path &&
        tab.workspaceIdentity === preparedWorkspaceIdentity,
    );
    const workspacePurpose =
      (previousTab && isWorkspaceTab(previousTab) ? previousTab.workspacePurpose : undefined) ??
      session.workspacePurpose ?? "project";
    const binding = await platform.bindRemoteWorkspaceSessionContext?.({
      remoteSessionId: sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity: preparedWorkspaceIdentity,
      workspacePurpose,
    });
    await assertCurrent();
    // Binding replaces the transport; never keep the pre-bind service accessor.
    const bound = getRemoteWorkspaceSession(sessionId);
    const workspaceIdentity = binding?.workspaceIdentity?.trim() || bound?.workspaceIdentity?.trim();
    if (!bound || !workspaceIdentity)
      throw new Error(`Remote workspace bind did not return an authoritative identity: ${sessionId}`);
    const workspacePath = binding?.workspacePath ?? bound.workspacePath ?? canonicalPath;
    bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);
    bindRemoteWorkspacePath(workspacePath, sessionId);
    tabStoreApi.getState().ensureWorkspaceTab(workspacePath, {
      remoteSessionId: sessionId,
      workspaceIdentity,
      previousWorkspaceIdentity: binding?.previousWorkspaceIdentity,
      remoteTarget: bound.target ?? session.target,
      workspacePurpose: binding?.workspacePurpose ?? bound.workspacePurpose ?? workspacePurpose,
      localWorkspacePath,
    });
    clearRemoteRecovery(workspaceIdentity);
  }, [clearRemoteRecovery, platform, tabStoreApi]);
  const handleReconnectRemoteWorkspace = useCallback((workspaceKey: string): Promise<void> => {
    const running = reconnectFlights.current.get(workspaceKey);
    if (running) return running;
    const reconnect = async () => {
      const tab = tabStoreApi.getState().tabs.find(
        (entry) => isWorkspaceTab(entry) &&
          (entry.workspaceIdentity?.trim() || entry.workspacePath) === workspaceKey,
      );
      if (!tab || !isWorkspaceTab(tab) || !tab.workspaceIdentity)
        throw new Error(`Remote workspace not found: ${workspaceKey}`);
      const hostId = remoteHostIdFromWorkspaceIdentity(tab.workspaceIdentity);
      const directory = services.windowProjectDirectory ?? services;
      const remoteService = directory.remoteProjectService;
      if (!hostId || !remoteService) throw new Error("project.connection-unavailable");
      const isCurrent = () => tabStoreApi.getState().tabs.some(
        (entry) => isWorkspaceTab(entry) && entry.id === tab.id &&
          entry.workspaceIdentity === tab.workspaceIdentity,
      );
      setRemoteWorkspaceRecovery((current) => ({ ...current, [workspaceKey]: { mode: "manual" } }));
      setRemoteWorkspaceConnectionState(workspaceKey, "reconnecting");
      try {
        await attachRemoteProjectWorkspace({
          hostId,
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          remoteService,
          isCurrent,
          findSession: (identity) => Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById)
            .find((session) => session.workspaceIdentity === identity),
          connect: handleConnectRemote,
          bind: (sessionId, path, guard) =>
            handleSelectRemoteProject(sessionId, path, tab.localWorkspacePath, tab.workspaceIdentity, guard),
          cancel: handleCancelRemoteProject,
        });
        clearRemoteRecovery(workspaceKey);
      } catch (error) {
        setRemoteWorkspaceConnectionState(workspaceKey, "disconnected");
        setRemoteWorkspaceErrors((current) => ({
          ...current,
          [workspaceKey]: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      } finally {
        setRemoteWorkspaceRecovery((current) => {
          const next = { ...current };
          delete next[workspaceKey];
          return next;
        });
      }
    };
    const flight = reconnect().finally(() => reconnectFlights.current.delete(workspaceKey));
    reconnectFlights.current.set(workspaceKey, flight);
    return flight;
  }, [clearRemoteRecovery, handleCancelRemoteProject, handleConnectRemote, handleSelectRemoteProject, services, tabStoreApi]);

  useEffect(() => {
    const stopClosed = platform.onRemoteSessionClosed((event) => {
      const affected = tabStoreApi.getState().tabs.filter(
        (tab) => isWorkspaceTab(tab) && tab.remoteSessionId === event.sessionId,
      );
      unregisterRemoteWorkspaceSession(event.sessionId);
      if (!event.recoverable) tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) && tab.remoteSessionId === event.sessionId
            ? { ...tab, remoteSessionId: undefined }
            : tab,
        ),
      }));
      for (const tab of affected) {
        if (!isWorkspaceTab(tab)) continue;
        const key = tab.workspaceIdentity?.trim() || tab.workspacePath;
        setRemoteWorkspaceConnectionState(key, event.recoverable ? "reconnecting" : "disconnected");
        setRemoteWorkspaceRecovery((current) => {
          const next = { ...current };
          if (event.recoverable) next[key] = {
            mode: "automatic", attempt: event.recoveryAttempt, limit: event.recoveryLimit,
          };
          else delete next[key];
          return next;
        });
        if (event.recoverable) continue;
        const message = event.recoveryBudgetExhausted
          ? intl.formatMessage({ id: "remote.error.recoveryBudgetExhausted" }, {
              attempt: event.recoveryAttempt ?? "?", limit: event.recoveryLimit ?? "?",
            })
          : event.error || event.reasonCode ||
            ((event.exitCode != null && event.exitCode !== 0) || event.signal
              ? intl.formatMessage({ id: "remote.error.connectionClosed" })
              : undefined);
        setRemoteWorkspaceErrors((current) => {
          const next = { ...current };
          if (message) next[key] = message;
          else delete next[key];
          return next;
        });
      }
    });
    const stopReconnected = platform.onRemoteSessionReconnected?.((event) => {
      const tab = tabStoreApi.getState().tabs.find(
        (entry) => isWorkspaceTab(entry) &&
          entry.workspacePath === event.workspacePath &&
          entry.workspaceIdentity === event.workspaceIdentity &&
          (!entry.remoteSessionId || entry.remoteSessionId === event.previousSessionId),
      );
      if (!tab || !isWorkspaceTab(tab)) return;
      unregisterRemoteWorkspaceSession(event.previousSessionId);
      tabStoreApi.getState().ensureWorkspaceTab(event.workspacePath, {
        remoteSessionId: event.sessionId,
        workspaceIdentity: event.workspaceIdentity,
        previousWorkspaceIdentity: tab.workspaceIdentity,
      });
      bindRemoteWorkspaceIdentity(event.workspaceIdentity, event.sessionId);
      bindRemoteWorkspacePath(event.workspacePath, event.sessionId);
      clearRemoteRecovery(tab.workspaceIdentity?.trim() || tab.workspacePath);
      clearRemoteRecovery(event.workspaceIdentity);
    });
    return () => {
      stopClosed();
      stopReconnected?.();
    };
  }, [clearRemoteRecovery, intl, platform, tabStoreApi]);

  useEffect(() => {
    useWorkbenchGroupStore.getState().configureClientMode(workbenchGroupClientMode);
    if (workbenchGroupClientMode === "desktop-continuous" && !isRendererReloadNavigation()) {
      // group/pane 是 renderer-local 持久化 UI 状态。app 冷启动如果直接
      // 激活它们，即使 activeTaskId=null 也会把历史 session 显示出来，违背启动草稿语义。
      // renderer reload 则保留恢复资格，用于输出中刷新续流。
      const workbenchState = useWorkbenchGroupStore.getState();
      const activeGroup = workbenchState.activeGroupId
        ? workbenchState.groups[workbenchState.activeGroupId]
        : null;
      const activeGroupWasRestored = Boolean(
        activeGroup &&
        [activeGroup.primaryBinding, ...Object.values(activeGroup.panes)].some(
          (binding) => binding.restoredUnvalidated,
        ),
      );
      if (activeGroupWasRestored) {
        workbenchState.deactivateActiveGroup();
      }
      if (hadPersistedPaneLayoutAtModuleLoad()) {
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
    }
  }, [workbenchGroupClientMode]);

  const composerClientNamespace = useComposerClientNamespace();
  const startDraftInWorkspace = useCallback(
    (workspacePath: string, workspaceIdentity?: string, options?: CreateTaskOptions) => {
      const projectId =
        options?.projectId !== undefined
          ? options.projectId
          : (readComposerWorkspaceScope(workspacePath, workspaceIdentity, composerClientNamespace)
              ?.projectId ?? null);
      const scope = resolveComposerScope(projectId, workspaceIdentity, composerClientNamespace);
      const savedDraft = readV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        scope,
      );
      const taskGroupId =
        options?.taskGroupId !== undefined
          ? options.taskGroupId
          : (savedDraft?.taskGroupId ?? null);
      rememberComposerWorkspaceScope(workspacePath, workspaceIdentity, scope);
      if (options?.draftId) bindPendingTaskDraft(scope, options.draftId, workspacePath);
      persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        {
          text: "",
          ...(options?.initialComposerDraft?.draft ?? savedDraft),
          projectId,
          taskGroupId,
        },
        scope,
      );
      if (workbenchGroupClientMode === "desktop-continuous") {
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      useZCodeSessionStore
        .getState()
        .startDraft(workspacePath, options?.provider, workspaceIdentity, {
          projectId,
          taskGroupId,
        });
      if (options?.initialComposerDraft) {
        stageV4ComposerDraftAttachments(
          workspacePath,
          workspaceIdentity,
          useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .draftFocusVersion,
          options.initialComposerDraft,
        );
      }
      // 项目草稿只由接收目录的 Root 初始化；mention 的尾空格属于编辑内容。
      const initialPrompt = options?.initialPrompt;
      if (initialPrompt?.trim()) {
        const mention = options?.initialPromptMention;
        persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          V4_DRAFT_SCOPE_ROOT,
          {
            text: initialPrompt,
            projectId,
            taskGroupId,
            ...(mention ? { mention } : {}),
          },
          scope,
        );
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(workspacePath, initialPrompt, workspaceIdentity, mention);
      }
    },
    [workbenchGroupClientMode, composerClientNamespace],
  );

  const startNewTaskFromActiveWorkspace = useCallback(
    async (source: string, request?: CreateTaskRequest) => {
      const sequence = ++navigationSequence.current;
      const originTab = tabStoreApi.getState().activeTabId;
      const originWorkspace = activeWorkspacePath
        ? useZCodeSessionStore
            .getState()
            .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined)
        : null;
      const isCurrent = () =>
        (typeof request !== "object" || request.isCurrent?.() !== false) &&
        sequence === navigationSequence.current &&
        tabStoreApi.getState().activeTabId === originTab &&
        (!activeWorkspacePath ||
          (() => {
            const state = useZCodeSessionStore
              .getState()
              .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined);
            return (
              state.activeTaskId === originWorkspace?.activeTaskId &&
              state.draftFocusVersion === originWorkspace?.draftFocusVersion
            );
          })());
      try {
        // 在第一次 await 前捕获活动任务/草稿；快捷键和侧栏新建共用同一组织意图。
        const requestOptions = typeof request === "string" ? { provider: request } : { ...request };
        if (
          requestOptions.taskGroupId === undefined &&
          requestOptions.projectId === undefined &&
          readProjectSidebarView() === "grouped" &&
          activeWorkspacePath
        ) {
          const taskId = originWorkspace?.activeTaskId;
          const draftGroupId = originWorkspace?.draftTaskGroupId;
          const structure = taskId ? await services.taskGroupService?.read() : undefined;
          if (!isCurrent()) return;
          requestOptions.taskGroupId = taskId
            ? (structure?.members.find(
                (member) =>
                  member.taskId === taskId &&
                  member.workspaceKey === (activeWorkspaceIdentity?.trim() || activeWorkspacePath),
              )?.groupId ?? null)
            : (draftGroupId ?? null);
        }
        request = requestOptions;
        let projectId =
          typeof request === "string"
            ? undefined
            : (request?.projectId ?? request?.targetWorkspace?.projectId);
        let hostId =
          typeof request === "string"
            ? undefined
            : (request?.hostId ?? request?.targetWorkspace?.hostId);
        const hasExplicitProject =
          typeof request === "object" &&
          request !== null &&
          ("projectId" in request || Boolean(request.targetWorkspace?.projectId));
        const newTaskTarget = resolveNewTaskTargetFromRequest(request, () =>
          resolveWorkbenchNewTaskTarget({
            activeWorkspacePath,
            activeWorkspaceIdentity,
            activeGroup: useWorkbenchGroupStore.getState().activeGroupId
              ? (useWorkbenchGroupStore.getState().groups[
                  useWorkbenchGroupStore.getState().activeGroupId!
                ] ?? null)
              : null,
            paneLayout: usePaneLayoutStore.getState(),
          }),
        );
        if (!hasExplicitProject && newTaskTarget) {
          const workspace = useZCodeSessionStore
            .getState()
            .getWorkspaceState(
              newTaskTarget.workspacePath,
              newTaskTarget.workspaceIdentity ?? undefined,
            );
          const tree = workspace.activeTaskId
            ? await services.projectService?.readTree(hostId ? { hostId } : undefined)
            : undefined;
          if (workspace.activeTaskId && !tree) throw new Error("project.service-unavailable");
          projectId = workspace.activeTaskId
            ? (tree?.tasks.find(
                (task) =>
                  task.taskId === workspace.activeTaskId &&
                  (task.workspaceIdentity?.trim() || task.workspacePath) ===
                    (newTaskTarget.workspaceIdentity?.trim() || newTaskTarget.workspacePath),
              )?.projectId ?? undefined)
            : (workspace.draftProjectId ?? undefined);
          if (projectId && (!hostId || hostId === "local")) {
            // 软删除保留历史 project_id；把它直接继承给新任务会报 not-found 并停在旧页。
            // 只继承同 Host 的有效项目，草稿也复验；读取失败仍报错，不冒充项目已删除。
            const projects = tree?.projects ?? (await services.projectService?.readProjects());
            if (!projects) throw new Error("project.service-unavailable");
            if (
              !projects.some(
                (project) =>
                  project.id === projectId && project.hostId === "local" && !project.deleted,
              )
            ) {
              logger.debug("[Root] 新任务不继承已删除的本地项目", { projectId });
              projectId = undefined;
            }
          }
        }
        if (!isCurrent()) return;
        if (!services.projectService) throw new Error("project.service-unavailable");
        const pendingDraft =
          !projectId && (!hostId || hostId === "local")
            ? ensurePendingTaskDraft(resolveComposerScope(null, undefined, composerClientNamespace))
            : null;
        const target = await services.projectService.prepareSession({
          ...(projectId ? { projectId } : {}),
          ...(hostId ? { hostId } : {}),
          // 显式 local 与省略 Host 是同一入口，不能漏掉待发送身份而另建目录。
          ...(pendingDraft
            ? { draftId: pendingDraft.draftId, reuseDraft: Boolean(pendingDraft.workspacePath) }
            : {}),
        });
        if (!isCurrent()) return;
        // 目录准备成功才提交导航；失败保留当前会话和分屏。
        addTab(target.workspacePath, {
          workspacePurpose: target.projectId ? "project" : "conversation",
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        });
        startDraftInWorkspace(target.workspacePath, target.workspaceIdentity, {
          ...(typeof request === "string" ? { provider: request } : request),
          ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
          projectId: target.projectId,
        });
        if (typeof request === "object") request.onComplete?.();
        setWorkspaceActionError(null);
        logger.info(`[Root] ${source}`, {
          workspacePath: target.workspacePath,
          projectId: target.projectId,
        });
      } catch (error) {
        if (!isCurrent()) return;
        logger.error("[Root] 准备新任务失败", error);
        if (typeof request === "object" && request.onError) request.onError(error);
        else {
          // 原因：原错误状态无人展示，目录移走后顶部新建和快捷键只会静默失败。
          // 在仍有效的动作出口反馈；有 onError 的调用方继续负责展示，避免重复提示。
          // 手机 bridge 返回普通错误对象，不能用 instanceof Error 丢掉 message。
          const message =
            error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
              ? error.message
              : String(error);
          toast(
            message === "project.primaryRootMissing" || message === "project.primaryRootUnavailable"
              ? intl.formatMessage({ id: message })
              : message,
          );
        }
      }
    },
    [
      services.projectService,
      intl,
      composerClientNamespace,
      activeWorkspacePath,
      activeWorkspaceIdentity,
      tabStoreApi,
      addTab,
      workbenchGroupClientMode,
      startDraftInWorkspace,
    ],
  );

  const {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  } = useConversationWorkspaceActions({
    services,
    addTab,
    createTask: startNewTaskFromActiveWorkspace,
    setWorkspaceActionError,
  });

  const handleSelectProject = useCallback(
    async (path: string, activateOtherWindow = true) => {
      logger.info("[Root] handleSelectProject called with path:", path);
      const sequence = ++navigationSequence.current;
      const origin = tabStoreApi.getState();
      const readOriginDraft = () =>
        origin.activeWorkspacePath
          ? useZCodeSessionStore
              .getState()
              .getWorkspaceState(
                origin.activeWorkspacePath,
                origin.activeWorkspaceIdentity ?? undefined,
              )
          : undefined;
      const originDraft = readOriginDraft();
      const isCurrent = () => {
        const current = readOriginDraft();
        return (
          sequence === navigationSequence.current &&
          tabStoreApi.getState().activeTabId === origin.activeTabId &&
          current?.activeTaskId === originDraft?.activeTaskId &&
          current?.draftFocusVersion === originDraft?.draftFocusVersion
        );
      };
      try {

        if (!isCurrent()) return;
        // 项目模型迁移后，单独 addTab 不再赋予项目归属。桌面目录入口必须先由
        // Host 原子复用/创建项目，再初始化草稿，不能沿用该目录的旧草稿归属。
        let projectId: string | undefined;
        if (isDesktop) {
          if (!services.projectService) throw new Error("project.service-unavailable");
          projectId = (
            await services.projectService.saveProject({ roots: [path], reuseExistingRoot: true })
          ).id;
        }
        if (!isCurrent()) return;
        // 桌面端：检查是否已有其他窗口打开了该目录，如果是则激活该窗口对应 tab
        const result = activateOtherWindow
          ? await platform.activateOrSetWorkspace(path)
          : { activated: false };
        if (!isCurrent()) return;
        if (result.activated) {
          logger.info("[Root] 目录已在其他窗口打开，已激活该窗口对应 tab，跳过重复打开");
          return;
        }

        // 新增 tab（如果已在本窗口打开则激活它）
        addTab(path);
        // 打开 workspace 是 workspace-only 意图，不是“继续上次会话”。
        // 即使命中已存在 tab，也必须清掉该 workspace 的 activeTaskId 并回到单 pane 草稿。
        startDraftInWorkspace(path, undefined, projectId ? { projectId } : undefined);
        setWorkspaceActionError(null);
        logger.info("[Root] 已打开目录", { path, projectId });
      } catch (err) {
        if (!isCurrent()) return;
        logger.error("[Root] handleSelectProject error:", err);
        setWorkspaceActionError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      addTab,
      platform,
      services.projectService,
      isDesktop,
      startDraftInWorkspace,
      tabStoreApi,
    ],
  );

  const handleOpenWorkspace = useCallback(() => {
    if (!allowOpenWorkspace) {
      // Web 远程控制当前只保证“进入 desktop 已打开的 workspace”。
      // 之前这里继续放开“打开工作区”，用户会被带进打开工作区中间页，
      // 但后续的新工作区/新会话链路并没有在 Web 远程控制模式里补齐，看起来就像页面一直卡住。
      // 这里直接拦掉入口，避免把用户带进半支持状态。
      logger.info("[Root] 当前模式不支持打开其他工作区，已忽略请求");
      return;
    }
    setWorkspaceActionError(null);

    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    // 打开工作区中间页作为“新标签页”会在启动空态、Cmd/Ctrl+O
    // 和菜单打开工作区时抢占整页。现在打开工作区只保留为动作：本地优先直接弹系统目录选择，
    // 不再进入中间页面；不支持系统目录选择的壳层由启动兜底负责创建默认 workspace。
    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 创建对话 workspace 失败", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleOpenFolderFromWorkspaceMenu = useCallback(() => {
    if (!allowOpenWorkspace) {
      logger.info("[Root] 当前模式不支持从空态菜单打开文件夹，已忽略请求");
      return;
    }

    // 空态 workspace 菜单的 Open folder 需要复用根级打开工作区动作。
    // 因此这里调用同一个入口函数，只把 Root 里的 selectDirectory 与项目选择回调注入进去。
    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 从空态菜单创建对话 workspace 失败", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleCreateTask = useCallback(
    (request?: CreateTaskRequest) => {
      return startNewTaskFromActiveWorkspace("sidebar new task", request);
    },
    [startNewTaskFromActiveWorkspace],
  );

  const handleBackFromSettings = useCallback(() => {
    if (!activeWorkspacePath) {
      return;
    }

    // 设置页返回最近 workspace 时不能只按 path 激活。
    // 同一路径可能存在不同远端身份，丢掉 activeWorkspaceIdentity 会把远程工作区切到 path-only 桶。
    const activated = tabStoreApi
      .getState()
      .activateTabByPath(
        activeWorkspacePath,
        activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : undefined,
      );
    const taskId = useZCodeSessionStore
      .getState()
      .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined).activeTaskId;
    if (activated && taskId) {
      notifyTaskNavigationCommitted({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity ?? undefined,
        taskId,
      });
    }
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabStoreApi]);

  return {
    handleConnectRemote,
    handleSelectRemoteProject,
    handleCancelRemoteProject,
    handleReconnectRemoteWorkspace,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,
    workspaceActionError,
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateTask,
    handleBackFromSettings,
  };
}
