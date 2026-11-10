import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  openFileManagerSidePane,
  navigateFileManagerSidePane,
  type FileManagerTarget,
} from "@/lib/workspaceSidePane.js";
/* eslint-disable max-lines */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import {
  buildTaskSidePaneMemoryKey,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  ensureSidePaneTab,
  closeSidePaneTabs,
  isSidePaneTabVisibleInScope,
  closeGitSidePane,
  closeCodeViewerSidePane,
  openWhiteboardSidePane,
  openModelTrajectorySidePane,
  openSubagentSessionSidePane,
  openSubagentDirectorySidePane,
  openSelectionSideChatPane,
  openPlanDetailSidePane,
  openWorkflowRunSidePane,
  replaceWorkflowRunSidePane,
  openWorkflowRunDirectorySidePane,
  openWorkflowActorSessionSidePane,
  openWorkflowWorkspaceSidePane,
  openWorkflowArtifactSidePane,
  activateDeveloperToolsSidePane,
  activateDevMaterialsSidePane,
  activateNewTabSidePane,
  openCodeViewerSidePane,
  openCodeViewerSidePanes,
  activateGitSidePane,
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  sidePaneOwnerKey,
  reorderSidePaneTab,
  resolveSidePaneScopeState,
  restoreSidePaneTab,
  setActiveSidePaneTab,
  syncSubagentSessionSidePaneTabs,
  toggleGitSidePane,
  stampSidePaneTabsOwnership,
  type OpenScopedSubagentSideTabRequest,
  type OpenBackgroundBashSideTabRequest,
  openBackgroundBashSidePane,
  type OpenScopedSubagentDirectorySideTabRequest,
  type OpenSelectionSideChatRequest,
  type OpenScopedPlanDetailSideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenScopedWorkflowRunDirectorySideTabRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type WorkspaceSidePaneState,
  type WorkspaceSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useModelTrajectoryOpenBridge } from "@/hooks/useModelTrajectoryOpenBridge.js";
