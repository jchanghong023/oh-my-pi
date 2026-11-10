import type { DevRequirementGroup, DevMaterialView } from "./types.js";
import { prototypeMaterial } from "./materials.js";
import { prototypeChangeRoot } from "./proposal-storage.js";
import solution from "./proposal-solution.md?raw";

export const PROPOSAL_STATUS_LABELS = { draft: "草稿", "solution-ready": "方案完成", "requirements-pr": "PR 待合并", formal: "正式提案", frozen: "开发已冻结", deleted: "已删除" };
export function hasCurrentProposalSolution(group: DevRequirementGroup): boolean {
 const solution = group.proposalSolution;
 if (!solution?.valid || !group.snapshot?.digest || solution.round !== (group.proposalRound ?? 1) || solution.requirementsDigest !== group.snapshot.digest) return false;
 const root = prototypeChangeRoot(group.id);
 const required = [`${root}/proposal.md`, ...group.snapshot.srs.map(sr => sr.documentPath), `${root}/design.md`];
 return group.documentPath === required[0] && solution.path === `${root}/design.md` && group.snapshot.srs.length === group.srIds.length && group.srIds.every(id => group.snapshot!.srs.some(sr => sr.id === id)) && required.every(path => group.files.some(file => file.path === path));
}
export function prototypeProposalSolution(group: DevRequirementGroup): DevMaterialView {
 return prototypeMaterial({ projectId: group.projectId, irId: group.id, kind: "solution", path: `${prototypeChangeRoot(group.id)}/design.md`, content: `# ${group.title} · 提案方案 · design.md\n\n${solution}\n\n## SR 实施顺序与依赖（样例）\n${group.srIds.map(id => `- ${group.snapshot?.srs.find(sr => sr.id === id)?.title ?? id}：${(group.srDependencies?.[id] ?? []).map(dependency => group.snapshot?.srs.find(sr => sr.id === dependency)?.title ?? dependency).join("、") || "无前置依赖，可与其他独立 SR 并行"}`).join("\n")}\n\n同仓库单 IR，默认最多两个依赖就绪的 SR 并行；前置 SR 合并并核验后才能开始后继。` });
}
