import { useDev } from "@/dev/DevContext.js";
import type {
  ZCodeProvider,
  ZCodeTaskMeta,
  ZCodeTaskChangeSummary,
  EditorInfo,
  GitRepositorySummary,
  UserInfo,
} from "@zcode/shared";
import { useState } from "react";
import { TID_WORKSPACE_HEADER } from "@zcode/shared/test-ids";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { cn } from "@/components/lib/utils.js";
import {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderState,
  WorkspaceHeaderTitleSection,
} from "@/WorkspaceHeaderSections.js";
import type { WorkspaceHeaderVariant } from "@/WorkspaceHeaderSections/shared.js";

/**
 * 侧栏收起时左上角浮层（侧栏开关、前进后退、新建）盖在内容区顶栏上，顶栏需要让出的左侧留白。
 * WorkspaceHeader 与 Side Pane 完整视图的 tab 栏共用这一规则。
 */
export function resolveTopOverlayLeadingPaddingClass({
  isSidebarVisible,
}: {
  isSidebarVisible: boolean;
}): string | false {
  return !isSidebarVisible && "pl-38";
}

export function WorkspaceHeader({
  variant = "task",
  backendBusinessAvailable = true,

  draftDropTargetController,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary,
  activeTaskId,
  user,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  sessionLogPath,
  nativeSessionLogProvider,
  nativeSessionLogPath,
  nativeSessionLogExists,
  nativeSessionLogLoading,
  providerWorkspaceConfigPath,
  providerWorkspaceConfigExists,
  providerWorkspaceConfigLoading,
  workspaceHeaderState,
  gitSummary,
  gitDirtyFileCount,
  simplifyForNarrowViewport = false,
  isSidebarVisible,
  isSidePaneOpen,
  onRefreshGit,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onReloadSession,
  reloadSessionDisabled,
  reloadSessionPending,
}: {
  variant?: WorkspaceHeaderVariant;
  backendBusinessAvailable?: boolean;
  draftDropTargetController?: ConversationDropTargetController | null;
  readOnlyReason?: string;
  workspaceAbsPath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  projectName: string;
  activeTaskTitle: string;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  activeTaskId: string | null;
  user?: UserInfo | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  sessionLogPath: string | null;
  nativeSessionLogProvider: ZCodeProvider | null;
  nativeSessionLogPath: string | null;
  nativeSessionLogExists: boolean;
  nativeSessionLogLoading: boolean;
  providerWorkspaceConfigPath: string | null;
  providerWorkspaceConfigExists: boolean;
  providerWorkspaceConfigLoading: boolean;
  workspaceHeaderState: WorkspaceHeaderState;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  simplifyForNarrowViewport?: boolean;
  isSidebarVisible: boolean;
  isSidePaneOpen: boolean;
  onRefreshGit: () => void;
  onToggleSidePane: () => void;
  toggleSidePaneShortcutLabel?: string;
  onReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => void | Promise<void>;
  reloadSessionDisabled?: boolean;
  reloadSessionPending?: boolean;
  onCreateTask: () => void;
  onOpenWorkspace: () => void;
  allowOpenWorkspace?: boolean;
}) {
  const dev = useDev();
  // 需求总览、入库或只读时可能没有活动会话，标题仍统一放在原生头部。
  const devRequirement = Boolean(!dev?.selection.freeSessionId && [...(dev?.view?.drafts ?? []), ...(dev?.view?.groups ?? [])].some(item => item.id === dev?.selection.irId && item.projectId === dev?.selection.projectId));
  const [selectedEditor, setSelectedEditor] = useState<EditorInfo | null>(null);
  const headerLeadingPaddingClass = resolveTopOverlayLeadingPaddingClass({
    isSidebarVisible,
  });

  return (
    <header
      data-testid={TID_WORKSPACE_HEADER}
      data-workspace-header-variant={variant}
      className={cn(
        "@container/workspace-header relative flex w-full shrink-0 h-12 border-b",
        variant === "draft" ? "border-transparent" : "border-border/50",
      )}
    >
      {variant === "draft" && draftDropTargetController?.active ? (
        <div
          className="absolute inset-0 z-40 bg-accent/55 backdrop-blur-sm pointer-events-auto"
          data-testid="new-task-draft-drop-mask"
          onDragOver={draftDropTargetController.onDragOver}
          onDragLeave={draftDropTargetController.onDragLeave}
          onDrop={draftDropTargetController.onDrop}
        />
      ) : null}
      <div
        className={cn(
          "flex h-12 flex-1 min-w-0 items-center justify-between gap-2 overflow-hidden p-2 transition-[padding] duration-300",
          headerLeadingPaddingClass,
        )}
      >
        {variant === "task" || devRequirement ? (
          <WorkspaceHeaderTitleSection
            variant={devRequirement ? "task" : variant}
            backendBusinessAvailable={backendBusinessAvailable}
            readOnlyReason={readOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            remoteSessionId={remoteSessionId}
            workspaceIdentity={workspaceIdentity}
            projectName={projectName}
            activeTaskTitle={activeTaskTitle}
            activeTaskChangeSummary={activeTaskChangeSummary}
            activeTaskId={activeTaskId}
            activeTraceId={activeTraceId}
            activeSessionId={activeSessionId}
            activeTaskProvider={activeTaskProvider}
            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
            gitSummary={gitSummary}
            gitDirtyFileCount={gitDirtyFileCount}
            sessionLogPath={sessionLogPath}
            nativeSessionLogProvider={nativeSessionLogProvider}
            nativeSessionLogPath={nativeSessionLogPath}
            nativeSessionLogExists={nativeSessionLogExists}
            nativeSessionLogLoading={nativeSessionLogLoading}
            providerWorkspaceConfigPath={providerWorkspaceConfigPath}
            providerWorkspaceConfigExists={providerWorkspaceConfigExists}
            providerWorkspaceConfigLoading={providerWorkspaceConfigLoading}
            workspaceHeaderState={workspaceHeaderState}
            simplifyForNarrowViewport={simplifyForNarrowViewport}
            selectedEditor={selectedEditor}
            onReloadSession={onReloadSession}
            reloadSessionDisabled={reloadSessionDisabled}
            reloadSessionPending={reloadSessionPending}
            onRefreshGit={onRefreshGit}
          />
        ) : (
          <div className="min-w-0 flex-1" aria-hidden="true" />
        )}
        <WorkspaceHeaderActionSection
          variant={variant}
          activeTaskId={activeTaskId}
          user={user}
          readOnlyReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          simplifyForNarrowViewport={simplifyForNarrowViewport}
          hideHelpMenu={false}
          onSelectedEditorChange={setSelectedEditor}
        />
      </div>
    </header>
  );
}
