import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import { getEmployeeId } from "./identity.js";

export type DevRequirementFilter = "all" | "developing" | "pending" | "completed";
interface SidebarPreferences {
	query: string;
	filter: DevRequirementFilter;
	formalSectionOpen: boolean;
	proposalSectionOpen: boolean;
	expandedIrIds: string[];
	lastViewedTarget?: string;
}
// 仅保存当前浏览器的查看偏好，不是共享配置、执行授权或工作流状态。
const preferences = new Map<string, SidebarPreferences>();
function storageKey(key: string): string { return `dev-sidebar:${getEmployeeId()}:${key}`; }
export function readSidebarPreferences(key: string): SidebarPreferences {
 const scoped = storageKey(key);
 const cached = preferences.get(scoped);
 if (cached) return structuredClone(cached);
 const result: SidebarPreferences = { query: "", filter: "all", formalSectionOpen: true, proposalSectionOpen: true, expandedIrIds: [] };
 try {
  const saved: unknown = JSON.parse(readSafeLocalStorage(scoped) ?? "null");
  if (saved && typeof saved === "object") {
   const value = saved as Partial<SidebarPreferences>;
   if (typeof value.formalSectionOpen === "boolean") result.formalSectionOpen = value.formalSectionOpen;
   if (typeof value.proposalSectionOpen === "boolean") result.proposalSectionOpen = value.proposalSectionOpen;
   if (Array.isArray(value.expandedIrIds)) result.expandedIrIds = value.expandedIrIds.filter((id): id is string => typeof id === "string");
   if (typeof value.lastViewedTarget === "string") result.lastViewedTarget = value.lastViewedTarget;
  }
 } catch { /* 偏好损坏时使用默认展开，不阻断需求查看。 */ }
 preferences.set(scoped, result);
 return structuredClone(result);
}
export function updateSidebarPreferences(key: string, patch: Partial<SidebarPreferences>): void {
 const next = { ...readSidebarPreferences(key), ...patch };
 preferences.set(storageKey(key), next);
 const { formalSectionOpen, proposalSectionOpen, expandedIrIds, lastViewedTarget } = next;
 writeSafeLocalStorage(storageKey(key), JSON.stringify({ formalSectionOpen, proposalSectionOpen, expandedIrIds, lastViewedTarget }));
}