import { useServices } from "@/hooks/useServices.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { clearSelectionSideChat } from "@/lib/selectionSideChatRuntime.js";
import { clearConversationSelectionReferenceScope } from "@/lib/conversationSelectionReference.js";
import { subscribeTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { useDev } from "@/dev/DevContext.js";
import { useIsMobileCompactViewport } from "@/lib/mobileTextInput.js";


export interface RecentClosedSidePaneTab {
  tab: WorkspaceSidePaneTab;
  closedAt: number;
}

const RECENT_CLOSED_SIDE_PANE_TAB_LIMIT = 8;


export function useAppPanels(options: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  activeTaskId: string | null;
  /** 草稿态与正式任务共用稳定 id，作为侧栏对话隔离边界。 */
  sidePaneOwnerId: string | null;
  defaultWhiteboardNamePrefix: string;
}) {
  const {
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    defaultWhiteboardNamePrefix,
  } = options;
  const activeWorkspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const { zcodeSessionService } = useServices();
  const isOfficeMode = useIsOfficeMode();
  const isDev = useDev() !== null;
  const isMobileCompactViewport = useIsMobileCompactViewport();
  const sidePaneMemoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  const initialSidePaneMemoryState = readTaskSidePaneMemoryState(sidePaneMemoryKey);

  // 普通工作区沿用已保存的侧栏状态；Dev 在首次初始化当前 scope 时打开材料标签。
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(
    initialSidePaneMemoryState.sidePaneState,
  );
  const [isSidePaneCollapsed, setIsSidePaneCollapsedState] = useState(
    getSidePaneCollapsedPreference(initialSidePaneMemoryState, sidePaneOwnerId) ??
      initialSidePaneMemoryState.isSidePaneCollapsed,
  );
  // 交互说明：侧栏显隐按钮放在 App 外层，而不是 Sidebar 内部。
  // 这样即使侧栏被隐藏，入口也仍然留在左上角，不会出现"收起后没有地方再展开"的问题；
  // 同时这里统一处理 macOS 红绿灯安全区，避免按钮和系统窗口控件重叠。
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [allRecentClosedSidePaneTabs, setAllRecentClosedSidePaneTabs] = useState<
    RecentClosedSidePaneTab[]
  >([]);
  const lastActiveSubagentTabByRootRef = useRef<Map<string, string>>(new Map());
  const sidePaneOwnerIdRef = useRef(sidePaneOwnerId);
  sidePaneOwnerIdRef.current = sidePaneOwnerId;
  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  activeWorkspaceKeyRef.current = activeWorkspaceKey;
  const activeTabByOwnerRef = useRef<Map<string, string>>(new Map());
  const activeSidePaneMemoryKeyRef = useRef<string | null>(sidePaneMemoryKey);
  const initializedDevSidePaneScopesRef = useRef<Set<string>>(new Set());
  const latestSidePaneMemoryRef = useRef({
    sidePaneState,
    isSidePaneCollapsed,
  });
  latestSidePaneMemoryRef.current = {
    sidePaneState,
    isSidePaneCollapsed,
  };

  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    // 关闭等异步操作可能晚于 App 重挂；同步撤销旧实例，避免旧快照覆盖新实例的标签和折叠态。
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 折叠态参与同一批事件的后续决策，统一同步 ref，避免 React 提交前读到旧值。
  const setIsSidePaneCollapsed = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    if (!mountedRef.current) return;
    const next =
      typeof value === "function"
        ? value(latestSidePaneMemoryRef.current.isSidePaneCollapsed)
        : value;
    latestSidePaneMemoryRef.current.isSidePaneCollapsed = next;
    saveTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current, {
      isSidePaneCollapsed: next,
    });
    setIsSidePaneCollapsedState(next);
  }, []);

  const currentSidePaneScope = useCallback(
    () => ({
      workspaceKey: activeWorkspaceKeyRef.current,
      ownerTaskId: sidePaneOwnerIdRef.current,
    }),
    [],
  );

  const revealSidePaneForCurrentOwner = useCallback(() => {
    setIsSidePaneCollapsed(false);
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      false,
    );
  }, []);

  const commitSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      if (!mountedRef.current) return latestSidePaneMemoryRef.current.sidePaneState;
      const next = updater(latestSidePaneMemoryRef.current.sidePaneState);
      // 关闭末标签必须收敛到收起态；在此补建入口会让 Cmd/Ctrl+W 永远关闭不完。
      // 仅显式展开空面板时创建 new-tab，后台关闭也不能重新展开面板。
      if (getVisibleSidePaneTabs(next?.tabs ?? [], currentSidePaneScope()).length === 0) {
        setIsSidePaneCollapsed(true);
      }
      // 所有侧栏写入口统一先提交 canonical ref，保证交互与 lifecycle 严格按接收顺序合并。
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        sidePaneState: next,
      };
      // bridge 换代时，新组件先 render，旧组件后 cleanup；等卸载才保存会让新实例读到旧标签，
      // 留下仍存活却失去入口的 PTY。状态提交时同步写入既有 memory，使重挂读取同一份已提交状态。
      saveTaskSidePaneMemoryState(
        activeSidePaneMemoryKeyRef.current,
        latestSidePaneMemoryRef.current,
      );
      setSidePaneState(next);
      return next;
    },
    [currentSidePaneScope],
  );

  const commitOpenedSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      commitSidePaneState((current) => {
        const next = stampSidePaneTabsOwnership(updater(current), {
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
        });
        const launcher = getActiveSidePaneTab(current);
        const opened = getActiveSidePaneTab(next);
        const scope = currentSidePaneScope();
        // 新标签页被内容替换，保留原位置；后台或其他对话的打开事件不能消费当前入口。
        if (
          !next ||
          launcher?.type !== "new-tab" ||
          !opened ||
          opened.type === "new-tab" ||
          !isSidePaneTabVisibleInScope(launcher, scope) ||
          !isSidePaneTabVisibleInScope(opened, scope)
        )
          return next;
        const alreadyOpen = current?.tabs.some((tab) => tab.id === opened.id);
        return {
          ...next,
          tabs: alreadyOpen
            ? next.tabs.filter((tab) => tab.id !== launcher.id)
            : next.tabs.flatMap((tab) =>
                tab.id === launcher.id ? [opened] : tab.id === opened.id ? [] : [tab],
              ),
        };
      });
    },
    [commitSidePaneState, currentSidePaneScope],
  );
  const handleOpenDevMaterialsSidePane = useCallback(() => {
    if (!isDev) return;
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) =>
      activateDevMaterialsSidePane(current, currentSidePaneScope()),
    );
  }, [commitOpenedSidePaneState, currentSidePaneScope, isDev, revealSidePaneForCurrentOwner]);


  useEffect(() => {
    const previousKey = activeSidePaneMemoryKeyRef.current;
    if (previousKey === sidePaneMemoryKey) {
      return;
    }

    // tabs/折叠态已在提交时保存，切换只恢复目标 workspace，不再用旧组件快照覆盖 memory。
    // 同一 workspace 内切换 task 不应该影响 side pane，所以 key 已经不再按 task 维度切分。
    const restored = readTaskSidePaneMemoryState(sidePaneMemoryKey);
    activeSidePaneMemoryKeyRef.current = sidePaneMemoryKey;
    const collapsed =
      getSidePaneCollapsedPreference(restored, sidePaneOwnerIdRef.current) ??
      restored.isSidePaneCollapsed;
    setIsSidePaneCollapsed(collapsed);
    commitSidePaneState(() => restored.sidePaneState);
  }, [commitSidePaneState, sidePaneMemoryKey]);

  useEffect(() => {
    commitSidePaneState((current) => {
      const scopeKey = `${activeWorkspaceKey}::${sidePaneOwnerId ?? "__draft__"}`;
      const preferredTabId =
        activeTabByOwnerRef.current.get(scopeKey) ??
        (activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : undefined);
      const collapsedPreference = getSidePaneCollapsedPreference(
        readTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current),
        sidePaneOwnerId,
      );
      const resolved = resolveSidePaneScopeState(
        current,
        {
          workspaceKey: activeWorkspaceKey,
          ownerTaskId: sidePaneOwnerId,
        },
        preferredTabId,
        collapsedPreference,
      );
      setIsSidePaneCollapsed(resolved.isSidePaneCollapsed);
      logger.debug("[App] 同步对话右侧面板 scope", {
        activeTabId: resolved.sidePaneState?.activeTabId ?? null,
        activeTaskId,
        isSidePaneCollapsed: resolved.isSidePaneCollapsed,
        ownerTaskId: sidePaneOwnerId,
        preferredTabId: preferredTabId ?? null,
        workspaceKey: activeWorkspaceKey,
      });
      return resolved.sidePaneState;
    });
    const scopeKey = `${activeWorkspaceKey}::${sidePaneOwnerId ?? "__draft__"}`;
    if (!isDev) {
      initializedDevSidePaneScopesRef.current.clear();
    } else if (!initializedDevSidePaneScopesRef.current.has(scopeKey)) {
      initializedDevSidePaneScopesRef.current.add(scopeKey);
      handleOpenDevMaterialsSidePane();
      // 手机首次进入会话时保留材料标签，但不让抽屉自动盖住聊天和输入。
      // 后续显式打开仍使用同一面板；桌面继续默认显示材料。
      if (isMobileCompactViewport) setIsSidePaneCollapsed(true);
    }
  }, [
    activeTaskId,
    activeWorkspaceKey,
    commitSidePaneState,
    handleOpenDevMaterialsSidePane,
    isMobileCompactViewport,
    isDev,
    sidePaneOwnerId,
  ]);

  const pendingFileManagerTarget = useOptionalTabStore((state) => state.pendingFileManagerTarget);
  const requestFileManager = useOptionalTabStore((state) => state.requestFileManager);
  const consumeFileManager = useOptionalTabStore((state) => state.consumeFileManager);
  const handleOpenFileManager = useCallback(
    (target?: FileManagerTarget) => {
      if (
        target &&
        !target.temporaryExternalDirectory &&
        (target.workspaceIdentity?.trim() || target.workspacePath) !== activeWorkspaceKeyRef.current
      ) {
        requestFileManager(target);
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openFileManagerSidePane(
          current,
          target ?? {
            workspacePath: workspaceAbsPath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
          },
        ),
      );
    },
    [
      requestFileManager,
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    ],
  );

  useEffect(() => {
    if (!pendingFileManagerTarget) return;
    const targetKey =
      pendingFileManagerTarget.workspaceIdentity?.trim() || pendingFileManagerTarget.workspacePath;
    if (targetKey !== activeWorkspaceKey) return;
    // 必须在本 hook 恢复目标 workspace 的 pane memory 和 owner 之后消费，不能由子 Shell effect 抢先写入旧桶。
    if (!consumeFileManager(pendingFileManagerTarget)) return;
    logger.debug("[FileManager] 在目标工作区打开目录", {
      workspaceKey: targetKey,
      ownerTaskId: sidePaneOwnerIdRef.current,
    });
    handleOpenFileManager(pendingFileManagerTarget);
  }, [pendingFileManagerTarget, activeWorkspaceKey, consumeFileManager, handleOpenFileManager]);

  const handleNavigateFileManager = useCallback(
    (tabId: string, source: CodeViewerSource) => {
      commitSidePaneState((current) => navigateFileManagerSidePane(current, tabId, source));
    },
    [commitSidePaneState],
  );

  const handleOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePane(current, source, sidePaneOwnerIdRef.current);
        const activeTab = getActiveSidePaneTab(next);
        const activePath =
          activeTab?.type === "code-viewer" ? (activeTab.source.path ?? "none") : "none";
        logger.info(
          `[App] 切换右侧面板 mode=code-viewer workspace=${workspaceAbsPath} title=${source.title} path=${activePath} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenCodeViewers = useCallback(
    (sources: readonly CodeViewerSource[]) => {
      if (sources.length === 0) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePanes(current, sources, sidePaneOwnerIdRef.current, 0);
        logger.info(
          `[App] 批量打开右侧预览 workspace=${workspaceAbsPath} sources=${sources.length} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBrowserUrl = useCallback((url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const handleToggleGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const closingActiveGit = getActiveSidePaneTab(current)?.type === "git";
      const next = toggleGitSidePane(current);
      if (!closingActiveGit) {
        revealSidePaneForCurrentOwner();
      }
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 切换右侧面板 mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const next = activateGitSidePane(current);
      // 文件变更查找只需要“确保 Git 面板打开”，不能复用 toggle。
      // 如果当前已经在 Git tab 上，toggle 会把它关掉，导致切到文件变更范围反而看不到内容。
      revealSidePaneForCurrentOwner();
      logger.info(
        `[App] 打开右侧面板 mode=git workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenWhiteboard = useCallback(() => {
    const board = useWhiteboardStore.getState().createBoard({
      defaultNamePrefix: defaultWhiteboardNamePrefix,
      workspaceIdentity,
      workspacePath: workspaceAbsPath,
    });
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openWhiteboardSidePane(current, {
        boardId: board.id,
        title: board.name,
      });
      logger.info(
        `[App] 打开右侧面板 mode=whiteboard workspace=${workspaceAbsPath} board=${board.id} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    defaultWhiteboardNamePrefix,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  const handleOpenNewSidePaneTab = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState(activateNewTabSidePane);
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner]);


  const handleOpenDeveloperTools = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = activateDeveloperToolsSidePane(current);
      logger.info(
        `[App] 打开右侧面板 mode=developer-tools workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);


  const handleOpenModelTrajectory = useCallback(
    (params: { taskId: string; title?: string | null }) => {
      if (!params.taskId) {
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openModelTrajectorySidePane(current, params);
        logger.info(
          `[App] 打开右侧面板 mode=model-trajectory workspace=${workspaceAbsPath} taskId=${params.taskId} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBackgroundBash = useCallback(
    (request: OpenBackgroundBashSideTabRequest) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => openBackgroundBashSidePane(current, request));
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenScopedSubagentSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentSessionSidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
          childSessionId: request.childSessionId,
          subagentType: request.subagentType,
          title: request.title,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        logger.debug(
          `[App] 打开子智能体右侧 tab parent=${request.parentSessionId} child=${request.childSessionId} workspace=${workspaceKey}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentDirectory = useCallback(
    (request: OpenScopedSubagentDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentDirectorySidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleSyncSubagentSessionTabs = useCallback(
    (request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest) => {
      // 分支 edit/retry 的失效 tab 属于投影清理，不进入“最近关闭”。
      commitSidePaneState((current) => syncSubagentSessionSidePaneTabs(current, request));
    },
    [commitSidePaneState],
  );

  const handleOpenSelectionSideChat = useCallback(
    (request: OpenSelectionSideChatRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const staleTab = request.replacesChildSessionId
          ? current?.tabs.find(
              (tab) =>
                tab.type === "selection-side-chat" &&
                tab.workspaceKey === workspaceKey &&
                tab.parentSessionId === request.parentSessionId &&
                tab.childSessionId === request.replacesChildSessionId,
            )
          : undefined;
        const withoutStale = staleTab ? closeSidePaneTab(current, staleTab.id) : current;
        return openSelectionSideChatPane(withoutStale, {
          ...request,
          workspaceKey,
        });
      });
      logger.debug("[App] 打开框选副屏会话", {
        childSessionId: request.childSessionId,
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenPlanDetail = useCallback(
    (request: OpenScopedPlanDetailSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPlanDetailSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开计划详情右侧 tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );


  const handleOpenWorkflowRun = useCallback(
    (request: OpenScopedWorkflowRunSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      // 「配置」之后的原地替换不是一次打开：收起的侧栏保持收起。
      const replaceRunId = request.replaceRunId;
      if (replaceRunId === undefined) setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        replaceRunId === undefined
          ? openWorkflowRunSidePane(current, { ...request, workspaceKey })
          : replaceWorkflowRunSidePane(current, { ...request, workspaceKey, replaceRunId }),
      );
      logger.debug("[App] 打开工作流运行详情右侧 tab", {
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowRunDirectory = useCallback(
    (request: OpenScopedWorkflowRunDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowRunDirectorySidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流运行目录右侧 tab", {
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenScopedWorkflowActorSessionSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowActorSessionSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流 actor 会话右侧 tab", {
        actorSessionId: request.actorSessionId,
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenScopedWorkflowWorkspaceSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowWorkspaceSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流工作区右侧 tab", {
        parentSessionId: request.parentSessionId,
        phaseId: request.phaseId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenScopedWorkflowArtifactSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowArtifactSidePane(current, { ...request, workspaceKey }),
      );
    },
    [commitOpenedSidePaneState],
  );

  const closeSelectionSideChatRuntime = useCallback(
    (tab: Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }>) => {
      clearSelectionSideChat(tab.childSessionId);
      clearConversationSelectionReferenceScope(tab.childSessionId, tab.workspaceKey);
      void zcodeSessionService
        .closeSession({
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          sessionId: tab.childSessionId,
        })
        .catch((error) => {
          if (String(error).includes("sessionNotFound")) return;
          logger.warn("[App] 关闭框选副屏 runtime 失败", {
            childSessionId: tab.childSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [zcodeSessionService],
  );

  useEffect(() => {
    const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
    return subscribeTaskLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      clearConversationSelectionReferenceScope(event.taskId, event.workspaceKey);
      const closingTabs =
        latestSidePaneMemoryRef.current.sidePaneState?.tabs.filter(
          (tab): tab is Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }> =>
            tab.type === "selection-side-chat" && tab.parentSessionId === event.taskId,
        ) ?? [];
      if (closingTabs.length === 0) return;

      for (const tab of closingTabs) closeSelectionSideChatRuntime(tab);
      const closingIds = new Set(closingTabs.map((tab) => tab.id));
      commitSidePaneState((current) => {
        if (!current) return current;
        let next: WorkspaceSidePaneState | null = current;
        for (const tabId of closingIds) {
          next = closeSidePaneTabForScope(next, tabId, currentSidePaneScope());
        }
        return next;
      });
      logger.info("[App] 父任务结束，清理框选副屏会话", {
        event: event.type,
        parentSessionId: event.taskId,
        workspaceKey,
      });
    });
  }, [
    currentSidePaneScope,
    closeSelectionSideChatRuntime,
    commitSidePaneState,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  // 订阅“打开模型调用轨迹”请求：菜单深处通过单例 store 发起，这里按 workspaceKey 匹配后消费。
  useModelTrajectoryOpenBridge(
    workspaceIdentity?.trim() || workspaceAbsPath,
    handleOpenModelTrajectory,
  );


  const handleToggleSidebar = useCallback(() => {
    setIsSidebarVisible((visible) => !visible);
  }, []);

  const handleToggleSidePaneCollapse = useCallback(() => {
    const nextCollapsed = !latestSidePaneMemoryRef.current.isSidePaneCollapsed;
    setIsSidePaneCollapsed(nextCollapsed);
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      nextCollapsed,
    );
    // 与显隐在同一交互内提交，避免先显示特殊空态再由 effect 补建标签。
    if (!nextCollapsed)
      commitSidePaneState((current) => ensureSidePaneTab(current, currentSidePaneScope()));
    logger.info(
      `[App] ${nextCollapsed ? "收起" : "展开"}右侧面板 workspace=${workspaceAbsPath} tabs=${latestSidePaneMemoryRef.current.sidePaneState?.tabs.length ?? 0}`,
    );
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  const handleCloseCodeViewer = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=code-viewer workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeCodeViewerSidePane(current);
      return next;
    });
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  const handleCloseGit = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=git workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeGitSidePane(current);
      return next;
    });
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  const handleActivateSidePaneTab = useCallback(
    (tabId: string) => {
      commitSidePaneState((current) => {
        const target = current?.tabs.find((candidate) => candidate.id === tabId);
        if (target?.type === "subagent-session" || target?.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(target.rootSessionId, target.id);
        }
        return setActiveSidePaneTab(current, tabId);
      });
    },
    [commitSidePaneState],
  );

  const handleReorderSidePaneTab = useCallback(
    (activeTabId: string, overTabId: string) => {
      commitSidePaneState((current) => reorderSidePaneTab(current, activeTabId, overTabId));
    },
    [commitSidePaneState],
  );

  const rememberClosedSidePaneTabs = useCallback((tabs: WorkspaceSidePaneTab[]) => {
    const restorableTabs = tabs.filter(
      (tab) => tab.type !== "selection-side-chat" && tab.type !== "new-tab",
    );
    if (restorableTabs.length === 0) {
      return;
    }

    const closedAt = Date.now();
    setAllRecentClosedSidePaneTabs((current) => {
      const closingIds = new Set(restorableTabs.map((tab) => tab.id));
      return [
        ...restorableTabs.map((tab) => ({ tab, closedAt })),
        ...current.filter((item) => !closingIds.has(item.tab.id)),
      ].slice(0, RECENT_CLOSED_SIDE_PANE_TAB_LIMIT);
    });
  }, []);


  const closeSelectedSidePaneTabs = useCallback(
    (closingTabs: WorkspaceSidePaneTab[], preferredTabId?: string) => {
      if (closingTabs.length === 0) return;
      const scope = currentSidePaneScope();
      for (const tab of closingTabs) {
        if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
      }
      rememberClosedSidePaneTabs(closingTabs);
      const closingIds = closingTabs.map((tab) => tab.id);
      if (!mountedRef.current || scope.workspaceKey !== activeWorkspaceKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(scope.workspaceKey);
        const next = closeSidePaneTabs(stored.sidePaneState, closingIds, scope, preferredTabId);
        saveTaskSidePaneMemoryState(scope.workspaceKey, {
          sidePaneState: next,
          isSidePaneCollapsed: stored.isSidePaneCollapsed,
        });
      } else {
        const liveScope = currentSidePaneScope();
        commitSidePaneState((current) =>
          closeSidePaneTabs(
            current,
            closingIds,
            liveScope,
            liveScope.ownerTaskId === scope.ownerTaskId
              ? (preferredTabId ??
                  (liveScope.ownerTaskId
                    ? lastActiveSubagentTabByRootRef.current.get(liveScope.ownerTaskId)
                    : null))
              : undefined,
          ),
        );
      }
      logger.info("[App] 关闭右侧面板标签", { tabIds: closingIds, ...scope });
    },
    [
      closeSelectionSideChatRuntime,
      commitSidePaneState,
      currentSidePaneScope,
      rememberClosedSidePaneTabs,
    ],
  );

  const visibleSidePaneTabs = useCallback(
    () =>
      getVisibleSidePaneTabs(
        latestSidePaneMemoryRef.current.sidePaneState?.tabs ?? [],
        currentSidePaneScope(),
      ),
    [currentSidePaneScope],
  );

  const handleCloseSidePaneTab = useCallback(
    (tabId: string) => {
      void closeSelectedSidePaneTabs(visibleSidePaneTabs().filter((tab) => tab.id === tabId));
    },
    [closeSelectedSidePaneTabs, visibleSidePaneTabs],
  );

  const handleCloseOtherSidePaneTabs = useCallback(
    (tabId: string) => {
      const tabs = visibleSidePaneTabs();
      if (!tabs.some((tab) => tab.id === tabId)) return;
      void closeSelectedSidePaneTabs(
        tabs.filter((tab) => tab.id !== tabId),
        tabId,
      );
    },
    [closeSelectedSidePaneTabs, visibleSidePaneTabs],
  );

  const handleCloseAllSidePaneTabs = useCallback(() => {
    void closeSelectedSidePaneTabs(visibleSidePaneTabs());
  }, [closeSelectedSidePaneTabs, visibleSidePaneTabs]);

  const handleReopenClosedSidePaneTab = useCallback(
    (tabId: string) => {
      const item = allRecentClosedSidePaneTabs.find((entry) => entry.tab.id === tabId);
      if (
        !item ||
        !isSidePaneTabVisibleInScope(item.tab, currentSidePaneScope()) ||
        (isOfficeMode && item.tab.type === "git")
      )
        return;

      // 交互说明：最近关闭列表里的 tab 被点回打开时，需要同步展开右侧面板。
      // 否则 tab 状态已经恢复，但用户看到的还是折叠态，会误以为点击没有生效。
      revealSidePaneForCurrentOwner();
      commitSidePaneState((sidePaneCurrent) => {
        const restoredTab = item.tab;
        const next = restoreSidePaneTab(sidePaneCurrent, restoredTab);
        if (restoredTab.type === "subagent-session" || restoredTab.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(restoredTab.rootSessionId, restoredTab.id);
        }
        return next;
      });
      setAllRecentClosedSidePaneTabs((current) =>
        current.filter((entry) => entry.tab.id !== tabId),
      );
      logger.info(`[App] 重新打开最近关闭右侧面板 tab=${tabId} workspace=${workspaceAbsPath}`);
    },
    [
      isOfficeMode,
      allRecentClosedSidePaneTabs,
      currentSidePaneScope,
      commitSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
    ],
  );


  const recentClosedSidePaneTabs = useMemo(
    () =>
      allRecentClosedSidePaneTabs.filter(
        (item) =>
          isSidePaneTabVisibleInScope(item.tab, {
            workspaceKey: activeWorkspaceKey,
            ownerTaskId: sidePaneOwnerId,
          }) &&
          (!isOfficeMode || item.tab.type !== "git"),
      ),
    [activeWorkspaceKey, sidePaneOwnerId, allRecentClosedSidePaneTabs, isOfficeMode],
  );

  return {
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    handleOpenFileManager,
    handleNavigateFileManager,
    // 回调
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleOpenBrowserUrl,
    handleToggleGit,
    handleOpenGit,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenNewSidePaneTab,
    handleOpenDevMaterialsSidePane,
    handleOpenModelTrajectory,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    handleToggleSidebar,
    handleToggleSidePaneCollapse,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab,
  };
}
