import type { ComposerInputPreview } from "@/prompt-editor/ChatPromptEditor.js";
import { useAIReq } from "@/aireq/AIReqContext.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useSessionRuntimeRestart } from "@/app-shell/useWorkspaceSessionReload.js";
import { isRequestVerificationConfigNetworkError } from "@/request-security-edition/errors.js";
import { useShallow } from "zustand/react/shallow";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import { useNativeHostAvailable } from "@/hooks/useBackendBusinessAvailability.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { executeNativeBrowserAction, openNativeBrowserUrl, type NativeBrowserActionInput } from "@/v4/nativeBrowserActions.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import {
  createRemoteWorkspaceDisconnectedError,
  getRemoteConnectionFailureCode,
} from "@/lib/remoteWorkspaceServiceError.js";
import { getLocalTtftObserver } from "@/v4/telemetry/local-ttft/contract.js";
import { BotGroupDeliveryProvider } from "@/v4/BotGroupDeliveryAction.js";
/* oxlint-disable eslint(max-lines) -- SessionPane 是单 pane 竖切的命令编排收口（订阅/发送/停止/fork/edit/retry/queue/slash 全集），与旧 ChatView 同粒度；HEAD 已超限（693 行计数），拆散命令组会打散 dispatchCommand/snapshotRef 的闭包纪律。 */
import { useOptionalProjectDirectoryActions } from "@/project-sidebar/index.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Hand } from "lucide-react";
import {
  buildCustomSupplierKey,
  isRemoteWorkspaceIdentity,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import { TID_CHAT_EMPTY, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import type {
  GitChangeSourceId,
  LocalTtftContext,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  CommandType,
  ConversationSnapshot,
  ConversationRowTarget,
  SessionErrorInfo,
  SessionModelTransition,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { SandboxSessionActionsProvider } from "@/plugin-ui/hostPrimitives.js";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import { buildChatSessionScrollMemoryKey } from "@/lib/chatSessionScrollMemory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useServices } from "@/hooks/useServices.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";
import {
  workflowSessionModelOf,
  type WorkflowRunSettingsChange,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { selectGenUiModelContext } from "@zcode/shared/gen-ui";
import { useWorkspaceHomePath } from "@/hooks/useWorkspaceHomePath.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { prepareComposerRecentReceipt } from "@/lib/composerRecent.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  readPendingTaskDraft,
  resolveComposerScope,
  composerScopeKey,
} from "@/v4/composer/composerDraftStore.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import {
  buildDraftCreateConfigPayload,
  useDraftConfigControl,
} from "@/v4/composer/useDraftConfigControl.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import {
  createComposerSubmissionConfig,
  type ComposerSubmissionConfig,
} from "@/v4/composer/composerSubmissionConfig.js";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import { projectSessionConfigToTaskConfigOptions } from "@/v4/composer/sessionConfigTaskCache.js";
import { useDraftRuntimeRebuildGate } from "@/v4/composer/useDraftRuntimeRebuildGate.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  ConversationComposer,
  type ComposerRestoreRequest,
  type ExternalTextInsertRequest,
  type NativeComposerTarget,
  type ConversationComposerSendOptions,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import { captureV4ComposerDraftHandoff, stageV4ComposerDraftAttachments } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { shouldIgnoreEscapeForStopGeneration } from "@/v4/composer/escapeStop.js";
import { useConversationPanePresentation } from "@/side-pane-full-view/index.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";
import { ConversationHeader, type PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationLatestTurnSummary } from "@/v4/conversationTimelineLiveTail.js";
import { ConversationBottomDockTransition } from "@/v4/ConversationBottomDockTransition.js";
import {
  resolveConversationStatusPanelVariant,
  shouldUseConversationStatusPanelInlineLayout,
} from "@/v4/conversationLayout.js";
import {
  buildConversationStatusPanelModel,
  resolveSoleRunningWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  buildWorkflowRunByRunId,
  buildWorkflowSaveCandidatesByRunId,
  buildWorkflowRunByToolCallId,
  buildWorkflowRunPendingQuestionsByRunId,
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
  selectWorkflowJoinRowsInPartition,
} from "@/v4/workflowRunCardJoin.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  countEndedWorkflowRuns,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";
import {
  getConversationRowsPartition,
  hasOlderRows,
  requiresAcceptedInputProjection,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  createAssistantPreviewPptxAutoOpenGateState,
  resolveLatestCompletedAssistantPreviewTurn,
  type AssistantPreviewPptxAutoOpenTarget,
} from "@/v4/assistantPreviewPptxAutoOpen.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import { recordV4CommandAck } from "@/v4/commandAckObservability.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  parseV4VisibleSlashCommand,
  parseSelectionSideSlashCommand,
  v4QueuedCommandText,
  type V4VisibleSlashCommand,
} from "@/v4/slashCommands.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { usePendingCommandRecovery } from "@/v4/usePendingCommandRecovery.js";
import { resolveMcpUnavailableNoticeInPartition } from "@/v4/mcpUnavailableBannerNotice.js";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
} from "@/v4/chatLoadingVisibility.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type { ChatErrorBannerModelConfigTarget } from "@/ChatErrorBanner.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  SyncSubagentSessionTabsRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import {
  buildSelectionSideChatKey,
  clearSelectionSideChat,
  createSelectionSideChat,
  isSelectionSideChatBlocked,
  registerSelectionSideChatOpener,
  setSelectionSideChatBlocked,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import {
  normalizeSlashCommandValue,
  shouldOfferSideSlashCommand,
  type AppSlashCommand,
} from "@/slashCommandHelpers.js";
import {
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

export interface SessionPaneProps {
  /** 嵌入设置页时只收起窗格标题，保留聊天、工具交互与审批能力。 */
  embedded?: boolean;
  /** 仅覆盖输入框展示文案，不写入草稿或发送正文。 */
  composerPlaceholder?: string;
  composerAriaLabel?: string;
  composerInputPreview?: ComposerInputPreview;
  /** 功能页的空会话引导，不作为消息或发送内容。 */
  conversationEmptyState?: ReactNode;
  /** 原型设计页向现有聊天输入框投递未发送草稿。 */
  composerInsertRequest?: ExternalTextInsertRequest | null;
  onComposerInsertApplied?: (requestId: number) => void;
  paneId: string;
  sessionId: string | null;
  rootSessionId?: string;
  /** subagent 右侧详情等观察视图：不显示 composer/input，也不发送行内编辑类命令。 */
  readOnly?: boolean;
  /** 工作区只读原因；普通 subagent 观察视图不传，避免误报目录失效。 */
  readOnlyReason?: string;
  /** 观察视图的显式例外：允许文件摘要恢复 workspace，但不开放会话编辑能力。 */
  allowWorkspaceFileRewind?: boolean;
  /** 框选副屏：保留普通 composer/tools，但隐藏并禁止 edit/retry/fork/goal。 */
  selectionSideChat?: boolean;
  /** 主会话划词动作只投递到 Side Pane 当前激活的辅助 child。 */
  activeSelectionSideChatSessionId?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  compactForRemoteControl?: boolean;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /** deleteSession：删除当前会话后回到 draft（shell 起新草稿）。 */
  onSessionDeleted?: () => void;
  /** 隐藏副屏的 child 已不存在时，由宿主移除对应 tab。 */
  onSelectionSideChatUnavailable?: () => void;
  /**
   * Focus 层：全局快捷键（Esc stop）与 add-to-chat 事件只路由到
   * focused pane。单 pane 消费者（V4ChatPane）缺省 true。
   */
  focused?: boolean;
  /** 右侧面板关闭时，主区 focused pane 可接收对话外的 Esc。 */
  allowEscapeStopOutsidePane?: boolean;
  /** 关闭本窗格（仅非 primary pane 下发；关 pane ≠ 停 session）。 */
  onClosePane?: () => void;
  /** 跨 workspace pane 的归属徽标（pane workspace ≠ shell 当前 workspace 时下发）。 */
  workspaceBadge?: PaneWorkspaceBadge;
  /**
   * 草稿态 composer 上方的 contextHeader（m5：workspace 切换菜单 + Git 分支）。
   * 由 app-shell 构造下发（依赖 workspaceTabs / 远程连接回调等壳层能力）；
   * 非 primary pane 不下发（workspace 切换是壳级动作）。
   */
  draftComposerHeader?: ReactNode;
  /** 主草稿把 drop controller 提给 app shell 的标题栏；其他 pane 只在自身 surface 消费。 */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** 通知行的产物 chip → 全尺寸查看 tab。 */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  /** 工具卡上的子代理药丸 → transcript tab；与详情页子代理行同一个宿主处理器。 */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** 工具卡上的脚本药丸 → 脚本 transcript tab；与详情页脚本行同一个宿主处理器。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

const MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS = 500;
function createSessionErrorKey(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): string {
  return [
    sessionId?.trim() || "draft",
    error.code,
    error.at,
    error.message,
    error.traceId ?? "",
    error.detail ?? "",
  ].join(":");
}

const EMPTY_SUBAGENT_PROJECTION: NonNullable<ConversationSnapshot["subagents"]> = {
  revision: 0,
  childSessionIds: [],
  running: [],
  endedTotal: 0,
};

const MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES = 20;

function toComposerUiError(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): ZCodeUiError {
  return {
    code: error.code,
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.underlyingErrorMessage
      ? { underlyingErrorMessage: error.underlyingErrorMessage }
      : {}),
    ...(error.underlyingErrorDetail ? { underlyingErrorDetail: error.underlyingErrorDetail } : {}),
    // V4 snapshot 已携带安全归因；此处透传归因字段，保证错误按安全归因聚类。
    ...(error.attribution ? { attribution: error.attribution } : {}),
    ...(sessionId ? { taskId: sessionId } : {}),
  };
}

function submissionConfigFromCommand(
  type: CommandType,
  payload: Record<string, unknown>,
): ComposerSubmissionConfig | null {
  const candidate =
    type === "createSession"
      ? (payload.firstInput as Record<string, unknown> | undefined)
      : type === "sendText" || type === "sendGoalCommand"
        ? payload
        : undefined;
  if (!candidate?.modelSelection || !candidate.mode) return null;
  return {
    modelSelection: candidate.modelSelection as ComposerSubmissionConfig["modelSelection"],
    mode: candidate.mode as ComposerSubmissionConfig["mode"],
    planEnabled:
      typeof candidate.planEnabled === "boolean"
        ? candidate.planEnabled
        : candidate.mode === "plan",
  };
}

function isConversationFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME) ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

export interface QueuedComposerRestoreTarget {
  baseRevision: number;
  queueItemId: string;
  sourceCommandId: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: ComposerRestoreRequest["config"];
}

export function resolveQueuedComposerRestore(
  snapshot: ConversationSnapshot,
  queueItemId: string,
): QueuedComposerRestoreTarget | null {
  const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item || item.kind === "compact") return null;
  const restoresModelSelection = item.modelSelection !== undefined;
  const config = {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(restoresModelSelection ? { modelSelection: item.modelSelection } : {}),
  };
  return {
    baseRevision: snapshot.revision,
    queueItemId,
    sourceCommandId: item.sourceCommandId,
    inputKind: item.kind,
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function shouldRestoreQueuedComposerFromAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate";
}

interface SessionPaneLeaseBinding {
  sessionId: string | null;
  layer: object;
  lease: SessionLease | null;
}

// 原始 binding 留在独立 hook 作用域，不能让 SessionPane 的事件闭包捕获失效 owner。
export function useSessionPaneLease(sessionId: string | null, layer: object) {
  const [binding, setBinding] = useState<SessionPaneLeaseBinding>({
    sessionId,
    layer,
    lease: null,
  });
  if (binding.sessionId !== sessionId || binding.layer !== layer) {
    // Bug 根因：新 session 的首帧若读取旧 lease，稳定回调会捕获旧 snapshot/store，
    // 不同代的共享 render 闭包便会串成保留链。先收紧 owner，再让 acquire effect 接管。
    // 草稿晋升仍复用同一预热 lease；不重挂 Composer，也不提前释放原 effect 的资源。
    const promoted =
      binding.layer === layer &&
      binding.sessionId === null &&
      binding.lease?.sessionId === sessionId;
    const lease = promoted ? binding.lease : null;
    setBinding({ sessionId, layer, lease });
    return [lease, setBinding] as const;
  }
  return [binding.lease, setBinding] as const;
}

/**
 * 单 pane 竖切：订阅 → 渲染 rows → composer 发送 / stop（06-ui §SessionPane）。
 *
 * React 性能（vercel-react-best-practices）：
 * - 叶子组件（Header/Timeline/QueuePanel/InputControls/Composer/GoalBanner）均 memo；
 * - 所有回调用 useCallback 且**不依赖高频变化的 snapshot**——snapshot/composer 文本经 ref 读取，
 *   使回调在流式增量期间保持稳定引用，避免把新函数灌进 memo 子组件触发无谓重渲染；
 * - 模型表单的本地输入 state 下沉到对应子组件，输入时不牵动整个 pane。
 */
export function SessionPane({
  embedded = false,
  composerPlaceholder,
  composerAriaLabel,
  composerInputPreview,
  conversationEmptyState,
  paneId,
  sessionId,
  rootSessionId,
  readOnly = false,
  readOnlyReason,
  allowWorkspaceFileRewind = false,
  selectionSideChat = false,
  activeSelectionSideChatSessionId = null,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  compactForRemoteControl = false,
  provider,
  onSessionCreated,
  onSelectionSideChatUnavailable,
  focused = true,
  allowEscapeStopOutsidePane = false,
  onClosePane,
  workspaceBadge,
  composerInsertRequest,
  onComposerInsertApplied,
  draftComposerHeader,
  onDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenCodeViewer,
  onAutoOpenAssistantPptx,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenSelectionSideChat,
  onOpenPlanDetail,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  onOpenWorkflowRunDirectory,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: SessionPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const remoteAvailable = useRemoteConversationAvailable();
  const {
    layer,
    sendCommand,
    attachmentPut,
    attachmentRead,
    attachmentReadRange,
    onRuntimeRestart,
    onRuntimeLifecycle,
    fileChanges,
    fileRewindPreview,
  } = useV4Conversation();
  const {
    modelSelectionService,
    zcodeSessionService,
    zcodeTaskService,
  } = useServices();
  const { intl } = useZCodeIntl();
  const nativeHostAvailable = useNativeHostAvailable();
  const aireq = useAIReq();
  const aiReqProjectDraft = Boolean(aireq && !aireq.selection.irId && !aireq.selection.srId);
  const aiReqProjectDraftReady = !aireq || Boolean(
    aiReqProjectDraft && !aireq.pending && aireq.selection.projectId &&
    aireq.view?.currentProjectId === aireq.selection.projectId &&
    (aireq.selection.freeDraftId || aireq.view.releases.some(release => release.id === aireq.releaseId && release.projectId === aireq.selection.projectId)),
  );
  const browserPlatform = useOptionalPlatform();
  const nativeAttachmentTarget = useRef<{ sessionId: string | null; target: NativeComposerTarget | null }>({ sessionId, target: null });
  const handleNativeAttachmentTargetChange = useCallback((target: NativeComposerTarget | null) => {
    nativeAttachmentTarget.current = { sessionId, target };
  }, [sessionId]);
  const [nativePresentations, setNativePresentations] = useState<Record<string, {
    mode?: "clean" | "compact" | "detailed"; hideThinking?: boolean; todoExpanded?: boolean; todoMarkdown?: string;
  }>>({});
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  const baseWorkspaceServices = useBaseWorkspaceServices();
  const composerClientNamespace = useComposerClientNamespace();
  const composerProjectId = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).draftProjectId,
  );
  const newTaskComposerScope = useMemo(
    () => resolveComposerScope(composerProjectId, workspaceIdentity, composerClientNamespace),
    [composerProjectId, workspaceIdentity, composerClientNamespace],
  );
  const composerDraftGeneration = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  const nativeDraftOwnerKey = JSON.stringify([workspaceKey, composerDraftGeneration, composerProjectId]);
  const nativeDraftOwnerRef = useRef(nativeDraftOwnerKey);
  nativeDraftOwnerRef.current = nativeDraftOwnerKey;
  const nativeDraftNavigation = useRef<{ ownerKey: string; sessionId: string } | null>(null);
  const [nativeDraftState, setNativeDraftState] = useState<{ ownerKey: string; sessionId: string } | null>(null);
  const nativeDraftFlight = useRef<{ ownerKey: string; promise: Promise<string> } | null>(null);
  const nativeDraftSessionId = sessionId === null && nativeDraftState?.ownerKey === nativeDraftOwnerKey
    ? nativeDraftState.sessionId : null;
  const pendingAtEntry = useMemo(() => {
    if (sessionId !== null || newTaskComposerScope.projectId !== null) return null;
    const pending = readPendingTaskDraft(newTaskComposerScope);
    return pending?.workspacePath === workspacePath && pending.commandId ? pending : null;
  }, [sessionId, workspacePath, newTaskComposerScope, composerDraftGeneration]);
  const [resolvedDraftCommand, setResolvedDraftCommand] = useState<string | null>(null);
  const recoveringDraft =
    pendingAtEntry?.commandId !== resolvedDraftCommand ? pendingAtEntry : null;
  const workspaceHomePath = useWorkspaceHomePath({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  });
  // SessionPane 已位于目标 Workspace 的 ServiceProvider 内，直接订阅该 Host Service；
  // 不再从展示组件二次解析 workspace/remote 路由。
  const [lease, setLease] = useSessionPaneLease(sessionId, layer);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // 「冻结历史 + 尾轮」分区（spec：docs/ui/chat-virtual-scroll.md「每帧派生成本」）：
  // 下面随 snapshot 每帧执行的行扫描都按 history 引用缓存历史段，只扫尾轮。
  const rowsPartition = snapshot ? getConversationRowsPartition(snapshot.rows.window) : null;
  const confirmLifecycleRecovery = useConfirmDialog();
  const taskRestart = useSessionRuntimeRestart(
    workspacePath,
    sessionId,
    remoteSessionId,
    workspaceIdentity,
  );
  const runtimeReady =
    sessionId === null ||
    (state.status === "live" &&
      state.projectionReady !== false &&
      (!state.lifecycle || state.lifecycle.state === "ready") &&
      snapshot?.sessionId === sessionId &&
      (!snapshot.runtimeInitialization || snapshot.runtimeInitialization.status === "ready"));
  const mobilePlanInteractionReconcileTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  useEffect(() => {
    const timers = mobilePlanInteractionReconcileTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [lease, sessionId]);
  const handleMobilePlanInteractionAccepted = useCallback(
    (interactionId: string) => {
      if (!compactForRemoteControl || !lease) return;
      const timers = mobilePlanInteractionReconcileTimersRef.current;
      if (timers.has(interactionId)) return;
      const timer = setTimeout(() => {
        timers.delete(interactionId);
        const authoritativeSnapshot = lease.store.getState().snapshot;
        const stillPending = authoritativeSnapshot?.pendingInteractions.some(
          (interaction) => interaction.interactionId === interactionId,
        );
        if (!stillPending) return;
        // Bug 根因：手机 Plan 回执 ACK 与 replayable 清场分属两条异步路径；清场帧
        // 丢失时旧 interaction 会永久驻留。只在 grace 后仍读到权威 pending 时复用
        // 既有 same-sub recovery，不本地隐藏弹窗，也不影响 desktop continuous。
        logger.warn("[v4-pane] 手机 Plan ACK 后 pending 未收口，触发权威恢复", {
          interactionId,
          sessionId,
          workspaceKey: workspaceIdentity?.trim() || workspacePath,
        });
        lease.store.recoverFromStaleAuthority();
      }, MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS);
      timers.set(interactionId, timer);
    },
    [compactForRemoteControl, lease, sessionId, workspaceIdentity, workspacePath],
  );
  const fileChangesRequestCache = useMemo(
    () => new Map<string, Promise<V4ConversationFileChangesResult>>(),
    [fileChanges, sessionId, snapshot?.logEpoch],
  );
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<readonly string[]>([]);
  const [sendSubmissionError, setSendSubmissionError] = useState<ZCodeUiError | null>(null);
  const [paneLocalSummaryPanelVariantOverride, setPaneLocalSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const [terminalSectionOpen, setTerminalSectionOpen] = useState(false);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [workflowSectionOpen, setWorkflowSectionOpen] = useState(false);
  const [dropTargetController, setDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const handleDropTargetControllerChange = useCallback(
    (controller: ConversationDropTargetController | null) => {
      setDropTargetController(controller);
      onDropTargetControllerChange?.(controller);
    },
    [onDropTargetControllerChange],
  );
  const readOnlyDropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: false,
      kind: null,
      onDragLeave: () => {},
      onDragOver: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      },
      onDrop: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [],
  );
  const effectiveDropTargetController = readOnly
    ? readOnlyDropTargetController
    : dropTargetController;
  const isMobileTextInputViewport = useIsMobileTextInputViewport();

  // 稳定回调读取的最新值经 ref 透传，避免回调依赖高频变化的 snapshot/文本。
  const snapshotRef = useRef<ConversationSnapshot | null>(snapshot);
  const sessionIdRef = useRef(sessionId);
  const autoOpenedAssistantPptxKeysRef = useRef<Set<string>>(new Set());
  const assistantPreviewPptxGateRef = useRef(createAssistantPreviewPptxAutoOpenGateState());
  const [assistantPreviewPptxAutoOpenTarget, setAssistantPreviewPptxAutoOpenTarget] =
    useState<AssistantPreviewPptxAutoOpenTarget | null>(null);
  const autoLoadIncompleteTurnCursorRef = useRef<string | null>(null);
  snapshotRef.current = snapshot;
  sessionIdRef.current = sessionId;
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!onAutoOpenAssistantPptx || request.sources.length === 0) return;
      if (autoOpenedAssistantPptxKeysRef.current.has(request.key)) return;
      autoOpenedAssistantPptxKeysRef.current.add(request.key);
      onAutoOpenAssistantPptx(request);
    },
    [onAutoOpenAssistantPptx],
  );
  const composerDraftStateRef = useRef({ hasContent: false, busy: false });
  const [queueEditOperation, setQueueEditOperation] = useState<{
    queueItemId: string;
    sessionId: string;
    workspaceKey: string;
  } | null>(null);
  const queueEditOperationRef = useRef(queueEditOperation);
  queueEditOperationRef.current = queueEditOperation;
  const [composerRestoreRequest, setComposerRestoreRequest] =
    useState<ComposerRestoreRequest | null>(null);
  const nextComposerRestoreRequestIdRef = useRef(1);
  const timelineScrollToBottomRef = useRef<(() => void) | null>(null);
  const timelineScrollToQueryRef = useRef<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >(null);
  const hasExternalSummaryPanelVariantControl = Boolean(onSummaryPanelVariantOverrideChange);
  const effectiveSummaryPanelVariantOverride = hasExternalSummaryPanelVariantControl
    ? (summaryPanelVariantOverride ?? null)
    : paneLocalSummaryPanelVariantOverride;
  const handleSummaryPanelVariantChange = useCallback(
    (variant: ChatViewSummaryPanelVariant | null) => {
      if (onSummaryPanelVariantOverrideChange) {
        onSummaryPanelVariantOverrideChange(variant);
        return;
      }
      setPaneLocalSummaryPanelVariantOverride(variant);
    },
    [onSummaryPanelVariantOverrideChange],
  );

  const workspaceConfigOptions = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).configOptions,
  );
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      !snapshot.config.provider.trim() ||
      !snapshot.config.model.trim() ||
      !workspaceConfigOptions?.length
    ) {
      return;
    }
    // Bug 原因：V4 session 配置只存在 ConversationSnapshot，legacy task 配置桶一直为空；
    // 用户从 custom model 会话新建任务时，startDraft 只能继承 workspace 默认模型。
    // 这里仅把权威配置叠到完整目录并按 task 缓存，不改变 session 或 workspace 事实源。
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(
        workspacePath,
        sessionId,
        projectSessionConfigToTaskConfigOptions(workspaceConfigOptions, snapshot.config),
        workspaceIdentity,
      );
  }, [
    sessionId,
    snapshot?.config.mode,
    snapshot?.config.model,
    snapshot?.config.provider,
    snapshot?.config.thought,
    snapshot?.sessionId,
    workspaceConfigOptions,
    workspaceIdentity,
    workspacePath,
  ]);
  useEffect(() => {
    const scopeKey = `${workspaceKey}\u0000${sessionId ?? "draft"}`;
    const enabled = Boolean(onAutoOpenAssistantPptx && focused && sessionId);
    const result = advanceAssistantPreviewPptxAutoOpenGate(assistantPreviewPptxGateRef.current, {
      enabled,
      scopeKey,
      logEpoch: snapshot?.logEpoch,
      phase: snapshot?.control.phase,
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(snapshot?.rows.window ?? []),
    });
    assistantPreviewPptxGateRef.current = result.state;
    if (result.target !== undefined) {
      setAssistantPreviewPptxAutoOpenTarget(result.target);
    }
  }, [
    focused,
    onAutoOpenAssistantPptx,
    sessionId,
    snapshot?.control.phase,
    snapshot?.logEpoch,
    snapshot?.rows.window,
    workspaceKey,
  ]);
  useEffect(() => {
    // 防止切换 workspace/session/logEpoch 后沿用旧 key；key 本身已隔离，清理仅是
    // 生命周期边界，避免长时间 workbench 中 Set 随会话数增长。
    autoOpenedAssistantPptxKeysRef.current.clear();
  }, [sessionId, snapshot?.logEpoch, workspaceKey]);
  const composerTextInsertRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest,
  );
  const draftRuntimeInvalidationVersion = useZCodeSessionStore(
    (store) =>
      store.getWorkspaceState(workspacePath, workspaceIdentity).draftRuntimeInvalidationVersion,
  );
  const handleExternalTextInsertApplied = useCallback(
    (requestId: number) => {
      useZCodeSessionStore
        .getState()
        .clearComposerTextInsertRequest(workspacePath, requestId, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );
  const composerBindingRef = useRef({ sessionId, workspaceKey });
  composerBindingRef.current = { sessionId, workspaceKey };
  const configCommandBarrier = useMemo(() => createConfigCommandBarrier(), []);
  // 软审核不是阻塞交互，不能隐藏 Composer 或禁用选区引用。
  const blockingInteractionId =
    snapshot?.pendingInteractions.find(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    )?.interactionId ?? null;
  const panePresentation = useConversationPanePresentation();
  const isFloatingPresentation = panePresentation.presentation === "floating";
  const isRunning = Boolean(snapshot?.control.canStop);
  const { reportFloatingStatus } = panePresentation;
  const floatingOwnerKey = sessionId ?? "__draft__";
  // 浮窗形态下由时间线上报最后一个回合（同一个 render unit 的运行状态、时长与最终回答）；
  // 记录带上 owner，切换会话后旧会话的摘要不会混进新会话。
  const [floatingLatestTurn, setFloatingLatestTurn] = useState<{
    ownerKey: string;
    summary: ConversationLatestTurnSummary;
  } | null>(null);
  const handleFloatingLatestTurnSummaryChange = useCallback(
    (summary: ConversationLatestTurnSummary) =>
      setFloatingLatestTurn({ ownerKey: floatingOwnerKey, summary }),
    [floatingOwnerKey],
  );
  const floatingLatestTurnSummary =
    isFloatingPresentation && floatingLatestTurn?.ownerKey === floatingOwnerKey
      ? floatingLatestTurn.summary
      : null;
  const floatingTurnKey = floatingLatestTurnSummary?.turnKey ?? null;
  const floatingTurnRunning = floatingLatestTurnSummary?.running ?? false;
  const floatingTurnAnswer = floatingLatestTurnSummary?.answer ?? null;
  const hasFloatingLatestTurn = floatingLatestTurnSummary !== null;
  useEffect(() => {
    // 完整视图浮窗只展示焦点 pane 的状态；docked 时 reportFloatingStatus 为 noop。
    if (!focused) return;
    reportFloatingStatus({
      running: isRunning,
      blockingInteractionId,
      ownerKey: floatingOwnerKey,
      latestTurn: hasFloatingLatestTurn
        ? { turnKey: floatingTurnKey, running: floatingTurnRunning, answer: floatingTurnAnswer }
        : null,
    });
  }, [
    blockingInteractionId,
    floatingOwnerKey,
    floatingTurnAnswer,
    floatingTurnKey,
    floatingTurnRunning,
    focused,
    hasFloatingLatestTurn,
    isRunning,
    reportFloatingStatus,
  ]);
  const selectionSideChatKey = sessionId
    ? buildSelectionSideChatKey(workspaceKey, sessionId)
    : null;
  const selectionSideActionBlocked = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () =>
      activeSelectionSideChatSessionId
        ? isSelectionSideChatBlocked(activeSelectionSideChatSessionId)
        : false,
    () => false,
  );
  const timelineScrollMemoryKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId,
    taskId: null,
  });

  const {
    agentStartupAllowed: providerAgentStartupAllowed,
    error: draftModelReadinessError,
    dismissError: dismissDraftModelReadinessError,
    ensureReadyForSend: ensureDraftModelReadyForSend,
    markProviderNotReady: markDraftProviderNotReady,
  } = useDraftModelReadinessGate({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    modelSelectionService,
  });

  // 冷恢复可能先连上远端、后恢复项目归属；此时预热会发出缺 projectId 的创建并反复失败。
  // 直接使用草稿 owner 的归属作为创建前置，选择项目后自然恢复；正式会话和本地未归类不受限。
  const draftProjectReady =
    sessionId !== null ||
    !isRemoteWorkspaceIdentity(workspaceIdentity ?? "") ||
    Boolean(composerProjectId);
  const draftAgentStartupAllowed =
    providerAgentStartupAllowed && remoteAvailable && draftProjectReady;

  // Composer 保存下一次 Submission 的 renderer intent；prewarm session 仅承载草稿预热。
  const {
    composerDraft,
    composerDraftScopeToken,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    observeDraftPermissionGrant,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    replaceComposerDraft,
    stageComposerContent,
    captureComposerContentLifecycleCommit,
    captureComposerSubmissionDraftTransaction,
    updateComposerContent,
    persistComposerContent,
  } = useDraftConfigControl({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    modelSessionId: sessionId ?? nativeDraftSessionId,
    sessionConfig: runtimeReady && snapshot?.sessionId === sessionId ? snapshot.config : null,
    agentStartupAllowed: nativeHostAvailable ? Boolean(sessionId ?? nativeDraftSessionId) : draftAgentStartupAllowed,
    modelSelectionService,
  });
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // selection 重读不代表 Provider 目录失效。历史名称沿用 hook 保留的同 Host 目录，
  // 避免先回退内部 ID 再跳回名称；提交配置仍只使用 ready 的完整 View。
  const modelSelectionDisplayView =
    modelSelectionView ??
    (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null);
  const nativeRecoveryScope = JSON.stringify([workspaceKey, sessionId]);
  const [nativeHistoryRecovery, setNativeHistoryRecovery] = useState<{
    scope: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const nativeHistoryRecoveryPending =
    nativeHistoryRecovery?.scope === nativeRecoveryScope && nativeHistoryRecovery.pending;
  const nativeHistoryRecoveryError =
    nativeHistoryRecovery?.scope === nativeRecoveryScope ? nativeHistoryRecovery.error : null;
  const nativeHistoryNeedsResume = Boolean(
    !readOnly &&
      !selectionSideChat &&
      (!rootSessionId || rootSessionId === sessionId) &&
      sessionId &&
      snapshot?.sessionId === sessionId &&
      modelSelectionView?.nativeSession !== undefined &&
      (modelSelectionView.nativeSession === null ||
        modelSelectionView.nativeSession.sessionId !== sessionId ||
        modelSelectionView.nativeSession.workspacePath !== workspacePath),
  );
  const nativeComposerBound =
    modelSelectionView?.nativeSession?.chatAvailable === true &&
    modelSelectionView.nativeSession.sessionId === sessionId &&
    modelSelectionView.nativeSession.workspacePath === workspacePath &&
    snapshot?.sessionId === sessionId &&
    !nativeHistoryRecoveryPending;
  const handleResumeNativeHistory = useCallback(async () => {
    if (!nativeHistoryNeedsResume || !sessionId || nativeHistoryRecoveryPending) return;
    const targetSessionId = sessionId;
    const scope = nativeRecoveryScope;
    const stillViewingTarget = () =>
      composerBindingRef.current.sessionId === targetSessionId &&
      composerBindingRef.current.workspaceKey === workspaceKey;
    setNativeHistoryRecovery({ scope, pending: true, error: null });
    try {
      // Browsing never resumes implicitly. This explicit action uses the bound Host scope,
      // without carrying the draft/default model into the native recovery operation.
      const resumed = await zcodeSessionService.resumeSession({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId: targetSessionId,
      });
      if (resumed.session.sessionId !== targetSessionId)
        throw new Error("原生 Host 未恢复所选会话。");
      if (!stillViewingTarget()) return;
      const projectUrl = (resumed as typeof resumed & { projectUrl?: string }).projectUrl;
      if (projectUrl) {
        const destination = new URL(projectUrl, window.location.href);
        const currentProject = new URL(window.location.href);
        if (destination.origin !== currentProject.origin ||
            destination.pathname !== currentProject.pathname ||
            destination.searchParams.get("project") !== currentProject.searchParams.get("project")) {
          destination.searchParams.set("session", targetSessionId);
          window.location.assign(destination.href);
          return;
        }
      }
      const refreshed = await modelSelectionRead.refresh();
      if (
        refreshed.kind !== "ready" ||
        !refreshed.view.nativeSession?.chatAvailable ||
        refreshed.view.nativeSession.sessionId !== targetSessionId
      )
        throw new Error("尚未确认原生会话状态，请重试继续此会话。");
      if (stillViewingTarget()) await lease?.store.retry();
    } catch (error) {
      setNativeHistoryRecovery({
        scope,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setNativeHistoryRecovery((current) =>
        current?.scope === scope ? { ...current, pending: false } : current,
      );
    }
  }, [
    nativeHistoryNeedsResume,
    nativeHistoryRecoveryPending,
    nativeRecoveryScope,
    sessionId,
    workspaceKey,
    workspacePath,
    workspaceIdentity,
    zcodeSessionService,
    modelSelectionRead.refresh,
    lease,
  ]);
  const extendedConversationAvailable =
    modelSelectionDisplayView != null && modelSelectionDisplayView.nativeSession === undefined;
  const draftModelSelectionRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionId !== null) {
      draftModelSelectionRevisionRef.current = null;
      return;
    }
    const revision = modelSelectionView?.revision ?? null;
    const previousRevision = draftModelSelectionRevisionRef.current;
    draftModelSelectionRevisionRef.current = revision;
    if (
      revision === null ||
      previousRevision === null ||
      revision === previousRevision ||
      (draftConfigRef.current.provider && draftConfigRef.current.model)
    ) {
      return;
    }
    // Bug 原因：冷启动时普通 Provider 会先让草稿预热，Account Overlay 随后才进入
    // Selection View。旧预热会话冻结了早期 fallback，即使最新 View 已包含当前账号连接，
    // Renderer 也会永久停在旧模型。未发送且无显式选择的草稿不是执行事实；View 更新时
    // 回收并按最新选择事实重建，已显式选择和正式会话仍保持冻结。
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [draftConfigRef, modelSelectionView?.revision, sessionId, workspaceIdentity, workspacePath]);
  const createSubmissionFromComposer = useCallback(
    () => (!aireq || aireq.selection.freeDraftId) && nativeHostAvailable && sessionId === null && !nativeDraftSessionId
      ? null : createComposerSubmissionConfig(draftConfigRef.current, modelSelectionView),
    [aireq, draftConfigRef, modelSelectionView, nativeHostAvailable, sessionId, nativeDraftSessionId],
  );
  const composerSubmissionReady = useMemo(
    () => createComposerSubmissionConfig(draftConfig, modelSelectionView) !== null,
    [draftConfig, modelSelectionView],
  );
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const projectDirectory = useOptionalProjectDirectoryActions();
  const commitCreatedTask = projectDirectory?.commitCreatedTask;
  const refreshTaskGroups = projectDirectory?.refreshTaskGroups;
  const draftNavigation = useMemo(
    () => ({ controller: new AbortController() }),
    [workspaceKey, sessionId],
  );
  useEffect(() => {
    // StrictMode 会重放 effect；旧 scope 的请求仍使用各自的取消信号。
    draftNavigation.controller = new AbortController();
    return () => draftNavigation.controller.abort();
  }, [draftNavigation]);
  const handleDraftSessionCreated = useCallback(
    async (
      createdSessionId: string,
      messageId?: string,
      taskGroupId?: string | null,
    ) => {
      const commit = () => {
        // 旧首发接纳不能抢回已经切走的页面；导航与草稿交接共用 owner 的代际判断。
        if (!promoteComposerDraft(createdSessionId)) return;
        onSessionCreated?.(createdSessionId);
      };
      const organize =
        taskGroupId !== undefined
          ? async () => {
              const task = {
                taskId: createdSessionId,
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                hostId: remoteHostIdFromWorkspaceIdentity(workspaceIdentity ?? "") ?? "local",
              };
              const attempt = async () => {
                try {
                  if (!baseWorkspaceServices.taskGroupService)
                    throw new Error("task-group.service-unavailable");
                  await baseWorkspaceServices.taskGroupService.admit({
                    tasks: [task],
                    placement: {
                      task,
                      groupId: taskGroupId,
                      creationId: messageId ?? createdSessionId,
                    },
                  });
                  // 分组结构是独立投影；重读迟滞不能延长已接受首发或组织写入的完成时间。
                  void refreshTaskGroups?.();
                } catch (cause) {
                  // 会话已创建；组织失败不能向发送层抛错，否则会诱导用户再发一次。
                  // 重试闭包只持有这次创建的地址和 placement，绝不调用 createSession。
                  logger.error("[task-groups] 新任务归属提交失败", cause);
                  toast(intl.formatMessage({ id: "taskGroup.failed" }), {
                    durationMs: 0,
                    actionLabel: intl.formatMessage({ id: "taskGroup.retryPlacement" }),
                    onAction: () => void attempt(),
                    dedupeKey: `task-group:${createdSessionId}`,
                  });
                }
              };
              await attempt();
            }
          : undefined;
      if (commitCreatedTask) {
        await commitCreatedTask(
          { taskId: createdSessionId, workspacePath, workspaceIdentity },
          commit,
          draftNavigation.controller.signal,
          organize,
        );
      } else {
        void organize?.();
        commit();
      }
    },
    [
      commitCreatedTask,
      baseWorkspaceServices.taskGroupService,
      refreshTaskGroups,
      intl,
      draftNavigation,
      onSessionCreated,
      promoteComposerDraft,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const ensureNativeDraftSession = useCallback((): Promise<string> => {
    if (sessionId) return Promise.resolve(sessionId);
    if (aireq && !aireq.selection.freeDraftId) return Promise.reject(new Error("所选 AIReq 需求的原生会话不可用，请从工作台打开已有会话。"));
    if (nativeDraftSessionId) return Promise.resolve(nativeDraftSessionId);
    if (!nativeHostAvailable) return Promise.reject(new Error("No native browser host is available"));
    if (nativeDraftFlight.current?.ownerKey === nativeDraftOwnerKey)
      return nativeDraftFlight.current.promise;
    const ownerKey = nativeDraftOwnerKey;
    const promise: Promise<string> = zcodeSessionService.createSession({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }).then((created) => {
      if (!created.session.sessionId) throw new Error("The native host did not create a session");
      if (nativeDraftOwnerRef.current !== ownerKey ||
          composerBindingRef.current.workspaceKey !== workspaceKey ||
          composerBindingRef.current.sessionId !== null)
        throw new Error("The project draft changed while creating its native session");
      setNativeDraftState({ ownerKey, sessionId: created.session.sessionId });
      return created.session.sessionId;
    }).catch((error) => {
      if (nativeDraftFlight.current?.promise === promise) nativeDraftFlight.current = null;
      throw error;
    });
    nativeDraftFlight.current = { ownerKey, promise };
    return promise;
  }, [aireq, sessionId, nativeDraftSessionId, nativeHostAvailable, nativeDraftOwnerKey, workspaceKey, workspacePath, workspaceIdentity, zcodeSessionService]);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const nativePresentationSessionId = sessionId ?? nativeDraftSessionId;
  const nativePresentation = nativePresentationSessionId ? nativePresentations[nativePresentationSessionId] : undefined;
  const nativeDisplayMode = nativePresentation?.mode;
  const nativeHideThinking = nativeDisplayMode === "clean" || nativePresentation?.hideThinking === true;
  const messageStreamShowReasoning = nativeDisplayMode === "clean" ? false :
    nativePresentation?.hideThinking !== undefined
      ? !nativePresentation.hideThinking : sharedSettings?.messageStreamShowReasoning ?? true;
  const messageStreamShowTodos = nativePresentation?.todoExpanded ?? sharedSettings?.messageStreamShowTodos ?? false;
  const toolGroupingExploreEnabled = nativePresentation?.mode
    ? nativePresentation.mode !== "detailed" : sharedSettings?.toolGroupingExploreEnabled ?? true;
  const toolGroupingTerminalEnabled = nativePresentation?.mode
    ? nativePresentation.mode !== "detailed" : sharedSettings?.toolGroupingTerminalEnabled ?? true;
  const toolGroupingChangesEnabled = nativePresentation?.mode
    ? nativePresentation.mode !== "detailed" : sharedSettings?.toolGroupingChangesEnabled ?? false;
  const handleNativeBrowserAction = useCallback((input: NativeBrowserActionInput, requestId: string) => {
    const originSessionId = sessionId ?? nativeDraftSessionId;
    if (!originSessionId || input.originSessionId !== originSessionId)
      return Promise.reject(new Error("The native action belongs to another session"));
    return executeNativeBrowserAction(input, {
      sessionId: originSessionId,
      workspaceIdentity: workspaceKey,
      requestId,
      platform: browserPlatform ?? null,
      async reportMediaState(event) {
        if (!zcodeSessionService.reportBrowserMediaState)
          throw new Error("The native host cannot accept browser media settlement");
        const result = await zcodeSessionService.reportBrowserMediaState({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          sessionId: originSessionId,
          connectionId: input.connectionId,
          clientId: input.clientId,
          event,
        });
        if (result.accepted !== true) throw new Error("The native host rejected browser media settlement");
      },
      attachFile(file) {
        const current = nativeAttachmentTarget.current;
        return (current.sessionId === originSessionId ||
          (sessionId === null && nativeDraftSessionId === originSessionId && current.sessionId === null)) &&
          current.target?.addFile(file) === true;
      },
      setDraft(text, files, onlyIfEmpty) {
        const current = nativeAttachmentTarget.current;
        if (!(current.sessionId === originSessionId ||
              (sessionId === null && nativeDraftSessionId === originSessionId && current.sessionId === null)) || !current.target)
          throw new Error("The originating session composer is unavailable");
        return current.target.setDraft(text, files, onlyIfEmpty);
      },
      openSession(action) {
        const targetId = String(action.sessionId);
        const recordNavigation = () => {
          if (sessionId === null && targetId !== originSessionId)
            nativeDraftNavigation.current = { ownerKey: nativeDraftOwnerKey, sessionId: targetId };
        };
        const destination = new URL(typeof action.url === "string" ? action.url : window.location.href, window.location.href);
        destination.searchParams.set("session", targetId);
        if (action.placement === "window" || destination.pathname !== window.location.pathname) {
          openNativeBrowserUrl(destination.href);
          recordNavigation();
          return;
        }
        const workspaceScope = { workspacePath, workspaceIdentity, remoteSessionId: remoteSessionId ?? undefined };
        const groups = useWorkbenchGroupStore.getState();
        groups.splitSessionIntoGroup(paneId, "right", { workspaceScope, sessionId: targetId }, { workspaceScope, sessionId: originSessionId });
        const grouped = Object.values(useWorkbenchGroupStore.getState().groups).some((group) =>
          group.primaryBinding.sessionId === targetId || Object.values(group.panes).some((pane) => pane.sessionId === targetId));
        if (!grouped) {
          usePaneLayoutStore.getState().openSessionInNewPane(workspaceScope, targetId);
          if (!Object.values(usePaneLayoutStore.getState().panes).some((pane) => pane.sessionId === targetId))
            throw new Error("The browser could not open another session pane");
        }
        recordNavigation();
      },
      setTodoExpanded(expanded, markdown) {
        setNativePresentations((current) => ({
          ...current, [originSessionId]: { ...current[originSessionId], todoExpanded: expanded,
            ...(markdown !== undefined ? { todoMarkdown: markdown } : {}) },
        }));
        handleSummaryPanelVariantChange(expanded ? "panel" : "mini");
      },
      setDisplayMode(mode, hideThinking) {
        setNativePresentations((current) => ({
          ...current, [originSessionId]: { ...current[originSessionId], mode, hideThinking },
        }));
      },
    });
  }, [sessionId, nativeDraftSessionId, nativeDraftOwnerKey, workspaceKey, workspacePath, workspaceIdentity, remoteSessionId, browserPlatform, handleSummaryPanelVariantChange, paneId, zcodeSessionService]);
  const snapshotSessionId = snapshot?.sessionId ?? null;
  const snapshotFollowupMode = snapshot?.config.followupMode ?? null;
  const snapshotRevision = snapshot?.revision ?? null;

  // 注入模式对齐 PermissionDialog：theme/codePreviewSettings 在宿主取 store，
  // 经稳定引用的 rowContext 下发给 memo 行组件（MessageResponse/ToolCallBlocks）。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // Tier 1 fork 跳转：点 child 会话的 forkNotice → 把当前 pane 原地切到父会话，复用 fork
  // 落地同款 onSessionCreated（primary→setActiveTaskId、分屏→bindPaneSession）。rowId 预留
  // Tier 2 精确滚动——当前 forkNotice.parentRowId 恒为 0 占位，此处忽略。
  const handleNavigateToRow = useCallback(
    (targetSessionId: string, _rowId: number) => {
      if (!targetSessionId || targetSessionId === sessionId) {
        return;
      }
      onSessionCreated?.(targetSessionId);
    },
    [onSessionCreated, sessionId],
  );
  const dispatchCommand = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      targetSessionId: string | null,
      baseRevision?: number,
      baseLogEpoch?: string,
      localTtft?: LocalTtftContext,
      onEnvelopeCreated?: (envelope: CommandEnvelope) => void,
      creationProjectId?: string | null,
      creationTaskGroupId?: string | null,
      submittedDraftText?: string,
    ): Promise<CommandAck> => {
      // 离线点击/快捷键不得进入 accepted 命令恢复账本，更不能在重连后自动发送。
      if (!remoteAvailable) throw createRemoteWorkspaceDisconnectedError();
      const submission = submissionConfigFromCommand(type, payload);
      const recentSubmission = submission;
      // 发送时固定组织归属；同 cwd 可属于多个项目，切页和迟到 ACK 不得改写目标。
      let recentScope =
        creationProjectId === undefined
          ? newTaskComposerScope
          : { ...newTaskComposerScope, projectId: creationProjectId };
      // 在异步查询归属前冻结选择与发起顺序，避免慢查询把早发命令排成最新。
      const recentReceipt = recentSubmission
        ? prepareComposerRecentReceipt(recentScope, recentSubmission)
        : undefined;
      // Native transports have no ZCode project ownership; Recent must not gate their input.
      if (recentSubmission && sessionId && targetSessionId &&
          !nativeHostAvailable && modelSelectionView?.nativeSession === undefined) {
        const projectService = baseWorkspaceServices.projectService;
        if (!projectService) throw new Error("project.service-unavailable");
        const directories = await projectService.resolveSessionDirectories(
          {
            workspacePath,
            workspaceIdentity,
            // 辅助 child 不进主任务索引；Recent 查所属主会话，输入仍发给 child。
            // 普通会话和 fork 即使带 rootSessionId 也必须保留自身项目归属。
            taskId:
              selectionSideChat && targetSessionId === sessionId && rootSessionId
                ? rootSessionId
                : targetSessionId,
          },
          recentScope.hostId,
        );
        recentScope = { ...recentScope, projectId: directories.projectId };
      }
      if (recentReceipt) recentReceipt.scope = recentScope;
      const pendingDraft =
        sessionId === null && recentScope.projectId === null
          ? readPendingTaskDraft(recentScope)
          : null;
      const acceptSelection =
        submission && (sessionId === null || targetSessionId === sessionId)
          ? captureAcceptedModelSelection(submission.modelSelection)
          : undefined;
      const envelope = createCommandEnvelope({
        type,
        sessionId: targetSessionId,
        payload: payload as never,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(baseLogEpoch ? { baseLogEpoch } : {}),
      });
      onEnvelopeCreated?.(envelope);
      const projectId =
        type === "createSession"
          ? creationProjectId !== undefined
            ? creationProjectId
            : useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                .draftProjectId
          : undefined;
      // 必须早于第一次上行：transport error/renderer refresh 后仍有可查询线索。
      pendingCommandRegistry.record(
        envelope,
        type === "createSession"
          ? {
              workspace: {
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
              },
              ...(projectId !== undefined ? { projectId } : {}),
              ...(recentReceipt
                ? {
                    composer: {
                      ...recentReceipt,
                      submittedText: submittedDraftText,
                      ...(pendingDraft?.workspacePath === workspacePath
                        ? { draftId: pendingDraft.draftId }
                        : {}),
                    },
                  }
                : {}),
              taskGroupId:
                creationTaskGroupId !== undefined
                  ? creationTaskGroupId
                  : useZCodeSessionStore
                      .getState()
                      .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId,
            }
          : recentReceipt
            ? {
                workspace: { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) },
                ...(sessionId === null
                  ? {
                      projectId: recentScope.projectId,
                      taskGroupId:
                        creationTaskGroupId ??
                        useZCodeSessionStore
                          .getState()
                          .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId,
                    }
                  : {}),
                composer: {
                  ...recentReceipt,
                  submittedText: submittedDraftText,
                  ...(pendingDraft?.workspacePath === workspacePath
                    ? { draftId: pendingDraft.draftId }
                    : {}),
                },
              }
            : undefined,
      );
      // 首发等待预热时，闭包里的页面 lease 可能仍为空；按命令目标取得同一个投影 owner，
      // 避免漏记待投影输入造成 placeholder 闪回，也避免切页后把命令状态写进另一会话。
      const commandLease =
        targetSessionId && type !== "createSession" ? layer.acquire(targetSessionId) : null;
      try {
        if (commandLease) {
          commandLease.store.markCommandPending({
            commandId: envelope.commandId,
            type: envelope.type,
            issuedAt: envelope.issuedAt,
          });
        }
        let ack: CommandAck;
        try {
          if (localTtft && !workspaceIdentity?.trim()) {
            envelope.ttft = getLocalTtftObserver()?.dispatch(
              localTtft,
              workspacePath,
              envelope.commandId,
              targetSessionId,
            );
          }
          ack =
            projectId !== undefined
              ? await sendCommand(envelope, { projectId })
              : await sendCommand(envelope);
          if (localTtft && ack.reasonCode === "guard.heldQueueConfirmationStale")
            getLocalTtftObserver()?.confirmationRetry(localTtft);
          else if (localTtft)
            getLocalTtftObserver()?.ack(localTtft, ack.status, ack.ttftExcluded);
        } catch (error) {
          if (localTtft)
            getLocalTtftObserver()?.exclude(localTtft, "failed");
          if (commandLease) {
            commandLease.store.settleCommand(envelope.commandId);
          }
          if (isProviderNotReadyError(error)) {
            // provider_not_ready 在 Host getClient 前确定性拒绝，CLI 不可能已经
            // admission。unknown 查询只保留待确认状态，因此必须在此明确清除被拒绝的记录。
            pendingCommandRegistry.rejectCommand(envelope.sessionId, envelope.commandId);
          }
          recordV4CommandAck({
            type,
            status: "transport-error",
            reasonCode: String(error),
            at: Date.now(),
          });
          throw error;
        }
        pendingCommandRegistry.applyAck(envelope, ack);
        if (ack.status === "accepted") {
          acceptSelection?.();
        }
        if (
          commandLease &&
          requiresAcceptedInputProjection(type) &&
          (ack.status === "accepted" || ack.status === "duplicate")
        ) {
          // Bug 根因：editUserQuery 会先发布 branch cut；若 replacement user row 的 topic
          // 投影静默，UI 只剩截断结果。ACK 后必须和 sendText 一样等待权威输入投影；
          // watchdog 只重订阅，不伪造消息、不恢复旧分支，也不重放命令。
          commandLease.store.expectAcceptedInputProjection(envelope.commandId);
        }
        // 生产构建 renderer 日志关闭，ack 摘要写入有界调试缓冲供 e2e/现场 probe。
        recordV4CommandAck({
          type,
          status: ack.status,
          ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
          revisionAtDecision: ack.revisionAtDecision,
          at: Date.now(),
        });
        if (shouldResyncForStaleAuthority(ack)) {
          // epoch/entity authority 已变化时只清 optimistic overlay 仍会继续拿旧
          // target 发命令；统一 same-sub recovery 后才能基于同代 rowId/entityId 再裁决。
          commandLease?.store?.recoverFromStaleAuthority();
        }
        // rejected/stale/failed 时若不 settle，optimistic overlay 会永久残留。
        if (commandLease && ack.status !== "accepted" && ack.status !== "duplicate") {
          commandLease.store.settleCommand(envelope.commandId);
        }
        return ack;
      } finally {
        commandLease?.release();
      }
    },
    [
      captureAcceptedModelSelection,
      newTaskComposerScope,
      baseWorkspaceServices.projectService,
      nativeHostAvailable,
      modelSelectionView?.nativeSession,
      layer,
      provider,
      sendCommand,
      remoteAvailable,
      rootSessionId,
      selectionSideChat,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleFetchFileChanges = useCallback(
    (target: ConversationRowTarget, options: ConversationFileChangesRequestOptions) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          files: 0,
          additions: 0,
          deletions: 0,
          items: [],
        });
      }
      const cacheKey = JSON.stringify([
        options.cachePolicy,
        sessionId,
        current.logEpoch,
        // rewind 会在同一 logEpoch、row/entity 下把 active 切为 reverted；
        // 终态缓存必须带上这个语义版本，不能继续复用撤销前的完整 diff。
        options.cachePolicy === "in-flight"
          ? current.revision
          : (options.fileChangesState ?? "unknown"),
        target.rowId,
        target.entityId,
      ]);
      const cachedRequest = fileChangesRequestCache.get(cacheKey);
      if (cachedRequest) {
        fileChangesRequestCache.delete(cacheKey);
        fileChangesRequestCache.set(cacheKey, cachedRequest);
        return cachedRequest;
      }

      // 虚拟行卸载会丢失行内 state，复挂载后预览卡片会重复拉取包含完整
      // patch 的 fileChanges；缓存必须放在 SessionPane，才能与文件变更面板共享同一请求。
      let request: Promise<V4ConversationFileChangesResult>;
      request = fileChanges({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).then(
        (result) => {
          // 运行中成功结果仍可能只是当前 revision 的局部 diff；只共享
          // in-flight Promise，settled 后删除，避免最终卡片复用早期结果。
          if (
            options.cachePolicy === "in-flight" &&
            fileChangesRequestCache.get(cacheKey) === request
          ) {
            fileChangesRequestCache.delete(cacheKey);
          }
          return result;
        },
        (error: unknown) => {
          // 失败不能污染后续重试；仅删除当前 Promise，避免旧请求误删同 key 的新请求。
          if (fileChangesRequestCache.get(cacheKey) === request) {
            fileChangesRequestCache.delete(cacheKey);
          }
          if (shouldResyncForStaleAuthority(error)) {
            lease?.store?.recoverFromStaleAuthority();
          }
          throw error;
        },
      );
      fileChangesRequestCache.set(cacheKey, request);
      while (fileChangesRequestCache.size > MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES) {
        const oldestKey = fileChangesRequestCache.keys().next().value;
        if (oldestKey === undefined) break;
        fileChangesRequestCache.delete(oldestKey);
      }
      return request;
    },
    [fileChanges, fileChangesRequestCache, lease, sessionId],
  );

  const handlePreviewFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          canApply: false,
          safeFiles: [],
          unsafeFiles: [],
          ignoredFiles: [],
        });
      }
      return fileRewindPreview({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).catch((error: unknown) => {
        if (shouldResyncForStaleAuthority(error)) {
          lease?.store?.recoverFromStaleAuthority();
        }
        throw error;
      });
    },
    [fileRewindPreview, lease, sessionId],
  );

  const handleApplyFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        throw new Error("Cannot apply file rewind without an active session revision");
      }
      return dispatchCommand(
        "applyFileRewind",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenSubagentSideTabRequest) => {
      onOpenSubagentSession?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentSession, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  const handleOpenSubagentDirectory = useCallback(
    (request: import("@/lib/workspaceSidePane.js").OpenSubagentDirectorySideTabRequest) => {
      if (compactForRemoteControl) return;
      onOpenSubagentDirectory?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [
      compactForRemoteControl,
      onOpenSubagentDirectory,
      remoteSessionId,
      rootSessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const handleOpenPlanDetail = useCallback(
    (request: OpenPlanDetailSideTabRequest) => {
      onOpenPlanDetail?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenPlanDetail, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 与 plan-detail 完全同构：卡片只发意图（runId + toolCallId + 展示名），
  // 会话与 workspace 身份一律由宿主（这里）补齐，卡片不感知 scope。
  const handleOpenWorkflowRun = useCallback(
    (request: OpenWorkflowRunSideTabRequest) => {
      onOpenWorkflowRun?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRun, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 药丸 → 子代理 transcript：与 plan-detail / workflow-run 同构，卡片只交出实例身份，scope 在这里补。
  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenWorkflowActorSessionSideTabRequest) => {
      onOpenWorkflowActorSession?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowActorSession, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 脚本药丸同构：卡片交出 run + 发起行 + 阶段，scope 在这里补。
  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenWorkflowWorkspaceSideTabRequest) => {
      onOpenWorkflowWorkspace?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowWorkspace, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 产物 chip 与 run 详情同构：卡片/通知行只发意图，scope 由这里补齐。
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenWorkflowArtifactSideTabRequest) => {
      onOpenWorkflowArtifact?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowArtifact, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 工具卡 → workflow run 的关联表。权威来源是 workflowRuns 投影里每条 run 的 toolCallId
  // （schema 注释就写着它是「工具卡 → 详情页的关联键」）；工具行自己的 output 在 v4 下
  // 只剩 formatCreateWorkflowModelContent 挑出的那句散文，结构化字段拿不到。
  //
  // 值不只是 runId：run 态的卡片本身要渲染状态词与步数，所以联接一次就把摘要算完
  // （计数规则见 buildWorkflowRunByToolCallId，它的单测穷举 settled / observed 语义）。
  // 重启后投影不再为空：CLI 冷物化把 journal 回放进同一个 reducer，
  // 卡片 join 只读投影，不再合并发现查询。发现查询在这里只剩一个用途——
  //
  // `limit` 与 `refreshKey` 服务的是任务列表那条「已结束的工作流 · N」页脚行：
  // - 深度取 run 目录页的同一个常量，否则页脚行的计数与页面上的行会是两套口径；
  // - 触发器取**同一个派生函数**（run 数 + 已结算数），所以页脚行与它开出来的目录页新鲜度一致；
  //   接投影的 `revision` 则会把一次分页读变成一条跟着节点事件走的流。
  const workflowRunJournalSummaries = useWorkflowRunJournalSummaries({
    sessionId,
    // Bug 根因（2026-08-24 实测）：嵌套只读 transcript（dwf actor / subagent）也是 SessionPane，
    // 无差别发这条查询等于拿子会话 id 去问一条按**父会话**建键的 journal；CLI 的冷会话前置
    // 随即为正在运行的 detached actor 会话物化第二个 runtime（幽灵），双写事件日志，
    // 直播冻结在「已工作 xx 秒」。只读 pane 也不消费 join 回退与任务列表页脚，直接关掉。
    enabled: extendedConversationAvailable && !readOnly && runtimeReady,
    live: state.status === "live" && runtimeReady,
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(snapshot?.workflowRuns?.runs),
  });
  const endedWorkflowRunCount = useMemo(
    () => countEndedWorkflowRuns(workflowRunJournalSummaries),
    [workflowRunJournalSummaries],
  );
  const workflowRunByToolCallId = useMemo(
    () => buildWorkflowRunByToolCallId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // runId 键的同源表：ResumeWorkflowRun 工具行的联接入口（display 带 runId，投影的
  // toolCallId 跨 resume 沿用原始 CreateWorkflow 行，resume 行按 toolCallId 查不到）。
  const workflowRunByRunId = useMemo(
    () => buildWorkflowRunByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // 发起 toolCallId → 静态图：图是 run 的属性，
  // 三种来源的轮尾 run 卡都到这一张表取图。行窗口一遍建成，随窗口重建。
  const selectWorkflowRows = useShallow(selectWorkflowJoinRowsInPartition);
  const workflowRows = selectWorkflowRows(rowsPartition);
  const workflowGraphByToolCallId = useMemo(
    () => buildWorkflowGraphByToolCallId(workflowRows),
    [workflowRows],
  );
  // runId → 最新补全的有效脚本图（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：补全之后
  // run 卡与侧板取它。行窗口一遍建成，随窗口重建。
  const workflowFillGraphByRunId = useMemo(
    () => buildWorkflowFillGraphByRunId(workflowRows),
    [workflowRows],
  );
  // 工作流工具行 → 草稿位置：稿号与
  // 「后面还有更新的一稿」都只能从行序读出，行窗口一遍建成，随窗口重建。
  const workflowDraftByToolCallId = useMemo(
    () => buildWorkflowDraftByToolCallId(workflowRows),
    [workflowRows],
  );
  // runId → 转写里认领过它的 SaveWorkflow 候选（docs/dynamic-workflow/transcript-and-notifications.md
  // 「Which workflow a run is saved as」规则 1）。行窗口一遍建成，随窗口重建。
  const workflowSaveCandidatesByRunId = useMemo(
    () => buildWorkflowSaveCandidatesByRunId(workflowRows),
    [workflowRows],
  );
  // Workflow 通知 manifest 的升级条目 Waiting→Answered 联查表（runId → 停驻 qid 集合）。
  const workflowRunPendingQuestionsByRunId = useMemo(
    () => buildWorkflowRunPendingQuestionsByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // 详情页入口（面板 Workflows 分区的行）。行只把「打开哪个 run」交出来（runId + toolCallId），
  // 会话与 workspace 身份照旧由这里补齐——与工具卡走的是同一个 handler，不存在第二条打开路径。
  const handleOpenWorkflowRunFromPanel = useCallback(
    (target: ConversationStatusPanelWorkflowRunTarget) => {
      if (!sessionId) return;
      handleOpenWorkflowRun({ ...target, parentSessionId: sessionId });
    },
    [handleOpenWorkflowRun, sessionId],
  );
  // run 目录页的入口（同一条页脚行）。同样只补 scope，不在这里多造一条打开路径。
  const handleOpenWorkflowRunDirectoryFromPanel = useCallback(
    (request: OpenWorkflowRunDirectorySideTabRequest) => {
      onOpenWorkflowRunDirectory?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRunDirectory, remoteSessionId, workspaceIdentity, workspacePath],
  );
  const handleAddSelectionToCurrentTask = useCallback(
    (reference: ConversationSelectionReference) => {
      if (!sessionId) return;
      dispatchConversationSelectionAdd({
        targetSessionId: sessionId,
        workspaceKey,
        reference,
      });
    },
    [sessionId, workspaceKey],
  );
  const handleOpenSelectionSideConversation = useCallback(
    async (reference?: ConversationSelectionReference, forceNew = false) => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) return;
      try {
        let targetChildSessionId = reference && !forceNew ? activeSelectionSideChatSessionId : null;
        let replacesChildSessionId: string | undefined;
        if (targetChildSessionId) {
          try {
            await zcodeSessionService.readSession({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              sessionId: targetChildSessionId,
              messageLimit: 1,
            });
          } catch (error) {
            if (!String(error).includes("sessionNotFound")) throw error;
            // 多开后 tab id 包含 child，旧单例实现依靠新 child 覆盖同一个父 tab
            // 来移除失效项已不成立。这里显式携带 replacesChildSessionId，让宿主原子删旧开新。
            replacesChildSessionId = targetChildSessionId;
            clearSelectionSideChat(targetChildSessionId);
            clearConversationSelectionReferenceScope(targetChildSessionId, workspaceKey);
            targetChildSessionId = null;
          }
        }

        if (targetChildSessionId) {
          onOpenSelectionSideChat({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            parentSessionId: sessionId,
            childSessionId: targetChildSessionId,
          });
          if (reference) {
            dispatchConversationSelectionAdd({
              targetSessionId: targetChildSessionId,
              workspaceKey,
              reference,
            });
          }
          return;
        }

        const childSessionId = await createSelectionSideChat(selectionSideChatKey, async () => {
          const ack = await dispatchCommand("createSelectionSideSession", {}, sessionId);
          if (
            (ack.status !== "accepted" && ack.status !== "duplicate") ||
            ack.result?.type !== "createSelectionSideSession"
          ) {
            throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
          }
          return ack.result.sessionId;
        });
        onOpenSelectionSideChat({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          parentSessionId: sessionId,
          childSessionId,
          ...(replacesChildSessionId ? { replacesChildSessionId } : {}),
        });
        if (reference) {
          dispatchConversationSelectionAdd({
            targetSessionId: childSessionId,
            workspaceKey,
            reference,
          });
        }
      } catch (error) {
        logger.warn("[v4-pane] 创建框选副屏会话失败", {
          error: error instanceof Error ? error.message : String(error),
          parentSessionId: sessionId,
          workspaceKey,
        });
      }
    },
    [
      activeSelectionSideChatSessionId,
      dispatchCommand,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
      zcodeSessionService,
    ],
  );

  const handleOpenSelectionSideConversationWithPrompt = useCallback(
    async (text: string, localTtft?: LocalTtftContext): Promise<boolean> => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) {
        throw new Error("selection side chat is unavailable");
      }
      // 参数命令每次都是新 child；同一条文本在 ACK 未回时重试仍复用 pending，
      // 不同文本则不能与 bare `/side` 或另一条 prompt 合并。
      const pendingKey = `${selectionSideChatKey}\u0000prompt\u0000${text}`;
      const childSessionId = await createSelectionSideChat(pendingKey, async () => {
        const ack = await dispatchCommand(
          "createSelectionSideSession",
          { firstInput: { text } },
          sessionId,
          undefined,
          undefined,
          localTtft,
        );
        if (
          (ack.status !== "accepted" && ack.status !== "duplicate") ||
          ack.result?.type !== "createSelectionSideSession"
        ) {
          throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
        }
        return ack.result.sessionId;
      });
      onOpenSelectionSideChat({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        parentSessionId: sessionId,
        childSessionId,
      });
      return true;
    },
    [
      dispatchCommand,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  useEffect(() => {
    if (
      !selectionSideChatKey ||
      !sessionId ||
      readOnly ||
      selectionSideChat ||
      isMobileTextInputViewport ||
      !onOpenSelectionSideChat
    ) {
      return;
    }

    // Side Pane 固定入口没有会话 Provider；这里只注册主 pane 已有的命令编排能力。
    // 父会话即使处于 Permission/AskUser 等阻塞态也保持注册，直接入口仍可创建/激活副屏。
    return registerSelectionSideChatOpener(
      selectionSideChatKey,
      // 合并时曾丢弃 reference，导致 Markdown 入口只建空白副屏；复用现有引用路由。
      (reference) => handleOpenSelectionSideConversation(reference, !reference),
      focused,
      Boolean(blockingInteractionId) || selectionSideActionBlocked,
    );
  }, [
    blockingInteractionId,
    selectionSideActionBlocked,
    focused,
    handleOpenSelectionSideConversation,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    selectionSideChatKey,
    sessionId,
  ]);

  const cliSlashCommandNames = useMemo(
    () =>
      new Set(
        (slashCommands ?? []).map((command) =>
          normalizeSlashCommandValue(command.name).toLowerCase(),
        ),
      ),
    [slashCommands],
  );
  const availableSelectionSideSlashCommandNames = useMemo(
    () => ["side", "btw"].filter((name) => !cliSlashCommandNames.has(name)),
    [cliSlashCommandNames],
  );

  // Plan 选中即开启标准 Composer 开关，不能等发送时解析文本；与 /side 共用本地操作入口。
  const appSlashCommands = useMemo<AppSlashCommand[] | undefined>(() => {
    if (readOnly) return undefined;
    const reloadActions: AppSlashCommand[] = sessionId
      ? [
          {
            value: "reload",
            recovery: true,
            description: intl.formatMessage({ id: "chat.slash.app.reload.description" }),
            keywords: ["reload", "restart", "重启"],
            run: taskRestart.restart,
          },
        ]
      : [];
    const planAction: AppSlashCommand = {
      value: "plan",
      description: intl.formatMessage({ id: "chat.slash.app.plan.description" }),
      keywords: ["plan", "计划", "计划模式"],
      run: () => handleDraftSwitchMode("plan"),
    };
    if (
      !sessionId ||
      !onOpenSelectionSideChat ||
      !shouldOfferSideSlashCommand({
        isDraft: sessionId === null,
        selectionSideChat,
        readOnly,
        isMobileViewport: isMobileTextInputViewport,
      })
    ) {
      return [...reloadActions, planAction];
    }
    const openNewSelectionSideChat = () => {
      void handleOpenSelectionSideConversation(undefined, true);
    };
    // 关键词固定同时包含中英文别名，任一 locale 下输入 side / btw / 辅助 都能搜到。
    // `/btw` 是 `/side` 的等价别名，适配不同用户输入习惯，面板中各自独立展示。
    const sharedKeywords = ["side", "btw", "side chat", "auxiliary", "辅助对话", "辅助", "侧边"];
    const description = intl.formatMessage({ id: "chat.slash.app.side.description" });
    return [
      ...reloadActions,
      planAction,
      ...[
        { value: "side", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
        { value: "btw", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
      ].filter((command) => !cliSlashCommandNames.has(command.value)),
    ];
  }, [
    taskRestart.restart,
    cliSlashCommandNames,
    handleDraftSwitchMode,
    handleOpenSelectionSideConversation,
    intl,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    sessionId,
  ]);

  const chatLoadingBlockedByInteraction = hasChatLoadingBlockingInteraction(
    snapshot?.pendingInteractions ?? [],
  );
  const chatLoadingBlockedByActiveWork = hasChatLoadingBlockingActiveWork(
    snapshot?.control.activeWorks ?? [],
  );
  // 子智能体详情的会话内容仍只读；文件撤销恢复的是 workspace，必须作为独立能力判断。
  const workspaceFileRewindEnabled = !readOnly || allowWorkspaceFileRewind;
  // cancelBackgroundWork：启动卡 / 后台任务卡的「取消」入口。定义在 rowContext memo 之前，
  // 供其绑定（onOpenWorkflowRun 同样在 memo 前定义）；只读模式下不下发（与 4213 处一致）。
  const handleCancelBackgroundWork = useCallback(
    (workId: string) => {
      if (!sessionId) return;
      void dispatchCommand("cancelBackgroundWork", { workId }, sessionId).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] cancelBackgroundWork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // 动态工作流灰度快照：只读 store，
  // 取数在 Root 里做一次。未就绪时 enabled 为 false，按未命中处理。
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();

  // resumeWorkflowRun：工具卡页脚的 Resume。与详情页
  // 同一条 v4 命令，不携 baseRevision；`name` 喂恢复后完成通知的主题。
  const handleResumeWorkflowRun = useCallback(
    (workId: string, name?: string) => {
      if (!sessionId) return;
      void dispatchCommand(
        "resumeWorkflowRun",
        { workId, ...(name ? { name } : {}) },
        sessionId,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] resumeWorkflowRun 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // amendWorkflowRunSettings：run 卡的「配置」。回 ACK 给弹层——拒绝理由画在弹层里，不是控制台的一行 warn。门与 Resume 相同。
  const handleAmendWorkflowRunSettings = useCallback(
    (workId: string, change: WorkflowRunSettingsChange): Promise<CommandAck> =>
      dispatchCommand("amendWorkflowRunSettings", { workId, ...change }, sessionId),
    [dispatchCommand, sessionId],
  );
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(snapshot?.sessionId === sessionId ? snapshot?.config : undefined),
    [sessionId, snapshot?.config, snapshot?.sessionId],
  );

  /**
   * 「让 ZCode 帮我提炼保存」那条用户消息的发送口（docs/dynamic-workflow/transcript-and-notifications.md
   * 「The message the lead sends」）：与中枢的「提升为全局」同一条先例——GUI 写、自动发、用户不再确认。
   *
   * 经 ref 转一手而不是直接引 `handleSendText`：后者定义在本文件更下面，而 rowContext 的 memo
   * 工厂在**同一次渲染里**就会跑到，直接引会落进 TDZ。ref 在渲染中赋值，点击总在挂载之后。
   */
  const sendTextRef = useRef<typeof handleSendText | null>(null);
  const handleSendWorkflowSaveRequest = useCallback(async (text: string) => {
    const send = sendTextRef.current;
    if (send === null) throw new Error("send path not mounted");
    const result = await send(text);
    // 被挡下（会话忙着确认别的、队列暂停待确认）就不是「已交给 ZCode」：抛回弹层，让它留在原处。
    if (result !== "sent") throw new Error(`workflow save request not sent: ${result}`);
  }, []);

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      workspaceRemoteSessionId: remoteSessionId ?? undefined,
      modelSelectionView: modelSelectionDisplayView,
      logEpoch: snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId: rootSessionId ?? sessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      nativeHideThinking,
      nativeDisplayMode,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      onNavigateToRow: handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx: runtimeReady ? handleAutoOpenAssistantPptx : undefined,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession:
        runtimeReady && onOpenSubagentSession ? handleOpenSubagentSession : undefined,
      onOpenPlanDetail: runtimeReady && onOpenPlanDetail ? handleOpenPlanDetail : undefined,
      onOpenWorkflowRun: runtimeReady && onOpenWorkflowRun ? handleOpenWorkflowRun : undefined,
      onOpenWorkflowActor:
        runtimeReady && onOpenWorkflowActorSession ? handleOpenWorkflowActorSession : undefined,
      onOpenWorkflowWorkspace:
        runtimeReady && onOpenWorkflowWorkspace ? handleOpenWorkflowWorkspace : undefined,
      onOpenWorkflowArtifact:
        runtimeReady && onOpenWorkflowArtifact ? handleOpenWorkflowArtifact : undefined,
      onCancelBackgroundWork: readOnly || !runtimeReady ? undefined : handleCancelBackgroundWork,
      // Resume 进入会话上下文的唯一供给点；灰度与只读两道门都在 resolveWorkflowResumeHandler 里，
      // 断在这里等于工具卡页脚与摘要卡的按钮一起消失。
      onResumeWorkflowRun: resolveWorkflowResumeHandler({
        readOnly: readOnly || !runtimeReady,
        dynamicWorkflowEnabled,
        handler: handleResumeWorkflowRun,
      }),
      onAmendWorkflowRunSettings:
        runtimeReady && sessionId
          ? resolveWorkflowResumeHandler({
              readOnly,
              dynamicWorkflowEnabled,
              handler: handleAmendWorkflowRunSettings,
            })
          : undefined,
      // 保存与 Resume 同一道门、同一个供给点：写文件与起引擎都属于「Resume 被收走的地方一并收走」
      // （docs/dynamic-workflow/launch.md「Gray release」）。芯片不经这道门，它只是一条事实。
      onSendWorkflowSaveRequest:
        runtimeReady && sessionId
          ? resolveWorkflowResumeHandler({
              readOnly,
              dynamicWorkflowEnabled,
              handler: handleSendWorkflowSaveRequest,
            })
          : undefined,
      workflowSaveCandidatesByRunId,
      ...(workflowSessionModel === undefined ? {} : { workflowSessionModel }),
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      fetchFileChanges: runtimeReady ? handleFetchFileChanges : undefined,
      previewFileRewind:
        runtimeReady && workspaceFileRewindEnabled ? handlePreviewFileRewind : undefined,
      applyFileRewind:
        runtimeReady && workspaceFileRewindEnabled ? handleApplyFileRewind : undefined,
      readAttachment: runtimeReady ? attachmentRead : undefined,
      readAttachmentRange: runtimeReady ? attachmentReadRange : undefined,
    }),
    [
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      remoteSessionId,
      modelSelectionDisplayView,
      snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      nativeHideThinking,
      nativeDisplayMode,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession,
      handleOpenSubagentSession,
      onOpenPlanDetail,
      handleOpenPlanDetail,
      onOpenWorkflowRun,
      handleOpenWorkflowRun,
      onOpenWorkflowActorSession,
      handleOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      handleOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      handleOpenWorkflowArtifact,
      readOnly,
      runtimeReady,
      handleCancelBackgroundWork,
      dynamicWorkflowEnabled,
      handleResumeWorkflowRun,
      handleAmendWorkflowRunSettings,
      handleSendWorkflowSaveRequest,
      workflowSaveCandidatesByRunId,
      workflowSessionModel,
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      workspaceFileRewindEnabled,
      handleFetchFileChanges,
      handlePreviewFileRewind,
      handleApplyFileRewind,
      attachmentRead,
      attachmentReadRange,
    ],
  );

  // ── 草稿态 v4 draft session 预热（m5）──
  // pane 未绑定会话时后台建 phase=draft 会话作预热载体：配置写 CAS 直达、首发复用。
  // 对外绑定语义不变（shell activeTaskId 仍 null），预热会话只是 pane 内部 effective 订阅目标。
  const { binding: prewarmBinding, waitForSession: waitForDraftSession } = useDraftSessionPrewarm({
    enabled: !nativeHostAvailable && sessionId === null && draftAgentStartupAllowed && !recoveringDraft,
    workspaceKey,
    paneId,
    invalidationVersion: draftRuntimeInvalidationVersion,
    // SessionDataLayer 来自 workspace connection registry：同 transport generation 的 pane/remount
    // 共享 identity；provider wrapper 重建产生的新 sendCommand 函数不能误判为 transport 换代。
    transportIdentity: layer,
    dispatchCommand,
    // 预热会话只消费当前 Root Composer Draft 的一次性初始化结果。
    resolveInitialConfig: resolveInitialDraftConfig,
  });
  const prewarmBindingRef = useRef(prewarmBinding);
  prewarmBindingRef.current = prewarmBinding;
  const prewarmSessionId = prewarmBinding?.sessionId ?? null;
  // runtime 换代（CUA Helper 就绪、liveness 恢复等触发 workspace-dispose）会冲掉草稿态尚未
  // 持久化的预热会话。重建期间禁止发送，否则附件会挂在已消失的会话上（sessionNotFound）。
  const { rebuilding: draftRuntimeRebuilding } = useDraftRuntimeRebuildGate({
    enabled: !nativeHostAvailable && sessionId === null,
    onRuntimeRestart,
    onRuntimeLifecycle,
    prewarmSessionId,
    workspaceIdentity,
    workspacePath,
  });
  const ensureDraftPrewarmConfigBeforeSendRef = useRef<(targetSessionId: string) => Promise<void>>(
    async () => undefined,
  );
  const effectiveSessionId = sessionId ?? nativeDraftSessionId ?? recoveringDraft?.sessionId ?? prewarmSessionId;
  const sessionRuntimeReady = Boolean(
    effectiveSessionId &&
    lease?.sessionId === effectiveSessionId &&
    snapshot?.sessionId === effectiveSessionId &&
    (!snapshot.runtimeInitialization || snapshot.runtimeInitialization.status === "ready"),
  );
  useEffect(() => {
    if (sessionId === null && effectiveSessionId && sessionRuntimeReady && snapshot) {
      observeDraftPermissionGrant(effectiveSessionId, snapshot.config);
    }
  }, [
    sessionId,
    effectiveSessionId,
    sessionRuntimeReady,
    snapshot?.config,
    observeDraftPermissionGrant,
  ]);

  useEffect(() => {
    if (!recoveringDraft?.commandId || !remoteAvailable) return;
    let current = true;
    const commandId = recoveringDraft.commandId;
    const off = pendingCommandRegistry.subscribeResolution(commandId, (resolution) => {
      if (!current) return;
      if (
        resolution === "accepted" ||
        resolution === "duplicate" ||
        resolution === "authoritative"
      ) {
        const entry = pendingCommandRegistry.findCommand(commandId);
        const recoveredSessionId = entry?.sessionId ?? recoveringDraft.sessionId;
        if (recoveredSessionId)
          void handleDraftSessionCreated(
            recoveredSessionId,
            commandId,
            entry?.clientContext?.taskGroupId,
          );
      } else if (resolution === "failed" || resolution === "discarded") {
        setResolvedDraftCommand(commandId);
      }
    });
    void pendingCommandRegistry
      .reconcileSession(
        pendingCommandRegistry.findCommand(commandId)?.sessionId ??
          recoveringDraft.sessionId ??
          null,
        (params) => layer.queryCommands(params),
        workspaceIdentity?.trim() || workspacePath,
      )
      .catch((error) => {
        logger.warn("[v4-composer] 首发结果恢复查询失败，保留草稿身份", error);
      });
    return () => {
      current = false;
      off();
    };
  }, [
    recoveringDraft,
    remoteAvailable,
    layer,
    handleDraftSessionCreated,
    newTaskComposerScope,
    workspacePath,
    workspaceIdentity,
  ]);
  const showModelChangeNotice = useCallback(
    (sourceModel: ModelSelectionSource | null, targetModel: ModelSelectionSource) => {
      // Bug 原因：草稿尚未形成实际会话，模型选择本身已经在 composer 中可见；
      // 若此时重复弹出切换结果，会把初始化或 prewarm fallback 误报成一次会话内切换。
      if (sessionId === null) {
        return;
      }

      const fromProviderId = sourceModel?.provider ?? "";
      const fromModelId = sourceModel?.model ?? "";
      const providerChanged = Boolean(
        fromProviderId && targetModel.provider && fromProviderId !== targetModel.provider,
      );
      if (
        !fromModelId ||
        !targetModel.model ||
        (fromModelId === targetModel.model && !providerChanged)
      ) {
        return;
      }

      const fromProvider = resolveProviderLabel(fromProviderId, modelSelectionView);
      const toProvider = resolveProviderLabel(targetModel.provider, modelSelectionView);
      const fromModel = formatModelChangeLabel(fromProviderId, fromProvider, fromModelId, intl);
      const toModel = formatModelChangeLabel(
        targetModel.provider,
        toProvider,
        targetModel.model,
        intl,
      );
      toast(intl.formatMessage({ id: "chat.modelChangeNotice.changed" }, { fromModel, toModel }));
    },
    [intl, modelSelectionView, sessionId],
  );

  const handleOnlineModelTransition = useCallback(
    (
      subscribedSessionId: string,
      _store: SessionLease["store"],
      transition: SessionModelTransition,
    ) => {
      if (!focused || subscribedSessionId !== effectiveSessionId) return;
      // Bug 原因：自动 fallback 的提示与偏好晋升过去分别由 online 事件和任意
      // snapshot 差异驱动，recovery/历史投影可能静默改写下一草稿。现在两者都只
      // 消费 store 已按 deliveryKind 去重后的同一 realtime online 事件。
      showModelChangeNotice(transition.from, transition.to);
    },
    [
      effectiveSessionId,
      focused,
      provider,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );
  const onlineModelTransitionHandlerRef = useRef(handleOnlineModelTransition);
  useLayoutEffect(() => {
    onlineModelTransitionHandlerRef.current = handleOnlineModelTransition;
  }, [handleOnlineModelTransition]);

  const recoverableCommands = usePendingCommandRecovery({
    layer,
    sessionId: effectiveSessionId,
    snapshot,
    status: state.status,
    subscriptionId: state.subscriptionId,
    workspacePath,
    workspaceIdentity,
  });

  useEffect(() => {
    if (!effectiveSessionId) {
      setLease({ sessionId, layer, lease: null });
      return;
    }
    const nextLease = layer.acquire(effectiveSessionId);
    // Bug 原因：acquire 会立即启动 connect，activation 可能在下一轮 effect 前释放
    // 一次性 online 帧；必须在 acquire 返回后同步监听，不能靠 snapshot 重放补偿。
    const offOnlineModelTransition = nextLease.store.onOnlineModelTransition((transition) => {
      onlineModelTransitionHandlerRef.current(effectiveSessionId, nextLease.store, transition);
    });
    setLease({ sessionId, layer, lease: nextLease });
    return () => {
      offOnlineModelTransition();
      nextLease.release();
    };
  }, [layer, effectiveSessionId]);

  useEffect(() => {
    if (
      !extendedConversationAvailable ||
      !sessionId ||
      !lease ||
      snapshot?.sessionId !== sessionId
    )
      return;
    void lease.store.refreshPlans();
  }, [
    extendedConversationAvailable,
    lease,
    sessionId,
    snapshot?.sessionId,
    state.planDirectoryRevision,
  ]);

  // 预热会话订阅失败（CLI 重启内存会话消失等）→ 丢弃旧 binding，下一次发送由 owner 重试。
  useEffect(() => {
    if (sessionId === null && prewarmBinding && state.status === "error") {
      logger.warn("[v4-draft-prewarm] 预热会话订阅失败，丢弃旧 binding", {
        prewarmSessionId: prewarmBinding.sessionId,
        lastError: state.lastError ?? null,
      });
      prewarmBinding.discard();
    }
  }, [prewarmBinding, sessionId, state.lastError, state.status]);

  useEffect(() => {
    if (
      !selectionSideChat ||
      state.status !== "error" ||
      !state.lastError?.includes("sessionNotFound")
    ) {
      return;
    }
    // 副屏是临时 UI 绑定；持久 child 丢失后清 tab，下一次框选按父会话重建。
    onSelectionSideChatUnavailable?.();
  }, [onSelectionSideChatUnavailable, selectionSideChat, state.lastError, state.status]);

  const settleCurrentQueueInputs = useCallback((targetSessionId: string) => {
    const current = snapshotRef.current;
    if (!current || current.sessionId !== targetSessionId) return;
    for (const item of current.queue.items) {
      pendingCommandRegistry.settle(targetSessionId, item.sourceCommandId);
    }
  }, []);

  const dispatchSlashCommand = useCallback(
    async (
      command: V4VisibleSlashCommand,
      targetSessionId: string,
      baseRevision: number | undefined,
      heldQueueDisposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
      expectedHeldQueueItemIds?: readonly string[],
      submission?: ComposerSubmissionConfig,
    ): Promise<boolean | "confirmationRequired"> => {
      let type: CommandType | null = null;
      let payload: Record<string, unknown> = {};
      // compact 是可排队 input command，不走 CAS；resumeGoal 仍是 CAS。
      let withBaseRevision = false;
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      const compactExpectedToQueue =
        command.kind === "compact" &&
        currentRoutingMode !== undefined &&
        currentRoutingMode !== "startNow";
      switch (command.kind) {
        case "compact":
          type = "compact";
          // 旧命令丢掉 Composer 选择，摘要因此沿用旧会话模型；固定本次提交，后续改选不回写。
          if (!submission) return false;
          payload = { modelSelection: submission.modelSelection };
          break;
        case "sendGoalCommand":
          type = "sendGoalCommand";
          // 人工合并曾让 /goal 在准备完成后重新读取 Composer，覆盖点击时已冻结的档位。
          // 与 sendText 一样沿用本次 Submission；后续菜单修改只影响下一次发送。
          if (!submission) return false;
          payload = {
            text: command.objective,
            displayText: command.displayText,
            ...submission,
            ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
            ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          };
          break;
        case "resumeGoal":
          type = "resumeGoal";
          withBaseRevision = true;
          break;
        case "emptyGoal":
          logger.warn("[v4-pane] /goal 需要目标文本");
          return true;
        case "unsupportedGoal":
          logger.warn(`[v4-pane] 暂不支持 /goal ${command.action}`);
          return true;
        default:
          return false;
      }
      if (withBaseRevision && baseRevision === undefined) {
        logger.warn(`[v4-pane] slash ${command.kind} 缺少 baseRevision`);
        return true;
      }
      const ack = await dispatchCommand(
        type,
        payload,
        targetSessionId,
        withBaseRevision ? baseRevision : undefined,
      );
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired";
      }
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(
          `[v4-pane] slash ${command.kind} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
        );
        if (command.kind === "compact" && ack.reasonCode === "compactOperationLock") {
          toast(intl.formatMessage({ id: "chat.compact.duplicateBlocked" }));
        } else if (command.kind === "compact" && ack.reasonCode === "activeTurn") {
          // 兼容尚未升级的 CLI：旧端仍会返回 activeTurn，不能再次无声清空命令。
          toast(intl.formatMessage({ id: "chat.compact.runningBlocked" }));
        }
      } else if (command.kind === "compact" && compactExpectedToQueue) {
        toast(intl.formatMessage({ id: "chat.compact.queued" }));
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
      return true;
    },
    [dispatchCommand, intl, settleCurrentQueueInputs],
  );

  const dispatchSendTextAfterConfig = useCallback(
    async (
      text: string,
      options: ConversationComposerSendOptions | undefined,
      taskGroupIdAtSend?: string | null,
    ) => {
      if (nativeHostAvailable || modelSelectionView?.nativeSession !== undefined) {
        const targetSessionId = sessionId ?? await ensureNativeDraftSession();
        if (sessionId) {
          if (!modelSelectionView?.nativeSession?.chatAvailable ||
              modelSelectionView.nativeSession.sessionId !== sessionId ||
              modelSelectionView.nativeSession.workspacePath !== workspacePath)
            return "blocked" as const;
          const nativeSnapshot = snapshotRef.current;
          if (nativeSnapshot?.sessionId !== sessionId || nativeSnapshot.inputRouting.mode === "reject")
            return "blocked" as const;
        }
        let submission = options?.submission ?? createSubmissionFromComposer();
        if (!submission) {
          if (!modelSelectionService) throw new Error("Native model selection service is unavailable");
          const view = await modelSelectionService.getView({ sessionId: targetSessionId, selection: null });
          if (view.nativeSession?.sessionId !== targetSessionId || view.nativeSession.workspacePath !== workspacePath)
            throw new Error("The native model view belongs to another session");
          submission = createComposerSubmissionConfig(draftConfigRef.current, view);
        }
        if (!submission) throw new Error("Select an available model for this native session");
        // Native chat 使用同一命令与投影生命周期。
        const ack = await dispatchCommand(
          "sendText",
          {
            text,
            ...submission,
            ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
            ...(options?.conversationQuotes?.length ? { conversationQuotes: options.conversationQuotes } : {}),
            ...(options?.requestedDelivery ? { requestedDelivery: options.requestedDelivery } : {}),
            ...(options?.heldQueueDisposition ? { heldQueueDisposition: options.heldQueueDisposition } : {}),
            ...(options?.expectedHeldQueueItemIds ? { expectedHeldQueueItemIds: options.expectedHeldQueueItemIds } : {}),
            ...(options?.source ? { source: options.source } : {}),
          },
          targetSessionId,
          undefined,
          undefined,
          options?.localTtft,
          options?.onCommandCreated
            ? (envelope) => options.onCommandCreated?.(envelope.commandId)
            : undefined,
        );
        if (ack.reasonCode === "guard.heldQueueConfirmationStale")
          return "confirmationRequired" as const;
        if (ack.status !== "accepted") throw new Error(ack.message ?? ack.reasonCode ?? "sendText rejected");
        const navigation = nativeDraftNavigation.current;
        if (sessionId === null && nativeDraftOwnerRef.current === nativeDraftOwnerKey &&
            !(navigation?.ownerKey === nativeDraftOwnerKey && navigation.sessionId !== targetSessionId) &&
            composerBindingRef.current.workspaceKey === workspaceKey && composerBindingRef.current.sessionId === null) {
          const handoff = captureV4ComposerDraftHandoff(workspacePath, workspaceIdentity, composerClientNamespace);
          const submittedRefs = new Set(options?.attachments?.map((attachment) => attachment.ref) ?? []);
          const remaining = handoff.attachments.filter((attachment) =>
            !submittedRefs.has((attachment as { attachmentRef?: AttachmentRef }).attachmentRef?.ref ?? ""));
          if (remaining.length > 0) {
            stageV4ComposerDraftAttachments(workspacePath, workspaceIdentity, composerDraftGeneration,
              { ...handoff, attachments: remaining }, targetSessionId);
            const source = nativeAttachmentTarget.current;
            if (source.sessionId === null) remaining.forEach((attachment) => source.target?.removeFile(attachment.id));
          }
          if (promoteComposerDraft(targetSessionId)) onSessionCreated?.(targetSessionId);
        }
        return;
      }
      const dispatchSubmissionCommand = async (...args: Parameters<typeof dispatchCommand>) => {
        args[8] = taskGroupIdAtSend;
        args[9] = options?.submittedDraftText ?? text;
        if (args[0] === "sendText") args[1] = { ...args[1], genUiContext: [] };
        if (
          args[0] === "sendText" &&
          args[2] &&
          baseWorkspaceServices.genUiService &&
          typeof args[1]?.text === "string"
        ) {
          try {
            const context = selectGenUiModelContext(
              await baseWorkspaceServices.genUiService.listState({
                workspacePath,
                workspaceIdentity,
                sessionId: args[2],
              }),
            );
            // 页面状态曾混入 text，队列等出口因此泄漏尾块；正文与快照随同一命令分开传递。
            args[1] = { ...args[1], genUiContext: context };
          } catch {
            // 状态是辅助上下文；读取失败不能阻断既有 CommandInbox 输入路径。
            logger.warn("[gen-ui] Widget context unavailable");
          }
        }
        return dispatchCommand(...args);
      };
      // 进入 barrier 前已经冻结；等待配置/附件期间不再回读 Composer 或 Session。
      const submission = options?.submission ?? null;
      const heldQueueDisposition = options?.heldQueueDisposition;
      const expectedHeldQueueItemIds = options?.expectedHeldQueueItemIds;
      const readyAttachments = options?.attachments ?? [];
      const contextAttachmentCount = options?.contextAttachmentCount ?? 0;
      const slashCommand = parseV4VisibleSlashCommand(text, readyAttachments, {
        contextAttachmentCount,
      });

      if (!draftProjectReady || !(await ensureDraftModelReadyForSend())) {
        return "blocked" as const;
      }

      const selectionSideSlashCommand =
        sessionId &&
        appSlashCommands?.some((command) => command.value === "side" || command.value === "btw")
          ? parseSelectionSideSlashCommand(text, readyAttachments, {
              contextAttachmentCount,
              enabledCommandNames: availableSelectionSideSlashCommandNames,
            })
          : null;
      if (sessionId && selectionSideSlashCommand) {
        const created = await handleOpenSelectionSideConversationWithPrompt(
          selectionSideSlashCommand.text,
          options?.localTtft,
        );
        return created ? ("sent" as const) : ("blocked" as const);
      }
      if (
        submission?.planEnabled &&
        slashCommand !== null &&
        (slashCommand.kind === "sendGoalCommand" ||
          slashCommand.kind === "resumeGoal" ||
          slashCommand.kind === "emptyGoal" ||
          slashCommand.kind === "unsupportedGoal")
      ) {
        // Plan 模式不能创建、更新或恢复 goal。必须在 draft promotion / command dispatch
        // 之前拒绝，否则即使 CLI 后续拒绝，composer 也会误以为发送成功并清空用户输入。
        toast(intl.formatMessage({ id: "chat.goal.planModeBlocked" }));
        return "blocked" as const;
      }
      if (!submission) {
        logger.warn("[v4-pane] Submission 缺少完整模型或模式配置");
        return "blocked" as const;
      }
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      if (
        currentRoutingMode === "choice" &&
        !heldQueueDisposition &&
        (slashCommand === null || slashCommand.kind === "sendGoalCommand")
      ) {
        // UI choice 只对普通输入和 /goal <新目标> 生效；/compact 直接追加暂停队列，
        // resumeGoal 等控制命令也不应被发送消息确认框截获。
        return "confirmationRequired" as const;
      }
      const prewarmTargetBeforeSend =
        sessionId === null ? prewarmBindingRef.current?.sessionId : null;
      if (prewarmTargetBeforeSend) {
        // 屏障只保证已经入队的命令完成；若点击配置时预热 session/snapshot 尚未
        // 就绪，命令可能当时没有目标。首发绑定确定的预热 session 前再同步一次
        // 草稿权威配置，禁止 UI 新值与 runtime 旧值分叉。
        await ensureDraftPrewarmConfigBeforeSendRef.current(prewarmTargetBeforeSend);
      }
      // slash 命令优先：已有 session 直接消费；draft 首发 /goal 先建空会话再发命令。
      // 携带附件或网页元素上下文时不消费为 v4 原生命令（compact/goal 等无附件语义），随 sendText 直发。
      if (sessionId && slashCommand) {
        const consumed = await dispatchSlashCommand(
          slashCommand,
          sessionId,
          snapshotRef.current?.revision,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          return;
        }
      }
      const draftSlashCommand =
        slashCommand?.kind === "sendGoalCommand" ||
        slashCommand?.kind === "resumeGoal" ||
        slashCommand?.kind === "emptyGoal" ||
        slashCommand?.kind === "unsupportedGoal"
          ? slashCommand
          : null;
      if (!sessionId && draftSlashCommand) {
        if (
          draftSlashCommand.kind === "emptyGoal" ||
          draftSlashCommand.kind === "unsupportedGoal"
        ) {
          await dispatchSlashCommand(
            draftSlashCommand,
            prewarmBindingRef.current?.sessionId ?? "__draft__",
            undefined,
            heldQueueDisposition,
            expectedHeldQueueItemIds,
            submission,
          );
          return;
        }
      }
      // Bug 根因：首发曾把 binding=null 当成无预热，绕过 owner 再建一个会话。
      // 文本、附件/context 和 goal 都等待同一创建任务，创建失败或换代直接保留草稿。
      const draftBinding = sessionId === null ? await waitForDraftSession() : null;
      if (draftBinding) {
        await ensureDraftPrewarmConfigBeforeSendRef.current(draftBinding.sessionId);
        if (!draftBinding.beginPromotion()) throw new Error("草稿会话已切换，请重新发送");
      }
      const targetSessionId = sessionId ?? draftBinding!.sessionId;
      if (draftBinding && draftSlashCommand) {
        const consumed = await dispatchSlashCommand(
          draftSlashCommand,
          targetSessionId,
          0,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          draftBinding.promote();
          await handleDraftSessionCreated(
            targetSessionId,
            undefined,
            taskGroupIdAtSend,
          );
          return;
        }
      }
      // admission 写出后的失败或 transport error 不能证明 CLI 没有执行；保留原 binding
      // 的 pending 生命周期，交给 Composer 保留输入，禁止自动换会话/command 重发。
      // 附件 ref 已在 composer 预传状态机中收口。
      const ack = await dispatchSubmissionCommand(
        "sendText",
        {
          text,
          ...submission,
          ...(options?.requestedDelivery ? { requestedDelivery: options.requestedDelivery } : {}),
          conversationQuotes: options?.conversationQuotes,
          ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
          ...(sessionId && options?.requestedDelivery
            ? {
                // Bug 根因：立即发送曾先投影 QueueItem，再等待二次
                // sendQueuedNow，导致队列中间态外泄且输入框延迟清空。现在由
                // CLI 原子 stop + start，accepted ACK 即是 Composer 清空边界。
                requestedDelivery: options.requestedDelivery,
              }
            : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(options?.source ? { source: options.source } : {}),
        },
        targetSessionId,
        undefined,
        undefined,
        options?.localTtft,
        options?.onCommandCreated
          ? (envelope) => {
              if (envelope.type === "sendText") options.onCommandCreated?.(envelope.commandId);
            }
          : undefined,
      );
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired" as const;
      }
      if (ack.status !== "accepted") {
        throw new Error(ack.message ?? ack.reasonCode ?? "sendText 被拒绝");
      }
      if (draftBinding) {
        draftBinding.promote();
        await handleDraftSessionCreated(
          targetSessionId,
          ack.commandId,
          taskGroupIdAtSend,
        );
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
    },
    [
      dispatchCommand,
      baseWorkspaceServices,
      dispatchSlashCommand,
      draftProjectReady,
      ensureDraftModelReadyForSend,
      availableSelectionSideSlashCommandNames,
      appSlashCommands,
      handleDraftSessionCreated,
      handleOpenSelectionSideConversationWithPrompt,
      intl,
      createSubmissionFromComposer,
      modelSelectionView,
      nativeHostAvailable,
      ensureNativeDraftSession,
      modelSelectionService,
      draftConfigRef,
      promoteComposerDraft,
      onSessionCreated,
      nativeDraftOwnerKey,
      workspaceKey,
      workspacePath,
      workspaceIdentity,
      composerClientNamespace,
      composerDraftGeneration,
      sessionId,
      settleCurrentQueueInputs,
      waitForDraftSession,
    ],
  );

  const dispatchSendText = useCallback(
    (text: string, options?: ConversationComposerSendOptions) => {
      const submissionOptions = {
        ...options,
        submission:
          options?.submission === undefined ? createSubmissionFromComposer() : options.submission,
      };
      const taskGroupId =
        sessionId === null
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .draftTaskGroupId
          : undefined;
      // followupMode 仍通过 Session CAS 同步；模型和模式已封装进 Submission，不再
      // 依赖“配置命令先到、sendText 后到”的跨命令时序。
      return configCommandBarrier.enqueue(async () => {
        try {
          return await dispatchSendTextAfterConfig(
            text,
            submissionOptions,
            taskGroupId,
          );
        } catch (error) {
          if (sessionId === null && isProviderNotReadyError(error)) {
            // UI 预检查与 Host getClient 之间 registry 仍可能失效。竞态命中时收敛成
            // 同一个正常等待态，不走异常发送路径，也不清空 composer。
            markDraftProviderNotReady();
            return "blocked" as const;
          }
          throw error;
        }
      });
    },
    [
      configCommandBarrier,
      createSubmissionFromComposer,
      dispatchSendTextAfterConfig,
      markDraftProviderNotReady,
      sessionId,
      workspacePath,
      workspaceIdentity,
    ],
  );

  const focusTimelineToLatest = useCallback(() => {
    timelineScrollToBottomRef.current?.();
  }, []);

  const handleSendText = useCallback(
    async (
      text: string,
      options?: ConversationComposerSendOptions,
    ): Promise<ConversationComposerSendResult> => {
      // 发送前冻结本次 admission 预期：command ACK 回来时 projection 可能已经切到 running，
      // 不能用更新后的 enqueue mode 反推刚提交的 prompt 是否原本立即发送。
      const shouldFocusLatest = shouldFocusTimelineAfterComposerSend({
        draftMode: sessionId === null,
        inputRoutingMode: snapshotRef.current?.inputRouting.mode ?? null,
        heldQueueDisposition: options?.heldQueueDisposition,
      });
      try {
        const sendResult = await dispatchSendText(text, options);
        if (sendResult === "blocked" || sendResult === "confirmationRequired") {
          return sendResult;
        }
        setSendSubmissionError(null);
        if (shouldFocusLatest) {
          focusTimelineToLatest();
        }
        return "sent";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const runtimeModelUnavailable = detail.includes("provider.notInRegistry");
        // 首发前 switchModelConfig 失败只会抛回 Composer；Composer 为了保留草稿
        // 仅写日志，不会生成 snapshot.control.lastError，用户看到的结果就是“点击没反应”。
        // 这里把 admission 前失败收口为 pane-local 错误横幅，不改变 desktop continuous 或
        // Web remote replayable 的发送/恢复语义，草稿仍由 Composer 原路径保留。
        setSendSubmissionError({
          code:
            getRemoteConnectionFailureCode(error) ??
            (runtimeModelUnavailable ? "ZCODE_RUNTIME_MODEL_UNAVAILABLE" : "SEND_FAILED"),
          message: runtimeModelUnavailable
            ? detail
            : intl.formatMessage({ id: "chat.error.sendFailed" }),
          detail,
          ...(sessionId ? { taskId: sessionId } : {}),
        });
        throw error;
      }
    },
    [dispatchSendText, focusTimelineToLatest, intl, sessionId],
  );
  // 上面那个 ref 的唯一赋值点（见 handleSendWorkflowSaveRequest 的说明）。
  sendTextRef.current = handleSendText;

  const handleComposerDraftStateChange = useCallback(
    (state: { hasContent: boolean; busy: boolean }) => {
      composerDraftStateRef.current = state;
    },
    [],
  );
  const clearQueueEditOperation = useCallback(() => {
    queueEditOperationRef.current = null;
    setQueueEditOperation(null);
  }, []);
  const handleComposerRestoreApplied = useCallback(
    (requestId: number) => {
      setComposerRestoreRequest((current) => (current?.requestId === requestId ? null : current));
      clearQueueEditOperation();
    },
    [clearQueueEditOperation],
  );
  const handleFork = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // forkAssistant 是 CAS 命令：baseRevision 取当前投影 revision。
      void dispatchCommand(
        "forkAssistant",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          logger.warn(`[v4-pane] fork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          return;
        }
        if (ack.result?.type === "forkAssistant") {
          // 原地切到 child session（与新建会话同一选择路径）。
          onSessionCreated?.(ack.result.sessionId);
        }
      });
    },
    [dispatchCommand, onSessionCreated, sessionId],
  );

  const handleEdit = useCallback(
    async (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
      workspaceMode: "preserve" | "rewind" = "preserve",
      conversationQuotes?: import("@zcode/shared").ConversationSelectionText[],
    ) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      if (
        !newText.trim() &&
        (!attachments || attachments.length === 0) &&
        !conversationQuotes?.length
      ) {
        logger.warn("[v4-pane] edit 跳过：行内编辑内容为空且无附件");
        return false;
      }
      const latest = snapshotRef.current;
      if (!latest || latest.sessionId !== sessionId) {
        logger.warn("[v4-pane] edit 跳过：session 已切换");
        return false;
      }
      const ack = await dispatchCommand(
        "editUserQuery",
        {
          target,
          newText,
          workspaceMode,
          conversationQuotes,
          // editUserQuery 的 attachments 缺省表示保留 canonical 原附件；
          // 只有显式透传 []，CLI 才能区分“用户删除全部”与“调用方未修改附件”。
          ...(attachments ? { attachments: [...attachments] } : {}),
        },
        sessionId,
        latest.revision,
        latest.logEpoch,
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        logger.warn(`[v4-pane] edit 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        throw new Error(ack.message ?? ack.reasonCode ?? "editUserQuery rejected");
      }
      if (
        modelSelectionView?.nativeSession !== undefined &&
        ack.result?.type === "editUserQuery" &&
        ack.result.disposition === "fork"
      ) {
        onSessionCreated?.(ack.result.sessionId);
      }
      return ack;
    },
    [dispatchCommand, sessionId, modelSelectionView, onSessionCreated],
  );

  const handleAssistantFeedback = useCallback(
    async (
      target: ConversationRowTarget,
      feedback: "like" | "dislike" | null,
    ): Promise<boolean> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      const ack = await dispatchCommand(
        "setAssistantFeedback",
        { target, feedback },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      const accepted = ack.status === "accepted" || ack.status === "duplicate";
      if (!accepted) {
        logger.warn(`[v4-pane] assistant 反馈被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
      return accepted;
    },
    [dispatchCommand, sessionId],
  );

  const handleDeleteQueueItem = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      const sourceCommandId = current.queue.items.find(
        (item) => item.queueItemId === queueItemId,
      )?.sourceCommandId;
      void dispatchCommand("deleteQueueItem", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] deleteQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
            return;
          }
          if (sourceCommandId) pendingCommandRegistry.settle(sessionId, sourceCommandId);
        },
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleEditQueueItem = useCallback(
    async (queueItemId: string): Promise<void> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null || queueEditOperationRef.current) return;
      if (composerDraftStateRef.current.hasContent || composerDraftStateRef.current.busy) {
        toast(intl.formatMessage({ id: "chat.queue.editDraftConflict" }));
        return;
      }
      const restoreTarget = resolveQueuedComposerRestore(current, queueItemId);
      if (!restoreTarget) {
        logger.warn(`[v4-pane] queue 撤回编辑跳过：queue item 不存在或不可编辑 ${queueItemId}`);
        return;
      }
      const operation = { queueItemId, sessionId, workspaceKey };
      queueEditOperationRef.current = operation;
      setQueueEditOperation(operation);
      try {
        const ack = await dispatchCommand(
          "deleteQueueItem",
          { queueItemId },
          sessionId,
          restoreTarget.baseRevision,
        );
        if (!shouldRestoreQueuedComposerFromAck(ack.status)) {
          logger.warn(`[v4-pane] queue 撤回编辑被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
          clearQueueEditOperation();
          return;
        }
        pendingCommandRegistry.settle(sessionId, restoreTarget.sourceCommandId);
        const currentBinding = composerBindingRef.current;
        if (
          currentBinding.sessionId !== sessionId ||
          currentBinding.workspaceKey !== workspaceKey
        ) {
          // delete ACK 异步返回时 pane 可能已切 task；旧实现若直接 setText，
          // 会把原 session 的 queue payload 写进新 task。权威删除保留，但本地恢复必须放弃。
          logger.warn("[v4-pane] queue 撤回编辑未恢复：ACK 返回前 composer 已切换", {
            queueItemId,
            sessionId,
            workspaceKey,
          });
          clearQueueEditOperation();
          return;
        }
        setComposerRestoreRequest({
          requestId: nextComposerRestoreRequestIdRef.current++,
          sessionId,
          workspaceKey,
          inputKind: restoreTarget.inputKind,
          text: restoreTarget.text,
          attachments: restoreTarget.attachments,
          config: restoreTarget.config,
        });
      } catch (error) {
        logger.warn("[v4-pane] queue 撤回编辑命令失败", error);
        toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
        clearQueueEditOperation();
      }
    },
    [clearQueueEditOperation, dispatchCommand, intl, sessionId, workspaceKey],
  );

  const handleSendQueuedNow = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // 用户明确点击“立即发送”时，视觉意图等价于点击“滚动到底部”；command 的
      // reserve/stop/promote 生命周期仍由 CLI 裁决，不把滚动状态混入协议。
      focusTimelineToLatest();
      void (async () => {
        const latest = snapshotRef.current;
        const latestQueueItem = latest?.queue.items.find(
          (item) => item.queueItemId === queueItemId,
        );
        if (!latest || latest.sessionId !== sessionId || !latestQueueItem) {
          logger.warn("[v4-pane] sendQueuedNow 跳过：队列状态已变化", {
            queueItemId,
          });
          return null;
        }
        return dispatchCommand(
          "sendQueuedNow",
          { queueItemId },
          sessionId,
          latest.revision,
        );
      })().then((ack) => {
        if (!ack) return;
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] sendQueuedNow 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [
      dispatchCommand,
      focusTimelineToLatest,
      sessionId,
    ],
  );

  const handleReorderQueueItem = useCallback(
    (queueItemId: string, beforeQueueItemId: string | null) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      void dispatchCommand(
        "reorderQueueItem",
        { queueItemId, beforeQueueItemId },
        sessionId,
        current.revision,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] reorderQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  const handleResumeQueue = useCallback(async () => {
    const current = snapshotRef.current;
    if (!sessionId || !current || current.queue.autoDrain || current.queue.items.length === 0) {
      return;
    }
    const ack = await dispatchCommand(
      "setAutoDrain",
      { autoDrain: true },
      sessionId,
      current.revision,
    );
    if (ack.status !== "accepted" && ack.status !== "noop") {
      logger.warn(`[v4-pane] 恢复暂停队列被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
    }
  }, [dispatchCommand, sessionId]);

  // 配置面 CAS 命令的 stale 重试。模型→思考深度→模式连续操作时，前一条命令的
  // revision bump 可能尚未回流到本地投影，直接用本地 revision 会被 CAS 判 stale。
  // stale ack 带 revisionAtDecision（CLI 当前 revision），用它重试即可收敛（有界 3 次）。
  // m5：目标 = effective session（已绑定会话或草稿预热会话）；投影必须与目标
  // 同源（snapshot.sessionId 校验），防止预热切换瞬间用错 revision。
  const dispatchConfigCas = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      options?: { initialBaseRevision?: number; targetSessionId?: string },
    ): Promise<CommandAck | null> => {
      const targetSessionId =
        options?.targetSessionId ?? sessionId ?? prewarmBindingRef.current?.sessionId ?? null;
      const current = snapshotRef.current;
      if (!targetSessionId) {
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "skipped",
          reasonCode: "no-session",
          at: Date.now(),
        });
        return null;
      }
      // draft 预热会话已经创建、snapshot 尚未投影时，旧逻辑直接跳过
      // 配置 CAS；首发随后沿用 runtime 的 build 缺省。CAS 本身支持 stale revision
      // 回包重试，因此无 snapshot 时从 0 起步也能确定收敛，不能把“未投影”当成功。
      let baseRevision =
        options?.initialBaseRevision ??
        (current?.sessionId === targetSessionId ? current.revision : 0);
      let lastAck: CommandAck | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const ack = await dispatchCommand(type, payload, targetSessionId, baseRevision);
          lastAck = ack;
          if (ack.status === "stale") {
            baseRevision = ack.revisionAtDecision;
            continue;
          }
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] ${type} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
          return ack;
        }
        logger.warn(`[v4-pane] ${type} 连续 stale，放弃重试`);
        return lastAck;
      } catch (error) {
        if (isProviderNotReadyError(error)) {
          // provider readiness 竞态被配置 CAS 吞成 null 后，首发会改写成
          // missing-ack，草稿页无法恢复成模型配置引导。确定性启动门禁必须原样上抛。
          throw error;
        }
        // 生产 renderer 日志关闭，异常也进 ack 调试缓冲，避免静默丢失。
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "dispatch-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        logger.warn(`[v4-pane] ${type} 失败: ${String(error)}`);
        return null;
      }
    },
    [dispatchCommand, sessionId],
  );
  const ensureDraftPrewarmConfigBeforeSend = useCallback(
    async (targetSessionId: string) => {
      // followupMode 仍是 Session 行为设置；模型与模式属于本次 Submission，随 sendText
      // 原子提交，不能在发送前通过 CAS 改写共享 Session。
      const desiredConfig = buildDraftCreateConfigPayload(
        draftConfigRef.current,
        appFollowupMode,
      ).config;
      if (!desiredConfig) return;
      const projectedConfig =
        snapshotRef.current?.sessionId === targetSessionId ? snapshotRef.current.config : null;

      const requireAcceptedConfigAck = (type: CommandType, ack: CommandAck | null) => {
        if (
          ack &&
          (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate")
        ) {
          return;
        }
        throw new Error(
          `${type} 未在首发前收敛: ${ack?.status ?? "missing-ack"} ${ack?.reasonCode ?? ""}`,
        );
      };

      if (
        desiredConfig.followupMode &&
        desiredConfig.followupMode !== projectedConfig?.followupMode
      ) {
        const ack = await dispatchConfigCas(
          "setFollowupMode",
          { mode: desiredConfig.followupMode },
          { targetSessionId },
        );
        requireAcceptedConfigAck("setFollowupMode", ack);
      }
    },
    [appFollowupMode, dispatchConfigCas, draftConfigRef],
  );
  ensureDraftPrewarmConfigBeforeSendRef.current = ensureDraftPrewarmConfigBeforeSend;

  const followupModeSyncKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // Native busy delivery is session-owned; browser-wide ZCode preferences must not
    // silently turn the default follow-up queue into steer for every resident.
    if (nativeHostAvailable || modelSelectionDisplayView?.nativeSession !== undefined) return;
    const targetSessionId = sessionId ?? prewarmSessionId;
    if (!targetSessionId || !appFollowupMode || snapshotRevision === null) return;
    if (snapshotSessionId !== targetSessionId) return;
    if (snapshotFollowupMode === appFollowupMode) {
      followupModeSyncKeyRef.current = `${targetSessionId}:${appFollowupMode}:synced`;
      return;
    }
    const syncKey = `${targetSessionId}:${appFollowupMode}:${snapshotRevision}`;
    if (followupModeSyncKeyRef.current === syncKey) return;
    followupModeSyncKeyRef.current = syncKey;
    // 交互行为的用户事实源是 app 设置页；v4 投影 followupMode 只是
    // CLI/runtime 同步结果。这里把设置变更补发成既有 setFollowupMode 命令，
    // 避免 composer 再暴露一个同义“追加模式”入口造成上下游分叉。
    void configCommandBarrier.enqueue(() =>
      dispatchConfigCas("setFollowupMode", { mode: appFollowupMode }),
    );
  }, [
    appFollowupMode,
    modelSelectionDisplayView,
    nativeHostAvailable,
    configCommandBarrier,
    dispatchConfigCas,
    prewarmSessionId,
    sessionId,
    snapshotFollowupMode,
    snapshotRevision,
    snapshotSessionId,
  ]);

  // Composer 选择表达“下一次提交”。点击只更新 renderer intent；Session Selection
  // 在 Submission 真正开跑（Guide 为下一次 model-step）时由 CLI/Core 更新。
  const handleSelectModel = useCallback(
    (
      modelProvider: string,
      model: string,
      sourceModel: ModelSelectionSource | null,
      reasoningLevel?: string,
    ) => {
      const resolvedProvider =
        modelProvider || draftConfigRef.current.provider || sourceModel?.provider || "";
      logger.debug("[v4-pane] onSelectModel", {
        modelProvider: resolvedProvider,
        model,
        branch: "composer-submission-intent",
      });
      return handleDraftSelectModel(resolvedProvider, model, reasoningLevel);
    },
    [draftConfigRef, handleDraftSelectModel],
  );

  const handleSelectThought = useCallback(
    (thought: string, _modelContext: { provider: string; model: string }) => {
      handleDraftSelectThought(thought);
    },
    [handleDraftSelectThought],
  );

  const handleRecoverCustomModelSelection = useCallback(
    async (value: string, sourceModel: ModelSelectionSource | null) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.providerId) {
        return;
      }
      const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
      let modelValue = value;
      if (!decoded.modelName) {
        const fallbackModel =
          modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )?.models[0]?.modelId ?? (modelSelectionView ? null : undefined);
        if (!fallbackModel) {
          logger.warn("[v4-pane] custom provider 恢复跳过：provider 没有可用模型", {
            customProviderId: decoded.providerId,
            workspacePath,
          });
          return;
        }
        modelValue = encodeCustomModelValue(decoded.providerId, fallbackModel);
      }
      const modelSelection = parseModelPickerValue(modelValue);
      // Bug 原因：configOptions error 的 custom provider 选择绕过普通 onSelectModel；
      // 已绑定任务仍复用同一提示入口，草稿态由入口统一静默。
      showModelChangeNotice(sourceModel, {
        provider: modelSelection.providerId,
        model: modelSelection.modelId,
      });
      const store = useZCodeSessionStore.getState();
      store.setModelSelectionResolution(
        workspacePath,
        {
          selectedSupplierKey: buildCustomSupplierKey(decoded.providerId),
          isGhostSupplier: false,
          supplierMismatchReason: null,
        },
        workspaceIdentity,
      );
      store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
      logger.info("[v4-pane] configOptions error custom provider recovery start", {
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });

      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          bumpRuntimeEpoch: true,
        });

        const prepareResult = await prepareWorkspaceWithZCodeSessionService({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          zcodeSessionService,
        });
        await handleDraftSelectModel(modelSelection.providerId, modelSelection.modelId);
        store.setConfigOptions(workspacePath, prepareResult.configOptions ?? [], workspaceIdentity);
        store.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        store.setSlashCommands(workspacePath, prepareResult.slashCommands ?? [], workspaceIdentity);
        logger.info("[v4-pane] configOptions error custom provider recovery done", {
          configOptionsCount: prepareResult.configOptions?.length ?? 0,
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
      } catch (error) {
        store.setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn("[v4-pane] configOptions error custom provider recovery failed", {
          error: error instanceof Error ? error.message : String(error),
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
        throw error;
      }
    },
    [
      provider,
      handleDraftSelectModel,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspacePath,
      zcodeSessionService,
      zcodeTaskService,
    ],
  );

  // 模式与模型一样属于下一次 Submission；选择时只更新 Composer。
  const handleSwitchMode = useCallback(
    (mode: string) => {
      handleDraftSwitchMode(mode);
    },
    [handleDraftSwitchMode],
  );

  // 误停排障需要区分按钮与 Esc；普通 info 在生产禁用，必须走生命周期日志。
  const handleStop = useCallback(
    (source: "button" | "escape") => {
      const current = snapshotRef.current;
      const targetSessionId = sessionId ?? nativeDraftSessionId;
      if (!targetSessionId || current?.sessionId !== targetSessionId || !current.control.canStop) {
        logger.lifecycle.info("[v4-pane] stop 命令被跳过（无可停执行）", {
          source,
          sessionId: sessionId ?? "",
        });
        return;
      }
      const foregroundExecutionId = current.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      )?.foregroundExecutionId;
      logger.lifecycle.info("[v4-pane] stop 命令发出", {
        source,
        sessionId,
        foregroundExecutionId: foregroundExecutionId ?? "",
      });
      void dispatchCommand(
        "stop",
        foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {},
        targetSessionId,
      ).then((ack) => {
        if (!["accepted", "noop", "duplicate"].includes(ack.status))
          toast(ack.reasonCode ?? `stop ${ack.status}`);
      }).catch((error) => {
        logger.lifecycle.warn(`[v4-pane] stop 失败: ${String(error)}`);
      });
    },
    [dispatchCommand, sessionId, nativeDraftSessionId],
  );

  const handlePauseGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.pauseGoal.allowed) return;
    void dispatchCommand("pauseGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] pauseGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  const handleResumeGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.resumeGoal.allowed) return;
    void dispatchCommand("resumeGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] resumeGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  // 主、辅对话可同时 focused（各自布局的可见态），不能据此争抢窗口 Esc。
  // 面板打开时按 DOM 归属隔离；关闭时由 Shell 授权主区接收对话外 Esc，避免焦点离开输入框后无法停止。
  // 保留窗口冒泡阶段，让 mention/slash 的 preventDefault 和 dialog 优先处理。
  useEffect(() => {
    if (!focused || readOnly) return;
    if (!(sessionId ?? nativeDraftSessionId) || !snapshot?.control.canStop) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!paneRef.current) return;
      if (!allowEscapeStopOutsidePane && !event.composedPath().includes(paneRef.current)) return;
      if (shouldIgnoreEscapeForStopGeneration(event)) return;
      event.preventDefault();
      handleStop("escape");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    allowEscapeStopOutsidePane,
    focused,
    handleStop,
    readOnly,
    sessionId,
    nativeDraftSessionId,
    snapshot?.control.canStop,
  ]);

  // handleStop 带 source 参数（button / escape 两个调用点），但 ConversationComposer 是 memo：
  // 直接写 onStop={() => handleStop("button")} 每次 render 都换引用，memo 白做，而 composer
  // 恰好是每次输入都可能重渲染的组件。这里固定 button 版的引用，不动 handleStop 的双入口设计。
  const handleStopFromButton = useCallback(() => handleStop("button"), [handleStop]);

  const handleRetrySubscribe = useCallback(() => {
    if (state.lifecycle?.state !== "faulted") {
      void lease?.store.retry();
      return;
    }
    // faulted 不能通过重复单任务 close 恢复；扩大到工作区必须由用户明确选择。
    void (async () => {
      if (
        !(await confirmLifecycleRecovery({
          title: intl.formatMessage({ id: "taskList.recoverWorkspace" }),
          description: intl.formatMessage({ id: "taskList.recoverWorkspaceDescription" }),
          confirmLabel: intl.formatMessage({ id: "taskList.recoverWorkspace" }),
        }))
      )
        return;
      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: provider ?? ZCODE_AGENT_PROVIDER,
          bumpRuntimeEpoch: true,
        });
        await lease?.store.retry();
      } catch (error) {
        logger.warn("[session-lifecycle] 工作区恢复失败", { workspacePath, error });
        toast(intl.formatMessage({ id: "taskList.restartFailed" }));
      }
    })();
  }, [
    lease,
    state.lifecycle?.state,
    confirmLifecycleRecovery,
    intl,
    zcodeTaskService,
    workspacePath,
    workspaceIdentity,
    provider,
  ]);

  // loadOlder 触发（接近顶部自动预取）。store 内部单飞防重入。
  const handleLoadOlder = useCallback(() => {
    return lease?.store.loadOlder();
  }, [lease]);

  const handleLoadAllOlder = useCallback(() => {
    return lease
      ? lease.store.loadAllOlder()
      : Promise.resolve({
          status: "stale" as const,
          logEpoch: snapshot?.logEpoch ?? "unknown",
        });
  }, [lease, snapshot?.logEpoch]);

  useEffect(() => {
    if (
      !sessionId ||
      !lease?.store ||
      !shouldAutoLoadIncompleteLeadingTurn(snapshot, state.loadingOlder)
    ) {
      return;
    }
    const firstRowId = snapshot?.rows.window[0]?.rowId;
    if (firstRowId === undefined) return;
    const cursorKey = `${sessionId}:${state.subscriptionId ?? "connecting"}:${firstRowId}`;
    if (autoLoadIncompleteTurnCursorRef.current === cursorKey) return;
    autoLoadIncompleteTurnCursorRef.current = cursorKey;

    // snapshotTailWindowRows 按 row 截尾，可能把一个长 turn 的 header/user
    // 留在窗口外。旧 UI 只在 scroll 事件到达顶边时 loadOlder；内容不足一屏或 scrollTop
    // 已经为 0 时不会再产生事件，于是只渲染 assistant，必须先下滚再上滚。检测到首 turn
    // 缺 header 后立即逐窗补齐；cursor 去重避免空 range 或失败时 effect 自旋。
    logger.debug("[v4-pane] 冷快照首 turn 不完整，自动补拉更早行", {
      firstRowId,
      sessionId,
      turnId: snapshot?.rows.window[0]?.turnId,
    });
    void lease.store.loadOlder();
  }, [lease, sessionId, snapshot, state.loadingOlder, state.subscriptionId]);

  // subscribe ACK 会先把 store 置 live，initial snapshot 稍后才到；只看
  // status 会在无投影窗口提前启用编辑器。正式 session 必须等首个 snapshot 才可输入。
  const connecting =
    sessionId !== null &&
    (snapshot === null || (state.status === "connecting" && !snapshot.runtimeInitialization));
  const queueEditActiveForCurrentComposer =
    queueEditOperation?.sessionId === sessionId && queueEditOperation.workspaceKey === workspaceKey;
  const errored = sessionId !== null && state.status === "error";
  // retry 的产品裁决属于行级权威投影。这里仅提供命令能力，入口是否展示
  // 完全读取 row.actions.canRetry，禁止再用 pane phase 形成第二套 guard。
  const retryActionsEnabled =
    runtimeReady &&
    remoteAvailable &&
    !readOnly &&
    !selectionSideChat &&
    Boolean(sessionId) &&
    (!(nativeHostAvailable || modelSelectionDisplayView?.nativeSession !== undefined) ||
      nativeComposerBound);
  const handleRetry = useCallback(
    async (target: ConversationRowTarget): Promise<void> => {
      const current = snapshotRef.current;
      if (!retryActionsEnabled || !sessionId || current?.sessionId !== sessionId) return;
      const row = current.rows.window.find(
        (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
      );
      if (row?.actions?.canRetry !== true) return;
      // Keep the composer draft and attachments untouched; native retry owns the original query.
      const ack = await dispatchCommand(
        "retryTurn",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        logger.warn(`[v4-pane] retry 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        throw new Error(ack.message ?? ack.reasonCode ?? "retryTurn rejected");
      }
    },
    [dispatchCommand, retryActionsEnabled, sessionId],
  );
  // fork 可用性完全由 row.actions.canFork（CLI stable resolver 投影）裁决；pane 只提供命令回调。
  const forkActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  // editUserQuery 已由 command 层防御 latest real user query，并在 running
  // 提交时先 stop barrier 再 rewind/rerun；UI 不应再用 completed gate 把入口整轮隐藏。
  const editActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  const isDraft = sessionId === null;
  // 滚动恢复必须使用与 sessionId 匹配的 lease projection。切换 session 的 render 与
  // passive effect 不在同一时刻，旧 lease 的 rows 若提前交给 timeline，会让新记忆按旧
  // 内容高度 clamp，后续目标 rows 到达时也无法区分这次临时落点。
  const sessionLeaseReady = sessionId !== null && lease?.sessionId === sessionId;
  const timelineSnapshot =
    !isDraft && (lease === null || sessionLeaseReady) && snapshot?.sessionId === sessionId
      ? snapshot
      : null;
  const initialDraftConfigForDiagnostics = isDraft ? resolveInitialDraftConfig() : undefined;
  // CLI V4 projection 是 running/count/manifest 的唯一权威；renderer 不再在 spawn
  // 事件后另发查询拼接第二份状态，避免并发 child 的 in-flight refresh 丢更新。
  const subagents = snapshot?.subagents ?? EMPTY_SUBAGENT_PROJECTION;
  useEffect(() => {
    if (!sessionId || subagents.revision === 0 || !onSyncSubagentSessionTabs) return;
    onSyncSubagentSessionTabs({
      rootSessionId: rootSessionId ?? sessionId,
      parentSessionId: sessionId,
      validChildSessionIds: subagents.childSessionIds,
    });
  }, [
    onSyncSubagentSessionTabs,
    rootSessionId,
    sessionId,
    subagents.childSessionIds,
    subagents.revision,
  ]);
  useEffect(() => {
    if (!selectionSideChat || !sessionId) return;
    setSelectionSideChatBlocked(sessionId, Boolean(blockingInteractionId));
    return () => setSelectionSideChatBlocked(sessionId, false);
  }, [blockingInteractionId, selectionSideChat, sessionId]);
  const isOfficeMode = useIsOfficeMode();
  const statusPanelModel = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        workspacePath,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal: selectionSideChat ? null : (snapshot?.goal ?? null),
        sessionPlans: state.sessionPlans,
        plan: snapshot?.plan ?? null,
        backgroundWorks: snapshot?.backgroundWorks ?? [],
        runningSubagents: subagents.running,
        workflowRuns: snapshot?.workflowRuns?.runs ?? [],
      }),
    [
      isOfficeMode,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      snapshot?.backgroundWorks,
      snapshot?.goal,
      snapshot?.plan,
      snapshot?.workflowRuns,
      state.sessionPlans,
      selectionSideChat,
      subagents.running,
      workspacePath,
    ],
  );
  const runningBackgroundWorkCount =
    statusPanelModel.runningBashWorks.length +
    statusPanelModel.runningSubagentWorks.length +
    statusPanelModel.runningWorkflowRuns.length;
  const runningTerminalCount = statusPanelModel.runningBashWorks.length;
  const runningAgentCount = statusPanelModel.runningSubagentWorks.length;
  const runningWorkflowCount = statusPanelModel.runningWorkflowRuns.length;
  useEffect(() => {
    setTerminalSectionOpen(false);
    setAgentSectionOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (runningTerminalCount === 0) {
      setTerminalSectionOpen(false);
    }
  }, [runningTerminalCount]);
  // 「工作流」分区跟着「有没有活的 run」走（docs/dynamic-workflow/presentation.md「Other places a
  // run appears」）：在跑数从 0 变成 ≥1 时打开、归零时折起，进入会话时按该会话重新判定。只在这个
  // 布尔翻转（或换会话）时写入，所以读者手动折起后，run 还在跑就一直保持折起。
  // Bug 原因：过去它和终端 / 智能体一样默认折起；胶囊改为按名字显示工作流后，点开胶囊反而把刚才
  // 看到的那条 run 折进了分区里——展开后看到的比胶囊还少。
  const hasLiveWorkflowRun = runningWorkflowCount > 0;
  useEffect(() => {
    setWorkflowSectionOpen(hasLiveWorkflowRun);
  }, [hasLiveWorkflowRun, sessionId]);
  useEffect(() => {
    if (runningAgentCount === 0) {
      setAgentSectionOpen(false);
    }
  }, [runningAgentCount]);
  // composer 徽标直达：唯一在跑的是一条可开
  // 详情页的 workflow run 时，徽标点击直接开它的 side tab，胶囊不动。判定吃胶囊的同一份模型；
  // 宿主没给 onOpenWorkflowRun（面板行同样不可点）时不直达。
  const soleRunningWorkflowRunTarget = useMemo(
    () => (onOpenWorkflowRun ? resolveSoleRunningWorkflowRunTarget(statusPanelModel) : null),
    [onOpenWorkflowRun, statusPanelModel],
  );
  const handleOpenRunningBackgroundWorks = useCallback(() => {
    if (runningBackgroundWorkCount === 0) return;
    if (soleRunningWorkflowRunTarget) {
      // 与面板行同一个 handler：不存在第二条打开路径。
      handleOpenWorkflowRunFromPanel(soleRunningWorkflowRunTarget);
      return;
    }
    // 产品规则：Composer 是全部实时活动的入口；分区拆开后一次点击仍要展开所有非空类型，
    // 但三个区块后续保持独立折叠状态，不能再共享一个 open 布尔值。
    setTerminalSectionOpen(runningTerminalCount > 0);
    setAgentSectionOpen(runningAgentCount > 0);
    setWorkflowSectionOpen(runningWorkflowCount > 0);
    handleSummaryPanelVariantChange("panel");
  }, [
    handleOpenWorkflowRunFromPanel,
    handleSummaryPanelVariantChange,
    runningAgentCount,
    runningBackgroundWorkCount,
    runningTerminalCount,
    runningWorkflowCount,
    soleRunningWorkflowRunTarget,
  ]);
  const statusPanelVariant = resolveConversationStatusPanelVariant({
    variantOverride: effectiveSummaryPanelVariantOverride,
  });
  // 若只有 status panel 内部知道自动展开态，而 timeline/composer 未同步调整布局，
  // 宽屏下就会出现面板覆盖内容。因此外层布局也必须使用同一展开状态。
  const shouldUseStatusPanelInlineLayout =
    !isDraft &&
    shouldUseConversationStatusPanelInlineLayout({
      hasContent: statusPanelModel.hasContent,
      variant: statusPanelVariant,
    });
  const statusPanelLayout = aireq || !shouldUseStatusPanelInlineLayout
    ? "none"
    : statusPanelVariant === "auto"
      ? "auto"
      : "inline";
  const controlLastError = snapshot?.control.lastError ?? null;
  const controlLastErrorKey = controlLastError
    ? createSessionErrorKey(snapshot?.sessionId ?? sessionId, controlLastError)
    : null;
  const projectedComposerError =
    controlLastError && controlLastErrorKey && !dismissedErrorKeys.includes(controlLastErrorKey)
      ? toComposerUiError(snapshot?.sessionId ?? sessionId, controlLastError)
      : null;
  // 官方 Server MCP 不可用（额度耗尽 / 无 Coding Plan）：事实来自 tool row 上的结构化标识，
  // 与模型额度是两条独立信息通道，这里只做投影。
  const mcpUnavailableNotice = useMemo(
    () => resolveMcpUnavailableNoticeInPartition(rowsPartition),
    [rowsPartition],
  );
  const composerError =
    draftModelReadinessError ?? sendSubmissionError ?? projectedComposerError;
  const retryConfigReadRow = snapshot?.rows.window.findLast(
    (row) => row.kind === "userInput" && row.origin === "realUser",
  );
  const retryConfigReadEnabled =
    retryActionsEnabled &&
    !isRunning &&
    isRequestVerificationConfigNetworkError(composerError) &&
    retryConfigReadRow?.actions?.canEdit === true &&
    Boolean(retryConfigReadRow.entityId);
  const handleRetryConfigRead = useCallback(() => {
    const current = snapshotRef.current;
    if (
      !retryActionsEnabled ||
      !current ||
      current.control.canStop ||
      !isRequestVerificationConfigNetworkError(current.control.lastError)
    )
      return;
    const row = current.rows.window.findLast(
      (item) => item.kind === "userInput" && item.origin === "realUser",
    );
    if (!row || row.kind !== "userInput" || !row.actions?.canEdit || !row.entityId) return;
    // 配置失败时没有 assistant 行；复用权威 edit 命令重跑原输入，保留附件且不追加第二条消息。
    const text = row.epilogueStart === undefined ? row.text : row.text.slice(0, row.epilogueStart);
    void handleEdit(
      { rowId: row.rowId, entityId: row.entityId },
      text,
      row.attachments,
      "preserve",
      row.conversationQuotes,
    ).catch((error: unknown) => {
      logger.warn("[v4-pane] 配置读取失败后重试原消息失败", { error });
    });
  }, [handleEdit, retryActionsEnabled]);
  useEffect(() => {
    setSendSubmissionError(null);
  }, [sessionId]);
  const handleDismissComposerError = useCallback(() => {
    if (draftModelReadinessError) {
      dismissDraftModelReadinessError();
      return;
    }
    if (sendSubmissionError) {
      setSendSubmissionError(null);
      return;
    }
    if (!controlLastErrorKey) return;
    // v4 control.lastError 是投影事实，单纯关闭 banner 不会改投影。
    // 这里只记录当前错误指纹，避免下一次 render 把同一条错误立刻重新顶回来；新错误 at/message 变化仍会显示。
    setDismissedErrorKeys((keys) =>
      keys.includes(controlLastErrorKey) ? keys : [...keys.slice(-19), controlLastErrorKey],
    );
  }, [
    controlLastErrorKey,
    dismissDraftModelReadinessError,
    draftModelReadinessError,
    sendSubmissionError,
  ]);
  // 远端 workspace 的模型目录来自远端 Registry；本机配置保存后由 Provisioning 自动下发，
  // 因此缺模型横幅只切换措辞，配置动作仍统一指向本机。
  const modelConfigTarget: ChatErrorBannerModelConfigTarget = isRemoteWorkspaceIdentity(
    workspaceIdentity ?? "",
  )
    ? "remote"
    : "local";
  const handleOpenModelSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);

  const recoverableCommand = recoverableCommands[0] ?? null;
  const handleDismissPendingRecovery = useCallback(() => {
    if (!recoverableCommand) return;
    pendingCommandRegistry.dismissRecovery(
      recoverableCommand.sessionId,
      recoverableCommand.commandId,
    );
  }, [recoverableCommand]);
  const handleResendPendingCommand = useCallback(() => {
    if (!recoverableCommand) return;
    const replay = pendingCommandRegistry.consumeReplay({
      sessionId: recoverableCommand.sessionId,
      commandId: recoverableCommand.commandId,
    });
    if (!replay) return;
    void dispatchCommand(
      replay.type,
      replay.payload,
      replay.sessionId,
      replay.baseRevision,
      undefined,
      undefined,
      undefined,
      replay.clientContext?.projectId,
      replay.clientContext?.taskGroupId,
      replay.clientContext?.composer?.submittedText,
    )
      .then((ack) => {
        if (
          replay.type === "createSession" &&
          (ack.status === "accepted" || ack.status === "duplicate") &&
          ack.result?.type === "createSession"
        ) {
          const originWorkspace = replay.clientContext?.workspace;
          const originWorkspaceKey =
            originWorkspace?.workspaceIdentity?.trim() || originWorkspace?.workspacePath;
          if (originWorkspaceKey && originWorkspaceKey !== workspaceKey) {
            // 防御 stale UI/旧闭包直接触发跨 workspace replay；正常入口已在 hook 过滤。
            logger.error("[v4-pending-command] 拒绝跨 workspace 提交 createSession 恢复结果", {
              originWorkspaceKey,
              workspaceKey,
            });
            return;
          }
          return handleDraftSessionCreated(
            ack.result.sessionId,
            replay.payload.firstInput ? ack.commandId : undefined,
            replay.clientContext?.taskGroupId,
          );
        }
      })
      .catch((error) => {
        // 新 command 已先写入 registry；本次 transport 失败仍可在下次连接继续对账。
        logger.warn("[v4-pending-command] 用户确认重发失败", error);
      });
  }, [dispatchCommand, handleDraftSessionCreated, recoverableCommand, workspaceKey]);

  // subagent 右侧 child tab 是观察视图；复用普通 SessionPane 时
  // 若仍创建 composer，会让用户误以为可以直接向 child session 继续输入。
  const composerNode = readOnly ? null : (
    <ConversationComposer
      key="conversation-composer"
      // Snapshot 仍服务路由与运行态；工具栏的 mode/model 只读下方 Composer Draft。
      snapshot={snapshot}
      inputPending={state.optimisticCommands.some((command) =>
        requiresAcceptedInputProjection(command.type),
      )}
      lifecycle={state.lifecycle}
      sessionId={sessionId}
      // 草稿 taskId 仍为 null，但 prewarm 已经拥有独立 AgentRuntime。
      // 只给 Skill catalog 下发 effective id，避免 UI 扫到 prewarm runtime 尚未加载的新 Skill。
      skillCatalogSessionId={effectiveSessionId}
      draftMode={isDraft}
      draftConfig={draftConfig}
      composerDraft={composerDraft}
      composerDraftScopeToken={composerDraftScopeToken}
      rootDraftScopeKey={composerScopeKey(newTaskComposerScope)}
      replaceComposerDraft={replaceComposerDraft}
      submissionReady={
        aireq && sessionId === null ? aiReqProjectDraftReady :
          nativeHostAvailable && sessionId === null ? true :
          draftProjectReady && composerSubmissionReady && runtimeReady && !recoveringDraft &&
          (modelSelectionDisplayView?.nativeSession === undefined || nativeComposerBound)
      }
      stageComposerContent={stageComposerContent}
      captureComposerContentLifecycleCommit={captureComposerContentLifecycleCommit}
      captureComposerSubmissionDraftTransaction={captureComposerSubmissionDraftTransaction}
      updateComposerContent={updateComposerContent}
      persistComposerContent={persistComposerContent}
      createSubmissionFromComposer={createSubmissionFromComposer}
      // 完整视图浮窗默认是一条输入框：草稿项目栏不进入浮窗，切到对话 tab 再选择项目。
      contextHeader={isDraft && !isFloatingPresentation ? draftComposerHeader : undefined}
      placeholder={composerPlaceholder}
      inputAriaLabel={composerAriaLabel}
      inputPreview={composerInputPreview}
      centered={isDraft}
      layout={isFloatingPresentation ? "inline" : "stacked"}
      workingDurationMs={
        floatingTurnRunning ? floatingLatestTurnSummary?.workDurationMs : undefined
      }
      blockingRequestId={blockingInteractionId}
      listenAddToChatEvents={focused}
      externalTextInsertRequest={focused ? composerInsertRequest ?? (sessionId === null ? composerTextInsertRequest : null) : null}
      onExternalTextInsertApplied={composerInsertRequest ? onComposerInsertApplied : handleExternalTextInsertApplied}
      autoFocusEnabled={focused && aireq?.session?.role !== "reviewer"}
      disabled={
        (sessionId !== null && modelSelectionDisplayView?.nativeSession !== undefined &&
          !nativeComposerBound) ||
        connecting ||
        draftRuntimeRebuilding ||
        queueEditActiveForCurrentComposer
      }
      isWebRemoteControl={compactForRemoteControl}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId ?? undefined}
      modelSelectionView={modelSelectionDisplayView}
      modelSelectionState={modelSelectionRead.state}
      modelSelectionReload={modelSelectionRead.reload}
      attachmentSessionId={effectiveSessionId}
      ensureAttachmentSession={(!aireq || aireq.selection.freeDraftId) && nativeHostAvailable && sessionId === null ? ensureNativeDraftSession : undefined}
      modelSelectionSessionId={sessionId ?? nativeDraftSessionId}
      attachmentPut={attachmentPut}
      onRuntimeRestart={onRuntimeRestart}
      onRuntimeLifecycle={onRuntimeLifecycle}
      provider={provider}
      onSendText={handleSendText}
      onDraftStateChange={handleComposerDraftStateChange}
      composerRestoreRequest={composerRestoreRequest}
      onComposerRestoreApplied={handleComposerRestoreApplied}
      onStop={handleStopFromButton}
      onSelectModel={handleSelectModel}
      onSelectThought={handleSelectThought}
      onSwitchMode={handleSwitchMode}
      onOpenRunningBackgroundWorks={
        sessionId && runningBackgroundWorkCount > 0 ? handleOpenRunningBackgroundWorks : undefined
      }
      backgroundWorkOpenTarget={soleRunningWorkflowRunTarget ? "workflow-run" : "panel"}
      // 父轮结束后 subagents.running 的目录投影可能短暂落后于仍为 running 的
      // backgroundWorks；Composer 若直接读目录会提前隐藏 Agent 入口。这里复用状态面板按
      // childSessionId 精确回退后的计数，让两个入口共享同一份运行态真值。
      runningSubagentCount={runningAgentCount}
      onRecoverCustomModelSelection={handleRecoverCustomModelSelection}
      error={composerError}
      onDismissError={handleDismissComposerError}
      onRetryInitialization={handleRetrySubscribe}
      onRetryError={retryConfigReadEnabled ? handleRetryConfigRead : undefined}
      onOpenModelSettings={handleOpenModelSettings}
      modelConfigTarget={modelConfigTarget}
      onOpenCodeViewer={onOpenCodeViewer}
      suppressGoalCommands={selectionSideChat}
      appSlashCommands={appSlashCommands}
      onDropTargetControllerChange={handleDropTargetControllerChange}
      onNativeComposerTargetChange={handleNativeAttachmentTargetChange}
    />
  );
  const pendingGuideProjection = snapshot ? projectPendingGuideQueue(snapshot.queue) : null;
  // 目录失效仍禁止输入；将宿主已有原因放回原输入区，不在 pane 内探测或恢复目录。
  const conversationBottomDockContent = readOnly ? (
    readOnlyReason ? (
      <div
        role="status"
        data-testid="v4-workspace-readonly-notice"
        className="w-full min-w-0 break-words rounded-xl border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle"
      >
        {readOnlyReason}
      </div>
    ) : null
  ) : (
    <>
      {nativeHistoryNeedsResume || nativeHistoryRecoveryPending ? (
        <div
          role="status"
          data-testid="v4-native-history-resume"
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle"
        >
          <span>当前仅浏览历史；继续后才可发送消息或临时选模。</span>
          <Button
            type="button"
            size="sm"
            // 历史只有只读投影，恢复前不会 runtimeReady；不能用执行就绪阻断恢复本身。
            disabled={nativeHistoryRecoveryPending || connecting}
            onClick={() => void handleResumeNativeHistory()}
          >
            {nativeHistoryRecoveryPending ? "正在继续…" : "继续此会话"}
          </Button>
        </div>
      ) : null}
      {nativeHistoryRecoveryError ? (
        <p role="alert" className="px-4 py-2 text-ui-caption text-warning">
          {nativeHistoryRecoveryError}
        </p>
      ) : null}
      {mcpUnavailableNotice ? (
        <p role="alert" className="px-4 py-2 text-ui-caption text-warning">
          {mcpUnavailableNotice.serverName} / {mcpUnavailableNotice.toolName}: {mcpUnavailableNotice.code}
        </p>
      ) : null}
      {recoverableCommand ? (
        <PendingCommandRecoveryBanner
          entry={recoverableCommand}
          onResend={
            recoverableCommand.replay.kind === "input" ? handleResendPendingCommand : undefined
          }
          onDismiss={handleDismissPendingRecovery}
        />
      ) : null}
      {sessionId && snapshot ? (
        <ConversationQueuePanel
          key="conversation-queue"
          queue={pendingGuideProjection?.visibleQueue ?? snapshot.queue}
          onDeleteItem={handleDeleteQueueItem}
          onEditItem={handleEditQueueItem}
          pendingEditQueueItemId={
            queueEditActiveForCurrentComposer ? queueEditOperation.queueItemId : null
          }
          onSendNow={handleSendQueuedNow}
          onMoveItem={handleReorderQueueItem}
          onResume={handleResumeQueue}
        />
      ) : null}
      {nativePresentation?.todoExpanded && nativePresentation.todoMarkdown ? (
        <section data-testid="v4-native-todo" data-session-id={nativePresentationSessionId}
          className="rounded-lg border border-card-border bg-card p-3">
          <pre className="whitespace-pre-wrap break-words text-ui-base">{nativePresentation.todoMarkdown}</pre>
        </section>
      ) : null}
      {/* Bugfix: v4 权限/问答等待态只是 runtime 的阻塞交互，必须和 composer
          共享 timeline bottom dock；渲染在 SessionPane 外层会脱离主列宽度并挤占下半屏。 */}
      {effectiveSessionId && snapshot?.sessionId === effectiveSessionId ? (
        <V4InteractionDialogs
          key="conversation-interactions"
          sessionId={effectiveSessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          provider={provider}
          snapshot={snapshot}
          onBrowserAction={handleNativeBrowserAction}
          onPlanInteractionAccepted={
            compactForRemoteControl ? handleMobilePlanInteractionAccepted : undefined
          }
        />
      ) : null}
      {composerNode}
      {/* 完整视图浮窗只露出输入框，草稿推荐提示不进入浮窗。 */}
      {isDraft && !isFloatingPresentation ? (
        <ConversationDraftSuggestedPromptsContainer
          className={isOfficeMode ? "mt-4" : "mt-6"}
          onOpenAutomations={
            onOpenAutomationsMain && !compactForRemoteControl
              ? () => onOpenAutomationsMain(undefined, "scheduled")
              : undefined
          }
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
        />
      ) : null}
    </>
  );
  const conversationBottomDock = conversationBottomDockContent ? (
    <ConversationBottomDockTransition mode="chat">
      {conversationBottomDockContent}
    </ConversationBottomDockTransition>
  ) : null;

  return (
    <SandboxSessionActionsProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      sessionId={sessionRuntimeReady ? effectiveSessionId : null}
      readOnly={readOnly || !sessionRuntimeReady || (sessionId === null && !focused)}
      sendText={dispatchSendText}
    >
      <div
        ref={paneRef}
        data-testid={testId(TID_V4_SESSION_PANE, paneId)}
        data-session-id={sessionId ?? "draft"}
        data-session-lifecycle={state.lifecycle?.state}
        data-session-generation={state.lifecycle?.generation}
        data-initial-draft-provider={initialDraftConfigForDiagnostics?.provider ?? ""}
        data-initial-draft-model={initialDraftConfigForDiagnostics?.model ?? ""}
        data-projection-seq={snapshot?.seq ?? ""}
        data-running-subagent-ids={subagents.running.map((item) => item.childSessionId).join(",")}
        data-running-subagent-work-ids={(snapshot?.backgroundWorks ?? [])
          .filter((work) => work.kind === "subagent" && work.status === "running")
          .map((work) => work.childSessionId ?? work.workId)
          .join(",")}
        data-v4-conversation-drop-target="true"
        onDragOver={effectiveDropTargetController?.onDragOver}
        onDragLeave={effectiveDropTargetController?.onDragLeave}
        onDrop={effectiveDropTargetController?.onDrop}
        className={cn("relative flex h-full min-h-0 flex-col", compactForRemoteControl && "min-w-0")}
      >
        {effectiveDropTargetController?.active ? (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>
                {intl.formatMessage({
                  id:
                    effectiveDropTargetController.kind === "workspace"
                      ? "chat.composer.workspaceFileDragHint"
                      : "chat.attachments.dragHint",
                })}
              </span>
            </div>
          </div>
        ) : null}
        {!embedded && (
          <ConversationHeader
            title={snapshot?.meta.title ?? ""}
            onClosePane={onClosePane}
            workspaceBadge={workspaceBadge}
          />
        )}

        <div
          className={cn(
            "@container/conversation relative flex min-h-0 flex-1 flex-col",
            compactForRemoteControl && "min-w-0",
          )}
        >
          {!isDraft ? (
            <ConversationStatusPanel
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              gitSummary={gitSummary}
              gitDirtyFileCount={gitDirtyFileCount}
              gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
              gitWorktreeChangeSummary={gitWorktreeChangeSummary}
              activeTaskChangeSummary={activeTaskChangeSummary}
              goal={selectionSideChat ? null : (snapshot?.goal ?? null)}
              sessionPlans={state.sessionPlans}
              plan={snapshot?.plan ?? null}
              backgroundWorks={snapshot?.backgroundWorks ?? []}
              runningSubagents={subagents.running}
              workflowRuns={snapshot?.workflowRuns?.runs ?? []}
              endedSubagentCount={subagents.endedTotal}
              rootSessionId={rootSessionId ?? sessionId ?? undefined}
              parentSessionId={sessionId ?? undefined}
              isWebRemoteControl={compactForRemoteControl}
              isMobileViewport={isMobileTextInputViewport}
              layoutMode={statusPanelLayout}
              inFlow={Boolean(aireq)}
              summaryPanelVariantOverride={effectiveSummaryPanelVariantOverride}
              onVariantChange={handleSummaryPanelVariantChange}
              terminalSectionOpen={terminalSectionOpen}
              onTerminalSectionOpenChange={setTerminalSectionOpen}
              agentSectionOpen={agentSectionOpen}
              onAgentSectionOpenChange={setAgentSectionOpen}
              workflowSectionOpen={workflowSectionOpen}
              onWorkflowSectionOpenChange={setWorkflowSectionOpen}
              onRefreshGit={onRefreshGit}
              onOpenGitReview={onOpenGitReview}
              onPauseGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.pauseGoal.allowed
                  ? handlePauseGoal
                  : undefined
              }
              onResumeGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.resumeGoal.allowed
                  ? handleResumeGoal
                  : undefined
              }
              onOpenPlanDetail={onOpenPlanDetail ? handleOpenPlanDetail : undefined}
              onOpenBackgroundBash={
                onOpenBackgroundBash && sessionId
                  ? (work) =>
                      onOpenBackgroundBash({
                        workspacePath,
                        workspaceIdentity: workspaceIdentity ?? undefined,
                        remoteSessionId: remoteSessionId ?? undefined,
                        rootSessionId: rootSessionId ?? sessionId,
                        sessionId,
                        workId: work.workId,
                        title: work.title,
                      })
                  : undefined
              }
              onCancelBackgroundWork={readOnly ? undefined : handleCancelBackgroundWork}
              onOpenSubagentSession={onOpenSubagentSession ? handleOpenSubagentSession : undefined}
              onOpenSubagentDirectory={
                onOpenSubagentDirectory && !compactForRemoteControl ? handleOpenSubagentDirectory : undefined
              }
              onOpenWorkflowRun={onOpenWorkflowRun && sessionId ? handleOpenWorkflowRunFromPanel : undefined}
              endedWorkflowRunCount={endedWorkflowRunCount}
              onOpenWorkflowRunDirectory={
                onOpenWorkflowRunDirectory && !compactForRemoteControl
                  ? handleOpenWorkflowRunDirectoryFromPanel
                  : undefined
              }
            />
          ) : null}

          {readOnly && controlLastError ? (
            <div
              role="alert"
              data-testid="v4-subagent-readonly-error"
              className="mx-4 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-ui-base text-[var(--color-danger)]"
            >
              {controlLastError.message}
            </div>
          ) : null}

          {errored && remoteAvailable ? (
            <SessionSubscriptionErrorPanel
              error={state.lastError ?? intl.formatMessage({ id: "chat.error.connectionLost" })}
              onReconnect={handleRetrySubscribe}
              reconnectLabel={
                state.lifecycle?.state === "faulted"
                  ? intl.formatMessage({ id: "taskList.recoverWorkspace" })
                  : undefined
              }
            />
          ) : (
            <BotGroupDeliveryProvider
              taskId={extendedConversationAvailable ? sessionId : null}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
            >
              <ConversationTimeline
                compactForRemoteControl={compactForRemoteControl}
                scrollToBottomActionRef={timelineScrollToBottomRef}
                scrollToQueryActionRef={timelineScrollToQueryRef}
                rows={timelineSnapshot?.rows.window ?? []}
                pendingGuides={timelineSnapshot ? pendingGuideProjection?.pendingGuides : []}
                apiRetry={timelineSnapshot?.control.apiRetry ?? null}
                totalCount={timelineSnapshot?.rows.totalCount ?? 0}
                sessionKey={sessionId ?? "draft"}
                scrollMemoryKey={timelineScrollMemoryKey}
                rowContext={rowContext}
                onFork={forkActionsEnabled ? handleFork : undefined}
                onRetry={retryActionsEnabled ? handleRetry : undefined}
                onFeedbackChange={!readOnly && !selectionSideChat && sessionId ? handleAssistantFeedback : undefined}
                onEdit={editActionsEnabled ? handleEdit : undefined}
                canLoadOlder={timelineSnapshot ? hasOlderRows(timelineSnapshot) : false}
                loadingOlder={timelineSnapshot ? state.loadingOlder : false}
                onLoadOlder={handleLoadOlder}
                onLoadAllOlder={handleLoadAllOlder}
                turnNavigatorDirectoryRevision={state.turnNavigatorDirectoryRevision}
                bottomDock={conversationBottomDock}
                emptyState={
                  !remoteAvailable ? (
                    <div className="p-6 text-center text-ui-base text-foreground-subtle">
                      {intl.formatMessage({ id: "remote.conversation.placeholder" })}
                    </div>
                  ) : conversationEmptyState ?? (isDraft ? (
                    <div data-testid={TID_CHAT_EMPTY} className="w-full">
                      <ConversationDraftEmptyState compactForRemoteControl={compactForRemoteControl} />
                    </div>
                  ) : null)
                }
                // 浮窗形态只露出底部输入区，空会话也必须贴底，不能居中。
                centerEmptyStateWithDock={isDraft && !isFloatingPresentation}
                floatingComposerDock={isFloatingPresentation}
                onComposerDockHeightChange={
                  isFloatingPresentation && focused ? panePresentation.reportComposerDockHeight : undefined
                }
                onLatestTurnSummaryChange={
                  isFloatingPresentation && focused ? handleFloatingLatestTurnSummaryChange : undefined
                }
                compactEmptyStateWithDock={compactForRemoteControl}
                summaryPanelLayout={statusPanelLayout}
                conversationFindQuery={!isDraft && focused ? conversationFindQuery : ""}
                conversationFindActiveIndex={!isDraft && focused ? conversationFindActiveIndex : -1}
                conversationFindNavigationRequestId={!isDraft && focused ? conversationFindNavigationRequestId : 0}
                onConversationFindMatchStateChange={
                  !isDraft && focused ? onConversationFindMatchStateChange : undefined
                }
                searchResultHighlightRequest={isDraft ? null : searchResultHighlightRequest}
                onSearchResultHighlightDone={onSearchResultHighlightDone}
                sessionPhase={isDraft ? undefined : snapshot?.control.phase}
                selectionActions={
                  !isDraft && sessionId && !readOnly && !selectionSideChat && !isMobileTextInputViewport
                    ? {
                        enabled: focused && !blockingInteractionId,
                        sideActionDisabled: selectionSideActionBlocked,
                        onAddToCurrentTask: handleAddSelectionToCurrentTask,
                        onAskInSideChat: handleOpenSelectionSideConversation,
                      }
                    : undefined
                }
              />
            </BotGroupDeliveryProvider>
          )}
        </div>
      </div>
    </SandboxSessionActionsProvider>
  );
}
