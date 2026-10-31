import * as path from "node:path";
import { fuseRanked } from "@oh-my-pi/pi-mnemopi/core/rank-fusion";
import {
	WikiSearchEngine,
	wikiCheckIndexingCancellation,
	wikiNormalizeSearchOptions,
	wikiPrepareToolQuery,
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
import { resolveWikiModels, type WikiEmbedding, type WikiReranker } from "./models";

const VECTOR_BATCH_SIZE = 32;
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
	logger.debug("docs.model.unavailable", { component: "docs", event: "docs.model", stage, result: "offline" });
}

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
	readonly #agentDir: string;
	readonly #native: WikiSearchEngine;

	constructor(options: DocsServiceOptions & { cursorPath?: string }) {
		this.cwd = path.resolve(options.cwd ?? process.cwd());
		this.#agentDir = path.resolve(options.agentDir);
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
			async () => {
				const context = logger.getLogContext();
				const build = await this.#native.initDeferred(
					path.resolve(this.cwd, directory),
					name,
					progress =>
						logger.withLogContext(context, () => {
							options.onProgress?.({ ...progress, phase: progress.phase as DocsProgressPhase });
						}),
					options.signal,
					nativeDiagnostics(),
				);
				const token = build.importToken;
				let published = false;
				try {
					options.signal?.throwIfAborted();
					let embedding: WikiEmbedding | undefined;
					try {
						embedding = (await resolveWikiModels({ agentDir: this.#agentDir, cwd: this.cwd, reranker: false }))
							.embedding;
					} catch {
						options.signal?.throwIfAborted();
						optionalModelFailure("import.resolve");
					}
					if (embedding) {
						let progressFailed = false;
						try {
							const generation = await this.#native.beginVectorImport(token, embedding.identity, options.signal);
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
		if (options.mode === "grep") {
			return this.#runSearchWindow(query, options, (nativeOptions, diagnostic) =>
				this.#native.searchWindowAsync(query, nativeOptions, signal, diagnostic),
			);
		}
		const prepared = wikiPrepareToolQuery(query, undefined, ["query"], false, undefined, undefined);
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
		options: WikiSearchOptions,
		diagnostic: (event: WikiDiagnosticEvent) => void,
		signal?: AbortSignal,
	): Promise<WikiSearchOutput> {
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
		options: WikiSearchOptions,
		diagnostic: (event: WikiDiagnosticEvent) => void,
		signal?: AbortSignal,
	): Promise<WikiSearchOutput> {
		let cacheable = true;
		let reranker: WikiReranker | undefined;
		let rerankerResolved = false;
		const resolveReranker = async (): Promise<void> => {
			if (rerankerResolved) return;
			rerankerResolved = true;
			try {
				reranker = (await resolveWikiModels({ agentDir: this.#agentDir, cwd: this.cwd, embedding: false }))
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
		let embedding: WikiEmbedding | undefined;
		try {
			embedding = (await resolveWikiModels({ agentDir: this.#agentDir, cwd: this.cwd, reranker: false })).embedding;
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
