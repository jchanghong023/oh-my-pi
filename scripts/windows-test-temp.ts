import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Windows-only: the OS temp dir defaults to the system drive (`C:\Users\…\AppData\Local\Temp`).
 * The TS and Rust suites fan out many concurrent test processes whose temp
 * fixtures all land on that one disk, next to the pagefile — enough constant
 * I/O to make the whole machine stutter. When another writable drive exists,
 * redirect test temp dirs (`TMP`/`TEMP`) to it; keep the default only on
 * single-drive machines. No-op on every other platform, when `TEMP` already
 * points off the system drive, and when no other writable drive is found.
 */
export function windowsTestTempOverride(): { TMP: string; TEMP: string } | undefined {
	if (process.platform !== "win32") return undefined;
	const systemDrive = (process.env.SystemDrive ?? "C:").toUpperCase();
	const current = process.env.TEMP ?? process.env.TMP ?? "";
	const currentDrive = current.replaceAll("/", "\\").slice(0, 2).toUpperCase();
	if (currentDrive.length === 2 && currentDrive !== systemDrive) return undefined;

	let best: { dir: string; free: number } | undefined;
	for (let code = "D".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
		const root = `${String.fromCharCode(code)}:\\`;
		if (root.slice(0, 2).toUpperCase() === systemDrive) continue;
		if (!fs.existsSync(root)) continue;
		const dir = path.join(root, "omp-test-tmp");
		try {
			// A standard user may create files inside an existing temp directory
			// even when writing directly to the drive root is denied.
			fs.mkdirSync(dir, { recursive: true });
			const probe = fs.mkdtempSync(path.join(dir, ".omp-probe-"));
			fs.rmSync(probe, { recursive: true });
		} catch {
			continue;
		}
		let free = 0;
		try {
			if (typeof fs.statfsSync === "function") {
				const stats = fs.statfsSync(root);
				free = Number(stats.bsize) * Number(stats.bavail);
			}
		} catch {
			// Free-space comparison is best effort; fall back to probe order.
		}
		if (best === undefined || free > best.free) best = { dir, free };
	}
	if (best === undefined) return undefined;

	return { TMP: best.dir, TEMP: best.dir };
}
