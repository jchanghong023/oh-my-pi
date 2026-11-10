import type { DevRelease } from "./types.js";

const createdAt = "2026-11-10T09:00:00.000Z";
// 各项目自己 Git 仓库中 Release 清单的内存投影；不属于 OMP 个人配置。
// 每个项目独立维护，不实际执行文件写入、commit 或 push。
const releasesByProject = new Map<string, DevRelease[]>([
	["demo-aurora", [
		{ id: "release-2026-11", projectId: "demo-aurora", title: "2026.11 · 体验优化", createdAt },
		{ id: "release-2026-12", projectId: "demo-aurora", title: "2026.12 · 下一迭代（样例）", createdAt },
	]],
	["demo-mobile", [
		{ id: "mobile-release-2026-11", projectId: "demo-mobile", title: "2026.11 · 移动端优化", createdAt },
		{ id: "mobile-release-2026-12", projectId: "demo-mobile", title: "2026.12 · 离线体验", createdAt },
	]],
]);

export function readPrototypeProjectReleases(projectId?: string): DevRelease[] {
	return structuredClone(projectId ? releasesByProject.get(projectId) ?? [] : [...releasesByProject.values()].flat());
}
export function addPrototypeRelease(release: DevRelease): void {
	releasesByProject.set(release.projectId, [...(releasesByProject.get(release.projectId) ?? []), structuredClone(release)]);
}
