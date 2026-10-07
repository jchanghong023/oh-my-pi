import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Whether this process can create real filesystem symlinks. Windows needs
 * Developer Mode or elevation for that (fs.symlink fails with EPERM), so tests
 * whose fixtures require real links gate on this probe instead of the platform
 * alone — a privileged Windows box still runs them. Results are cached; the
 * probe link lives only for the check.
 */
let cached: boolean | undefined;

export function canCreateSymlinks(): boolean {
	if (cached !== undefined) return cached;
	if (process.platform !== "win32") {
		cached = true;
		return cached;
	}
	const base = path.join(os.tmpdir(), `omp-symlink-probe-${process.pid}`);
	const link = `${base}-link`;
	try {
		// A stale link from an earlier run (crash before cleanup, pid reused)
		// would surface as EEXIST and read as "no privilege".
		fs.rmSync(link, { force: true });
		fs.symlinkSync(base, link, "file");
		fs.rmSync(link, { force: true });
		cached = true;
	} catch {
		cached = false;
	}
	return cached;
}
