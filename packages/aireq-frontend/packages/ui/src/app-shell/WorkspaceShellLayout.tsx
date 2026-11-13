import { AIReqIssuePages } from "@/aireq/AIReqIssuePages.js";
import { WorkspaceSidebarToolbar } from "@/WorkspaceSidebarToolbar.js";
import { AIReqFormalWorkspace } from "@/aireq/AIReqFormalProgress.js";
import { proposalProgressIndex, proposalViewedIndex } from "@/aireq/domain.js";
import { useOptionalAIReqDataSource } from "@/aireq/data-source.js";
import { AIReqEmptyState, AIReqProposalSrReadOnlyState } from "@/aireq/AIReqEmptyState.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useAIReq } from "@/aireq/AIReqContext.js";
import { conversationReadOnlyReason } from "@/aireq/domain.js";
import { DeferredAIReqRequirementAnalysisPage as AIReqRequirementAnalysisPage } from "@/app-shell/DeferredWorkspacePages.js";
import { DeferredAIReqSkillDesignPage as AIReqSkillDesignPage } from "@/app-shell/DeferredWorkspacePages.js";
import { DeferredAIReqAutomations as AIReqAutomations } from "@/app-shell/DeferredWorkspacePages.js";
import { AIReqSidebar, AIReqStageHeader } from "@/aireq/AIReqWorkbench.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  ReactNode,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { MessageCirclePlus } from "lucide-react";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { V4SplitPaneEntryProvider } from "@/v4/splitPaneEntryContext.js";
import {
  readFloatingAnchorPreference,
  SidePaneFullViewConversationHost,
  writeFloatingAnchorPreference,
  type FloatingAnchor,
  type SidePaneFullViewFloating,
  type SidePaneFullViewHostMode,
} from "@/side-pane-full-view/index.js";
import {
  SavedWorkflowHubProvider,
  type SavedWorkflowHubTarget,
} from "@/v4/savedWorkflowHubContext.js";
import {
  WorkflowRunOpenProvider,
  type WorkflowRunOpenTarget,
} from "@/v4/workflowRunOpenContext.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  selectWorkbenchSession,
  type WorkbenchSessionTarget,
} from "@/v4/workbenchSessionPlacement.js";
import {
  usePaneSessionPersistence,
  useRemotePaneSessionLookup,
} from "@/v4/usePaneSessionPersistence.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useNativeHostAvailable } from "@/hooks/useBackendBusinessAvailability.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

import { AUTOMATIONS_TOAST_ANCHOR_ID } from "@/settings/automationToastAnchor.js";
import { DeferredAutomationsSection as AutomationsSection } from "@/app-shell/DeferredWorkspacePages.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";
import { resolveTopOverlayLeadingPaddingClass, WorkspaceHeader } from "@/WorkspaceHeader.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { resolveWorkspaceShellPanelRadiusPx, resolveWorkspaceShellResizeHandleInsetPx } from "@/app-shell/workspaceShellWindowChrome.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf } from "@/lib/path.js";
import { setWorkspaceSidebarResizeActive } from "@/lib/workspaceSidebarResizeState.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { getActiveSelectionSideChatTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";

const MOBILE_VIEWPORT_QUERY = "(max-width: 767px)";
const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "zcode:workspace-shell:sidebar-width-px";
const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
const CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX = 360;
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
// 性能修复：ResizablePanelGroup 收到深相等的新 panelIds 数组，
// 会跟随 chat streaming render 重算布局上下文；固定数组语义上不会随消息变化。
const WORKSPACE_BODY_PANEL_IDS = ["conversation-column", "side-pane"];


type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

function clampWorkspaceSidebarWidth(widthPx: number, containerWidthPx?: number) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)));
}

function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = globalThis.__ompAIReqLocalStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkspaceSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = globalThis.__ompAIReqLocalStorage.getItem(LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    globalThis.__ompAIReqLocalStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
  } catch {
    // ignore
  }
}

function getIsMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_VIEWPORT_QUERY).matches
  );
}


export const WorkspaceShellLayout = memo(function WorkspaceShellLayout(
  props: WorkspaceShellLayoutProps,
) {
  return <WorkspaceShellLayoutContent {...props} />;
});

