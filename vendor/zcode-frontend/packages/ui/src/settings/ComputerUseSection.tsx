import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** ZCode 电脑控制关闭状态的纯展示界面，不查询插件、权限或宿主设置。 */
export function ComputerUseSection() {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-5">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
          description={intl.formatMessage({ id: "settings.computerUse.toggleDescription" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
              checked={false}
              disabled
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
          description={intl.formatMessage({ id: "settings.computerUse.composerEntry.requiresEnabled" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
              checked={false}
              disabled
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
