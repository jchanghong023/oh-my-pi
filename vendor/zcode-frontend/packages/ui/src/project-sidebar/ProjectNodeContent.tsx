import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { memo } from "react";
import type { useSortable } from "@dnd-kit/sortable";
import {
  Ellipsis,
  Folders,
  ListTree,
  Pin,
  PinOff,
  Pencil,
  Trash2,
  MessageCirclePlus,
} from "lucide-react";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import type {
  ProjectTask,
  VirtualProject,
  ProjectSidebarProps,
  ProjectAvailability,
  ProjectRowAction,
} from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 修复原因：memo 内容的内联默认对象/数组会在每次渲染时新建引用，触发引用稳定性门禁。
const DEFAULT_AVAILABILITY: ProjectAvailability = { online: true };
const EMPTY_ADDITIONAL_ACTIONS: ProjectRowAction[] = [];

export type ProjectNodeProps = {
  project: VirtualProject;
  expanded: boolean;
  onExpandedChange(value: boolean): void;
  tasks: ProjectTask[];
  hasUnread?: boolean;
  additionalActions?: ProjectRowAction[];
  onCreate(): void;
  onViewFiles?(rootPath: string): void;
  onEdit(): void;
  onDelete(): void;
  onPin(): void;
  onMove(task: { workspacePath: string; workspaceIdentity?: string; taskId: string }): void;
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  availability?: ProjectAvailability;
  /** Open local project management in settings. */
  onManageProjects?(): void;
};

