import * as path from "node:path";
import {
	knowledgeNormalizeSearchOptions,
	knowledgePrepareToolQuery,
	knowledgeSelectPage,
	knowledgeToolPage,
	type KnowledgeToolPage,
	knowledgeWaitMinimum,
} from "@oh-my-pi/pi-natives";
import { isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import {
	companySnapshotForSubprocess,
	isCompanyLaneActive,
	setCompanyOfflineEnabled,
} from "../config/company-provider";
import { KNOWLEDGE_WORKER_ARG } from "../cli/worker-selectors";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import type { SpawnedSubprocess, WorkerHandle } from "../subprocess/worker-client";
import { isThenable } from "../utils/ipc";
import type {
	KnowledgeBuildOptions,
	KnowledgeBuildResult,
	KnowledgeIndexSummary,
	KnowledgeProgress,
	KnowledgeSearchOptions,
	KnowledgeSearchResult,
	KnowledgeSearchWindow,
	KnowledgeServiceOptions,
	KnowledgeVectorRetryResult,
} from "./types";
import type {
	KnowledgeWorkerCommand,
	KnowledgeWorkerInbound,
	KnowledgeWorkerLogContext,
	KnowledgeWorkerOutbound,
	KnowledgeWorkerResults,
} from "./worker-protocol";

type RequestCommand = Exclude<KnowledgeWorkerCommand, { type: "configure" }>;
type KnowledgeWorkerHandle = WorkerHandle<KnowledgeWorkerInbound, KnowledgeWorkerOutbound>;
interface Reply<T> {
	value: T;
	engine_ms: number;
	startup_engine_ms: number;
	ipc_ms: number;
	queue_ms: number;
}
interface Request {
	id: string;
	command: RequestCommand;
	context: KnowledgeWorkerLogContext;
	signal?: AbortSignal;
	onProgress?: (progress: KnowledgeProgress) => void;
	resolve(reply: Reply<unknown>): void;
	reject(error: unknown): void;
	cleanup(): void;
	enqueuedAt: number;
	activeAt: number;
	startupEngineMs: number;
}
interface OwnedWorker {
	handle: KnowledgeWorkerHandle;
	spawned: SpawnedSubprocess<KnowledgeWorkerOutbound>;
	configured: boolean;
	configureId?: string;
	offMessage(): void;
	offError(): void;
}

function cancelled(): Error {
	const error = new Error("Document operation cancelled");
	error.name = "AbortError";
	return error;
}

function logContext(): KnowledgeWorkerLogContext {
	const inherited = logger.getLogContext();
	const identifier = (value: unknown): string | undefined =>
		typeof value === "string" && /^[\w.:-]{1,160}$/.test(value) ? value : undefined;
	return {
		operation_id: identifier(inherited.operation_id) ?? `knowledge-${crypto.randomUUID()}`,
		call_id: `knowledge-worker-${crypto.randomUUID()}`,
		parent_call_id: identifier(inherited.call_id),
	};
}

interface KnowledgeWorkerChild {
	handle: KnowledgeWorkerHandle;
	spawned: SpawnedSubprocess<KnowledgeWorkerOutbound>;
}

function spawnKnowledgeWorker(onSendError: (error: unknown) => void): KnowledgeWorkerChild {
	const spawned = createWorkerSubprocess<KnowledgeWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(KNOWLEDGE_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "knowledge worker",
		reportCleanExit: true,
		unref: false,
	});
	const handle = createWorkerHandle<KnowledgeWorkerInbound, KnowledgeWorkerOutbound>(spawned, message => {
		const sent = spawned.proc.send(message);
		if (isThenable(sent)) sent.then(undefined, onSendError);
	});
	return { handle, spawned };
}

async function reapKnowledgeWorker(child: KnowledgeWorkerChild): Promise<void> {
	// Idle workers are unref'd; retirement must keep the parent alive until exit/drain completes.
	child.spawned.proc.ref();
	await child.handle.terminate();
	await child.spawned.proc.exited;
	await child.spawned.stderrDrained;
}

/** Lazy, owner-scoped subprocess facade. No SQLite code is imported or opened in the caller. */
export class KnowledgeService {
	readonly cwd: string;
	readonly databasePath: string;
	readonly #options: KnowledgeServiceOptions;
	readonly #cursorPath: string;
	#closed = false;
	#worker?: OwnedWorker;
	#retiring?: Promise<void>;
	#active?: Request;
	#queue: Request[] = [];
	#searches = new Set<AbortController>();

	constructor(options: KnowledgeServiceOptions) {
		this.cwd = path.resolve(options.cwd ?? process.cwd());
		// Cursor identity must match direct engine callers before resolving the worker's open path.
		this.#cursorPath = path.join(options.agentDir, "knowledge.db");
		// The helper's SDK/test fallback has its own cwd; resolve the DB in the caller's cwd.
		const agentDir = path.resolve(options.agentDir);
		this.databasePath = path.join(agentDir, "knowledge.db");
		this.#options = { agentDir, cwd: this.cwd };
	}

