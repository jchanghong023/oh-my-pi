export type PrototypeRequirementFilter = "all" | "developing" | "pending" | "completed";
interface SidebarPreferences {
	query: string;
	filter: PrototypeRequirementFilter;
	draftsOpen: boolean;
}
// 仅保存当前浏览器页面的查看偏好，不是项目配置、执行授权或工作流状态。
const preferences = new Map<string, SidebarPreferences>();
export function readPrototypeSidebarPreferences(key: string): SidebarPreferences {
	return { query: "", filter: "all", draftsOpen: false, ...preferences.get(key) };
}
export function updatePrototypeSidebarPreferences(key: string, patch: Partial<SidebarPreferences>): void {
	preferences.set(key, { ...readPrototypeSidebarPreferences(key), ...patch });
}
