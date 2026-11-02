import * as fs from "node:fs";
import * as path from "node:path";
import { fuseRanked } from "@oh-my-pi/pi-mnemopi/core/rank-fusion";
import {
	KnowledgeSearchEngine,
	knowledgeCheckIndexingCancellation,
	knowledgeNormalizeSearchOptions,
	knowledgePrepareToolQuery,
	knowledgeSelectPage,
	type KnowledgeDiagnosticEvent,
	type KnowledgeSearchOptions as NativeKnowledgeSearchOptions,
	type KnowledgeSearchOutput,
} from "@oh-my-pi/pi-natives";
import { isEexist, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { withFileLockSync } from "@oh-my-pi/pi-utils/file-lock";
import { Database } from "bun:sqlite";
import type {
	KnowledgeBuildOptions,
	KnowledgeBuildResult,
	KnowledgeIndexSummary,
	KnowledgeProgressPhase,
	KnowledgeSearchOptions,
	KnowledgeSearchResult,
	KnowledgeSearchWindow,
	KnowledgeSearchWindowOptions,
	KnowledgeServiceOptions,
} from "./types";
import {
	KNOWLEDGE_EMBEDDING_BATCH_SIZE,
	KNOWLEDGE_EMBEDDING_CHAR_BUDGET,
	KNOWLEDGE_EMBEDDING_CONCURRENCY,
	resolveKnowledgeModels,
	type KnowledgeEmbedding,
	type KnowledgeReranker,
} from "./models";

// Keep only one request window in memory while feeding every HTTP worker.
const VECTOR_BATCH_SIZE = KNOWLEDGE_EMBEDDING_BATCH_SIZE * KNOWLEDGE_EMBEDDING_CONCURRENCY;
const SEMANTIC_LIMIT = 64;
const RERANK_LIMIT = 40;

/** Validate the representation actually persisted, including float32 overflow/underflow. */
function vector32(values: readonly number[], dimensions?: number): Float32Array | undefined {
	if (!values.length || (dimensions !== undefined && values.length !== dimensions)) return undefined;
	const vector = Float32Array.from(values);
	let norm = 0;
	for (const value of vector) {
		if (!Number.isFinite(value)) return undefined;
		norm += value * value;
	}
	return Number.isFinite(norm) && norm > 0 ? vector : undefined;
}

function optionalModelFailure(stage: string): void {
	logger.debug("knowledge.model.unavailable", {
		component: "knowledge",
		event: "knowledge.model",
		stage,
		result: "offline",
	});
}

/** Native callbacks must retain their originating operation's logger context. */
function nativeDiagnostics(): (event: KnowledgeDiagnosticEvent) => void {
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

/**
 * Adopt a consistent SQLite snapshot, including committed WAL frames. Both files
 * may coexist: knowledge.db is authoritative, while docs.db remains a backup.
 * A same-directory hard link publishes only a complete snapshot and cannot
 * replace a database created by another process.
 */
function adoptLegacyDatabase(databasePath: string): void {
	const legacyPath = path.join(path.dirname(databasePath), "docs.db");
	const exists = (file: string): boolean => {
		try {
			fs.statSync(file);
			return true;
		} catch (error) {
			if (isEnoent(error)) return false;
			throw error;
		}
	};
	if (exists(databasePath)) {
		if (exists(legacyPath)) {
			logger.warn("knowledge.database.legacy_retained", {
				component: "knowledge",
				event: "knowledge.database.legacy_retained",
				database_path: databasePath,
				legacy_path: legacyPath,
			});
		}
		return;
	}
	if (!exists(legacyPath)) return;
	const staging = `${databasePath}.adopt-${crypto.randomUUID()}`;
	try {
		const legacy = new Database(legacyPath, { readonly: true });
		try {
			legacy.run("VACUUM INTO ?", [staging]);
		} finally {
			legacy.close();
		}
		try {
			fs.linkSync(staging, databasePath);
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
	} finally {
		fs.rmSync(staging, { force: true });
	}
}

/** OMP path, callback and telemetry adapter for the native documentation owner. */
export class KnowledgeIndexEngine {
	readonly cwd: string;
	readonly databasePath: string;
	readonly #agentDir: string;
	readonly #native: KnowledgeSearchEngine;

	constructor(options: KnowledgeServiceOptions & { cursorPath?: string }) {
		this.cwd = path.resolve(options.cwd ?? process.cwd());
		this.#agentDir = path.resolve(options.agentDir);
		const databasePath = path.join(options.agentDir, "knowledge.db");
		this.databasePath = path.resolve(databasePath);
		// Opening uses an absolute path; cursor identity retains caller spelling.
		fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
		this.#native = withFileLockSync(this.databasePath, () => {
			adoptLegacyDatabase(this.databasePath);
			return logger.withLogContext(
				{ operation_id: logger.getLogContext().operation_id ?? `knowledge-open-${crypto.randomUUID()}` },
				() => new KnowledgeSearchEngine(this.databasePath, options.cursorPath ?? databasePath, nativeDiagnostics()),
			);
		});
	}

	close(): void {
		this.#native.close();
	}

	list(): KnowledgeIndexSummary[] {
		const context = logger.getLogContext();
		return logger.withLogContext(
			{
				operation_id: context.operation_id ?? `knowledge-list-${crypto.randomUUID()}`,
				parent_call_id: context.call_id,
				call_id: `knowledge-list-${crypto.randomUUID()}`,
			},
			() => this.#native.list(nativeDiagnostics()),
		);
	}

	async init(directory: string, name: string, options: KnowledgeBuildOptions = {}): Promise<KnowledgeBuildResult> {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `knowledge-init-${crypto.randomUUID()}`,
				index_hash:
					typeof name === "string" ? new Bun.CryptoHasher("sha256").update(name).digest("hex") : undefined,
			},
			async () => {
				const context = logger.getLogContext();
				const build = await this.#native.initDeferred(
					path.resolve(this.cwd, directory),
					name,
					progress =>
						logger.withLogContext(context, () => {
							options.onProgress?.({ ...progress, phase: progress.phase as KnowledgeProgressPhase });
						}),
					options.signal,
					nativeDiagnostics(),
				);
				const token = build.importToken;
				let published = false;
				try {
					options.signal?.throwIfAborted();
					let embedding: KnowledgeEmbedding | undefined;
					try {
						embedding = (
							await resolveKnowledgeModels({ agentDir: this.#agentDir, cwd: this.cwd, reranker: false })
						).embedding;
					} catch {
						options.signal?.throwIfAborted();
						optionalModelFailure("import.resolve");
					}
					if (embedding) {
						let progressFailed = false;
						try {
							const generation = await this.#native.beginVectorImport(token, embedding.identity, options.signal);
							logger.info("knowledge.vector-import.started", {
								component: "knowledge",
								event: "knowledge.vector-import.started",
								section_count: generation.total,
								request_concurrency: KNOWLEDGE_EMBEDDING_CONCURRENCY,
								max_request_inputs: KNOWLEDGE_EMBEDDING_BATCH_SIZE,
								request_char_budget: KNOWLEDGE_EMBEDDING_CHAR_BUDGET,
								read_batch_size: VECTOR_BATCH_SIZE,
							});
							let completed = 0;
							const reportProgress = (): void => {
								try {
									logger.withLogContext(context, () =>
										options.onProgress?.({
											phase: "fts",
											total: generation.total,
											completed,
											failed: 0,
											message: "Preparing optional embedding vectors",
										}),
									);
								} catch (error) {
									progressFailed = true;
									throw error;
								}
							};
							reportProgress();
							let after = 0;
							let dimensions: number | undefined;
							let complete = true;
							for (;;) {
								const batch = await this.#native.readVectorImportBatch(
									token,
									after,
									VECTOR_BATCH_SIZE,
									options.signal,
								);
								if (!batch.sections.length) break;
								let vectors: number[][];
								try {
									vectors = await embedding.embed(
										batch.sections.map(section => section.text),
										options.signal,
									);
								} catch {
									options.signal?.throwIfAborted();
									optionalModelFailure("import.embedding");
									complete = false;
									break;
								}
								options.signal?.throwIfAborted();
								const rows: { sectionId: number; vector: Float32Array }[] = [];
								if (vectors.length !== batch.sections.length) complete = false;
								for (let i = 0; complete && i < batch.sections.length; i++) {
									const vector = vector32(vectors[i] ?? [], dimensions);
									if (!vector) {
										complete = false;
										break;
									}
									dimensions ??= vector.length;
									rows.push({ sectionId: batch.sections[i].sectionId, vector });
								}
								if (!complete) {
									optionalModelFailure("import.vector");
									break;
								}
								await this.#native.writeVectorImportBatch(token, rows, options.signal);
								completed += rows.length;
								reportProgress();
								if (batch.nextSectionId === undefined) break;
								after = batch.nextSectionId;
							}
							if (complete) await this.#native.publishVectorImport(token, options.signal);
						} catch (error) {
							if (progressFailed) throw error;
							options.signal?.throwIfAborted();
							if (error instanceof Error && error.name === "AbortError") throw error;
							// The final publication independently verifies database/build
							// identity and removes any incomplete vector generation.
							optionalModelFailure("import.vector-storage");
						}
					}
					options.signal?.throwIfAborted();
					await this.#native.publishDeferredImport(token, options.signal);
					published = true;
					return { index: build.index, processed: build.processed, failed: build.failed };
				} finally {
					if (!published) await this.#native.rollbackImport(token);
				}
			},
		);
	}

	remove(name: string): void {
		logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `knowledge-remove-${crypto.randomUUID()}`,
				index_hash:
					typeof name === "string" ? new Bun.CryptoHasher("sha256").update(name).digest("hex") : undefined,
			},
			() => this.#native.remove(name, nativeDiagnostics()),
		);
	}

	search(query: string, options: KnowledgeSearchOptions = {}): KnowledgeSearchResult {
		knowledgeCheckIndexingCancellation(options.signal);
		const { characterBudget } = knowledgeNormalizeSearchOptions(undefined, options.characterBudget);
		return knowledgeSelectPage(
			this.searchWindow(query, options),
			characterBudget,
			(hit, position) => options.sectionCost?.(hit, position),
			options.signal,
			true,
		);
	}

	searchWindow(query: string, options: KnowledgeSearchWindowOptions = {}): KnowledgeSearchWindow {
		return this.#runSearchWindow(query, options, (nativeOptions, diagnostic) =>
			this.#native.searchWindow(query, nativeOptions, diagnostic),
		);
	}

	async searchWindowAsync(
		query: string,
		options: KnowledgeSearchWindowOptions = {},
		signal?: AbortSignal,
	): Promise<KnowledgeSearchWindow> {
		knowledgeCheckIndexingCancellation(signal);
		if (options.mode === "grep") {
			return this.#runSearchWindow(query, options, (nativeOptions, diagnostic) =>
				this.#native.searchWindowAsync(query, nativeOptions, signal, diagnostic),
			);
		}
		const prepared = knowledgePrepareToolQuery(query, undefined, ["query"], false, undefined, undefined);
		if (prepared.error) throw new Error(prepared.error);
		const effectiveQuery = prepared.query ?? query;
		return this.#runSearchWindow(effectiveQuery, options, (nativeOptions, diagnostic) => {
			if (options.cursor !== undefined) {
				return this.#native.searchWindowAsync(effectiveQuery, nativeOptions, signal, diagnostic).catch(error => {
					// A pre-upgrade direct caller could create a cursor from an
					// untruncated query; only retry the precise identity mismatch.
					signal?.throwIfAborted();
					if (
						query !== effectiveQuery &&
						error instanceof Error &&
						error.message.includes("Documentation search cursor does not match query or index")
					) {
						return this.#native.searchWindowAsync(query, nativeOptions, signal, diagnostic);
					}
					throw error;
				});
			}
			return this.#adaptiveSearch(effectiveQuery, nativeOptions, diagnostic, signal);
		});
	}

	async #adaptiveSearch(
		query: string,
		options: NativeKnowledgeSearchOptions,
		diagnostic: (event: KnowledgeDiagnosticEvent) => void,
		signal?: AbortSignal,
	): Promise<KnowledgeSearchOutput> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await this.#adaptiveSearchOnce(query, options, diagnostic, signal);
			} catch (error) {
				signal?.throwIfAborted();
				if (
					!(error instanceof Error) ||
					error.message !== "Stale documentation search cursor: indexed snapshot has changed"
				) {
					throw error;
				}
			}
		}
		return this.#native.searchWindowAsync(query, options, signal, diagnostic);
	}

	async #adaptiveSearchOnce(
		query: string,
		options: NativeKnowledgeSearchOptions,
		diagnostic: (event: KnowledgeDiagnosticEvent) => void,
		signal?: AbortSignal,
	): Promise<KnowledgeSearchOutput> {
		let cacheable = true;
		let reranker: KnowledgeReranker | undefined;
		let rerankerResolved = false;
		const resolveReranker = async (): Promise<void> => {
			if (rerankerResolved) return;
			rerankerResolved = true;
			try {
				reranker = (await resolveKnowledgeModels({ agentDir: this.#agentDir, cwd: this.cwd, embedding: false }))
					.reranker;
			} catch {
				signal?.throwIfAborted();
				cacheable = false;
				optionalModelFailure("rerank.resolve");
			}
		};
		const configurationIdentity = (): string =>
			JSON.stringify({
				embedding: embedding?.identity,
				reranker: reranker?.identity,
				semanticLimit: SEMANTIC_LIMIT,
				rerankLimit: RERANK_LIMIT,
				rrf: 60,
			});
		let embedding: KnowledgeEmbedding | undefined;
		try {
			embedding = (await resolveKnowledgeModels({ agentDir: this.#agentDir, cwd: this.cwd, reranker: false }))
				.embedding;
		} catch {
			signal?.throwIfAborted();
			cacheable = false;
			optionalModelFailure("search.resolve");
		}
		signal?.throwIfAborted();
		if (!embedding) {
			const baseline = await this.#native.searchWindowAsync(query, options, signal, diagnostic);
			if (!baseline.result.total) return baseline;
			await resolveReranker();
			if (!reranker) return baseline;
		} else if (await this.#native.hasCachedHybridCandidates(query, options, signal)) {
			// Only resolve reranking before preparation when a cached result proves
			// there are candidates; empty searches must not resolve it.
			await resolveReranker();
		}
		if (cacheable) {
			const cached = await this.#native.lookupHybridSearch(query, options, configurationIdentity(), signal);
			if (cached) return cached;
		}
		const snapshot = await this.#native.prepareHybridSearch(query, options, embedding?.identity, signal);
		if ("result" in snapshot) return snapshot;
		if (snapshot.vectorFailure) {
			cacheable = false;
			optionalModelFailure("search.vector-read");
		}
		type Ranked = { sectionId: number; matchKind: string; sourceOrder: number };
		const fulltext: Ranked[] = snapshot.fulltext;
		let ranked = fulltext.slice();
		let embeddingUsed = false;
		if (embedding && snapshot.vectorDimensions.length) {
			let vector: Float32Array | undefined;
			try {
				const response = await embedding.embed([snapshot.effectiveQuery], signal);
				if (response.length === 1) vector = vector32(response[0] ?? []);
				if (!vector) {
					cacheable = false;
					optionalModelFailure("search.vector");
				}
			} catch {
				signal?.throwIfAborted();
				cacheable = false;
				optionalModelFailure("search.embedding");
			}
			signal?.throwIfAborted();
			const compatible = vector && snapshot.vectorDimensions.includes(vector.length);
			if (vector && !compatible) cacheable = false;
			if (compatible && vector) {
				const ids = (await this.#native.scoreHybridSearch(snapshot.token, vector, SEMANTIC_LIMIT, signal)) ?? [];
				if (ids.length) {
					const hits = await this.#native.readHybridCandidates(snapshot.token, ids, signal);
					const metadata = new Map(hits.map(hit => [hit.sectionId, hit as typeof hit & { sourceOrder: number }]));
					const semantic: Ranked[] = ids.map(id => {
						const hit = metadata.get(id);
						if (!hit) throw new Error("Missing documentation semantic candidate");
						return { sectionId: id, matchKind: hit.matchKind, sourceOrder: hit.sourceOrder };
					});
					const sources = new Map([...fulltext, ...semantic].map(item => [item.sectionId, item.sourceOrder]));
					ranked = fuseRanked(
						[fulltext, semantic],
						item => item.sectionId,
						(a, b) => (sources.get(a) ?? 0) - (sources.get(b) ?? 0) || a - b,
					).map(entry => entry.item);
					// Complete-name evidence always precedes related evidence, regardless of RRF score.
					ranked = [
						...ranked.filter(item => item.matchKind === "exact-name"),
						...ranked.filter(item => item.matchKind !== "exact-name"),
					];
					embeddingUsed = true;
				}
			}
		}

		let rerankerUsed: string | undefined;
		if (ranked.length) {
			await resolveReranker();
			if (reranker) {
				const window = ranked.slice(0, RERANK_LIMIT);
				const hits = await this.#native.readHybridCandidates(
					snapshot.token,
					window.map(item => item.sectionId),
					signal,
				);
				const byId = new Map(hits.map(hit => [hit.sectionId, hit]));
				const texts = window.map(item => {
					const hit = byId.get(item.sectionId);
					if (!hit) throw new Error("Missing documentation rerank candidate");
					return hit.text;
				});
				let scores: number[] | undefined;
				try {
					scores = await reranker.rerank(snapshot.effectiveQuery, texts, signal);
					if (scores.length !== window.length || scores.some(score => !Number.isFinite(score))) {
						scores = undefined;
						cacheable = false;
						optionalModelFailure("rerank.response");
					}
				} catch {
					signal?.throwIfAborted();
					cacheable = false;
					optionalModelFailure("rerank.request");
				}
				signal?.throwIfAborted();
				if (scores) {
					const ordered = window.map((item, index) => ({ item, index, score: scores[index] }));
					for (const kind of new Set(window.map(item => item.matchKind))) {
						const positions = ordered.filter(entry => entry.item.matchKind === kind).map(entry => entry.index);
						const sorted = ordered
							.filter(entry => entry.item.matchKind === kind)
							.sort((a, b) => b.score - a.score || a.index - b.index);
						positions.forEach((position, i) => {
							ranked[position] = sorted[i].item;
						});
					}
					rerankerUsed = reranker.identity;
				}
			}
		}
		signal?.throwIfAborted();
		const identity =
			embeddingUsed || rerankerUsed
				? JSON.stringify({
						embedding: embeddingUsed ? embedding?.identity : undefined,
						reranker: rerankerUsed,
						semanticLimit: SEMANTIC_LIMIT,
						rerankLimit: RERANK_LIMIT,
						rrf: 60,
					})
				: "";
		return this.#native.finishHybridSearch(
			snapshot.token,
			ranked.map(item => item.sectionId),
			identity,
			cacheable ? configurationIdentity() : "",
			signal,
		);
	}

	#runSearchWindow(
		query: string,
		options: KnowledgeSearchWindowOptions,
		execute: (
			options: NativeKnowledgeSearchOptions,
			diagnostic: (event: KnowledgeDiagnosticEvent) => void,
		) => KnowledgeSearchOutput,
	): KnowledgeSearchWindow;
	#runSearchWindow(
		query: string,
		options: KnowledgeSearchWindowOptions,
		execute: (
			options: NativeKnowledgeSearchOptions,
			diagnostic: (event: KnowledgeDiagnosticEvent) => void,
		) => Promise<KnowledgeSearchOutput>,
	): Promise<KnowledgeSearchWindow>;
	#runSearchWindow(
		query: string,
		options: KnowledgeSearchWindowOptions,
		execute: (
			options: NativeKnowledgeSearchOptions,
			diagnostic: (event: KnowledgeDiagnosticEvent) => void,
		) => KnowledgeSearchOutput | Promise<KnowledgeSearchOutput>,
	): KnowledgeSearchWindow | Promise<KnowledgeSearchWindow> {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `knowledge-search-${crypto.randomUUID()}`,
				...(options.index === undefined
					? {}
					: { index_hash: new Bun.CryptoHasher("sha256").update(options.index).digest("hex") }),
			},
			() => {
				const started = performance.now();
				const fields = { component: "knowledge", event: "knowledge.search", stage: "query" };
				logger.info("knowledge.search.started", { ...fields, result: "started", query_length: query.length });
				const completed = ({ result, cacheHit, termCount }: KnowledgeSearchOutput): KnowledgeSearchWindow => {
					logger.info("knowledge.search.completed", {
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
					logger.error("knowledge.search.failed", {
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
