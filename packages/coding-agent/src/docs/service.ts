import * as path from "node:path";
import {
	wikiNormalizeSearchOptions,
	wikiSelectPage,
	wikiToolPage,
	type WikiToolPage,
	wikiWaitMinimum,
} from "@oh-my-pi/pi-natives";
import { isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { DOCS_WORKER_ARG } from "../cli/worker-selectors";
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
	DocsBuildOptions,
	DocsBuildResult,
	DocsIndexSummary,
	DocsProgress,
	DocsSearchOptions,
	DocsSearchResult,
	DocsSearchWindow,
	DocsServiceOptions,
} from "./types";
import type {
	DocsWorkerCommand,
	DocsWorkerInbound,
	DocsWorkerLogContext,
	DocsWorkerOutbound,
	DocsWorkerResults,
} from "./worker-protocol";

type RequestCommand = Exclude<DocsWorkerCommand, { type: "configure" }>;
type DocsWorkerHandle = WorkerHandle<DocsWorkerInbound, DocsWorkerOutbound>;
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
	context: DocsWorkerLogContext;
	signal?: AbortSignal;
	onProgress?: (progress: DocsProgress) => void;
	resolve(reply: Reply<unknown>): void;
	reject(error: unknown): void;
	cleanup(): void;
	enqueuedAt: number;
	activeAt: number;
	startupEngineMs: number;
}
interface OwnedWorker {
	handle: DocsWorkerHandle;
	spawned: SpawnedSubprocess<DocsWorkerOutbound>;
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

function logContext(): DocsWorkerLogContext {
	const inherited = logger.getLogContext();
	const identifier = (value: unknown): string | undefined =>
		typeof value === "string" && /^[\w.:-]{1,160}$/.test(value) ? value : undefined;
	return {
		operation_id: identifier(inherited.operation_id) ?? `docs-${crypto.randomUUID()}`,
		call_id: `docs-worker-${crypto.randomUUID()}`,
		parent_call_id: identifier(inherited.call_id),
	};
}

interface DocsWorkerChild {
	handle: DocsWorkerHandle;
	spawned: SpawnedSubprocess<DocsWorkerOutbound>;
}

function spawnDocsWorker(onSendError: (error: unknown) => void): DocsWorkerChild {
	const spawned = createWorkerSubprocess<DocsWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(DOCS_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "docs worker",
		reportCleanExit: true,
		unref: false,
	});
	const handle = createWorkerHandle<DocsWorkerInbound, DocsWorkerOutbound>(spawned, message => {
		const sent = spawned.proc.send(message);
		if (isThenable(sent)) sent.then(undefined, onSendError);
	});
	return { handle, spawned };
}

async function reapDocsWorker(child: DocsWorkerChild): Promise<void> {
	// Idle workers are unref'd; retirement must keep the parent alive until exit/drain completes.
	child.spawned.proc.ref();
	await child.handle.terminate();
	await child.spawned.proc.exited;
	await child.spawned.stderrDrained;
}

/** Lazy, owner-scoped subprocess facade. No SQLite code is imported or opened in the caller. */
export class DocsService {
	readonly cwd: string;
	readonly databasePath: string;
	readonly #options: DocsServiceOptions;
	#closed = false;
	#worker?: OwnedWorker;
	#retiring?: Promise<void>;
	#active?: Request;
	#queue: Request[] = [];
	#searches = new Set<AbortController>();

	constructor(options: DocsServiceOptions) {
		this.cwd = path.resolve(options.cwd ?? process.cwd());
		const wikiDir = process.env.OMP_WIKI_DIR?.trim();
		const agentDir = wikiDir ? path.resolve(this.cwd, wikiDir) : options.agentDir;
		this.databasePath = path.join(agentDir, "docs.db");
		// The helper's SDK/test fallback has its own cwd; resolve the DB in the caller's cwd.
		this.#options = { agentDir: path.resolve(agentDir), cwd: this.cwd };
	}

