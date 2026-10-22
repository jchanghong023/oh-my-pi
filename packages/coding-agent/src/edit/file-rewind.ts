import * as fs from "node:fs";
import * as path from "node:path";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterUncertainWrites,
	invalidateFsScanAfterWrite,
} from "../tools/fs-cache-invalidation";

export interface FileCheckpoint {
	path: string;
	/** Undefined means the file did not exist, not an unavailable snapshot. */
	before?: string;
	/** Undefined means the expected current file is absent. */
	after?: string;
}

export interface FileCheckpointReceipt {
	path: string;
	status: "restored" | "unchanged" | "rejected" | "unknown";
	reason?: string;
}

export interface FileCheckpointRestoreResult {
	applied: boolean;
	receipts: FileCheckpointReceipt[];
	reason?: string;
}

export interface FileCheckpointRestoreOptions {
	cwd?: string;
	signal?: AbortSignal;
	/** Synchronous owner revision/lease guard; called inside mutation admission. */
	assertCurrent?: () => void;
	/** Notification only; a thrown notification never erases the mutation receipt. */
	onRestored?: (path: string) => void;
}

const mutations = new Map<string, Promise<void>>();
const mutationKey = (file: string) => {
	let absolute = path.resolve(file);
	const suffix: string[] = [];
	for (;;) {
		try {
			absolute = path.join(fs.realpathSync.native(absolute), ...suffix.reverse());
			break;
		} catch (error) {
			if (!missing(error)) throw error;
			const parent = path.dirname(absolute);
			if (parent === absolute) throw error;
			suffix.push(path.basename(absolute));
			absolute = parent;
		}
	}
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

/** Shared by edit's real write callback and checkpoint restores, across sessions. */
export async function withFileMutationLocks<T>(files: readonly string[], run: () => Promise<T> | T): Promise<T> {
	const keys = [...new Set(files.map(mutationKey))].sort();
	const pending = keys.map(key => mutations.get(key)).filter((value): value is Promise<void> => value !== undefined);
	const gate = Promise.withResolvers<void>();
	for (const key of keys) mutations.set(key, gate.promise);
	try {
		await Promise.all(pending);
		return await run();
	} finally {
		gate.resolve();
		for (const key of keys) if (mutations.get(key) === gate.promise) mutations.delete(key);
	}
}

interface Identity {
	dev: number;
	ino: number;
}
interface Observed {
	parents: { path: string; identity: Identity }[];
	file?: fs.Stats;
}

function sameIdentity(a: Identity, b: Identity): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function inspect(file: string, expected: string | undefined): Observed {
	const parents: Observed["parents"] = [];
	let parent = path.dirname(file);
	for (;;) {
		const stat = fs.lstatSync(parent);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe_path: ${parent}`);
		parents.push({ path: parent, identity: stat });
		const next = path.dirname(parent);
		if (next === parent) break;
		parent = next;
	}
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(file);
	} catch (error) {
		if (!missing(error)) throw error;
		if (expected !== undefined) throw new Error(`content_mismatch: missing ${file}`);
		return { parents };
	}
	if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error(`unsafe_path: ${file}`);
	if (expected === undefined || !fs.readFileSync(file).equals(Buffer.from(expected, "utf8"))) {
		throw new Error(`content_mismatch: ${file}`);
	}
	return { parents, file: stat };
}

function revalidate(file: string, expected: string | undefined, observed: Observed): void {
	const current = inspect(file, expected);
	if (current.parents.some((parent, index) => !sameIdentity(parent.identity, observed.parents[index].identity))) {
		throw new Error(`path_redirected: ${file}`);
	}
	if (
		Boolean(current.file) !== Boolean(observed.file) ||
		(current.file &&
			observed.file &&
			(!sameIdentity(current.file, observed.file) ||
				current.file.mtimeMs !== observed.file.mtimeMs ||
				current.file.ctimeMs !== observed.file.ctimeMs ||
				current.file.size !== observed.file.size))
	) {
		throw new Error(`external_modification: ${file}`);
	}
}

/**
 * Restore complete, known UTF-8 snapshots only. No patch parsing, formatting,
 * conversation truncation, snapshot inference, or rollback over external edits.
 * The synchronous revalidate/commit section prevents cooperating JS mutations
 * from interleaving. OS-external writers are not locked by this process; any
 * unconfirmed commit is reported unknown, never automatically rolled back.
 */
export async function restoreFileCheckpoints(
	checkpoints: readonly FileCheckpoint[],
	options: FileCheckpointRestoreOptions = {},
): Promise<FileCheckpointRestoreResult> {
	const files = checkpoints.map(checkpoint => ({
		...checkpoint,
		path: path.resolve(options.cwd ?? process.cwd(), checkpoint.path),
	}));
	const receipts: FileCheckpointReceipt[] = files.map(file => ({
		path: file.path,
		status: "rejected",
		reason: "not_attempted",
	}));
	const guard = () => {
		options.signal?.throwIfAborted();
		options.assertCurrent?.();
	};
	try {
		if (files.length === 0) throw new Error("missing_checkpoint");
		if (
			process.platform === "win32" &&
			files.some(file => file.path.slice(path.parse(file.path).root.length).includes(":"))
		) {
			throw new Error("unsafe_path: alternate data stream");
		}
		const keys = new Set<string>();
		for (let index = 0; index < files.length; index++) {
			const file = files[index];
			if (
				!checkpoints[index].path ||
				checkpoints[index].path.includes("\0") ||
				/^[a-z][a-z0-9+.-]*:\/\//i.test(checkpoints[index].path)
			)
				throw new Error("unsafe_path");
			if (file.before === undefined && file.after === undefined) throw new Error("missing_checkpoint");
			if (
				(file.before !== undefined && typeof file.before !== "string") ||
				(file.after !== undefined && typeof file.after !== "string")
			)
				throw new Error("invalid_checkpoint");
			for (const text of [file.before, file.after]) {
				if (text !== undefined && Buffer.from(text, "utf8").toString("utf8") !== text)
					throw new Error("invalid_utf8_checkpoint");
			}
			const key = mutationKey(file.path);
			if (keys.has(key)) throw new Error(`duplicate_path: ${file.path}`);
			keys.add(key);
		}
		return await withFileMutationLocks(
			files.map(file => file.path),
			() => {
				try {
					guard();
					const observed = files.map(file => inspect(file.path, file.after));
					for (let index = 0; index < files.length; index++) {
						const file = files[index];
						guard();
						revalidate(file.path, file.after, observed[index]);
						if (file.before === file.after) {
							receipts[index] = { path: file.path, status: "unchanged" };
							continue;
						}
						let descriptor: number | undefined;
						let began = false;
						let committedIdentity: Identity | undefined;
						try {
							if (file.before === undefined) {
								began = true;
								fs.unlinkSync(file.path);
							} else {
								descriptor = fs.openSync(
									file.path,
									file.after === undefined ? "wx" : fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
								);
								if (file.after === undefined) began = true;
								const stat = fs.fstatSync(descriptor);
								committedIdentity = stat;
								const original = observed[index].file;
								if (original && !sameIdentity(stat, original)) throw new Error(`path_redirected: ${file.path}`);
								// Recheck content on the opened inode before the first destructive write.
								if (
									file.after !== undefined &&
									!fs.readFileSync(descriptor).equals(Buffer.from(file.after, "utf8"))
								)
									throw new Error(`content_mismatch: ${file.path}`);
								revalidate(
									file.path,
									file.after ?? "",
									file.after === undefined
										? { parents: observed[index].parents, file: stat }
										: observed[index],
								);
								began = true;
								const bytes = Buffer.from(file.before, "utf8");
								let written = 0;
								while (written < bytes.length) {
									const count = fs.writeSync(descriptor, bytes, written, bytes.length - written, written);
									if (count === 0) throw new Error("incomplete_write");
									written += count;
								}
								fs.ftruncateSync(descriptor, bytes.length);
								fs.closeSync(descriptor);
								descriptor = undefined;
							}
							const confirmed = inspect(file.path, file.before);
							if (committedIdentity && (!confirmed.file || !sameIdentity(committedIdentity, confirmed.file))) {
								throw new Error(`path_redirected_after_commit: ${file.path}`);
							}
							receipts[index] = { path: file.path, status: "restored" };
						} catch (error) {
							receipts[index] = {
								path: file.path,
								status: began ? "unknown" : "rejected",
								reason: reason(error),
							};
							throw error;
						} finally {
							if (descriptor !== undefined) fs.closeSync(descriptor);
							if (began) {
								if (receipts[index].status === "unknown") {
									invalidateFsScanAfterUncertainWrites(
										[file.path],
										receipts[index].reason ?? "checkpoint_restore_unknown",
									);
								} else if (file.before === undefined) invalidateFsScanAfterDelete(file.path);
								else invalidateFsScanAfterWrite(file.path);
							}
						}
						options.onRestored?.(file.path);
					}
					return { applied: true, receipts };
				} catch (error) {
					return { applied: false, receipts, reason: reason(error) };
				}
			},
		);
	} catch (error) {
		return { applied: false, receipts, reason: reason(error) };
	}
}