	async list(options: { signal?: AbortSignal } = {}): Promise<KnowledgeIndexSummary[]> {
		return (await this.#request({ type: "list" }, options.signal)).value;
	}

	async init(directory: string, name: string, options: KnowledgeBuildOptions = {}): Promise<KnowledgeBuildResult> {
		return (await this.#request({ type: "init", directory, name }, options.signal, options.onProgress)).value;
	}

	async retryVectors(options: KnowledgeBuildOptions = {}): Promise<KnowledgeVectorRetryResult> {
		return (await this.#request({ type: "retryVectors" }, options.signal, options.onProgress)).value;
	}

	async remove(name: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		await this.#request({ type: "remove", name }, options.signal);
	}

	search(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchResult> {
		return this.#search(query, options, false);
	}

	searchKnowledge(
		query: string,
		options: Pick<KnowledgeSearchOptions, "index" | "path" | "cursor" | "mode" | "case" | "signal"> = {},
	): Promise<KnowledgeToolPage> {
		return this.#search(query, options, true);
	}

	#search(query: string, options: KnowledgeSearchOptions, renderKnowledge: false): Promise<KnowledgeSearchResult>;
	#search(query: string, options: KnowledgeSearchOptions, renderKnowledge: true): Promise<KnowledgeToolPage>;
	async #search(
		query: string,
		options: KnowledgeSearchOptions,
		renderKnowledge: boolean,
	): Promise<KnowledgeSearchResult | KnowledgeToolPage> {
		const started = performance.now();
		const context = logContext();
		return logger.withLogContext(context, async () => {
			const controller = new AbortController();
			const onAbort = (): void => controller.abort(cancelled());
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) onAbort();
			this.#searches.add(controller);
			const fields = { component: "knowledge", event: "knowledge.search.outward", query_length: query.length };
			let reply: Reply<KnowledgeSearchWindow> | undefined;
			let floorWaitMs = 0;
			let budgetMs = 0;
			logger.info("knowledge.search.outward.started", { ...fields, stage: "worker", result: "started" });
			try {
				if (this.#closed) throw new Error("Document service is closed");
				controller.signal.throwIfAborted();
				const { limit, characterBudget } = knowledgeNormalizeSearchOptions(
					renderKnowledge ? 20 : options.limit,
					options.characterBudget,
				);
				reply = await this.#request(
					{
						type: "searchWindow",
						query,
						options: {
							index: options.index,
							path: options.path,
							limit,
							cursor: options.cursor,
							mode: options.mode,
							case: options.case,
						},
					},
					controller.signal,
				);
				controller.signal.throwIfAborted();
				const budgetStarted = performance.now();
				const window = reply.value;
				const prepared =
					renderKnowledge && options.mode !== "grep" && options.cursor === undefined
						? knowledgePrepareToolQuery(query, undefined, ["query"], false, undefined, undefined)
						: undefined;
				const page = renderKnowledge
					? knowledgeToolPage(prepared?.query ?? query, window, options.mode, options.case, options.path)
					: undefined;
				const result = page
					? page.result
					: knowledgeSelectPage(
							window,
							characterBudget,
							(hit, position) => options.sectionCost?.(hit, position),
							controller.signal,
							false,
						);
				budgetMs = performance.now() - budgetStarted;
				const floorStarted = performance.now();
				try {
					await knowledgeWaitMinimum(performance.now() - started, controller.signal);
				} finally {
					floorWaitMs = performance.now() - floorStarted;
				}
				controller.signal.throwIfAborted();
				logger.info("knowledge.search.outward.completed", {
					...fields,
					stage: "complete",
					result: "completed",
					returned_count: result.sections.length,
					total_matches: result.total,
					exact_name_matches: result.exactNameMatches,
					has_more: result.hasMore,
					engine_ms: reply.engine_ms,
					startup_engine_ms: reply.startup_engine_ms,
					ipc_ms: reply.ipc_ms,
					queue_ms: reply.queue_ms,
					budget_ms: budgetMs,
					floor_wait_ms: floorWaitMs,
					total_ms: performance.now() - started,
				});
				return page ?? result;
			} catch (error) {
				// Native waits use their own AbortError; preserve our cancellation/close reason.
				const failure = controller.signal.aborted ? controller.signal.reason : error;
				logger.info("knowledge.search.outward.finished", {
					...fields,
					stage: "complete",
					result: failure instanceof Error && failure.name === "AbortError" ? "cancelled" : "failed",
					engine_ms: reply?.engine_ms,
					startup_engine_ms: reply?.startup_engine_ms,
					ipc_ms: reply?.ipc_ms,
					queue_ms: reply?.queue_ms,
					budget_ms: budgetMs,
					floor_wait_ms: floorWaitMs,
					total_ms: performance.now() - started,
					...logger.diagnosticError(failure),
				});
				throw failure;
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
				this.#searches.delete(controller);
			}
		});
	}

	/** Synchronously cancels pending work; resolves after the owned child exits and drains. */
	close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			const error = new Error("Document service is closed");
			for (const controller of this.#searches) controller.abort(error);
			this.#failAll(error);
		}
		return (this.#retiring ??= Promise.resolve());
	}

	#request<C extends RequestCommand>(
		command: C,
		signal?: AbortSignal,
		onProgress?: (progress: KnowledgeProgress) => void,
	): Promise<Reply<KnowledgeWorkerResults[C["type"]]>> {
		if (this.#closed) return Promise.reject(new Error("Document service is closed"));
		if (signal?.aborted) return Promise.reject(cancelled());
		const { promise, resolve, reject } = Promise.withResolvers<Reply<KnowledgeWorkerResults[C["type"]]>>();
		const request: Request = {
			id: crypto.randomUUID(),
			command,
			context: logContext(),
			signal,
			onProgress,
			resolve: reply => resolve(reply as Reply<KnowledgeWorkerResults[C["type"]]>),
			reject,
			cleanup: () => signal?.removeEventListener("abort", onAbort),
			enqueuedAt: performance.now(),
			activeAt: 0,
			startupEngineMs: 0,
		};
		const onAbort = (): void => {
			if (this.#active === request) {
				this.#active = undefined;
				request.cleanup();
				request.reject(cancelled());
				// Cooperatively signal the operation before the hard process boundary.
				try {
					this.#worker?.handle.send({ type: "cancel", id: request.id, context: request.context });
				} catch {
					// The worker is already unavailable; discard still owns cleanup.
				}
				this.#discardWorker();
				void this.#pump();
			} else {
				const index = this.#queue.indexOf(request);
				if (index < 0) return;
				this.#queue.splice(index, 1);
				request.cleanup();
				request.reject(cancelled());
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#queue.push(request);
		void this.#pump();
		return promise;
	}

	async #pump(): Promise<void> {
		if (this.#closed || this.#active || this.#retiring) return;
		const request = this.#queue.shift();
		if (!request) {
			if (this.#worker && !isBunTestRuntime()) this.#worker.spawned.proc.unref();
			return;
		}
		this.#active = request;
		request.activeAt = performance.now();
		try {
			if (isCompanyLaneActive()) await setCompanyOfflineEnabled(true);
			if (this.#active !== request || this.#closed) return;
			let worker = this.#worker;
			if (!worker) {
				const { spawned, handle } = spawnKnowledgeWorker(error => {
					if (this.#worker === owned) this.#failAll(error);
				});
				const owned: OwnedWorker = { handle, spawned, configured: false, offMessage: () => {}, offError: () => {} };
				owned.offMessage = handle.onMessage(message => this.#receive(owned, message));
				owned.offError = handle.onError(error => {
					if (this.#worker === owned) this.#failAll(error);
				});
				worker = owned;
				this.#worker = owned;
			}
			worker.spawned.proc.ref();
			if (!worker.configured) {
				worker.configureId = crypto.randomUUID();
				worker.handle.send({
					type: "configure",
					id: worker.configureId,
					options: this.#options,
					company: companySnapshotForSubprocess(),
					cursorPath: this.#cursorPath,
					context: request.context,
				});
			} else {
				worker.handle.send({ ...request.command, id: request.id, context: request.context });
			}
		} catch (error) {
			if (this.#active === request) this.#failAll(error);
		}
	}

	#receive(worker: OwnedWorker, message: KnowledgeWorkerOutbound): void {
		if (this.#worker !== worker) return;
		const request = this.#active;
		if (!request) return;
		if (message.id === worker.configureId) {
			if (message.type === "progress") return;
			worker.configureId = undefined;
			if (message.type === "error") {
				this.#failAll(this.#remoteError(message));
				return;
			}
			if (message.command !== "configure") {
				this.#failAll(new Error("Invalid document worker configure response"));
				return;
			}
			worker.configured = true;
			request.startupEngineMs = message.engine_ms;
			try {
				worker.handle.send({ ...request.command, id: request.id, context: request.context });
			} catch (error) {
				this.#failAll(error);
			}
			return;
		}
		if (message.id !== request.id) return;
		if (message.type === "progress") {
			try {
				if (!request.signal?.aborted)
					logger.withLogContext(request.context, () => request.onProgress?.(message.progress));
			} catch (error) {
				this.#active = undefined;
				request.cleanup();
				request.reject(error);
				this.#discardWorker();
				void this.#pump();
			}
			return;
		}
		this.#active = undefined;
		request.cleanup();
		if (message.type === "error") {
			request.reject(this.#remoteError(message));
		} else if (message.command !== request.command.type) {
			request.reject(new Error("Invalid document worker response command"));
			this.#failAll(new Error("Document worker protocol mismatch"));
			return;
		} else {
			request.resolve({
				value: message.value,
				engine_ms: message.engine_ms,
				startup_engine_ms: request.startupEngineMs,
				ipc_ms: Math.max(0, performance.now() - request.activeAt - message.engine_ms - request.startupEngineMs),
				queue_ms: request.activeAt - request.enqueuedAt,
			});
		}
		void this.#pump();
	}

	#remoteError(message: Extract<KnowledgeWorkerOutbound, { type: "error" }>): Error {
		const error = new Error(message.error.message);
		error.name = message.error.name;
		if (message.error.code !== undefined) Object.assign(error, { code: message.error.code });
		return error;
	}

	#failAll(error: unknown): void {
		const pending = this.#active ? [this.#active, ...this.#queue] : this.#queue;
		this.#active = undefined;
		this.#queue = [];
		this.#discardWorker();
		for (const request of pending) {
			request.cleanup();
			request.reject(error);
		}
	}

	#discardWorker(): void {
		const worker = this.#worker;
		this.#worker = undefined;
		if (!worker) return;
		worker.offMessage();
		worker.offError();
		// Wait for exit/drain before allowing a new child to acquire this database's locks.
		const retiring = reapKnowledgeWorker(worker).catch(error => {
			logger.warn("knowledge.worker.terminate.failed", { component: "knowledge", ...logger.diagnosticError(error) });
		});
		this.#retiring = retiring;
		void retiring.then(() => {
			if (this.#retiring === retiring && !this.#closed) this.#retiring = undefined;
			void this.#pump();
		});
	}
}

/** The compiled CLI smoke must open/migrate/query a real isolated database, not just pong. */
export async function smokeTestKnowledgeWorker(): Promise<void> {
	const directory = await TempDir.create("@omp-knowledge-worker-smoke-");
	let child: KnowledgeWorkerChild | undefined;
	let offMessage: (() => void) | undefined;
	let offError: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	try {
		const sourceText = "# Smoke\ndocsworkersmokebeacon\n";
		const sourceRoot = directory.join("documents");
		await Bun.write(path.join(sourceRoot, "guide.md"), sourceText);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		child = spawnKnowledgeWorker(reject);
		const worker = child;
		const context = logContext();
		const configureId = crypto.randomUUID();
		const initId = crypto.randomUUID();
		const searchId = crypto.randomUUID();
		const sendSearch = (): void =>
			worker.handle.send({
				type: "searchWindow",
				id: searchId,
				context,
				query: "docsworkersmokebeacon",
				options: { limit: 1 },
			});
		offMessage = worker.handle.onMessage(message => {
			if (message.type === "progress") return;
			if (message.id !== configureId && message.id !== initId && message.id !== searchId) return;
			if (message.type === "error") {
				reject(new Error(`knowledge worker smoke: ${message.error.message}`));
				return;
			}
			if (
				(message.id === configureId && message.command === "configure") ||
				(message.id === initId && message.command === "init")
			) {
				try {
					if (message.id === configureId) {
						worker.handle.send({ type: "init", id: initId, context, directory: sourceRoot, name: "smoke" });
					} else {
						sendSearch();
					}
				} catch (error) {
					reject(error);
				}
				return;
			}
			if (message.id !== searchId || message.command !== "searchWindow") {
				reject(new Error("knowledge worker smoke: unexpected response"));
				return;
			}
			const result = message.value;
			if (
				result.total !== 1 ||
				result.sections.length !== 1 ||
				result.sections[0]?.index !== "smoke" ||
				result.sections[0]?.path !== "guide.md" ||
				result.sections[0]?.text !== sourceText ||
				result.cursorBase.p !== 0
			) {
				reject(new Error("knowledge worker smoke: indexed source evidence did not match"));
				return;
			}
			resolve();
		});
		offError = worker.handle.onError(reject);
		timer = setTimeout(
			() => reject(new Error("knowledge worker smoke: real database query timed out")),
			SMOKE_TEST_TIMEOUT_MS,
		);
		worker.handle.send({
			type: "configure",
			id: configureId,
			context,
			options: { agentDir: directory.join("agent") },
			cursorPath: directory.join("agent", "knowledge.db"),
		});
		await promise;
	} finally {
		clearTimeout(timer);
		offMessage?.();
		offError?.();
		try {
			if (child) await reapKnowledgeWorker(child);
		} finally {
			await directory.remove();
		}
	}
}
