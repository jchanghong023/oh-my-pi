import type { DevProject } from "./types.js";

interface PrototypeProjectSettings { projects: DevProject[] }
const createdAt = "2026-11-10T09:00:00.000Z";

function project(id: string, name: string, root: string): DevProject {
	return { id, name, root, commonDir: `${root}/.git`, revision: 1, createdAt, updatedAt: createdAt,
		defaultBranch: "main", remote: "origin", repositoryId: `sample-repository-${id}` };
}

const projects = [project("demo-aurora", "Aurora 协作控制台", "/demo/aurora-console"), project("demo-mobile", "Mobile 移动工作台", "/demo/mobile-console")];
// OMP 个人目录只登记当前 Dev 管理哪些项目；不保存项目的 Release。
// 仅为内存演示，不访问 ~/.omp 或真实项目目录。
let settings: PrototypeProjectSettings = {
	projects,
};

export function readPrototypeProjectSettings(): PrototypeProjectSettings {
	return structuredClone(settings);
}
export function addPrototypeProject(input: { id: string; name: string; root: string; branch: string }): void {
	settings = { ...settings, projects: [...settings.projects, { ...project(input.id, input.name, input.root), defaultBranch: input.branch }] };
}
