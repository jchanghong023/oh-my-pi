import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import {
  ChevronDownIcon,
  FolderPlus,
  MessageCircle,
  Plus,
  SearchIcon,
  X,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { useNativeHostAvailable } from "@/hooks/useBackendBusinessAvailability.js";
import { getPathLeaf } from "@/lib/path.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import {
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
} from "@zcode/shared/test-ids";

import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import { projectKey } from "@/project-sidebar/view.js";
import { useProjectSelectionDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export function ProjectComposerMenu({
  workspacePath,
  workspaceIdentity,
  compactForRemoteControl = false,
  allowConversationWorkspaceSelection = true,
  allowConversationWorkspaceDetach = allowConversationWorkspaceSelection,
  onCreateTask,
  onSelectConversationWorkspace,
  onOpenProject,
  containerClassName,
  triggerClassName,
  triggerIndicator,
  showEditProject = false,
  children,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  compactForRemoteControl?: boolean;
  allowConversationWorkspaceSelection?: boolean;
  /** 是否显示项目 chip 的快捷脱离按钮；默认跟随非项目工作区选择能力。 */
  allowConversationWorkspaceDetach?: boolean;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  onSelectConversationWorkspace: () => void | Promise<void>;
  onOpenProject?: () => void;
  /** 调用方局部调整 workspace chip 外层视觉，不改变普通会话默认样式。 */
  containerClassName?: string;
  /** 调用方局部调整 workspace trigger 视觉，不改变普通会话默认样式。 */
  triggerClassName?: string;
  /** 调用方局部替换尾部 indicator；普通会话继续使用默认 Lucide chevron。 */
  triggerIndicator?: ReactNode;
  /** 聊天头部启用当前项目编辑，其他项目选择器保持原有入口。 */
  showEditProject?: boolean;
  /** 分支等控件位于项目选择器与编辑按钮之间。 */
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const nativeHostAvailable = useNativeHostAvailable();
  const platform = usePlatform();
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const {
    allProjects,
    projects,
    availability,
    directory,
    error,
    service,
    remoteService,
    refresh,
  } = useProjectSelectionDirectory();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const projectId = useZCodeSessionStore((state) => state.workspaces[workspaceKey]?.draftProjectId);
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId,
  );
  const createProjectTask: ProjectSidebarProps["onCreateTask"] = (request) =>
    onCreateTask(
      typeof request === "object"
        ? {
            ...request,
            // 远程目录确认曾遗漏草稿分组；两个项目入口必须从同一草稿 owner 读取组织意图。
            taskGroupId: !activeTaskId
              ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftTaskGroupId
              : null,
          }
        : request,
    );
  const draftVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  // 草稿重建和聊天切换都会使旧返回意图失效，即使后来又回到同一路径也不能复活旧操作。
  const chatKey = JSON.stringify([workspaceKey, activeTaskId, projectId, draftVersion]);
  const currentChat = useRef({ key: chatKey });
  if (currentChat.current.key !== chatKey) currentChat.current = { key: chatKey };
  const chat = currentChat.current;
  const [creating, setCreating] = useState(false);
  const [editingChat, setEditingChat] = useState<typeof chat | null>(null);
  // 原因：目录可以属于多个项目，tab/cwd 不能决定归属；只读草稿的项目身份。
  const currentProject = projects.find(
    (project) => nativeHostAvailable
      ? project.roots.some((root) => root.rootPath === workspacePath)
      : project.id === projectId,
  );
  const canEditProject =
    showEditProject &&
    !nativeHostAvailable &&
    currentProject &&
    !currentProject.legacySingleRoot &&
    (availability.get(projectKey(currentProject))?.online ?? true) &&
    Boolean(service);
  const isConversationWorkspace = !currentProject;
  const canDetachProject =
    allowConversationWorkspaceSelection &&
    !nativeHostAvailable &&
    allowConversationWorkspaceDetach &&
    !isConversationWorkspace;
  const visibleProjects = useMemo(() => {
    const query = workspaceSearchQuery.trim().toLowerCase();
    return projects.filter((project) =>
      [
        project.name,
        ...project.roots.map((root) => root.rootPath),
      ].some((text) => text.toLowerCase().includes(query)),
    );
  }, [projects, workspaceSearchQuery]);
  const currentWorkspaceTitle =
    currentProject?.name ?? (nativeHostAvailable ? getPathLeaf(workspacePath) || workspacePath
      : intl.formatMessage({ id: "chat.empty.selectProject" }));
  const currentWorkspaceIconClassName = cn(
    "size-4 text-foreground-subtle transition-opacity",
    // Bugfix: 关闭按钮和项目图标占用同一位置。只有允许脱离项目时才隐藏底层图标，
    // 否则 X 会直接叠在图标上；定时任务禁用该能力时则让项目图标保持可见。
    canDetachProject &&
      "group-hover/workspace-chip:opacity-0 group-focus-within/workspace-chip:opacity-0",
  );

  const menu = (
    <DropdownMenu>
      <div
        className={cn(
          "group/workspace-chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover",
          containerClassName,
        )}
      >
        {canDetachProject ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-none absolute left-1.5 z-10 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/workspace-chip:pointer-events-auto group-hover/workspace-chip:opacity-100 group-focus-within/workspace-chip:pointer-events-auto group-focus-within/workspace-chip:opacity-100"
            aria-label={intl.formatMessage({ id: "chat.empty.detachProject" })}
            data-testid={TID_COMPOSER_PROJECT_DETACH}
            onClick={(event) => {
              event.stopPropagation();
              void Promise.resolve(onSelectConversationWorkspace());
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className={cn(
              "min-w-0 rounded-full bg-transparent text-ui-base/relaxed hover:bg-transparent",
              // Bugfix: 远程控制页面空态文案区域更窄，workspacePath 过长会把同一行挤坏。
              // 这里在远控模式收紧菜单触发按钮宽度，让超长路径在按钮内走省略号。
              compactForRemoteControl ? "max-w-44 pl-3 pr-2" : "max-w-[15rem] pl-3 pr-2",
              triggerClassName,
            )}
            aria-label={intl.formatMessage({ id: "chat.empty.workspaceMenu" })}
            data-testid={TID_COMPOSER_WORKSPACE_TRIGGER}
          >
              <ProjectFolderIcon
                rootCount={currentProject?.roots.length ?? 0}
                className={currentWorkspaceIconClassName}
              />
            <span className="block max-w-full truncate">{currentWorkspaceTitle}</span>
            {triggerIndicator ?? <ChevronDownIcon className="size-3.5 text-foreground-subtle" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        data-testid="composer-project-menu"
        align="start"
        side="top"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div
          data-slot="command-input-wrapper"
          className="shrink-0 p-1 border-b border-border"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover ">
            <input
              data-slot="command-input"
              value={workspaceSearchQuery}
              placeholder={intl.formatMessage({
                id: "chat.empty.workspaceSearchPlaceholder",
              })}
              onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex min-h-0 flex-col p-1">
          {error ? (
            <div role="alert" className="px-2 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          <div className="min-h-0 max-h-60 overflow-y-auto">
            {visibleProjects.map((project) => {
              const state = availability.get(projectKey(project));
              const disabled = state?.online === false;
              return (
                  <span key={projectKey(project)} className="block min-w-0">
                    <DropdownMenuCheckboxItem
                      data-project-id={project.id}
                      data-project-host={project.hostId}
                      data-project-name={project.name}
                      checked={currentProject === project}
                      disabled={disabled}
                      onSelect={() => {
                        if (nativeHostAvailable) {
                          const root = project.roots.find((item) => item.isPrimary) ?? project.roots[0];
                          if (!root) {
                            toast("The selected native project has no root directory.");
                            return;
                          }
                          void platform.activateOrSetWorkspace(root.rootPath).catch((cause) => {
                            toast(cause instanceof Error ? cause.message : String(cause));
                          });
                          return;
                        }
                        logger.info("[ProjectComposerMenu] 选择项目", {
                          projectId: project.id,
                          hostId: project.hostId,
                        });
                        createProjectTask({ projectId: project.id });
                      }}
                    >
                        <ProjectFolderIcon
                          rootCount={project.roots.length}
                          className="size-4 text-foreground-subtle"
                        />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  </span>
              );
            })}
            {visibleProjects.length === 0 && !error ? (
              <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.empty.workspaceSearchEmpty" })}
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <DropdownMenuSeparator />
            {/* 项目创建依赖共享服务，不能受本机原生打开文件夹的能力开关限制。 */}
            <DropdownMenuItem
              data-testid="composer-create-project"
              disabled={nativeHostAvailable ? !onOpenProject : !service || !remoteService}
              onSelect={() => nativeHostAvailable ? onOpenProject?.() : setCreating(true)}
            >
              <FolderPlus className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "project.create" })}</span>
            </DropdownMenuItem>
            {allowConversationWorkspaceSelection && !nativeHostAvailable ? (
              <DropdownMenuCheckboxItem
                data-testid={TID_COMPOSER_WORK_OUTSIDE_PROJECT}
                checked={isConversationWorkspace}
                onSelect={() =>
                  void Promise.resolve(onSelectConversationWorkspace())
                }
              >
                <MessageCircle className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.workOutsideProject" })}</span>
              </DropdownMenuCheckboxItem>
            ) : null}
          </div>
        </div>
      </DropdownMenuContent>
      {creating && service && remoteService ? (
        <ProjectCreation
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          onCreateTask={createProjectTask}
          projects={allProjects}
          directory={directory}
          service={service}
          remoteService={remoteService}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      ) : null}
    </DropdownMenu>
  );
  return (
    <>
      {menu}
      {children}
      {canEditProject ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "project.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-foreground-subtle"
            aria-label={intl.formatMessage({ id: "project.edit" })}
            data-testid="composer-edit-project"
            onClick={() => setEditingChat(chat)}
          >
            <Plus className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {/* 项目身份沿用菜单；聊天切换使旧编辑器失效，避免同 cwd 的项目被误编辑。 */}
      {editingChat === chat && canEditProject && currentProject && service ? (
        <ProjectEditor
          key={projectKey(currentProject)}
          project={currentProject}
          projects={allProjects.filter(
            (project) => !availability.get(projectKey(project))?.entryId,
          )}
          service={service}
          onClose={() => setEditingChat(null)}
          onSaved={refresh}
          onDeleted={refresh}
        />
      ) : null}
    </>
  );
}
