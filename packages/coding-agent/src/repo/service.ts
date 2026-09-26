import { randomUUID, createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import * as path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { pythonSymbols } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { acquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import { sanitizeText, truncate } from "@oh-my-pi/pi-utils";
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

function check(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
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
		repoRoot = vcs.repo(canonical)?.root() ?? null;
	} catch {
		/* Non-VCS directories are valid. */
	}
	return realpathSync(repoRoot ?? canonical);
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
		this.#ensureOpen();
		return this.storage.read(() => this.#statusSnapshot());
	}

	#statusSnapshot(): RepoStatus {
		const state = this.storage.state();
		const totals = this.storage.db
			.query(
				"SELECT (SELECT count(*) FROM failures WHERE generation=?) failures,(SELECT count(*) FROM pending) pending,(SELECT count(*) FROM uncertainty) uncertainty",
			)
			.get(state.generation) as { failures: number; pending: number; uncertainty: number };
		const failures = state.generation ? this.storage.failures(state.generation, 50) : [];
		const pendingPaths = this.storage.pending(50).map(row => row.path);
		const uncertainReasons = this.storage.uncertainty(20);
		const counts = state.generation ? this.storage.counts(state.generation) : { files: 0, symbols: 0 };
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
	}

	markUncertain(reason: string): void {
		this.#ensureOpen();
		if (reason.trim()) this.storage.markUncertain(reason.trim().slice(0, 200));
	}

	/** Read cheap Git status/HEAD hints; absence of a Git hint never certifies the whole tree. */
	async discoverChanges(): Promise<void> {
		this.#ensureOpen();
		if (this.storage.recoveryError) return;
		const initial = this.storage.state();
		if (!initial.generation) return;
		const stillCurrent = (): boolean => {
			if (this.#closed || this.storage.recoveryError) return false;
			try {
				const state = this.storage.state();
				return state.epoch === initial.epoch && state.generation !== null;
			} catch {
				return false;
			}
		};
		const git = vcs.git(this.root);
		if (!git) return;
		try {
			const head = await git.headSha();
			if (!stillCurrent()) return;
			if (this.#head !== null && head !== this.#head)
				this.markUncertain("Git HEAD changed; complete reconciliation recommended");
			this.#head = head ?? null;
			const output = await git.statusPorcelain({ untracked: "all", nulTerminated: true });
			if (!stillCurrent()) return;
			const paths: string[] = [];
			for (const entry of output.split("\0")) {
				if (!entry) continue;
				if (entry.startsWith("  ")) {
					paths.push(entry.slice(3));
					continue;
				}
				if (entry.length >= 3 && entry[2] === " ") paths.push(entry.slice(3));
				else paths.push(entry);
			}
			this.markChanged(paths);
		} catch (error) {
			if (stillCurrent())
				this.markUncertain(
					`Git change discovery failed: ${error instanceof Error ? error.message : String(error)}`,
				);
		}
	}

	async #exclusive<T>(
		work: (signal: AbortSignal, epoch: number) => Promise<T>,
		options: RepoMaintenanceOptions = {},
		allowAfterRemoval = false,
	): Promise<T> {
		this.#ensureOpen();
		const epoch = this.storage.recoveryError ? 0 : this.storage.state().epoch;
		const signal = options.signal ? AbortSignal.any([options.signal, this.#closing.signal]) : this.#closing.signal;
		const previous = this.#gate;
		const { promise, resolve: release } = Promise.withResolvers<void>();
		this.#gate = promise;
		const task = (async () => {
			await previous;
			let lease: FileLockHandle | undefined;
			try {
				check(signal);
				lease = await acquireFileLock(this.storage.path, { signal });
				if (!allowAfterRemoval && this.storage.state().epoch !== epoch)
					throw new Error("Repository index was removed while this operation waited; retry explicitly");
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
				endLine: Math.max(1, file.text.split("\n").length),
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
		return this.#exclusive(async (signal, epoch) => {
			const state = this.storage.state();
			if (mode === "build" && state.generation)
				throw new Error("Repository index already exists; reconcile or rebuild instead");
			if (mode === "reconcile" && !state.generation)
				throw new Error("Repository index does not exist; build it first");
			const generation = randomUUID();
			let published = false;
			try {
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
				for (let i = 0; i < inventory.length; i++) {
					check(signal);
					const rel = inventory[i];
					const result = await readRepoFile(this.root, rel, signal);
					if (result.missing || result.failure?.kind === "unstable" || result.failure?.kind === "unreadable")
						throw new Error(
							`Cannot complete repository inventory at ${rel}: ${result.failure?.message ?? "file disappeared"}`,
						);
					let indexed: IndexedFile | undefined;
					let failure = result.failure;
					if (result.file) {
						const current =
							state.generation && mode === "reconcile" ? this.storage.getFile(rel, state.generation) : null;
						if (current && current.hash === result.file.hash) unchanged.add(rel);
						else {
							indexed = await this.#extract(result.file, signal);
							if (rel.endsWith(".py") && indexed.symbols.length === 0)
								failure = {
									path: rel,
									kind: "parse",
									message: "Python syntax tree contains parse errors; symbols omitted",
								};
						}
					}
					if (indexed || failure) {
						this.storage.transaction(() => {
							if (indexed) this.storage.insertFile(indexed, generation);
							if (failure) this.storage.putFailure(failure, generation);
						});
					}
					options.onProgress?.({ phase: "reading", processed: i + 1, total: inventory.length, path: rel });
					if (i % 16 === 0) await yieldToLoop();
				}
				check(signal);
				options.onProgress?.({ phase: "publishing", processed: inventory.length, total: inventory.length });
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
				return this.status();
			} catch (error) {
				this.storage.markUncertain(
					`${mode} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
				);
				throw error;
			} finally {
				if (!published) this.storage.transaction(() => this.storage.removeGeneration(generation));
			}
		}, options);
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
		this.#ensureOpen();
		if (!this.storage.recoveryError) throw new Error("Repository index is readable; use rebuild() to refresh it");
		return this.#exclusive(
			async signal => {
				// Another instance may have recovered the same path while this operation waited.
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
					await staged.build({ signal, onProgress: options.onProgress });
					check(signal);
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
	}

	async #flush(signal?: AbortSignal): Promise<void> {
		if (!this.storage.state().generation || this.storage.pending().length === 0) return;
		await this.#exclusive(
			async inner => {
				const state = this.storage.state();
				if (!state.generation) return;
				const paths = this.storage.pending();
				if (paths.length === 0) return;
				const prepared: Array<{ path: string; file?: IndexedFile; failure?: RepoFailure; unchanged?: boolean }> =
					[];
				for (const row of paths) {
					check(inner);
					const old = this.storage.getFile(row.path, state.generation);
					const ignored =
						row.path.split("/").some(part => part === ".git" || part === "node_modules") ||
						path.join(this.root, row.path) === this.storage.path;
					const result: ReadResult = ignored ? { missing: true } : await readRepoFile(this.root, row.path, inner);
					if (result.failure?.kind === "unstable" || result.failure?.kind === "unreadable")
						throw new Error(`Unable to update ${row.path}: ${result.failure.message}`);
					const eligible = result.file ? await indexedCandidate(this.root, row.path, inner) : false;
					if (result.file && eligible && old?.hash === result.file.hash) {
						prepared.push({ path: row.path, unchanged: true });
					} else {
						const file = result.file && eligible ? await this.#extract(result.file, inner) : undefined;
						prepared.push({
							path: row.path,
							file,
							failure:
								result.failure ??
								(file && row.path.endsWith(".py") && !file.symbols.length
									? {
											path: row.path,
											kind: "parse",
											message: "Python syntax tree contains parse errors; symbols omitted",
										}
									: undefined),
						});
					}
					if (prepared.length % 16 === 0) await yieldToLoop();
				}
				check(inner);
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
						Math.max(...paths.map(row => row.seq)),
					);
					if (prepared.some(item => !item.unchanged)) {
						this.storage.db.query("UPDATE state SET generation=? WHERE id=1").run(randomUUID());
						const updated = this.storage.state().generation!;
						this.storage.db
							.query("UPDATE files SET generation=? WHERE generation=?")
							.run(updated, state.generation);
						this.storage.db
							.query("UPDATE failures SET generation=? WHERE generation=?")
							.run(updated, state.generation);
					}
				});
			},
			{ signal },
		);
	}

	async remove(): Promise<void> {
		await this.#exclusive(
			async () => {
				if (!this.storage.recoveryError) {
					this.storage.remove();
					return;
				}
				const stageDir = path.join(path.dirname(this.storage.path), `.recovery-${randomUUID()}`);
				try {
					const staged = new RepoStorage(stageDir, this.root);
					if (staged.recoveryError) throw staged.recoveryError;
					try {
						staged.remove();
						this.storage.replaceFrom(staged);
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

	async search(query: string, options: RepoQueryOptions = {}): Promise<RepoQueryResult<RepoTextHit>> {
		this.#ensureOpen();
		await this.#flush(options.signal);
		check(options.signal);
		return this.storage.read(() => {
			const status = this.#statusSnapshot();
			if (!status.exists) return this.#page("search", query, options, status, []);
			const needle = query.slice(0, MAX_QUERY_LENGTH).trim();
			if (!needle) return this.#page("search", query, options, status, []);
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
			let sql = `SELECT f.path,f.category,f.text FROM files f WHERE f.generation=? AND (${clauses.join(" OR ")})`;
			if (options.path) {
				sql += " AND (f.path=? OR f.path LIKE ? ESCAPE '\\')";
				params.push(options.path, `${escapeLike(options.path.replace(/\/$/, ""))}/%`);
			}
			if (options.category) {
				sql += " AND f.category=?";
				params.push(options.category);
			}
			sql += " ORDER BY f.path LIMIT ?";
			params.push(MAX_CANDIDATES + 1);
			const rows = this.storage.db.query(sql).all(...params) as Array<{
				path: string;
				category: RepoTextHit["category"];
				text: string;
			}>;
			if (rows.length > MAX_CANDIDATES)
				throw new Error("Repository query exceeds candidate limit; narrow path or query");
			const foldedNeedle = needle.toLowerCase();
			const foldedTokens = tokens.slice(1).map(token => token.toLowerCase());
			const hits: Array<{ hit: RepoTextHit; score: number }> = [];
			for (const row of rows) {
				const folded = row.text.toLowerCase();
				const full = folded.indexOf(foldedNeedle);
				let index = full;
				let score = full < 0 ? 0 : 100;
				if (full >= 0) {
					const before = row.text[originalOffset(row.text, full) - 1] ?? "";
					const after = row.text[originalOffset(row.text, full + foldedNeedle.length)] ?? "";
					if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) score += 100;
				}
				for (const token of foldedTokens) {
					const position = folded.indexOf(token);
					if (position >= 0) {
						score += 10;
						if (index < 0) index = position;
					}
				}
				if (index >= 0)
					hits.push({
						hit: {
							path: row.path,
							category: row.category,
							...snippet(row.text, originalOffset(row.text, index)),
						},
						score,
					});
			}
			hits.sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path, "en"));
			return this.#page(
				"search",
				query,
				options,
				status,
				hits.map(row => row.hit),
			);
		});
	}

	async symbol(name: string, options: RepoQueryOptions = {}): Promise<RepoQueryResult<RepoSymbolHit>> {
		this.#ensureOpen();
		await this.#flush(options.signal);
		check(options.signal);
		return this.storage.read(() => {
			const status = this.#statusSnapshot();
			if (!status.exists || !name.trim()) return this.#page("symbol", name, options, status, []);
			let sql =
				"SELECT f.path,f.category,s.name,s.qualname,s.kind,s.start_line startLine,s.end_line endLine,s.signature FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.generation=? AND (instr(s.name_folded, ?) > 0 OR instr(s.qualname_folded, ?) > 0)";
			const lowered = name.toLowerCase();
			const params: (string | number)[] = [status.generation!, lowered, lowered];
			if (options.path) {
				sql += " AND (f.path=? OR f.path LIKE ? ESCAPE '\\')";
				params.push(options.path, `${escapeLike(options.path.replace(/\/$/, ""))}/%`);
			}
			if (options.category) {
				sql += " AND f.category=?";
				params.push(options.category);
			}
			sql += " ORDER BY f.path,s.start_line,s.id LIMIT ?";
			params.push(MAX_CANDIDATES + 1);
			const hits = this.storage.db.query(sql).all(...params) as RepoSymbolHit[];
			if (hits.length > MAX_CANDIDATES)
				throw new Error("Repository symbol query exceeds candidate limit; narrow path or name");
			hits.sort(
				(a, b) =>
					Number(b.name.toLowerCase() === lowered) - Number(a.name.toLowerCase() === lowered) ||
					Number(b.qualname.toLowerCase() === lowered) - Number(a.qualname.toLowerCase() === lowered) ||
					a.path.localeCompare(b.path, "en") ||
					a.startLine - b.startLine ||
					a.qualname.localeCompare(b.qualname, "en"),
			);
			return this.#page("symbol", name, options, status, hits);
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closing.abort();
		if (this.#active.size === 0) this.storage.close();
		else void Promise.allSettled(this.#active).then(() => this.storage.close());
	}
}
