import type { DevSrPlanningInput, DevSystemRequirement, DevWorkflowView } from "./types.js";
import { readSrDependencies, srDependencyMap } from "./sr-dependencies.js";

/** 排期按项目时区 Asia/Shanghai 保存为带分钟的本地时间；不是工时统计。 */
export function planningDate(value?: string): string {
  return value ? `${value.slice(5, 10).replace("-", "/")} ${value.slice(11, 16)}` : "未排期";
}
export function irPlanning(srs: DevSystemRequirement[]): DevSrPlanningInput & { incomplete: boolean } {
  const starts = srs.flatMap(sr => sr.planning?.plannedStart ? [sr.planning.plannedStart] : []).sort();
  const ends = srs.flatMap(sr => sr.planning?.plannedEnd ? [sr.planning.plannedEnd] : []).sort();
  return { plannedStart: starts[0], plannedEnd: ends.at(-1), incomplete: !srs.length || starts.length !== srs.length || ends.length !== srs.length };
}
export function srDependencies(view: DevWorkflowView, sr: DevSystemRequirement): string[] {
  const group = [...view.groups, ...view.drafts].find(item => item.projectId === sr.projectId && item.id === sr.irId);
  return group ? srDependencyMap(group)[sr.id] ?? [] : [];
}
export function planningWarnings(view: DevWorkflowView, sr: DevSystemRequirement, plan = sr.planning): string[] {
  if (!plan?.plannedStart || !plan.plannedEnd) return ["计划时间尚未完整安排。"];
  const group = [...view.groups, ...view.drafts].find(item => item.projectId === sr.projectId && item.id === sr.irId);
  const issue = group && readSrDependencies(group).issue;
  if (issue) return [issue];
  const warnings: string[] = [];
  for (const dependency of srDependencies(view, sr)) {
    const before = view.srs.find(item => item.projectId === sr.projectId && item.id === dependency);
    if (!before) warnings.push(`前置 SR ${dependency} 未找到，需核对仓库依赖文档。`);
    else if (!before.planning?.plannedEnd) warnings.push(`前置「${before.title}」尚无计划结束时间。`);
    else if (plan.plannedStart < before.planning.plannedEnd) warnings.push(`计划早于前置「${before.title}」结束，需协调依赖排期。`);
  }
  if (plan.developerEmployeeId) {
    const overlap = view.srs.filter(item => item.id !== sr.id && item.planning?.developerEmployeeId === plan.developerEmployeeId && item.planning.plannedStart && item.planning.plannedEnd && item.planning.plannedStart < plan.plannedEnd! && item.planning.plannedEnd > plan.plannedStart!);
    if (overlap.length) warnings.push(`与 ${overlap.map(item => `「${item.title}」`).join("、")} 的人员排期重叠，需人工协调。`);
  }
  return warnings;
}
