import { statSync } from "node:fs";
import * as path from "node:path";
import { WikiSearchEngine, type WikiSearchOptions } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { acquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import { enumerateMarkdownFiles, readMarkdownDocument } from "./markdown";
import { BUILDING_INDEX_PREFIX, DocsStorage, normalizeFts } from "./storage";
import type {
	DocsBuildOptions,
	DocsBuildResult,
	DocsIndexSummary,
	DocsSearchOptions,
	DocsSearchResult,
	DocsSearchWindow,
	DocsSearchWindowOptions,
	DocsSectionHit,
	DocsServiceOptions,
	MarkdownDocument,
} from "./types";

const MAX_PAGE_SECTIONS = 500;

interface NativeSearchWindow {
	result: DocsSearchWindow;
	cacheHit: boolean;
	termCount: number;
}

function validateName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Document index name must not be empty");
	if ([...trimmed].length > 64) throw new Error("Document index name must contain at most 64 Unicode scalar values");
	if (/\p{Cc}/u.test(trimmed)) throw new Error("Document index name must not contain control characters");
	if (trimmed.startsWith(BUILDING_INDEX_PREFIX))
		throw new Error(`Document index name uses reserved prefix: ${BUILDING_INDEX_PREFIX}`);
	return trimmed;
}

function checkCancelled(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Document indexing cancelled");
	error.name = "AbortError";
	throw error;
}

/**
 * Bounded wait for the shared import lock. The holder keeps it for a whole
 * import, so a second import should report the conflict instead of queueing
 * behind minutes of indexing.
 */
const IMPORT_LOCK_OPTIONS = { retries: 3, retryDelayMs: 100 } as const;

/** Owns import storage and the mandatory native query engine in the docs worker. */
export class DocsSearchEngine {
	storage: DocsStorage;
	readonly cwd: string;
	readonly #agentDir: string;
	readonly #cursorPath: string;
	#fileIdentity: string;
	#closed = false;
	#native: WikiSearchEngine;

