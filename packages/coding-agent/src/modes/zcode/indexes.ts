import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { z } from "zod";
import { DocsService } from "../../docs/service";
import type { DocsProgress } from "../../docs/types";
import { REPO_EXCLUSIONS } from "../../repo/files";
import { normalizeRepoQueryPath, RepoService, resolveRepoRoot } from "../../repo/service";
import { repoIndexPath } from "../../repo/storage";
import type { RepoProgress, RepoQueryResult, RepoStatus } from "../../repo/types";
import { LegacyProtocol as L } from "./schema";

const text = z.string().min(1);
const workspaceSchema = L.zcodeWorkflowsListParamsSchema.shape.workspace;
const base = { workspace: workspaceSchema, operationId: text };
const wikiQuery = {
	...base,
	query: text,
	index: text.optional(),
	limit: z.number().int().min(1).max(200).optional(),
	cursor: text.optional(),
	characterBudget: z.number().int().min(1).max(1_000_000).optional(),
};
export const ompWikiParamsSchema = z.discriminatedUnion("action", [
	z.object({ ...base, action: z.literal("list") }).strict(),
	z.object({ ...base, action: z.literal("init"), directory: text, name: text, confirmedDirectory: text }).strict(),
	z.object({ ...base, action: z.literal("remove"), name: text }).strict(),
	z.object({ ...wikiQuery, action: z.literal("search") }).strict(),
	z.object({ ...wikiQuery, action: z.literal("grep"), case: z.boolean().optional() }).strict(),
	z.object({ ...base, action: z.literal("cancel") }).strict(),
]);
const repoQuery = {
	...base,
	query: text,
	path: text.optional(),
	category: z.enum(["source", "test", "config", "other"]).optional(),
	limit: z.number().int().min(1).max(50).optional(),
	cursor: text.optional(),
};
export const ompRepoParamsSchema = z.discriminatedUnion("action", [
	z.object({ ...base, action: z.literal("status") }).strict(),
	z.object({ ...base, action: z.literal("init"), confirmedRoot: text }).strict(),
	z.object({ ...base, action: z.literal("update"), confirmedRoot: text }).strict(),
	z.object({ ...base, action: z.literal("rebuild"), confirmedRoot: text }).strict(),
	z.object({ ...base, action: z.literal("remove"), confirmedRoot: text }).strict(),
	z.object({ ...repoQuery, action: z.literal("text") }).strict(),
	z.object({ ...repoQuery, action: z.literal("symbol") }).strict(),
	z.object({ ...base, action: z.literal("cancel") }).strict(),
]);
type Scope = { workspace: z.infer<typeof workspaceSchema>; operationId: string; action: string };
interface Operation {
	controller: AbortController;
	done: Promise<void>;
}
export interface OmpIndexesBridgeOptions {
	agentDir?: string;
	notify(
		method: "omp/wiki/progress" | "omp/repo/progress",
		params: {
			operationId: string;
			workspace: z.infer<typeof workspaceSchema>;
			progress: DocsProgress | RepoProgress;
		},
	): void;
}

// tools/repo 的 missing helpers 不公开；这里只映射相同结果，不为只读请求打开原生存储。
function missingRepoStatus(root: string): RepoStatus {
	return {
		root,
		exists: false,
		generation: null,
		fileCount: 0,
		symbolCount: 0,
		failures: [],
		failureCount: 0,
		failuresTruncated: false,
		pendingPaths: [],
		pendingCount: 0,
		pendingTruncated: false,
		needsReconcile: false,
		uncertainReasons: [],
		uncertainCount: 0,
		uncertaintyTruncated: false,
		unchecked: true,
		lastFullCheck: null,
		incomplete: true,
		exclusions: REPO_EXCLUSIONS,
	};
}

