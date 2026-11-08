import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  activeTaskId,
  user,
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  isSidePaneOpen,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onSelectedEditorChange,
  simplifyForNarrowViewport = false,
  hideHelpMenu = false,
}: WorkspaceHeaderActionSectionProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {variant === "task" ? (
        <WorkspaceEditorButtonGroup
          disabledReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          onSelectedEditorChange={onSelectedEditorChange}
        />
      ) : null}
      {/* 分享发布接口依赖登录态；未登录时隐藏入口，避免用户打开后只能得到鉴权失败。 */}
      {activeTaskId && user ? <ConversationShareMenu taskId={activeTaskId} /> : null}
      {!simplifyForNarrowViewport && !hideHelpMenu ? <WorkspaceHelpMenuButton /> : null}
      {!isSidePaneOpen ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
        />
      ) : null}
    </div>
  );
}