	async list(options: { signal?: AbortSignal } = {}): Promise<DocsIndexSummary[]> {
		return (await this.#request({ type: "list" }, options.signal)).value;
	}

	async init(directory: string, name: string, options: DocsBuildOptions = {}): Promise<DocsBuildResult> {
		return (await this.#request({ type: "init", directory, name }, options.signal, options.onProgress)).value;
	}

	async remove(name: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		await this.#request({ type: "remove", name }, options.signal);
	}

	search(query: string, options: DocsSearchOptions = {}): Promise<DocsSearchResult> {
		return this.#search(query, options, false);
	}

	searchWiki(
		query: string,
		options: Pick<DocsSearchOptions, "index" | "cursor" | "mode" | "case" | "signal"> = {},
	): Promise<WikiToolPage> {
		return this.#search(query, options, true);
	}

	#search(query: string, options: DocsSearchOptions, renderWiki: false): Promise<DocsSearchResult>;
	#search(query: string, options: DocsSearchOptions, renderWiki: true): Promise<WikiToolPage>;
	async #search(
		query: string,
		options: DocsSearchOptions,
		renderWiki: boolean,
	): Promise<DocsSearchResult | WikiToolPage> {
		const started = performance.now();
		const context = logContext();
		return logger.withLogContext(context, async () => {
			const controller = new AbortController();
			const onAbort = (): void => controller.abort(cancelled());
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) onAbort();
			this.#searches.add(controller);
			const fields = { component: "docs", event: "docs.search.outward", query_length: query.length };
			let reply: Reply<DocsSearchWindow> | undefined;
			let floorWaitMs = 0;
			let budgetMs = 0;
			logger.info("docs.search.outward.started", { ...fields, stage: "worker", result: "started" });
			try {
				if (this.#closed) throw new Error("Document service is closed");
				controller.signal.throwIfAborted();
				const { limit, characterBudget } = wikiNormalizeSearchOptions(
					renderWiki ? 200 : options.limit,
					options.characterBudget,
				);
				reply = await this.#request(
					{
						type: "searchWindow",
						query,
						options: {
							index: options.index,
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
				const page = renderWiki ? wikiToolPage(query, window, options.mode, options.case) : undefined;
				const result = page
					? page.result
					: wikiSelectPage(
							window,
							characterBudget,
							(hit, position) => options.sectionCost?.(hit, position),
							controller.signal,
							false,
						);
				budgetMs = performance.now() - budgetStarted;
				const floorStarted = performance.now();
				try {
					await wikiWaitMinimum(performance.now() - started, controller.signal);
				} finally {
					floorWaitMs = performance.now() - floorStarted;
				}
				controller.signal.throwIfAborted();
				logger.info("docs.search.outward.completed", {
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
				logger.info("docs.search.outward.finished", {
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
		onProgress?: (progress: DocsProgress) => void,
	): Promise<Reply<DocsWorkerResults[C["type"]]>> {
		if (this.#closed) return Promise.reject(new Error("Document service is closed"));
		if (signal?.aborted) return Promise.reject(cancelled());
		const { promise, resolve, reject } = Promise.withResolvers<Reply<DocsWorkerResults[C["type"]]>>();
		const request: Request = {
			id: crypto.randomUUID(),
			command,
			context: logContext(),
			signal,
			onProgress,
			resolve: reply => resolve(reply as Reply<DocsWorkerResults[C["type"]]>),
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
				this.#discardWorker();
				this.#pump();
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
		this.#pump();
		return promise;
	}

	#pump(): void {
		if (this.#closed || this.#active || this.#retiring) return;
		const request = this.#queue.shift();
		if (!request) {
			if (this.#worker && !isBunTestRuntime()) this.#worker.spawned.proc.unref();
			return;
		}
		this.#active = request;
		request.activeAt = performance.now();
		try {
			let worker = this.#worker;
			if (!worker) {
				const { spawned, handle } = spawnDocsWorker(error => {
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
					databasePath: this.databasePath,
					context: request.context,
				});
			} else {
				worker.handle.send({ ...request.command, id: request.id, context: request.context });
			}
		} catch (error) {
			this.#failAll(error);
		}
	}

	#receive(worker: OwnedWorker, message: DocsWorkerOutbound): void {
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
				this.#pump();
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
		this.#pump();
	}

	#remoteError(message: Extract<DocsWorkerOutbound, { type: "error" }>): Error {
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
		const retiring = reapDocsWorker(worker).catch(error => {
			logger.warn("docs.worker.terminate.failed", { component: "docs", ...logger.diagnosticError(error) });
		});
		this.#retiring = retiring;
		void retiring.then(() => {
			if (this.#retiring === retiring && !this.#closed) this.#retiring = undefined;
			this.#pump();
		});
	}
}

/** The compiled CLI smoke must open/migrate/query a real isolated database, not just pong. */
export async function smokeTestDocsWorker(): Promise<void> {
	const directory = await TempDir.create("@omp-docs-worker-smoke-");
	let child: DocsWorkerChild | undefined;
	let offMessage: (() => void) | undefined;
	let offError: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	try {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		child = spawnDocsWorker(reject);
		const worker = child;
		const context = logContext();
		const configureId = crypto.randomUUID();
		const searchId = crypto.randomUUID();
		const sendSearch = (): void =>
			worker.handle.send({
				type: "searchWindow",
				id: searchId,
				context,
				query: "docs worker smoke",
				options: { limit: 1 },
			});
		offMessage = worker.handle.onMessage(message => {
			if (message.type === "progress") return;
			if (message.id !== configureId && message.id !== searchId) return;
			if (message.type === "error") {
				reject(new Error(`docs worker smoke: ${message.error.message}`));
				return;
			}
			if (message.id === configureId && message.command === "configure") {
				try {
					sendSearch();
				} catch (error) {
					reject(error);
				}
				return;
			}
			if (message.id !== searchId || message.command !== "searchWindow") {
				reject(new Error("docs worker smoke: unexpected response"));
				return;
			}
			const result = message.value;
			if (
				result.total !== 0 ||
				result.sections.length !== 0 ||
				result.exactNameMatches !== 0 ||
				result.cursorBase.p !== 0
			) {
				reject(new Error("docs worker smoke: expected successful empty database search"));
				return;
			}
			resolve();
		});
		offError = worker.handle.onError(reject);
		timer = setTimeout(
			() => reject(new Error("docs worker smoke: real database query timed out")),
			SMOKE_TEST_TIMEOUT_MS,
		);
		worker.handle.send({
			type: "configure",
			id: configureId,
			context,
			options: { agentDir: directory.path() },
			databasePath: directory.join("docs.db"),
		});
		await promise;
	} finally {
		clearTimeout(timer);
		offMessage?.();
		offError?.();
		try {
			if (child) await reapDocsWorker(child);
		} finally {
			await directory.remove();
		}
	}
}
