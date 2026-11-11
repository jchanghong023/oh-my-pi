import { useOptionalDevDataSource } from "@/dev/data-source.js";
/* eslint-disable max-lines -- 技能管理面板需共享筛选、安装与开关交互状态，集中维护更便于一致性 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Import,
  Plus,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Switch } from "@/components/ui/switch.js";
import type {
  ZCodeProvider,
  SkillDiagnostic,
  SkillDiagnosticCode,
  SkillSummary,
  SkillsCapability,
  RemoteTarget,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBackendBusinessAvailable } from "@/hooks/useBackendBusinessAvailability.js";
import { useConfigWorkspaceReadCatalogResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/useConfigWorkspaceServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { groupSkillsByPlugin } from "@/settings/pluginManagedResourceGroups.js";
import { SkillsImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { buildSourceSettingsProjectionKey } from "@/settings/settingsSourceWorkspace.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  groupScopedSkillsBySource,
  selectPluginsForScope,
  selectSkillsForScope,
} from "@/settings/pluginCapabilityProjection.js";

const EMPTY_PLUGIN_INVENTORY: never[] = [];

function getWorkspaceBasename(workspacePath: string | null): string {
  if (!workspacePath) return "";
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

function formatSkillPublishedAt(timestamp: number | undefined): string | null {
  if (timestamp === undefined) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function SkillDetailField({
  label,
  value,
  mono = false,
  className = "",
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  className?: string;
}) {
  if (!value) {
    return null;
  }
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div
        className={[
          "mt-1 break-words text-ui-base text-foreground-subtle",
          mono ? "break-all font-mono" : "",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function SkillPathDetailField({
  label,
  path,
  openLabel,
  onOpen,
}: {
  label: string;
  path: string;
  openLabel: string;
  onOpen: () => void;
}) {
  return (
    <div className="min-w-0 col-span-2">
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div className="mt-1">
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-label={openLabel}
          title={openLabel}
          className="inline-flex h-auto max-w-full items-baseline gap-1.5 whitespace-normal break-all px-0 py-0 text-left align-baseline font-mono text-ui-base font-normal text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline"
          onClick={onOpen}
        >
          <span>{path}</span>
          <ExternalLink className="relative top-px size-3 shrink-0" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

interface SkillsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  scopeFilter: "user" | "workspace";
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenProjectSettings?: () => void;
  onReturnToUserScope?: () => void;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

export function SkillsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  scopeFilter,
  searchQuery,
  onVisibleCountChange,
  onCreateTask,
  onDetailOpenChange,
  onOpenProjectSettings,
  onReturnToUserScope,
  unscopedServices,
  cacheAuthorityKey,
}: SkillsSectionProps) {
  const devSource = useOptionalDevDataSource();
  const readOnly = devSource?.capabilities.settingsWrite === false;
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const backendBusinessAvailable = useBackendBusinessAvailable();
  const plugins = usePluginManagementStore((state) =>
    backendBusinessAvailable ? state.plugins : EMPTY_PLUGIN_INVENTORY,
  );
  const installedPlugins = usePluginManagementStore((state) =>
    backendBusinessAvailable ? state.installedPlugins : EMPTY_PLUGIN_INVENTORY,
  );
  const availablePlugins = usePluginManagementStore((state) =>
    backendBusinessAvailable ? state.availablePlugins : EMPTY_PLUGIN_INVENTORY,
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  // useConfirmDialog 是纯 Zustand selector（不含 useState），放在这里不会影响 SkillsSection
  // 既有的「按 useState 调用次序」单测桩（见下方 selectedSkill 附近的注释）。
  const confirmDialog = useConfirmDialog();
  const targetServiceResolution = useWorkspaceServicesResolution(
    workspacePath ?? null,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey || unscopedServices) },
  );
  const nativeCatalog = targetServiceResolution.nativeCatalog;
  const activeWorkspacePath = nativeCatalog
    ? targetServiceResolution.nativeSession?.workspacePath ?? null
    : workspacePath ?? null;
  const activeWorkspaceIdentity = nativeCatalog ? undefined : workspaceIdentity;
  const catalogReady = targetServiceResolution.catalogReady;
  // PluginsSection 已把 Scope target 传入，但 Skills 仍从当前 ServiceProvider
  // 取服务，导致跨远程 host 误路由。技能读写改用同一 target 解析结果。
  const { pluginManagementService, skillsService } = targetServiceResolution.services;
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [capability, setCapability] = useState<SkillsCapability | null>(null);
  const [loadedSkillTargetKey, setLoadedSkillTargetKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = searchQuery;
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const detailTriggerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    onDetailOpenChange?.(selectedSkill !== null);
  }, [onDetailOpenChange, selectedSkill]);
  const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const latestRequestIdRef = useRef(0);
  const activeSkillTargetKey = buildSourceSettingsProjectionKey(
    activeWorkspacePath,
    activeWorkspaceIdentity,
    cacheAuthorityKey,
  ) + targetServiceResolution.catalogKey;
  const projectionMatchesTarget =
    !activeWorkspacePath || loadedSkillTargetKey === activeSkillTargetKey;

  useEffect(() => {
    if (!catalogReady || nativeCatalog || !backendBusinessAvailable || !pluginManagementService ||
        !activeWorkspacePath || !targetServiceResolution.rpcReady)
      return;
    void initializePlugins({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
      pluginService: pluginManagementService,
    });
  }, [
    backendBusinessAvailable,
    catalogReady,
    nativeCatalog,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    cacheAuthorityKey,
    initializePlugins,
    pluginManagementService,
    scopeFilter,
    targetServiceResolution.rpcReady,
  ]);

  const workspaceLabel = getWorkspaceBasename(activeWorkspacePath);

  const renderScopeLabel = useCallback(
    (skill: SkillSummary): string => {
      switch (skill.scope) {
        case "workspace":
          // workspace 作用域显示 workspace 名，没有 workspace 时退回到通用文案。
          return (
            workspaceLabel ||
            intl.formatMessage({
              id: "settings.skills.scope.workspaceFallback",
            })
          );
        case "plugin":
          return skill.pluginName?.trim()
            ? resolvePluginDisplayName(
                {
                  name: skill.pluginName,
                  listing:
                    (skill.pluginId ? pluginListingById.get(skill.pluginId) : undefined) ??
                    resolveUniquePluginListingByName(availablePlugins, skill.pluginName),
                },
                locale,
              )
            : intl.formatMessage({ id: "settings.skills.scope.plugin" });
        case "user":
        default:
          return intl.formatMessage({ id: "settings.skills.scope.personal" });
      }
    },
    [availablePlugins, intl, locale, pluginListingById, workspaceLabel],
  );

  const renderDiagnosticCodeLabel = useCallback(
    (code: SkillDiagnosticCode): string =>
      intl.formatMessage({ id: `settings.skills.diagnostics.code.${code}` }),
    [intl],
  );

  const loadSkills = useCallback(
    async (showBlockingLoading: boolean) => {
      if (!catalogReady) return;
      if (!activeWorkspacePath) {
        setSkills([]);
        setCapability(null);
        setDiagnostics([]);
        setError(null);
        setLoading(false);
        setLoadedSkillTargetKey("");
        return;
      }
      const requestTargetKey = buildSourceSettingsProjectionKey(
        activeWorkspacePath,
        activeWorkspaceIdentity,
        cacheAuthorityKey,
      ) + targetServiceResolution.catalogKey;
      setLoading(showBlockingLoading);
      setError(null);
      const requestId = ++latestRequestIdRef.current;
      try {
        const result = await skillsService.list({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          provider: ZCODE_AGENT_PROVIDER,
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setSkills(result.skills);
        setCapability(result.capability);
        setDiagnostics(result.diagnostics);
        setLoadedSkillTargetKey(requestTargetKey);
        setLoading(false);
      } catch (loadError) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setLoadedSkillTargetKey(requestTargetKey);
        setLoading(false);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      cacheAuthorityKey,
      skillsService,
      catalogReady,
      targetServiceResolution.catalogKey,
    ],
  );

  useEffect(() => {
    setSelectedSkill(null);
    setSkills([]);
    setCapability(null);
    setDiagnostics([]);
    if (!catalogReady) {
      latestRequestIdRef.current += 1;
      setLoading(false);
      setError(null);
      setImportDialogOpen(false);
      return;
    }
    // 首屏或切换 Scope target 时必须显示阻塞 loading；手动刷新仍走后台刷新，
    // 避免有当前 target 数据时整块闪烁。
    void loadSkills(true);
    return () => {
      latestRequestIdRef.current += 1;
    };
  }, [activeWorkspacePath, loadSkills, catalogReady]);

  const refresh = useCallback(async () => {
    await loadSkills(false);
  }, [loadSkills]);

  const refreshSharedSkillStoreForCurrentWorkspace = useCallback(async () => {
    await refreshSharedSkillStoreForWorkspace({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      skillsService,
    });
  }, [activeWorkspaceIdentity, activeWorkspacePath, skillsService]);

  const setEnabled = useCallback(
    async (skillId: string, enabled: boolean) => {
      if (readOnly || nativeCatalog || !activeWorkspacePath) {
        return;
      }
      // 移除三方来源后，技能状态统一写入 ZCode Agent 上下文，避免旧 provider 前缀带来分桶漂移。
      const targetSkill = skills.find((skill) => skill.id === skillId);
      const effectiveProvider: ZCodeProvider = ZCODE_AGENT_PROVIDER;
      try {
        await skillsService.setEnabled({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          provider: effectiveProvider,
          scope: targetSkill?.scope,
          skillId,
          enabled,
        });
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          reason: "settings-skill-enabled",
        });
        await Promise.all([loadSkills(false), refreshSharedSkillStoreForCurrentWorkspace()]);
      } catch (setEnabledError) {
        setError(
          setEnabledError instanceof Error ? setEnabledError.message : String(setEnabledError),
        );
      }
    },
    [
      activeWorkspaceIdentity,
      nativeCatalog,
      readOnly,
      activeWorkspacePath,
      loadSkills,
      refreshSharedSkillStoreForCurrentWorkspace,
      skills,
      skillsService,
    ],
  );

  // 删除本地技能：plugin 作用域技能不可单独删除（由卸载插件管理），调用方已在 UI 层屏蔽其入口。
  // 复用应用根部已挂载的确认弹窗 store（useConfirmDialog），与子智能体删除流程保持一致。
  const handleDeleteSkill = useCallback(
    async (skill: SkillSummary) => {
      if (readOnly || nativeCatalog || !activeWorkspacePath || skill.scope === "plugin") {
        return;
      }
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.skills.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.skills.delete.description" },
          { name: skill.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      try {
        await skillsService.deleteSkill({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          skillId: skill.id,
        });
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          reason: "settings-skill-delete",
        });
        if (selectedSkill?.id === skill.id) {
          setSelectedSkill(null);
        }
        await loadSkills(false);
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      }
    },
    [
      activeWorkspaceIdentity,
      nativeCatalog,
      readOnly,
      activeWorkspacePath,
      confirmDialog,
      intl,
      loadSkills,
      selectedSkill,
      skillsService,
    ],
  );

  const scopedProviderSkills = useMemo(() => {
    if (!catalogReady || !projectionMatchesTarget) return [];
    const allProviderSkills = nativeCatalog ? skills : filterSkillsForProvider(skills, ZCODE_AGENT_PROVIDER);
    if (nativeCatalog || !backendBusinessAvailable || !pluginManagementService) {
      // The resource list is authoritative without ZCode inventory. Plugin scope has no
      // user/workspace ownership field, so retain it rather than inventing membership.
      return allProviderSkills.filter(
        (skill) => skill.scope === scopeFilter || skill.scope === "plugin",
      );
    }
    const pluginStoreMatchesTarget =
      (pluginWorkspaceIdentity?.trim() || pluginWorkspacePath || "") ===
        (activeWorkspaceIdentity?.trim() || activeWorkspacePath || "") &&
      pluginConfigScope === scopeFilter;
    return selectSkillsForScope(
      allProviderSkills,
      pluginStoreMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, scopeFilter) : [],
      scopeFilter,
    );
  }, [
    backendBusinessAvailable,
    catalogReady,
    projectionMatchesTarget,
    nativeCatalog,
    pluginManagementService,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    installedPlugins,
    pluginWorkspaceIdentity,
    pluginWorkspacePath,
    pluginConfigScope,
    plugins,
    scopeFilter,
    skills,
  ]);
  const groupedSkills = useMemo(
    () => groupSkillsByPlugin(scopedProviderSkills, query),
    [query, scopedProviderSkills],
  );
  const skillSourceGroups = useMemo(() => {
    return groupScopedSkillsBySource(
      [...groupedSkills.local, ...groupedSkills.plugin],
      scopeFilter === "user"
        ? intl.formatMessage({ id: "settings.scope.user" })
        : workspaceLabel || intl.formatMessage({ id: "settings.scope.workspace" }),
    );
  }, [groupedSkills.local, groupedSkills.plugin, intl, scopeFilter, workspaceLabel]);
  const filteredSkillCount = groupedSkills.local.length + groupedSkills.plugin.length;
  const hasEmptySearchResult = Boolean(query.trim()) && filteredSkillCount === 0;
  const directInstalledSkillCount = scopedProviderSkills.filter(
    (skill) => skill.scope !== "plugin",
  ).length;
  const hideInstalledGroup = Boolean(query.trim()) && groupedSkills.local.length === 0;
  const pluginIconItemById = useMemo(
    () =>
      new Map(
        plugins.map((plugin) => [
          plugin.id,
          { name: plugin.name, listing: pluginListingById.get(plugin.id) },
        ]),
      ),
    [pluginListingById, plugins],
  );
  useEffect(() => {
    onVisibleCountChange?.(filteredSkillCount);
  }, [filteredSkillCount, onVisibleCountChange]);
  const handleCreateSkill = () => {
    if (readOnly || nativeCatalog || !activeWorkspacePath || !onCreateTask) {
      return;
    }
    const effectiveProvider: ZCodeProvider = ZCODE_AGENT_PROVIDER;
    const skillCreator = filterSkillsForProvider(skills, effectiveProvider).find(
      (skill) => skill.name === "skill-creator",
    );
    const markdown = buildSkillMentionMarkdown("skill-creator", skillCreator?.path);

    // v4 迁移删除旧 pendingComposerPrefill 后，这个入口仍手工操作 session
    // store，只剩返回聊天页的导航，skill-creator 文本没有进入新 Composer。统一委托
    // Root 的新任务入口，让草稿持久化、workspaceIdentity 隔离和 Composer 插入保持单一路径。
    onCreateTask({
      provider: effectiveProvider,
      initialPrompt: `${markdown} `,
      initialPromptMention: {
        id: `skill:${skillCreator?.id ?? "skill-creator"}`,
        category: "skills",
        label: "skill-creator",
        value: "skill-creator",
        markdown,
        ...(skillCreator?.description ? { description: skillCreator.description } : {}),
        ...(skillCreator
          ? {
              data: {
                path: skillCreator.path,
                scope: skillCreator.scope,
              },
            }
          : {}),
      },
    });
  };

  const detailSkill = catalogReady && projectionMatchesTarget && selectedSkill
    ? (skills.find((skill) => skill.id === selectedSkill.id) ?? selectedSkill)
    : null;
  const selectedSkillPublishedAt = formatSkillPublishedAt(detailSkill?.metadata?.publishedAt);
  const openSkillFilePath = useCallback(
    async (path: string) => {
      const result = await platform.openInFileManager(path);
      if (!result.success) {
        toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
      }
    },
    [intl, platform],
  );

  // 诊断条数不等于加载失败的技能数；同一次扫描可以返回可用技能和多个目录级警告。
  // 按严重级别展示真实统计，避免把 warning 误报成“所有技能加载失败”。
  const diagnosticErrorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  const diagnosticWarningCount = diagnostics.length - diagnosticErrorCount;
  const diagnosticsSummary =
    diagnostics.length > 0
      ? intl.formatMessage(
          { id: "settings.skills.diagnostics.summary" },
          {
            errorCount: String(diagnosticErrorCount),
            warningCount: String(diagnosticWarningCount),
          },
        )
      : "";
  const renderSkillRow = (skill: SkillSummary) => {
    const pluginIconItem = skill.pluginId
      ? pluginIconItemById.get(skill.pluginId)
      : skill.pluginName
        ? {
            name: skill.pluginName,
            listing: resolveUniquePluginListingByName(availablePlugins, skill.pluginName),
          }
        : undefined;
    return (
      <div
        key={skill.id}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
      >
        {skill.scope === "plugin" && pluginIconItem ? (
          <PluginStoreAvatar item={pluginIconItem} className="size-9 bg-background" />
        ) : (
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
            aria-hidden="true"
          >
            <WandSparkles className="size-4" />
          </div>
        )}
        <div
          role="button"
          tabIndex={0}
          className="min-w-0 cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          onClick={(event) => { detailTriggerRef.current = event.currentTarget; setSelectedSkill(skill); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              detailTriggerRef.current = event.currentTarget;
              setSelectedSkill(skill);
            }
          }}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-ui-base font-medium text-foreground">{skill.name}</span>
          </div>
          <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
            {skill.description ||
              intl.formatMessage({
                id: "settings.skills.noDescription",
              })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {nativeCatalog ? (
            <span className="text-ui-sm text-foreground-subtle">
              {skill.enabled ? "Native · 只读" : "Native · 策略禁用"}
            </span>
          ) : skill.scope === "plugin" ? null : (
            <>
              <Switch
                disabled={readOnly}
                checked={skill.enabled}
                onCheckedChange={(checked) => {
                  void setEnabled(skill.id, checked);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:bg-destructive/10 hover:text-destructive"
                aria-label={intl.formatMessage({ id: "common.delete" })}
                title={intl.formatMessage({ id: "common.delete" })}
                disabled={readOnly}
                onClick={() => void handleDeleteSkill(skill)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderSkillList = (groupSkills: SkillSummary[]) => (
    <SettingsResourceList
      items={groupSkills}
      getKey={(skill) => skill.id}
      renderItem={renderSkillRow}
    />
  );

  const skillHeaderActions = (
    <SettingsResourceHeaderActions
      onRefresh={() => void (nativeCatalog
        ? refresh()
        : Promise.all([refresh(), refreshSharedSkillStoreForCurrentWorkspace()]))}
      onImport={nativeCatalog ? undefined : () => setImportDialogOpen(true)}
      onNew={nativeCatalog ? undefined : handleCreateSkill}
      refreshing={loading}
      importDisabled={readOnly || !capability?.userScopeAvailable}
      newDisabled={readOnly}
      importActionId="settings.skills.import.open"
      newActionId="settings.skills.create.open"
    />
  );

  return (
    <div className="space-y-4">
      {readOnly && <p className="text-ui-sm text-foreground-subtle">当前账号只读，可搜索、筛选并查看技能详情；只有当前 Web 的所有者可修改技能。请启动自己的 OMP Web 修改自己的技能。</p>}
      {nativeCatalog ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          当前 Native 会话的有效技能目录（只读）：{activeWorkspacePath ?? "未绑定会话"}。
          策略禁用和资源读取失败见下方诊断；此处不支持启用、创建、导入或删除。
        </div>
      ) : null}

      {catalogReady && projectionMatchesTarget && diagnostics.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/10 text-ui-base text-foreground">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            onClick={() => setDiagnosticsOpen((prev) => !prev)}
            aria-expanded={diagnosticsOpen}
            aria-label={
              diagnosticsOpen
                ? intl.formatMessage({
                    id: "settings.skills.diagnostics.collapse",
                  })
                : intl.formatMessage({
                    id: "settings.skills.diagnostics.expand",
                  })
            }
          >
            {diagnosticsOpen ? (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            <span className="flex-1 truncate font-medium">{diagnosticsSummary}</span>
          </button>
          {diagnosticsOpen ? (
            <ul className="space-y-1 border-t border-amber-500/30 px-3 py-2">
              {diagnostics.map((diagnostic, index) => (
                <li
                  key={`${diagnostic.code}-${diagnostic.path ?? "no-path"}-${index}`}
                  className="min-w-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={
                        diagnostic.severity === "error"
                          ? "shrink-0 text-ui-xs font-semibold uppercase tracking-wide text-destructive"
                          : "shrink-0 text-ui-xs font-semibold uppercase tracking-wide text-amber-500"
                      }
                    >
                      {diagnostic.severity}
                    </span>
                    <span className="font-medium text-foreground">
                      {renderDiagnosticCodeLabel(diagnostic.code)}
                    </span>
                    {diagnostic.skillName ? (
                      <span className="text-foreground-subtle">· {diagnostic.skillName}</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 break-words text-foreground-subtle">
                    {diagnostic.message}
                  </div>
                  {diagnostic.path ? (
                    <div className="mt-0.5 break-all font-mono text-ui-xs text-foreground-subtle">
                      {diagnostic.path}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {catalogReady && capability && !nativeCatalog && !capability.userScopeAvailable ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.skills.userScopeDesktopOnly" })}
        </div>
      ) : null}

      {(projectionMatchesTarget && error) || targetServiceResolution.catalogError ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {targetServiceResolution.catalogError?.message ?? error}
          <Button type="button" variant="outline" size="sm" onClick={() => {
            if (catalogReady) void refresh();
            else targetServiceResolution.catalog.reload();
          }}>{intl.formatMessage({ id: "common.refresh" })}</Button>
        </div>
      ) : null}

      {nativeCatalog && !catalogReady && !targetServiceResolution.catalogError ? (
        <div className="space-y-2 text-foreground-subtle">
          <p>Native 会话未绑定，技能只读目录不可用。</p>
          <p className="text-ui-sm leading-6">项目范围需要该项目的 Native 会话绑定；工作区中已打开的其他范围会话不会自动用于此项目。刷新不会创建或改绑会话。请在 Dev 项目与 Release 设置中检查对应项目的“我的开发项目”，再从工作区显式选择该项目的已有会话；原型不会自动绑定真实会话。</p>
          <div className="flex flex-wrap gap-2">
            {onOpenProjectSettings && <Button variant="outline" onClick={onOpenProjectSettings}>打开 Dev 项目与 Release 设置</Button>}
            {onReturnToUserScope && <Button variant="outline" onClick={onReturnToUserScope}>返回用户范围</Button>}
          </div>
          <Button variant="outline" onClick={targetServiceResolution.catalog.reload}>
            {intl.formatMessage({ id: "common.refresh" })}
          </Button>
        </div>
      ) : targetServiceResolution.catalogError ? null : !catalogReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.skills.searchEmpty",
          })}
        />
      ) : (
        <div className="space-y-6">
          <section className={hideInstalledGroup ? "hidden" : "space-y-4"}>
            <div data-skills-plugin-direct-actions="true">
              <SettingsResourceGroupHeader
                actions={skillHeaderActions}
                count={groupedSkills.local.length}
                title={intl.formatMessage({
                  id: "settings.plugin.skills.installed",
                })}
              />
            </div>
            {groupedSkills.local.length > 0 ? (
              renderSkillList(groupedSkills.local)
            ) : directInstalledSkillCount === 0 && !query.trim() ? (
              <PluginInstallEmptyState
                title={nativeCatalog ? "此作用域没有已加载的 Native 技能" : intl.formatMessage({
                  id: "settings.plugin.skills.emptyInstalledTitle",
                })}
                description={nativeCatalog
                  ? "仅显示当前会话有效目录；策略与资源问题见诊断，不扫描其他配置档案。"
                  : intl.formatMessage({ id: "settings.plugin.skills.emptyInstalledDescription" })}
                actions={nativeCatalog ? undefined :
                  <>
                    <Button type="button" variant="default" size="lg" disabled={readOnly} onClick={handleCreateSkill}>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.plugin.skills.newSkill",
                      })}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      disabled={readOnly || !capability?.userScopeAvailable}
                      onClick={() => setImportDialogOpen(true)}
                    >
                      <Import data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.skills.import.action",
                      })}
                    </Button>
                  </>
                }
              />
            ) : null}
          </section>
          {skillSourceGroups
            .filter((group) => group.id.startsWith("plugin:"))
            .map((group) => (
              <section key={group.id} className="space-y-4">
                <SettingsResourceGroupHeader
                  count={group.skills.length}
                  title={resolvePluginDisplayName(
                    {
                      name: group.label,
                      listing:
                        (group.pluginId ? pluginListingById.get(group.pluginId) : undefined) ??
                        resolveUniquePluginListingByName(availablePlugins, group.label),
                    },
                    locale,
                  )}
                />
                {renderSkillList(group.skills)}
              </section>
            ))}
        </div>
      )}
      <Dialog
        open={detailSkill !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSkill(null);
          }
        }}
      >
        <DialogContent className="max-h-[min(80vh,640px)] max-w-xl overflow-hidden p-0" onCloseAutoFocus={(event) => {
          if (detailTriggerRef.current?.isConnected) {
            event.preventDefault();
            detailTriggerRef.current.focus();
          }
        }}>
          {detailSkill ? (
            <div className="flex min-h-0 flex-col">
              <DialogHeader className="border-b border-popover-border px-4 pt-4 pb-3">
                <DialogTitle className="truncate pr-8 text-ui-lg">{detailSkill.name}</DialogTitle>
              </DialogHeader>
              <div className="min-h-0 space-y-4 overflow-auto px-4 py-5">
                <div className="grid gap-1.5">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "settings.skills.detail.description",
                    })}
                  </div>
                  <div className="max-h-40 overflow-auto whitespace-pre-wrap text-ui-base/relaxed text-foreground-subtle">
                    {detailSkill.description ||
                      intl.formatMessage({
                        id: "settings.skills.noDescription",
                      })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.scope",
                    })}
                    value={renderScopeLabel(detailSkill)}
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.status",
                    })}
                    value={
                      detailSkill.enabled
                        ? intl.formatMessage({
                            id: "settings.skills.detail.enabled",
                          })
                        : intl.formatMessage({
                            id: "settings.skills.detail.disabled",
                          })
                    }
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.version",
                    })}
                    value={detailSkill.metadata?.version}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.slug",
                    })}
                    value={detailSkill.metadata?.slug}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.publishedAt",
                    })}
                    value={selectedSkillPublishedAt}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.ownerId",
                    })}
                    value={detailSkill.metadata?.ownerId}
                    mono
                    className="col-span-2"
                  />
                  {nativeCatalog ? (
                    <SkillDetailField label="Native 路径（只读）" value={detailSkill.path} mono />
                  ) : (
                    <SkillPathDetailField
                      label={intl.formatMessage({ id: "settings.skills.detail.path" })}
                      path={detailSkill.path}
                      openLabel={intl.formatMessage({ id: "settings.skills.detail.openPath" })}
                      onOpen={() => void openSkillFilePath(detailSkill.path)}
                    />
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <SkillsImportDialog
        open={importDialogOpen && catalogReady && !nativeCatalog && !readOnly}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={targetServiceResolution.services.settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: activeWorkspacePath,
            workspaceIdentity: activeWorkspaceIdentity,
            reason: "settings-skill-import",
          });
          await refresh();
        }}
      />
    </div>
  );
}
