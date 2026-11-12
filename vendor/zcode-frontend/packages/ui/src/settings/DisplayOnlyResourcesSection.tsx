import { ReadOnlyBuiltInPlugins } from "@/settings/ReadOnlyBuiltInPlugins.js";
import { ChevronDown, Monitor, Plus, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginInstallEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";

/** 仅复用资源管理页外观，不挂载作用域、插件、模型或子智能体服务。 */
export function DisplayOnlyResourcesSection({ kind }: { kind: "plugin" | "subagents" }) {
  const { intl } = useZCodeIntl();
  if (kind === "plugin") return <ReadOnlyBuiltInPlugins />;
  const titleId = "settings.subagents.title";
  const groups = ["settings.subagents.group.user", "settings.subagents.group.builtIn"];

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="default" className="rounded-full pl-2.5 pr-1.5" disabled>
            <Monitor className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugin.scope.user" })}
            <ChevronDown className="size-4 text-foreground-subtlest" aria-hidden="true" />
          </Button>
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground">
            <span>{intl.formatMessage({ id: titleId })}</span>
            <span className="text-ui-sm text-foreground-subtle">—</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          value=""
          disabled
          aria-label={intl.formatMessage({ id: "settings.subagents.searchPlaceholder" })}
          placeholder={intl.formatMessage({ id: "settings.subagents.searchPlaceholder" })}
        />
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.displayOnly.description" })}
      </p>
      {groups.map((groupId, index) => (
        <section key={groupId} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: groupId })}
              <span className="text-ui-sm font-normal text-foreground-subtle">—</span>
            </h3>
            {index === 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="icon-md" disabled aria-label={intl.formatMessage({ id: "common.refresh" })}>
                  <RefreshCcw aria-hidden="true" />
                </Button>
                <Button type="button" disabled>
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.create.action" })}
                </Button>
              </div>
            ) : null}
          </div>
          <PluginInstallEmptyState
            title={intl.formatMessage({ id: "settings.displayOnly.inventoryTitle" })}
            description={intl.formatMessage({ id: "settings.displayOnly.inventoryDescription" })}
            actions={null}
          />
        </section>
      ))}
    </div>
  );
}
