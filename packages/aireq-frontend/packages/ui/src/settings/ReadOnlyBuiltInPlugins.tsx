import { useState } from "react";
import { ChevronDown, LockKeyhole, Monitor, Plus, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import catalog from "./builtInPluginCatalog.json";

/** Static ZCode catalog, not installed inventory. Never mounts plugin services. */
export function ReadOnlyBuiltInPlugins() {
  const { intl, locale } = useZCodeIntl();
  const zh = locale === "zh-CN";
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const items = catalog.filter(item => [item.name, item.nameZh, item.description, item.descriptionZh].join(" ").toLocaleLowerCase().includes(search));
  return <div className="@container/plugin-store space-y-6">
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <Button type="button" variant="outline" className="rounded-full pl-2.5 pr-1.5" disabled>
        <Monitor className="size-4" aria-hidden="true" />
        {intl.formatMessage({ id: "settings.plugin.scope.user" })}
        <ChevronDown className="size-4 text-foreground-subtlest" aria-hidden="true" />
      </Button>
      <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
      <div className="flex h-7 items-center gap-1.5 text-ui-base font-medium">
        {intl.formatMessage({ id: "settings.plugins.title" })}
        <span className="text-ui-sm font-normal text-foreground-subtle">{catalog.length}</span>
      </div>
      <SettingsSearchInput containerClassName="w-full sm:ml-auto sm:w-64" value={query}
        onChange={event => setQuery(event.target.value)} onClear={() => setQuery("")}
        clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
        aria-label={intl.formatMessage({ id: "settings.plugin.plugins.searchPlaceholder" })}
        placeholder={intl.formatMessage({ id: "settings.plugin.plugins.searchPlaceholder" })} />
    </div>
    <section className="space-y-4" aria-label={intl.formatMessage({ id: "settings.plugin.plugins.builtIn" })}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium">
          {intl.formatMessage({ id: "settings.plugin.plugins.builtIn" })}
          <span className="text-ui-sm font-normal text-foreground-subtle">{items.length}</span>
          <Badge variant="outline" className="ml-1 gap-1 font-normal"><LockKeyhole className="size-3" aria-hidden="true" />{zh ? "只读" : "Read only"}</Badge>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="icon-md" disabled aria-label={intl.formatMessage({ id: "common.refresh" })}><RefreshCcw aria-hidden="true" /></Button>
          <Button type="button" variant="outline" disabled>{intl.formatMessage({ id: "chat.plugins.browseMarketplace" })}</Button>
          <Button type="button" disabled><Plus data-icon="inline-start" aria-hidden="true" />{intl.formatMessage({ id: "pluginCreator.add" })}</Button>
        </div>
      </div>
      <p className="text-ui-sm text-foreground-subtle">{zh ? "ZCode 内置插件目录，仅供查看。" : "ZCode built-in plugin catalog. View only."}</p>
      {items.length ? <ul className="grid grid-cols-1 gap-x-6 gap-y-1 @min-[40rem]/plugin-store:grid-cols-2">
        {items.map(item => <li key={item.id} className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-3" data-plugin-id={item.id}>
          <PluginStoreAvatar item={{ id: item.id, name: item.name }} className="size-10" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui-base font-medium leading-5 text-foreground" title={zh ? item.nameZh : item.name}>{zh ? item.nameZh : item.name}</p>
            <p className="mt-0.5 truncate text-ui-caption leading-5 text-foreground-subtle" title={zh ? item.descriptionZh : item.description}>{zh ? item.descriptionZh : item.description}</p>
          </div>
        </li>)}
      </ul> : <p role="status" className="py-8 text-center text-ui-base text-foreground-subtle">{zh ? "没有匹配的插件。" : "No matching plugins."}</p>}
    </section>
  </div>;
}
