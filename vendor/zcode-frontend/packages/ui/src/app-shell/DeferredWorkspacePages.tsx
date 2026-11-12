import { lazy, type ComponentProps } from "react";
import { DeferredPage } from "@/components/DeferredPage.js";

const AutomationsSection = lazy(() => import("@/settings/AutomationsSection.js").then(module => ({ default: module.AutomationsSection })));

export function DeferredAutomationsSection(props: ComponentProps<typeof AutomationsSection>) {
  return <DeferredPage scope="automations"><AutomationsSection {...props} /></DeferredPage>;
}

