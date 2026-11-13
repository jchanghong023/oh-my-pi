import { createWorkspaceServiceProjection } from "../packages/ui/src/lib/workspaceServiceProjection.js";
import { isFormalSelection } from "../packages/ui/src/aireq/domain.js";
import "../packages/ui/src/aireq/browserStorage.js";
import { createUuid } from "@zcode/shared";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { AIReqWorkspace } from "../packages/ui/src/aireq/types.js";
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

interface ProjectConnection {
  key: string;
  registrationId: string;
  services: IServiceAccessor;
  workspaceServices: IServiceAccessor;
  workspace: AIReqWorkspace;
  taskId?: string;
  attachment: { active: boolean };
}

const platform = { ...createWebPlatform(), canOpenCommunity: async () => false };

function BrowserApplication() {
  const source = useAIReqDataSource();
  const aireq = useAIReq()!;
  const identity = useAIReqIdentity();
  const { selection, session, view } = aireq;
  const workspace = source.resolveWorkspace(view, selection);
  const [connection, setConnection] = useState<ProjectConnection>();
  const [connectionError, setConnectionError] = useState<string>();
  const formalProgress = isFormalSelection(view, selection);
  const workspaceSession = formalProgress ? undefined : session;
  // 连接、Root 和 dir 归属 OMP 项目；切换 IR／Agent 只切换各自的会话 ID。
  const key = JSON.stringify([source.backend?.id ?? source.clientId, identity?.employeeId, selection.projectId]);
  const taskId = formalProgress ? undefined : selection.freeSessionId ?? workspaceSession?.sessionId;

  useEffect(() => {
    if (!selection.projectId) return;
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
    const openProject = async () => {
      const projectSelection = { projectId: selection.projectId };
      const projectView = await source.readWorkflow(projectSelection);
      const projectWorkspace = source.resolveWorkspace(projectView, projectSelection);
      if (!projectWorkspace.path) throw new Error(projectWorkspace.error ?? "项目工作区不可用。");
      if (!active) return;
      const opened = await source.connectWorkspace(projectWorkspace, projectSelection);
      if (!active) { await opened.dispose(); return; }
      dispose = opened.dispose;
      registerBaseWorkspaceServices(opened.services);
      const workspaceServices = createWorkspaceServiceProjection(opened.services);
      registerRemoteWorkspaceSession({
        sessionId: registrationId,
        workspacePath: projectWorkspace.path,
        workspaceIdentity: projectWorkspace.identity,
        services: workspaceServices,
        dispose: close,
      });
      bindRemoteWorkspaceIdentity(projectWorkspace.identity, registrationId);
      setConnection({ key, registrationId, services: opened.services, workspaceServices, workspace: projectWorkspace, attachment });
    };
    void openProject().catch((cause: unknown) => {
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

  useEffect(() => {
    if (!aireq.selectionReady || !workspace.path || !connection || connection.key !== key || !connection.attachment.active) return;
    if (connection.workspace.path === workspace.path && connection.workspace.identity === workspace.identity && connection.taskId === taskId) return;
    // 正常 IR／Agent 切换只更新 taskId，不重新绑定项目目录或服务。
    // 旧自由会话／开发夹具仍保留其显式目录，不将它们误绑定到提案项目。
    if (connection.workspace.path !== workspace.path || connection.workspace.identity !== workspace.identity) {
      registerRemoteWorkspaceSession({
        sessionId: connection.registrationId,
        workspacePath: workspace.path,
        workspaceIdentity: workspace.identity,
        services: connection.workspaceServices,
      });
      bindRemoteWorkspaceIdentity(workspace.identity, connection.registrationId);
    }
    setConnection({ ...connection, workspace, taskId });
  }, [connection, key, aireq.selectionReady, workspace.path, workspace.identity, taskId]);

  if (!view) return <ConnectionStatus error={aireq.error} retry={() => { void aireq.retrySession(); }} />;
  if (aireq.pending && !workspace.path && connection?.key !== key) return <ConnectionStatus error={aireq.error} retry={() => { void aireq.refresh(); }} />;
  if (!workspace.path && connection?.key !== key) return <AIReqWorkspaceRecovery workspace={workspace} />;
  if (connectionError) return <ConnectionStatus error={connectionError} retry={() => window.location.reload()} />;
  if (!connection || connection.key !== key || !connection.attachment.active) return <ConnectionStatus />;
  return <div className="contents" data-aireq-connection-state="connected" data-aireq-workspace-path={connection.workspace.path} data-aireq-workspace-identity={connection.workspace.identity} data-aireq-workspace-kind={connection.workspace.kind}>
    {(aireq.error || (!aireq.pending && !workspace.path && workspace.error)) && !formalProgress && <div role="alert" className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-background p-3 text-destructive">
      <span>{aireq.error || workspace.error}</span><button type="button" onClick={() => { void aireq.refresh(); }}>重试读取</button>
    </div>}
    <Root
      key={key}
      services={connection.services}
      platform={platform}
      composerClientNamespace={`aireq:${source.backend?.id ?? source.clientId}:${identity?.employeeId ?? ""}`}
      initialWorkspaceAbsPath={connection.workspace.path}
      initialWorkspaceIdentity={connection.workspace.identity}
      initialDirectoryPath={connection.workspace.path}
      initialTaskId={connection.taskId}
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
