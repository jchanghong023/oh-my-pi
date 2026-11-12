import { useAIReq } from "@/aireq/AIReqContext.js";
import { AIReqRequirementMenu } from "@/aireq/AIReqRequirementMenu.js";
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
  const aireq = useAIReq();
  const formal = !aireq?.selection.freeSessionId ? aireq?.view?.groups.find(item => item.id === aireq.selection.irId && item.projectId === aireq.selection.projectId) : undefined;
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
      {formal ? <AIReqRequirementMenu key={`${formal.projectId}:${formal.id}:${aireq?.selection.srId ?? "ir"}`} group={formal} /> : null}
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
