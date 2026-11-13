import type { ReactNode } from "react";
import { useState } from "react";
import { ListChevronsDownUp, ListChevronsUpDown, Plus } from "lucide-react";
import { SortableProjects } from "@/project-sidebar/SortableProjects.js";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";
import {
  persistSidebarPurposeSectionPreferences,
  readSidebarPurposeSectionPreferences,
} from "@/lib/sidebarPurposeSectionPreferences.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 项目树是唯一的组织视图；会话只在所属项目内展开，不再单独列出无项目归属的任务。 */
export function ProjectSections({
  projects,
  renderProject,
  onAddProject,
  hasExpandedProjects,
  canToggleProjects,
  onToggleProjects,
  onReorder,
}: {
  projects: VirtualProject[];
  renderProject(project: VirtualProject): ReactNode;
  onAddProject(): void;
  hasExpandedProjects: boolean;
  canToggleProjects: boolean;
  onToggleProjects(): void;
  onReorder(active: string, over: string): void;
}) {
  const { intl } = useZCodeIntl();
  const [preferences, setPreferences] = useState(readSidebarPurposeSectionPreferences);
  const setExpanded = (projectsExpanded: boolean) => {
    const next = { ...preferences, projectsExpanded };
    setPreferences(next);
    persistSidebarPurposeSectionPreferences(next);
  };
  return (
    <div className="grid grid-cols-1 gap-3" data-purpose-section-list="true">
      <WorkspacePurposeSection
        title={intl.formatMessage({ id: "project.projects" })}
        testId="project-section"
        open={preferences.projectsExpanded}
        onOpenChange={setExpanded}
        action={
          <>
            <ControlHintTooltip
              title={intl.formatMessage({
                id: hasExpandedProjects ? "project.collapseAll" : "project.expandAll",
              })}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-foreground-subtle hover:text-foreground"
                data-testid="virtual-project-toggle-all"
                aria-label={intl.formatMessage({
                  id: hasExpandedProjects ? "project.collapseAll" : "project.expandAll",
                })}
                disabled={!canToggleProjects}
                onClick={onToggleProjects}
              >
                {hasExpandedProjects ? (
                  <ListChevronsDownUp className="size-3.5" />
                ) : (
                  <ListChevronsUpDown className="size-3.5" />
                )}
              </Button>
            </ControlHintTooltip>
            <ControlHintTooltip title={intl.formatMessage({ id: "project.new" })}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-foreground-subtle hover:text-foreground"
                data-testid="virtual-project-add"
                aria-label={intl.formatMessage({ id: "project.new" })}
                onClick={onAddProject}
              >
                <Plus className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          </>
        }
      >
        <SortableProjects
          projects={projects.filter((project) => !project.pinned)}
          renderProject={renderProject}
          onReorder={onReorder}
        />
      </WorkspacePurposeSection>
    </div>
  );
}