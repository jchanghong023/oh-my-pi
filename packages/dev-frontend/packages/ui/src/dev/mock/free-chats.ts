import type { ProjectTask, VirtualProject, IServiceAccessor } from "@zcode/services";
import { getEmployeeId } from "../identity.js";
import { readPrototypeProjectSettings, readPrototypeDevelopmentRoot } from "./project-settings.js";
import { unavailablePrototypeOperation } from "./events.js";

export const FREE_CHAT_LIMIT = 5;
export const FREE_CHAT_PREFIX = "prototype-free:";
export const FREE_WORKSPACE_PREFIX = "dev-ui-prototype:free:";
interface FreeChat { meta: ProjectTask; empty: boolean; deleted: boolean }
const records = new Map<string, FreeChat>();
const seeded = new Set<string>();
const hiddenProjects = new Set<string>();
const pins = new Set<string>();
const listeners = new Set<() => void>();
// 当前页面查看范围，不是后端全局 current project 或项目登记权威。
let viewedProjectId: string | undefined;
export function setPrototypeFreeProject(projectId?: string): void { if (viewedProjectId !== projectId) { viewedProjectId = projectId; notify(); } }
function notify() { for (const listener of listeners) listener(); }
export function subscribePrototypeFreeChats(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function freeProjectId(identity?: string): string | undefined { return identity?.startsWith(FREE_WORKSPACE_PREFIX) ? identity.slice(FREE_WORKSPACE_PREFIX.length).split(":")[0] : undefined; }
function make(projectId: string, taskId: string, title: string, updatedAt: number, empty: boolean, root?: string, identity?: string): FreeChat {
 const project = readPrototypeProjectSettings().projects.find(item => item.id === projectId);
 if (!project) throw new Error("请选择已登记项目。");
 const employeeId = getEmployeeId();
 return { empty, deleted: false, meta: { taskId, traceId: `sample:${taskId}`, title, projectId, hostId: "local", pinned: false, archived: false,
  workspacePath: root ?? readPrototypeDevelopmentRoot(projectId) ?? project.root,
  workspaceIdentity: identity ?? `${FREE_WORKSPACE_PREFIX}${projectId}:${employeeId}`,
  createdAt: updatedAt, updatedAt, mode: "build", provider: "glm", model: "Beam Free", status: "completed" } };
}
function seed(projectId: string) {
 if (seeded.has(projectId)) return; seeded.add(projectId);
 const titles = ["检查当前登录改动", "解释项目目录结构", "梳理会话恢复逻辑", "检查待提交文件", "补充空态交互", "较早的接口讨论", "较早的构建检查", "较早的样式整理"];
 const base = Date.now() - 3600000;
 for (let i = 0; i < titles.length; i++) { const id = `${FREE_CHAT_PREFIX}${projectId}:sample-${i + 1}`; records.set(id, make(projectId, id, titles[i]!, base - i * 60000, false)); }
}
/** 有界的元数据查询；正文只由既有聊天服务在打开会话时读取，不读取 IR/SR 会话。 */
export function readRecentFreeChats(projectId: string, limit = FREE_CHAT_LIMIT): ProjectTask[] {
 seed(projectId);
 return [...records.values()].filter(item => item.meta.projectId === projectId && !item.deleted && !item.meta.archived)
  .sort((a,b) => b.meta.updatedAt - a.meta.updatedAt || a.meta.taskId.localeCompare(b.meta.taskId))
  .slice(0, Math.min(FREE_CHAT_LIMIT, Math.max(0, limit))).map(item => structuredClone(item.meta));
}
export function readPrototypeFreeChat(id: string): FreeChat | undefined { const item = records.get(id); return item && !item.deleted ? structuredClone(item) : undefined; }
export function createPrototypeFreeChat(projectId: string, root?: string, identity?: string): ProjectTask {
 seed(projectId); const id = `${FREE_CHAT_PREFIX}${projectId}:${crypto.randomUUID()}`;
 const item = make(projectId, id, "新建会话", Date.now(), true, root, identity); records.set(id, item); notify(); return structuredClone(item.meta);
}
export function updatePrototypeFreeChat(meta: Partial<ProjectTask> & { taskId: string }, state?: { deleted: boolean; empty?: boolean }): void {
 const item = records.get(meta.taskId); if (!item) return;
 Object.assign(item.meta, meta); if (state) { item.deleted = state.deleted; if (state.empty !== undefined) item.empty = state.empty; } notify();
}
export function createPrototypeProjectServices(): Pick<IServiceAccessor, "projectService"> {
 const projects = (): VirtualProject[] => readPrototypeProjectSettings().projects.map((project, position) => ({
  id: project.id, hostId: "local", name: project.name, nameOverridden: false, roots: [{ rootPath: readPrototypeDevelopmentRoot(project.id) ?? project.root, position: 0, isPrimary: true }],
  position, pinned: pins.has(project.id), deleted: hiddenProjects.has(project.id), createdAt: Date.parse(project.createdAt), updatedAt: Date.parse(project.updatedAt), primaryRootStatus: "available",
 }));
 const find = (id: string) => { const project = projects().find(item => item.id === id); if (!project) throw new Error("项目不存在。"); return project; };
 return { projectService: {
  readProjects: async params => projects().filter(item => params?.includeDeleted || !item.deleted),
  readTree: async params => { const id = viewedProjectId ?? projects()[0]?.id; const rows = projects().filter(item => item.id === id && (params?.includeDeleted || !item.deleted)); return { projects: rows, tasks: rows.filter(item => !item.deleted).flatMap(project => readRecentFreeChats(project.id, FREE_CHAT_LIMIT)) }; },
  readDirectory: async params => ({ path: params?.path ?? "/demo", entries: projects().map(project => ({ name: project.name, path: project.roots[0]!.rootPath, type: "directory" as const })) }),
  saveProject: async input => { if (!input.id) throw new Error("请在 Dev 项目与 Release 中添加已有 Git 项目。"); if (input.pinned !== undefined) input.pinned ? pins.add(input.id) : pins.delete(input.id); notify(); return find(input.id); },
  deleteProject: async id => { find(id); hiddenProjects.add(id); notify(); },
  restoreProject: async id => { find(id); hiddenProjects.delete(id); notify(); return find(id); },
  moveTask: async input => { find(input.projectId); const item = records.get(input.task.taskId); if (!item) throw new Error("自由会话不存在。"); item.meta.projectId = input.projectId; notify(); },
  reorderProjects: async () => {},
  prepareSession: async params => { const project = find(params?.projectId ?? projects()[0]!.id); return { workspacePath: project.roots[0]!.rootPath, additionalDirectories: [], projectId: project.id, workspaceIdentity: `${FREE_WORKSPACE_PREFIX}${project.id}:${getEmployeeId()}` }; },
  resolveSessionDirectories: async task => { const item = readPrototypeFreeChat(task.taskId); if (!item) throw new Error("自由会话不存在。"); return { workspacePath: item.meta.workspacePath, workspaceIdentity: item.meta.workspaceIdentity, additionalDirectories: [], projectId: item.meta.projectId }; },
  measureProjectData: unavailablePrototypeOperation, deleteProjectData: unavailablePrototypeOperation,
 } };
}

/** 只返回现有元数据中的冻结根路径，供样例文件服务识别；不加载聊天。 */
export function readPrototypeFreeWorkspaceRoots(): string[] { return [...new Set([...records.values()].map(item => item.meta.workspacePath))]; }
