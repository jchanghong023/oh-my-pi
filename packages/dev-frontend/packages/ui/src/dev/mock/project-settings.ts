import { prototypeRecoveryScenario } from "./recovery.js";
import { getEmployeeId } from "../identity.js";
import { checkPrototypeProjectDirectory, prototypeRepositoryRoot } from "./project-directories.js";
import type { DevProject } from "../types.js";

interface PrototypeProjectSettings { projects: DevProject[] }
const createdAt = "2026-11-10T09:00:00.000Z";

function project(id: string, name: string, root: string): DevProject {
	return { id, name, storageName: root.split("/").filter(Boolean).at(-1)!, root, commonDir: `${root}/.git`, revision: 1, createdAt, updatedAt: createdAt,
		defaultBranch: "main", remote: "origin", repositoryId: `sample-repository-${id}` };
}

const projects = [project("demo-aurora", "Aurora 协作控制台", "/demo/aurora-console"), project("demo-mobile", "Mobile 移动工作台", "/demo/mobile-console")];
// 共享数据库项目表的内存投影；不访问真实 SQLite 或项目目录。
let settings: PrototypeProjectSettings = {
	projects: prototypeRecoveryScenario === "empty-projects" ? [] : projects,
};

export function readPrototypeProjectSettings(): PrototypeProjectSettings {
	return structuredClone(settings);
}
export function addPrototypeProject(input: { id: string; name: string; root: string; branch: string }): void {
	settings = { ...settings, projects: [...settings.projects, { ...project(input.id, input.name, input.root), defaultBranch: input.branch }] };
}

export function checkPrototypeSharedProjectDirectory(path: string, projectId: string) {
  const project = settings.projects.find(item => item.id === projectId);
  if (!project) return { valid: false as const, error: "请选择已有项目。" };
  const check = checkPrototypeProjectDirectory(path, settings.projects.filter(item => item.id !== projectId).map(item => item.root));
  if (!check.valid) return check;
  if (prototypeRepositoryRoot(check.root) !== prototypeRepositoryRoot(project.root)) return { valid: false as const, error: "新路径必须属于当前项目的同一 Git 仓库，不能用其他仓库替换已有项目。" };
  return check;
}
export function updatePrototypeSharedProjectRoot(projectId: string, root: string): void {
  if (getEmployeeId() !== "j00808874") throw new Error("只有管理员 j00808874 可修改共享项目路径。");
  const check = checkPrototypeSharedProjectDirectory(root, projectId);
  if (!check.valid) throw new Error(check.error);
  settings = { ...settings, projects: settings.projects.map(item => item.id === projectId ? { ...item, root: check.root, commonDir: `${check.root}/.git`, revision: item.revision + 1, updatedAt: new Date().toISOString() } : item) };
}

// 按工号和共享项目关联；不是服务账号的 OMP profile，也不修改共享 root。
const developmentRoots = new Map<string, string>([["j00808874:demo-aurora", "/demo/j00808874/aurora-console"]]);
export function readPrototypeDevelopmentRoot(projectId: string, employeeId = getEmployeeId()): string | undefined {
	return developmentRoots.get(`${employeeId}:${projectId}`);
}
export function savePrototypeDevelopmentRoot(projectId: string, root: string, employeeId = getEmployeeId()): void {
	developmentRoots.set(`${employeeId}:${projectId}`, root);
}
