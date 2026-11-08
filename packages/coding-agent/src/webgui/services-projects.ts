import type { HighspeedServiceSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/highspeed";
import type {
	OffPeakCodingPlanSupport,
	OffPeakTakeNumberAvailability,
	ZCodeOffPeakTask,
} from "../../../../vendor/zcode-frontend/packages/shared/src/off-peak-types";
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
import { legacyMessages, listNativeHistory, nativeChatRuntime } from "./native-chat";
import { sessionDisplayName, type SessionInfo } from "../session/session-listing";
import { createWebGuiService } from "./service-channel";

/** The sidebar is a read-only projection of native histories, not new ZCode project/task records. */
export function createProjectServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	const taskMeta = (info: SessionInfo): ZCodeTaskMeta => {
		const active = context.nativeSession?.sessionId === info.id ? context.nativeSession : undefined;
		return {
			taskId: info.id,
			traceId: info.id,
			title: sessionDisplayName(info),
			workspacePath: context.workspacePath!,
			createdAt: info.created.getTime(),
			updatedAt: info.modified.getTime(),
			mode: "build",
			status: active?.isStreaming ? "running" : info.status === "error" ? "error" : "completed",
			...(active?.model ? { model: active.model.id, thoughtLevel: active.thinkingLevel } : {}),
		};
	};
	const tasks = async (): Promise<ProjectTask[]> =>
		(await listNativeHistory(context)).map(info => ({
			...taskMeta(info),
			projectId: null,
			hostId: "local",
			pinned: false,
			archived: false,
		}));
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
			readProjects: (): VirtualProject[] => [],
			readTree: async (): Promise<ProjectTree> => ({ projects: [], tasks: await tasks(), deletedTasks: [] }),
			resolveSessionDirectories: async value => {
				const info = await find(value);
				if (!info) throw new Error("Native session not found");
				return { workspacePath: context.workspacePath!, additionalDirectories: [], projectId: null };
			},
		}),
		createWebGuiService("task-groups", {
			read: (): TaskGroupStructure => ({ groups: [], members: [], order: [] }),
		}),
		// Runtime mutation, prompt queues, files and permissions stay unavailable.
		createWebGuiService("zcode-task", {
			initialize: (): { available: boolean; version?: string } => ({
				available: !!context.nativeSession,
				...(context.nativeSession ? { version: "omp-native" } : {}),
			}),
			listTasks: tasks,
			listPinnedTaskIds: () => [],
			listPinnedTasks: () => [],
			listDeletedTaskIds: () => [],
			listActiveTaskIds: () => (context.nativeSession?.isStreaming ? [context.nativeSession.sessionId] : []),
			listArchivedTasks: () => [],
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
				await nativeChatRuntime(context).resume(context, info.id);
				return taskMeta(info);
			},
			getTaskSnapshotBody: () => null,
			getTaskSnapshotRef: () => null,
			getTaskSnapshotToolCallsSlice: () => null,
			getTaskConfigOptions: () => [],
			getTaskModelSelection: async value => {
				const info = await find(value);
				const current = info?.id === context.nativeSession?.sessionId ? context.nativeSession?.model : undefined;
				return current ? { providerId: current.provider, modelId: current.id } : null;
			},
		}),
		// TODO(omp-scheduler): Integrate native OMP scheduler persistence and provider
		// admission. Empty attachment reads do not inspect persisted scheduled jobs;
		// create/cancel/pause/continue/delete/deleteHistory/update remain unavailable.
		createWebGuiService("off-peak-task", {
			getCodingPlanSupport: (): OffPeakCodingPlanSupport => ({
				supported: false,
				reason: "connection_unavailable",
			}),
			getTakeNumberAvailability: (): OffPeakTakeNumberAvailability => ({ canTakeNumber: false }),
			list: (): ZCodeOffPeakTask[] => [],
			get: (): ZCodeOffPeakTask | null => null,
		}),
		// TODO(omp-session-manager-highspeed): Integrate native OMP provider/billing
		// admission. This attachment owns no card or draw; prepareTurn, invalidateCard
		// and healthy remain unavailable rather than pretending a subscription exists.
		createWebGuiService("highspeed-card", {
			getSnapshot: (): HighspeedServiceSnapshot => ({ card: null, nextDrawAt: null, drawing: false }),
		}),
		// TODO(omp-session-manager-bots): Integrate native OMP SessionManager/project
		// channel delivery and configuration. Bot status has no unavailable variant;
		// status/config reads, runtime preference sync, registrations, bot management,
		// topic/group operations and message/callback dispatch all explicitly reject.
		createWebGuiService("bots", {}),
	];
}
