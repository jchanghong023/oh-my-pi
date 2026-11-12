import { lazy, type ComponentProps } from "react";
import { DeferredPage } from "@/components/DeferredPage.js";

const AutomationsSection = lazy(() => import("@/settings/AutomationsSection.js").then(module => ({ default: module.AutomationsSection })));
const DevAutomations = lazy(() => import("@/dev/DevAutomations.js").then(module => ({ default: module.DevAutomations })));
const DevSkillDesignPage = lazy(() => import("@/dev/DevSkillDesignPage.js").then(module => ({ default: module.DevSkillDesignPage })));
const DevRequirementAnalysisPage = lazy(() => import("@/dev/DevRequirementAnalysisPage.js").then(module => ({ default: module.DevRequirementAnalysisPage })));

export function DeferredAutomationsSection(props: ComponentProps<typeof AutomationsSection>) {
  return <DeferredPage scope="automations"><AutomationsSection {...props} /></DeferredPage>;
}

export function DeferredDevAutomations(props: ComponentProps<typeof DevAutomations>) {
  return <DeferredPage scope="dev-automations"><DevAutomations {...props} /></DeferredPage>;
}

export function DeferredDevSkillDesignPage(props: ComponentProps<typeof DevSkillDesignPage>) {
  return <DeferredPage scope="dev-skill-design"><DevSkillDesignPage {...props} /></DeferredPage>;
}

export function DeferredDevRequirementAnalysisPage(props: ComponentProps<typeof DevRequirementAnalysisPage>) {
  return <DeferredPage scope="dev-requirement-analysis"><DevRequirementAnalysisPage {...props} /></DeferredPage>;
}

