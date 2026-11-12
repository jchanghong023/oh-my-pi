import { Keyboard, RotateCcw } from "lucide-react";
import { SHORTCUT_COMMANDS } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ShortcutBindingRow } from "@/settings/ShortcutBindingRow.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";

/** 所有行操作均禁用；复用原生行组件但不挂载录制、保存或平台事件。 */
function ignoreShortcutEdit() {}

/** 只展示源码默认键位，不读取用户配置，不改变实际快捷键或键盘监听。 */
export function ShortcutSettingsSection({ isDesktop = false }: { isDesktop?: boolean }) {
  const { intl } = useZCodeIntl();
  const visibleCommands = SHORTCUT_COMMANDS.filter((entry) => {
    if (entry.id === "openOnboarding" || entry.id === "toggleInterfaceMode") return false;
    return entry.id !== "toggleSidePaneFullView" || isDesktop;
  });

  return (
    <div className="min-w-0 space-y-6" data-testid="settings-shortcuts-section">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button variant="outline" disabled data-testid="settings-shortcut-reset-all">
          <RotateCcw className="size-3.5" />
          {intl.formatMessage({ id: "settings.shortcuts.resetAll" })}
        </Button>
        <SettingsSearchInput
          containerClassName="w-full min-w-0 sm:ml-auto sm:w-64"
          placeholder={intl.formatMessage({ id: "settings.shortcuts.searchPlaceholder" })}
          aria-label={intl.formatMessage({ id: "settings.shortcuts.searchPlaceholder" })}
          value=""
          disabled
          data-testid="settings-shortcut-search-input"
          trailingAction={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "settings.shortcuts.keySearchAria" })}
              aria-pressed={false}
              data-testid="settings-shortcut-key-search"
              className="rounded-full text-foreground-subtle"
              disabled
            >
              <Keyboard className="size-4" aria-hidden="true" />
            </Button>
          }
        />
      </div>
      <div className="min-w-0 rounded-xl border border-card-border">
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_40px] rounded-t-xl bg-surface sm:grid px-4 py-3 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderCommand" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderBinding" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderScope" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderActions" })}</span>
        </div>
        {visibleCommands.map((entry) => (
          <ShortcutBindingRow
            key={entry.id}
            entry={entry}
            commandLabel={intl.formatMessage({ id: `settings.shortcuts.command.${entry.id}` })}
            bindings={entry.defaultBindings}
            saving
            isOverridden={false}
            isRecording={false}
            recording={null}
            menuChannelUnavailable={entry.channel === "menu" && !isDesktop}
            onRecord={ignoreShortcutEdit}
            onSteal={ignoreShortcutEdit}
            onClearAll={ignoreShortcutEdit}
          />
        ))}
      </div>
    </div>
  );
}
