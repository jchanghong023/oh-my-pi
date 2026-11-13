import { memo } from "react";
import { ProjectDirectoryProvider } from "@/project-sidebar/index.js";
import { App } from "@/App.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import type { AppProps, WorkspaceRemoteNavigationProps } from "@/app-shell/types.js";
import type { RootProps } from "@/root/types.js";
import type { IServiceAccessor } from "@zcode/services";

const StableWorkspaceApp = memo(App);

interface RootWorkspaceContentProps extends WorkspaceRemoteNavigationProps {
  workspaceScopedServices: IServiceAccessor;
  workspaceShellPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  handleCreateTask: AppProps["onCreateTask"];
  handleCreateConversationTask: NonNullable<AppProps["onCreateConversationTask"]>;
  handleResolveConversationWorkspace: NonNullable<AppProps["onResolveConversationWorkspace"]>;
  handleOpenWorkspace: AppProps["onOpenWorkspace"];
  handleOpenFolderFromWorkspaceMenu: AppProps["onOpenFolderFromWorkspaceMenu"];
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  responsiveBrowserLayout?: RootProps["responsiveBrowserLayout"];
  backendBusinessAvailable?: RootProps["backendBusinessAvailable"];
  initialSidebarFileTreeOpen?: boolean;
  isDesktop?: RootProps["isDesktop"];
}

export function RootWorkspaceContent({
  workspaceScopedServices,
  workspaceShellPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  handleCreateTask,
  handleCreateConversationTask,
  handleResolveConversationWorkspace,
  handleOpenWorkspace,
  handleOpenFolderFromWorkspaceMenu,
  allowOpenWorkspace,
  responsiveBrowserLayout,
  backendBusinessAvailable,
  initialSidebarFileTreeOpen,
  isDesktop,
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceRecoveryByWorkspaceKey,
  remoteWorkspaceErrorByWorkspaceKey,
}: RootWorkspaceContentProps) {
  const workspaceKey = workspaceIdentity?.trim() || workspaceShellPath;

  return (
    <ProjectDirectoryProvider isDesktop={isDesktop}>
      <div className="h-full" data-root-workspace-surface="interactive">
        <ServiceProvider services={workspaceScopedServices}>
          <ScopedErrorBoundary
            scope="workspace-app"
            resetKeys={[workspaceKey]}
            variant="panel"
            className="h-full"
          >
            <StableWorkspaceApp
              services={workspaceScopedServices}
              workspaceAbsPath={workspaceShellPath}
              workspaceRemoteSessionId={workspaceRemoteSessionId}
              workspaceIdentity={workspaceIdentity}
              onCreateTask={handleCreateTask}
              onCreateConversationTask={handleCreateConversationTask}
              onResolveConversationWorkspace={handleResolveConversationWorkspace}
              onOpenWorkspace={handleOpenWorkspace}
              onOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
              onConnectRemote={onConnectRemote}
              onSelectRemoteProject={onSelectRemoteProject}
              onCancelRemoteProject={onCancelRemoteProject}
              onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
              reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
              remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
              remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
              allowOpenWorkspace={allowOpenWorkspace}
              responsiveBrowserLayout={responsiveBrowserLayout}
              backendBusinessAvailable={backendBusinessAvailable}
              initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
              isDesktop={isDesktop}
            />
          </ScopedErrorBoundary>
        </ServiceProvider>
      </div>
    </ProjectDirectoryProvider>
  );
}