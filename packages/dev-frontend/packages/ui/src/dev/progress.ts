import type { DevRequirementGroup, DevSystemRequirement, DevWorkflowView } from "./types.js";

export const PROGRESS_STATUSES = ["待开发", "开发中", "待合入", "待验收", "已完成"] as const;
export type DevProgressStatus = (typeof PROGRESS_STATUSES)[number];

export function srProgress(sr: DevSystemRequirement): number {
  return Math.min(sr.progress?.percent ?? 0, sr.progress?.merged ? 100 : 99);
}
export function progressLabel(percent: number): string {
  return `${percent === 100 ? 100 : Math.min(99.9, Math.round(percent * 10) / 10)}%`;
}
export function irSrs(view: DevWorkflowView, group: DevRequirementGroup): DevSystemRequirement[] {
  return view.srs.filter(sr => sr.projectId === group.projectId && sr.irId === group.id);
}
export function irProgress(srs: DevSystemRequirement[]): number {
  return srs.length ? srs.reduce((sum, sr) => sum + srProgress(sr), 0) / srs.length : 0;
}
export function srProgressStatus(sr: DevSystemRequirement): DevProgressStatus {
  const percent = srProgress(sr);
  if (percent === 100) return "已完成";
  if (sr.progress?.merged) return "待验收";
  if (percent === 0) return "待开发";
  return sr.progress?.certain ? "待合入" : "开发中";
}
export function irProgressStatus(srs: DevSystemRequirement[]): DevProgressStatus {
  if (!srs.length || srs.every(sr => srProgress(sr) === 0)) return "待开发";
  const statuses = srs.map(srProgressStatus);
  if (statuses.every(status => status === "已完成")) return "已完成";
  if (statuses.some(status => status === "待开发" || status === "开发中")) return "开发中";
  return statuses.includes("待合入") ? "待合入" : "待验收";
}
