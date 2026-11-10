import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeElicitationRequest, ZCodePermissionOption, ZCodeProvider } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { workflowSessionModelOf } from "@/components/workflow-timeline/workflowRunSettings.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePendingInteractionTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { logger } from "@/logger.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  getTaskUiState,
  getWorkspaceState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";
import {
  pendingPermissionToLegacyRequest,
  pendingUserInputToElicitationRequest,
  pendingUserInputToViewModel,
} from "@/v4/pendingInteractionAdapter.js";
import { V4UserInputDialog } from "@/v4/V4UserInputDialog.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { V4NativeBrowserAction } from "@/v4/V4NativeBrowserAction.js";
import { nativeBrowserActionInput, type NativeBrowserActionInput } from "@/v4/nativeBrowserActions.js";
import { readComposerFileBase64 } from "@/v4/composer/attachmentUpload.js";

interface NativeQuestionImage {
  type: "image";
  data: string;
  mimeType: string;
}
interface NativeQuestion {
  id: string;
  question: string;
  multi?: boolean;
  options: Array<{ label: string }>;
}
interface NativeQuestionExtra {
  customInputImages?: NativeQuestionImage[];
  noteImages?: NativeQuestionImage[];
  note?: string;
}

export function nativeQuestionResponseContent(
  questions: NativeQuestion[],
  content: Record<string, unknown> | undefined,
  extras: Record<string, NativeQuestionExtra>,
): Record<string, unknown> {
  return {
    ...content,
    result: {
      kind: "submit",
      results: questions.map((question, index) => {
        const raw = content?.[`answer_${index}`] ?? (questions.length === 1 ? content?.answer : undefined);
        const values = typeof raw === "string" ? [raw] : Array.isArray(raw)
          ? raw.filter((value): value is string => typeof value === "string") : [];
        const labels = question.options.map(option => option.label);
        return {
          id: question.id, question: question.question, options: labels, multi: question.multi ?? false,
          selectedOptions: values.filter(value => labels.includes(value)),
          customInput: values.filter(value => !labels.includes(value)).join("\n") || undefined,
          ...extras[question.id],
        };
      }),
    },
  };
}

