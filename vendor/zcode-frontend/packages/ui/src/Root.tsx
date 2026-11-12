import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
import {
  RequestSecurityHost,
  RequestSecurityWorkspaceBridge,
  setRequestSecurityReporter,
} from "@/request-security-edition/index.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LucideProvider, RefreshCw } from "lucide-react";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider, useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  BackendBusinessAvailabilityProvider,
  NativeHostAvailabilityProvider,
  NativeWorkspaceSessionProvider,
  type NativeWorkspaceSessionScope,
} from "@/hooks/useBackendBusinessAvailability.js";
import { RemoteProjectPresentationProvider } from "@/hooks/RemoteProjectPresentationContext.js";
import {
  readComposerWorkspaceScope,
  readV4ComposerDraft,
  persistV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import {
  captureV4ComposerDraftHandoff,
  stageV4ComposerDraftAttachments,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { selectWorkbenchSession } from "@/v4/workbenchSessionPlacement.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { restorePersistedRemoteWorkspaceSessions } from "@/root/remoteWorkspaceSessionPersistence.js";
import type { AppSettings } from "@zcode/shared";
import { useTabPersistence, type WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import { bindNativeWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DeferredSettingsPage as SettingsPage } from "@/root/DeferredSettingsPage.js";
import { ProviderSetupScreen } from "@/ProviderSetupScreen.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { areWorkspaceFilePathsEqual } from "@/workspace-file-tree/model.js";
import {
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isSettingsTab, isWorkspaceTab } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { RootShell } from "@/root/RootShell.js";
import { RootWorkspaceContent } from "@/root/RootWorkspaceContent.js";
import { resolveConversationWorkspaceTarget } from "@/conversation-workspace-target/index.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { useRootProviderStateRefresh } from "@/root/useRootProviderStateRefresh.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useBotBroadcastEffects } from "@/root/useBotBroadcastEffects.js";
import { registerBaseWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import type { RootProps } from "@/root/types.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { toast } from "@/components/ui/toast.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import {
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL,
  isCodeCommentPayload,
  isCodeCommentRemovePayload,
  markCodeCommentRemoved,
} from "@/lib/codeCommentContext.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;
type WelcomeScreenOpenReason = "startup-provider-required";

/**
 * Root —— 应用根组件
 *
 * 外层挂载 StoreProvider（连接广播服务）+ TabStoreProvider，内层处理认证和路由。
 */
export function Root(props: RootProps) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      {/*
       * 之前通过 lucide.tsx 包装每个图标，把默认 strokeWidth 固定成 1.5。
       * 现在移除包装文件后，如果不在根层统一注入，按钮、列表和工具栏里的 Lucide 图标会回退到 2，
       * 导致同一套 size class 下视觉显得更粗、更挤。这里改用官方 LucideProvider 保持默认值，
       * 同时保留个别图标显式传入 strokeWidth 时的覆盖能力。
       */}
      <TooltipProvider>
        {/*
         * 大会话消息动作里会出现大量 tooltip。Provider 如果跟随每个 tooltip 实例创建，
         * React 点击切换任务时会同步构造数量级相同的 Radix 上下文树；根层共享一次即可保留零延迟配置。
         */}
        <ServiceProvider
          services={props.services}
          composerClientNamespace={props.composerClientNamespace}
        >
          <BackendBusinessAvailabilityProvider available={props.backendBusinessAvailable !== false}>
          <NativeHostAvailabilityProvider
            available={props.nativeHostAvailable === true}
            openProject={props.onOpenProject}
          >
          <PlatformProvider platform={props.platform}>
            <StoreProvider
              broadcastService={props.services.broadcastService}
            >
              <TabStoreProvider>
                <ProjectDirectoryProvider isDesktop={props.isDesktop}>
                    <AssistantCodeCommentFeatureProvider
                      enabled={props.assistantCodeCommentCardsEnabled}
                    >
                        <RequestSecurityHost />
                        <RootInner {...props} />
                    </AssistantCodeCommentFeatureProvider>
                </ProjectDirectoryProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
          </NativeHostAvailabilityProvider>
          </BackendBusinessAvailabilityProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function RootInner({
  services,
  platform,
  initialWorkspaceAbsPath,
  unavailableWorkspacePath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  initialTaskDraft,
  isDesktop,
  responsiveBrowserLayout = false,
  backendBusinessAvailable = true,
  nativeHostAvailable = false,
  initialDirectoryPath,
  onOpenProject,
  restoreSession = true,
  supportsSettings = true,
  allowOpenWorkspace = true,
  preferDirectoryBrowser,
  initialSidebarFileTreeOpen,
  initialWorkspaceLoadingFallback,
}: RootProps) {
  useEffect(() => {
    setRequestSecurityReporter(platform);
    return () => {
      setRequestSecurityReporter(null);
    };
  }, [isDesktop, platform]);



  const { intl } = useZCodeIntl();
  const {
    settings: appSettings,
    refresh: refreshAppSettings,
  } = useSettings();
  const [welcomeScreenOpenReason, setWelcomeScreenOpenReason] =
    useState<WelcomeScreenOpenReason | null>(null);
  const rootModelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  const rootModelSelectionView =
    rootModelSelectionRead.state.status === "ready" ? rootModelSelectionRead.state.view : null;
  const rootModelSelectionErrorNode =
    rootModelSelectionRead.state.status === "error" ? (
      <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={rootModelSelectionRead.reload}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    ) : null;
  const readRootModelSelectionView = useCallback(
    () => services.modelSelectionService.getView(),
    [services.modelSelectionService],
  );
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [projectOpening, setProjectOpening] = useState(false);
  const [projectOpenError, setProjectOpenError] = useState<string | null>(null);
  const nativeCreationRef = useRef<Promise<void> | null>(null);
  const [isCreatingFallbackWorkspace, setIsCreatingFallbackWorkspace] = useState(false);
  const [isBootstrappingInitialWorkspace, setIsBootstrappingInitialWorkspace] = useState(
    Boolean(initialWorkspaceAbsPath),
  );
  const didRequestFallbackWorkspaceRef = useRef(false);
  const rootInnerMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      rootInnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL) {
        const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(
          message.payload,
        );
        if (!parsed.success) {
          logger.warn("[settings] 丢弃无效的运行时偏好广播", {
            issues: parsed.error.issues,
          });
          return;
        }
        void refreshAppSettings();
        if (!backendBusinessAvailable) return;
        void services.zcodeAgentService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口运行时偏好失败", error);
        });
        void services.botsService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口 Bot 运行时偏好失败", error);
        });
        return;
      }

      if (message.channel === CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL) {
        if (!isCodeCommentPayload(message.payload) || !message.payload.id) {
          return;
        }
        useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
          ...message.payload,
          id: message.payload.id,
        });
        return;
      }

      if (message.channel !== CODE_COMMENT_REMOVE_BROADCAST_CHANNEL) {
        return;
      }

      if (!isCodeCommentRemovePayload(message.payload)) {
        return;
      }

      // 关闭文件 tab 后 PreviewPane 会卸载，不能再依赖 PreviewPane 自己监听跨窗口清理事件。
      // 这里在 Root 生命周期内同步清理 renderer 级 preview store，避免发送后重新打开文件又恢复旧 comment。
      markCodeCommentRemoved(message.payload);
      useCodeCommentPreviewStore.getState().removeCommentBySource(message.payload);
    });

    return () => {
      disposable.dispose();
    };
  }, [
    backendBusinessAvailable,
    refreshAppSettings,
    services.botsService,
    services.broadcastService,
    services.zcodeAgentService,
  ]);

  useEffect(() => {
    // TODO(omp-business): Bind runtime preference propagation to the OMP Agent and bots.
    if (!backendBusinessAvailable || !appSettings) {
      return;
    }
    void services.zcodeAgentService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化运行时偏好失败", error);
      });
    void services.botsService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化 Bot 运行时偏好失败", error);
      });
  }, [
    backendBusinessAvailable,
    appSettings?.askUserQuestionAutoResolutionEnabled,
    appSettings?.modelIoFullRetentionEnabled,
    services.botsService,
    services.zcodeAgentService,
  ]);

  const tabs = useTabStore((state) => state.tabs);
  const windowWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const isSettingsTabActive = activeTab ? isSettingsTab(activeTab) : false;
  const {
    workspaceShellPath,
    workspaceIdentity: workspaceShellIdentity,
    workspaceRemoteSessionId: workspaceShellRemoteSessionId,
  } = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    // Settings 覆盖时仍使用被覆盖 tab 的完整远程身份，避免通知与侧栏建立重复订阅。
    workspaceTabs: windowWorkspaceTabs,
  });
  const workspaceScopedServices = useWorkspaceServices(
    workspaceShellPath,
    workspaceShellRemoteSessionId,
    workspaceShellIdentity,
  );
  const selectedNativeSessionId = useZCodeSessionStore((state) => workspaceShellPath
    ? state.getWorkspaceState(workspaceShellPath, workspaceShellIdentity).activeTaskId : null);
  const selectedNativeRead = useModelSelectionServiceView(
    workspaceScopedServices.modelSelectionService,
    nativeHostAvailable && Boolean(selectedNativeSessionId),
    "remote-waiting",
    selectedNativeSessionId ? { sessionId: selectedNativeSessionId } : undefined,
  );
  const selectedNativeSession = selectedNativeRead.state.status === "ready"
    ? selectedNativeRead.state.view.nativeSession : undefined;
  const selectedNativeResident = selectedNativeSession?.chatAvailable === true &&
    selectedNativeSession.sessionId === selectedNativeSessionId;
  const [confirmedNativeScope, setConfirmedNativeScope] = useState<{
    services: typeof workspaceScopedServices;
    scope: NativeWorkspaceSessionScope;
  } | null>(null);
  const retainedNativeScope = confirmedNativeScope?.services === workspaceScopedServices &&
    confirmedNativeScope.scope.workspacePath === workspaceShellPath
    ? confirmedNativeScope.scope : undefined;
  const defaultNativeSession = rootModelSelectionView?.nativeSession;
  const nativeWorkspaceScope = useMemo<NativeWorkspaceSessionScope>(() => {
    const path = workspaceShellPath ?? "";
    if (selectedNativeResident && selectedNativeSession) {
      if (!areWorkspaceFilePathsEqual(selectedNativeSession.workspacePath, path)) {
        return { workspacePath: path, ready: false };
      }
      if (retainedNativeScope?.sessionId === selectedNativeSession.sessionId) return retainedNativeScope;
      return { workspacePath: path, sessionId: selectedNativeSession.sessionId, ready: true };
    }
    if (selectedNativeSessionId && selectedNativeRead.state.status !== "ready") {
      return { workspacePath: path, ready: false };
    }
    // Viewing a readonly history never changes the last confirmed execution/file owner.
    if (retainedNativeScope) return retainedNativeScope;
    if (defaultNativeSession?.chatAvailable &&
        areWorkspaceFilePathsEqual(defaultNativeSession.workspacePath, path)) {
      return { workspacePath: path, sessionId: defaultNativeSession.sessionId, ready: true };
    }
    return {
      workspacePath: path,
      ready: !selectedNativeSessionId ||
        (selectedNativeRead.state.status === "ready" && !selectedNativeResident),
    };
  }, [
    workspaceShellPath, selectedNativeSessionId, selectedNativeResident,
    selectedNativeSession?.sessionId, selectedNativeSession?.workspacePath,
    selectedNativeRead.state.status, retainedNativeScope,
    defaultNativeSession?.sessionId, defaultNativeSession?.workspacePath,
    defaultNativeSession?.chatAvailable,
  ]);
  useEffect(() => {
    if (!nativeHostAvailable || !nativeWorkspaceScope.sessionId) return;
    setConfirmedNativeScope((previous) =>
      previous?.services === workspaceScopedServices &&
      previous.scope.sessionId === nativeWorkspaceScope.sessionId &&
      previous.scope.workspacePath === nativeWorkspaceScope.workspacePath
        ? previous : { services: workspaceScopedServices, scope: nativeWorkspaceScope });
  }, [nativeHostAvailable, nativeWorkspaceScope, workspaceScopedServices]);
  useEffect(() => {
    if (!nativeHostAvailable || !selectedNativeResident || !selectedNativeSession ||
        !workspaceShellPath ||
        areWorkspaceFilePathsEqual(selectedNativeSession.workspacePath, workspaceShellPath)) return;
    // Same-project /cd still requires rebuilding every absolute-path service and pane.
    const target = new URL(window.location.href);
    target.searchParams.set("session", selectedNativeSession.sessionId);
    window.location.replace(target.href);
  }, [
    nativeHostAvailable, selectedNativeResident, selectedNativeSession?.sessionId,
    selectedNativeSession?.workspacePath, workspaceShellPath,
  ]);
  const nativeScopedWorkspaceServices = useMemo(
    () => nativeHostAvailable
      ? bindNativeWorkspaceServices(workspaceScopedServices, nativeWorkspaceScope)
      : workspaceScopedServices,
    [nativeHostAvailable, workspaceScopedServices, nativeWorkspaceScope],
  );

  const addTab = useTabStore((state) => state.addTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const tabStoreApi = useTabStoreApi();
  const refreshProviderState = useRootProviderStateRefresh(services);
  useRootProviderSettingsSnapshot(services);

  const shouldPreferDirectoryBrowser = Boolean(preferDirectoryBrowser);
  const rootProviderAvailability = resolveProviderAvailabilityState({
    modelSelectionView: rootModelSelectionView,
  });
  const providerStartupSyncPending =
    backendBusinessAvailable &&
    !rootProviderAvailability.hydrated &&
    rootModelSelectionRead.state.status !== "error";
  const providerAvailabilityLoginEntryGuardEnabled =
    backendBusinessAvailable &&
    shouldEnableProviderAvailabilityLoginEntryGuard({
      isWebRemoteControlRoot: false,
    });
  const { startupCheckCompleted: providerAvailabilityStartupCheckCompleted } =
    useProviderAvailabilityLoginEntryGuard({
      enabled: providerAvailabilityLoginEntryGuardEnabled,
      modelSelectionView: rootModelSelectionView,
      modelSelectionError:
        rootModelSelectionRead.state.status === "error"
          ? rootModelSelectionRead.state.error
          : undefined,
      refreshProviderState,
      readModelSelectionView: readRootModelSelectionView,
      setLoginEntryOpen: (open) => {
        setWelcomeScreenOpenReason((currentReason) => {
          if (open) {
            return "startup-provider-required";
          }
          return currentReason === "startup-provider-required" ? null : currentReason;
        });
      },
    });
  const isResolvingProviderStartupState =
    backendBusinessAvailable &&
    shouldResolveProviderStartupState({
      isWebRemoteControlRoot: false,
      providerStartupSyncPending,
      providerAvailabilityStartupCheckCompleted,
    });
  const isStartupProviderLoginEntryOpen = welcomeScreenOpenReason === "startup-provider-required";
  // 首次安装时 provider 登录入口判定晚于 workspace 注入，ChatView 会先 mount 并触发草稿预热。
  // 这里把 provider 启动检查纳入 workspace 恢复门禁，避免未连接账号前启动 ZCode session。
  const canRestoreWorkspaceSession =
    !isResolvingProviderStartupState &&
    !isStartupProviderLoginEntryOpen;
  const workspacePersistenceGate = useMemo<WorkspacePersistenceGate>(
    () => ({ canPersist: false, restoreFailed: false }),
    [],
  );

  useEffect(() => {
    // 跨 workspace 任务列表需要一个稳定的“本地/root services”入口。
    // 桌面端 renderer 启动时会注册一次，但 Web 和测试入口也会直接挂 Root；
    // 这里再以 Root props 兜底注册，避免当前激活远端 workspace 时本地列表误用远端 host。
    registerBaseWorkspaceServices(services);
  }, [services]);

  useBotBroadcastEffects(services, tabStoreApi);

  const handleOpenDirectoryBrowser = useCallback(() => {
    setDirectoryBrowserOpen(true);
  }, []);
  const {
    handleConnectRemote,
    handleSelectRemoteProject,
    handleCancelRemoteProject,
    handleReconnectRemoteWorkspace,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask: handleCreateZCodeConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateTask: handleCreateZCodeTask,
    handleBackFromSettings,
  } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    isDesktop,
    allowOpenWorkspace,
    preferDirectoryBrowser: shouldPreferDirectoryBrowser,
    openDirectoryBrowser: handleOpenDirectoryBrowser,
  });

  const handleSelectBrowserProject = useCallback(async (path: string, create = false) => {
    if (!onOpenProject || projectOpening) return;
    setProjectOpening(true);
    setProjectOpenError(null);
    try {
      await onOpenProject(path, create);
      setDirectoryBrowserOpen(false);
    } catch (error) {
      setProjectOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectOpening(false);
    }
  }, [onOpenProject, projectOpening]);

  const composerClientNamespace = useComposerClientNamespace();
  const handleCreateTask = useCallback((request?: CreateTaskRequest) => {
    if (!nativeHostAvailable) return handleCreateZCodeTask(request);
    if (nativeCreationRef.current) return nativeCreationRef.current;
    if (!workspaceShellPath) {
      setDirectoryBrowserOpen(true);
      return;
    }
    const options = typeof request === "object" ? request : undefined;
    const originState = useZCodeSessionStore.getState()
      .getWorkspaceState(workspaceShellPath, workspaceShellIdentity);
    const originTaskId = originState.activeTaskId;
    const originDraftVersion = originState.draftFocusVersion;
    const originTabId = tabStoreApi.getState().activeTabId;
    const isCurrent = () => options?.isCurrent?.() !== false &&
      tabStoreApi.getState().activeTabId === originTabId &&
      useZCodeSessionStore.getState()
        .getWorkspaceState(workspaceShellPath, workspaceShellIdentity).activeTaskId === originTaskId &&
      useZCodeSessionStore.getState()
        .getWorkspaceState(workspaceShellPath, workspaceShellIdentity).draftFocusVersion === originDraftVersion;
    const creation = (async () => {
      try {
        if (!nativeWorkspaceScope.ready) throw new Error("Native workspace ownership is changing; retry after rebinding.");
        let targetPath = options?.targetWorkspace?.workspacePath;
        if (options?.projectId && !targetPath) {
          const projectService = workspaceScopedServices.projectService;
          if (!projectService) throw new Error("The native project service is unavailable.");
          const project = (await projectService.readProjects())
            .find((candidate) => candidate.id === options.projectId);
          if (!project) throw new Error("The selected native project is unavailable.");
          targetPath = (project.roots.find((root) => root.isPrimary) ?? project.roots[0])?.rootPath;
          if (!targetPath) throw new Error("The selected native project has no root directory.");
        }
        if (!isCurrent()) return;
        if (targetPath && targetPath !== workspaceShellPath) {
          if (!onOpenProject) throw new Error("Project navigation is unavailable.");
          await onOpenProject(targetPath, false, true);
          return;
        }
        const created = await workspaceScopedServices.zcodeSessionService.createSession({
          workspacePath: workspaceShellPath,
          ...(workspaceShellIdentity ? { workspaceIdentity: workspaceShellIdentity } : {}),
        });
        if (!created.session.sessionId) throw new Error("The native host did not return a session.");
        if (!isCurrent()) return;
        const incomingDraft = options?.initialComposerDraft ?? (!originTaskId
          ? captureV4ComposerDraftHandoff(
              workspaceShellPath, workspaceShellIdentity, composerClientNamespace,
            ) : undefined);
        const initialDraft = incomingDraft?.draft;
        if (initialDraft || options?.initialPrompt?.trim()) {
          persistV4ComposerDraft(
            workspaceShellPath, workspaceShellIdentity, created.session.sessionId,
            {
              ...initialDraft,
              text: options?.initialPrompt ?? initialDraft?.text ?? "",
              ...(options?.initialPromptMention ? { mention: options.initialPromptMention } : {}),
            },
          );
        }
        if (incomingDraft) {
          stageV4ComposerDraftAttachments(
            workspaceShellPath, workspaceShellIdentity,
            useZCodeSessionStore.getState()
              .getWorkspaceState(workspaceShellPath, workspaceShellIdentity).draftFocusVersion,
            incomingDraft, created.session.sessionId,
          );
        }
        selectWorkbenchSession(
          originTaskId ? {
            workspaceScope: {
              workspacePath: workspaceShellPath,
              ...(workspaceShellIdentity ? { workspaceIdentity: workspaceShellIdentity } : {}),
            },
            sessionId: originTaskId,
          } : null,
          {
            workspacePath: workspaceShellPath,
            ...(workspaceShellIdentity ? { workspaceIdentity: workspaceShellIdentity } : {}),
            sessionId: created.session.sessionId,
          },
        );
        useZCodeSessionStore.getState().setActiveTaskId(
          workspaceShellPath, created.session.sessionId, workspaceShellIdentity,
        );
        options?.onComplete?.();
      } catch (error) {
        if (!isCurrent()) return;
        if (options?.onError) options.onError(error);
        else toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
      }
    })();
    nativeCreationRef.current = creation;
    void creation.finally(() => {
      if (nativeCreationRef.current === creation) nativeCreationRef.current = null;
    });
    return creation;
  }, [
    nativeWorkspaceScope.ready,
    handleCreateZCodeTask, nativeHostAvailable, tabStoreApi,
    composerClientNamespace,
    onOpenProject,
    workspaceScopedServices, workspaceShellIdentity, workspaceShellPath,
  ]);
  const handleCreateConversationTask = useCallback(
    () => nativeHostAvailable ? handleCreateTask() : handleCreateZCodeConversationTask(),
    [nativeHostAvailable, handleCreateTask, handleCreateZCodeConversationTask],
  );

  const handleResolveConversationWorkspaceForShell = useCallback(
    async () =>
      // Bug 原因：此前只回传 workspacePath，Shell 再按路径反查 identity；多设备 conversation 路径
      // 相同时会归到错误 Source。改为在这里按 Source 归属一次性解析 path + identity。
      await resolveConversationWorkspaceTarget({
        getTabs: () => tabStoreApi.getState().tabs,
        activeWorkspacePath,
        activeWorkspaceIdentity,
        resolveLocalConversationWorkspacePath: handleResolveConversationWorkspace,
      }),
    [activeWorkspacePath, activeWorkspaceIdentity, handleResolveConversationWorkspace, tabStoreApi],
  );


  useEffect(() => {
    // Bugfix: fileDisplay 默认不传 basePath 时需要落到“当前激活 workspace”。
    // 之前纯工具层拿不到窗口内的 workspace 上下文，只能退回绝对路径，导致 mention / 文件展示在输入框里不够简洁。
    // 这里由 Root 在 workspace 切换时同步一份当前上下文，既保留工具层复用性，也不把 Zustand 依赖硬塞进工具函数。
    setDefaultFileDisplayBasePath(activeWorkspacePath);
  }, [activeWorkspacePath]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }

    setWorkspaceActionError(null);
  }, [activeWorkspacePath, setWorkspaceActionError]);

  const restorePersistedSession = useCallback(
    async (settings: AppSettings) => {
      const conversationWorkspace =
        isDesktop && restoreSession && !initialWorkspaceIdentity
          ? await services.fileService.ensureConversationWorkspace()
          : undefined;
      const restored = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        allowRemoteWorkspaceRestore: false,
        unavailableWorkspacePath,
        conversationWorkspacePath: conversationWorkspace?.path,
        restoreMode:
          isDesktop && restoreSession && !initialWorkspaceIdentity ? "active-first" : "all",
      });
      const restoreDraftIntents = () => {
        // 桌面刷新通过历史 tab 恢复，不经过 initialWorkspace 入口。先恢复项目意图，
        // 再打开首屏门禁，避免 Composer 按未归类范围读取并预热同目录的项目草稿。
        for (const tab of tabStoreApi.getState().tabs) {
          if (!isWorkspaceTab(tab)) continue;
          const workspace = useZCodeSessionStore
            .getState()
            .getWorkspaceState(tab.workspacePath, tab.workspaceIdentity);
          if (workspace.activeTaskId || workspace.draftProjectId !== undefined) continue;
          const scope = readComposerWorkspaceScope(
            tab.workspacePath,
            tab.workspaceIdentity,
            composerClientNamespace,
          );
          if (!scope) continue;
          const draft = readV4ComposerDraft(
            tab.workspacePath,
            tab.workspaceIdentity,
            V4_DRAFT_SCOPE_ROOT,
            scope,
          );
          useZCodeSessionStore
            .getState()
            .startDraft(tab.workspacePath, undefined, tab.workspaceIdentity, {
              projectId: scope.projectId,
              taskGroupId: draft?.taskGroupId,
            });
          logger.info("[Root] 已恢复新建草稿归属", {
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            projectId: scope.projectId,
          });
        }
      };
      restoreDraftIntents();
      return {
        excludedRecentProjectPaths: conversationWorkspace ? [conversationWorkspace.path] : [],
        ...(restored?.deferredRestore
          ? {
              deferredRestore: () => {
                restored.deferredRestore!();
                restoreDraftIntents();
              },
            }
          : {}),
      };
    },
    [
      composerClientNamespace,
      initialWorkspaceIdentity,
      isDesktop,
      restoreSession,
      services.fileService,
      tabStoreApi,
      unavailableWorkspacePath,
    ],
  );

  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
    settingService: supportsSettings ? services.settingService : undefined,
    // 首次安装未连接账号时，provider 登录入口判定会晚于 workspace 恢复。
    // 如果这里先恢复 workspace，ChatView mount 会触发草稿 session 预热并在登录页背后报错。
    restoreSession: restoreSession && canRestoreWorkspaceSession,
    persistSession: backendBusinessAvailable && restoreSession && canRestoreWorkspaceSession,
    persistenceGate: workspacePersistenceGate,
    restorePersistedSession,
  });


  // Bug 原因（2026-08-16 web 远控卡死）：官方版本请求安全校验应答方曾只随桌面正在展示的
  // session pane 挂载，web 远控新建会话时桌面没有对应 pane、web 端无应答方，
  // headers 请求永远滞留 pending，任务永久「工作中」。应答方必须常驻桌面窗口、
  // 覆盖每个打开的 workspace tab，与展示状态解耦；Web 端保持零订阅，桌面仍是唯一权威。
  const requestSecurityBridgeNode = isDesktop ? (
    <RequestSecurityWorkspaceBridge workspaceTabs={windowWorkspaceTabs} />
  ) : null;

  // 启动阻塞是桌面窗口保护期，手机 Web 远控在进入 Root 前已有配对/加载页。
  // Web 端继续使用该 gate 会在 workspace tab 注入前渲染空 RootShell，露出浏览器白底。
  const isStartupRenderBlocked = shouldShowRootStartupLoading({
    isDesktop,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
    isResolvingProviderStartupState,
    isRestoring,
    isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace || isCreatingFallbackWorkspace,
  });


  useRootPlatformEffects({
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    initialTaskId,
    initialTaskDraft,
    // Bugfix: 系统右键/Service 冷启动传入 initialWorkspacePath 时，必须先恢复历史 tabs，
    // 再把目标 workspace 合并并激活。否则先 addTab 会被 restoreTabs 整体替换掉；
    // 直接禁用 restoreSession 又会让其他 workspace 全部消失。
    canBootstrapInitialWorkspace: canRestoreWorkspaceSession && hasCompletedInitialRestore,
    addTab,
    setIsBootstrappingInitialWorkspace,
    platform,
    activateTabByPath,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace: nativeHostAvailable
      ? () => { void handleCreateTask(); }
      : startNewTaskFromActiveWorkspace,
    openWorkspace: handleOpenWorkspace,
    openWorkspacePath: handleSelectProject,
    setWorkspaceActionError,
    allowOpenWorkspace,
    isDesktop,
    tabs,
    hasCompletedFullTabRestore: hasCompletedFullRestore,
    intl,
  });




  useEffect(() => {
    if (
      !backendBusinessAvailable ||
      shouldBlockRootRender({
        isResolvingProviderStartupState,
        isRestoring,
        isBootstrappingInitialWorkspace,
      }) ||
      isStartupProviderLoginEntryOpen ||
      workspaceShellPath ||
      isSettingsTabActive ||
      !allowOpenWorkspace ||
      didRequestFallbackWorkspaceRef.current
    ) {
      return;
    }

    didRequestFallbackWorkspaceRef.current = true;
    setIsCreatingFallbackWorkspace(true);
    // 以前 tab store 的默认空态会把 Root 带到打开工作区中间页。
    // 删除整页流程后，启动恢复为空或入口没有传 initialWorkspacePath 时必须在 Root
    // 兜底落到默认 workspace，避免用户先看到一张“打开工作区”中间页或空白页。
    // 这里不能用当前 effect 的 cleanup 作为异步取消标记：setIsCreatingFallbackWorkspace
    // 或 addTab 后的 workspaceShellPath 变化都会让 React 先跑 cleanup，若因此跳过 finally，
    // 启动 loading gate 会永远保持 true。
    services.fileService
      .ensureConversationWorkspace()
      .then((result) => {
        // 启动兜底创建目录可能早于会话恢复发起、晚于恢复完成返回。
        // 返回后必须按 tab store 最新 active workspace 再判一次，避免迟到的默认项目抢走上次恢复的 tab。
        if (
          !shouldOpenFallbackWorkspaceAfterCreate({
            isMounted: rootInnerMountedRef.current,
            activeWorkspacePath: tabStoreApi.getState().activeWorkspacePath,
          })
        ) {
          return;
        }
        handleSelectConversationWorkspace(result.path);
      })
      .catch((error) => {
        if (!rootInnerMountedRef.current) {
          return;
        }
        logger.error("[Root] 启动兜底创建默认 workspace 失败", { error });
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (rootInnerMountedRef.current) {
          setIsCreatingFallbackWorkspace(false);
        }
      });
  }, [
    allowOpenWorkspace,
    backendBusinessAvailable,
    handleSelectConversationWorkspace,
    isBootstrappingInitialWorkspace,
    isResolvingProviderStartupState,
    isRestoring,
    isSettingsTabActive,
    isStartupProviderLoginEntryOpen,
    services.fileService,
    setWorkspaceActionError,
    tabStoreApi,
    workspaceShellPath,
  ]);

  useEffect(() => {
    if (!workspaceShellPath) {
      return;
    }

    logger.info(
      `[Root] settings view ${isSettingsTabActive ? "open" : "closed"} workspace=${workspaceShellPath}`,
    );
  }, [isSettingsTabActive, workspaceShellPath]);


  const handleWelcomeScreenComplete = useCallback(
    async () => {
      await refreshAppSettings();
      await refreshProviderState();
      if (providerAvailabilityLoginEntryGuardEnabled) {
        const modelSelectionView = await readRootModelSelectionView();
        if (!resolveProviderAvailabilityState({ modelSelectionView }).hasUsableProvider) {
          throw new Error("请先配置至少一个可用的模型供应商及模型。");
        }
      }
      if (
        welcomeScreenOpenReason !== "startup-provider-required" ||
        workspaceShellPath ||
        !allowOpenWorkspace
      ) {
        setWelcomeScreenOpenReason(null);
        return;
      }

      await handleEnsureConversationWorkspace();
      setWelcomeScreenOpenReason(null);
    },
    [
      allowOpenWorkspace,
      handleEnsureConversationWorkspace,
      providerAvailabilityLoginEntryGuardEnabled,
      readRootModelSelectionView,
      refreshAppSettings,
      refreshProviderState,
      welcomeScreenOpenReason,
      workspaceShellPath,
    ],
  );
  const directoryBrowserDialog = directoryBrowserOpen ||
    (nativeHostAvailable && !workspaceShellPath && !isSettingsTabActive) ? (
    <ScopedErrorBoundary
      scope="directory-browser"
      resetKeys={["directory-browser"]}
      variant="silent"
    >
      <DirectoryBrowser
        services={services}
        initialPath={initialDirectoryPath ?? workspaceShellPath ?? undefined}
        directoriesOnly={nativeHostAvailable}
        selecting={projectOpening}
        selectionError={projectOpenError ?? undefined}
        onCancel={() => {
          if (!projectOpening) setDirectoryBrowserOpen(false);
        }}
        onSelect={(path) => {
          if (onOpenProject) void handleSelectBrowserProject(path);
          else {
            setDirectoryBrowserOpen(false);
            void handleSelectProject(path);
          }
        }}
        onCreate={onOpenProject ? (path) => {
          void handleSelectBrowserProject(path, true);
        } : undefined}
      />
    </ScopedErrorBoundary>
  ) : null;


  // 修复原因：没有打开的项目时 Root 只渲染独立设置页，迁移向导没有挂载，数据同步页「迁移」点了没有反应。
  // 两个分支共用同一个迁移向导节点；没有项目时 workspacePath 为空，用户级的项照常导入（见 useSettingsSync）。
  const onboardingDialog = (
    <ScopedErrorBoundary
      scope="onboarding-dialog"
      resetKeys={[workspaceShellIdentity?.trim() || workspaceShellPath]}
      variant="silent"
    >
      <OnboardingDialog
        workspacePath={workspaceShellPath || undefined}
        workspaceIdentity={workspaceShellIdentity}
        isDesktop={isDesktop}
        enabled={backendBusinessAvailable}
      />
    </ScopedErrorBoundary>
  );

  const settingsLayerProps = {
    isDesktop,
    captionWorkspacePath: activeWorkspacePath,
    onBack: activeWorkspacePath ? handleBackFromSettings : undefined,
    onCreateTask: handleCreateTask,
    onOpenWorkspace: handleOpenWorkspace,
    allowOpenWorkspace,
  };

  if (isStartupRenderBlocked) {
    const loadingLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {directoryBrowserDialog}
        {/* 修复原因：HTML 启动壳已经展示 ZCode SVG，但 React 接管 root 后旧壳会被整棵替换。
            之前阻塞恢复 tab / 初始 workspace 注入时重新渲染纯文字“加载中...”，所以启动被拆成两套 loading。
            这里复用同一套 SVG 启动画面，只把文案保留到 aria-label，保证视觉始终连续且不牺牲可访问性。 */}
        <RootStartupLoading label={loadingLabel} />
      </RootShell>
    );
  }

  if (welcomeScreenOpenReason) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {directoryBrowserDialog}
        <ProviderSetupScreen onComplete={handleWelcomeScreenComplete} />
      </RootShell>
    );
  }

  if (!workspaceShellPath && isSettingsTabActive) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {directoryBrowserDialog}
        <ScopedErrorBoundary
          scope="settings-page"
          resetKeys={["settings-root"]}
          variant="panel"
          className="h-full"
        >
          <SettingsPage {...settingsLayerProps} />
        </ScopedErrorBoundary>
        {onboardingDialog}
      </RootShell>
    );
  }

  if (
    !workspaceShellPath &&
    !isDesktop &&
    initialWorkspaceAbsPath &&
    initialWorkspaceLoadingFallback
  ) {
    // 非桌面入口的 workspace tab 由 effect 注入，首帧不能返回 null。
    // 这里延续入口 loading，等任务列表有 workspaceShellPath 后再切换，避免露出浏览器白底。
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {initialWorkspaceLoadingFallback}
        {directoryBrowserDialog}
      </RootShell>
    );
  }

  if (!workspaceShellPath) {
    return directoryBrowserDialog || rootModelSelectionErrorNode ? (
      <RootShell>
        {rootModelSelectionErrorNode}
        {directoryBrowserDialog}
      </RootShell>
    ) : null;
  }

  return (
    <RootShell>
      {rootModelSelectionErrorNode}
      {requestSecurityBridgeNode}
      {directoryBrowserDialog}
              <RemoteProjectPresentationProvider
                reconnectingKeys={reconnectingRemoteWorkspaceKeys}
                errors={remoteWorkspaceErrorByWorkspaceKey}
                recovery={remoteWorkspaceRecoveryByWorkspaceKey}
                onReconnect={handleReconnectRemoteWorkspace}
              >
              <NativeWorkspaceSessionProvider scope={nativeWorkspaceScope}>
              <RootWorkspaceContent
                workspaceScopedServices={nativeScopedWorkspaceServices}
                workspaceShellPath={workspaceShellPath}
                workspaceIdentity={workspaceShellIdentity}
                workspaceRemoteSessionId={workspaceShellRemoteSessionId}
                activeWorkspacePath={activeWorkspacePath}
                isSettingsTabActive={isSettingsTabActive}
                onConnectRemote={handleConnectRemote}
                onSelectRemoteProject={handleSelectRemoteProject}
                onCancelRemoteProject={handleCancelRemoteProject}
                onReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                handleCreateTask={handleCreateTask}
                handleCreateConversationTask={handleCreateConversationTask}
                handleResolveConversationWorkspace={handleResolveConversationWorkspaceForShell}
                handleOpenWorkspace={handleOpenWorkspace}
                handleOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                handleBackFromSettings={handleBackFromSettings}
                allowOpenWorkspace={allowOpenWorkspace}
                responsiveBrowserLayout={responsiveBrowserLayout}
                backendBusinessAvailable={backendBusinessAvailable}
                initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
                isDesktop={isDesktop}
              />
              </NativeWorkspaceSessionProvider>
              </RemoteProjectPresentationProvider>
        {onboardingDialog}
    </RootShell>
  );
}
