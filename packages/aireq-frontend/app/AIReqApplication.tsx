import { createWorkspaceServiceProjection } from "../packages/ui/src/lib/workspaceServiceProjection.js";
import { isFormalSelection } from "../packages/ui/src/aireq/domain.js";
import "../packages/ui/src/aireq/browserStorage.js";
import { createUuid } from "@zcode/shared";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { IServiceAccessor } from "@zcode/services";
import { useEffect, useState } from "react";
import { AIReqDataSourceProvider, useAIReqDataSource, type AIReqDataSource } from "../packages/ui/src/aireq/data-source.js";
import { AIReqWorkspaceRecovery } from "../packages/ui/src/aireq/AIReqWorkspaceRecovery.js";
import { AIReqEntry, useAIReqIdentity } from "../packages/ui/src/aireq/AIReqEntry.js";
import { AIReqProvider, useAIReq } from "../packages/ui/src/aireq/AIReqContext.js";
import {
  bindRemoteWorkspaceIdentity,
  registerRemoteWorkspaceSession,
  registerBaseWorkspaceServices,
  unregisterRemoteWorkspaceSession,
} from "../packages/ui/src/store/remoteWorkspaceSessionStore.js";
import { createWebPlatform } from "../packages/web/src/platform/index.js";
import "../packages/web/src/styles.css";

const platform = { ...createWebPlatform(), canOpenCommunity: async () => false };

function BrowserApplication() {
  const source = useAIReqDataSource();
  const aireq = useAIReq()!;
  const identity = useAIReqIdentity();
  const { selection, session, view } = aireq;
  const workspace = source.resolveWorkspace(view, selection);
  const [connection, setConnection] = useState<{ key: string; services: IServiceAccessor; attachment: { active: boolean } }>();
  const [connectionError, setConnectionError] = useState<string>();
  const formalProgress = isFormalSelection(view, selection);
  const workspaceSession = formalProgress ? undefined : session;
  const proposal = view?.drafts.find(group => group.id === selection.irId && group.projectId === selection.projectId);
  const review = session?.role === "reviewer" ? [proposal?.review, ...(proposal?.reviewHistory ?? [])].find(item => item?.agents?.some(agent => agent.session.sessionId === session.sessionId)) : undefined;
  // 同轮评审共享工作区连接；四个会话由原生会话 store 切换，不重建整个 Root。
  const sessionScope = review ? `requirements-review:${review.id}` : workspaceSession?.sessionId;
  // 列表和同页报告复用工作区，保留表格筛选、展开与滚动位置。
  const key = JSON.stringify([source.backend?.id ?? source.clientId, identity?.employeeId, workspace.identity, workspace.path, selection.projectId, formalProgress ? "formal-progress" : selection.irId, formalProgress ? undefined : selection.srId, selection.freeSessionId, sessionScope, workspaceSession?.round]);

  useEffect(() => {
    if (!view || !workspace.path) return;
    let active = true;
    const attachment = { active: true };
    let dispose: (() => void | Promise<void>) | undefined;
    const close = () => {
      attachment.active = false;
      const release = dispose;
      dispose = undefined;
      if (release) void Promise.resolve(release()).catch(aireq.report);
    };
    const registrationId = `aireq:${source.clientId}:${createUuid()}`;
    setConnectionError(undefined);
    void source.connectWorkspace(workspace, selection, workspaceSession).then(async opened => {
      if (!active) { await opened.dispose(); return; }
      dispose = opened.dispose;
      registerBaseWorkspaceServices(opened.services);
      const workspaceServices = createWorkspaceServiceProjection(opened.services);
      registerRemoteWorkspaceSession({
        sessionId: registrationId,
        workspacePath: workspace.path!,
        workspaceIdentity: workspace.identity,
        services: workspaceServices,
        dispose: close,
      });
      bindRemoteWorkspaceIdentity(workspace.identity, registrationId);
      setConnection({ key, services: opened.services, attachment });
    }).catch((cause: unknown) => {
      close();
      if (active) setConnectionError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      attachment.active = false;
      // Child effects issue unsubscribe/unwatch RPCs during the same cleanup pass.
      queueMicrotask(() => {
        unregisterRemoteWorkspaceSession(registrationId);
        close();
      });
    };
  }, [source, key]);

  if (!view) return <ConnectionStatus error={aireq.error} retry={() => { void aireq.retrySession(); }} />;
  if (aireq.pending && !workspace.path) return <ConnectionStatus error={aireq.error} retry={() => { void aireq.refresh(); }} />;
  if (!workspace.path) return <AIReqWorkspaceRecovery workspace={workspace} />;
  if (connectionError) return <ConnectionStatus error={connectionError} retry={() => window.location.reload()} />;
  if (!connection || connection.key !== key || !connection.attachment.active) return <ConnectionStatus />;
  return <div className="contents" data-aireq-connection-state="connected" data-aireq-workspace-path={workspace.path} data-aireq-workspace-identity={workspace.identity} data-aireq-workspace-kind={workspace.kind}>
    {aireq.error && !formalProgress && <p role="alert" className="fixed inset-x-0 top-0 z-50 bg-background p-3 text-destructive">{aireq.error}</p>}
    <Root
      key={key}
      services={connection.services}
      platform={platform}
      composerClientNamespace={`aireq:${source.backend?.id ?? source.clientId}:${identity?.employeeId ?? ""}`}
      initialWorkspaceAbsPath={workspace.path}
      initialWorkspaceIdentity={workspace.identity}
      initialDirectoryPath={workspace.path}
      initialTaskId={formalProgress ? undefined : selection.freeSessionId ?? workspaceSession?.sessionId}
      initialSidebarFileTreeOpen={selection.freeFiles}
      onOpenProject={async (path, _create, newSession, showFiles) => {
        const target = view.projects.find(item => item.root === path || source.projects?.readDevelopmentRoot(item.id, identity?.employeeId) === path);
        if (!target) throw new Error("请先在 AIReq 设置中添加已有 Git 项目。");
        const recent = (await source.readRecentFreeChats(target.id))[0];
        if (newSession || !recent) aireq.startFreeChat(target.id, showFiles);
        else aireq.openFreeChat(recent.taskId, showFiles);
      }}
      nativeHostAvailable={source.capabilities.nativeChat}
      restoreSession={false}
      responsiveBrowserLayout
      backendBusinessAvailable={false /* OMP owns native configuration, not the copied product backend. */}
      isDesktop={false}
      supportsSettings
      allowOpenWorkspace={false}
    />
  </div>;
}

function ConnectionStatus({ error, retry }: { error?: string; retry?: () => void }) {
  return <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
    <section className="max-w-lg space-y-4">
      <p role={error ? "alert" : "status"} className="whitespace-pre-wrap break-words">{error ?? "正在读取工作区…"}</p>
      {error && retry ? <button type="button" className="rounded-lg border border-border px-4 py-2" onClick={retry}>重新读取</button> : null}
    </section>
  </main>;
}

export function AIReqApplication({ source }: { source: AIReqDataSource }) {
  return <AppErrorBoundary><ZCodeIntlProvider><AIReqDataSourceProvider source={source}>
    <AIReqEntry><AIReqProvider><BrowserApplication /></AIReqProvider></AIReqEntry>
  </AIReqDataSourceProvider></ZCodeIntlProvider></AppErrorBoundary>;
}
