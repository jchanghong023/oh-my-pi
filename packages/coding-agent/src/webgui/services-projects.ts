import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import type {
	ProjectTree,
	VirtualProject,
} from "../../../../vendor/zcode-frontend/packages/services/src/project-storage/repository-contract";
import type { TaskGroupStructure } from "../../../../vendor/zcode-frontend/packages/services/src/task-groups/contract";
import type { ZCodeTaskListResult } from "../../../../vendor/zcode-frontend/packages/services/src/session/zcodeTaskListTypes";
import type { ZCodeTaskSnapshotWithEtagResult } from "../../../../vendor/zcode-frontend/packages/services/src/session/zcodeTaskService";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import type { ProjectTask } from "../../../../vendor/zcode-frontend/packages/services/src/project-storage/repository-contract";
import type {
	ZCodeTaskMeta,
	ZCodeTaskSnapshot,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-task-types-core";
import { Emitter } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import { legacyMessages, listNativeHistory, nativeChatChanges } from "./native-chat";
import { sessionDisplayName, type SessionInfo } from "../session/session-listing";
import { createWebGuiService } from "./service-channel";
import { listBrowserProjects, resolveBrowserProjectRoot } from "./project-registry";
import { resumeWebGuiNativeSession, subscribeWebGuiNativeSessions, webGuiSessionProject } from "./native-session-host";

/** The sidebar is a read-only projection of native histories, not new ZCode project/task records. */
export function createProjectServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	const residents = () =>
		listBrowserProjects()
			.filter(project => project.mode === "webgui")
			.flatMap(project => [...(project.nativeSessions ?? [])])
			.filter(session => !session.isDisposed);
	const projects = (): VirtualProject[] =>
		listBrowserProjects()
			.filter(project => project.mode === "webgui")
			.map((project, position) => ({
				id: project.projectId,
				hostId: "local",
				name: path.basename(project.root) || project.root,
				nameOverridden: false,
				roots: [{ rootPath: project.root, position: 0, isPrimary: true }],
				position,
				pinned: false,
				deleted: false,
				createdAt: project.createdAt ?? 0,
				updatedAt: project.updatedAt ?? project.createdAt ?? 0,
			}));
	const projectForCwd = async (cwd: string): Promise<string | null> => {
		const root = await resolveBrowserProjectRoot(cwd).catch(() => undefined);
		if (!root) return null;
		return (
			listBrowserProjects().find(
				project =>
					project.mode === "webgui" &&
					normalizePathForComparison(project.root) === normalizePathForComparison(root),
			)?.projectId ?? null
		);
	};
	const taskMeta = (info: SessionInfo): ZCodeTaskMeta => {
		const active = residents().find(session => session.sessionId === info.id);
		return {
			taskId: info.id,
			traceId: info.id,
			title: sessionDisplayName(info),
			workspacePath: info.cwd,
			createdAt: info.created.getTime(),
			updatedAt: info.modified.getTime(),
			mode: "build",
			status: active?.isStreaming ? "running" : info.status === "error" ? "error" : "completed",
			...(active?.model ? { model: active.model.id, thoughtLevel: active.thinkingLevel } : {}),
		};
	};
	const workspaceEvents = new Emitter<{ type: "workspace_task_list_changed" }>();
	const nativeChatSubscription = nativeChatChanges.event(() =>
		workspaceEvents.fire({ type: "workspace_task_list_changed" }),
	);
	const disposeWorkspaceEvents = [
		subscribeWebGuiNativeSessions(() => workspaceEvents.fire({ type: "workspace_task_list_changed" })),
		() => nativeChatSubscription.dispose(),
	];

	const tasks = async (): Promise<ProjectTask[]> => {
		const byCwd = new Map<string, Promise<string | null>>();
		const all = await Promise.all(
			(await listNativeHistory(context)).map(async info => {
				let project = byCwd.get(info.cwd);
				if (!project) {
					project = projectForCwd(info.cwd);
					byCwd.set(info.cwd, project);
				}
				return {
					...taskMeta(info),
					projectId: await project,
					hostId: "local",
					pinned: false,
					archived: false,
				};
			}),
		);
		// 新会话尚未落盘时历史标题仍是 Untitled；从原生会话的首条用户消息即时取标题。
		const liveSessions = residents();
		for (const task of all) {
			if (!task.title.startsWith("Untitled")) continue;
			const session = liveSessions.find(candidate => candidate.sessionId === task.taskId);
			if (!session) continue;
			const firstUser = session.agent.state.messages.find(message => message.role === "user");
			const content = firstUser?.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.flatMap(part =>
									part && typeof part === "object" && "type" in part && part.type === "text"
										? [String((part as { text?: unknown }).text ?? "")]
										: [],
								)
								.join(" ")
						: "";
			const title = text.trim().split("\n")[0]?.trim();
			if (title) task.title = title.slice(0, 60);
		}

		// 手机侧栏只保留每个项目最近 5 条会话，避免长历史拖慢首屏。
		const byProject = new Map<string, ProjectTask[]>();
		for (const task of all) {
			const key = task.projectId ?? "unbound";
			const bucket = byProject.get(key);
			if (bucket) bucket.push(task);
			else byProject.set(key, [task]);
		}
		const capped: ProjectTask[] = [];
		for (const bucket of byProject.values()) {
			bucket.sort((left, right) => right.updatedAt - left.updatedAt);
			capped.push(...bucket.slice(0, 5));
		}
		return capped;
	};
	const find = async (value: unknown): Promise<SessionInfo | undefined> => {
		if (!value || typeof value !== "object" || !("taskId" in value) || typeof value.taskId !== "string")
			throw new TypeError("Expected native taskId");
		return (await listNativeHistory(context)).find(info => info.id === value.taskId);
	};
	const snapshot = async (value: unknown): Promise<ZCodeTaskSnapshot | null> => {
		const info = await find(value);
		if (!info) return null;
		const messages = await legacyMessages(context, info.id);
		const native: ZCodeTaskSnapshot = {
			meta: taskMeta(info),
			messages: messages.map(message => ({
				id: message.info.messageId,
				role: message.info.role,
				timestamp: message.info.time.created,
				content: message.parts.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\\n"),
				...(message.info.model ? { model: message.info.model.modelId } : {}),
				...(message.parts.some(part => part.type === "reasoning")
					? { thought: message.parts.flatMap(part => (part.type === "reasoning" ? [part.text] : [])).join("\\n") }
					: {}),
			})),
		};
		return native;
	};
	return [
		createWebGuiService("project", {
			readProjects: projects,
			readTree: async (): Promise<ProjectTree> => ({ projects: projects(), tasks: await tasks(), deletedTasks: [] }),
			resolveSessionDirectories: async value => {
				const info = await find(value);
				if (!info) throw new Error("Native session not found");
				return { workspacePath: info.cwd, additionalDirectories: [], projectId: await projectForCwd(info.cwd) };
			},
		}),
		createWebGuiService("task-groups", {
			read: (): TaskGroupStructure => ({ groups: [], members: [], order: [] }),
		}),
		createWebGuiService(
			"zcode-task",
			{
				initialize: (): { available: boolean; version: string } => ({ available: true, version: "omp-native" }),
				listTasks: tasks,
				listPinnedTaskIds: () => [],
				listPinnedTasks: () => [],
				listDeletedTaskIds: () => [],
				listActiveTaskIds: () =>
					residents()
						.filter(session => session.isStreaming)
						.map(session => session.sessionId),
				listArchivedTasks: () => [],
				onDynamicWorkspaceEvent:
					(_scope: unknown) => (listener: (event: { type: "workspace_task_list_changed" }) => void) => {
						const subscription = workspaceEvents.event(listener);
						return { dispose: () => subscription.dispose() };
					},
				listTaskList: async value => {
					const query =
						value && typeof value === "object"
							? (value as { kind?: string; search?: string; sortBy?: string; limit?: number })
							: {};
					let items = await tasks();
					if (query.kind === "pinned" || query.kind === "archived") items = [];
					if (query.kind === "active") items = items.filter(item => item.status === "running");
					if (query.search) {
						const search = query.search.toLocaleLowerCase();
						items = items.filter(item => item.title.toLocaleLowerCase().includes(search));
					}
					items.sort((left, right) =>
						query.sortBy === "created" ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt,
					);
					const total = items.length;
					if (typeof query.limit === "number") items = items.slice(0, Math.max(0, query.limit));
					return { items, total, hasMore: items.length < total } satisfies ZCodeTaskListResult;
				},
				getTaskMeta: async value => {
					const info = await find(value);
					return info ? taskMeta(info) : null;
				},
				getTaskSnapshot: snapshot,
				getTaskSnapshotWithEtag: async value =>
					({ snapshot: await snapshot(value) }) satisfies ZCodeTaskSnapshotWithEtagResult,
				getTaskSessionFilePath: async value => {
					const info = await find(value);
					return { path: info?.path ?? "", exists: !!info?.path };
				},
				getTaskNativeSessionLogFile: async value => {
					const info = await find(value);
					return { path: info?.path ?? "", exists: !!info?.path };
				},
				resumeTask: async value => {
					const info = await find(value);
					if (!info) throw new Error("Native session not found");
					const session = await resumeWebGuiNativeSession(context, info.id);
					const project = webGuiSessionProject(session);
					return { ...taskMeta(info), ...project, workspacePath: session.sessionManager.getCwd() };
				},
				getTaskSnapshotBody: () => null,
				getTaskSnapshotRef: () => null,
				getTaskSnapshotToolCallsSlice: () => null,
				getTaskConfigOptions: () => [],
				getTaskModelSelection: async value => {
					const info = await find(value);
					const current = residents().find(session => session.sessionId === info?.id)?.model;
					return current ? { providerId: current.provider, modelId: current.id } : null;
				},
			},
			{
				dispose: () => {
					for (const dispose of disposeWorkspaceEvents) dispose();
					workspaceEvents.dispose();
				},
			},
		),
		// TODO(omp-session-manager-bots): Integrate native OMP SessionManager/project
		// channel delivery and configuration. Bot status has no unavailable variant;
		// status/config reads, runtime preference sync, registrations, bot management,
		// topic/group operations and message/callback dispatch all explicitly reject.
		createWebGuiService("bots", {}),
	];
}
