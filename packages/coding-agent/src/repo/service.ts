import { randomUUID, createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { realpathSync, rmSync } from "node:fs";
import * as path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { pythonSymbols } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { acquireFileLock, tryAcquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import { countNewlines, logger, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import {
	enumerateFiles,
	indexedCandidate,
	readRepoFile,
	relativePath,
	REPO_EXCLUSIONS,
	type FileRead,
	type ReadResult,
} from "./files";
import { RepoStorage, type IndexedFile } from "./storage";
import type {
	RepoFailure,
	RepoMaintenanceOptions,
	RepoQueryOptions,
	RepoQueryResult,
	RepoStatus,
	RepoSymbolHit,
	RepoTextHit,
} from "./types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CANDIDATES = 100_000;
const MAX_QUERY_LENGTH = 500;

interface TextCandidate {
	id: number;
	path: string;
	category: RepoTextHit["category"];
	offset: number;
	score: number;
}

// Tool calls reopen the service. Retain only bounded locator/score metadata,
// keyed by database, immutable generation and query, never source text.
const searchPages = new LRUCache<string, TextCandidate[]>({
	max: 16,
	maxSize: 8 * 1024 * 1024,
	sizeCalculation: hits => hits.reduce((size, hit) => size + hit.path.length * 2 + 64, 1),
});

function check(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

function queryPath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const relative = value.replaceAll("\\", "/");
	if (path.posix.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes("\0"))
		throw new Error("Repository path must be relative to the index root; absolute paths are not supported");
	const normalized = path.posix.normalize(relative);
	if (normalized === ".." || normalized.startsWith("../"))
		throw new Error("Repository path must stay within the index root");
	return normalized === "." ? undefined : normalized.replace(/\/$/, "");
}
/** A .py file whose syntax tree carries errors is indexed without symbols and reported as a parse failure. */
function pythonParseFailure(path: string): RepoFailure {
	return { path, kind: "parse", message: "Python syntax tree contains parse errors; symbols omitted" };
}
/** Pending rows can outnumber the engine's spread-argument limit, so accumulate the maximum without spreading. */
export function maxPendingSeq(rows: Array<{ seq: number }>): number {
	let max = rows[0]!.seq;
	for (const row of rows) if (row.seq > max) max = row.seq;
	return max;
}
/** Map a UTF-16 offset in lowercased text back to the original source. */
function originalOffset(text: string, loweredOffset: number): number {
	let source = 0;
	let lowered = 0;
	while (source < text.length && lowered < loweredOffset) {
		const codepoint = String.fromCodePoint(text.codePointAt(source)!);
		const folded = codepoint.toLowerCase();
		if (lowered + folded.length > loweredOffset) break;
		lowered += folded.length;
		source += codepoint.length;
	}
	return source;
}

function snippet(text: string, index: number): { startLine: number; endLine: number; snippet: string } {
	let startLine = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) startLine++;
	const lineEnd = text.indexOf("\n", index);
	const end = lineEnd < 0 ? text.length : lineEnd;
	const start = text.lastIndexOf("\n", index - 1) + 1;
	const lineLength = end - start - (text.charCodeAt(end - 1) === 13 ? 1 : 0);
	const matchColumn = index - start;
	const cutStart = Math.max(0, Math.min(matchColumn - 65, lineLength - 180));
	const excerpt = sanitizeText(
		truncate(text.slice(start + cutStart, Math.min(start + lineLength, start + cutStart + 181)), 180),
	);
	return { startLine, endLine: startLine, snippet: `${cutStart ? "…" : ""}${excerpt}` };
}

/** One canonical scope for the panel, tool and session lifecycle (Git worktree or non-Git cwd). */
export function resolveRepoRoot(cwd: string): string {
	const canonical = realpathSync(cwd);
	let repoRoot: string | null = null;
	try {
		const repo = vcs.repo(canonical);
		if (repo?.kind() === "git") repoRoot = repo.root();
	} catch (error) {
		logger.warn("Repository root VCS detection unavailable", {
			component: "repo",
			event: "repo_scope",
			stage: "vcs_detect",
			result: "fallback",
			...logger.diagnosticError(error),
		});
		/* Non-VCS directories are valid. */
	}
	return realpathSync(repoRoot ?? canonical);
}

function diagnosticGeneration(value: string | null): string | null {
	return value === null || /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function repoDiagnosticSummary(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") return {};
	if ("coverage" in value && "hits" in value) {
		const query = value as RepoQueryResult<unknown>;
		return {
			...repoDiagnosticSummary(query.coverage),
			query_status: query.status,
			hit_count: query.hits.length,
			has_cursor: Boolean(query.cursor),
			truncated: query.truncated,
		};
	}
	if ("pendingCount" in value) {
		const status = value as RepoStatus;
		return {
			generation: diagnosticGeneration(status.generation),
			exists: status.exists,
			file_count: status.fileCount,
			symbol_count: status.symbolCount,
			failure_count: status.failureCount,
			pending_count: status.pendingCount,
			uncertain_count: status.uncertainCount,
			unchecked: status.unchecked,
			incomplete: status.incomplete,
		};
	}
	return {};
}

export class RepoService {
	readonly root: string;
	readonly storage: RepoStorage;
	#closed = false;
	#closing = new AbortController();
	#active = new Set<Promise<unknown>>();
	#gate: Promise<void> = Promise.resolve();
	#head: string | null = null;
	readonly #agentDir: string;
	readonly #excludedIndexPath?: string;

	/** Observe boundaries without reading storage again or exposing index contents. */
	async #diagnose<T>(
		action: string,
		work: (stage: (name: string, fields?: Record<string, unknown>, checkpoint?: boolean) => void) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const context = logger.getLogContext();
		return logger.withLogContext(
			{
				operation_id: context.operation_id ?? `repo-${randomUUID()}`,
				parent_call_id: context.call_id,
				call_id: `repo-${randomUUID()}`,
			},
			async () => {
				const started = performance.now();
				let currentStage = "dispatch";
				let activeStep = currentStage;
				let stageStarted = started;
				const fields = { component: "repo", action };
				const details: Record<string, unknown> = {};
				const stage = (name: string, summary?: Record<string, unknown>, checkpoint = false) => {
					activeStep = name;
					if (checkpoint) return;
					if (summary) Object.assign(details, summary);
					const now = performance.now();
					logger.info("Repository stage completed", {
						...fields,
						event: "repo_stage",
						stage: currentStage,
						result: "completed",
						elapsed_ms: now - stageStarted,
						...summary,
					});
					currentStage = name;
					stageStarted = now;
					logger.info("Repository stage started", {
						...fields,
						event: "repo_stage",
						stage: name,
						result: "started",
						...summary,
					});
				};
				logger.info("Repository operation started", {
					...fields,
					event: "repo_operation",
					stage: currentStage,
					result: "started",
				});
				// One bounded heartbeat exposes a blocked read/parser without per-file events.
				const heartbeat = setInterval(() => {
					logger.info("Repository operation still running", {
						...fields,
						event: "repo_wait",
						stage: currentStage,
						active_step: activeStep,
						result: "waiting",
						elapsed_ms: performance.now() - started,
						...details,
					});
				}, 30_000);
				heartbeat.unref();
				try {
					const value = await work(stage);
					const summary = repoDiagnosticSummary(value);
					logger.info("Repository operation completed", {
						...fields,
						event: "repo_operation",
						stage: currentStage,
						result: "completed",
						elapsed_ms: performance.now() - started,
						stage_elapsed_ms: performance.now() - stageStarted,
						...details,
						...summary,
					});
					return value;
				} catch (error) {
					const cancelled = signal?.aborted || this.#closing.signal.aborted;
					const log = cancelled ? logger.info : logger.error;
					log("Repository operation ended", {
						...fields,
						event: "repo_operation",
						stage: currentStage,
						result: cancelled ? "cancelled" : "failed",
						elapsed_ms: performance.now() - started,
						stage_elapsed_ms: performance.now() - stageStarted,
						...logger.diagnosticError(error),
						active_step: activeStep,
						...details,
					});
					throw error;
				} finally {
					clearInterval(heartbeat);
				}
			},
		);
	}

	constructor(options: { agentDir: string; cwd: string; root?: string; excludeIndexPath?: string }) {
		this.root = options.root ?? resolveRepoRoot(options.cwd);
		this.#agentDir = options.agentDir;
		this.#excludedIndexPath = options.excludeIndexPath;
		this.storage = new RepoStorage(options.agentDir, this.root);
	}

	#ensureOpen(): void {
		if (this.#closed) throw new Error("Repository index service is closed");
	}

	async status(): Promise<RepoStatus> {
		return this.#diagnose("status", async stage => {
			this.#ensureOpen();
			stage("snapshot");
			return this.storage.read(() => this.#statusSnapshot());
		});
	}

	#statusSnapshot(db = this.storage.db): RepoStatus {
		const state = this.storage.state(db);
		const totals = db
			.query(
				"SELECT (SELECT count(*) FROM failures WHERE generation=?) failures,(SELECT count(*) FROM pending) pending,(SELECT count(*) FROM uncertainty) uncertainty",
			)
			.get(state.generation) as { failures: number; pending: number; uncertainty: number };
		const failures = state.generation ? this.storage.failures(state.generation, 50, db) : [];
		const pendingPaths = this.storage.pending(50, db).map(row => row.path);
		const uncertainReasons = this.storage.uncertainty(20, db);
		const counts = state.generation ? this.storage.counts(state.generation, db) : { files: 0, symbols: 0 };
		return {
			root: this.root,
			exists: state.generation !== null,
			generation: state.generation,
			fileCount: counts.files,
			symbolCount: counts.symbols,
			failures,
			failureCount: totals.failures,
			failuresTruncated: totals.failures > failures.length,
			pendingPaths,
			pendingCount: totals.pending,
			pendingTruncated: totals.pending > pendingPaths.length,
			needsReconcile: totals.uncertainty > 0,
			uncertainReasons,
			uncertainCount: totals.uncertainty,
			uncertaintyTruncated: totals.uncertainty > uncertainReasons.length,
			unchecked: state.checked_at === null || totals.uncertainty > 0,
			lastFullCheck: state.checked_at,
			incomplete: state.generation === null || totals.failures > 0 || totals.uncertainty > 0 || totals.pending > 0,
			exclusions: REPO_EXCLUSIONS,
		};
	}

	markChanged(paths: string[]): void {
		this.#ensureOpen();
		const accepted = new Set<string>();
		for (const pathname of paths) {
			const rel = relativePath(this.root, path.isAbsolute(pathname) ? pathname : path.join(this.root, pathname));
			if (rel) accepted.add(rel);
		}
		this.storage.markChanged([...accepted]);
		logger.info("Repository change hints recorded", {
			component: "repo",
			event: "repo_hints",
			stage: "notification",
			result: "completed",
			notification_count: paths.length,
			accepted_count: accepted.size,
		});
	}

	markUncertain(reason: string): void {
		this.#ensureOpen();
		if (reason.trim()) {
			this.storage.markUncertain(reason.trim().slice(0, 200));
			logger.info("Repository scope marked unchecked", {
				component: "repo",
				event: "repo_unchecked",
				stage: "notification",
				result: "completed",
			});
		}
	}

	/** Read cheap Git status/HEAD hints; absence of a Git hint never certifies the whole tree. */
	async discoverChanges(): Promise<void> {
		return this.#diagnose("discover", async stage => {
			this.#ensureOpen();
			if (this.storage.recoveryError) {
				stage("recovery_required");
				return;
			}
			const initial = this.storage.state();
			if (!initial.generation) {
				stage("missing");
				return;
			}
			const stillCurrent = (): boolean => {
				if (this.#closed || this.storage.recoveryError) {
					stage(this.#closed ? "closed" : "recovery_required");
					return false;
				}
				try {
					const state = this.storage.state();
					const current = state.epoch === initial.epoch && state.generation !== null;
					if (!current) stage("stale");
					return current;
				} catch (error) {
					logger.warn("Repository discovery state unavailable", {
						component: "repo",
						event: "repo_discovery",
						stage: "state",
						result: "failed",
						...logger.diagnosticError(error),
					});
					stage("state_unavailable");
					return false;
				}
			};
			stage("git_open");
			const git = vcs.git(this.root);
			if (!git) {
				stage("no_git");
				return;
			}
			let gitStage = "git_head";
			try {
				stage("git_head");
				const head = await git.headSha();
				if (!stillCurrent()) return;
				const headChanged = this.#head !== null && head !== this.#head;
				logger.info("Repository HEAD hint received", {
					component: "repo",
					event: "repo_discovery",
					stage: "git_head",
					result: "completed",
					head_changed: headChanged,
				});
				if (headChanged) this.markUncertain("Git HEAD changed; complete reconciliation recommended");
				this.#head = head ?? null;
				gitStage = "git_status";
				stage("git_status");
				const output = await git.statusPorcelain({ untracked: "all", nulTerminated: true });
				if (!stillCurrent()) return;
				const paths: string[] = [];
				const entries = output.split("\0");
				for (let i = 0; i < entries.length; i++) {
					const entry = entries[i];
					if (entry.length < 4 || entry[2] !== " ") continue;
					paths.push(entry.slice(3));
					// Rename/copy sources are raw filenames, not another status record.
					if (/[RC]/.test(entry.slice(0, 2))) {
						const original = entries[++i];
						if (original) paths.push(original);
					}
				}
				this.markChanged(paths);
				stage("notified", { notification_count: paths.length });
			} catch (error) {
				const current = stillCurrent();
				logger[current ? "warn" : "info"]("Repository Git hint discovery failed", {
					component: "repo",
					event: "repo_discovery",
					stage: gitStage,
					result: current ? "failed" : this.#closed ? "closed" : "stale",
					...logger.diagnosticError(error),
				});
				if (current)
					this.markUncertain(
						`Git change discovery failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			}
		});
	}

	#exclusive<T>(
		work: (signal: AbortSignal, epoch: number) => Promise<T>,
		options?: RepoMaintenanceOptions,
		allowAfterRemoval?: boolean,
	): Promise<T>;
	#exclusive<T>(
		work: (signal: AbortSignal, epoch: number) => Promise<T>,
		options: RepoMaintenanceOptions,
		allowAfterRemoval: boolean,
		tryOnly: true,
	): Promise<T | undefined>;
	async #exclusive<T>(
		work: (signal: AbortSignal, epoch: number) => Promise<T>,
		options: RepoMaintenanceOptions = {},
		allowAfterRemoval = false,
		tryOnly = false,
	): Promise<T | undefined> {
		return this.#diagnose(
			"exclusive",
			async stage => {
				this.#ensureOpen();
				const initialState = this.storage.recoveryError ? undefined : this.storage.state();
				const epoch = initialState?.epoch ?? 0;
				const signal = options.signal
					? AbortSignal.any([options.signal, this.#closing.signal])
					: this.#closing.signal;
				const previous = this.#gate;
				const { promise, resolve: release } = Promise.withResolvers<void>();
				if (!tryOnly) this.#gate = promise;
				const task = (async () => {
					stage("queue_wait", {
						queued_operation_count: this.#active.size,
						queue_generation: initialState ? diagnosticGeneration(initialState.generation) : null,
						recovery_required: Boolean(this.storage.recoveryError),
					});
					if (!tryOnly) await previous;
					let lease: FileLockHandle | undefined;
					try {
						check(signal);
						stage("lock_wait");
						lease = tryOnly
							? (tryAcquireFileLock(this.storage.path) ?? undefined)
							: await acquireFileLock(this.storage.path, { signal });
						if (!lease) {
							stage("maintenance_busy");
							return;
						}
						stage("abandoned_cleanup");
						if (!allowAfterRemoval && this.storage.state().epoch !== epoch)
							throw new Error("Repository index was removed while this operation waited; retry explicitly");
						if (!this.storage.recoveryError) this.storage.removeAbandoned();
						stage("work");
						return await work(signal, epoch);
					} finally {
						lease?.release();
						release();
					}
				})();
				this.#active.add(task);
				try {
					return await task;
				} finally {
					this.#active.delete(task);
				}
			},
			options.signal,
		);
	}

	async #extract(file: FileRead, signal: AbortSignal): Promise<IndexedFile> {
		if (!file.path.endsWith(".py")) return { ...file, symbols: [] };
		const moduleName = file.path
			.replace(/\.py$/, "")
			.replace(/\/__init__$/, "")
			.replaceAll("/", ".");
		const symbols: IndexedFile["symbols"] = [
			{
				name: moduleName.split(".").at(-1) ?? moduleName,
				qualname: moduleName,
				kind: "module",
				startLine: 1,
				endLine: Math.max(1, countNewlines(file.text) + (file.text.endsWith("\n") ? 0 : 1)),
			},
		];
		const parsed = await pythonSymbols({ code: file.text, signal });
		check(signal);
		if (parsed.parseError) return { ...file, symbols: [] };
		for (const symbol of parsed.symbols)
			symbols.push({
				name: symbol.name,
				qualname: symbol.qualname,
				kind: symbol.kind as RepoSymbolHit["kind"],
				startLine: symbol.startLine,
				endLine: symbol.endLine,
				signature: symbol.signature,
			});
		return { ...file, symbols };
	}

	async #full(mode: "build" | "reconcile" | "rebuild", options: RepoMaintenanceOptions): Promise<RepoStatus> {
		return this.#diagnose(
			mode,
			async stage =>
				this.#exclusive(async (signal, epoch) => {
					const state = this.storage.state();
					stage("validate", { old_generation: diagnosticGeneration(state.generation) });
					if (mode === "build" && state.generation)
						throw new Error("Repository index already exists; reconcile or rebuild instead");
					if (mode === "reconcile" && !state.generation)
						throw new Error("Repository index does not exist; build it first");
					const generation = randomUUID();
					let published = false;
					let processed = 0;
					let parsed = 0;
					let failures = 0;
					let step = "enumerate";
					let fileHash: string | undefined;
					let readFailureKind: NonNullable<ReadResult["failure"]>["kind"] | "missing" | undefined;
					try {
						stage("enumerate", {
							old_generation: diagnosticGeneration(state.generation),
							new_generation: generation,
						});
						options.onProgress?.({ phase: "enumerating", processed: 0, total: 0 });
						const excluded = this.#excludedIndexPath && relativePath(this.root, this.#excludedIndexPath);
						const stagedDir = this.#excludedIndexPath && relativePath(this.root, path.dirname(this.storage.path));
						const inventory = (await enumerateFiles(this.root, signal, this.storage.path)).filter(
							rel =>
								(!excluded || (rel !== excluded && rel !== `${excluded}-wal` && rel !== `${excluded}-shm`)) &&
								(!stagedDir || !rel.startsWith(`${stagedDir}/`)),
						);
						const scanned = new Set(inventory);
						const pending = this.storage.pending();
						const since = state.change_seq;
						const oldFailures = new Map(
							state.generation ? this.storage.failures(state.generation).map(item => [item.path, item]) : [],
						);
						const unchanged = new Set<string>();
						const fingerprints = new Map<string, string>();
						stage("scan_parse", { inventory_count: inventory.length, pending_count: pending.length });
						for (let i = 0; i < inventory.length; i++) {
							check(signal);
							const rel = inventory[i];
							fileHash = createHash("sha256").update(rel).digest("hex").slice(0, 16);
							readFailureKind = undefined;
							step = "read";
							stage("read", undefined, true);
							const result = await readRepoFile(this.root, rel, signal);
							readFailureKind = result.missing ? "missing" : result.failure?.kind;
							fingerprints.set(rel, result.file?.hash ?? `excluded:${result.failure?.kind}`);
							if (result.missing || result.failure?.kind === "unstable" || result.failure?.kind === "unreadable")
								throw new Error(
									`Cannot complete repository inventory at ${rel}: ${result.failure?.message ?? "file disappeared"}`,
								);
							let indexed: IndexedFile | undefined;
							let failure = result.failure;
							if (result.file) {
								const current =
									state.generation && mode === "reconcile"
										? this.storage.getFile(rel, state.generation)
										: null;
								if (current && current.hash === result.file.hash) unchanged.add(rel);
								else {
									step = "parse";
									stage("parse", undefined, true);
									if (rel.endsWith(".py")) parsed++;
									indexed = await this.#extract(result.file, signal);
									if (rel.endsWith(".py") && indexed.symbols.length === 0) failure = pythonParseFailure(rel);
								}
							}
							if (indexed || failure) {
								this.storage.transaction(() => {
									if (indexed) this.storage.insertFile(indexed, generation);
									if (failure) this.storage.putFailure(failure, generation);
								});
							}
							processed++;
							if (failure) failures++;
							fileHash = undefined;
							readFailureKind = undefined;
							options.onProgress?.({ phase: "reading", processed: i + 1, total: inventory.length, path: rel });
							if (i % 16 === 0) await yieldToLoop();
						}
						check(signal);
						step = "verify";
						stage("verify", {
							processed_count: processed,
							parsed_count: parsed,
							unchanged_count: unchanged.size,
							failure_count: failures,
						});
						options.onProgress?.({ phase: "publishing", processed: inventory.length, total: inventory.length });
						// The first file can change while later files are read. Verify the
						// full inventory again before certifying it, including external writes
						// that did not send an OMP notification. Newer known hints stay pending.
						const newerPaths = new Set(
							this.storage
								.pending()
								.filter(row => row.seq > since)
								.map(row => row.path),
						);
						for (const rel of inventory) {
							check(signal);
							fileHash = createHash("sha256").update(rel).digest("hex").slice(0, 16);
							readFailureKind = undefined;
							const verified = await readRepoFile(this.root, rel, signal);
							readFailureKind = verified.missing ? "missing" : verified.failure?.kind;
							if ((verified.file?.hash ?? `excluded:${verified.failure?.kind}`) !== fingerprints.get(rel)) {
								if (newerPaths.has(rel)) {
									fileHash = undefined;
									readFailureKind = undefined;
									continue;
								}
								this.markChanged([rel]);
								throw new Error(
									`Repository file changed during ${mode}: ${rel}; retry complete reconciliation`,
								);
							}
							fileHash = undefined;
							readFailureKind = undefined;
						}
						const verifiedInventory = await enumerateFiles(this.root, signal, this.storage.path);
						const verifiedPaths = new Set(verifiedInventory);
						const scopeChanges = [
							...inventory.filter(rel => !verifiedPaths.has(rel)),
							...verifiedInventory.filter(
								rel =>
									!scanned.has(rel) &&
									(!excluded ||
										(rel !== excluded && rel !== `${excluded}-wal` && rel !== `${excluded}-shm`)) &&
									(!stagedDir || !rel.startsWith(`${stagedDir}/`)),
							),
						];
						const pendingNow = new Set(
							this.storage
								.pending()
								.filter(row => row.seq > since)
								.map(row => row.path),
						);
						const newerUncertainty = this.storage.db
							.query("SELECT 1 FROM uncertainty WHERE seq>? LIMIT 1")
							.get(since);
						if (scopeChanges.some(rel => !pendingNow.has(rel)) && !newerUncertainty)
							throw new Error(`Repository inventory changed during ${mode}; retry complete reconciliation`);
						step = "publish";
						stage("publish", {
							verified_count: inventory.length,
							scope_change_count: scopeChanges.length,
							newer_pending_count: pendingNow.size,
							newer_uncertainty: Boolean(newerUncertainty),
						});
						this.storage.transaction(() => {
							check(signal);
							if (this.storage.state().epoch !== epoch) throw new Error("Repository index deleted during build");
							if (state.generation) {
								if (mode === "reconcile") {
									const previous = this.storage.db
										.query("SELECT id,path FROM files WHERE generation=?")
										.all(state.generation) as Array<{ id: number; path: string }>;
									for (const file of previous) if (!unchanged.has(file.path)) this.storage.removeFile(file.id);
									this.storage.db
										.query("UPDATE files SET generation=? WHERE generation=?")
										.run(generation, state.generation);
									for (const rel of unchanged) {
										const failure = oldFailures.get(rel);
										if (failure) this.storage.putFailure(failure, generation);
									}
								}
								this.storage.removeGeneration(state.generation);
							}
							this.storage.db
								.query("UPDATE state SET generation=?,checked_at=? WHERE id=1")
								.run(generation, Date.now());
							this.storage.clearPending([...scanned, ...pending.map(row => row.path)], since);
							this.storage.db.query("DELETE FROM uncertainty WHERE seq<=?").run(since);
						});
						published = true;
						stage("snapshot", {
							old_generation: diagnosticGeneration(state.generation),
							new_generation: generation,
							old_generation_retained: false,
						});
						return this.status();
					} catch (error) {
						logger[signal.aborted ? "info" : "error"]("Repository generation not published", {
							component: "repo",
							event: "repo_generation",
							stage: step,
							file_hash: fileHash,
							failure_kind: readFailureKind,
							result: signal.aborted ? "cancelled" : "failed",
							old_generation: diagnosticGeneration(state.generation),
							new_generation: generation,
							old_generation_retained: !published && state.generation !== null,
							published,
							processed_count: processed,
							parsed_count: parsed,
							failure_count: failures,
							...logger.diagnosticError(error),
						});
						this.storage.markUncertain(
							`${mode} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
						);
						logger.info("Repository failed maintenance marked unchecked", {
							component: "repo",
							event: "repo_unchecked",
							stage: step,
							result: "completed",
							source: mode,
						});
						throw error;
					} finally {
						if (!published) this.storage.transaction(() => this.storage.removeGeneration(generation));
					}
				}, options),
			options.signal,
		);
	}

	build(options: RepoMaintenanceOptions = {}): Promise<RepoStatus> {
		return this.#full("build", options);
	}
	reconcile(options: RepoMaintenanceOptions = {}): Promise<RepoStatus> {
		return this.#full("reconcile", options);
	}
	rebuild(options: RepoMaintenanceOptions = {}): Promise<RepoStatus> {
		return this.#full("rebuild", options);
	}

	/** Explicitly replace an unreadable or newer-schema index only after a complete staged build. */
	recover(options: RepoMaintenanceOptions = {}): Promise<RepoStatus> {
		try {
			this.#ensureOpen();
			if (!this.storage.recoveryError) throw new Error("Repository index is readable; use rebuild() to refresh it");
		} catch (error) {
			logger.error("Repository recovery rejected", {
				component: "repo",
				event: "repo_operation",
				action: "recover",
				stage: "validate",
				result: "failed",
				operation_id: logger.getLogContext().operation_id ?? `repo-${randomUUID()}`,
				...logger.diagnosticError(error),
			});
			throw error;
		}
		return this.#diagnose(
			"recover",
			async stage => {
				return this.#exclusive(
					async signal => {
						// Another instance may have recovered the same path while this operation waited.
						stage("recovery_check");
						const current = new RepoStorage(this.#agentDir, this.root);
						const stillBroken = Boolean(current.recoveryError);
						current.close();
						if (!stillBroken) throw new Error("Repository index was already recovered; reopen the service");
						const stageDir = path.join(path.dirname(this.storage.path), `.recovery-${randomUUID()}`);
						let staged: RepoService | undefined;
						try {
							staged = new RepoService({
								agentDir: stageDir,
								cwd: this.root,
								excludeIndexPath: this.storage.path,
							});
							if (staged.storage.recoveryError) throw staged.storage.recoveryError;
							stage("staged_build");
							await staged.build({ signal, onProgress: options.onProgress });
							check(signal);
							stage("replace");
							this.storage.replaceFrom(staged.storage);
							return this.status();
						} finally {
							staged?.close();
							rmSync(stageDir, { recursive: true, force: true });
						}
					},
					options,
					true,
				);
			},
			options.signal,
		);
	}

	async #flush(signal?: AbortSignal): Promise<void> {
		return this.#diagnose(
			"flush",
			async stage => {
				if (!this.storage.state().generation || this.storage.pending().length === 0) {
					stage("no_pending_or_missing");
					return;
				}
				await this.#exclusive(
					async inner => {
						const state = this.storage.state();
						if (!state.generation) {
							stage("missing");
							return;
						}
						const paths = this.storage.pending();
						if (paths.length === 0) {
							stage("no_pending");
							return;
						}
						stage("scan_parse", {
							old_generation: diagnosticGeneration(state.generation),
							initial_pending_count: paths.length,
						});
						const prepared: Array<{
							path: string;
							file?: IndexedFile;
							failure?: RepoFailure;
							unchanged?: boolean;
						}> = [];
						let nextGeneration = state.generation;
						let unchangedCount = 0;
						let failureCount = 0;
						let published = false;
						try {
							for (const row of paths) {
								check(inner);
								const old = this.storage.getFile(row.path, state.generation);
								const ignored =
									row.path.split("/").some(part => part === ".git" || part === "node_modules") ||
									path.join(this.root, row.path) === this.storage.path;
								stage("read", undefined, true);
								const result: ReadResult = ignored
									? { missing: true }
									: await readRepoFile(this.root, row.path, inner);
								if (result.failure?.kind === "unstable" || result.failure?.kind === "unreadable")
									throw new Error(`Unable to update ${row.path}: ${result.failure.message}`);
								const eligible = result.file ? await indexedCandidate(this.root, row.path, inner) : false;
								if (result.file && eligible && old?.hash === result.file.hash) {
									prepared.push({ path: row.path, unchanged: true });
								} else {
									stage("parse", undefined, true);
									const file = result.file && eligible ? await this.#extract(result.file, inner) : undefined;
									prepared.push({
										path: row.path,
										file,
										failure:
											result.failure ??
											(file && row.path.endsWith(".py") && !file.symbols.length
												? pythonParseFailure(row.path)
												: undefined),
									});
								}
								if (prepared.at(-1)?.unchanged) unchangedCount++;
								if (prepared.at(-1)?.failure) failureCount++;
								if (prepared.length % 16 === 0) await yieldToLoop();
							}
							check(inner);
							stage("publish", {
								prepared_count: prepared.length,
								unchanged_count: unchangedCount,
								failure_count: failureCount,
							});
							this.storage.transaction(() => {
								check(inner);
								for (const item of prepared) {
									const old = this.storage.getFile(item.path, state.generation!);
									if (item.unchanged) continue;
									if (old) this.storage.removeFile(old.id);
									this.storage.clearFailure(item.path, state.generation!);
									if (item.file) this.storage.insertFile(item.file, state.generation!);
									if (item.failure) this.storage.putFailure(item.failure, state.generation!);
								}
								this.storage.clearPending(
									paths.map(row => row.path),
									maxPendingSeq(paths),
								);
								if (prepared.some(item => !item.unchanged)) {
									this.storage.db.query("UPDATE state SET generation=? WHERE id=1").run(randomUUID());
									const updated = this.storage.state().generation!;
									nextGeneration = updated;
									this.storage.db
										.query("UPDATE files SET generation=? WHERE generation=?")
										.run(updated, state.generation);
									this.storage.db
										.query("UPDATE failures SET generation=? WHERE generation=?")
										.run(updated, state.generation);
								}
							});
							published = true;
							logger.info("Repository pending changes published", {
								component: "repo",
								event: "repo_generation",
								stage: "publish",
								result: "completed",
								old_generation: diagnosticGeneration(state.generation),
								new_generation: diagnosticGeneration(nextGeneration),
								processed_count: prepared.length,
								old_generation_retained: nextGeneration === state.generation,
							});
						} catch (error) {
							logger[inner.aborted ? "info" : "error"]("Repository pending update ended", {
								component: "repo",
								event: "repo_generation",
								stage: "flush",
								result: inner.aborted ? "cancelled" : "failed",
								published,
								old_generation: diagnosticGeneration(state.generation),
								old_generation_retained: !published,
								pending_count: paths.length,
								prepared_count: prepared.length,
								...logger.diagnosticError(error),
							});
							throw error;
						}
					},
					{ signal },
					false,
					true,
				);
			},
			signal,
		);
	}

	async remove(): Promise<void> {
		return this.#diagnose("remove", async stage => {
			await this.#exclusive(
				async () => {
					stage("remove", { recovery_required: Boolean(this.storage.recoveryError) });
					if (!this.storage.recoveryError) {
						this.storage.remove();
						stage("removed", { new_generation: null });
						return;
					}
					const stageDir = path.join(path.dirname(this.storage.path), `.recovery-${randomUUID()}`);
					try {
						const staged = new RepoStorage(stageDir, this.root);
						if (staged.recoveryError) throw staged.recoveryError;
						try {
							staged.remove();
							this.storage.replaceFrom(staged);
							stage("removed", { new_generation: null });
						} finally {
							staged.close();
						}
					} finally {
						rmSync(stageDir, { recursive: true, force: true });
					}
				},
				{},
				true,
			);
		});
	}

	#page<T>(kind: string, query: string, options: RepoQueryOptions, status: RepoStatus, hits: T[]): RepoQueryResult<T> {
		const limit = Math.max(
			1,
			Math.min(MAX_LIMIT, Number.isFinite(options.limit) ? Math.floor(options.limit!) : DEFAULT_LIMIT),
		);
		const identity = createHash("sha256")
			.update(JSON.stringify([kind, query, options.path ?? "", options.category ?? ""]))
			.digest("hex");
		let offset = 0;
		if (options.cursor) {
			let cursor: unknown;
			try {
				cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
			} catch {
				throw new Error("Invalid repository index cursor");
			}
			if (
				!cursor ||
				typeof cursor !== "object" ||
				!("generation" in cursor) ||
				cursor.generation !== status.generation
			)
				throw new Error("Stale repository index cursor; restart the search");
			if (
				!("identity" in cursor) ||
				cursor.identity !== identity ||
				!("offset" in cursor) ||
				typeof cursor.offset !== "number" ||
				!Number.isSafeInteger(cursor.offset) ||
				cursor.offset < 0
			)
				throw new Error("Invalid repository index cursor");
			offset = cursor.offset;
		}
		const next = offset + limit;
		const warnings = [
			...(status.pendingCount ? [`${status.pendingCount} known paths pending update`] : []),
			...(status.needsReconcile ? ["Full repository scope has not been reconciled since uncertain changes"] : []),
			...(status.failureCount ? [`${status.failureCount} files excluded or failed parsing`] : []),
		];
		return {
			root: this.root,
			generation: status.generation,
			status: status.exists ? "ok" : "missing",
			hits: hits.slice(offset, next),
			cursor:
				next < hits.length
					? Buffer.from(JSON.stringify({ generation: status.generation, identity, offset: next })).toString(
							"base64url",
						)
					: undefined,
			truncated: next < hits.length,
			warnings,
			coverage: status,
		};
	}

	async #query<T>(work: (db: Database, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#diagnose(
			"query",
			async stage => {
				this.#ensureOpen();
				const combined = signal ? AbortSignal.any([signal, this.#closing.signal]) : this.#closing.signal;
				stage("read_snapshot");
				const task = this.storage.readAsync(async db => {
					check(combined);
					stage("query");
					return work(db, combined);
				});
				this.#active.add(task);
				try {
					return await task;
				} finally {
					this.#active.delete(task);
				}
			},
			signal,
		);
	}

	async search(query: string, options: RepoQueryOptions = {}): Promise<RepoQueryResult<RepoTextHit>> {
		return this.#diagnose(
			"search",
			async stage => {
				this.#ensureOpen();
				options = { ...options, path: queryPath(options.path) };
				stage("flush");
				await this.#flush(options.signal);
				check(options.signal);
				stage("snapshot");
				return this.#query(async (db, signal) => {
					const status = this.#statusSnapshot(db);
					if (!status.exists) return this.#page<RepoTextHit>("search", query, options, status, []);
					const needle = query.slice(0, MAX_QUERY_LENGTH).trim();
					if (!needle) return this.#page<RepoTextHit>("search", query, options, status, []);
					const cacheKey = JSON.stringify([
						this.storage.path,
						status.generation,
						needle,
						options.path,
						options.category,
					]);
					let hits = searchPages.get(cacheKey);
					stage(hits ? "cache_page" : "candidate_scan", {
						...repoDiagnosticSummary(status),
						cache_hit: Boolean(hits),
					});
					if (!hits) {
						const tokens = [needle, ...(needle.match(/[\p{L}\p{N}]+/gu) ?? [])]
							.filter((token, i, array) => token.length > 1 && array.indexOf(token) === i)
							.slice(0, 16);
						if (!tokens.length) tokens.push(needle);
						const clauses: string[] = [];
						const params: (string | number)[] = [status.generation!];
						for (const token of tokens) {
							if ([...token].length >= 3) {
								clauses.push("f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)");
								params.push(`"${token.toLowerCase().replaceAll('"', '""')}"`);
							} else {
								clauses.push("f.id IN (SELECT rowid FROM files_fts WHERE instr(text, ?) > 0)");
								params.push(token.toLowerCase());
							}
						}
						let sql = `SELECT f.id,f.path,f.category,i.text FROM files f JOIN files_fts i ON i.rowid=f.id WHERE f.generation=? AND (${clauses.join(" OR ")})`;
						if (options.path) {
							sql += " AND (f.path=? OR instr(f.path, ?) = 1)";
							params.push(options.path, `${options.path.replace(/\/$/, "")}/`);
						}
						if (options.category) {
							sql += " AND f.category=?";
							params.push(options.category);
						}
						sql += " ORDER BY f.path LIMIT ?";
						params.push(MAX_CANDIDATES + 1);
						const rows = db.query(sql).iterate(...params) as Iterable<{
							id: number;
							path: string;
							category: RepoTextHit["category"];
							text: string;
						}>;
						const foldedNeedle = needle.toLowerCase();
						const foldedTokens = tokens.slice(1).map(token => token.toLowerCase());
						const boundary = new RegExp(
							`(?<![\\p{L}\\p{N}_])${RegExp.escape(foldedNeedle)}(?![\\p{L}\\p{N}_])`,
							"u",
						);
						hits = [];
						let candidates = 0;
						for (const row of rows) {
							check(signal);
							if (++candidates > MAX_CANDIDATES)
								throw new Error("Repository query exceeds candidate limit; narrow path or query");
							// FTS already stores JS-lowercased text. Score offsets only; original
							// source and snippets are loaded after pagination, within this snapshot.
							const folded = row.text;
							const full = folded.indexOf(foldedNeedle);
							const exact = full < 0 ? undefined : boundary.exec(folded);
							let index = exact?.index ?? full;
							let score = full < 0 ? 0 : 100;
							if (exact) score += 100;
							for (const token of foldedTokens) {
								const position = folded.indexOf(token);
								if (position >= 0) {
									score += 10;
									if (index < 0) index = position;
								}
							}
							if (index >= 0)
								hits.push({ id: row.id, path: row.path, category: row.category, offset: index, score });
							if (candidates % 32 === 0) await yieldToLoop();
						}
						check(signal);
						stage("rank", { candidate_count: candidates, match_count: hits.length });
						hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "en"));
						searchPages.set(cacheKey, hits);
					}
					const page = this.#page("search", query, options, status, hits);
					stage("page_load", { page_hit_count: page.hits.length, has_cursor: Boolean(page.cursor) });
					const load = db.query("SELECT text FROM files WHERE id=? AND generation=?");
					return {
						...page,
						hits: page.hits.map(hit => {
							const source = (load.get(hit.id, status.generation!) as { text: string }).text;
							return {
								path: hit.path,
								category: hit.category,
								...snippet(source, originalOffset(source, hit.offset)),
							};
						}),
					};
				}, options.signal);
			},
			options.signal,
		);
	}

	async symbol(name: string, options: RepoQueryOptions = {}): Promise<RepoQueryResult<RepoSymbolHit>> {
		return this.#diagnose(
			"symbol",
			async stage => {
				this.#ensureOpen();
				options = { ...options, path: queryPath(options.path) };
				stage("flush");
				await this.#flush(options.signal);
				check(options.signal);
				stage("snapshot");
				return this.#query(async (db, signal) => {
					const status = this.#statusSnapshot(db);
					if (!status.exists || !name.trim())
						return this.#page<RepoSymbolHit>("symbol", name, options, status, []);
					let sql =
						"SELECT s.id symbolId,f.path,f.category,s.name,s.qualname,s.kind,s.start_line startLine,s.end_line endLine FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.generation=? AND (instr(s.name_folded, ?) > 0 OR instr(s.qualname_folded, ?) > 0)";
					const lowered = name.toLowerCase();
					const params: (string | number)[] = [status.generation!, lowered, lowered];
					if (options.path) {
						sql += " AND (f.path=? OR instr(f.path, ?) = 1)";
						params.push(options.path, `${options.path.replace(/\/$/, "")}/`);
					}
					if (options.category) {
						sql += " AND f.category=?";
						params.push(options.category);
					}
					sql += " ORDER BY f.path,s.start_line,s.id LIMIT ?";
					params.push(MAX_CANDIDATES + 1);
					const hits: Array<RepoSymbolHit & { symbolId: number }> = [];
					stage("candidate_scan", repoDiagnosticSummary(status));
					for (const hit of db.query(sql).iterate(...params) as Iterable<RepoSymbolHit & { symbolId: number }>) {
						check(signal);
						hits.push(hit);
						if (hits.length > MAX_CANDIDATES)
							throw new Error("Repository symbol query exceeds candidate limit; narrow path or name");
						if (hits.length % 128 === 0) await yieldToLoop();
					}
					check(signal);
					stage("rank", { candidate_count: hits.length });
					hits.sort(
						(a, b) =>
							Number(b.name.toLowerCase() === lowered) - Number(a.name.toLowerCase() === lowered) ||
							Number(b.qualname.toLowerCase() === lowered) - Number(a.qualname.toLowerCase() === lowered) ||
							a.path.localeCompare(b.path, "en") ||
							a.startLine - b.startLine ||
							a.qualname.localeCompare(b.qualname, "en"),
					);
					const page = this.#page("symbol", name, options, status, hits);
					stage("page_load", { page_hit_count: page.hits.length, has_cursor: Boolean(page.cursor) });
					if (page.hits.length === 0) return { ...page, hits: [] };
					// A signature can span most of a 2 MiB file. Load only this bounded page,
					// not every matching declaration, while retaining the same read snapshot.
					const ids = page.hits.map(hit => hit.symbolId);
					const signatures = db
						.query(`SELECT id,signature FROM symbols WHERE id IN (${ids.map(() => "?").join(",")})`)
						.all(...ids) as Array<{ id: number; signature: string | null }>;
					const byId = new Map(signatures.map(row => [row.id, row.signature]));
					return {
						...page,
						hits: page.hits.map(({ symbolId, ...hit }) => ({
							...hit,
							signature: byId.get(symbolId) ?? undefined,
						})),
					};
				}, options.signal);
			},
			options.signal,
		);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closing.abort();
		if (this.#active.size === 0) this.storage.close();
		else void Promise.allSettled(this.#active).then(() => this.storage.close());
	}
}
