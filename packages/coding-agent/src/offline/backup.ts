import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, type OfflineShmState, removeWithRetries, tryAcquireFileLock } from "@oh-my-pi/pi-utils";

const BACKUP_DIRECTORY = ".offline-shm-backups";
const WORK_DIRECTORY = ".offline-shm-backup-work";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const GENERATION_NAME = /^\d{13}-[a-f0-9-]{36}$/;
const latestSuccess = new Map<string, string>();

interface FileStamp {
	dev: string;
	ino: string;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
}
interface SnapshotEntry {
	path: string;
	kind: "file" | "sqlite" | "directory" | "symlink";
	mode: number;
	stamp?: FileStamp;
	sha256?: string;
	/** Complete newline-delimited prefix; append-only logs/sessions may grow during a round. */
	prefixBytes?: number;
	target?: string;
}
interface SnapshotManifest {
	format: 1;
	status: "complete";
	domainId: string;
	generation: string;
	completedAt: string;
	persistentRoot: string;
	runtimeRoot: string;
	runtimeIdentity: string;
	scope: "complete-runtime-only";
	consistency: "individual-sqlite-transactions-and-stable-files-not-global-transaction";
	recovery: string;
	deletionScope: "same-runtime-incarnation-only-never-original-persistent-root";
	deletedSincePrevious: string[];
	entries: SnapshotEntry[];
	excluded: Array<{ path: string; reason: string }>;
}
interface CurrentGeneration {
	format: 1;
	current: string;
	previous?: string;
	completedAt: string;
}

class BackupFailure extends Error {
	override readonly name = "OfflineShmBackupError";

	constructor(readonly code: string) {
		super(`Offline shm backup failed (${code})`);
	}
}

function failure(code: string): BackupFailure {
	return new BackupFailure(code);
}

function stamp(stat: BigIntStats): FileStamp {
	return {
		dev: String(stat.dev),
		ino: String(stat.ino),
		size: String(stat.size),
		mtimeNs: String(stat.mtimeNs),
		ctimeNs: String(stat.ctimeNs),
	};
}

function equalStamp(a: FileStamp | undefined, b: FileStamp): boolean {
	return (
		!!a &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function ephemeral(name: string, relative: string): boolean {
	const scoped = relative.replace(/^profiles[\\/][^\\/]+[\\/]/, "").replace(/^agent(?:[\\/]|$)/, "");
	const processRuntime = /^run(?:[\\/]|$)/.test(scoped);
	// Dependency locks are durable data, regardless of their package manager.
	// Match process-lock conventions and their owning namespaces, not all *.lock files.
	const processLock =
		/\.(?:install|bind)\.lock$|\.lock\.lock$|\.(?:jsonl?|ya?ml|db|sqlite3?|i64|idb)\.lock$/i.test(name) ||
		(processRuntime && /\.lock(?:\.\d+)?$/i.test(name)) ||
		(scoped === "" && name === "gc.lock") ||
		(/^memories[\\/]sharpshooter[\\/][^\\/]+$/.test(scoped) && name === "consolidate.lock") ||
		(/^idbs[\\/][^\\/]+$/.test(scoped) && name === "db.lock") ||
		(/^cache[\\/]eval-js[\\/]project-locks$/.test(scoped) && name.endsWith(".lock")) ||
		(/^cache[\\/][^\\/]+-runtime$/.test(scoped) && name.endsWith(".lock"));
	return (
		name === WORK_DIRECTORY ||
		name === BACKUP_DIRECTORY ||
		name.startsWith(".offline-shm-") ||
		processLock ||
		/(?:\.pid$|\.sock$|\.socket$|\.tmp(?:$|[-.])|\.temp$|\.swp$|~$)/i.test(name) ||
		(processRuntime && /^(?:clients|provider-inflight|broker\.token|meta\.json|spec\.json|scope\.json)$/.test(name))
	);
}

async function privateDirectory(directory: string, create = true): Promise<void> {
	if (create) {
		await fs.mkdir(directory, { mode: 0o700 }).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		});
	}
	const stat = await fs.lstat(directory);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(process.getuid && stat.uid !== process.getuid()) ||
		(process.platform !== "win32" && (stat.mode & 0o077) !== 0)
	) {
		throw failure("UNSAFE_BACKUP_DIRECTORY");
	}
}

