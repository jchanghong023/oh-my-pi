import { getEmployeeId } from "./identity.js";

export type DevRequirementFilter = "all" | "developing" | "pending" | "completed";
interface SidebarPreferences {
	query: string;
	filter: DevRequirementFilter;
	formalSectionOpen: boolean;
	proposalSectionOpen: boolean;
	expandedIrIds: string[];
	proposalList: { phase: string; proposer: string; intake: "all" | "attention"; sort: string };
}
// 仅在本页保留导航选择；刷新恢复默认筛选、排序、栏目展开及 IR 子项收起。
const preferences = new Map<string, SidebarPreferences>();
function storageKey(key: string): string { return `dev-sidebar:${getEmployeeId()}:${key}`; }
export function readSidebarPreferences(key: string): SidebarPreferences {
 const scoped = storageKey(key);
 const cached = preferences.get(scoped);
 if (cached) return structuredClone(cached);
 const result: SidebarPreferences = { query: "", filter: "all", formalSectionOpen: true, proposalSectionOpen: true, expandedIrIds: [], proposalList: { phase: "all", proposer: "all", intake: "all", sort: "updated" } };
 preferences.set(scoped, result);
 return structuredClone(result);
}
export function updateSidebarPreferences(key: string, patch: Partial<SidebarPreferences>): void {
 const next = { ...readSidebarPreferences(key), ...patch };
 preferences.set(storageKey(key), next);
}
