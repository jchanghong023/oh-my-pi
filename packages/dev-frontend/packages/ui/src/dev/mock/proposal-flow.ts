import type { DevRequirementGroup, DevMaterialView } from "./types.js";
import { prototypeMaterial } from "./materials.js";
import solution from "./proposal-solution.md?raw";

export const PROPOSAL_STATUS_LABELS = { draft: "草稿", "solution-ready": "方案完成", "requirements-pr": "PR 待合并", frozen: "正式需求", deleted: "已删除" };
export function hasCurrentProposalSolution(group: DevRequirementGroup): boolean {
 return Boolean(group.proposalSolution?.valid && group.proposalSolution.round === (group.proposalRound ?? 1));
}
export function prototypeProposalSolution(group: DevRequirementGroup): DevMaterialView {
 return prototypeMaterial({ projectId: group.projectId, irId: group.id, kind: "solution", path: `requirements/${group.id}/solution.md`, content: `# ${group.title} · 提案方案\n\n${solution}` });
}