	constructor(options: DocsServiceOptions & { cursorPath?: string }) {
		const started = performance.now();
		this.storage = logger.withLogContext(
			{ operation_id: logger.getLogContext().operation_id ?? `docs-open-${crypto.randomUUID()}` },
			() => {
				logger.info("docs.database.started", {
					component: "docs",
					event: "docs.database",
					stage: "open",
					result: "started",
				});
				try {
					const storage = DocsStorage.open(options.agentDir);
					logger.info("docs.database.completed", {
						component: "docs",
						event: "docs.database",
						stage: "open",
						result: "completed",
						elapsed_ms: performance.now() - started,
					});
					return storage;
				} catch (error) {
					logger.error("docs.database.failed", {
						component: "docs",
						event: "docs.database",
						stage: "open",
						result: "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
		this.cwd = path.resolve(options.cwd ?? process.cwd());
		this.#agentDir = options.agentDir;
		// Worker opening paths are absolute; cursor identity retains the caller's
		// original database path spelling so existing relative-path cursors survive.
		this.#cursorPath = options.cursorPath ?? this.storage.path;
		this.#fileIdentity = this.#databaseIdentity();
		this.#native = new WikiSearchEngine(this.storage.path, this.#cursorPath);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#native.close();
		this.storage.close();
	}

	#databaseIdentity(): string {
		const stat = statSync(this.storage.path, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
	}

	#ensureDatabase(): void {
		if (this.#closed) throw new Error("Documentation search engine is closed");
		const identity = this.#databaseIdentity();
		if (identity === this.#fileIdentity) return;
		// A live connection can still point to an unlinked database after a swap.
		this.#native.close();
		this.storage.close();
		this.storage = DocsStorage.open(this.#agentDir);
		this.#fileIdentity = this.#databaseIdentity();
		this.#native = new WikiSearchEngine(this.storage.path, this.#cursorPath);
	}

	list(): DocsIndexSummary[] {
		this.#ensureDatabase();
		const context = logger.getLogContext();
		return logger.withLogContext(
			{
				operation_id: context.operation_id ?? `docs-list-${crypto.randomUUID()}`,
				parent_call_id: context.call_id,
				call_id: `docs-list-${crypto.randomUUID()}`,
			},
			() => {
				const started = performance.now();
				const fields = { component: "docs", event: "docs.list", stage: "query" };
				logger.info("docs.list.started", {
					...fields,
					result: "started",
					elapsed_ms: performance.now() - started,
				});
				try {
					const indexes = this.storage.list();
					logger.info("docs.list.completed", {
						...fields,
						result: "completed",
						index_count: indexes.length,
						elapsed_ms: performance.now() - started,
					});
					return indexes;
				} catch (error) {
					logger.error("docs.list.failed", {
						...fields,
						result: "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
	}

	async init(directory: string, name: string, options: DocsBuildOptions = {}): Promise<DocsBuildResult> {
		this.#ensureDatabase();
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `docs-init-${crypto.randomUUID()}`,
				index_hash:
					typeof name === "string" ? new Bun.CryptoHasher("sha256").update(name).digest("hex") : undefined,
			},
			async () => {
				const started = performance.now();
				let stage = "validate";
				let documentCount = 0;
				let sectionCount = 0;
				let fileCount = 0;
				let cleanup = "not_needed";
				let expectedResult: string | undefined;
				let published = false;
				const fields = () => ({
					component: "docs",
					event: "docs.init",
					stage,
					elapsed_ms: performance.now() - started,
					file_count: fileCount,
					document_count: documentCount,
					section_count: sectionCount,
				});
				logger.info("docs.init.started", { ...fields(), result: "started" });
				try {
					checkCancelled(options.signal);
					stage = "name_validation";
					const storedName = validateName(name);
					stage = "validate";
					if (this.storage.get(storedName)) {
						expectedResult = "duplicate_name";
						throw new Error(`Document index already exists: ${storedName}`);
					}
					const rootPath = path.resolve(this.cwd, directory);
					stage = "scan";
					const scanStarted = performance.now();
					logger.info("docs.init.scan.started", { ...fields(), result: "started" });
					const files = await enumerateMarkdownFiles(rootPath);
					fileCount = files.length;
					logger.info("docs.init.scan.completed", {
						...fields(),
						result: "completed",
						elapsed_ms: performance.now() - scanStarted,
					});
					checkCancelled(options.signal);
					if (files.length === 0) {
						expectedResult = "no_documents";
						throw new Error(`No Markdown files found in: ${rootPath}`);
					}
					// Enumeration runs before the lock: only the database writes need to be
					// exclusive, and the lease is held for the whole build.
					stage = "lock";
					const lockStarted = performance.now();
					logger.info("docs.init.lock.started", {
						...fields(),
						result: "started",
						retry_limit: IMPORT_LOCK_OPTIONS.retries,
					});
					let lease: FileLockHandle;
					try {
						lease = await acquireFileLock(this.storage.path, { ...IMPORT_LOCK_OPTIONS, signal: options.signal });
						logger.info("docs.init.lock.completed", {
							...fields(),
							result: "completed",
							elapsed_ms: performance.now() - lockStarted,
						});
					} catch (error) {
						const log = options.signal?.aborted ? logger.info : logger.warn;
						log("docs.init.lock.failed", {
							...fields(),
							result: options.signal?.aborted ? "cancelled" : "contended",
							elapsed_ms: performance.now() - lockStarted,
							...logger.diagnosticError(error),
						});
						checkCancelled(options.signal);
						throw new Error(
							`Another document index build is already running for this profile: ${this.storage.path}`,
							{ cause: error },
						);
					}
					try {
						checkCancelled(options.signal);
						stage = "validate";
						// Another import may have published this name while we waited for the lease.
						if (this.storage.get(storedName)) {
							expectedResult = "duplicate_name";
							throw new Error(`Document index already exists: ${storedName}`);
						}
						// A killed import leaves a half-built index behind; clear those out now that
						// this process is the one building.
						stage = "recovery";
						this.storage.removeAbandoned();
						stage = "create";
						const temp = this.storage.create({
							name: `${BUILDING_INDEX_PREFIX}${crypto.randomUUID()}`,
							rootPath,
						});
						try {
							options.onProgress?.({ phase: "scan", total: files.length, completed: 0, failed: 0 });
							stage = "read_parse";
							logger.info("docs.init.ingest.started", { ...fields(), result: "started" });
							let readParseMs = 0;
							let ftsMs = 0;
							let completed = 0;
							for (const relativePath of files) {
								checkCancelled(options.signal);
								stage = "read_parse";
								const readStarted = performance.now();
								// The reader parses internally; no per-document text or path is logged.
								let document: MarkdownDocument;
								try {
									document = await readMarkdownDocument(rootPath, relativePath);
								} catch (error) {
									// The reader wraps parse failures with this stable prefix; never log its text.
									stage =
										error instanceof Error && error.message.startsWith("Unable to parse Markdown ")
											? "parse"
											: "read";
									throw error;
								}
								readParseMs += performance.now() - readStarted;
								checkCancelled(options.signal);
								stage = "fts";
								if (completed === 0) logger.info("docs.init.fts.started", { ...fields(), result: "started" });
								const ftsStarted = performance.now();
								this.#commitDocument(temp.id, document);
								ftsMs += performance.now() - ftsStarted;
								completed++;
								documentCount = completed;
								sectionCount += document.sections.length;
								options.onProgress?.({
									phase: "fts",
									total: files.length,
									completed,
									failed: 0,
									currentPath: relativePath,
								});
							}
							logger.info("docs.init.read_parse.completed", {
								...fields(),
								stage: "read_parse",
								result: "completed",
								elapsed_ms: readParseMs,
							});
							logger.info("docs.init.parse.completed", { ...fields(), stage: "parse", result: "completed" });
							logger.info("docs.init.fts.completed", {
								...fields(),
								stage: "fts",
								result: "completed",
								elapsed_ms: ftsMs,
							});
							checkCancelled(options.signal);
							stage = "publish";
							const result = {
								processed: completed,
								failed: 0,
								index: this.storage.promote(temp.id, storedName),
							};
							published = true;
							return result;
						} catch (error) {
							const failedStage = stage;
							const cancelled = error instanceof Error && error.name === "AbortError";
							const log = cancelled ? logger.info : logger.error;
							log("docs.init.ingest.finished", {
								...fields(),
								result: cancelled ? "cancelled" : "failed",
								...logger.diagnosticError(error),
							});
							cleanup = "started";
							logger.info("docs.init.rollback.started", {
								...fields(),
								stage: "rollback",
								result: "started",
								failed_stage: failedStage,
							});
							try {
								this.storage.removeById(temp.id);
								cleanup = "completed";
								logger.info("docs.init.rollback.completed", {
									...fields(),
									stage: "rollback",
									result: "completed",
									failed_stage: failedStage,
								});
							} catch (cleanupError) {
								cleanup = "failed";
								stage = "rollback";
								logger.error("docs.init.rollback.failed", {
									...fields(),
									result: "failed",
									failed_stage: failedStage,
									...logger.diagnosticError(cleanupError),
								});
								throw cleanupError;
							}
							throw error;
						}
					} finally {
						logger.info("docs.init.lock.release.started", {
							...fields(),
							stage: "lock_release",
							result: "started",
						});
						const operationStage = stage;
						stage = "lock_release";
						lease.release();
						stage = operationStage;
						logger.info("docs.init.lock.release.completed", {
							...fields(),
							stage: "lock_release",
							result: "completed",
						});
						if (published) logger.info("docs.init.completed", { ...fields(), result: "completed", cleanup });
					}
				} catch (error) {
					const cancelled = error instanceof Error && error.name === "AbortError";
					if (
						stage === "scan" &&
						error instanceof Error &&
						error.message.startsWith("Markdown root is not a directory: ")
					) {
						expectedResult = "source_not_directory";
					}
					const log =
						cancelled || expectedResult || stage === "name_validation"
							? logger.info
							: stage === "lock"
								? logger.warn
								: logger.error;
					log("docs.init.finished", {
						...fields(),
						result: cancelled
							? "cancelled"
							: expectedResult || stage === "name_validation"
								? "rejected"
								: "failed",
						reason: expectedResult,
						cleanup,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
	}

	remove(name: string): void {
		this.#ensureDatabase();
		logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `docs-remove-${crypto.randomUUID()}`,
				index_hash:
					typeof name === "string" ? new Bun.CryptoHasher("sha256").update(name).digest("hex") : undefined,
			},
			() => {
				const started = performance.now();
				let notFound = false;
				const fields = { component: "docs", event: "docs.remove", stage: "delete" };
				logger.info("docs.remove.started", { ...fields, result: "started" });
				try {
					// Only visible rows move here; a hidden build belongs to the import lease.
					if (!this.storage.remove(name)) {
						notFound = true;
						logger.info("docs.remove.rejected", {
							...fields,
							result: "not_found",
							elapsed_ms: performance.now() - started,
						});
						throw new Error(`Unknown document index: ${name}`);
					}
					logger.info("docs.remove.completed", {
						...fields,
						result: "completed",
						elapsed_ms: performance.now() - started,
					});
				} catch (error) {
					if (!notFound)
						logger.error("docs.remove.failed", {
							...fields,
							result: "failed",
							elapsed_ms: performance.now() - started,
							...logger.diagnosticError(error),
						});
					throw error;
				}
			},
		);
	}

	#commitDocument(indexId: number, document: MarkdownDocument): void {
		const started = performance.now();
		let stage = "document_insert";
		try {
			this.storage.transaction(() => {
				const inserted = this.storage.db
					.query(
						"INSERT INTO documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms) VALUES(?,?,?,?,?,?,?) RETURNING id",
					)
					.get(
						indexId,
						document.relativePath,
						document.title,
						document.sourceKind,
						document.sha256,
						document.sizeBytes,
						document.mtimeMs,
					) as { id: number };
				for (const section of document.sections) {
					stage = "section_insert";
					const sectionRow = this.storage.db
						.query(
							"INSERT INTO sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
						)
						.get(
							indexId,
							inserted.id,
							section.ordinal,
							section.headingPath.join(" > "),
							section.headingLevel,
							section.lineStart,
							section.lineEnd,
							section.byteStart,
							section.byteEnd,
							section.rawMarkdown,
						) as { id: number };
					stage = "fts_insert";
					this.storage.db
						.query(
							"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
						)
						.run(
							sectionRow.id,
							sectionRow.id,
							indexId,
							section.ordinal === 0 ? normalizeFts(document.relativePath) : "",
							normalizeFts(section.headingPath.join(" > ")),
							normalizeFts(section.plainText),
						);
				}
			});
		} catch (error) {
			logger.error("docs.init.document.failed", {
				component: "docs",
				event: "docs.init.document",
				stage,
				result: "failed",
				elapsed_ms: performance.now() - started,
				section_count: document.sections.length,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}

	search(query: string, options: DocsSearchOptions = {}): DocsSearchResult {
		checkCancelled(options.signal);
		const budget = options.characterBudget ?? Number.POSITIVE_INFINITY;
		if (Number.isNaN(budget) || budget < 0) throw new Error("Invalid documentation search page size");
		const window = this.searchWindow(query, options);
		const sections: DocsSectionHit[] = [];
		let cost = 0;
		for (const hit of window.sections) {
			checkCancelled(options.signal);
			const sectionCost = options.sectionCost?.(hit, sections.length) ?? hit.text.length;
			if (!Number.isFinite(sectionCost) || sectionCost < 0)
				throw new Error("Invalid documentation search section cost");
			// Deliver the first hit whole; never skip a later nonfitting hit.
			if (sections.length > 0 && cost + sectionCost > budget) break;
			sections.push(hit);
			cost += sectionCost;
		}
		const next = window.cursorBase.p + sections.length;
		const hasMore = next < window.total;
		return {
			sections,
			total: window.total,
			exactNameMatches: window.exactNameMatches,
			...(window.technicalName === undefined ? {} : { technicalName: window.technicalName }),
			hasMore,
			...(hasMore
				? { cursor: Buffer.from(JSON.stringify({ ...window.cursorBase, p: next })).toString("base64url") }
				: {}),
		};
	}

	searchWindow(query: string, options: DocsSearchWindowOptions = {}): DocsSearchWindow {
		this.#ensureDatabase();
		return this.#runSearchWindow(query, options, nativeOptions => this.#native.searchWindow(query, nativeOptions));
	}

	async searchWindowAsync(
		query: string,
		options: DocsSearchWindowOptions = {},
		signal?: AbortSignal,
	): Promise<DocsSearchWindow> {
		this.#ensureDatabase();
		checkCancelled(signal);
		return this.#runSearchWindow(query, options, nativeOptions =>
			this.#native.searchWindowAsync(query, nativeOptions, signal),
		);
	}

	#runSearchWindow(
		query: string,
		options: DocsSearchWindowOptions,
		execute: (options: WikiSearchOptions) => NativeSearchWindow,
	): DocsSearchWindow;
	#runSearchWindow(
		query: string,
		options: DocsSearchWindowOptions,
		execute: (options: WikiSearchOptions) => Promise<NativeSearchWindow>,
	): Promise<DocsSearchWindow>;
	#runSearchWindow(
		query: string,
		options: DocsSearchWindowOptions,
		execute: (options: WikiSearchOptions) => NativeSearchWindow | Promise<NativeSearchWindow>,
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
				const completed = ({ result, cacheHit, termCount }: NativeSearchWindow): DocsSearchWindow => {
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
					const limit = Math.max(1, Math.min(MAX_PAGE_SECTIONS, Math.floor(options.limit ?? 10)));
					if (!Number.isFinite(limit)) throw new Error("Invalid documentation search page size");
					const response = execute({
						...(options.index === undefined ? {} : { index: options.index }),
						...(options.cursor === undefined ? {} : { cursor: options.cursor }),
						limit,
					});
					return response instanceof Promise ? response.then(completed).catch(failed) : completed(response);
				} catch (error) {
					return failed(error);
				}
			},
		);
	}
}
