import { ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";
/* oxlint-disable eslint(max-lines) */
import { DevPersonalConfigScope } from "@/dev/DevPersonalConfigScope.js";
import { DevProjectSettings } from "@/dev/DevWorkbench.js";
import { DevPersonalizationSettings } from "@/dev/DevPersonalizationSettings.js";
import { DevAgentModelSettings, type DevModelDraftActions } from "@/dev/DevAgentModelSettings.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog.js";
import { useDev } from "@/dev/DevContext.js";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type { AppSettings } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNativeHostAvailable } from "@/hooks/useBackendBusinessAvailability.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  addPendingSettingsSectionListener,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsModelProviderTarget,
  resolveSettingsSection,
  setPendingSettingsSectionIntent,
  writeLastSettingsSectionPreference,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import {
  ArchiveManagement,
  ProjectManagement,
} from "@/project-sidebar/index.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { DisplayOnlyResourcesSection } from "@/settings/DisplayOnlyResourcesSection.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { HooksSection } from "@/settings/HooksSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { MemorySettingsSection } from "@/settings/MemorySettingsSection.js";
import { PersonalizationSection } from "@/settings/PersonalizationSection.js";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";
import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { Theme } from "@/useTheme.js";

import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";
import {
  createSettingsPageConfig,
  TaskAutoArchiveSettings,
  resolveSettingsSectionForPlatform,
} from "@/settingsPageHelpers.js";
import { AppearanceSectionContent } from "./settingsCodePreview.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";


function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors",
          "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0",
          active
            ? "bg-surface-hover text-foreground"
            : "text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1 max-lg:sr-only">
          {children ?? <span className="truncate text-ui-base text-foreground">{label}</span>}
        </span>
      </button>
    </ControlHintTooltip>
  );
}

