import { formatProjectError } from "@/project-sidebar/view.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useEffect, useRef, useState } from "react";
import {
  Folder,
  FolderPlus,
  X,
} from "lucide-react";
import type {
  IProjectService,
  VirtualProject,
  RemoteProjectHost,
  ProjectDevice,
  IRemoteProjectService,
} from "@/project-sidebar/contract.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useProjectDirectoryServices } from "@/project-sidebar/useProjectDirectoryServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import {
  ProjectFolderTrustDialog,
  type ProjectFolderTrustRequest,
} from "@/project-sidebar/ProjectFolderTrustDialog.js";

const FIELD_LABEL = "text-ui-sm font-medium text-foreground";

export function ProjectEditor({
  project,
  host,
  initialRoots = [],
  isCurrent = () => true,
  projects,
  service,
  onClose,
  onSaved,
  onDeleted,
  suspended = false,
  devices,
  defaultDeviceId,
  fixedFolder,
  onBeforeSave,
}: {
  project: VirtualProject | null;
  host?: RemoteProjectHost;
  devices?: ProjectDevice[];
  defaultDeviceId?: string;
  /** 聊天已确认的远程目录；表单不能改成另一个 Host 或 root。 */
  fixedFolder?: { hostId: string; path: string; deviceLabel: string };
  onBeforeSave?(hostId: string): Promise<void>;
  remoteService?: IRemoteProjectService;
  onSavedExisting?(isCurrent?: () => boolean): Promise<void>;
  onBrowseExisting?(device: ProjectDevice): Promise<boolean>;
  onPrepareExisting?(hostId: string, isCurrent: () => boolean): Promise<RemoteProjectHost>;
  onConnectDevice?(device: ProjectDevice): Promise<boolean>;
  onAddDevice?(selectDevice: (id: string) => Promise<void>): void;
  initialRoots?: string[];
  suspended?: boolean;
  isCurrent?(): boolean;
  projects: VirtualProject[];
  service: IProjectService;
  onClose(): void;
  onSaved(project: VirtualProject): Promise<void>;
  onDeleted?(): Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const sidebar = useOptionalProjectDirectory();
  const platform = useOptionalPlatform();
  const [selectedDeviceId] = useState(defaultDeviceId ?? "local");
  const hostId =
    project?.hostId ?? fixedFolder?.hostId ?? host?.id ?? (devices ? selectedDeviceId : undefined);
  const remote = Boolean(hostId && hostId !== "local");
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const [name, setName] = useState(
    project?.name ?? (fixedFolder ? getPathLeaf(fixedFolder.path) : ""),
  );
  const [nameEdited, setNameEdited] = useState(false);
  const [roots, setRoots] = useState(
    project?.roots.map((root) => root.rootPath) ??
      (fixedFolder ? [fixedFolder.path] : initialRoots),
  );
  const [primary, setPrimary] = useState(
    project?.roots.find((root) => root.isPrimary)?.rootPath ??
      fixedFolder?.path ??
      initialRoots[0] ??
      "",
  );
  const [legacyDeviceId, setLegacyDeviceId] = useState<string | null>(null);
  const directory = useProjectDirectoryServices(service, hostId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<VirtualProject | null>(null);
  const [folderTrust, setFolderTrust] = useState<ProjectFolderTrustRequest | null>(null);
  const saveFlight = useRef<{ cancelTrust?: () => void } | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const confirm = useConfirmDialog();
  const epoch = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      saveFlight.current?.cancelTrust?.();
    };
  }, []);
  useEffect(() => {
    // 父表单切到后台后，连同尚未完成的恢复查询一起失效，避免返回前台后旧查询重新弹出确认。
    if (suspended && saveFlight.current) {
      epoch.current++;
      saveFlight.current.cancelTrust?.();
    }
  }, [suspended]);
  const current = (request: number) => alive.current && epoch.current === request;
  const selectedDevice = devices?.find((device) => device.id === selectedDeviceId);
  const addRoots = (values: string[]) => {
    if (remote && project) return;
    const next = remote
      ? values.filter(Boolean).slice(0, 1)
      : [...new Set([...roots, ...values.filter(Boolean)])];
    setRoots(next);
    if (remote || !roots.length) setPrimary(next[0] ?? "");
  };
  const browse = async () => {
    const request = ++epoch.current;
    if (!platform?.selectDirectories) {
      setError(intl.formatMessage({ id: "project.directoryPickerUnavailable" }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const selected = await platform.selectDirectories();
      logger.debug("[ProjectEditor] native directory selection", { count: selected.length });
      if (current(request) && selected.length) addRoots(selected);
    } catch (cause) {
      logger.warn("[ProjectEditor] native directory selection failed", cause);
      if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (current(request)) setBusy(false);
    }
  };
  const save = async () => {
    if (saveFlight.current || suspendedRef.current || !isCurrent()) return;
    const flight: { cancelTrust?: () => void } = {};
    saveFlight.current = flight;
    const request = epoch.current;
    const canCommit = () => current(request) && !suspendedRef.current && isCurrent();
    setBusy(true);
    setError(null);
    try {
      if (created) {
        await onSaved(created);
        if (canCommit()) onClose();
        return;
      }
      if (remote && (roots.length !== 1 || (project && project.roots[0]?.rootPath !== roots[0]))) {
        throw new Error("project.remote-single-root-required");
      }
      let restoreProject: VirtualProject | undefined;
      if (!project) {
        // 设备全集不等于本机项目入口全集；远端恢复候选必须读取所属 Host，不能只看 open set。
        const tree =
          remote && (devices || fixedFolder)
            ? await service.readTree({ hostId, includeDeleted: true })
            : undefined;
        if (tree?.legacySingleRoot) {
          setLegacyDeviceId(hostId!);
          throw new Error(msg("legacyUpgradeRequired"));
        }
        const candidates = tree?.projects ?? projects;
        if (!canCommit()) return;
        const deleted = candidates.find(
          (candidate) =>
            candidate.deleted &&
            (!hostId || candidate.hostId === hostId) &&
            candidate.roots.length === roots.length &&
            candidate.roots.every((root) => roots.includes(root.rootPath)),
        );
        if (
          deleted &&
          (await confirm({
            title: msg("restore"),
            description: intl.formatMessage(
              { id: "project.restoreDescription" },
              { name: deleted.name },
            ),
          }))
        )
          restoreProject = deleted;
      }
      if (!canCommit()) return;
      if (!project && roots.length) {
        const accepted = await new Promise<boolean>((resolve) => {
          const finish = (value: boolean) => {
            if (!flight.cancelTrust) return;
            flight.cancelTrust = undefined;
            if (alive.current) setFolderTrust(null);
            resolve(value);
          };
          flight.cancelTrust = () => finish(false);
          setFolderTrust({
            roots: [...roots],
            deviceLabel: remote
              ? (fixedFolder?.deviceLabel ??
                selectedDevice?.label ??
                (host ? remoteHostLabel(host) : hostId!))
              : undefined,
            restoring: Boolean(restoreProject),
            projectName: fixedFolder
              ? (nameEdited ? name.trim() : restoreProject?.name) || getPathLeaf(fixedFolder.path)
              : undefined,
            resolve: finish,
          });
        });
        logger.debug("[ProjectEditor] folder confirmation", {
          accepted,
          remote,
          count: roots.length,
        });
        if (!accepted || !canCommit()) return;
      }
      await onBeforeSave?.(hostId ?? "local");
      if (!canCommit()) return;
      const saved = await service.saveProject({
        ...(hostId ? { hostId } : {}),
        ...(project ? { id: project.id } : {}),
        ...(restoreProject ? { restoreProjectId: restoreProject.id } : {}),
        ...(nameEdited ? { name: name.trim() } : {}),
        defaultName: msg("new"),
        roots,
        ...(primary ? { primaryRoot: primary } : {}),
      });
      if (!alive.current) return;
      // 远端创建与本机入口登记分两步；登记失败重试必须复用已创建的项目，不能再生成一个 ID。
      if (!project) setCreated(saved);
      // 外层聊天可能已换代；保留已保存结果，但不继续登记、导航或关闭新流程。
      if (!canCommit()) return;
      if (!project && !remote) sidebar?.preferences.prepend(saved);
      await onSaved(saved);
      // 草稿可能已被关闭或替换；旧登记结果不能关闭后来创建的表单。
      if (canCommit()) onClose();
    } catch (cause) {
      if (canCommit()) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (saveFlight.current === flight) saveFlight.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const remove = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      // 编辑器曾漏掉删除入口；复用所属 Host 的软删除，不触碰文件或任务。
      await service.deleteProject(project.id, project.hostId);
      await onDeleted?.();
      onClose();
    } catch (cause) {
      setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!suspended}
      onOpenChange={(open) => {
        if (!open)
          logger.debug("[ProjectEditor] close requested", {
            busy,
            confirming: Boolean(folderTrust),
          });
        if (!open && (!busy || fixedFolder)) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg gap-5"
        onKeyDown={fixedFolder ? (event) => event.stopPropagation() : undefined}
      >
            <DialogTitle>
              {project ? msg("edit") : msg("create")}
            </DialogTitle>
            <DialogDescription className="sr-only">{msg("description")}</DialogDescription>
                <div className="grid min-w-0 gap-1.5">
                  <label htmlFor="project-name" className={FIELD_LABEL}>
                    {msg("name")}
                  </label>
                  <Input
                    id="project-name"
                    aria-label={msg("name")}
                    placeholder={msg("new")}
                    autoFocus
                    disabled={busy || Boolean(created)}
                    data-testid="virtual-project-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameEdited(true);
                    }}
                    className="h-9 rounded-lg max-md:text-mobile-input-safe"
                  />
                </div>
                <fieldset disabled={busy || Boolean(created)} className="min-w-0">
                  <legend className={`mb-1.5 ${FIELD_LABEL}`}>{msg("folders")}</legend>
                  {/* 有目录时使用同一列表的末行添加，只有零目录才展示空态大卡片。 */}
                  <div
                    data-testid={roots.length ? "virtual-project-roots" : undefined}
                    className={
                      roots.length
                        ? "min-w-0 overflow-hidden rounded-lg border border-border divide-y divide-border"
                        : undefined
                    }
                  >
                    {roots.map((root) => (
                      <div
                        className="flex min-h-12 min-w-0 items-center gap-2 px-3 py-2"
                        key={root}
                        data-testid="virtual-project-root-row"
                      >
                        <Folder className="size-4 shrink-0 text-foreground-subtle" />
                        <span
                          className={
                            fixedFolder
                              ? "min-w-0 flex-1 break-all text-ui-base"
                              : "min-w-0 flex-1 truncate text-ui-base"
                          }
                          title={root}
                          data-testid="virtual-project-root-name"
                        >
                          {fixedFolder ? root : getPathLeaf(root)}
                        </span>
                        {root === primary ? (
                          <span
                            data-testid="virtual-project-primary"
                            className="inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2 text-ui-base text-foreground-subtle"
                          >
                            {msg("primaryBadge")}
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-foreground-subtle"
                            data-testid="virtual-project-set-primary"
                            onClick={() => setPrimary(root)}
                          >
                            {msg("setPrimary")}
                          </Button>
                        )}
                        {!fixedFolder && (!remote || !project) ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-foreground-subtle"
                            data-testid="virtual-project-remove-folder"
                            aria-label={msg("removeFolder")}
                            onClick={() => {
                              const next = roots.filter((item) => item !== root);
                              setRoots(next);
                              if (primary === root) setPrimary(next[0] ?? "");
                            }}
                          >
                            <X className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {!fixedFolder && (!remote || !project) ? (
                      <button
                        type="button"
                        data-testid="virtual-project-browse"
                        aria-label={msg("browse")}
                        className={`group flex w-full items-center gap-2 text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 ${roots.length ? "min-h-12 px-3 py-2 text-left" : "min-h-32 flex-col justify-center rounded-lg border border-dashed border-border px-4 py-5 text-center hover:border-border-hover"}`}
                        onClick={() => {
                          void browse();
                        }}
                      >
                        {roots.length ? (
                          <>
                            <FolderPlus className="size-4 shrink-0 text-foreground-subtle" />
                            <span>
                              {msg("addSourceFolder")}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="flex size-9 items-center justify-center rounded-full bg-surface text-foreground-subtle group-hover:text-foreground">
                              <FolderPlus className="size-4" />
                            </span>
                            <span className="font-medium">
                              {msg("browse")}
                            </span>
                            <span className="text-ui-sm text-foreground-subtle">
                              {msg("browseHint")}
                            </span>
                          </>
                        )}
                      </button>
                    ) : null}
                  </div>
                </fieldset>
                {error ? (
                  <p role="alert" className="text-ui-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <DialogFooter className="flex-row flex-wrap items-center justify-end">
                  {project ? (
                    <Button
                      variant="ghost"
                      data-testid="virtual-project-editor-delete"
                      disabled={busy || Boolean(created)}
                      onClick={() => {
                        void remove();
                      }}
                      className="mr-auto bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface hover:text-destructive-surface-foreground"
                    >
                      {msg("delete")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={onClose} disabled={busy && !fixedFolder}>
                    {msg("cancel")}
                  </Button>
                  <Button
                    ref={saveButton}
                    data-testid="virtual-project-save"
                    onClick={() => {
                      void save();
                    }}
                    disabled={busy || (remote && (roots.length !== 1 || legacyDeviceId === hostId))}
                  >
                    {project ? msg("save") : msg("create")}
                  </Button>
                </DialogFooter>
        {/* 确认框须留在父弹层的 React 树内；兄弟节点的触摸取消会被延迟判为外部点击，连带关闭草稿。 */}
        {folderTrust && !suspended ? (
          <ProjectFolderTrustDialog
            request={folderTrust}
            onClosed={() => {
              if (alive.current && !suspendedRef.current) saveButton.current?.focus();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