async function repositoryIndexExists(databasePath: string): Promise<boolean> {
	try {
		await fs.stat(databasePath);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function missingRepoQuery(root: string, cursor: string | undefined): RepoQueryResult<never> {
	if (cursor) {
		let value: unknown;
		try {
			value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		} catch {
			throw new Error("Invalid repository index cursor");
		}
		if (value && typeof value === "object" && "generation" in value && value.generation !== null)
			throw new Error("Stale repository index cursor; restart the search");
		throw new Error("Invalid repository index cursor");
	}
	return {
		root,
		generation: null,
		status: "missing",
		hits: [],
		truncated: false,
		warnings: [],
		coverage: missingRepoStatus(root),
	};
}

/** Only adapts native services: they remain the sole owners of persisted index generations. */
export class OmpIndexesBridge {
	readonly #options: OmpIndexesBridgeOptions;
	readonly #agentDir: string;
	readonly #docs = new Map<string, DocsService>();
	readonly #repos = new Map<string, RepoService>();
	readonly #operations = new Map<string, Operation>();
	readonly #mutations = new Set<string>();
	#disposed = false;
	#disposing?: Promise<void>;

	constructor(options: OmpIndexesBridgeOptions) {
		this.#options = options;
		this.#agentDir = options.agentDir ?? getAgentDir();
	}

	async #directory(directory: string): Promise<string> {
		if (!path.isAbsolute(directory)) throw new Error("Index paths must be absolute execution-side paths");
		const canonical = await fs.realpath(directory);
		if (!(await fs.stat(canonical)).isDirectory()) throw new Error("Index scope must be a directory");
		return canonical;
	}

	#key(kind: string, params: Scope, cwd: string): string {
		// 路径和身份共同约束取消，不能让另一工作区复用 operationId 取消当前任务。
		return JSON.stringify([
			kind,
			cwd,
			params.workspace.workspaceIdentity ?? cwd,
			params.workspace.workspaceKey,
			params.workspace.remoteSessionId,
			params.operationId,
		]);
	}

	async #run<T>(
		kind: "wiki" | "repo",
		params: Scope,
		signal: AbortSignal | undefined,
		work: (cwd: string, signal: AbortSignal, progress: (value: DocsProgress | RepoProgress) => void) => Promise<T>,
	): Promise<T | { cancelled: boolean }> {
		if (this.#disposed) throw new Error("Index bridge is disposed");
		signal?.throwIfAborted();
		const cwd = await this.#directory(params.workspace.workspacePath);
		if (this.#disposed) throw new Error("Index bridge is disposed");
		signal?.throwIfAborted();
		const key = this.#key(kind, params, cwd);
		if (params.action === "cancel") {
			const active = this.#operations.get(key);
			active?.controller.abort(new DOMException("Index operation cancelled", "AbortError"));
			return { cancelled: Boolean(active) };
		}
		if (this.#operations.has(key)) throw new Error("Index operationId is already active in this workspace");
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		const done = Promise.withResolvers<void>();
		const operation = { controller, done: done.promise };
		this.#operations.set(key, operation);
		try {
			const result = await work(cwd, controller.signal, progress => {
				if (this.#disposed || controller.signal.aborted || this.#operations.get(key) !== operation) return;
				this.#options.notify(`omp/${kind}/progress`, {
					operationId: params.operationId,
					workspace: params.workspace,
					progress,
				});
			});
			controller.signal.throwIfAborted();
			return result;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.#operations.delete(key);
			done.resolve();
		}
	}

	handleWiki(action: string, raw: unknown, signal?: AbortSignal) {
		const schema = ompWikiParamsSchema.options.find(option => option.shape.action.value === action);
		if (!schema) throw new Error(`Unknown Wiki method: ${action}`);
		const { action: methodSchema, ...shape } = schema.shape;
		const payload = z.object(shape).strict().parse(raw);
		const params = ompWikiParamsSchema.parse({ ...payload, action: methodSchema.value });
		return this.#run("wiki", params, signal, async (cwd, inner, onProgress) => {
			let service = this.#docs.get(cwd);
			if (!service) {
				service = new DocsService({ agentDir: this.#agentDir, cwd });
				this.#docs.set(cwd, service);
			}
			switch (params.action) {
				case "list":
					return { indexes: await service.list({ signal: inner }) };
				case "init": {
					const directory = await this.#directory(params.directory);
					// Windows 斜杠、大小写及符号链接别名需按同一原生 realpath 比较，不能误拒等价确认。
					const confirmedDirectory = await this.#directory(params.confirmedDirectory);
					if (confirmedDirectory !== directory) throw new Error(`Confirm document directory: ${directory}`);
					return service.init(directory, params.name, { signal: inner, onProgress });
				}
				case "remove":
					await service.remove(params.name, { signal: inner });
					return { removed: true as const };
				case "search":
				case "grep":
					return service.search(params.query, {
						mode: params.action,
						index: params.index,
						limit: params.limit,
						cursor: params.cursor,
						characterBudget: params.characterBudget,
						signal: inner,
						...(params.action === "grep" ? { case: params.case } : {}),
					});
				case "cancel":
					throw new Error("Cancellation is handled before service admission");
			}
		});
	}

	handleRepo(action: string, raw: unknown, signal?: AbortSignal) {
		const schema = ompRepoParamsSchema.options.find(option => option.shape.action.value === action);
		if (!schema) throw new Error(`Unknown Repo method: ${action}`);
		const { action: methodSchema, ...shape } = schema.shape;
		const payload = z.object(shape).strict().parse(raw);
		const params = ompRepoParamsSchema.parse({ ...payload, action: methodSchema.value });
		return this.#run("repo", params, signal, async (cwd, inner, onProgress) => {
			const root = resolveRepoRoot(cwd);
			if ("confirmedRoot" in params) {
				const confirmedRoot = await this.#directory(params.confirmedRoot);
				// 确认的是同一真实目录，不应因路径别名或 Windows 大小写误拒用户。
				const matches =
					process.platform === "win32"
						? confirmedRoot.toLowerCase() === root.toLowerCase()
						: confirmedRoot === root;
				if (!matches) throw new Error(`Confirm repository root: ${root}`);
			}
			const readOnly = params.action === "status" || params.action === "text" || params.action === "symbol";
			if (readOnly && !(await repositoryIndexExists(repoIndexPath(this.#agentDir, root)))) {
				if (params.action === "status") return missingRepoStatus(root);
				if (params.action === "text" || params.action === "symbol") {
					normalizeRepoQueryPath(params.path);
					return missingRepoQuery(root, params.cursor);
				}
			}
			let service = this.#repos.get(root);
			if (!service) {
				service = new RepoService({ agentDir: this.#agentDir, cwd, root });
				this.#repos.set(root, service);
			}
			if (params.action === "status") {
				const recoveryError = service.storage.recoveryError;
				if (recoveryError) {
					// GUI 仅对 exists 的索引开放重建；保留真实库的根与故障，不能伪装为 missing。
					return {
						...missingRepoStatus(root),
						exists: true,
						needsReconcile: true,
						uncertainReasons: [recoveryError.message],
						uncertainCount: 1,
					} satisfies RepoStatus;
				}
				return service.status();
			}
			if (params.action === "text" || params.action === "symbol") {
				const options = {
					path: params.path,
					category: params.category,
					limit: params.limit,
					cursor: params.cursor,
					signal: inner,
				};
				return params.action === "text"
					? service.search(params.query, options)
					: service.symbol(params.query, options);
			}
			if (params.action === "cancel") throw new Error("Cancellation is handled before service admission");
			// 同根的写入串行准入，避免删除与排队重建交错后重新发布已删除索引。
			if (this.#mutations.has(root)) throw new Error("Repository maintenance is already active");
			this.#mutations.add(root);
			try {
				inner.throwIfAborted();
				const options = { signal: inner, onProgress };
				switch (params.action) {
					case "init":
						return await service.build(options);
					case "update":
						return await service.reconcile(options);
					case "rebuild":
						return await (service.storage.recoveryError ? service.recover(options) : service.rebuild(options));
					case "remove":
						await service.remove();
						return { removed: true as const, root };
				}
			} finally {
				this.#mutations.delete(root);
			}
		});
	}

	dispose(): Promise<void> {
		if (this.#disposing) return this.#disposing;
		this.#disposed = true;
		for (const operation of this.#operations.values())
			operation.controller.abort(new DOMException("Index bridge closed", "AbortError"));
		for (const service of this.#repos.values()) service.close();
		const closing = [...this.#docs.values()].map(service => service.close());
		this.#disposing = Promise.all([
			...closing,
			...[...this.#operations.values()].map(operation => operation.done),
		]).then(() => {
			this.#docs.clear();
			this.#repos.clear();
		});
		return this.#disposing;
	}
}
