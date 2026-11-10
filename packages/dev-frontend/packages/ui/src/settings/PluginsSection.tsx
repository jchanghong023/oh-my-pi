import { useCallback, useEffect, useState } from "react";
import {
  SettingsScopeDeviceProvider,
  SettingsScopeBlockedNotice,
  resolveSettingsScopeBlock,
  useSettingsScope,
} from "@/settings-scope/index.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { SkillsSection } from "@/settings/SkillsSection.js";
import { CommandsSection } from "@/settings/CommandsSection.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { PluginScopeMenu, getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { useTabStore } from "@/store/TabStoreProvider.js";

interface PluginsSectionProps {
  mode: "skill" | "command";
  initialScopeKey?: string;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenProjectSettings?: () => void;
}

export function PluginsSection({
  mode,
  initialScopeKey,
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onOpenProjectSettings,
}: PluginsSectionProps) {
  const { intl } = useZCodeIntl();
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const handleScopeFallback = useCallback(() => {
    toast(intl.formatMessage({ id: "settings.plugin.scopeUnavailableFallback" }));
  }, [intl]);
  const scope = useSettingsScope({
    workspacePath: workspacePath ?? activeWorkspacePath,
    workspaceIdentity: workspaceIdentity ?? activeWorkspaceIdentity ?? undefined,
    initialScopeKey,
    onFallback: handleScopeFallback,
  });
  const localScopeKey = scope.toLocalScopeKey(scope.selectedScopeKey);
  const userScope = scope.user;
  const userTarget = userScope.status === "ready" ? userScope.target : null;
  const userServices = userScope.status === "ready" ? userScope.unscopedServices : undefined;
  const userAuthorityKey = userScope.status === "ready" ? userScope.cacheAuthorityKey : undefined;
  const workspaceTabs = scope.deviceTargets;
  const resolution = scope.resolution;
  const isUserScope = resolution.status !== "ready" || resolution.kind !== "workspace";
  const target = !isUserScope && resolution.status === "ready" && resolution.kind === "workspace"
    ? resolution.target
    : userTarget;
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState<string | null>(null);
  const effectiveScopeKey = editorOpen && formScopeKey ? formScopeKey : localScopeKey;
  const editorWorkspace = workspaceTabs.find(
    (workspace) => getPluginWorkspaceKey(workspace) === effectiveScopeKey,
  );
  const editorWorkspaceMissing = Boolean(
    editorOpen && formScopeKey && formScopeKey !== "user" && !editorWorkspace,
  );
  const editorTarget = editorWorkspaceMissing ? null : (editorWorkspace ?? userTarget);
  useEffect(() => {
    if (!editorWorkspaceMissing) return;
    setEditorOpen(false);
    setFormScopeKey(null);
  }, [editorWorkspaceMissing]);
  const handleEditorOpenChange = useCallback((open: boolean) => {
    setEditorOpen(open);
    if (!open) setFormScopeKey(null);
  }, []);
  const blocked = resolveSettingsScopeBlock(scope, isUserScope);
  const titleId = mode === "skill"
    ? "settings.plugin.tab.skills"
    : "settings.plugin.tab.commands";

  return (
    <SettingsScopeDeviceProvider device={scope.device} userAvailable={userScope.status !== "unavailable"}>
      <div className="space-y-6">
        {!editorOpen ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <PluginScopeMenu
              align="start"
              groups={scope.groups}
              selectedScopeKey={scope.selectedScopeKey}
              selectedDevice={scope.device}
              onScopeKeyChange={scope.setSelectedScopeKey}
            />
            <div className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground">
              <span>{intl.formatMessage({ id: titleId })}</span>
              <span className="text-ui-sm text-foreground-subtle">{visibleCount}</span>
            </div>
            <SettingsSearchInput
              containerClassName="w-full sm:ml-auto sm:w-64"
              clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
              value={searchQuery}
              onClear={() => setSearchQuery("")}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={intl.formatMessage({
                id: mode === "skill"
                  ? "settings.skills.searchPlaceholder"
                  : "settings.commands.searchPlaceholder",
              })}
            />
          </div>
        ) : null}
        {blocked ? (
          <SettingsScopeBlockedNotice state={blocked} device={scope.device} />
        ) : mode === "skill" && target ? (
          <SkillsSection
            workspacePath={target.workspacePath}
            workspaceIdentity={target.workspaceIdentity}
            remoteSessionId={target.remoteSessionId}
            remoteTarget={target.remoteTarget}
            scopeFilter={isUserScope ? "user" : "workspace"}
            searchQuery={searchQuery}
            onCreateTask={onCreateTask}
            onOpenProjectSettings={onOpenProjectSettings}
            onReturnToUserScope={() => scope.setSelectedScopeKey(scope.toPageScopeKey("user"))}
            onDetailOpenChange={handleEditorOpenChange}
            onVisibleCountChange={setVisibleCount}
            unscopedServices={isUserScope ? userServices : undefined}
            cacheAuthorityKey={isUserScope ? userAuthorityKey : undefined}
          />
        ) : mode === "command" && editorTarget ? (
          <CommandsSection
            workspacePath={editorTarget.workspacePath}
            workspaceIdentity={editorTarget.workspaceIdentity}
            scopeFilter={effectiveScopeKey === "user" ? "user" : "workspace"}
            parentScopeKey={localScopeKey}
            workspaceTabs={workspaceTabs}
            searchQuery={searchQuery}
            onVisibleCountChange={setVisibleCount}
            onEditorOpenChange={handleEditorOpenChange}
            onFormScopeKeyChange={setFormScopeKey}
            unscopedServices={effectiveScopeKey === "user" ? userServices : undefined}
            cacheAuthorityKey={effectiveScopeKey === "user" ? userAuthorityKey : undefined}
          />
        ) : (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugin.noWorkspace" })}
          </div>
        )}
      </div>
    </SettingsScopeDeviceProvider>
  );
}
