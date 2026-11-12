import { prototypeRecoveryScenario } from "./recovery.js";
import type { AIReqRelease } from "../types.js";

const createdAt = "2026-11-10T09:00:00.000Z";
// 共享数据库中按项目关联的 Release 清单内存投影。
// 每个项目独立维护，不实际执行文件写入、commit 或 push。
const releasesByProject = new Map<string, AIReqRelease[]>([
	["demo-aurora", [
		{ id: "release-2026-11", projectId: "demo-aurora", title: "2026.11 · 体验优化", createdAt },
		{ id: "release-2026-12", projectId: "demo-aurora", title: "2026.12 · 下一迭代（样例）", createdAt },
	]],
	["demo-mobile", [
		{ id: "mobile-release-2026-11", projectId: "demo-mobile", title: "2026.11 · 移动端优化", createdAt },
		{ id: "mobile-release-2026-12", projectId: "demo-mobile", title: "2026.12 · 离线体验", createdAt },
	]],
]);

if (prototypeRecoveryScenario === "empty-projects") releasesByProject.clear();
if (prototypeRecoveryScenario === "empty-releases") releasesByProject.set("demo-aurora", []);

export function readPrototypeProjectReleases(projectId?: string): AIReqRelease[] {
	return structuredClone(projectId ? releasesByProject.get(projectId) ?? [] : [...releasesByProject.values()].flat());
}
export function addPrototypeRelease(release: AIReqRelease): void {
	releasesByProject.set(release.projectId, [...(releasesByProject.get(release.projectId) ?? []), structuredClone(release)]);
}
