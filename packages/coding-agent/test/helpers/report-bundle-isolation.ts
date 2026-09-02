import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * Test isolation for report-bundle suites.
 *
 * `createReportBundle` writes the archive to the reports directory and reads
 * same-day process logs from the logs directory. Both resolve through the
 * cached XDG-aware `DirResolver`, which only redirects under
 * `$XDG_STATE_HOME/omp` on Linux/macOS — on Windows those env vars never
 * apply, so a test that only points `XDG_STATE_HOME` at a temp dir silently
 * writes through to the real `~/.omp/reports` and `~/.omp/logs`. This helper
 * provisions temp reports/logs dirs that the suite injects into
 * `createReportBundle` via its options, keeping every write inside the temp
 * root on all platforms.
 */
export interface ReportBundleTestDirs {
	/** Temp root holding all isolated state; suites may place fixtures here. */
	rootDir: string;
	reportsDir: string;
	logsDir: string;
	/** Remove the temp root. */
	cleanup(): Promise<void>;
}

export async function isolateReportBundleDirs(): Promise<ReportBundleTestDirs> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-report-test-"));
	const reportsDir = path.join(root, "reports");
	const logsDir = path.join(root, "logs");
	await fs.mkdir(reportsDir, { recursive: true });
	await fs.mkdir(logsDir, { recursive: true });
	return {
		rootDir: root,
		reportsDir,
		logsDir,
		cleanup: () => removeWithRetries(root),
	};
}
