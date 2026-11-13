import { getEmployeeId } from "./identity.js";

export type AIReqRequirementFilter = "all" | "developing" | "pending" | "completed";
interface SidebarPreferences {
	query: string;
	filter: AIReqRequirementFilter;
	formalSectionOpen: boolean;
	proposalSectionOpen: boolean;
	expandedIrIds: string[];
	proposalList: { phase: string; proposer: string; intake: "all" | "attention"; sort: string };
}
// 仅在本页保留导航选择；刷新恢复默认筛选、排序、栏目展开及 IR 子项收起。
const preferences = new Map<string, SidebarPreferences>();
function storageKey(key: string): string { return `aireq-sidebar:${getEmployeeId()}:${key}`; }
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


// 整体导航开合独立于列表筛选；按后端及工号保存，浏览器外观偏好不写业务库。
const sidebarVisibility = new Map<string, boolean>();
export function readSidebarVisibility(backendId: string): boolean {
 const key = storageKey(`visible:${backendId}`);
 const cached = sidebarVisibility.get(key);
 if (cached !== undefined) return cached;
 let visible = false;
 try { visible = globalThis.__ompAIReqLocalStorage.getItem(key) === "true"; } catch { /* 存储不可用时默认收起。 */ }
 sidebarVisibility.set(key, visible);
 return visible;
}
export function saveSidebarVisibility(backendId: string, visible: boolean): void {
 const key = storageKey(`visible:${backendId}`);
 sidebarVisibility.set(key, visible);
 try { globalThis.__ompAIReqLocalStorage.setItem(key, String(visible)); } catch { /* 本页及重新挂载仍保留内存选择。 */ }
}
