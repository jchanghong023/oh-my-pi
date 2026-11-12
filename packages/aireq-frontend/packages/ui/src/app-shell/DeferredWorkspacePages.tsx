import { lazy, type ComponentProps } from "react";
import { DeferredPage } from "@/components/DeferredPage.js";

const AutomationsSection = lazy(() => import("@/settings/AutomationsSection.js").then(module => ({ default: module.AutomationsSection })));
const AIReqAutomations = lazy(() => import("@/aireq/AIReqAutomations.js").then(module => ({ default: module.AIReqAutomations })));
const AIReqSkillDesignPage = lazy(() => import("@/aireq/AIReqSkillDesignPage.js").then(module => ({ default: module.AIReqSkillDesignPage })));
const AIReqRequirementAnalysisPage = lazy(() => import("@/aireq/AIReqRequirementAnalysisPage.js").then(module => ({ default: module.AIReqRequirementAnalysisPage })));

export function DeferredAutomationsSection(props: ComponentProps<typeof AutomationsSection>) {
  return <DeferredPage scope="automations"><AutomationsSection {...props} /></DeferredPage>;
}

export function DeferredAIReqAutomations(props: ComponentProps<typeof AIReqAutomations>) {
  return <DeferredPage scope="aireq-automations"><AIReqAutomations {...props} /></DeferredPage>;
}

export function DeferredAIReqSkillDesignPage(props: ComponentProps<typeof AIReqSkillDesignPage>) {
  return <DeferredPage scope="aireq-skill-design"><AIReqSkillDesignPage {...props} /></DeferredPage>;
}

export function DeferredAIReqRequirementAnalysisPage(props: ComponentProps<typeof AIReqRequirementAnalysisPage>) {
  return <DeferredPage scope="aireq-requirement-analysis"><AIReqRequirementAnalysisPage {...props} /></DeferredPage>;
}