export function SettingsPage({
  isDesktop,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  allowOpenWorkspace = true,
}: {
  isDesktop?: boolean;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  allowOpenWorkspace?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const dev = useDev();
  const nativeHostAvailable = useNativeHostAvailable();
  const { settingsSectionGroups, settingsSections } = useMemo(
    () => createSettingsPageConfig(),
    [],
  );
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const initialSection = consumeInitialSettingsSection("general");
    const visibleInitialSection = resolveSettingsSectionForPlatform(
      initialSection,
      settingsSections,
    );
    // 设置页首次挂载时也要写入当前落点。否则用户直接打开再退出，
    // 下一次仍可能因为没有偏好记录而回到旧默认入口。
    writeLastSettingsSectionPreference(visibleInitialSection);
    return visibleInitialSection;
  });
  const [modelDraftActions, setModelDraftActions] = useState<DevModelDraftActions | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const requestNavigation = useCallback((navigate: () => void) => {
    if (modelDraftActions) setPendingNavigation(() => navigate);
    else navigate();
  }, [modelDraftActions]);
  const handleBack = useCallback(() => requestNavigation(() => onBack?.()), [requestNavigation, onBack]);
  const [pluginScopeKey, setPluginScopeKey] = useState(() =>
    consumePendingSettingsPluginScopeKey(),
  );
  const [settingsSectionNavigationVersion, setSettingsSectionNavigationVersion] = useState(0);
  useEffect(() => {
    clearPendingSettingsPluginScopeKey();
  }, []);
  const [settingsBreadcrumbItems, setSettingsBreadcrumbItems] = useState<
    readonly SettingsBreadcrumbItem[]
  >([]);
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const setCodePreviewSettings = useZCodeStore((state) => state.setCodePreviewSettings);
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [pendingModelProviderTarget, setPendingModelProviderTarget] = useState<
    SettingsModelProviderTarget | undefined
  >(() => initialModelProviderTarget);
  const setActiveSettingsSection = useCallback(
    (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
      const resolvedSection = resolveSettingsSection(section, fallbackSection);
      requestNavigation(() => {
        setActiveSection(resolvedSection);
        writeLastSettingsSectionPreference(resolvedSection);
      });
    },
    [activeSection, requestNavigation],
  );
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  // Settings 打开后 activeTab 会变成 settings，本地反查 activeTab 读 identity 会稳定丢失。
  // 这里改为读取 tabStore 维护的“最近激活 workspace identity”，让插件管理继续命中正确远端。
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const activeWorkspaceTab = useTabStore((state) => {
    const workspacePath = state.activeWorkspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentity = state.activeWorkspaceIdentity ?? undefined;
    const matchingTabs = state.tabs
      .filter(isWorkspaceTab)
      .filter((tab) => tab.workspacePath === workspacePath);
    return (
      matchingTabs.find((tab) =>
        workspaceIdentity ? tab.workspaceIdentity === workspaceIdentity : !tab.workspaceIdentity,
      ) ??
      matchingTabs[0] ??
      null
    );
  });
  const localModelProviderConnectivityWorkspacePath = useMemo(
    () =>
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeWorkspaceTab,
        workspaceTabs,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath, activeWorkspaceTab, workspaceTabs],
  );
  const isRemoteModelProviderWorkspace = Boolean(
    activeWorkspaceIdentity?.trim() ||
    activeWorkspaceTab?.remoteSessionId?.trim() ||
    activeWorkspaceTab?.remoteTarget,
  );
  const services = useServices();
  const localHostServices = useBaseWorkspaceServices();
  // SettingsPage 可能挂在远端 workspace 的 ServiceProvider 下；共享设置属于本机 Host，
  // 读写必须固定走本机 settingService，否则会写进远端 setting。
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings({
    services: localHostServices,
  });
  const memoryWorkspaceDisplayNames = useMemo(() => {
    const names = new Set<string>();
    // Memory Scope 的项目顺序以 settings.json recentProjects 为准；打开中的
    // Workspace 只补充尚未持久化的项目，不能抢占最近项目排序。
    for (const path of sharedSettings?.recentProjects ?? []) {
      const name = getPathLeaf(path).trim();
      if (name) names.add(name);
    }
    for (const tab of workspaceTabs) {
      const name = tab.label.trim() || getPathLeaf(tab.workspacePath).trim();
      if (name) names.add(name);
    }
    return [...names];
  }, [sharedSettings?.recentProjects, workspaceTabs]);
  const memoryEnabled = sharedSettings?.memoryEnabled === true;
  const [taskAutoArchiveEnabled, setTaskAutoArchiveEnabled] = useState(false);
  const [taskAutoArchiveOlderThanDays, setTaskAutoArchiveOlderThanDays] = useState(30);


  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // SettingsPage 已打开时再次从 quickpick 点“个性化/技能”等设置入口，
        // 页面不会重新挂载，之前写入的 pending section 无人消费，看起来像点击没反应。
        // 这里订阅同窗口跳转意图，立即切换当前设置分区。
        setActiveSettingsSection(section, activeSection);
        // 设置入口是一级路由边界。即使仍落在同一 section，也必须销毁旧的 New/Edit/Detail 子状态。
        setSettingsSectionNavigationVersion((version) => version + 1);
        setPluginScopeKey(detail?.pluginScopeKey);
        if (section === "modelProvider" && detail?.modelProviderId) {
          setPendingModelProviderTarget({
            providerId: detail.modelProviderId,
          });
        }
      }),
    [activeSection, setActiveSettingsSection],
  );


  useEffect(() => {
    let active = true;
    // 任务归档由目标 Environment 消费，仍读 Source；切换后丢弃旧响应。
    services.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        setTaskAutoArchiveEnabled(settings.taskAutoArchiveEnabled ?? false);
        setTaskAutoArchiveOlderThanDays(settings.taskAutoArchiveOlderThanDays ?? 30);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [services.settingService]);

  const handleMemoryEnabledChange = useCallback(
    async (enabled: boolean) => {
      await updateSharedSettings({ memoryEnabled: enabled });
    },
    [updateSharedSettings],
  );
  const handleTaskAutoArchiveEnabledChange = useCallback(
    async (enabled: boolean) => {
      await services.settingService.update({ taskAutoArchiveEnabled: enabled });
      setTaskAutoArchiveEnabled(enabled);
    },
    [services.settingService],
  );
  const handleTaskAutoArchiveOlderThanDaysChange = useCallback(
    async (days: number) => {
      await services.settingService.update({ taskAutoArchiveOlderThanDays: days });
      setTaskAutoArchiveOlderThanDays(days);
    },
    [services.settingService],
  );
  const handleFooterThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        setTheme(value as Theme);
      }
    },
    [setTheme],
  );
  const handleCodePreviewSettingsChange = useCallback(
    (patch: Parameters<typeof setCodePreviewSettings>[0]) => {
      return setCodePreviewSettings(patch);
    },
    [setCodePreviewSettings],
  );
  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection);
  useEffect(() => {
    setActiveSection((current) => resolveSettingsSectionForPlatform(current, settingsSections));
  }, [settingsSections]);
  if (!activeSectionMeta) {
    return null;
  }

  const activeSectionLabel = activeSection === "general"
    ? "Dev 项目与 Release"
    : intl.formatMessage({
        id: activeSectionMeta.contentTitleId ?? activeSectionMeta.titleId,
      });
  const settingsBreadcrumbSectionLabel = activeSectionLabel;
  const visibleSettingsBreadcrumbItems =
    settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel
      ? settingsBreadcrumbItems
      : [];
  const hasVisibleSettingsBreadcrumb = visibleSettingsBreadcrumbItems.length >= 2;
  const showActiveSectionTitle = !hasVisibleSettingsBreadcrumb;

  return (
    <>
        <div
          data-testid={TID_SETTINGS_PAGE}
          data-active-section={activeSection}
          className="relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)]"
        >
          <aside className="min-w-0">
            <div className="flex h-full flex-col">
              <div className="flex h-12 shrink-0 items-center px-4"><span role="img" aria-label="ZCode" data-testid="settings-logo" className="pointer-events-none flex size-5 items-center justify-center select-none"><ZCodeStartupLogoBadge size="titlebar" animated={false} /></span></div>
              <div className="px-2 pb-3 pt-3">
                {onBack ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "workspace.backToWorkspace",
                    })}
                    side="right"
                    align="center"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      data-testid={TID_SETTINGS_BACK_BUTTON}
                      aria-label={intl.formatMessage({
                        id: "workspace.backToWorkspace",
                      })}
                      className="m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl bg-surface px-1.5 text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground max-lg:m-1 max-lg:size-10 max-lg:justify-center max-lg:px-0"
                      onClick={() => {
                        handleBack();
                      }}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="max-lg:sr-only">
                        {intl.formatMessage({
                          id: "workspace.backToWorkspace",
                        })}
                      </span>
                    </Button>
                  </ControlHintTooltip>
                ) : null}
              </div>

              <nav
                aria-label={intl.formatMessage({ id: "settings.navLabel" })}
                className="flex-1 overflow-y-auto px-2 pb-3"
              >
                <div className="space-y-4">
                  {settingsSectionGroups.map((group, groupIndex) => {
                    const groupLabel = intl.formatMessage({
                      id: group.titleId,
                    });
                    const groupLabelId = `settings-sidebar-group-${group.id}`;

                    return (
                      <div
                        key={group.id}
                        role="group"
                        aria-labelledby={groupLabelId}
                        className={cn(
                          "space-y-1",
                          groupIndex > 0 && "max-lg:border-t max-lg:border-border max-lg:pt-3",
                        )}
                      >
                        <div
                          id={groupLabelId}
                          className="px-2.5 pb-1 text-ui-sm font-medium text-remote-foreground-muted max-lg:sr-only"
                        >
                          {groupLabel}
                        </div>
                        {group.sections
                          .map(({ id, icon: Icon, titleId }) => {
                            const isActive = activeSection === id;
                            const label = id === "general"
                              ? "Dev 项目与 Release"
                              : intl.formatMessage({ id: titleId });

                            return (
                              <SettingsSidebarButton
                                key={id}
                                icon={Icon}
                                label={label}
                                active={isActive}
                                aria-current={isActive ? "page" : undefined}
                                data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                                data-settings-section-nav={id}
                                onClick={() => {
                                    setSettingsSectionNavigationVersion((version) => version + 1);
                                    setActiveSettingsSection(id);
                                }}
                              >
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="truncate text-ui-base text-foreground">
                                    {label}
                                  </span>
                                </span>
                              </SettingsSidebarButton>
                            );
                          })}
                      </div>
                    );
                  })}
                </div>
              </nav>

              <div className="max-lg:hidden">
                <WorkspaceSidebarFooter
                  theme={theme}
                  onThemeChange={handleFooterThemeChange}
                  onSettingsButtonClick={handleBack}
                  settingsButtonMode="back"
                />
              </div>
            </div>
          </aside>

          <section
            data-settings-content-frame="true"
            className="flex min-h-0 flex-col"
          >
            <div
              data-settings-panel-frame="true"
              className="relative flex min-h-0 h-full flex-col rounded-xl border border-border bg-background"
            >
                <div
                  className={cn(
                    // Settings 使用和 new task 一致的问号定位：在内容面板内定位，外层让出自绘窗口按钮区，内层保持 top-2.5/right-2.5。
                    "absolute top-0 z-50 h-10 w-10 pointer-events-auto [app-region:no-drag]",
                    "right-0",
                  )}
                >
                  <div className="absolute right-2.5 top-2.5 pointer-events-auto [app-region:no-drag]">
                    <WorkspaceHelpMenuButton
                      className="relative z-50 [app-region:no-drag]"
                    />
                  </div>
                </div>
              <SettingsBreadcrumbProvider
                onItemsChange={setSettingsBreadcrumbItems}
                sectionLabel={settingsBreadcrumbSectionLabel}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0">
                    <div
                      className="min-w-0 flex-1 mr-12"
                    >
                      <SettingsHeaderBreadcrumb
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                        items={visibleSettingsBreadcrumbItems}
                      />
                    </div>
                  </div>
                  <>
                    <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                      <div
                        className={cn(
                          SETTINGS_FRAME_CONTENT_CLASSNAME,
                          "flex flex-col gap-8",
                        )}
                      >
                          <div>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex min-w-0 flex-wrap items-center gap-3">
                                {showActiveSectionTitle ? (
                                  <h2 className="text-ui-settings-title font-semibold tracking-tight text-foreground lg:text-ui-settings-title-lg">
                                    {activeSectionLabel}
                                  </h2>
                                ) : null}
                                {!hasVisibleSettingsBreadcrumb && activeSectionMeta.titleBadgeId ? (
                                  <span className="inline-flex h-6 items-center rounded-md border border-border px-2 text-ui-xs font-semibold tracking-normal text-foreground">
                                    {intl.formatMessage({
                                      id: activeSectionMeta.titleBadgeId,
                                    })}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            {activeSection === "projects" ? (
                              <p className="mt-2 max-w-2xl text-ui-base text-foreground-subtle">
                                {intl.formatMessage({ id: "projectManagement.intro" })}
                              </p>
                            ) : null}
                          </div>
                        <div className="space-y-8">
                          {activeSection === "general" ? (
                            <DevProjectSettings />
                          ) : activeSection === "appearance" ? (
                            <AppearanceSectionContent
                              codePreviewSettings={codePreviewSettings}
                              setCodePreviewSettings={handleCodePreviewSettingsChange}
                              theme={theme}
                              setTheme={(nextTheme) => handleFooterThemeChange(nextTheme)}
                              uiFontSizePx={uiFontSizePx}
                              setUiFontSizePx={(fontSizePx) =>
                                setUiFontSizePx(fontSizePx)
                              }
                            />
                          ) : activeSection === "browser" ? (
                            <BrowserSettingsSection />
                          ) : activeSection === "computerUse" ? (
                            <ComputerUseSection />
                          ) : activeSection === "shortcuts" ? (
                            <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
                          ) : activeSection === "modelProvider" ? (
                            <ServiceProvider services={localHostServices}>
                              {/* 模型配置属于本机全局事实源；激活远端 workspace 时也不能注入远端 Host。 */}
                              {dev ? <DevAgentModelSettings onDraftActionsChange={setModelDraftActions} /> :
                              <ModelProviderSection
                                workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
                                connectivityWorkspacePath={
                                  localModelProviderConnectivityWorkspacePath
                                }
                                connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}
                                pendingModelProviderTarget={pendingModelProviderTarget}
                                onConsumePendingModelProviderTarget={() =>
                                  setPendingModelProviderTarget(undefined)
                                }
                              />}
                            </ServiceProvider>
                          ) : activeSection === "personalization" ? (
                            dev ? <DevPersonalizationSettings onDraftActionsChange={setModelDraftActions} /> : isDesktop || nativeHostAvailable ? (
                              <PersonalizationSection
                                settingService={localHostServices.settingService}
                                isDesktop={Boolean(isDesktop)}
                              />
                            ) : (
                              <p className="text-ui-base text-foreground-subtle">
                                {intl.formatMessage({ id: "settings.personalization.localOnly" })}
                              </p>
                            )
                          ) : activeSection === "memory" ? (
                            <ServiceProvider services={localHostServices}>
                              {/* Memory catalog 始终使用本地 Host，避免远程 workspace 误读本机数据。 */}
                              <MemorySettingsSection
                                memoryEnabled={memoryEnabled}
                                memoryService={localHostServices.memoryService}
                                onMemoryEnabledChange={handleMemoryEnabledChange}
                                projectMemoryViewerAvailable={Boolean(isDesktop)}
                                workspaceDisplayNames={memoryWorkspaceDisplayNames}
                              />
                            </ServiceProvider>
                          ) : activeSection === "skill" ? (
                            <div className="space-y-4">
                              {dev && <DevPersonalConfigScope />}
                              {dev && <p className="text-ui-sm leading-6 text-foreground-subtle">以下为共享 OMP profile 与项目技能目录的内存样例，可搜索查看；切换访问工号不改变共享配置归属，不读取真实目录，不执行安装或文件写入。</p>}
                              <PluginsSection
                                key={`skill:${settingsSectionNavigationVersion}`}
                                mode="skill"
                                initialScopeKey={pluginScopeKey}
                                workspacePath={activeWorkspacePath}
                                workspaceIdentity={activeWorkspaceIdentity}
                                onCreateTask={onCreateTask}
                                onOpenProjectSettings={dev ? () => setActiveSettingsSection("general") : undefined}
                              />
                            </div>
                          ) : activeSection === "projects" ? (
                            <ProjectManagement />
                          ) : activeSection === "archives" ? (
                            <div className="min-w-0 space-y-6">
                              <TaskAutoArchiveSettings
                                taskAutoArchiveEnabled={taskAutoArchiveEnabled}
                                taskAutoArchiveOlderThanDays={taskAutoArchiveOlderThanDays}
                                onTaskAutoArchiveEnabledChange={handleTaskAutoArchiveEnabledChange}
                                onTaskAutoArchiveOlderThanDaysChange={
                                  handleTaskAutoArchiveOlderThanDaysChange
                                }
                              />
                              <ArchiveManagement />
                            </div>
                          ) : activeSection === "plugin" ? (
                            <DisplayOnlyResourcesSection kind="plugin" />
                          ) : activeSection === "subagents" ? (
                            <DisplayOnlyResourcesSection kind="subagents" />
                          ) : activeSection === "automations" ? (
                            <AutomationsSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "commands" ? (
                            <PluginsSection
                              mode="command"
                              initialScopeKey={pluginScopeKey}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                            />
                          ) : activeSection === "hooks" ? (
                            <HooksSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "workspaceFileSearch" ? (
                            <WorkspaceFileSearchSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : null}
                        </div>
                      </div>
                    </main>
                  </>
                </div>
              </SettingsBreadcrumbProvider>
              <Dialog open={pendingNavigation !== null} onOpenChange={open => { if (!open) setPendingNavigation(null); }}>
                <DialogContent>
                  <DialogHeader><DialogTitle>{activeSection === "personalization" ? "个性化有未保存的更改" : "模型设置有未保存的更改"}</DialogTitle></DialogHeader>
                  <p className="text-ui-base text-foreground-subtle">离开前保存配置，或明确丢弃本次修改。取消将继续编辑，不写入配置。</p>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setPendingNavigation(null)}>取消，继续编辑</Button>
                    <Button variant="ghost" onClick={() => { modelDraftActions?.discard(); setPendingNavigation(null); pendingNavigation?.(); }}>丢弃并离开</Button>
                    <Button disabled={modelDraftActions?.canSave === false} onClick={async () => { if (await modelDraftActions?.save()) { setPendingNavigation(null); pendingNavigation?.(); } }}>保存并离开</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </section>
        </div>
    </>
  );
}
