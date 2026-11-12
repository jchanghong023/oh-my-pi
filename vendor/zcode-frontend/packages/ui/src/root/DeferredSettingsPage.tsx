import { lazy, type ComponentProps } from "react";
import { DeferredPage } from "@/components/DeferredPage.js";

const SettingsPage = lazy(() => import("@/SettingsPage.js").then(module => ({ default: module.SettingsPage })));

/** 所有设置入口共用懒加载边界，避免另一条静态引用重新拉入整页。 */
export function DeferredSettingsPage(props: ComponentProps<typeof SettingsPage>) {
  return <DeferredPage scope="deferred-settings"><SettingsPage {...props} /></DeferredPage>;
}