async function sharedBackupDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { mode: 0o1777 }).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	});
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("UNSAFE_BACKUP_DIRECTORY");
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw failure("UNSAFE_BACKUP_DIRECTORY");
		if (process.getuid && opened.uid === process.getuid() && (opened.mode & 0o1777) !== 0o1777) {
			// mkdir is subject to umask. Initialize only our own shared container,
			// including the private container created by older versions; never a foreign directory.
			await handle.chmod((opened.mode & 0o2000) | 0o1777);
		}
		const shared = await handle.stat();
		// Sticky ownership protects private sibling domains from other writers.
		// Administratively provisioned group-shared containers are also supported.
		if ((shared.mode & 0o1000) === 0) throw failure("UNSAFE_BACKUP_DIRECTORY");
		await fs.access(directory, constants.W_OK | constants.X_OK);
	} finally {
		await handle.close();
	}
}

async function syncFile(filename: string): Promise<void> {
	// Windows FlushFileBuffers requires a writable handle, even when no bytes are changed.
	const access = process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY;
	const handle = await fs.open(filename, access | (constants.O_NOFOLLOW ?? 0));
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	await syncFile(directory);
}

async function writePrivate(filename: string, value: unknown): Promise<void> {
	const handle = await fs.open(filename, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readCurrent(directory: string): Promise<CurrentGeneration | undefined> {
	try {
		const handle = await fs.open(
			path.join(directory, "current.json"),
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const value = JSON.parse(await handle.readFile("utf8")) as CurrentGeneration;
			if (
				value.format !== 1 ||
				!GENERATION_NAME.test(value.current) ||
				(value.previous !== undefined && !GENERATION_NAME.test(value.previous)) ||
				typeof value.completedAt !== "string"
			) {
				throw failure("INVALID_BACKUP_POINTER");
			}
			return value;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function readManifest(directory: string, generation: string, domainId: string): Promise<SnapshotManifest> {
	const generationRoot = path.join(directory, "generations", generation);
	await privateDirectory(generationRoot, false);
	await privateDirectory(path.join(generationRoot, "data"), false);
	const handle = await fs.open(
		path.join(generationRoot, "manifest.json"),
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const manifest = JSON.parse(await handle.readFile("utf8")) as SnapshotManifest;
		if (
			manifest.format !== 1 ||
			manifest.status !== "complete" ||
			manifest.generation !== generation ||
			manifest.domainId !== domainId ||
			!Array.isArray(manifest.entries)
		)
			throw failure("INVALID_BACKUP_MANIFEST");
		return manifest;
	} finally {
		await handle.close();
	}
}

async function prune(directory: string, current: CurrentGeneration | undefined): Promise<void> {
	const retained = new Set([current?.current, current?.previous]);
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".staging-") || entry.name.startsWith(".current-")) {
			await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
		}
	}
	const generations = path.join(directory, "generations");
	for (const entry of await fs.readdir(generations, { withFileTypes: true })) {
		if (GENERATION_NAME.test(entry.name) && !retained.has(entry.name)) {
			await fs.rm(path.join(generations, entry.name), { recursive: true, force: true });
		}
	}
}

/**
 * One non-waiting, cross-process round. Call only in an owned background execution
 * context: SQLite and NFS can block that context, which its owner may terminate.
 * No restore, startup I/O, active-file hardlinks, or writes to original user data.
 */
export async function runOfflineShmBackup(
	state: OfflineShmState,
	signal?: AbortSignal,
): Promise<{ status: "completed" | "busy"; completedAt?: string; backupPath?: string }> {
	if (signal?.aborted) throw failure("ABORTED");
	let lock;
	try {
		lock = tryAcquireFileLock(path.join(state.runtimeRoot, ".offline-shm-backup-round"));
	} catch {
		throw failure("BACKUP_LOCK_FAILED");
	}
	if (!lock) return { status: "busy" };
	let staging: string | undefined;
	let scratch: string | undefined;
	let published = false;
	let previousSuccess = latestSuccess.get(state.domainId);
	const domainHash = createHash("sha256").update(state.domainId).digest("hex");
	const successRecord = path.join(state.runtimeRoot, ".offline-shm-backup-success.json");
	try {
		try {
			const handle = await fs.open(successRecord, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const record = JSON.parse(await handle.readFile("utf8")) as { completedAt?: unknown };
				if (
					typeof record.completedAt === "string" &&
					/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.completedAt)
				)
					previousSuccess = record.completedAt;
			} finally {
				await handle.close();
			}
		} catch {
			/* An absent/unreadable local diagnostic record never prevents a backup. */
		}
		logger.info("offline_shm_backup.started", { domain_id: domainHash, latest_success_at: previousSuccess });
		const runtime = await fs.realpath(state.runtimeRoot);
		const rootStat = await fs.lstat(runtime, { bigint: true });
		if (
			!rootStat.isDirectory() ||
			(process.getuid && rootStat.uid !== BigInt(process.getuid())) ||
			(process.platform !== "win32" && (rootStat.mode & 0o077n) !== 0n)
		) {
			throw failure("UNSAFE_RUNTIME_ROOT");
		}
		await fs.mkdir(state.persistentRoot, { recursive: true, mode: 0o700 });
		const persistent = await fs.realpath(state.persistentRoot);
		if (isInside(runtime, persistent) || isInside(persistent, runtime)) throw failure("OVERLAPPING_BACKUP_ROOTS");
		const backupRoot = path.join(persistent, BACKUP_DIRECTORY);
		await sharedBackupDirectory(backupRoot);
		const domain = path.join(backupRoot, domainHash);
		await privateDirectory(domain);
		await privateDirectory(path.join(domain, "generations"));
		const current = await readCurrent(domain);
		previousSuccess = current?.completedAt ?? previousSuccess;
		const previous = current ? await readManifest(domain, current.current, state.domainId) : undefined;
		await prune(domain, current);
		const workRoot = path.join(runtime, WORK_DIRECTORY);
		await privateDirectory(workRoot);
		// Only the round-lease holder owns this scratch directory; interrupted rounds are reclaimed here.
		for (const entry of await fs.readdir(workRoot)) await removeWithRetries(path.join(workRoot, entry));
		const generation = `${Date.now()}-${randomUUID()}`;
		staging = path.join(domain, `.staging-${generation}`);
		scratch = path.join(workRoot, generation);
		await privateDirectory(staging);
		await privateDirectory(scratch);
		const data = path.join(staging, "data");
		await privateDirectory(data);
		const runtimeIdentity = `${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeNs}`;
		const previousEntries = new Map(
			previous?.runtimeIdentity === runtimeIdentity ? previous.entries.map(entry => [entry.path, entry]) : [],
		);
		const entries: SnapshotEntry[] = [];
		const excluded: SnapshotManifest["excluded"] = [];
		const validators: Array<() => Promise<void>> = [];
		const buffer = Buffer.allocUnsafe(1024 * 1024);

		async function resolveInternalLink(source: string): Promise<string | undefined> {
			let resolved = runtime;
			let pending = path.relative(runtime, source).split(path.sep);
			let links = 0;
			while (pending.length > 0) {
				const component = pending.shift()!;
				if (!component || component === ".") continue;
				if (component === "..") {
					resolved = path.dirname(resolved);
					if (!isInside(runtime, resolved)) return undefined;
					continue;
				}
				const candidate = path.join(resolved, component);
				let stat;
				try {
					stat = await fs.lstat(candidate);
				} catch {
					throw failure("UNRESOLVED_SOURCE_LINK");
				}
				if (stat.isSymbolicLink()) {
					if (++links > 40) throw failure("UNRESOLVED_SOURCE_LINK");
					const target = await fs.readlink(candidate);
					if (path.isAbsolute(target)) {
						// Check before any target IO, including intermediate links which
						// leave the runtime and might eventually point back into it.
						if (target !== runtime && !target.startsWith(`${runtime}${path.sep}`)) return undefined;
						resolved = runtime;
						pending = target.slice(runtime.length).split(path.sep).concat(pending);
					} else pending = target.split(path.sep).concat(pending);
				} else {
					if (pending.length > 0 && !stat.isDirectory()) throw failure("UNRESOLVED_SOURCE_LINK");
					resolved = candidate;
				}
			}
			return resolved;
		}

		async function copyStable(
			source: string,
			destination: string | undefined,
			before: BigIntStats,
			appendOnly: boolean,
		): Promise<{ sha256: string; prefixBytes?: number }> {
			const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const opened = await input.stat({ bigint: true });
				if (
					appendOnly
						? !sameFile(before, opened) || opened.size < before.size
						: !equalStamp(stamp(before), stamp(opened))
				)
					throw failure("SOURCE_CHANGED");
				if (process.platform === "linux" && !isInside(runtime, await fs.realpath(`/proc/self/fd/${input.fd}`))) {
					throw failure("UNSAFE_SOURCE_LINK");
				}
				if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure("SOURCE_TOO_LARGE");
				let length = Number(before.size);
				if (appendOnly) {
					// Do not publish an in-flight final JSONL/log record. Find a completed line
					// in the initially observed extent, never chase a continuously growing EOF.
					let end = length;
					length = 0;
					while (end > 0) {
						signal?.throwIfAborted();
						const start = Math.max(0, end - buffer.length);
						const { bytesRead } = await input.read(buffer, 0, end - start, start);
						if (bytesRead !== end - start) throw failure("SOURCE_CHANGED");
						const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
						if (newline >= 0) {
							length = start + newline + 1;
							break;
						}
						end = start;
					}
				}
				const backupMode = (before.mode & 0o111n) !== 0n ? 0o700 : 0o600;
				const output = destination ? await fs.open(destination, "wx", backupMode) : undefined;
				try {
					await output?.chmod(backupMode);
					const hash = createHash("sha256");
					let position = 0;
					while (position < length) {
						signal?.throwIfAborted();
						const { bytesRead } = await input.read(
							buffer,
							0,
							Math.min(buffer.length, length - position),
							position,
						);
						if (bytesRead === 0) break;
						hash.update(buffer.subarray(0, bytesRead));
						if (output) {
							let written = 0;
							while (written < bytesRead) {
								const result = await output.write(buffer, written, bytesRead - written, position + written);
								if (result.bytesWritten === 0) throw failure("INCOMPLETE_WRITE");
								written += result.bytesWritten;
							}
						}
						position += bytesRead;
					}
					const after = await input.stat({ bigint: true });
					if (
						position !== length ||
						(appendOnly
							? !sameFile(before, after) || after.size < BigInt(length)
							: !equalStamp(stamp(before), stamp(after)))
					) {
						throw failure("SOURCE_CHANGED");
					}
					await output?.sync();
					return { sha256: hash.digest("hex"), ...(appendOnly ? { prefixBytes: length } : {}) };
				} finally {
					await output?.close();
				}
			} finally {
				await input.close();
			}
		}

		async function validatePrefix(source: string, before: BigIntStats, entry: SnapshotEntry): Promise<void> {
			if ((await fs.realpath(source)) !== source) throw failure("UNSAFE_SOURCE_LINK");
			const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const opened = await handle.stat({ bigint: true });
				const length = entry.prefixBytes!;
				if (
					!sameFile(before, opened) ||
					opened.size < BigInt(length) ||
					(process.platform === "linux" && !isInside(runtime, await fs.realpath(`/proc/self/fd/${handle.fd}`)))
				)
					throw failure("SOURCE_CHANGED");
				const hash = createHash("sha256");
				let position = 0;
				while (position < length) {
					signal?.throwIfAborted();
					const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position);
					if (bytesRead === 0) throw failure("SOURCE_CHANGED");
					hash.update(buffer.subarray(0, bytesRead));
					position += bytesRead;
				}
				const after = await handle.stat({ bigint: true });
				if (!sameFile(before, after) || after.size < BigInt(length) || hash.digest("hex") !== entry.sha256)
					throw failure("SOURCE_CHANGED");
			} finally {
				await handle.close();
			}
		}

		async function linkPrevious(child: string, destination: string, generation: string): Promise<void> {
			const oldFile = path.join(domain, "generations", generation, "data", child);
			const oldStat = await fs.lstat(oldFile);
			if (!oldStat.isFile() || oldStat.isSymbolicLink() || (await fs.realpath(oldFile)) !== oldFile)
				throw failure("UNSAFE_BACKUP_LINK");
			// Only immutable completed backup files are linked, never the active runtime.
			await fs.link(oldFile, destination);
		}

		async function visit(relative: string): Promise<void> {
			signal?.throwIfAborted();
			const sourceDirectory = path.join(runtime, relative);
			if ((await fs.realpath(sourceDirectory)) !== sourceDirectory) throw failure("UNSAFE_SOURCE_LINK");
			const directoryStat = await fs.lstat(sourceDirectory, { bigint: true });
			const children = (await fs.readdir(sourceDirectory)).sort();
			const considered: string[] = [];
			const databases = new Set<string>();
			const inspected = new Map<string, BigIntStats>();
			// Inspect content, not suffix: OMP/native stores need not use .db names.
			for (const name of children) {
				if (ephemeral(name, relative)) continue;
				const source = path.join(sourceDirectory, name);
				const stat = await fs.lstat(source, { bigint: true });
				if (!stat.isFile()) continue;
				inspected.set(name, stat);
				const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				try {
					if (
						process.platform === "linux" &&
						!isInside(runtime, await fs.realpath(`/proc/self/fd/${handle.fd}`))
					) {
						throw failure("UNSAFE_SOURCE_LINK");
					}
					const header = Buffer.alloc(SQLITE_HEADER.length);
					const { bytesRead } = await handle.read(header, 0, header.length, 0);
					if (bytesRead === header.length && header.equals(SQLITE_HEADER)) databases.add(name);
				} finally {
					await handle.close();
				}
			}
			const ignored = (name: string): boolean =>
				ephemeral(name, relative) ||
				["-wal", "-shm", "-journal"].some(
					suffix => name.endsWith(suffix) && databases.has(name.slice(0, -suffix.length)),
				);
			for (const name of children) {
				signal?.throwIfAborted();
				const child = path.join(relative, name);
				if (ignored(name)) {
					excluded.push({ path: child, reason: ephemeral(name, relative) ? "ephemeral" : "sqlite-sidecar" });
					continue;
				}
				considered.push(name);
				const source = path.join(runtime, child);
				const destination = path.join(data, child);
				const before = await fs.lstat(source, { bigint: true });
				const entry: SnapshotEntry = { path: child, kind: "file", mode: Number(before.mode & 0o777n) };
				if (before.isSymbolicLink()) {
					const target = await fs.readlink(source);
					const resolved = await resolveInternalLink(source);
					if (resolved === undefined) {
						excluded.push({ path: child, reason: "external-symlink" });
						continue;
					}
					entry.kind = "symlink";
					// Relative targets must retain symlink/.. and "." semantics. Absolute
					// internal targets become portable links into this recoverable tree.
					entry.target = path.isAbsolute(target) ? path.relative(path.dirname(source), resolved) || "." : target;
					await fs.symlink(entry.target, destination);
					validators.push(async () => {
						if (
							!equalStamp(stamp(before), stamp(await fs.lstat(source, { bigint: true }))) ||
							(await fs.readlink(source)) !== target ||
							(await resolveInternalLink(source)) !== resolved
						)
							throw failure("SOURCE_CHANGED");
					});
				} else if (before.isDirectory()) {
					entry.kind = "directory";
					await privateDirectory(destination);
					await visit(child);
				} else if (before.isFile()) {
					const initial = inspected.get(name);
					const appendOnly = /\.(?:jsonl|log)$/i.test(name);
					if (
						!initial ||
						!sameFile(initial, before) ||
						(!databases.has(name) &&
							!(appendOnly ? before.size >= initial.size : equalStamp(stamp(initial), stamp(before))))
					)
						throw failure("SOURCE_CHANGED");
					if ((await fs.realpath(source)) !== source) throw failure("UNSAFE_SOURCE_LINK");
					if (databases.has(name)) {
						entry.kind = "sqlite";
						const snapshot = path.join(scratch!, `${randomUUID()}.sqlite`);
						const db = new Database(source, { readonly: true, create: false });
						try {
							db.exec("PRAGMA busy_timeout = 1000");
							using statement = db.prepare("VACUUM INTO ?");
							statement.run(snapshot);
						} finally {
							db.close(true);
						}
						await fs.chmod(snapshot, 0o600);
						// Hash the new closed snapshot every round: main-file metadata misses WAL-only commits.
						const snapshotStat = await fs.lstat(snapshot, { bigint: true });
						Object.assign(entry, await copyStable(snapshot, undefined, snapshotStat, false));
						const old = previousEntries.get(child);
						if (old?.kind === "sqlite" && old.sha256 === entry.sha256 && current) {
							await linkPrevious(child, destination, current.current);
						} else {
							// The closed local snapshot has no live WAL dependency.
							await fs.copyFile(snapshot, destination, constants.COPYFILE_EXCL);
							await fs.chmod(destination, 0o600);
							await syncFile(destination);
						}
						// Bun's finalized SQLite handles can still deny Windows deletion until GC.
						// Reuse the owned-temp release primitive, not a snapshot/copy retry.
						await removeWithRetries(snapshot);
						validators.push(async () => {
							if (
								!sameFile(before, await fs.lstat(source, { bigint: true })) ||
								(await fs.realpath(source)) !== source
							)
								throw failure("DATABASE_REPLACED");
						});
					} else {
						entry.stamp = stamp(before);
						const old = previousEntries.get(child);
						if (old?.kind === "file" && equalStamp(old.stamp, entry.stamp) && old.sha256 && current) {
							await linkPrevious(child, destination, current.current);
							entry.sha256 = old.sha256;
							entry.prefixBytes = old.prefixBytes;
						} else Object.assign(entry, await copyStable(source, destination, before, appendOnly));
						validators.push(async () => {
							if (entry.prefixBytes !== undefined) await validatePrefix(source, before, entry);
							else if (
								!equalStamp(entry.stamp, stamp(await fs.lstat(source, { bigint: true }))) ||
								(await fs.realpath(source)) !== source
							)
								throw failure("SOURCE_CHANGED");
						});
					}
				} else {
					excluded.push({ path: child, reason: "non-regular-runtime-object" });
					continue;
				}
				entries.push(entry);
			}
			validators.push(async () => {
				if (
					!sameFile(directoryStat, await fs.lstat(sourceDirectory, { bigint: true })) ||
					(await fs.realpath(sourceDirectory)) !== sourceDirectory ||
					JSON.stringify((await fs.readdir(sourceDirectory)).filter(name => !ignored(name)).sort()) !==
						JSON.stringify(considered)
				) {
					throw failure("SOURCE_TREE_CHANGED");
				}
			});
			await syncDirectory(path.join(data, relative));
		}

		await visit("");
		for (const validate of validators) {
			signal?.throwIfAborted();
			await validate();
		}
		const completedAt = new Date().toISOString();
		const paths = new Set(entries.map(entry => entry.path));
		const manifest: SnapshotManifest = {
			format: 1,
			status: "complete",
			domainId: state.domainId,
			generation,
			completedAt,
			persistentRoot: state.persistentRoot,
			runtimeRoot: state.runtimeRoot,
			runtimeIdentity,
			scope: "complete-runtime-only",
			consistency: "individual-sqlite-transactions-and-stable-files-not-global-transaction",
			recovery:
				"Copy data/ contents into an inactive, empty runtime root, preserving permissions. Never overlay original persistent-root data or copy active WAL files. Private files retain owner executable permission; original modes are also recorded in entries.",
			deletionScope: "same-runtime-incarnation-only-never-original-persistent-root",
			deletedSincePrevious:
				previous?.runtimeIdentity === runtimeIdentity
					? previous.entries.filter(entry => !paths.has(entry.path)).map(entry => entry.path)
					: [],
			entries,
			excluded,
		};
		await writePrivate(path.join(staging, "manifest.json"), manifest);
		await syncDirectory(staging);
		signal?.throwIfAborted();
		const generationRoot = path.join(domain, "generations", generation);
		await fs.rename(staging, generationRoot);
		staging = undefined;
		await syncDirectory(path.join(domain, "generations"));
		const pointer: CurrentGeneration = { format: 1, current: generation, previous: current?.current, completedAt };
		const pointerTemporary = path.join(domain, `.current-${generation}`);
		await writePrivate(pointerTemporary, pointer);
		signal?.throwIfAborted();
		// This sole shared-pointer mutation is synchronous ONLY in the dedicated
		// worker. Its native lease cannot be dropped by Worker termination before
		// the syscall returns: no pending rename may overwrite a successor after
		// the lease is released. Parent shutdown never awaits the worker.
		renameSync(pointerTemporary, path.join(domain, "current.json"));
		// Durability errors are backup failures, not cleanup warnings.
		await syncDirectory(domain);
		published = true;
		if (latestSuccess.size >= 32) latestSuccess.delete(latestSuccess.keys().next().value!);
		latestSuccess.set(state.domainId, completedAt);
		// Only post-commit retention/diagnostic cleanup may degrade without failing the round.
		try {
			const localRecord = path.join(scratch, "success.json");
			await writePrivate(localRecord, { completedAt });
			renameSync(localRecord, successRecord);
			await prune(domain, pointer);
		} catch (error) {
			logger.warn("offline_shm_backup.cleanup_failed", {
				domain_id: domainHash,
				...logger.diagnosticError(error),
				latest_success_at: completedAt,
			});
		}
		logger.info("offline_shm_backup.completed", {
			domain_id: domainHash,
			latest_success_at: completedAt,
			entries: entries.length,
		});
		return { status: "completed", completedAt, backupPath: generationRoot };
	} catch (error) {
		const diagnostic = logger.diagnosticError(error);
		const code = signal?.aborted
			? "ABORTED"
			: error instanceof BackupFailure
				? error.code
				: typeof diagnostic.error_code === "string"
					? diagnostic.error_code
					: "BACKUP_IO_FAILED";
		logger.warn("offline_shm_backup.failed", {
			domain_id: domainHash,
			latest_success_at: previousSuccess,
			...diagnostic,
			reason: code,
		});
		throw failure(code);
	} finally {
		// Worker termination may interrupt this cleanup; the next lease holder reclaims its bounded leftovers.
		try {
			if (staging && !published) await fs.rm(staging, { recursive: true, force: true });
			if (scratch) await removeWithRetries(scratch);
		} catch (error) {
			logger.warn("offline_shm_backup.cleanup_failed", { domain_id: domainHash, ...logger.diagnosticError(error) });
		} finally {
			lock.release();
		}
	}
}
