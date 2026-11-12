import "../packages/ui/src/dev/browserStorage.js";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { IServiceAccessor } from "@zcode/services";
import { useEffect, useState } from "react";
import { DevDataSourceProvider, useDevDataSource, type DevDataSource } from "../packages/ui/src/dev/data-source.js";
import { DevWorkspaceRecovery } from "../packages/ui/src/dev/DevWorkspaceRecovery.js";
import { DevEntry, useDevIdentity } from "../packages/ui/src/dev/DevEntry.js";
import { DevProvider, useDev } from "../packages/ui/src/dev/DevContext.js";
import {
  bindRemoteWorkspaceIdentity,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "../packages/ui/src/store/remoteWorkspaceSessionStore.js";
import { createWebPlatform } from "../packages/web/src/platform/index.js";
import "../packages/web/src/styles.css";

const platform = { ...createWebPlatform(), canOpenCommunity: async () => false };

function BrowserApplication() {
  const source = useDevDataSource();
  const dev = useDev()!;
  const identity = useDevIdentity();
  const { selection, session, view } = dev;
  const workspace = source.resolveWorkspace(view, selection);
  const [connection, setConnection] = useState<{ key: string; services: IServiceAccessor }>();
  const [connectionError, setConnectionError] = useState<string>();
  const formalProgress = Boolean(selection.formalView || view?.groups.some(group => group.id === selection.irId));
  // 列表和同页报告复用工作区，保留表格筛选、展开与滚动位置。
  const key = JSON.stringify([source.backend?.id ?? source.clientId, identity?.employeeId, workspace.identity, workspace.path, selection.projectId, formalProgress ? "formal-progress" : selection.irId, formalProgress ? undefined : selection.srId, selection.freeSessionId, session?.sessionId, session?.round]);

  useEffect(() => {
    if (!view || !workspace.path) return;
    let active = true;
    let dispose: (() => void | Promise<void>) | undefined;
    const close = () => {
      const release = dispose;
      dispose = undefined;
      if (release) void Promise.resolve(release()).catch(dev.report);
    };
    const registrationId = `dev:${source.clientId}:${crypto.randomUUID()}`;
    setConnectionError(undefined);
    void source.connectWorkspace(workspace, selection, session).then(async opened => {
      if (!active) { await opened.dispose(); return; }
      dispose = opened.dispose;
      registerRemoteWorkspaceSession({
        sessionId: registrationId,
        workspacePath: workspace.path!,
        workspaceIdentity: workspace.identity,
        services: opened.services,
        dispose: close,
      });
      bindRemoteWorkspaceIdentity(workspace.identity, registrationId);
      setConnection({ key, services: opened.services });
    }).catch((cause: unknown) => {
      close();
      if (active) setConnectionError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      unregisterRemoteWorkspaceSession(registrationId);
      close();
    };
  }, [source, key]);

  if (!view) return <ConnectionStatus error={dev.error} retry={() => { void dev.retrySession(); }} />;
  if (dev.pending && !workspace.path) return <ConnectionStatus error={dev.error} retry={() => { void dev.refresh(); }} />;
  if (!workspace.path) return <DevWorkspaceRecovery workspace={workspace} />;
  if (connectionError) return <ConnectionStatus error={connectionError} retry={() => window.location.reload()} />;
  if (!connection || connection.key !== key) return <ConnectionStatus />;
  return <div className="contents" data-dev-connection-state="connected" data-dev-workspace-path={workspace.path} data-dev-workspace-identity={workspace.identity} data-dev-workspace-kind={workspace.kind}>
    {dev.error && <p role="alert" className="fixed inset-x-0 top-0 z-50 bg-background p-3 text-destructive">{dev.error}</p>}
    <Root
      key={key}
      services={connection.services}
      platform={platform}
      composerClientNamespace={`dev:${source.backend?.id ?? source.clientId}:${identity?.employeeId ?? ""}`}
      initialWorkspaceAbsPath={workspace.path}
      initialWorkspaceIdentity={workspace.identity}
      initialDirectoryPath={workspace.path}
      initialTaskId={selection.freeSessionId ?? session?.sessionId}
      initialSidebarFileTreeOpen={selection.freeFiles}
      onOpenProject={async (path, _create, newSession, showFiles) => {
        const target = view.projects.find(item => item.root === path || source.projects?.readDevelopmentRoot(item.id, identity?.employeeId) === path);
        if (!target) throw new Error("请先在 Dev 设置中添加已有 Git 项目。");
        const recent = (await source.readRecentFreeChats(target.id))[0];
        if (newSession || !recent) dev.startFreeChat(target.id, showFiles);
        else dev.openFreeChat(recent.taskId, showFiles);
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

export function DevApplication({ source }: { source: DevDataSource }) {
  return <AppErrorBoundary><ZCodeIntlProvider><DevDataSourceProvider source={source}>
    <DevEntry><DevProvider><BrowserApplication /></DevProvider></DevEntry>
  </DevDataSourceProvider></ZCodeIntlProvider></AppErrorBoundary>;
}
