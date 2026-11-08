import { connectViaWebSocket } from "@zcode/client";
import type { IServiceAccessor } from "@zcode/services";
import { serverRemoteInfoSchema, type ServerRemoteWorkspaceInfo } from "@zcode/shared";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createWebPlatform } from "../packages/web/src/platform/index.js";
import "../packages/web/src/styles.css";
import { WEBGUI_PROJECTS_PATH, WEBGUI_RPC_PATH, WEBGUI_SERVER_INFO_PATH } from "./session-info.js";

const serverInfoSchema = serverRemoteInfoSchema.pick({ workspaces: true });

async function openProject(
  path: string, create = false, newSession = false, showFiles = false,
): Promise<void> {
  const response = await fetch(WEBGUI_PROJECTS_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, ...(create ? { create: true } : {}) }),
  });
  const result = await response.json() as {
    projectId?: string;
    root?: string;
    url?: string;
    error?: string;
  };
  if (!response.ok) throw new Error(result.error || `Unable to open project (HTTP ${response.status}).`);
  if (!result.projectId || !result.root || !result.url) {
    throw new Error("The workspace server did not return a project binding.");
  }
  const target = new URL(result.url, window.location.href);
  if (target.origin !== window.location.origin ||
      target.searchParams.get("project") !== result.projectId) {
    throw new Error("The workspace server returned an invalid project binding.");
  }
  // Reopening this project must not reset the selected resident session or its draft.
  const current = new URLSearchParams(window.location.search);
  if (current.get("project") === result.projectId) {
    if (!newSession && !showFiles) return;
    const sessionId = current.get("session");
    if (sessionId && !newSession) target.searchParams.set("session", sessionId);
  }
  if (newSession) target.searchParams.set("newSession", "1");
  if (showFiles) target.searchParams.set("files", "1");
  // A document navigation tears down every old service, subscription and project-local pane.
  window.location.assign(target.href);
}

const platform = createWebPlatform({
  activateWorkspace: async (path) => {
    await openProject(path);
    return { activated: true };
  },
});

type BrowserState =
  | { status: "connecting" }
  | { status: "failed"; error: Error }
  | {
      status: "connected";
      services: IServiceAccessor;
      workspace?: ServerRemoteWorkspaceInfo;
      projectId?: string;
      directoryPath?: string;
      initialTaskId?: string;
    };

function createBrowserClientId(): string {
  return Array.from(window.crypto.getRandomValues(new Uint32Array(4))).join("-");
}

function BrowserApplication() {
  const [state, setState] = useState<BrowserState>({ status: "connecting" });
  const [clientId] = useState(() => {
    const key = "omp-webgui-client-id";
    try {
      const existing = window.sessionStorage.getItem(key);
      if (existing) return existing;
      const id = createBrowserClientId();
      window.sessionStorage.setItem(key, id);
      return id;
    } catch {
      return createBrowserClientId();
    }
  });

  useEffect(() => {
    const connection = new AbortController();
    const params = new URLSearchParams();
    const locationParams = new URLSearchParams(window.location.search);
    const project = locationParams.get("project");
    const selectedSession = locationParams.get("session");
    const createRequested = locationParams.get("newSession") === "1";
    if (createRequested) {
      // Consume the explicit navigation intent before any await so refresh never replays it.
      const consumed = new URL(window.location.href);
      consumed.searchParams.delete("newSession");
      window.history.replaceState(window.history.state, "", consumed.href);
    }
    if (project) params.set("project", project);
    const query = params.toString() ? `?${params}` : "";

    const fail = (error: unknown) => {
      if (connection.signal.aborted) return;
      setState({
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      connection.abort();
    };

    async function connect() {
      const response = await fetch(`${WEBGUI_SERVER_INFO_PATH}${query}`, {
        cache: "no-store",
        signal: connection.signal,
      });
      if (!response.ok) {
        throw new Error(`Unable to connect to the workspace server (HTTP ${response.status}).`);
      }
      const info = serverInfoSchema.parse(await response.json());
      if (project && info.workspaces.length === 0) {
        throw new Error("The selected project has no workspace binding.");
      }
      const socketUrl = new URL(`${WEBGUI_RPC_PATH}${query}`, window.location.href);
      socketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const services = await connectViaWebSocket(socketUrl.href, {
        browserDirect: true,
        signal: connection.signal,
        onClose: ({ code, reason }) => {
          fail(new Error(reason || `Workspace server connection closed (${code}).`));
        },
      });
      let { nativeSession } = await services.modelSelectionService.getView(
        selectedSession ? { sessionId: selectedSession } : undefined,
      );
      if (connection.signal.aborted) return;
      let initialTaskId = selectedSession ?? (nativeSession?.chatAvailable ? nativeSession.sessionId : undefined);
      if (createRequested) {
        const workspace = info.workspaces[0];
        if (!project || !workspace) throw new Error("Select a project before creating a native session.");
        const created = await services.zcodeSessionService.createSession({ workspacePath: workspace.path });
        initialTaskId = created.session.sessionId;
        if (!initialTaskId) throw new Error("The native host did not return a session.");
        if (connection.signal.aborted) return;
        ({ nativeSession } = await services.modelSelectionService.getView({ sessionId: initialTaskId }));
        if (connection.signal.aborted) return;
        const selected = new URL(window.location.href);
        selected.searchParams.set("session", initialTaskId);
        window.history.replaceState(window.history.state, "", selected.href);
      }
      const projectWorkspace = info.workspaces[0];
      const displayedWorkspace = projectWorkspace && nativeSession?.chatAvailable &&
        nativeSession.sessionId === initialTaskId
        ? { ...projectWorkspace, path: nativeSession.workspacePath } : projectWorkspace;
      setState({
        status: "connected",
        services,
        ...(project ? { workspace: displayedWorkspace, projectId: project } : {}),
        directoryPath: info.workspaces[0]?.path,
        ...(initialTaskId ? { initialTaskId } : {}),
      });
    }

    const disconnect = () => connection.abort();
    window.addEventListener("pagehide", disconnect);
    void connect().catch(fail);
    return () => {
      window.removeEventListener("pagehide", disconnect);
      connection.abort();
    };
  }, []);

  if (state.status === "failed") throw state.error;
  if (state.status === "connecting") return null;

  return (
    <ZCodeIntlProvider>
      <Root
        services={state.services}
        platform={platform}
        composerClientNamespace={`omp-webgui:${window.location.origin}:${state.projectId ?? "unbound"}:${state.workspace?.path ?? "unbound"}:${clientId}`}
        initialWorkspaceAbsPath={state.workspace?.path}
        initialWorkspaceIdentity={state.workspace?.workspaceIdentity}
        initialTaskId={state.initialTaskId}
        initialDirectoryPath={state.directoryPath}
        initialSidebarFileTreeOpen={new URLSearchParams(window.location.search).get("files") === "1"}
        nativeHostAvailable
        onOpenProject={openProject}
        restoreSession={false}
        responsiveBrowserLayout
        backendBusinessAvailable={false}
        isDesktop={false}
        supportsSettings
        allowOpenWorkspace
        preferDirectoryBrowser
      />
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <BrowserApplication />
  </AppErrorBoundary>,
);
