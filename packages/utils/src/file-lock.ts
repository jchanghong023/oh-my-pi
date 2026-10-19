/**
 * Cross-process advisory lock for packages that serialize access to an
 * on-disk resource. The native handle is process-owned and automatically
 * released on exit: Linux uses abstract Unix sockets, Windows uses named
 * mutexes, and other Unix platforms use `flock(2)` on `${filePath}.lock`.
 */
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import {
	FileLock as NativeFileLock,
	tryAcquirePersistentFileLock as nativeTryAcquirePersistentFileLock,
} from "@oh-my-pi/pi-natives";

/** Controls bounded waiting when an advisory file lock is contended. */
export interface FileLockOptions {
	/** Maximum acquisition attempts, including the initial attempt. */
	retries?: number;
	/** Delay between acquisition attempts. */
	retryDelayMs?: number;
	/** Cancel acquisition while waiting for another process to release the resource. */
	signal?: AbortSignal;
}

/** An exclusive OS-backed lease. Releasing an already released handle is safe. */
export interface FileLockHandle {
	release(): void;
}

/** A cross-host POSIX record-lock lease; release may perform filesystem I/O. */
export interface PersistentFileLockHandle {
	release(): Promise<void>;
}

const DEFAULT_OPTIONS = {
	retries: 50,
	retryDelayMs: 100,
};

function getLockPath(filePath: string): string {
	return `${path.resolve(filePath)}.lock`;
}

function tryAcquireLock(lockPath: string): NativeFileLock | null {
	const lock = NativeFileLock.tryAcquire(lockPath);
	if (lock.acquired) return lock;
	lock.release();
	return null;
}

/** Acquire an exclusive lease without waiting; `null` while another holder owns it. */
export function tryAcquireFileLock(filePath: string): FileLockHandle | null {
	return tryAcquireLock(getLockPath(filePath));
}

/** Acquire an exclusive lease; callers must release it when their operation ends. */
export async function acquireFileLock(filePath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries) await scheduler.wait(opts.retryDelayMs, { signal: opts.signal });
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): NativeFileLock {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries && opts.retryDelayMs > 0) Bun.sleepSync(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/** Run `fn` while holding an OS-backed exclusive lock for `filePath`. */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

/** Run synchronous `fn` while holding an OS-backed exclusive lock for `filePath`. */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const lock = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		lock.release();
	}
}

/**
 * Acquire a stable `${path.resolve(filePath)}.lock` POSIX record lock.
 * All sidecar I/O runs on native workers, including release. The native
 * process-wide inode registry also excludes contenders in other JS Workers:
 * JS-only mutexes cannot safely protect process-owned POSIX record locks.
 * Unsupported platforms reject; this never falls back to a local-only lock.
 * Cross-host exclusion requires working POSIX record locks on the NFS server.
 */
export async function acquirePersistentFileLock(
	filePath: string,
	options: FileLockOptions = {},
): Promise<PersistentFileLockHandle> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = await nativeTryAcquirePersistentFileLock(lockPath);
		if (lock.acquired) {
			// Cancellation can arrive while the native open/fcntl task is pending.
			// Never leak a newly acquired lease when delivering that cancellation.
			if (opts.signal?.aborted) {
				await lock.release();
				opts.signal.throwIfAborted();
			}
			return lock;
		}
		await lock.release();
		opts.signal?.throwIfAborted();
		if (attempt + 1 < opts.retries) await scheduler.wait(opts.retryDelayMs, { signal: opts.signal });
	}

	throw new Error(`Failed to acquire persistent lock for ${filePath} after ${opts.retries} attempts`);
}

/** Run `fn` under the persistent cross-host protocol, awaiting native release. */
export async function withPersistentFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquirePersistentFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}

/**
 * Test-only acquisition handle for forcing ownership handoffs. This is not
 * part of the supported package API.
 */
export const __internalsForTesting = {
	tryAcquireLock,
	getLockPath,
};
