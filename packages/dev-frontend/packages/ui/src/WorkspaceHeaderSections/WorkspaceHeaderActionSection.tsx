import { useDev } from "@/dev/DevContext.js";
import { DevCollabProjection } from "@/dev/DevCollabProjection.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
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
  const dev = useDev();
  const proposal = Boolean(!dev?.selection.srId && dev?.view?.drafts.some(item => item.id === dev.selection.irId));
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
      {proposal ? <DevCollabProjection iconOnly /> : null}
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