// 原因：useSortable 的激活/测量/落点更新曾让 41 个项目的菜单和 Tooltip 连续重渲染。
// 外壳只把稳定的激活器属性传入 memo 内容，位移和蓝线变化不穿透到整棵内容树。
export const ProjectNodeContent = memo(function ProjectNodeContent({
  project,
  tasks,
  hasUnread = false,
  onCreate,
  onViewFiles,
  onEdit,
  onDelete,
  onPin,
  onSelect,
  refresh,
  availability = DEFAULT_AVAILABILITY,
  onManageProjects,
  additionalActions = EMPTY_ADDITIONAL_ACTIONS,
  editable,
  isOpen,
  attributes,
  listeners,
  setActivatorNodeRef,
  dragEnabled,
}: ProjectNodeProps &
  Pick<ReturnType<typeof useSortable>, "attributes" | "listeners" | "setActivatorNodeRef"> & {
    dragEnabled: boolean;
    editable: boolean;
    canOpen: boolean;
    isOpen: boolean;
  }) {
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const primaryRootDisabledReason =
    project.primaryRootStatus === "missing"
      ? msg("primaryRootMissing")
      : project.primaryRootStatus === "unavailable"
        ? msg("primaryRootUnavailable")
        : undefined;
  const showFiles = intl.formatMessage({ id: "workspaceSidebar.showFileTree" });
  const more = intl.formatMessage({ id: "common.more" });
  // 原因：右键是快捷入口的补充；与更多菜单共用操作定义，避免再次删掉 hover 功能。
  const management: ProjectRowAction[] = [
    ...additionalActions,
    ...(editable
      ? [
          { id: "edit", label: msg("edit"), icon: Pencil, run: onEdit },
          {
            id: "pin",
            label: project.pinned ? msg("unpin") : msg("pin"),
            icon: project.pinned ? PinOff : Pin,
            run: onPin,
          },
          { id: "delete", label: msg("delete"), icon: Trash2, run: onDelete, destructive: true },
        ]
      : []),
    ...(onManageProjects
      ? [
          {
            id: "manage-projects",
            label: intl.formatMessage({ id: "projectManagement.manage" }),
            icon: Folders,
            run: onManageProjects,
            separatorBefore: true,
          },
        ]
      : []),
  ];
  const files: ProjectRowAction[] = project.roots.map((root, index) => ({
    id: `files-${index}`,
    label: project.roots.length > 1 ? `${showFiles} · ${root.rootPath}` : showFiles,
    icon: ListTree,
    run: () => onViewFiles?.(root.rootPath),
    disabled: Boolean(primaryRootDisabledReason) || !onViewFiles,
  }));
  const contextActions = [
    ...(availability.online
      ? [
          {
            id: "create-task",
            label: msg("createTask"),
            icon: MessageCirclePlus,
            run: onCreate,
            disabled: Boolean(primaryRootDisabledReason),
          },
          ...files,
        ]
      : []),
    ...management,
  ];
  return (
    <>
      <ContextMenu modal={false}>
          <ContextMenuTrigger asChild>
            <div
              data-testid="virtual-project-row"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  event.currentTarget.dispatchEvent(
                    new MouseEvent("contextmenu", {
                      bubbles: true,
                      clientX: rect.left + 24,
                      clientY: rect.bottom,
                    }),
                  );
                }
              }}
              className="group/project-row ml-2 flex h-8 min-w-0 items-center gap-1 rounded-lg pr-1 hover:bg-surface-hover"
            >
              {/* 标题仍可展开历史；失效提示仅绑定禁用的操作按钮，避免悬停整行也弹出。 */}
              <span className="flex min-w-0 flex-1 shrink-0">
                <CollapsibleTrigger asChild>
                  <Button
                    ref={setActivatorNodeRef}
                    {...(dragEnabled ? attributes : {})}
                    {...(dragEnabled ? listeners : {})}
                    variant="ghost"
                    className={cn(
                      dragEnabled ? "touch-none" : "touch-pan-y",
                      "flex h-8 min-w-0 flex-1 justify-start gap-2 rounded-lg pl-2.5 pr-1 text-left text-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground",
                      primaryRootDisabledReason && "opacity-50",
                    )}
                    data-testid="virtual-project-toggle"
                    // dnd-kit 的 attributes 按可排序性给出 aria-disabled，不能覆盖标题本身的不可用状态。
                    aria-disabled={false}
                  >
                    {/* 置顶提示复用左侧固定槽位；仅悬停时替换图标，避免名称右侧常驻钉子占位。 */}
                    <span
                      className="flex size-4 shrink-0 items-center justify-center"
                      aria-hidden="true"
                    >
                      <span
                        className={cn(
                          "inline-flex",
                          project.pinned && "group-hover/project-row:hidden",
                        )}
                      >
                          <ProjectFolderIcon
                            rootCount={project.roots.length}
                            open={isOpen}
                            className="size-4 shrink-0 text-foreground-subtle"
                          />
                      </span>
                      {project.pinned ? (
                        <Pin className="hidden size-4 text-foreground-subtle group-hover/project-row:block" />
                      ) : null}
                    </span>
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-ui-base text-foreground-subtle">
                        {project.name}
                      </span>
                    </span>
                    {!isOpen && availability.online && hasUnread ? (
                      <span
                        data-testid="virtual-project-unread"
                        data-workspace-unread-indicator="true"
                        role="img"
                        aria-label={intl.formatMessage({ id: "project.hasUnread" })}
                        className="size-1.5 shrink-0 rounded-full bg-icon-blue"
                      />
                    ) : null}
                  </Button>
                </CollapsibleTrigger>
              </span>
              <div
                data-testid="virtual-project-actions"
                className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 [&:has([data-state=open])]:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <DropdownMenu modal={false}>
                  <ControlHintTooltip title={more}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        data-testid="virtual-project-menu"
                        variant="ghost"
                        size="icon-sm"
                        disabled={!management.length}
                        aria-label={more}
                        className="text-foreground-subtle hover:text-foreground"
                      >
                        <Ellipsis className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </ControlHintTooltip>
                  <DropdownMenuContent align="end">
                    <ProjectMenuItems actions={management} />
                  </DropdownMenuContent>
                </DropdownMenu>
                {availability.online ? (
                  <>
                    {/* 主目录失效时多 root 也复用禁用按钮，避免菜单仍能打开附加目录。 */}
                    {files.length > 1 && !primaryRootDisabledReason ? (
                      <DropdownMenu modal={false}>
                        <ControlHintTooltip title={showFiles}>
                          <DropdownMenuTrigger asChild>
                            <Button
                              data-testid="virtual-project-files"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={showFiles}
                              className="text-foreground-subtle hover:text-foreground"
                            >
                              <ListTree className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                        </ControlHintTooltip>
                        <DropdownMenuContent align="end">
                          <ProjectMenuItems actions={files} />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <TaskRowActionButton
                        testId="virtual-project-files"
                        label={showFiles}
                        showTooltip
                        disabledReason={
                          primaryRootDisabledReason ??
                          (!files.length || !onViewFiles ? msg("noFolders") : undefined)
                        }
                        className="text-foreground-subtle hover:text-foreground"
                        onClick={() => files[0]?.run()}
                      >
                        <ListTree className="size-3.5" />
                      </TaskRowActionButton>
                    )}
                    <TaskRowActionButton
                      testId="virtual-project-create-task"
                      label={msg("createTask")}
                      showTooltip
                      disabledReason={primaryRootDisabledReason}
                      className="text-foreground-subtle hover:text-foreground"
                      onClick={onCreate}
                    >
                      <MessageCirclePlus className="size-3.5" />
                    </TaskRowActionButton>
                  </>
                ) : null}
              </div>
            </div>
          </ContextMenuTrigger>
        {/* 非模态菜单只负责导航，避免退出动画与编辑弹窗交错后残留指针锁。 */}
        <ContextMenuContent>
          <ProjectMenuItems actions={contextActions} context />
        </ContextMenuContent>
      </ContextMenu>
      {/* 直接条件卸载曾跳过收起动画；复用旧侧栏的受控高度/透明度生命周期。 */}
      <CollapsibleContent data-testid="virtual-project-tasks">
        {/* 原因：旧任务文字的 34px 缩进外只需 8px 留白，空态与项目名称保持对齐。 */}
        <div className="pl-2 pt-1">
          <ProjectTaskRows tasks={tasks} onSelect={onSelect} refresh={refresh} />
        </div>
      </CollapsibleContent>
    </>
  );
});

function ProjectMenuItems({
  actions,
  context = false,
}: {
  actions: ProjectRowAction[];
  context?: boolean;
}) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return actions.map((action, index) => [
    action.separatorBefore && index > 0 ? <Separator key={`${action.id}-separator`} /> : null,
    <Item
      key={action.id}
      disabled={action.disabled}
      data-testid={`virtual-project-${context && (action.id.startsWith("files-") || action.id === "create-task") ? "context-" : ""}${action.id}`}
      className={action.destructive ? "text-destructive" : undefined}
      onSelect={action.run}
    >
      {action.icon ? <action.icon className="size-4 shrink-0" aria-hidden="true" /> : null}
      {action.label}
    </Item>,
  ]);
}