function NativeQuestionImages({ questions, extras, onChange, onReading, onInteract }: {
  questions: NativeQuestion[];
  extras: Record<string, NativeQuestionExtra>;
  onChange(id: string, value: NativeQuestionExtra): void;
  onReading(reading: boolean): void;
  onInteract(): void;
}) {
  const abort = useRef(new AbortController());
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, []);
  const add = async (question: NativeQuestion, field: "customInputImages" | "noteImages", files: File[]) => {
    if (reading) return;
    onInteract();
    setReading(true); onReading(true); setError(undefined);
    try {
      const images = await Promise.all(files.map(async (file): Promise<NativeQuestionImage> => {
        if (!file.type.startsWith("image/")) throw new Error(`Not an image: ${file.name}`);
        return { type: "image", data: await readComposerFileBase64(file, abort.current.signal), mimeType: file.type };
      }));
      if (!abort.current.signal.aborted) onChange(question.id, {
        ...extras[question.id], [field]: [...(extras[question.id]?.[field] ?? []), ...images],
      });
    } catch (cause) {
      if (!abort.current.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!abort.current.signal.aborted) { setReading(false); onReading(false); }
    }
  };
  return (
    <div className="max-h-[24dvh] space-y-2 overflow-y-auto rounded-xl border border-card-border bg-card p-3" data-testid="v4-native-question-images">
      {questions.map(question => (
        <div key={question.id} data-question-id={question.id} className="space-y-2">
          <p className="text-ui-sm font-medium">{question.question}</p>
          <label className="block text-ui-sm">
            备注
            <textarea className="mt-1 w-full rounded-md border border-card-border bg-transparent p-2"
              data-testid="v4-native-question-note" value={extras[question.id]?.note ?? ""}
              onChange={event => { onInteract(); onChange(question.id, { ...extras[question.id], note: event.target.value }); }} />
          </label>
          {(["customInputImages", "noteImages"] as const).map(field => (
            <div key={field} className="space-y-1">
              <label className="block text-ui-sm">
                {field === "customInputImages" ? "图片回答" : "备注图片"}
                <input type="file" accept="image/*" multiple disabled={reading}
                  data-testid={field === "customInputImages" ? "v4-native-question-upload" : "v4-native-question-note-upload"}
                  onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void add(question, field, files); }} />
              </label>
              <div className="flex flex-wrap gap-2">
                {(extras[question.id]?.[field] ?? []).map((image, index) => (
                  <button key={index} type="button" disabled={reading} aria-label="移除图片"
                    onClick={() => onChange(question.id, { ...extras[question.id], [field]: extras[question.id]?.[field]?.filter((_, i) => i !== index) })}>
                    <img className="size-16 rounded-md object-contain" alt="图片回答" src={`data:${image.mimeType};base64,${image.data}`} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
      {error ? <p role="alert" className="text-ui-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export interface V4InteractionDialogsProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  isWebRemoteControl?: boolean;
  provider?: ZCodeProvider;
  snapshot: ConversationSnapshot | null;
  onCommandSettled?: (commandId: string) => void;
  onPlanInteractionAccepted?: (interactionId: string) => void;
  onBrowserAction?: (input: NativeBrowserActionInput, interactionId: string) => Promise<Record<string, unknown>>;
}

export function getCurrentSessionInteractionSnapshot(
  sessionId: string,
  snapshot: ConversationSnapshot | null,
): ConversationSnapshot | null {
  return snapshot?.sessionId === sessionId ? snapshot : null;
}

export function resolveV4ElicitationRequest(
  projected: ZCodeElicitationRequest | null,
  botProgress: ZCodeElicitationRequest | null,
): ZCodeElicitationRequest | null {
  // Bugfix：V4 snapshot 只保留原始阻塞请求，Bot 代答后的逐题进度必须覆盖同一 request 的投影。
  if (projected && botProgress?.requestId === projected.requestId) {
    return botProgress;
  }
  return projected;
}

export function buildV4ElicitationProgressKey(request: ZCodeElicitationRequest): string {
  return `${request.requestId}:${request.currentQuestionIndex ?? 0}:${JSON.stringify(request.answerDrafts ?? {})}`;
}

export interface InteractionAutoResolutionIntentTracker {
  markInteracted(interactionId: string): void;
  consumeSnooze(interactionId: string, autoResolutionReady: boolean): boolean;
  releaseSnooze(interactionId: string): void;
}

export function createInteractionAutoResolutionIntentTracker(): InteractionAutoResolutionIntentTracker {
  const interactedIds = new Set<string>();
  const sentIds = new Set<string>();
  return {
    markInteracted(interactionId) {
      interactedIds.add(interactionId);
    },
    consumeSnooze(interactionId, autoResolutionReady) {
      if (!autoResolutionReady || !interactedIds.has(interactionId) || sentIds.has(interactionId)) {
        return false;
      }
      sentIds.add(interactionId);
      return true;
    },
    releaseSnooze(interactionId) {
      sentIds.delete(interactionId);
    },
  };
}

/**
 * 竖切：把 projection.pendingInteractions 接到 PermissionDialog / userInput 弹窗。
 * ChatView 删除后若无此组件，带 tool 权限的会话会永久阻塞。
 */
export function V4InteractionDialogs({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isWebRemoteControl = false,
  provider,
  snapshot,
  onCommandSettled,
  onPlanInteractionAccepted,
  onBrowserAction,
}: V4InteractionDialogsProps) {
  const { sendCommand } = useV4Conversation();
  const connectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.connect);
  const disconnectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.disconnect);
  const upsertWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.upsert);
  const clearWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.clear);
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  // task 切换时 sessionId 会先更新，旧 task snapshot 可能再保留一帧。
  // 若直接使用旧 snapshot，会把当前 task 的 renderer-local 问答草稿误判为过期并清理。
  const currentSnapshot = getCurrentSessionInteractionSnapshot(sessionId, snapshot);
  // 工作流确认窗里「会话模型」那一项的名字（与 run 卡「配置」弹层同一个来源）。
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(currentSnapshot?.config),
    [currentSnapshot?.config],
  );
  // Bug 根因：workspaceHookReview 是 Settings/Hooks 处理的特殊交互，不能由通用 Dialog 渲染；
  // 但它可以和 permission/userInput 共存，固定读取 [0] 会遮挡后续真正需要弹窗的交互。
  // 这里只选择本组件可渲染的首个交互，同时保留 permission/userInput 的队列顺序。
  const pending =
    currentSnapshot?.pendingInteractions.find(
      (interaction) =>
        interaction.payload.kind === "permission" || interaction.payload.kind === "userInput",
    ) ?? null;
  const workspaceHookReview = currentSnapshot?.pendingInteractions.find(
    (interaction) => interaction.payload.kind === "workspaceHookReview",
  );
  const notificationEnabled = useZCodeStoreWithDefault((state) => state.notificationEnabled, true);
  const botElicitationProgress = useZCodeSessionStore(
    (state) =>
      getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
        .elicitationRequest,
  );
  const localElicitationDraft = useZCodeSessionStore((state) => {
    if (!pending || pending.payload.kind !== "userInput") return undefined;
    return getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
      .elicitationFormDraftsByRequestId[pending.interactionId];
  });
  usePendingInteractionTaskNotifications({
    snapshot: currentSnapshot,
    enabled: notificationEnabled,
    platform,
    formatMessage: intl.formatMessage,
  });
  useEffect(() => {
    connectWorkspaceHookCommands(sessionId, {
      sessionId,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      sendCommand,
      onCommandSettled,
    });
    return () => disconnectWorkspaceHookCommands(sessionId, sendCommand);
  }, [
    connectWorkspaceHookCommands,
    disconnectWorkspaceHookCommands,
    onCommandSettled,
    sendCommand,
    sessionId,
    workspaceIdentity,
    remoteSessionId,
    workspacePath,
  ]);
  useEffect(() => {
    if (!workspaceHookReview || workspaceHookReview.payload.kind !== "workspaceHookReview") {
      clearWorkspaceHookReview(sessionId);
      return;
    }
    upsertWorkspaceHookReview(sessionId, {
      request: workspaceHookReview.payload,
      workspacePath,
      sendCommand,
      onCommandSettled,
    });
    // 软门禁：不再强制跳转 Settings/Hooks。
    // 用户通过 WorkspaceHookPendingIndicator 的 [去审核] 按钮主动打开 Hooks 设置。
  }, [
    clearWorkspaceHookReview,
    onCommandSettled,
    sendCommand,
    sessionId,
    upsertWorkspaceHookReview,
    workspaceHookReview,
    workspacePath,
  ]);
  const autoResolutionIntentRef = useRef(createInteractionAutoResolutionIntentTracker());
  const loggedSnoozeSourceIdsRef = useRef(new Set<string>());
  const [permissionResponse, setPermissionResponse] = useState<{
    interactionId: string;
    pending: boolean;
    failed: boolean;
  } | null>(null);
  const permissionResponseFlight = useRef<string | null>(null);
  const [interactionFailure, setInteractionFailure] = useState<{ interactionId: string; message: string } | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState<string | null>(null);
  const questionFlight = useRef<string | null>(null);
  const questionOwner = `${sessionId}:${pending?.interactionId ?? ""}`;
  const questionOwnerRef = useRef(questionOwner); questionOwnerRef.current = questionOwner;
  const [imageDraft, setImageDraft] = useState<{ owner: string; extras: Record<string, NativeQuestionExtra> }>({ owner: "", extras: {} });
  const [imagesReading, setImagesReading] = useState(false);
  const imageExtras = imageDraft.owner === questionOwner ? imageDraft.extras : {};
  useEffect(() => { setImagesReading(false); }, [questionOwner]);

  const resolveInteraction = useCallback(
    async (
      interactionId: string,
      answer: {
        optionId?: string;
        freeText?: string;
        action?: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      },
    ) => {
      setInteractionFailure(null);
      const envelope = createCommandEnvelope({
        type: "resolveInteraction",
        sessionId,
        payload: { interactionId, answer },
      });
      // 权限/freeText/content 不落盘；registry 只持摘要，用于 ACK 丢失后的 query 对账。
      pendingCommandRegistry.record(envelope);
      try {
        const ack = await sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        const accepted =
          ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
        if (!accepted) {
          setInteractionFailure({ interactionId, message: ack.reasonCode ?? ack.status });
          logger.warn("[v4-interaction] resolveInteraction 被拒绝", {
            interactionId,
            status: ack.status,
            reasonCode: ack.reasonCode,
          });
        }
        return accepted;
      } catch (error) {
        logger.error("[v4-interaction] resolveInteraction 失败", { interactionId, error });
        setInteractionFailure({ interactionId, message: error instanceof Error ? error.message : String(error) });
        return false;
      } finally {
        onCommandSettled?.(envelope.commandId);
      }
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  const snoozeAutoResolution = useCallback(
    async (interactionId: string) => {
      return sendInteractionAutoResolutionSnooze({
        sessionId,
        interactionId,
        sendCommand,
        source: "dialog",
        onCommandSettled,
      });
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  const persistElicitationDraft = useCallback(
    (requestId: string, draft: ElicitationFormDraft) => {
      useZCodeSessionStore
        .getState()
        .setTaskElicitationFormDraft(workspacePath, sessionId, requestId, draft, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  const removeElicitationDraft = useCallback(
    (requestId: string) => {
      useZCodeSessionStore
        .getState()
        .removeTaskElicitationFormDraft(workspacePath, sessionId, requestId, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  useEffect(() => {
    if (!currentSnapshot) return;
    const activeRequestIds = new Set(
      currentSnapshot.pendingInteractions
        .filter((interaction) => interaction.payload.kind === "userInput")
        .map((interaction) => interaction.interactionId),
    );
    const taskUiState = getTaskUiState(
      getWorkspaceState(useZCodeSessionStore.getState(), workspacePath, workspaceIdentity),
      sessionId,
    );
    for (const requestId of Object.keys(taskUiState.elicitationFormDraftsByRequestId)) {
      if (!activeRequestIds.has(requestId)) {
        // 请求可能在 task 不可见期间被另一端回答或自动结束；回到该 task 后以
        // snapshot 的 pendingInteractions 为权威清理过期 renderer 草稿。
        removeElicitationDraft(requestId);
      }
    }
  }, [currentSnapshot, removeElicitationDraft, sessionId, workspaceIdentity, workspacePath]);

  const sendSnoozeOnce = useCallback(
    async (interactionId: string, autoResolutionReady: boolean) => {
      // 首个 userInput 与 autoResolution durable event 可能相邻两帧到达。未就绪时保留
      // tracker 意图，但向弹窗返回 false，让后续真实操作仍可重试；就绪后的 effect 会补发。
      if (!autoResolutionReady) return false;
      if (!autoResolutionIntentRef.current.consumeSnooze(interactionId, autoResolutionReady)) {
        return true;
      }
      try {
        const accepted = await snoozeAutoResolution(interactionId);
        if (!accepted) autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return accepted;
      } catch {
        autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return false;
      }
    },
    [snoozeAutoResolution],
  );

  useEffect(() => {
    // PermissionRequested 可能先投出 userInput，紧接着 autoResolution durable event 才到。
    // 用户若在这两帧之间完成首个分题操作，先记本地意图，registry 就绪后立即补发一次。
    if (pending) {
      void sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
    }
  }, [pending?.autoResolution, pending?.interactionId, sendSnoozeOnce]);

  if (!pending) {
    return null;
  }

  // workspaceHookReview 只能由 Settings/Hooks 行内 Trust 处理；绝不降级成通用 Dialog。
  if (pending.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (pending.payload.kind === "permission") {
    const request = pendingPermissionToLegacyRequest(sessionId, {
      ...pending,
      payload: pending.payload,
    });
    return (
      // 连续 permission 会复用输入框焦点状态，按 interaction 重建。
      <PermissionDialog
        key={pending.interactionId}
        request={request}
        permissionMode={currentSnapshot?.config?.mode}
        workspacePath={workspacePath}
        {...(workspaceIdentity === undefined ? {} : { workspaceIdentity })}
        {...(remoteSessionId === undefined ? {} : { remoteSessionId })}
        {...(workflowSessionModel === undefined ? {} : { workflowSessionModel })}
        isWebRemoteControl={isWebRemoteControl}
        provider={provider}
        responding={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.pending
        }
        responseError={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.failed
            ? intl.formatMessage({ id: "chat.permission.responseFailed" })
            : undefined
        }
        onRespond={(_requestId, option: ZCodePermissionOption, feedback, content) => {
          if (permissionResponseFlight.current === pending.interactionId) return;
          const interactionId = pending.interactionId;
          permissionResponseFlight.current = interactionId;
          setPermissionResponse({ interactionId, pending: true, failed: false });
          // content：工作流确认窗里改过的设置，只在放行应答上（docs/dynamic-workflow/launch.md
          // 「Adjusting the settings in the window」）。
          void resolveInteraction(interactionId, {
            optionId: option.optionId,
            ...(feedback ? { freeText: feedback } : {}),
            ...(content === undefined ? {} : { content }),
          }).then((accepted) => {
            if (permissionResponseFlight.current !== interactionId) return;
            permissionResponseFlight.current = null;
            setPermissionResponse({ interactionId, pending: false, failed: !accepted });
          });
        }}
      />
    );
  }
  const browserAction = pending.payload.toolName === "webgui-command" &&
    pending.interactionId.startsWith("webgui-question:")
    ? nativeBrowserActionInput(pending.payload.input) : null;
  if (browserAction) {
    return (
      <V4NativeBrowserAction
        key={`${sessionId}:${pending.interactionId}`}
        prompt={typeof browserAction.instructions === "string"
          ? `${pending.payload.prompt}\n${browserAction.instructions}` : pending.payload.prompt}
        action={browserAction.action}
        interactionId={pending.interactionId}
        execute={() => {
          if (!onBrowserAction || browserAction.originSessionId !== sessionId)
            return Promise.reject(new Error("The originating browser session is unavailable"));
          return onBrowserAction(browserAction, pending.interactionId);
        }}
        resolve={(answer) => resolveInteraction(pending.interactionId, answer)}
        cancel={["liveOffer", "liveAnswer", "recordStart"].includes(browserAction.action) && onBrowserAction
          ? async (result) => {
              await onBrowserAction({
                ...browserAction,
                action: browserAction.action === "recordStart" ? "recordStop" : "liveStop",
                ...(typeof result?.voiceSessionId === "string" ? { voiceSessionId: result.voiceSessionId } : {}),
                ...(typeof result?.recordingId === "string" ? { recordingId: result.recordingId } : {}),
              }, `${pending.interactionId}:cancel`);
            }
          : undefined}
      />
    );
  }

  const projectedElicitationRequest = pendingUserInputToElicitationRequest(sessionId, {
    ...pending,
    payload: pending.payload,
  });
  const elicitationRequest = resolveV4ElicitationRequest(
    projectedElicitationRequest,
    botElicitationProgress,
  );
  if (elicitationRequest) {
    const isExitPlanMode = pending.payload.toolName?.trim().toLowerCase() === "exitplanmode";
    const isAskUserQuestion =
      pending.payload.toolName?.trim().toLowerCase() === "askuserquestion" ||
      pending.autoResolution !== undefined;
    const nativeInput = pending.payload.input as { nativeQuestions?: NativeQuestion[]; acceptImages?: boolean } | undefined;
    const nativeQuestions = nativeInput?.nativeQuestions;
    return (
      <fieldset disabled={questionSubmitting === pending.interactionId || imagesReading}
        className="max-h-[80dvh] min-w-0 overflow-y-auto"
        data-testid="v4-native-question" data-interaction-id={pending.interactionId} data-session-id={sessionId}
        aria-busy={questionSubmitting === pending.interactionId}>
      {nativeInput?.acceptImages && nativeQuestions ? (
        <NativeQuestionImages key={questionOwner} questions={nativeQuestions} extras={imageExtras}
          onReading={setImagesReading}
          onInteract={() => { autoResolutionIntentRef.current.markInteracted(pending.interactionId); void sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution)); }}
          onChange={(id, value) => setImageDraft(current => ({ owner: questionOwner, extras: { ...(current.owner === questionOwner ? current.extras : {}), [id]: value } }))} />
      ) : null}
      <ElicitationDialog
        key={buildV4ElicitationProgressKey(elicitationRequest)}
        request={elicitationRequest}
        initialFormDraft={
          botElicitationProgress?.requestId === elicitationRequest.requestId
            ? undefined
            : localElicitationDraft
        }
        onFormDraftChange={persistElicitationDraft}
        autoResolution={isAskUserQuestion ? pending.autoResolution : undefined}
        onFirstInteraction={
          isAskUserQuestion
            ? (source) => {
                if (!loggedSnoozeSourceIdsRef.current.has(pending.interactionId)) {
                  loggedSnoozeSourceIdsRef.current.add(pending.interactionId);
                  logger.debug("[v4-interaction] AskUserQuestion 请求暂停自动结束", {
                    interactionId: pending.interactionId,
                    source,
                  });
                }
                autoResolutionIntentRef.current.markInteracted(pending.interactionId);
                return sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
              }
            : undefined
        }
        onRespond={(_requestId, action, content) => {
          if (questionFlight.current === pending.interactionId || imagesReading) return;
          questionFlight.current = pending.interactionId;
          setQuestionSubmitting(pending.interactionId);
          void resolveInteraction(pending.interactionId, {
            action,
            ...(action === "accept" && nativeQuestions
              ? { content: nativeQuestionResponseContent(nativeQuestions, content, imageExtras) }
              : content ? { content } : {}),
          }).then((accepted) => {
            if (questionOwnerRef.current !== questionOwner || questionFlight.current !== pending.interactionId) return;
            questionFlight.current = null;
            setQuestionSubmitting(null);
            if (!accepted) return;
            removeElicitationDraft(pending.interactionId);
            if (isExitPlanMode) {
              // Plan 回执 ACK 与 replayable pending 清场是两条异步路径。
              // 这里只上报已接受的 Plan interaction，由手机 pane 在仍读到旧权威状态时触发恢复。
              onPlanInteractionAccepted?.(pending.interactionId);
            }
          });
        }}
      />
      {interactionFailure?.interactionId === pending.interactionId ? (
        <p role="alert" className="mt-2 text-ui-sm text-destructive">{interactionFailure.message}</p>
      ) : null}
      </fieldset>
    );
  }

  const model = pendingUserInputToViewModel({
    ...pending,
    payload: pending.payload,
  });
  return (
    <V4UserInputDialog
      key={`${sessionId}:${pending.interactionId}`}
      model={model}
      errorMessage={interactionFailure?.interactionId === pending.interactionId ? interactionFailure.message : undefined}
      onSubmit={(answer) => resolveInteraction(pending.interactionId, answer)}
    />
  );
}
