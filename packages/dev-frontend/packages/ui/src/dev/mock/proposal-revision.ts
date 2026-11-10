import type { DevRequirementGroup, DevWorkflowView } from "./types.js";

export function prototypeProposalRevisionBlocker(view: DevWorkflowView, group: DevRequirementGroup): string | undefined {
 if (!view.groups.some(item => item.id === group.id && item.projectId === group.projectId) || !group.merge || !group.snapshot || group.status !== "formal") return "仅已入库且尚未开发的正式提案可以开始修订。";
 if (group.freeze || group.developmentStartedAt || group.acceptance || view.srs.some(sr => sr.projectId === group.projectId && sr.irId === group.id && sr.status !== "pending")) return "本 IR 已开始开发或冻结，不能修订原需求；业务或方案变化须重新提案。";
}
