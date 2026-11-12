import { useAIReq } from "@/aireq/AIReqContext.js";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, FileText, RefreshCw } from "lucide-react";
import type { IZCodeAgentService } from "@zcode/services";
import type { NativeTaskOutputContent, NativeTaskRunsSnapshot } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { NativeTaskRunGraph } from "@/settings/saved-workflows/NativeTaskRunGraph.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

/** Resolve the native owner before mounting any legacy saved-workflow readers. */
export function NativeTaskRunsGate({
  header,
  workspacePath,
  workspaceIdentity,
  children,
}: {
  header?: ReactNode;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  children: ReactNode;
}) {
  const aireq = useAIReq();
  const owner = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const modelRead = useModelSelectionServiceView(owner.services.modelSelectionService, owner.rpcReady);
  const { locale } = useZCodeIntl();
  const view =
    modelRead.state.status === "ready" ? modelRead.state.view :
      modelRead.state.status === "loading" ? modelRead.state.catalog : undefined;
  if (aireq) {
    return <ServiceProvider services={owner.services}><NativeTaskRunsSection
      key={`${workspacePath}:${aireq.session?.sessionId ?? "unbound"}`} header={header}
      sessionId={aireq.session?.sessionId ?? null} available={Boolean(aireq.session)}
      workspacePath={workspacePath ?? ""} workspaceIdentity={workspaceIdentity}
      remoteSessionId={owner.remoteSessionId ?? undefined}
    /></ServiceProvider>;
  }
  if (!view) {
    return (
      <div className={SETTINGS_FRAME_CONTENT_CLASSNAME}>
        {header}
        {modelRead.state.status === "error" ? (
          <div role="alert" className="mt-8 text-ui-base text-foreground-subtle">
            <p>{modelRead.state.error.message}</p>
            <Button type="button" variant="outline" onClick={modelRead.reload}>
              <RefreshCw className="size-3.5" aria-hidden />
              {locale.startsWith("zh") ? "重试" : "Retry"}
            </Button>
          </div>
        ) : modelRead.state.status === "unavailable" ? (
          <p role="status" className="mt-8 text-ui-base text-foreground-subtle">
            {locale.startsWith("zh") ? "正在等待工作区连接。" : "Waiting for the workspace connection."}
          </p>
        ) : (
          <Spinner className="mt-8 size-5" />
        )}
      </div>
    );
  }
  if (view.nativeSession !== undefined) {
    // 执行 cwd 可随历史恢复改变；RPC/Actor 必须保留解析 owner 时的页面作用域。
    const requestWorkspacePath = workspacePath;
    if (!requestWorkspacePath?.trim()) {
      return (
        <div className={SETTINGS_FRAME_CONTENT_CLASSNAME}>
          {header}
          <p role="status" className="mt-8 text-ui-base text-foreground-subtle">
            {locale.startsWith("zh") ? "原生会话尚未提供工作目录。" : "The native session has not provided its workspace."}
          </p>
        </div>
      );
    }
    return (
      <ServiceProvider services={owner.services}>
        <NativeTaskRunsSection
          key={`${workspaceIdentity ?? ""}:${requestWorkspacePath}:${view.nativeSession?.sessionId ?? "unbound"}`}
          header={header}
          sessionId={view.nativeSession?.sessionId ?? null}
          available={view.nativeSession?.taskRunsAvailable === true}
          workspacePath={requestWorkspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={owner.remoteSessionId ?? undefined}
        />
      </ServiceProvider>
    );
  }
  return children;
}

type Selection =
  | { kind: "actor"; runId: string; sessionId: string }
  | { kind: "output"; runId: string; outputId: string };

interface NativeTaskRunsSectionProps {
  header?: ReactNode;
  sessionId: string | null;
  available: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface OwnedRuns {
  service: IZCodeAgentService;
  sessionId: string;
  snapshot: NativeTaskRunsSnapshot | null;
  loading: boolean;
  error: string | null;
}

export function NativeTaskRunsSection({
  header,
  sessionId,
  available,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: NativeTaskRunsSectionProps) {
  const { zcodeAgentService: service } = useServices();
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const [refresh, setRefresh] = useState(0);
  const [owned, setOwned] = useState<OwnedRuns | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const supported = available && !!sessionId && !!workspacePath.trim() && !!service?.listNativeTaskRuns && !!service?.readNativeTaskOutput;
  const current = owned?.service === service && owned?.sessionId === sessionId ? owned : null;
  const snapshot = current?.snapshot;
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [workspacePath, workspaceIdentity, remoteSessionId],
  );

  useEffect(() => {
    if (!supported || !sessionId || !service?.onNativeTaskRunsChanged) return;
    const subscription = service.onNativeTaskRunsChanged((event) => {
      if (event.sessionId === sessionId) setRefresh((value) => value + 1);
    });
    return () => subscription.dispose();
  }, [service, sessionId, supported]);

  useEffect(() => {
    if (!supported || !sessionId || !service?.listNativeTaskRuns) return;
    let active = true;
    setOwned((previous) => ({
      service,
      sessionId,
      snapshot: previous?.service === service && previous.sessionId === sessionId ? previous.snapshot : null,
      loading: true,
      error: null,
    }));
    void service.listNativeTaskRuns({ ...scope, sessionId }).then(
      (next) => {
        if (!active) return;
        setOwned({ service, sessionId, snapshot: next, loading: false, error: null });
      },
      (error: unknown) => {
        if (!active) return;
        setOwned((previous) => ({
          service,
          sessionId,
          snapshot: previous?.service === service && previous.sessionId === sessionId ? previous.snapshot : null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    );
    return () => { active = false; };
  }, [service, sessionId, supported, refresh, scope]);

  const run = selection ? snapshot?.runs.find((item) => item.runId === selection.runId) : undefined;
  const actor = selection?.kind === "actor"
    ? run?.actors.find((item) => item.sessionId === selection.sessionId)
    : undefined;
  const output = selection?.kind === "output"
    ? run?.outputs.find((item) => item.id === selection.outputId)
    : undefined;

  return (
    <div data-automations-content className={`${SETTINGS_FRAME_CONTENT_CLASSNAME} flex min-h-0 flex-col`}>
      {header}
      <div className="mb-5 mt-8 flex items-center justify-between gap-3">
        <h2 className="text-ui-base font-medium text-foreground-subtle">
          {zh ? "原生任务运行" : "Native task runs"}
        </h2>
        {supported ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={zh ? "刷新" : "Refresh"}
            onClick={() => setRefresh((value) => value + 1)}
            disabled={current?.loading}
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
      {!supported ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {zh ? "当前会话未提供原生任务运行读取能力。" : "Native task runs are unavailable for this session."}
        </p>
      ) : (
        <>
          {current?.error ? <p role="alert" className="mb-4 break-words text-ui-base text-destructive">{current.error}</p> : null}
          {!snapshot && !current?.error ? <Spinner className="my-8 size-5 self-center" /> : null}
          {selection ? (
            <section className="min-w-0">
              <Button type="button" variant="ghost" onClick={() => setSelection(null)} className="mb-3">
                <ArrowLeft className="size-4" aria-hidden />
                {zh ? "返回运行列表" : "Back to runs"}
              </Button>
              <h3 className="mb-3 break-words text-ui-base font-medium">{actor?.title ?? output?.title}</h3>
              {actor && sessionId ? (
                <div className="h-[65vh] min-h-80 overflow-hidden rounded-xl border border-card-border">
                  <V4PaneConversationProvider scope={scope}>
                    <SessionPane
                      key={actor.sessionId}
                      paneId={`native-task:${sessionId}:${actor.sessionId}`}
                      sessionId={actor.sessionId}
                      rootSessionId={sessionId}
                      readOnly
                      focused
                      workspacePath={workspacePath}
                      workspaceIdentity={workspaceIdentity}
                      remoteSessionId={remoteSessionId}
                    />
                  </V4PaneConversationProvider>
                </div>
              ) : output && run && sessionId ? (
                <NativeTaskOutputView
                  key={`${sessionId}:${run.runId}:${output.id}`}
                  service={service}
                  sessionId={sessionId}
                  runId={run.runId}
                  outputId={output.id}
                  refresh={refresh}
                  workspacePath={workspacePath}
                  workspaceIdentity={workspaceIdentity}
                  remoteSessionId={remoteSessionId}
                />
              ) : snapshot ? (
                <p role="status" className="text-ui-base text-foreground-subtle">
                  {zh ? "此运行中的会话或输出已不可用。" : "This run's session or output is no longer available."}
                </p>
              ) : null}
            </section>
          ) : (
            <div className="space-y-4">
              {snapshot?.runs.length === 0 ? (
                <p className="py-8 text-ui-base text-foreground-subtlest">
                  {zh ? "当前会话尚未观测到 task / workpool 调用。" : "No task / workpool invocations observed in this session."}
                </p>
              ) : null}
              {snapshot?.runs.map((item) => (
                <section key={item.runId} className="min-w-0 rounded-xl border border-card-border p-4">
                  <NativeTaskRunGraph
                    run={item}
                    onOpenActor={(next) => setSelection({ kind: "actor", runId: item.runId, sessionId: next.sessionId })}
                  />
                  {item.outputs.length > 0 ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {item.outputs.map((entry) => (
                        <Button
                          key={entry.id}
                          type="button"
                          variant="outline"
                          className="max-w-full"
                          onClick={() => setSelection({ kind: "output", runId: item.runId, outputId: entry.id })}
                        >
                          <FileText className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate">{entry.title}</span>
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NativeTaskOutputView({
  service, sessionId, runId, outputId, refresh, workspacePath, workspaceIdentity, remoteSessionId,
}: {
  service: IZCodeAgentService;
  sessionId: string;
  runId: string;
  outputId: string;
  refresh: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const [state, setState] = useState<{ content: NativeTaskOutputContent | null; error: string | null }>({ content: null, error: null });
  useEffect(() => {
    if (!service.readNativeTaskOutput) return;
    let active = true;
    setState({ content: null, error: null });
    void service.readNativeTaskOutput({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      sessionId,
      runId,
      outputId,
    }).then(
      (content) => { if (active) setState({ content, error: null }); },
      (error: unknown) => {
        if (active) setState({ content: null, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => { active = false; };
  }, [service, sessionId, runId, outputId, refresh, workspacePath, workspaceIdentity, remoteSessionId]);
  if (state.error) return <p role="alert" className="break-words text-ui-base text-destructive">{state.error}</p>;
  if (!state.content) return <Spinner className="my-8 size-5" />;
  return (
    <div className="max-h-[65vh] min-w-0 overflow-auto rounded-xl border border-card-border p-4">
      {state.content.format === "markdown" ? (
        <MessageResponse theme={theme} workspacePath={workspacePath} className="min-w-0 break-words text-foreground">
          {state.content.content}
        </MessageResponse>
      ) : (
        <CodeBlock
          appTheme={theme}
          code={state.content.content}
          language={state.content.format === "json" ? "json" : "text"}
        />
      )}
    </div>
  );
}
