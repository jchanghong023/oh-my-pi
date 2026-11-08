import { connectViaWebSocket } from "@zcode/client";
import type { IServiceAccessor } from "@zcode/services";
import { serverRemoteInfoSchema, type ServerRemoteWorkspaceInfo } from "@zcode/shared";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createWebPlatform } from "../packages/web/src/platform/index.js";
import "../packages/web/src/styles.css";
import { WEBGUI_RPC_PATH, WEBGUI_SERVER_INFO_PATH } from "./session-info.js";

const serverInfoSchema = serverRemoteInfoSchema.pick({ workspaces: true });
const platform = createWebPlatform();

type BrowserState =
  | { status: "connecting" }
  | { status: "failed"; error: Error }
  | { status: "connected"; services: IServiceAccessor; workspace?: ServerRemoteWorkspaceInfo };

function BrowserApplication() {
  const [state, setState] = useState<BrowserState>({ status: "connecting" });

  useEffect(() => {
    const connection = new AbortController();
    const params = new URLSearchParams();
    const project = new URLSearchParams(window.location.search).get("project");
    if (project) params.set("project", project);
    const query = params.size ? `?${params}` : "";

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
      const socketUrl = new URL(`${WEBGUI_RPC_PATH}${query}`, window.location.href);
      socketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const services = await connectViaWebSocket(socketUrl.href, {
        browserDirect: true,
        signal: connection.signal,
        onClose: ({ code, reason }) => {
          fail(new Error(reason || `Workspace server connection closed (${code}).`));
        },
      });
      if (connection.signal.aborted) return;
      setState({ status: "connected", services, workspace: info.workspaces[0] });
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
    <ZCodeIntlProvider
      initialLocale="zh-CN"
      settingService={state.services.settingService}
      broadcastService={state.services.broadcastService}
    >
      <Root
        services={state.services}
        platform={platform}
        initialWorkspaceAbsPath={state.workspace?.path}
        initialWorkspaceIdentity={state.workspace?.workspaceIdentity}
        restoreSession={false}
        responsiveBrowserLayout
        backendBusinessAvailable={false}
        isDesktop={false}
        supportsSettings
        supportsEmbeddedBrowser={false}
        allowOpenWorkspace
        preferDirectoryBrowser
        allowRemoteWorkspace={false}
        webRemoteControlFeatureEnabled={false}
      />
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary isDesktop={false}>
    <BrowserApplication />
  </AppErrorBoundary>,
);
