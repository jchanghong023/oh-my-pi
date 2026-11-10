import { getPrototypeEmployeeId } from "./employee.js";
import type { DevProject } from "./types.js";

interface PrototypeProjectSettings { projects: DevProject[] }
const createdAt = "2026-11-10T09:00:00.000Z";

function project(id: string, name: string, root: string): DevProject {
	return { id, name, storageName: root.split("/").filter(Boolean).at(-1)!, root, commonDir: `${root}/.git`, revision: 1, createdAt, updatedAt: createdAt,
		defaultBranch: "main", remote: "origin", repositoryId: `sample-repository-${id}` };
}

const projects = [project("demo-aurora", "Aurora 协作控制台", "/demo/aurora-console"), project("demo-mobile", "Mobile 移动工作台", "/demo/mobile-console")];
// 共享数据库项目表的内存投影；不访问真实 SQLite 或项目目录。
let settings: PrototypeProjectSettings = {
	projects,
};

export function readPrototypeProjectSettings(): PrototypeProjectSettings {
	return structuredClone(settings);
}
export function addPrototypeProject(input: { id: string; name: string; root: string; branch: string }): void {
	settings = { ...settings, projects: [...settings.projects, { ...project(input.id, input.name, input.root), defaultBranch: input.branch }] };
}

// 按工号和共享项目关联；不是服务账号的 OMP profile，也不修改共享 root。
const developmentRoots = new Map<string, string>([["j00808874:demo-aurora", "/demo/j00808874/aurora-console"]]);
export function readPrototypeDevelopmentRoot(projectId: string, employeeId = getPrototypeEmployeeId()): string | undefined {
	return developmentRoots.get(`${employeeId}:${projectId}`);
}
export function savePrototypeDevelopmentRoot(projectId: string, root: string, employeeId = getPrototypeEmployeeId()): void {
	developmentRoots.set(`${employeeId}:${projectId}`, root);
}
