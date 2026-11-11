import { getEmployeeId } from "./identity.js";

export type DevRequirementFilter = "all" | "developing" | "pending" | "completed";
interface SidebarPreferences {
	query: string;
	filter: DevRequirementFilter;
	formalSectionOpen: boolean;
	proposalSectionOpen: boolean;
	expandedIrIds: string[];
}
// 仅在本页保留手动展开选择；刷新恢复栏目展开、IR 子项收起，不复原旧 SR 树。
const preferences = new Map<string, SidebarPreferences>();
function storageKey(key: string): string { return `dev-sidebar:${getEmployeeId()}:${key}`; }
export function readSidebarPreferences(key: string): SidebarPreferences {
 const scoped = storageKey(key);
 const cached = preferences.get(scoped);
 if (cached) return structuredClone(cached);
 const result: SidebarPreferences = { query: "", filter: "all", formalSectionOpen: true, proposalSectionOpen: true, expandedIrIds: [] };
 preferences.set(scoped, result);
 return structuredClone(result);
}
export function updateSidebarPreferences(key: string, patch: Partial<SidebarPreferences>): void {
 const next = { ...readSidebarPreferences(key), ...patch };
 preferences.set(storageKey(key), next);
}
