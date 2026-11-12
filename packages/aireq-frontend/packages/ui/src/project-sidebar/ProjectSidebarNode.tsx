import { memo } from "react";
import { shallow } from "zustand/shallow";
import type {
  IProjectService,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

export function runProjectAction(body: () => Promise<void>) {
  void body().catch((cause) => {
    logger.error("[project-sidebar] 操作失败", cause);
    toast(String(cause));
  });
}

type Props = Pick<
  ProjectNodeProps,
  | "project"
  | "expanded"
  | "hasUnread"
  | "availability"
  | "tasks"
  | "onSelect"
  | "refresh"
> &
  Pick<ProjectSidebarProps, "isDesktop" | "isWebRemoteControl" | "onCreateTask"> & {
    service?: IProjectService;
    onExpandedChange(project: VirtualProject, expanded: boolean): void;
    onEdit(value: { project: VirtualProject }): void;
    onViewFiles(project: VirtualProject, rootPath: string): Promise<void>;
  };

// Bug 根因：任务活动每秒更新目录，父组件随之重建所有项目的菜单与回调，穿透内容层 memo。
// 按项目隔离装配；数组只比较元素与顺序，其余属性完整比较，真实状态和回调变化仍需更新。
export const ProjectSidebarNode = memo(
  function ProjectSidebarNode({
    project,
    service,
    isDesktop,
    isWebRemoteControl,
    onCreateTask,
    onExpandedChange,
    onEdit,
    onViewFiles,
    ...display
  }: Props) {
    const { intl } = useZCodeIntl();
    const confirm = useConfirmDialog();
    const tabStore = useTabStoreApi();
    const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
    const { refresh } = display;
    return (
      <ProjectNode
        {...display}
        project={project}
        onManageProjects={
          isDesktop
            ? () => {
                setPendingSettingsSectionIntent("projects");
                tabStore.getState().openSettingsTab();
              }
            : undefined
        }
        onExpandedChange={(expanded) => onExpandedChange(project, expanded)}
        onCreate={() =>
          runProjectAction(async () => {
            onCreateTask({
              projectId: project.id,
              taskGroupId: null,
              ...(isWebRemoteControl ? { hostId: project.hostId } : {}),
            });
          })
        }
        onEdit={() => onEdit({ project })}
        onViewFiles={(rootPath) => runProjectAction(() => onViewFiles(project, rootPath))}
        onDelete={() =>
          runProjectAction(async () => {
            await service!.deleteProject(project.id, project.hostId);
            await refresh();
          })
        }
        onPin={() =>
          runProjectAction(async () => {
            await service!.saveProject({
              id: project.id,
              hostId: project.hostId,
              pinned: !project.pinned,
            });
            await refresh();
          })
        }
        onMove={(task) =>
          runProjectAction(async () => {
            if (!service) return;
            try {
              await service.moveTask({ task, projectId: project.id, hostId: project.hostId });
            } catch (cause) {
              if (
                project.hostId !== "local" ||
                !String(cause).includes("project.root-confirmation-required")
              )
                throw cause;
              if (!(await confirm({ title: msg("addFolder"), description: task.workspacePath })))
                return;
              await service.moveTask({
                task,
                projectId: project.id,
                hostId: project.hostId,
                addMissingRoot: true,
              });
            }
            await refresh();
          })
        }
      />
    );
  },
  (previous, next) => {
    const { tasks: previousTasks, ...previousProps } = previous;
    const { tasks: nextTasks, ...nextProps } = next;
    return shallow(previousProps, nextProps) && shallow(previousTasks, nextTasks);
  },
);