const WorkspaceShellLayoutContent = memo(function WorkspaceShellLayoutComponent({
  services,
  workspaceReadOnlyReason,
  workspaceMainView,
  openAutomationId,
  openAutomationTab,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSavedWorkflowInHub,
  onWorkspaceMainViewChange,
  onOpenAutomationConsumed,
  handleOpenAutomations,
  onCreateTask,
  onCreateConversationTask,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  allowOpenWorkspace = true,
  responsiveBrowserLayout = false,
  backendBusinessAvailable = true,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  workspaceShellZCodeState,
  theme,
  sidebarContainerRef,
  toggleSidebarShortcutLabel,
  goBackShortcutLabel,
  goForwardShortcutLabel,
  toggleSidePaneShortcutLabel,
  toggleSidePaneFullViewShortcutLabel,
  canTaskNavBack,
  canTaskNavForward,
  isSidebarVisible,
  isSidePaneOpen,
  sidePaneFullView,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  sidePaneState,
  recentClosedSidePaneTabs,
  projectName,
  workspaceTabs,
  activeTaskId,
  sidePaneOwnerId,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  activeTaskTitle,
  activeTaskChangeSummary,
  providerConfigFile,
  taskNativeSessionLogFile,
  taskSessionFile,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  conversationFindQuery,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  reloadSessionDisabled,
  reloadSessionPending,
  handleReloadSession,
  handleSelectTask,
  handleTaskNavBack,
  handleTaskNavForward,
  handleStartDraftInWorkspace,
  handleOpenCommandCenter,
  handleToggleSidebar,
  handleOpenDeveloperTools,
  handleToggleSidePane,
  handleOpenBrowserUrl,
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
  handleActivateSidePaneTab,
  handleOpenNewSidePaneTab,
  handleOpenAIReqMaterialsSidePane,
  handleReorderSidePaneTab,
  handleCloseSidePaneTab,
  handleCloseOtherSidePaneTabs,
  handleCloseAllSidePaneTabs,
  handleReopenClosedSidePaneTab,
  taskFindDialogProps,
}: WorkspaceShellLayoutProps) {
  const aireq = useAIReq();
  const fixedSidebar = aireq !== null;
  const aiReqSource = useOptionalAIReqDataSource();
  const aiReqSr = aireq?.view?.srs.find(item => item.id === aireq.selection.srId);
  const aiReqGroup = [...(aireq?.view?.groups ?? []), ...(aireq?.view?.drafts ?? [])].find(item => item.id === aireq?.selection.irId);
  const aiReqProposalSr = Boolean(aireq?.selection.srId && aireq.view?.drafts.some(item => item.id === aireq.selection.irId));
  const aiReqProposalHistory = !!aireq && !!aiReqGroup && !!aireq.view?.drafts.some(item => item.id === aiReqGroup.id) && proposalViewedIndex(aiReqGroup, aireq.selection) !== proposalProgressIndex(aiReqGroup, aireq.selection);
  const aiReqTargetWorkspace = aireq && aiReqSource ? aiReqSource.resolveWorkspace(aireq.view, aireq.selection) : undefined;
  const aiReqSwitching = !!aireq && (!aireq.selectionReady || aiReqTargetWorkspace?.path !== workspaceAbsPath || aiReqTargetWorkspace?.identity !== workspaceIdentity || (!!aireq.session && aireq.session.sessionId !== activeTaskId));
  const aiReqOwnershipReadOnlyReason = aiReqSwitching ? "正在切换需求，请等待当前会话就绪。" : aiReqSource ? conversationReadOnlyReason(aireq?.view, aireq?.selection ?? {}, aiReqSource.capabilities) : undefined;
  const aiReqFrozen = !!aireq && !aireq.selection.irAcceptance && !aireq.selection.srId && Boolean(aiReqGroup?.freeze);
  const aiReqEmpty = Boolean(aireq && !aireq.selection.freeSessionId && (!aireq.selection.irId || (!aireq.session && aiReqSr?.status !== "pending")));
  const aiReqFormalMode = Boolean(aireq?.selection.formalView || aireq?.view?.groups.some(group => group.id === aireq?.selection.irId));
  const { intl } = useZCodeIntl();
  const nativeHostAvailable = useNativeHostAvailable();
  const platform = usePlatform();
  const isOfficeMode = useIsOfficeMode();
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const usesResponsiveLayout = responsiveBrowserLayout;
  // Browser shells keep the upstream panel shape without restoring desktop window chrome.
  const workspacePanelRadiusPx = resolveWorkspaceShellPanelRadiusPx({});
  const workspaceResizeHandleInsetPx = resolveWorkspaceShellResizeHandleInsetPx({});
  const collapsedSidebarWidthPx = 0;
  const [draftHeaderDropTargetController, setDraftHeaderDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const [isMobileViewport, setIsMobileViewport] = useState(getIsMobileViewport);
  const restorePaneSession = useTabStore((state) =>
    state.tabs.some(
      (tab) =>
        isWorkspaceTab(tab) &&
        tab.restorePaneSession &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
    ),
  );
  const lookupPaneSession = useRemotePaneSessionLookup(
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  );
  // 页签决定启动位置，pane 复用既有选择持久化；services ready 前不查询远端。
  usePaneSessionPersistence({
    workspaceKey,
    activeSessionId: activeTaskId,
    draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
    restoreOnStartup: Boolean(isDesktop && restorePaneSession),
    selectSession: (sessionId) => handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity),
    lookupSession: isDesktop ? lookupPaneSession : undefined,
    onSessionMissing: () => handleStartDraftInWorkspace(workspaceAbsPath, workspaceIdentity),
  });
  const workspaceShellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const shell = workspaceShellRef.current;
    if (!shell) return;
    const scope =
      "[data-project-sidebar-panel], [data-workspace-conversation-frame], [data-workspace-side-frame]";
    const timers = new Map<HTMLElement, number>();
    let hovered: HTMLElement | null = null;
    let dragging = false;
    const animations = new Map<HTMLElement, Animation>();
    const setVisible = (element: HTMLElement, visible: boolean) => {
      if (element.hasAttribute("data-scrollbar-active") === visible) return;
      const current = getComputedStyle(element).getPropertyValue("--zcode-scrollbar-thumb");
      animations.get(element)?.cancel();
      element.toggleAttribute("data-scrollbar-active", visible);
      const target = visible
        ? getComputedStyle(element).getPropertyValue("--color-border")
        : "transparent";
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const animation = element.animate(
          [{ "--zcode-scrollbar-thumb": current }, { "--zcode-scrollbar-thumb": target }],
          { duration: 200, easing: "ease" },
        );
        animations.set(element, animation);
        animation.onfinish = () => {
          animations.delete(element);
        };
      }
    };
    const hideLater = (element: HTMLElement) => {
      window.clearTimeout(timers.get(element));
      timers.set(
        element,
        window.setTimeout(() => {
          timers.delete(element);
          if (element === hovered || dragging) return;
          setVisible(element, false);
        }, 1000),
      );
    };
    const reveal = (element: HTMLElement) => {
      setVisible(element, true);
      hideLater(element);
    };
    const onScroll = (event: Event) => {
      const element = event.target;
      if (element instanceof HTMLElement && element.closest(scope)) {
        element.setAttribute("data-scrollbar-container", "");
        reveal(element);
      }
    };
    let thumbHovered: HTMLElement | null = null;
    const setThumbHovered = (element: HTMLElement | null) => {
      if (thumbHovered === element) return;
      thumbHovered?.removeAttribute("data-scrollbar-hover");
      thumbHovered = element;
      element?.setAttribute("data-scrollbar-hover", "");
    };
    let pointerFrame = 0;
    let pendingPointer: MouseEvent | null = null;
    const updatePointer = (event: MouseEvent) => {
      let element = event.target instanceof HTMLElement ? event.target : null;
      let next: HTMLElement | null = null;
      if (!element || !element.closest(scope)) {
        setThumbHovered(null);
        if (hovered) hideLater(hovered);
        hovered = null;
        return;
      }
      while (element && shell.contains(element)) {
        if (
          element.scrollHeight <= element.clientHeight &&
          element.scrollWidth <= element.clientWidth
        ) {
          element = element.parentElement;
          continue;
        }
        const rect = element.getBoundingClientRect();
        const vertical =
          element.scrollHeight > element.clientHeight &&
          element.offsetWidth > element.clientWidth &&
          event.clientX >= rect.right - 10 &&
          event.clientX <= rect.right;
        const horizontal =
          element.scrollWidth > element.clientWidth &&
          element.offsetHeight > element.clientHeight &&
          event.clientY >= rect.bottom - 10 &&
          event.clientY <= rect.bottom;
        if (vertical || horizontal) {
          next = element;
          break;
        }
        element = element.parentElement;
      }
      if (!next) {
        // Query mounted nodes instead of retaining removed session/panel DOM in a Set.
        for (const candidate of shell.querySelectorAll<HTMLElement>("[data-scrollbar-container]")) {
          const rect = candidate.getBoundingClientRect();
          if (
            event.clientX >= rect.right - 14 &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom &&
            candidate.scrollHeight > candidate.clientHeight
          ) {
            next = candidate;
            break;
          }
        }
      }
      const previous = hovered;
      hovered = next;
      if (previous && previous !== next) hideLater(previous);
      let hitThumb = false;
      if (next) {
        reveal(next);
        const rect = next.getBoundingClientRect();
        const vertical = event.clientX >= rect.right - 14 && next.scrollHeight > next.clientHeight;
        const track = vertical ? next.clientHeight : next.clientWidth;
        const extent = vertical ? next.scrollHeight : next.scrollWidth;
        const offset = vertical ? next.scrollTop : next.scrollLeft;
        const length = Math.min(track, Math.max(32, (track * track) / extent));
        const start = extent > track ? (offset / (extent - track)) * (track - length) : 0;
        const position = vertical
          ? event.clientY - rect.top - next.clientTop
          : event.clientX - rect.left - next.clientLeft;
        hitThumb = position >= start && position <= start + length;
      }
      setThumbHovered(hitThumb ? next : null);
    };
    const onPointerMove = (event: MouseEvent) => {
      pendingPointer = event;
      if (pointerFrame) return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        if (pendingPointer) updatePointer(pendingPointer);
        pendingPointer = null;
      });
    };
    const onPointerDown = () => {
      dragging = thumbHovered !== null;
      if (dragging) thumbHovered?.setAttribute("data-scrollbar-dragging", "");
    };
    const onPointerUp = () => {
      dragging = false;
      shell
        .querySelectorAll("[data-scrollbar-dragging]")
        .forEach((element) => element.removeAttribute("data-scrollbar-dragging"));
      shell.querySelectorAll<HTMLElement>("[data-scrollbar-active]").forEach(hideLater);
    };
    const onPointerLeave = () => {
      cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      pendingPointer = null;
      setThumbHovered(null);
      const previous = hovered;
      hovered = null;
      if (previous) hideLater(previous);
    };
    const onBlur = () => {
      setThumbHovered(null);
      hovered = null;
      onPointerUp();
    };
    // 捕获真实滚动，不切换 overflow/宽度；每个滚动容器独立计时，避免内容抖动。
    shell.addEventListener("scroll", onScroll, true);
    shell.addEventListener("mousemove", onPointerMove, true);
    shell.addEventListener("mousedown", onPointerDown, true);
    shell.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onBlur);
    return () => {
      shell.removeEventListener("scroll", onScroll, true);
      shell.removeEventListener("mousemove", onPointerMove, true);
      shell.removeEventListener("mousedown", onPointerDown, true);
      shell.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onBlur);
      setThumbHovered(null);
      shell
        .querySelectorAll("[data-scrollbar-dragging]")
        .forEach((element) => element.removeAttribute("data-scrollbar-dragging"));
      cancelAnimationFrame(pointerFrame);
      timers.forEach(window.clearTimeout);
      timers.clear();
      shell
        .querySelectorAll("[data-scrollbar-container]")
        .forEach((element) => element.removeAttribute("data-scrollbar-container"));
      animations.forEach((animation) => animation.cancel());
      animations.clear();
      shell
        .querySelectorAll("[data-scrollbar-active]")
        .forEach((element) => element.removeAttribute("data-scrollbar-active"));
    };
  }, []);

  const workspaceSidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationAutoCollapseStateRef = useRef({
    handleToggleSidebar,
    handleToggleSidePane,
    isSidebarVisible,
    isSidePaneOpen,
    workspaceKey,
  });
  const conversationAutoCollapseResizeTimerRef = useRef<number | null>(null);
  const workspaceSidebarResizeSessionRef = useRef<WorkspaceSidebarResizeSession | null>(null);
  const [workspaceSidebarPanelWidthPx, setWorkspaceSidebarPanelWidthPx] = useState(
    () => readStoredWorkspaceSidebarWidthPx() ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  );
  const workspaceSidebarPanelWidthPxRef = useRef(workspaceSidebarPanelWidthPx);
  // 完整视图（docs/ui/side-pane-full-view.md）只读派生：不改侧栏、面板宽度等原有状态，退出后自然恢复。
  const fullViewController = sidePaneFullView;
  const activeFullView =
    workspaceMainView === "chat" ? (fullViewController?.fullView ?? null) : null;
  const isFullView = activeFullView !== null;
  const fullViewMode: SidePaneFullViewHostMode = !activeFullView
    ? "normal"
    : activeFullView.surface === "conversation"
      ? "conversation"
      : "floating";
  const isFloatingFullView = fullViewMode === "floating";
  const isFullViewRef = useRef(isFullView);
  isFullViewRef.current = isFullView;
  const [fullViewSlotElement, setFullViewSlotElement] = useState<HTMLDivElement | null>(null);
  const [floatingAnchor, setFloatingAnchor] = useState<FloatingAnchor>(
    readFloatingAnchorPreference,
  );
  const handleFloatingAnchorChange = useCallback((anchor: FloatingAnchor) => {
    setFloatingAnchor(anchor);
    writeFloatingAnchorPreference(anchor);
  }, []);
  const handleFullViewFloatingChange = useCallback(
    (floating: SidePaneFullViewFloating) => fullViewController?.setFloating(floating),
    [fullViewController],
  );
  const handleOpenFullViewConversation = useCallback(
    () => fullViewController?.setSurface("conversation"),
    [fullViewController],
  );
  const fullViewConversationTitle =
    activeTaskTitle?.trim() || intl.formatMessage({ id: "taskList.untitled" });
  // 完整视图保留左侧任务列表与左上角按钮组，侧栏显隐只由用户开关决定。
  const isSidebarPanelVisible = fixedSidebar || isSidebarVisible;
  const sidebarNavigation = {
    expanded: isSidebarPanelVisible,
    collapsible: !fixedSidebar,
    onToggle: handleToggleSidebar,
    canGoBack: aireq ? aireq.canGoBack : canTaskNavBack,
    canGoForward: aireq ? aireq.canGoForward : canTaskNavForward,
    onGoBack: aireq ? aireq.goBack : handleTaskNavBack,
    onGoForward: aireq ? aireq.goForward : handleTaskNavForward,
    toggleShortcut: fixedSidebar ? undefined : toggleSidebarShortcutLabel,
    backShortcut: goBackShortcutLabel,
    forwardShortcut: goForwardShortcutLabel,
    onCreate: () => { if (aireq) aireq.startProposalDraft(); else handleCreateTaskInChat(); },
    createLabel: aireq ? "新建需求提案" : undefined,
    createDisabled: aireq ? aireq.pending || !aireq.selection.projectId || !aireq.releaseId || !aiReqSource?.capabilities.workflowCommands.includes("createProposal") : Boolean(workspaceReadOnlyReason),
  };

  const {
    panelRef: sidePanePanelRef,
    panelElementRef: sidePanePanelElementRef,
    isVisible: isSidePaneVisible,
  } = useAnimatedResizablePanel({
    open: workspaceMainView === "chat" && isSidePaneOpen,
    expandedSize: SIDE_PANE_DEFAULT_EXPANDED_SIZE,
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
  });
  const mobileSidePanePanelRef = useRef<PanelImperativeHandle | null>(null);
  const mobileSidePanePanelElementRef = useRef<HTMLDivElement | null>(null);
  const workspaceSessionActionDisabled =
    Boolean(workspaceReadOnlyReason) || reloadSessionDisabled || reloadSessionPending;
  const simplifyHeaderForNarrowViewport = usesResponsiveLayout && isMobileViewport;
  const workspaceSidebarResizeLabel = intl.formatMessage({
    id: "workspaceSidebar.resizeSidebar",
  });

  useEffect(() => {
    conversationAutoCollapseStateRef.current = {
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      workspaceKey,
    };
  }, [handleToggleSidebar, handleToggleSidePane, isSidebarVisible, isSidePaneOpen, workspaceKey]);

  useEffect(() => {
    if (workspaceMainView !== "chat") {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const readConversationWidthPx = () =>
      conversationPanelElementRef.current?.getBoundingClientRect().width ?? null;

    const collapseSidebarIfStillNarrow = () => {
      if (fixedSidebar) return;
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidebar: collapseSidebar,
        isSidebarVisible: latestIsSidebarVisible,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      if (latestIsSidebarVisible && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起左侧栏", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidebar();
      }
    };

    const runAutoCollapseForWindowResize = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidePane: collapseSidePane,
        isSidePaneOpen: latestIsSidePaneOpen,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;
      // 完整视图中对话由宿主 fixed 定位，对话列宽度不代表可见对话区，不能据此收起面板或侧栏。
      if (isFullViewRef.current) {
        return;
      }

      // 功能说明：自动收起只响应用户改变窗口尺寸后的 conversation 实际宽度。
      // 不监听 conversation 自身 ResizeObserver，避免用户手动打开面板时又被策略关回去。
      if (latestIsSidePaneOpen && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起右侧面板", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidePane();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(collapseSidebarIfStillNarrow);
        });
        return;
      }

      collapseSidebarIfStillNarrow();
    };

    const handleWindowResize = () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
      }

      // Bugfix: 大会话 resize trace 显示自动收起侧栏会触发 WorkspaceSidebar
      // 和大量 tooltip/menu 子树重渲染；拖拽窗口过程中先等 resize idle，再保留原收起语义。
      conversationAutoCollapseResizeTimerRef.current = window.setTimeout(() => {
        conversationAutoCollapseResizeTimerRef.current = null;
        runAutoCollapseForWindowResize();
      }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };

    window.addEventListener("resize", handleWindowResize);

    return () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
        conversationAutoCollapseResizeTimerRef.current = null;
      }
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [workspaceMainView, fixedSidebar]);

  useEffect(() => {
    workspaceSidebarPanelWidthPxRef.current = workspaceSidebarPanelWidthPx;
  }, [workspaceSidebarPanelWidthPx]);

  const applyWorkspaceSidebarWidthDuringDrag = useCallback(
    (nextWidthPx: number) => {
      workspaceSidebarPanelWidthPxRef.current = nextWidthPx;
      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      // Bugfix: 大会话 trace 显示拖拽侧栏时每个 pointermove 都 setState，
      // 会让 WorkspaceShellLayout、WorkspaceSidebar 和 ChatView 大树反复 render。
      // 拖拽中的宽度只是瞬时布局值，直接写 CSS 变量；释放时再提交 React state。
      shellElement.style.setProperty(
        WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR,
        `${isSidebarPanelVisible ? nextWidthPx : collapsedSidebarWidthPx}px`,
      );
      shellElement.style.setProperty(WORKSPACE_SIDEBAR_WIDTH_CSS_VAR, `${nextWidthPx}px`);
    },
    [collapsedSidebarWidthPx, isSidebarPanelVisible],
  );

  useEffect(() => {
    if (readStoredWorkspaceSidebarWidthPx() !== null) {
      return;
    }

    const legacyRatio = readLegacyWorkspaceSidebarWidthRatio();
    const shellElement = workspaceShellRef.current;
    if (legacyRatio === null || !shellElement) {
      return;
    }

    const containerWidthPx = shellElement.getBoundingClientRect().width;
    if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
      return;
    }

    // 修复原因：外层 workspace shell 不再使用 react-resizable-panels，
    // 但旧版本已持久化过 sidebar/content 百分比。迁移成像素宽度后，
    // 普通窗口 resize 不会再触发 RRP layout store，同时仍保留用户拖出的侧栏宽度。
    const migratedWidthPx = clampWorkspaceSidebarWidth(
      containerWidthPx * legacyRatio,
      containerWidthPx,
    );
    workspaceSidebarPanelWidthPxRef.current = migratedWidthPx;
    setWorkspaceSidebarPanelWidthPx(migratedWidthPx);
    persistWorkspaceSidebarWidthPx(migratedWidthPx);
  }, []);

  const applyWorkspaceSidebarWidth = useCallback(
    (nextWidthPx: number, options: { persist: boolean }) => {
      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const resolvedWidthPx = clampWorkspaceSidebarWidth(nextWidthPx, containerWidthPx);
      workspaceSidebarPanelWidthPxRef.current = resolvedWidthPx;
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) =>
        currentWidthPx === resolvedWidthPx ? currentWidthPx : resolvedWidthPx,
      );
      if (options.persist) {
        persistWorkspaceSidebarWidthPx(resolvedWidthPx);
      }
      return resolvedWidthPx;
    },
    [],
  );

  const handleWorkspaceSidebarResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      const containerWidthPx = shellElement.getBoundingClientRect().width;
      workspaceSidebarResizeSessionRef.current = {
        containerWidthPx,
        pointerId: event.pointerId,
        startWidthPx: workspaceSidebarPanelWidthPxRef.current,
        startX: event.clientX,
      };
      setWorkspaceSidebarResizeActive({
        active: true,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [isSidebarPanelVisible],
  );

  const handleWorkspaceSidebarResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const nextWidthPx = clampWorkspaceSidebarWidth(
        resizeSession.startWidthPx + event.clientX - resizeSession.startX,
        resizeSession.containerWidthPx,
      );
      applyWorkspaceSidebarWidthDuringDrag(nextWidthPx);
      event.currentTarget.setAttribute("aria-valuenow", String(Math.round(nextWidthPx)));
    },
    [applyWorkspaceSidebarWidthDuringDrag],
  );

  const finishWorkspaceSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      workspaceSidebarResizeSessionRef.current = null;
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) => {
        const finalWidthPx = workspaceSidebarPanelWidthPxRef.current;
        return currentWidthPx === finalWidthPx ? currentWidthPx : finalWidthPx;
      });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!cancelled) {
        persistWorkspaceSidebarWidthPx(workspaceSidebarPanelWidthPxRef.current);
      }
    },
    [],
  );

  const handleWorkspaceSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible) {
        return;
      }

      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const maxWidthPx =
        containerWidthPx && containerWidthPx > 0
          ? containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO
          : workspaceSidebarPanelWidthPxRef.current;
      let nextWidthPx: number | null = null;

      if (event.key === "ArrowLeft") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current - WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "ArrowRight") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current + WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "Home") {
        nextWidthPx = WORKSPACE_SIDEBAR_MIN_WIDTH_PX;
      } else if (event.key === "End") {
        nextWidthPx = maxWidthPx;
      }

      if (nextWidthPx === null) {
        return;
      }

      event.preventDefault();
      applyWorkspaceSidebarWidth(nextWidthPx, { persist: true });
    },
    [applyWorkspaceSidebarWidth, isSidebarPanelVisible],
  );

  useEffect(() => {
    return () => {
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
    };
  }, []);

  useEffect(() => {
    if (
      !usesResponsiveLayout ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQueryList = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const syncMobileViewport = () => {
      setIsMobileViewport(mediaQueryList.matches);
    };

    syncMobileViewport();
    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", syncMobileViewport);
      return () => {
        mediaQueryList.removeEventListener("change", syncMobileViewport);
      };
    }

    mediaQueryList.addListener(syncMobileViewport);
    return () => {
      mediaQueryList.removeListener(syncMobileViewport);
    };
  }, [usesResponsiveLayout]);

  const activeSearchResultHighlightRequest = useMemo(() => {
    if (!searchResultHighlightRequest || searchResultHighlightRequest.taskId !== activeTaskId) {
      return null;
    }

    const activeWorkspaceKey = buildTaskWorkspaceKey(workspaceAbsPath, workspaceIdentity);
    const requestWorkspaceKey = buildTaskWorkspaceKey(
      searchResultHighlightRequest.workspacePath,
      searchResultHighlightRequest.workspaceIdentity,
    );
    return activeWorkspaceKey === requestWorkspaceKey ? searchResultHighlightRequest : null;
  }, [activeTaskId, searchResultHighlightRequest, workspaceAbsPath, workspaceIdentity]);
  const renderChatFindDialog = () => <TaskFindDialog {...taskFindDialogProps} placement="chat" />;
  const showChatMainView = useCallback(() => {
    onWorkspaceMainViewChange("chat");
  }, [onWorkspaceMainViewChange]);
  const handleCreateTaskInChat = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      // workspaceReadOnlyReason 判定的是活动 workspace；当 request 显式带 targetWorkspace 时
      // 目标另属他项目（跨项目发起已保存工作流，docs/dynamic-workflow/launch.md「The detail page」），
      // 活动 workspace 的只读性不适用，真正的守卫是 root 动作对 target 的 isWorkspaceReadOnly。
      const hasTargetWorkspace =
        typeof request === "object" && request !== null && Boolean(request.targetWorkspace);
      if (!hasTargetWorkspace && workspaceReadOnlyReason) {
        return;
      }
      showChatMainView();
      onCreateTask(request);
    },
    [onCreateTask, showChatMainView, workspaceReadOnlyReason],
  );
  const shellWorkbenchBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      activeTaskId
        ? {
            workspaceScope: {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
              ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
            },
            sessionId: activeTaskId,
          }
        : null,
    [activeTaskId, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId],
  );
  // 切入草稿曾改变侧栏选任务回调，让全部项目重渲染；点击时使用最近已提交的绑定，保留分屏导航语义。
  const shellWorkbenchBindingRef = useRef(shellWorkbenchBinding);
  useLayoutEffect(() => {
    shellWorkbenchBindingRef.current = shellWorkbenchBinding;
  }, [shellWorkbenchBinding]);
  const handleCreateAutomationInChat = useCallback(
    (prompt: string, targetWorkspace?: { workspacePath: string; workspaceIdentity?: string }) => {
      // 带 target 时跳过活动 workspace 只读检查，交由 handleCreateTaskInChat / root 动作在
      // target 上校验（docs/dynamic-workflow/launch.md「The detail page」）；无 target 时形状不变。
      if (!targetWorkspace && workspaceReadOnlyReason) return;
      handleCreateTaskInChat({
        initialPrompt: prompt,
        ...(targetWorkspace ? { targetWorkspace } : {}),
      });
    },
    [handleCreateTaskInChat, workspaceReadOnlyReason],
  );
  // 工作流「运行」现由中枢直接启动（docs/dynamic-workflow/launch.md）：GUI 建空会话 +
  // 发 startSavedWorkflow 命令，不再合成对话文案。本层只在 accepted 后把会话切到前台。
  const handleSelectTaskInChat = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      targetRemoteSessionId?: string,
      expectedUnreadAt?: number,
    ) => {
      if (nativeHostAvailable) {
        // History visibility does not admit or switch its cwd. Continue performs that
        // explicit operation and reconnects the destination project before execution.
        selectWorkbenchSession(shellWorkbenchBindingRef.current, {
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          sessionId: taskId,
        });
        showChatMainView();
        handleSelectTask(workspaceAbsPath, taskId, workspaceIdentity, expectedUnreadAt);
        return true;
      }
        const workspaceResult = ensureTaskNavigationWorkspace({
          workspacePath: targetWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          activateTabByPath: tabStoreApi.getState().activateTabByPath,
          addLocalWorkspaceTab: (workspacePath) => {
            tabStoreApi.getState().addTab(workspacePath);
          },
        });
        if (!workspaceResult.accepted) {
          logger.warn("[automations] 运行历史目标远程 workspace 未连接，保留当前页面", {
            sessionId: taskId,
            workspaceIdentity: targetWorkspaceIdentity,
            workspacePath: targetWorkspacePath,
          });
          toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
          return false;
        }
        if (workspaceResult.openedLocalTab) {
          logger.info("[automations] 为运行历史会话补开本地 workspace tab", {
            sessionId: taskId,
            workspacePath: targetWorkspacePath,
          });
        }
        const resolvedRemoteSessionId =
          targetRemoteSessionId ??
          workspaceTabs.find(
            (tab) =>
              (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
              (targetWorkspaceIdentity?.trim() || targetWorkspacePath),
          )?.remoteSessionId;
        const target: WorkbenchSessionTarget = {
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity?.trim()
            ? { workspaceIdentity: targetWorkspaceIdentity }
            : {}),
          ...(resolvedRemoteSessionId ? { remoteSessionId: resolvedRemoteSessionId } : {}),
          sessionId: taskId,
        };
        selectWorkbenchSession(shellWorkbenchBindingRef.current, target);
      // 只有目标 workspace 已经激活或补开成功后才关闭 Automations，避免失败时看起来像跳转成功。
      showChatMainView();
      if (typeof expectedUnreadAt === "number") {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity, expectedUnreadAt);
      } else {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      }
      return true;
    },
    [handleSelectTask, intl, nativeHostAvailable, showChatMainView, tabStoreApi,
      workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  // 中枢直接启动 accepted 后切到新会话（run 卡已在顶部）：复用运行历史那条导航，
  // target 恒带工作流所属项目坐标（不变式 7），remoteSessionId 决定连接 endpoint。
  // 「已保存」芯片的落点：交给 App 切主视图并设深链（与「自动化」入口同一条导航历史）。
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      onOpenSavedWorkflowInHub(target);
    },
    [onOpenSavedWorkflowInHub],
  );
  const handleNavigateToLaunchedRun = useCallback(
    (target: SavedWorkflowLaunchTarget, sessionId: string) => {
      handleSelectTaskInChat(
        target.workspacePath,
        sessionId,
        target.workspaceIdentity,
        target.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );
  // 工作流运行历史「查看实例」：先回到发起它的会话（侧栏页只在 chat 视图里可见），再开实例详情页。
  const handleOpenSavedWorkflowRun = useCallback(
    (params: SavedWorkflowsOpenRunParams) => {
      // 中枢是跨项目视图：实例必须开在发起它的项目，而非活动项目（不变式 8）。
      // params 恒带 workspacePath/identity；仅在异常缺省时兜底回退到活动 workspace。
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      // remoteSessionId 不在契约里：按目标 workspace 从已打开 tab 反查；命中活动项目即取活动值。
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowRun({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        toolCallId: params.toolCallId,
        runId: params.runId,
        workflowName: params.workflowName,
      });
    },
    [
      handleOpenWorkflowRun,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  // 侧栏运行行（docs/dynamic-workflow/presentation.md「The sidebar run line」）：与 composer 徽标
  // 同一跳转——先选中会话，再开 run pane。没有 toolCallId 的 run（不该有）只选中会话。
  const handleOpenSidebarWorkflowRun = useCallback(
    (target: WorkflowRunOpenTarget) => {
      if (target.run.toolCallId === undefined) {
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === target.workspacePath &&
            (!target.workspaceIdentity || tab.workspaceIdentity === target.workspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          target.workspacePath,
          target.sessionId,
          target.workspaceIdentity,
          targetRemoteSessionId,
        );
        return;
      }
      handleOpenSavedWorkflowRun({
        sessionId: target.sessionId,
        runId: target.run.runId,
        toolCallId: target.run.toolCallId,
        workflowName: target.run.name ?? "",
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [handleOpenSavedWorkflowRun, handleSelectTaskInChat, workspaceTabs],
  );
  // 中枢的产物 chip：与「查看实例」逐字同构（同一条「先回到发起它的会话」的路径），
  // 只是终点是 `workflow-artifact` tab 而不是 run 详情页。
  const handleOpenSavedWorkflowArtifact = useCallback(
    (params: SavedWorkflowsOpenArtifactParams) => {
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowArtifact({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.title === undefined ? {} : { title: params.title }),
        // 中枢的 chip 载荷带得到 contentType（html 产物据它直接开浏览器 tab）；`sourcePath`
        // 那份载荷没有，由 `handleOpenWorkflowArtifact` 自己查 journal 补。
        ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
      });
    },
    [
      handleOpenWorkflowArtifact,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  const handlePaneActiveSessionChange = useCallback(
    (
      scope: {
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
      },
      sessionId: string,
    ) => {
      handleSelectTaskInChat(
        scope.workspacePath,
        sessionId,
        scope.workspaceIdentity,
        scope.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );

  const handleStartDraftInWorkspaceInChat = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
    ) => {
      if (nativeHostAvailable) {
        if (targetWorkspacePath !== workspaceAbsPath) {
          void platform.activateOrSetWorkspace(targetWorkspacePath).catch((error) => {
            toast(error instanceof Error ? error.message : String(error));
          });
        } else showChatMainView();
        return;
      }
      showChatMainView();
      handleStartDraftInWorkspace(
        targetWorkspacePath,
        targetWorkspaceIdentity,
        targetWorkspacePurpose,
      );
    },
    [handleStartDraftInWorkspace, nativeHostAvailable, platform, showChatMainView, workspaceAbsPath],
  );
  const handleCreateProjectDraft = useCallback(
    (path: string, identity?: string) =>
      handleStartDraftInWorkspaceInChat(path, identity),
    [handleStartDraftInWorkspaceInChat],
  );
  const handleSelectConversationWorkspace = useCallback(async () => {
    if (!onResolveConversationWorkspace) {
      return;
    }
    let target: Awaited<ReturnType<typeof onResolveConversationWorkspace>>;
    try {
      target = await onResolveConversationWorkspace();
    } catch (error) {
      logger.error("[WorkspaceShellLayout] 切换对话 workspace 失败", {
        error,
      });
      return;
    }
    // Bug 原因：这里曾用 targetWorkspacePath 在 workspaceTabs 里反查 conversation tab 的 identity。
    // 多设备的 conversation backing path 同为各自 home 下的固定目录，home 相同时会命中别的设备。
    // 现在 identity 由 Root 按 Source 归属解析后一并回传，Shell 直接消费，不再按路径判等。
    const targetWorkspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
    if ((workspaceIdentity?.trim() || workspaceAbsPath) !== targetWorkspaceKey) {
      requestV4ComposerDraftWorkspaceTransfer({
        sourceWorkspacePath: workspaceAbsPath,
        sourceWorkspaceIdentity: workspaceIdentity,
        targetWorkspacePath: target.workspacePath,
        targetWorkspaceIdentity: target.workspaceIdentity,
      });
    }
    handleStartDraftInWorkspaceInChat(
      target.workspacePath,
      target.workspaceIdentity,
      "conversation",
    );
  }, [
    handleStartDraftInWorkspaceInChat,
    onResolveConversationWorkspace,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  // v4 pane 生命周期回调（稳定引用，供 memo 友好的 pane 宿主消费）：
  // createSession/fork 后接入既有选择路径；删除会话后回 draft。
  const handleV4SessionCreated = useCallback(
    (sessionId: string) => {
      handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity);
    },
    [handleSelectTask, workspaceAbsPath, workspaceIdentity],
  );
  const draftComposerHeader = useMemo(
    () =>
      nativeHostAvailable ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="native-session-create"
          onClick={() => handleCreateTaskInChat()}
        >
          <MessageCirclePlus className="size-4" />
          {intl.formatMessage({ id: "taskList.newThread" })}
        </Button>
      ) : null,
    [handleCreateTaskInChat, intl, nativeHostAvailable],
  );
  const handleV4SessionDeleted = useCallback(() => {
    if (activeTaskId) {
      for (const tab of sidePaneState?.tabs ?? []) {
        if (tab.type === "selection-side-chat" && tab.parentSessionId === activeTaskId) {
          handleCloseSidePaneTab(tab.id);
        }
      }
    }
    handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity);
  }, [
    activeTaskId,
    handleCloseSidePaneTab,
    handleStartDraftInWorkspaceInChat,
    sidePaneState?.tabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const workspaceShellSplitStyle = useMemo(
    () =>
      ({
        "--workspace-sidebar-panel-width": `${
          isSidebarPanelVisible ? workspaceSidebarPanelWidthPx : collapsedSidebarWidthPx
        }px`,
        "--workspace-sidebar-width": `${workspaceSidebarPanelWidthPx}px`,
        "--workspace-panel-radius": `${workspacePanelRadiusPx}px`,
        "--workspace-resize-handle-inset": `${workspaceResizeHandleInsetPx}px`,
      }) as CSSProperties,
    [
      collapsedSidebarWidthPx,
      isSidebarPanelVisible,
      workspacePanelRadiusPx,
      workspaceResizeHandleInsetPx,
      workspaceSidebarPanelWidthPx,
    ],
  );
  const activeSelectionSideChatSessionId = activeTaskId
    ? (getActiveSelectionSideChatTab(sidePaneState, {
        workspaceKey,
        parentSessionId: activeTaskId,
      })?.childSessionId ?? null)
    : null;
  const handleOpenSelectionSideConversationLauncher = useCallback(() => {
    if (!activeTaskId) return;
    const requested = requestSelectionSideChatOpen(
      buildSelectionSideChatKey(workspaceKey, activeTaskId),
    );
    if (!requested) {
      // 固定入口由当前主 SessionPane 承接命令；若 pane 尚未挂载，不允许壳层自行拼接远程身份或协议。
      logger.warn("[WorkspaceShell] 辅助对话入口没有可用的主会话控制器", {
        parentSessionId: activeTaskId,
        workspaceKey,
      });
    }
  }, [activeTaskId, workspaceKey]);
  const renderSidePanePanel = (options: { mobileOverlay?: boolean } = {}) => (
    <AnimatedSidePanePanel
      services={services}
      isDesktop={isDesktop}
      isVisible={
        isWorkspaceVisible &&
        workspaceMainView === "chat" &&
        isSidePaneOpen &&
        (options.mobileOverlay || isSidePaneVisible)
      }
      onCloseSidePane={handleToggleSidePane}
      toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
      fullViewToggle={
        !options.mobileOverlay && fullViewController
          ? {
              active: isFullView,
              onToggle: fullViewController.toggle,
              shortcutLabel: toggleSidePaneFullViewShortcutLabel,
            }
          : undefined
      }
      fullView={
        !options.mobileOverlay && activeFullView && fullViewController
          ? {
              surface: activeFullView.surface,
              conversationTitle: fullViewConversationTitle,
              leadingInsetClassName: resolveTopOverlayLeadingPaddingClass({
                isSidebarVisible,
              }),
              onSelectSurface: fullViewController.setSurface,
            }
          : null
      }
      fullViewSlotRef={options.mobileOverlay ? undefined : setFullViewSlotElement}
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={recentClosedSidePaneTabs}
      workspaceAbsPath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      activeTaskId={activeTaskId}
      sidePaneOwnerId={sidePaneOwnerId}
      panelRef={options.mobileOverlay ? mobileSidePanePanelRef : sidePanePanelRef}
      panelElementRef={
        options.mobileOverlay ? mobileSidePanePanelElementRef : sidePanePanelElementRef
      }
      onActivateTab={handleActivateSidePaneTab}
      onOpenNewTab={handleOpenNewSidePaneTab}
      onOpenAIReqMaterials={handleOpenAIReqMaterialsSidePane}
      onReorderTab={handleReorderSidePaneTab}
      onCloseTab={handleCloseSidePaneTab}
      onCloseOtherTabs={handleCloseOtherSidePaneTabs}
      onCloseAllTabs={handleCloseAllSidePaneTabs}
      onReopenClosedTab={handleReopenClosedSidePaneTab}
      onOpenDeveloperTools={handleOpenDeveloperTools}
      onOpenSelectionSideConversation={handleOpenSelectionSideConversationLauncher}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      onOpenBackgroundBash={handleOpenBackgroundBash}
      onOpenSubagentSession={handleOpenSubagentSession}
      onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
      onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
      onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
      onOpenWorkflowRun={handleOpenWorkflowRun}
      mobileOverlay={options.mobileOverlay}
    />
  );
  const sidePanePanel = renderSidePanePanel();
  const shouldRenderWorkspaceHeader = workspaceMainView === "chat" && !aiReqFormalMode;
  // 修复原因：ErrorBoundary resetKeys 的数组如果每次 render 都重新创建，
  // 即使 workspace/task 没变化也会在 React DevTools Components 轨道里持续表现为子树 props 变化。
  const workspaceOnlyResetKeys = useMemo(() => [workspaceKey], [workspaceKey]);
  const workspaceDraftResetKeys = useMemo(
    () => [workspaceKey, activeTaskId ?? "draft"],
    [workspaceKey, activeTaskId],
  );

  // 自动化在 AIReq 中独占内容区，避免隐藏的会话侧栏仍占用宽度；不改写需求页的布局偏好。
  const automationsContent = (
    <main
      id={AUTOMATIONS_TOAST_ANCHOR_ID}
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
    >
      <AutomationsMainBreadcrumbFrame
        sectionLabel={intl.formatMessage({
          id: "settings.automations.title",
        })}
        ariaLabel={intl.formatMessage({
          id: "automations.breadcrumbLabel",
        })}
      >
        <div
          // 修复原因：不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
          // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <ScopedErrorBoundary
            scope="automations-main"
            resetKeys={workspaceOnlyResetKeys}
            variant="panel"
            className="min-h-full"
          >
            {/* AIReq 子页已使用原生 Settings 内容列；外层只保留顶部留白，避免重复居中和 padding。 */}
            <div className={aireq ? "w-full py-4 md:py-6" : "mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6"}>
              {aireq ? <AIReqAutomations workspacePath={workspaceAbsPath} workspaceIdentity={workspaceIdentity} /> : (
                <AutomationsSection
                  workspacePath={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  onCreateViaChat={handleCreateAutomationInChat}
                  onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                  onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                  onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                  openAutomationId={openAutomationId}
                  openAutomationTab={openAutomationTab}
                  onOpenAutomationConsumed={onOpenAutomationConsumed}
                  openWorkflow={openWorkflow}
                  onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                  onOpenSession={({ sessionId, workspacePath, workspaceIdentity }) =>
                    handleSelectTaskInChat(workspacePath, sessionId, workspaceIdentity)
                  }
                />
              )}
            </div>
          </ScopedErrorBoundary>
        </div>
      </AutomationsMainBreadcrumbFrame>
    </main>
  );
  const renderWorkspaceSidebar = (mobile?: { navigateToChat(): void }) =>
    aireq ? (
      <AIReqSidebar onOpenIssue={page => { onWorkspaceMainViewChange(page); mobile?.navigateToChat(); }} issuePage={workspaceMainView.startsWith("issue") ? workspaceMainView : undefined} toolbar={sidebarNavigation} onNavigate={mobile?.navigateToChat ?? showChatMainView} onOpenAutomations={() => { handleOpenAutomations(); mobile?.navigateToChat(); }} automationsActive={workspaceMainView === "automations"} onOpenSkillDesign={() => { onWorkspaceMainViewChange("skillDesign"); mobile?.navigateToChat(); }} skillDesignActive={workspaceMainView === "skillDesign"} onOpenRequirementAnalysis={() => { onWorkspaceMainViewChange("requirementAnalysis"); mobile?.navigateToChat(); }} requirementAnalysisActive={workspaceMainView === "requirementAnalysis"} />
    ) : null;

  // Reuse the responsive phone layout for browsers connected directly to local OMP.
  const renderResponsiveShell = (wideContent: ReactNode) =>
    usesResponsiveLayout ? (
      <WebRemoteControlMobileShell
        isMobileViewport={isMobileViewport}
        isWorkspaceVisible={isWorkspaceVisible}
        activeTaskId={activeTaskId}
        // 只选项目／Release 时留在手机导航，选中 IR 或 SR 后才进入聊天。
        initialNavigationIntent={aireq?.selection.irId ? "chat" : undefined}
        isSidePaneOpen={workspaceMainView === "chat" && isSidePaneOpen}
        onCloseSidePane={isSidePaneOpen ? handleToggleSidePane : undefined}
        renderTaskHome={renderWorkspaceSidebar}
        renderChatHeader={() =>
          shouldRenderWorkspaceHeader ? (
            <>
            <ScopedErrorBoundary
              scope="workspace-header"
              resetKeys={workspaceOnlyResetKeys}
              variant="compact"
              className="border-b"
            >
              <WorkspaceHeader
                backendBusinessAvailable={backendBusinessAvailable}
                variant={activeTaskId === null ? "draft" : "task"}
                draftDropTargetController={
                  activeTaskId === null ? draftHeaderDropTargetController : undefined
                }
                readOnlyReason={aiReqOwnershipReadOnlyReason ?? workspaceReadOnlyReason}
                workspaceAbsPath={workspaceAbsPath}
                remoteSessionId={workspaceRemoteSessionId}
                workspaceIdentity={workspaceIdentity}
                projectName={projectName}
                activeTaskTitle={aireq && !aireq.selection.freeSessionId && !aireq.selection.freeDraftId ? (aiReqSr?.title ?? aiReqGroup?.title ?? "AIReq") : activeTaskTitle}
                activeTaskChangeSummary={activeTaskChangeSummary}
                activeTaskId={activeTaskId}
                activeTraceId={activeTraceId}
                activeSessionId={activeSessionId}
                activeTaskProvider={activeTaskProvider}
                resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                sessionLogPath={taskSessionFile.path}
                nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                nativeSessionLogPath={taskNativeSessionLogFile.path}
                nativeSessionLogExists={taskNativeSessionLogFile.exists}
                nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                providerWorkspaceConfigPath={providerConfigFile.path}
                providerWorkspaceConfigExists={providerConfigFile.exists}
                providerWorkspaceConfigLoading={providerConfigFile.loading}
                workspaceHeaderState={workspaceShellZCodeState}
                simplifyForNarrowViewport
                isSidebarVisible
                isSidePaneOpen={isSidePaneOpen}
                          onToggleSidePane={handleToggleSidePane}
                toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                onReloadSession={handleReloadSession}
                reloadSessionDisabled={workspaceSessionActionDisabled}
                reloadSessionPending={reloadSessionPending}
                onCreateTask={handleCreateTaskInChat}
                onOpenWorkspace={onOpenWorkspace}
                allowOpenWorkspace={allowOpenWorkspace}
              />
            </ScopedErrorBoundary>
              {aireq && !aiReqFormalMode && !!aireq.selection.irId && !aireq.selection.freeSessionId && workspaceMainView === "chat" && <AIReqStageHeader />}
            </>
          ) : null
        }
        chatOverlay={workspaceMainView === "chat" ? renderChatFindDialog() : undefined}
        chatContent={
          aireq && (workspaceMainView === "issueCreate" || workspaceMainView === "issueAnalysis" || workspaceMainView === "issueProgress") ? <AIReqIssuePages page={workspaceMainView} /> : aireq && workspaceMainView === "requirementAnalysis" ? <AIReqRequirementAnalysisPage /> : aireq && workspaceMainView === "skillDesign" ? <AIReqSkillDesignPage /> : workspaceMainView === "automations" ? automationsContent : aiReqFormalMode ? <AIReqFormalWorkspace navigationOpen={isSidebarPanelVisible} onToggleNavigation={sidebarNavigation.onToggle} toolbar={sidebarNavigation} /> : aiReqProposalSr ? <AIReqProposalSrReadOnlyState /> : aiReqEmpty ? <AIReqEmptyState /> : (
            <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
              {/* Bugfix: 手机远控聊天页中间层必须继续提供 flex 高度链。
                只有 h-full 的普通 block 会让 ChatView 的 flex-1 失效，草稿空态贴顶且内部滚动被外层裁掉。 */}
              <ScopedErrorBoundary
                scope="workspace-chat"
                resetKeys={workspaceDraftResetKeys}
                variant="panel"
                className="h-full"
              >
                {/* Bugfix(2026-07-05, M3 验收)：同桌面布局——绑定 activeTaskId 而非 meta 派生的
                  activeSessionId，避免新建 v4 session 因 meta 缓存未刷新而停在 draft。 */}
                {/* Bug 根因：计划详情功能只给桌面 V4WorkspaceChatArea 接了回调，手机卡片因此
                  显示按钮却无法打开抽屉；两端必须复用同一个 renderer Side Pane 入口。 */}
                <V4ChatPane
                  allowEscapeStopOutsidePane={
                    isWorkspaceVisible && !isSidePaneOpen && !isSidePaneVisible
                  }
                  readOnly={Boolean(workspaceReadOnlyReason || aiReqOwnershipReadOnlyReason) || aiReqFrozen || aiReqProposalHistory}
                  readOnlyReason={aiReqOwnershipReadOnlyReason ?? (aiReqProposalHistory ? "当前是另一讨论阶段的历史，只读；返回当前阶段继续处理。" : aiReqFrozen ? "整组需求已冻结，正式需求及拆分不可修改。" : workspaceReadOnlyReason)}
                  workspacePath={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  sessionId={activeTaskId}
                  provider={activeTaskProvider ?? undefined}
                  onSessionCreated={handleV4SessionCreated}
                  onSessionDeleted={handleV4SessionDeleted}
                  draftComposerHeader={draftComposerHeader}
                  activeTaskChangeSummary={activeTaskChangeSummary}
                  summaryPanelVariantOverride={summaryPanelVariantOverride}
                  onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
                  onOpenBrowserUrl={handleOpenBrowserUrl}
                  onOpenAutomationsMain={handleOpenAutomations}
                              onOpenBackgroundBash={handleOpenBackgroundBash}
                  onOpenSubagentSession={handleOpenSubagentSession}
                  onOpenSubagentDirectory={handleOpenSubagentDirectory}
                  onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                  onOpenPlanDetail={handleOpenPlanDetail}
                  onOpenWorkflowRun={handleOpenWorkflowRun}
                  onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                  onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                  onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                  onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                  conversationFindQuery={conversationFindQuery}
                  conversationFindActiveIndex={conversationFindActiveIndex}
                  conversationFindNavigationRequestId={conversationFindNavigationRequestId}
                  onConversationFindMatchStateChange={onConversationFindMatchStateChange}
                  searchResultHighlightRequest={activeSearchResultHighlightRequest}
                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                />
              </ScopedErrorBoundary>
            </div>
          )
        }
        sidePaneContent={renderSidePanePanel({ mobileOverlay: true })}
      >
        {wideContent}
      </WebRemoteControlMobileShell>
    ) : (
      wideContent
    );

  const wideContent = (
    // 完成卡上那两个壳级落点（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
    // run, and running it again」）：芯片开到中枢那一页、「再次运行」启动后切到新会话。只包桌面
    // 这一支——手机远控壳本来就不提供中枢，那边芯片是纯文字。
    <SavedWorkflowHubProvider
      openWorkflow={handleOpenSavedWorkflowInHub}
      navigateToRun={handleNavigateToLaunchedRun}
    >
      <div
        ref={workspaceShellRef}
        data-workspace-shell="true"
        style={workspaceShellSplitStyle}
        className={cn(
          "relative flex h-full min-h-0 w-full overflow-hidden [anchor-scope:--sidebar-task-list-divider]",
          // 修复原因：窗口原生 resize 时，外层 react-resizable-panels 会把每一帧
          // 都写进 layout store，连带侧栏 tooltip/menu 子树反复 commit。这里改成
          // CSS 变量驱动的专用 split，普通窗口 resize 只走浏览器布局，不触发 React 状态。
        )}
      >
        <div
          ref={workspaceSidebarPanelElementRef}
          data-panel=""
          data-workspace-sidebar-panel="true"
          id="sidebar"
          className={cn(
            "w-[var(--workspace-sidebar-panel-width)] max-w-[50%] flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity",
            // 修复原因：拖动侧栏宽度时如果继续过渡 width，会让指针移动和实际宽度之间产生滞后。
            // 拖拽 active 通过 DOM 标记切 transition，避免 pointerdown/up 为了切 class 重渲染整棵 workspace。
            isSidebarPanelVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <aside
            ref={sidebarContainerRef}
            className={cn(
              "h-full overflow-hidden select-none",
            )}
            aria-hidden={!isSidebarPanelVisible}
          >
            <ScopedErrorBoundary
              scope="workspace-sidebar"
              resetKeys={workspaceOnlyResetKeys}
              variant="panel"
              className="h-full"
            >
              <V4SplitPaneEntryProvider enabled={!isMobileViewport}>
                <WorkflowRunOpenProvider onOpenRun={handleOpenSidebarWorkflowRun}>
                  {renderWorkspaceSidebar()}
                </WorkflowRunOpenProvider>
              </V4SplitPaneEntryProvider>
            </ScopedErrorBoundary>
          </aside>
        </div>

        {isSidebarPanelVisible ? (
          <div
            role="separator"
            tabIndex={0}
            aria-controls="sidebar"
            aria-label={workspaceSidebarResizeLabel}
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH_PX}
            aria-valuenow={Math.round(workspaceSidebarPanelWidthPx)}
            data-testid="resizable-handle"
            onKeyDown={handleWorkspaceSidebarResizeKeyDown}
            onPointerCancel={(event) => finishWorkspaceSidebarResize(event, true)}
            onPointerDown={handleWorkspaceSidebarResizeStart}
            onPointerMove={handleWorkspaceSidebarResizeMove}
            onPointerUp={(event) => finishWorkspaceSidebarResize(event)}
            className={cn(
              "group/handle relative z-10 flex h-full w-1 shrink-0 touch-none cursor-ew-resize items-center justify-center bg-transparent outline-none [app-region:no-drag] focus:outline-none focus-visible:ring-0",
              "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 platform-mac-desktop:after:bg-resize-handle platform-windows-desktop:after:bg-resize-handle platform-linux-desktop:after:bg-resize-handle after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius)] after:w-0.5",
              "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100 [[data-workspace-sidebar-resizing=true]_&]:after:opacity-100",
            )}
          />
        ) : null}
        {isSidebarPanelVisible ? (
          // 原因：侧栏 overflow 裁掉横线末端；延伸装饰放在共同布局容器，不改变拖拽命中区。
          <span
            aria-hidden="true"
            data-sidebar-divider-extension="true"
            className={cn(
              "pointer-events-none absolute h-px w-1 bg-border/50 [left:anchor(--sidebar-task-list-divider_right,-4px)] [top:anchor(--sidebar-task-list-divider_top,-1px)]",
            )}
          />
        ) : null}
        {/* 右侧主工作区：会话与共享侧面板。 */}
        <div
          data-panel=""
          id="content"
          className={cn(
            "flex min-w-[320px] flex-1 flex-col",
            "p-0",
          )}
        >
        {!isSidebarPanelVisible && !(aiReqFormalMode && workspaceMainView === "chat") ? (
          <div
            className="flex shrink-0 items-center gap-1 border-b border-border bg-background"
          >
            <WorkspaceSidebarToolbar {...sidebarNavigation} />

          </div>
        ) : null}
          {aireq && (workspaceMainView === "issueCreate" || workspaceMainView === "issueAnalysis" || workspaceMainView === "issueProgress") ? <AIReqIssuePages page={workspaceMainView} /> : aireq && workspaceMainView === "requirementAnalysis" ? <AIReqRequirementAnalysisPage /> : aireq && workspaceMainView === "skillDesign" ? <AIReqSkillDesignPage /> : aireq && workspaceMainView === "automations" ? automationsContent : aiReqFormalMode && workspaceMainView === "chat" ? <AIReqFormalWorkspace navigationOpen={isSidebarPanelVisible} onToggleNavigation={sidebarNavigation.onToggle} toolbar={sidebarNavigation} /> : <ResizablePanelGroup
            layoutId={aireq ? "aireq-workspace-body-layout-v2" : "workspace-body-layout"}
            panelIds={WORKSPACE_BODY_PANEL_IDS}
            className={cn(
              "min-h-0 flex-1",
              // 完整视图：面板外框以 Group 为定位容器铺满整行，对话内容由宿主 fixed 定位。
              // 修复原因：曾用 CSS 把对话列 flex 压成 0，react-resizable-panels 以各 panel offsetWidth
              // 之和作为 group 尺寸，面板从收起展开时两者皆为 0，resize 得到 NaN，面板一直停在收起态。
              // 这里不改库管理的 flex，已保存的面板占比也不写入。
              isFullView && "relative",
            )}
          >
            <ResizablePanel
              id="conversation-column"
              minSize="35%"
              defaultSize={isSidePaneVisible ? "52%" : undefined}
            >
              <SidePaneFullViewConversationHost
                mode={fullViewMode}
                floating={activeFullView?.floating ?? "collapsed"}
                anchor={floatingAnchor}
                slotElement={fullViewSlotElement}
                onFloatingChange={handleFullViewFloatingChange}
                onAnchorChange={handleFloatingAnchorChange}
                onOpenConversation={handleOpenFullViewConversation}
              >
                <div ref={conversationPanelElementRef} className="h-full min-h-0">
                    <section
                      data-workspace-conversation-frame="true"
                      className={cn(
                        "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                        isSidePaneVisible
                          ? "rounded-[var(--workspace-panel-radius)] border border-border"
                          : "border-0",
                        "border-[0.5px]",
                        !isFullView && "shadow-xs",
                        // 完整视图由面板外框或浮窗外框承担边框与圆角，对话 frame 不再叠一层。
                        isFullView && "rounded-none border-0",
                      )}
                    >
                      {shouldRenderWorkspaceHeader && !isFullView ? (
                        <ScopedErrorBoundary
                          scope="workspace-header"
                          resetKeys={workspaceOnlyResetKeys}
                          variant="compact"
                          className="border-b"
                        >
                          <WorkspaceHeader
                            backendBusinessAvailable={backendBusinessAvailable}
                            variant={activeTaskId === null ? "draft" : "task"}
                            draftDropTargetController={
                              activeTaskId === null ? draftHeaderDropTargetController : undefined
                            }
                            readOnlyReason={aiReqOwnershipReadOnlyReason ?? workspaceReadOnlyReason}
                            workspaceAbsPath={workspaceAbsPath}
                            remoteSessionId={workspaceRemoteSessionId}
                            workspaceIdentity={workspaceIdentity}
                            projectName={projectName}
                            activeTaskTitle={aireq && !aireq.selection.freeSessionId && !aireq.selection.freeDraftId ? (aiReqSr?.title ?? aiReqGroup?.title ?? "AIReq") : activeTaskTitle}
                            activeTaskChangeSummary={activeTaskChangeSummary}
                            activeTaskId={activeTaskId}
                            activeTraceId={activeTraceId}
                            activeSessionId={activeSessionId}
                            activeTaskProvider={activeTaskProvider}
                            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                            sessionLogPath={taskSessionFile.path}
                            nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                            nativeSessionLogPath={taskNativeSessionLogFile.path}
                            nativeSessionLogExists={taskNativeSessionLogFile.exists}
                            nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                            providerWorkspaceConfigPath={providerConfigFile.path}
                            providerWorkspaceConfigExists={providerConfigFile.exists}
                            providerWorkspaceConfigLoading={providerConfigFile.loading}
                            workspaceHeaderState={workspaceShellZCodeState}
                            simplifyForNarrowViewport={simplifyHeaderForNarrowViewport}
                            isSidebarVisible={isSidebarVisible}
                            isSidePaneOpen={isSidePaneOpen}
                                                  onToggleSidePane={handleToggleSidePane}
                            toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                            onReloadSession={handleReloadSession}
                            reloadSessionDisabled={workspaceSessionActionDisabled}
                            reloadSessionPending={reloadSessionPending}
                            onCreateTask={handleCreateTaskInChat}
                            onOpenWorkspace={onOpenWorkspace}
                            allowOpenWorkspace={allowOpenWorkspace}
                          />
                        </ScopedErrorBoundary>
                      ) : null}
                      {aireq && !aiReqFormalMode && !!aireq.selection.irId && !aireq.selection.freeSessionId && workspaceMainView === "chat" && <AIReqStageHeader />}
                      <div className="min-h-0 flex-1 overflow-hidden">
                        {workspaceMainView === "automations" ? automationsContent : aiReqProposalSr ? <AIReqProposalSrReadOnlyState /> : aiReqEmpty ? <AIReqEmptyState /> : (
                          <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                            {renderChatFindDialog()}
                            <ScopedErrorBoundary
                              scope="workspace-chat"
                              resetKeys={workspaceDraftResetKeys}
                              variant="panel"
                              className="h-full"
                            >
                              {/* Bugfix(2026-07-05, M3 验收)：pane 绑定必须用原始选择态 activeTaskId，
                                  不能用 meta 派生的 activeSessionId——v4 createSession 刚建的会话
                                  不在 taskListCache/optimistic 缓存里，meta 解析为 null 会让 pane
                                  永远停在 draft。v4 语义下 sessionId ≡ taskId，meta 只服务 Header 显示。
                                  M5⑤：桌面主区升级为分屏宿主（Layout/Focus 两层）；primary pane
                                  绑定语义与 testid 契约（paneId=workspace-main）不变。 */}
                              <V4WorkspaceChatArea
                                allowEscapeStopOutsidePane={
                                  isWorkspaceVisible && !isSidePaneOpen && !isSidePaneVisible
                                }
                                readOnly={Boolean(workspaceReadOnlyReason || aiReqOwnershipReadOnlyReason) || aiReqFrozen || aiReqProposalHistory}
                                readOnlyReason={aiReqOwnershipReadOnlyReason ?? (aiReqProposalHistory ? "当前是另一讨论阶段的历史，只读；返回当前阶段继续处理。" : aiReqFrozen ? "整组需求已冻结，正式需求及拆分不可修改。" : workspaceReadOnlyReason)}
                                foregroundEnabled={isWorkspaceVisible}
                                workspacePath={workspaceAbsPath}
                                workspaceIdentity={workspaceIdentity}
                                remoteSessionId={workspaceRemoteSessionId}
                                sessionId={activeTaskId}
                                activeSelectionSideChatSessionId={activeSelectionSideChatSessionId}
                                provider={activeTaskProvider ?? undefined}
                                onSessionCreated={handleV4SessionCreated}
                                onSessionDeleted={handleV4SessionDeleted}
                                draftComposerHeader={draftComposerHeader}
                                onPrimaryDraftDropTargetControllerChange={
                                  setDraftHeaderDropTargetController
                                }
                                activeTaskChangeSummary={activeTaskChangeSummary}
                                summaryPanelVariantOverride={summaryPanelVariantOverride}
                                onSummaryPanelVariantOverrideChange={
                                  onSummaryPanelVariantOverrideChange
                                }
                                onPaneActiveSessionChange={handlePaneActiveSessionChange}
                                onOpenBrowserUrl={handleOpenBrowserUrl}
                                onOpenAutomationsMain={handleOpenAutomations}
                                onOpenBackgroundBash={handleOpenBackgroundBash}
                                onOpenSubagentSession={handleOpenSubagentSession}
                                onOpenSubagentDirectory={handleOpenSubagentDirectory}
                                onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                                onOpenSelectionSideChat={handleOpenSelectionSideChat}
                                onOpenPlanDetail={handleOpenPlanDetail}
                                onOpenWorkflowRun={handleOpenWorkflowRun}
                                onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                                onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                                onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                                onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                                conversationFindQuery={conversationFindQuery}
                                conversationFindActiveIndex={conversationFindActiveIndex}
                                conversationFindNavigationRequestId={
                                  conversationFindNavigationRequestId
                                }
                                onConversationFindMatchStateChange={
                                  onConversationFindMatchStateChange
                                }
                                searchResultHighlightRequest={activeSearchResultHighlightRequest}
                                onSearchResultHighlightDone={onSearchResultHighlightDone}
                              />
                            </ScopedErrorBoundary>
                          </main>
                        )}
                      </div>
                    </section>
                </div>
              </SidePaneFullViewConversationHost>
            </ResizablePanel>
            {sidePanePanel}
          </ResizablePanelGroup>}
        </div>

      </div>
    </SavedWorkflowHubProvider>
  );
  return <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">{renderResponsiveShell(wideContent)}</div>;
});
