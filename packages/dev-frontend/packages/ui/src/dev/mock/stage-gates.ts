import type { DevSelection, DevMaterialView, DevStageMaterial, DevSystemRequirement, DevWorkflowStage } from "./types.js";
export const STAGE_MATERIAL_KINDS: Record<DevWorkflowStage, DevStageMaterial["kind"][]> = {
 planning: ["plan"], executing: ["completion", "ut", "st"], pr: ["delivery"],
};
/** 检查原型材料快照完整性，不将样例报告当作真实验证通过。 */
export function prototypeStageMaterialBlocker(sr: DevSystemRequirement, materials: DevMaterialView[]): string | undefined {
 if (!sr.stage || !sr.materialDigest) return "尚无当前轮次的阶段材料，请先生成材料样例。";
 const files = sr.materials.filter(item => item.valid && item.stage === sr.stage && item.round === sr.round);
 if (!STAGE_MATERIAL_KINDS[sr.stage].every(kind => files.some(item => item.kind === kind))) return "当前阶段材料不完整，请先生成本轮材料样例。";
 if (files.some(file => !materials.some(item => item.projectId === sr.projectId && item.irId === sr.irId && item.srId === sr.id && item.path === file.path && item.valid && !item.error && item.content !== undefined && item.sha256 === file.sha256 && item.size === file.size))) return "材料版本已变化，请重新生成并确认本轮材料。";
}

export function prototypeStageView(sr: DevSystemRequirement, selection: DevSelection) {
 const stage = selection.stage ?? sr.stage;
 const round = selection.stageRound ?? (stage === sr.stage ? sr.round : Math.max(0, ...sr.sessions.filter(item => item.phase === stage).map(item => item.round)));
 return { stage, round, isCurrent: sr.status === "developing" && stage === sr.stage && round === sr.round };
}
