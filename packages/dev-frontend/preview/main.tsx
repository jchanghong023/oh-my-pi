import "../packages/ui/src/dev/browserStorage.js";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { readPrototypeFreeChat, readRecentFreeChats } from "../packages/ui/src/dev/mock/free-chats.js";
import { readPrototypeDevelopmentRoot } from "../packages/ui/src/dev/mock/project-settings.js";
import { DevEntry, useDevIdentity } from "../packages/ui/src/dev/DevEntry.js";
import { DevProvider, useDev } from "../packages/ui/src/dev/DevContext.js";
import {
  bindRemoteWorkspaceIdentity,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "../packages/ui/src/store/remoteWorkspaceSessionStore.js";
import { createWebPlatform } from "../packages/web/src/platform/index.js";
import {
  createPrototypeServices,
  PROTOTYPE_TASK_ID,
  PROTOTYPE_WORKSPACE,
  PROTOTYPE_WORKSPACE_IDENTITY,
} from "./mock-services.js";
import "../packages/web/src/styles.css";

// Temporary UI review phase. Real OMP integration follows frontend approval.
const services = createPrototypeServices();
const platform = {
  ...createWebPlatform(),
  canOpenCommunity: async () => false,
};

function BrowserApplication() {
  const dev = useDev()!;
  const identity = useDevIdentity();
  const { selection, session, view } = dev;
  const project = view?.projects.find(item => item.id === selection.projectId);
  const free = selection.freeSessionId ? readPrototypeFreeChat(selection.freeSessionId)?.meta : undefined;
  const workspacePath = free?.workspacePath ?? project?.root ?? PROTOTYPE_WORKSPACE;
  const workspaceIdentity = free?.workspaceIdentity ?? `${PROTOTYPE_WORKSPACE_IDENTITY}:${selection.projectId ?? "demo-aurora"}`;
  const taskId = free?.taskId ?? session?.sessionId ?? PROTOTYPE_TASK_ID;
  const [registeredIdentity, setRegisteredIdentity] = useState<string>();
  useEffect(() => {
    // Reuse only the copied UI's in-memory scope registry; no remote connection exists.
    const registrationId = `prototype:${workspaceIdentity}`;
    registerRemoteWorkspaceSession({
      sessionId: registrationId,
      workspacePath,
      workspaceIdentity,
      services,
      dispose: () => {},
    });
    bindRemoteWorkspaceIdentity(workspaceIdentity, registrationId);
    setRegisteredIdentity(workspaceIdentity);
    return () => unregisterRemoteWorkspaceSession(registrationId);
  }, [workspacePath, workspaceIdentity]);

  if (registeredIdentity !== workspaceIdentity) return null;

  return (
    <div className="contents" data-dev-connection-state="prototype">
      <Root
        key={`${selection.projectId}:${selection.irId}:${taskId}:${selection.freeFiles ?? false}`}
        services={services}
        platform={platform}
        composerClientNamespace={`dev-ui-prototype:${identity?.employeeId ?? ""}`}
        initialWorkspaceAbsPath={workspacePath}
        initialWorkspaceIdentity={workspaceIdentity}
        initialDirectoryPath={workspacePath}
        initialTaskId={taskId}
        initialSidebarFileTreeOpen={selection.freeFiles}
        onOpenProject={async (path, _create, newSession, showFiles) => {
          const target = view?.projects.find(item => item.root === path || readPrototypeDevelopmentRoot(item.id) === path);
          if (!target) throw new Error("请先在 Dev 设置中添加已有 Git 项目。");
          const recent = readRecentFreeChats(target.id)[0];
          if (newSession || !recent) dev.startFreeChat(target.id);
          else dev.openFreeChat(recent.taskId, showFiles);
        }}
        nativeHostAvailable
        restoreSession={false}
        responsiveBrowserLayout
        backendBusinessAvailable={false}
        isDesktop={false}
        supportsSettings
        allowOpenWorkspace={false}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <ZCodeIntlProvider>
      <DevEntry>
      <DevProvider>
        <BrowserApplication />
      </DevProvider>
      </DevEntry>
    </ZCodeIntlProvider>
  </AppErrorBoundary>,
);
