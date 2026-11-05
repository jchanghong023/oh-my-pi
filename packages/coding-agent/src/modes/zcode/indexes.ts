import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { z } from "zod";
import { KnowledgeService } from "../../knowledge/service";
import type { KnowledgeProgress } from "../../knowledge/types";
import { LegacyProtocol as L } from "./schema";

const text = z.string().min(1);
const workspaceSchema = L.zcodeWorkflowsListParamsSchema.shape.workspace;
const base = { workspace: workspaceSchema, operationId: text };
const knowledgeQuery = {
	...base,
	query: text,
	index: text.optional(),
	limit: z.number().int().min(1).max(200).optional(),
	cursor: text.optional(),
	characterBudget: z.number().int().min(1).max(1_000_000).optional(),
};
export const ompKnowledgeParamsSchema = z.discriminatedUnion("action", [
	z.object({ ...base, action: z.literal("list") }).strict(),
	z.object({ ...base, action: z.literal("init"), directory: text, name: text, confirmedDirectory: text }).strict(),
	z.object({ ...base, action: z.literal("remove"), name: text }).strict(),
	z.object({ ...knowledgeQuery, action: z.literal("search") }).strict(),
	z.object({ ...knowledgeQuery, action: z.literal("grep"), case: z.boolean().optional() }).strict(),
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
		method: "omp/wiki/progress",
		params: {
			operationId: string;
			workspace: z.infer<typeof workspaceSchema>;
			progress: KnowledgeProgress;
		},
	): void;
}

/** Only adapts native services: they remain the sole owners of persisted index generations. */
export class OmpIndexesBridge {
	readonly #options: OmpIndexesBridgeOptions;
	readonly #agentDir: string;
	readonly #knowledge = new Map<string, KnowledgeService>();
	readonly #operations = new Map<string, Operation>();
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

	#key(params: Scope, cwd: string): string {
		// 路径和身份共同约束取消，不能让另一工作区复用 operationId 取消当前任务。
		return JSON.stringify([
			cwd,
			params.workspace.workspaceIdentity ?? cwd,
			params.workspace.workspaceKey,
			params.workspace.remoteSessionId,
			params.operationId,
		]);
	}

	async #run<T>(
		params: Scope,
		signal: AbortSignal | undefined,
		work: (cwd: string, signal: AbortSignal, progress: (value: KnowledgeProgress) => void) => Promise<T>,
	): Promise<T | { cancelled: boolean }> {
		if (this.#disposed) throw new Error("Index bridge is disposed");
		signal?.throwIfAborted();
		const cwd = await this.#directory(params.workspace.workspacePath);
		if (this.#disposed) throw new Error("Index bridge is disposed");
		signal?.throwIfAborted();
		const key = this.#key(params, cwd);
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
				this.#options.notify("omp/wiki/progress", {
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

	handleKnowledge(action: string, raw: unknown, signal?: AbortSignal) {
		const schema = ompKnowledgeParamsSchema.options.find(option => option.shape.action.value === action);
		if (!schema) throw new Error(`Unknown Knowledge method: ${action}`);
		const { action: methodSchema, ...shape } = schema.shape;
		const payload = z.object(shape).strict().parse(raw);
		const params = ompKnowledgeParamsSchema.parse({ ...payload, action: methodSchema.value });
		return this.#run(params, signal, async (cwd, inner, onProgress) => {
			let service = this.#knowledge.get(cwd);
			if (!service) {
				service = new KnowledgeService({ agentDir: this.#agentDir, cwd });
				this.#knowledge.set(cwd, service);
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

	dispose(): Promise<void> {
		if (this.#disposing) return this.#disposing;
		this.#disposed = true;
		for (const operation of this.#operations.values())
			operation.controller.abort(new DOMException("Index bridge closed", "AbortError"));
		const closing = [...this.#knowledge.values()].map(service => service.close());
		this.#disposing = Promise.all([
			...closing,
			...[...this.#operations.values()].map(operation => operation.done),
		]).then(() => {
			this.#knowledge.clear();
		});
		return this.#disposing;
	}
}
