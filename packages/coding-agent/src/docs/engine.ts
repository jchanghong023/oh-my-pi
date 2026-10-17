import * as path from "node:path";
import {
	FileLock as NativeFileLock,
	WikiSearchEngine,
	wikiCheckIndexingCancellation,
	wikiImportLeasePath,
	wikiNormalizeSearchOptions,
	wikiSelectPage,
	type WikiDiagnosticEvent,
	type WikiSearchOptions,
	type WikiSearchOutput,
} from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	DocsBuildOptions,
	DocsBuildResult,
	DocsIndexSummary,
	DocsProgressPhase,
	DocsSearchOptions,
	DocsSearchResult,
	DocsSearchWindow,
	DocsSearchWindowOptions,
	DocsServiceOptions,
} from "./types";

/** Native callbacks must retain their originating operation's logger context. */
function nativeDiagnostics(): (event: WikiDiagnosticEvent) => void {
	const context = logger.getLogContext();
	return event =>
		logger.withLogContext(context, () => {
			const log =
				event.level === "error"
					? logger.error
					: event.level === "warn"
						? logger.warn
						: event.level === "debug"
							? logger.debug
							: logger.info;
			log(event.message, {
				component: event.component,
				event: event.event,
				stage: event.stage,
				result: event.result,
				elapsed_ms: event.elapsedMs,
				file_count: event.fileCount,
				document_count: event.documentCount,
				section_count: event.sectionCount,
				index_count: event.indexCount,
				abandoned_index_count: event.abandonedIndexCount,
				retry_limit: event.retryLimit,
				schema_version: event.schemaVersion,
				supported_version: event.supportedVersion,
				from_version: event.fromVersion,
				to_version: event.toVersion,
				index_id: event.indexId,
				...(event.indexHash === undefined ? {} : { index_hash: event.indexHash }),
				cleanup: event.cleanup,
				rollback: event.rollback,
				failed_stage: event.failedStage,
				reason: event.reason,
				error_errno: event.errorErrno,
				...(event.errorType === undefined
					? {}
					: logger.diagnosticError({ name: event.errorType, code: event.errorCode })),
			});
		});
}

/** OMP path, callback and telemetry adapter for the native documentation owner. */
export class DocsSearchEngine {
	readonly cwd: string;
	readonly databasePath: string;
	readonly #native: WikiSearchEngine;

	constructor(options: DocsServiceOptions & { cursorPath?: string }) {
		this.cwd = path.resolve(options.cwd ?? process.cwd());
		const databasePath = path.join(options.agentDir, "docs.db");
		this.databasePath = path.resolve(databasePath);
		// Opening uses an absolute path; cursor identity retains caller spelling.
		this.#native = logger.withLogContext(
			{ operation_id: logger.getLogContext().operation_id ?? `docs-open-${crypto.randomUUID()}` },
			() => new WikiSearchEngine(this.databasePath, options.cursorPath ?? databasePath, nativeDiagnostics()),
		);
	}

	close(): void {
		this.#native.close();
	}

	list(): DocsIndexSummary[] {
		const context = logger.getLogContext();
		return logger.withLogContext(
			{
				operation_id: context.operation_id ?? `docs-list-${crypto.randomUUID()}`,
				parent_call_id: context.call_id,
				call_id: `docs-list-${crypto.randomUUID()}`,
			},
			() => this.#native.list(nativeDiagnostics()),
		);
	}

	async init(directory: string, name: string, options: DocsBuildOptions = {}): Promise<DocsBuildResult> {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `docs-init-${crypto.randomUUID()}`,
				index_hash:
					typeof name === "string" ? new Bun.CryptoHasher("sha256").update(name).digest("hex") : undefined,
			},
			() => {
				const context = logger.getLogContext();
				return this.#native.init(
					path.resolve(this.cwd, directory),
					name,
					progress =>
						logger.withLogContext(context, () => {
							options.onProgress?.({ ...progress, phase: progress.phase as DocsProgressPhase });
						}),
					options.signal,
					nativeDiagnostics(),
				);
			},
		);
	}

	remove(name: string): void {
		logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `docs-remove-${crypto.randomUUID()}`,
				index_hash:
					typeof name === "string" ? new Bun.CryptoHasher("sha256").update(name).digest("hex") : undefined,
			},
			() => this.#native.remove(name, nativeDiagnostics()),
		);
	}

	search(query: string, options: DocsSearchOptions = {}): DocsSearchResult {
		wikiCheckIndexingCancellation(options.signal);
		const { characterBudget } = wikiNormalizeSearchOptions(undefined, options.characterBudget);
		return wikiSelectPage(
			this.searchWindow(query, options),
			characterBudget,
			(hit, position) => options.sectionCost?.(hit, position),
			options.signal,
			true,
		);
	}

	searchWindow(query: string, options: DocsSearchWindowOptions = {}): DocsSearchWindow {
		return this.#runSearchWindow(query, options, (nativeOptions, diagnostic) =>
			this.#native.searchWindow(query, nativeOptions, diagnostic),
		);
	}

	async searchWindowAsync(
		query: string,
		options: DocsSearchWindowOptions = {},
		signal?: AbortSignal,
	): Promise<DocsSearchWindow> {
		wikiCheckIndexingCancellation(signal);
		return this.#runSearchWindow(query, options, (nativeOptions, diagnostic) =>
			this.#native.searchWindowAsync(query, nativeOptions, signal, diagnostic),
		);
	}

	#runSearchWindow(
		query: string,
		options: DocsSearchWindowOptions,
		execute: (options: WikiSearchOptions, diagnostic: (event: WikiDiagnosticEvent) => void) => WikiSearchOutput,
	): DocsSearchWindow;
	#runSearchWindow(
		query: string,
		options: DocsSearchWindowOptions,
		execute: (
			options: WikiSearchOptions,
			diagnostic: (event: WikiDiagnosticEvent) => void,
		) => Promise<WikiSearchOutput>,
	): Promise<DocsSearchWindow>;
	#runSearchWindow(
		query: string,
		options: DocsSearchWindowOptions,
		execute: (
			options: WikiSearchOptions,
			diagnostic: (event: WikiDiagnosticEvent) => void,
		) => WikiSearchOutput | Promise<WikiSearchOutput>,
	): DocsSearchWindow | Promise<DocsSearchWindow> {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `docs-search-${crypto.randomUUID()}`,
				...(options.index === undefined
					? {}
					: { index_hash: new Bun.CryptoHasher("sha256").update(options.index).digest("hex") }),
			},
			() => {
				const started = performance.now();
				const fields = { component: "docs", event: "docs.search", stage: "query" };
				logger.info("docs.search.started", { ...fields, result: "started", query_length: query.length });
				const completed = ({ result, cacheHit, termCount }: WikiSearchOutput): DocsSearchWindow => {
					logger.info("docs.search.completed", {
						...fields,
						result: result.sections.length ? "completed" : "no_match",
						elapsed_ms: performance.now() - started,
						term_count: termCount,
						section_count: result.sections.length,
						match_count: result.total,
						rank_cache_hit: cacheHit,
					});
					return result;
				};
				const failed = (error: unknown): never => {
					logger.error("docs.search.failed", {
						...fields,
						result: "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				};
				try {
					const response = execute(options, nativeDiagnostics());
					return response instanceof Promise ? response.then(completed).catch(failed) : completed(response);
				} catch (error) {
					return failed(error);
				}
			},
		);
	}
}
