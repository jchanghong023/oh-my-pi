import type { DevRequirementGroup, DevMaterialView } from "../types.js";
import { prototypeMaterial } from "./materials.js";
import { prototypeChangeRoot } from "./proposal-storage.js";
import solution from "./proposal-solution.md?raw";

export function prototypeProposalSolution(group: DevRequirementGroup): DevMaterialView {
 return prototypeMaterial({ projectId: group.projectId, irId: group.id, kind: "solution", path: `${prototypeChangeRoot(group.id)}/design.md`, content: `# ${group.title} · 提案方案 · design.md\n\n${solution}\n\n## SR 实施顺序与依赖（样例）\n${group.srIds.map(id => `- ${group.snapshot?.srs.find(sr => sr.id === id)?.title ?? id}：${(group.srDependencies?.[id] ?? []).map(dependency => group.snapshot?.srs.find(sr => sr.id === dependency)?.title ?? dependency).join("、") || "无前置依赖，可与其他独立 SR 并行"}`).join("\n")}\n\n同仓库单 IR，默认最多两个依赖就绪的 SR 并行；前置 SR 合并并核验后才能开始后继。` });
}
