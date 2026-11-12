import type { DevMaterialView, DevRequirementGroup } from "./types.js";

export interface DevSrDependencyDocument { srs: { srId: string; estimate: { workingDays: number; assumptions: string }; prerequisites: { srId: string; reason: string }[] }[] }

/** Read the repository material, never the legacy group/SR dependency metadata. */
export function readSrDependencies(group: DevRequirementGroup, material = group.srDependencyFile): { document?: DevSrDependencyDocument; issue?: string } {
 const root = group.documentPath.replace(/proposal\.md$/, "");
 if (!material || material.path !== `${root}sr-dependencies.json` || material.round !== (group.proposalRound ?? 1) || !material.valid || material.error || !material.content) return { issue: "sr-dependencies.json 缺失、失效、过期或不可读取，请重新生成本轮方案。" };
 let value: DevSrDependencyDocument;
 try { value = JSON.parse(material.content); } catch { return { issue: "sr-dependencies.json 不是有效 JSON。" }; }
 if (!value || !Array.isArray(value.srs) || value.srs.length !== group.srIds.length || new Set(value.srs.map(row => row?.srId)).size !== group.srIds.length || value.srs.some(row => !row || !group.srIds.includes(row.srId) || !Array.isArray(row.prerequisites) || row.prerequisites.some(item => !item || typeof item.srId !== "string" || !group.srIds.includes(item.srId) || typeof item.reason !== "string" || !item.reason.trim()) || new Set(row.prerequisites.map(item => item.srId)).size !== row.prerequisites.length)) return { issue: "sr-dependencies.json 必须覆盖全部 SR，并使用本 IR 的稳定 SR ID 和非空依赖原因。" };
 if (value.srs.some(row => !row.estimate || !Number.isFinite(row.estimate.workingDays) || row.estimate.workingDays <= 0 || typeof row.estimate.assumptions !== "string" || !row.estimate.assumptions.trim())) return { issue: "sr-dependencies.json 中每个 SR 须包含正数工期预估（工作日）及预估假设。" };
 const visiting = new Set<string>(); const visited = new Set<string>();
 const inspect = (id: string): boolean => {
  if (visiting.has(id)) return true;
  if (visited.has(id)) return false;
  visiting.add(id);
  if (value.srs.find(row => row.srId === id)!.prerequisites.some(item => inspect(item.srId))) return true;
  visiting.delete(id); visited.add(id); return false;
 };
 if (group.srIds.some(inspect)) return { issue: "SR 依赖存在循环或自依赖，请修正本轮 sr-dependencies.json。" };
 return { document: value };
}

export function srDependencyMap(group: DevRequirementGroup): Record<string, string[]> {
 return Object.fromEntries(readSrDependencies(group).document?.srs.map(row => [row.srId, row.prerequisites.map(item => item.srId)]) ?? []);
}

export function proposalDependencyMaterialIssue(group: DevRequirementGroup, materials: DevMaterialView[]): string | undefined {
 const material = materials.find(item => item.projectId === group.projectId && item.irId === group.id && item.path === group.srDependencyFile?.path);
 const issue = readSrDependencies(group, material).issue;
 if (!material) return "sr-dependencies.json 材料缺失。";
 if (issue) return issue;
 if (!group.srDependencyFile || material.content !== group.srDependencyFile.content || material.sha256 !== group.srDependencyFile.sha256 || material.size !== group.srDependencyFile.size) return "sr-dependencies.json 版本已变化，请重新生成并确认本轮方案。";
}
export function parallelSrIds(group: DevRequirementGroup, srId: string): string[] {
 const result = readSrDependencies(group);
 if (result.issue) return [];
 const graph = Object.fromEntries(result.document!.srs.map(row => [row.srId, row.prerequisites.map(item => item.srId)]));
 const related = (from: string, to: string): boolean => (graph[from] ?? []).some(id => id === to || related(id, to));
 return group.srIds.filter(id => id !== srId && !related(srId, id) && !related(id, srId));
}

