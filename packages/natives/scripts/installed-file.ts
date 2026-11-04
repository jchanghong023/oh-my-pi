import * as fs from "node:fs/promises";

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
