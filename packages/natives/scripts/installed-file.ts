import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Preserve an identical writable regular file, repairing POSIX permissions in place. */
export async function matchesInstalledFile(sourcePath: string, destPath: string): Promise<boolean> {
	try {
		const installed = await fs.lstat(destPath);
		if (!installed.isFile() || !(installed.mode & 0o200)) return false;
		if (!(await fs.readFile(destPath)).equals(await fs.readFile(sourcePath))) return false;
		if (process.platform !== "win32" && (installed.mode & 0o7777) !== 0o644) {
			await fs.chmod(destPath, 0o644);
		}
		return true;
	} catch {
		// A comparison is optional; retain the normal replacement/error path.
		return false;
	}
}

/** Both the previous file and the candidate are needed if rollback fails. */
class InstallRollbackError extends Error {
	constructor(backupPath: string, tempPath: string, installError: unknown, rollbackError: unknown) {
		super(
			`Cannot restore previous file at ${backupPath}: ${String(rollbackError)}; replacement retained at ${tempPath}`,
			{ cause: installError },
		);
	}
}

async function replaceInstalledFile(tempPath: string, destPath: string, allowUnlinkFallback: boolean): Promise<void> {
	const windows = process.platform === "win32";
	try {
		await fs.rename(tempPath, destPath);
		return;
	} catch (error) {
		if (!windows && !allowUnlinkFallback) throw error;
	}

	// Windows lets a mapped image move aside even when it cannot be overwritten.
	const backupPath = `${destPath}.old.${process.pid}`;
	let movedAside = false;
	try {
		await fs.rename(destPath, backupPath);
		movedAside = true;
	} catch (error) {
		if (allowUnlinkFallback) {
			try {
				await fs.unlink(destPath);
			} catch (unlinkError) {
				if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
					throw new Error(
						`Cannot replace ${path.basename(destPath)}${windows ? " (file may be in use - close any running processes)" : ""}: ${(unlinkError as Error).message}`,
						{ cause: unlinkError },
					);
				}
			}
		} else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	try {
		await fs.rename(tempPath, destPath);
	} catch (error) {
		if (movedAside) {
			try {
				await fs.rename(backupPath, destPath);
			} catch (rollbackError) {
				throw new InstallRollbackError(backupPath, tempPath, error, rollbackError);
			}
		}
		if (allowUnlinkFallback) {
			throw new Error(`Failed to install ${path.basename(destPath)}: ${(error as Error).message}`, { cause: error });
		}
		throw error;
	}
	if (movedAside) await fs.unlink(backupPath).catch(() => {});
}

interface InstallOptions {
	/** Keep Cargo's fallback only if both direct replacement and moving aside fail. */
	allowUnlinkFallback?: boolean;
}

type PrepareFile<T> = (tempPath: string) => Promise<T>;

/** Stage and install final bytes, comparing after preparation when one is supplied. */
export function installFile<T>(
	sourcePath: string,
	destPath: string,
	options: InstallOptions & { prepare: PrepareFile<T> },
): Promise<T>;
export function installFile(sourcePath: string, destPath: string, options?: InstallOptions): Promise<void>;
export async function installFile<T>(
	sourcePath: string,
	destPath: string,
	{ prepare, allowUnlinkFallback = false }: InstallOptions & { prepare?: PrepareFile<T> } = {},
): Promise<T | void> {
	if (!prepare && (await matchesInstalledFile(sourcePath, destPath))) return;

	const tempPath = `${destPath}.tmp.${process.pid}.${randomUUID()}`;
	try {
		await fs.copyFile(sourcePath, tempPath);
		// Windows cannot replace a read-only staged copy when stamping; on POSIX
		// set the final mode after preparation, which may create a new inode.
		const windows = process.platform === "win32";
		if (windows) await fs.chmod(tempPath, 0o644);
		const result = await prepare?.(tempPath);
		if (!windows) await fs.chmod(tempPath, 0o644);
		if (prepare && (await matchesInstalledFile(tempPath, destPath))) await fs.unlink(tempPath);
		else await replaceInstalledFile(tempPath, destPath, allowUnlinkFallback);
		return result;
	} catch (error) {
		if (!(error instanceof InstallRollbackError)) await fs.unlink(tempPath).catch(() => {});
		throw error;
	}
}
