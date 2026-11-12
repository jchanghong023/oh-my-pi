import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** ZCode 浏览器控制设置的纯展示界面；不读取或写入浏览器、插件或宿主配置。 */
export function BrowserSettingsSection() {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.browser.control.title" })}
            description={intl.formatMessage({ id: "settings.browser.control.description" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "settings.browser.control.title" })}
                checked={false}
                disabled
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.browser.import.title" })}
            description={intl.formatMessage({ id: "settings.browser.import.description" })}
            control={
              <Button type="button" size="lg" variant="outline" disabled className="min-w-24">
                {intl.formatMessage({ id: "settings.browser.import.action" })}
              </Button>
            }
          />
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.open.section" })}
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.browser.htmlClickOpensBrowser" })}
            description={intl.formatMessage({ id: "settings.browser.htmlClickOpensBrowserDescription" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "settings.browser.htmlClickOpensBrowser" })}
                checked={false}
                disabled
              />
            }
          />
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.security.section" })}
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.embeddedBrowserAllowInsecureCertificates" })}
            description={intl.formatMessage({ id: "settings.embeddedBrowserAllowInsecureCertificatesDescription" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "settings.embeddedBrowserAllowInsecureCertificates" })}
                checked={false}
                disabled
              />
            }
          />
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.data.section" })}
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.browser.clearCache.title" })}
            description={intl.formatMessage({ id: "settings.browser.clearCache.description" })}
            control={
              <Button type="button" size="lg" variant="outline" disabled className="min-w-24">
                {intl.formatMessage({ id: "settings.browser.clearCache.action" })}
              </Button>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.browser.clearAll.title" })}
            description={intl.formatMessage({ id: "settings.browser.clearAll.description" })}
            control={
              <Button type="button" size="lg" variant="destructive" disabled className="min-w-24">
                {intl.formatMessage({ id: "settings.browser.clearAll.action" })}
              </Button>
            }
          />
        </SettingsGroupCard>
      </section>
    </div>
  );
}
