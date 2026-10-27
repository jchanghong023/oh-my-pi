import { closeSync, openSync, readSync, statSync } from "node:fs";
import * as path from "node:path";

const windowsAppAlias = /[\\/]Microsoft[\\/]WindowsApps(?:[\\/]|$)/i;

function isInstalledFile(filename: string): boolean {
	if (windowsAppAlias.test(filename)) return false;
	try {
		return statSync(filename).isFile();
	} catch {
		return false;
	}
}

/** Resolve declared tools against the same real-install PATH used by Windows tests. */
export function bazelToolPath(value: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return value;
	return value
		.split(";")
		.filter(directory => !windowsAppAlias.test(directory.replace(/^"(.*)"$/, "$1")))
		.join(";");
}

/** Only the fork E2E files using the shared native Dev TUI harness require this tool. */
export function requiresTuiTest(label: string): boolean {
	return /^test\/fork packages\/coding-agent\/test\/spec-driven\/tui(?:-capabilities|-lifecycle|-closing|-materials(?:-later-roles)?|-interactions|-resources|-resource-lifecycle)?\.e2e\.test\.ts$/.test(
		label,
	);
}

/** A script or unknown executable may delegate to an untracked implementation.
 * Never infer a closed tool input from its wrapper. */
export function isNativeTuiTest(filename: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "win32" || !filename.toLowerCase().endsWith(".exe")) return false;
	let fd: number | undefined;
	try {
		fd = openSync(filename, "r");
		const header = Buffer.alloc(64);
		if (readSync(fd, header, 0, header.length, 0) !== header.length || header.toString("ascii", 0, 2) !== "MZ")
			return false;
		const offset = header.readUInt32LE(0x3c);
		if (offset < header.length || offset > 1024 * 1024) return false;
		const signature = Buffer.alloc(4);
		return (
			readSync(fd, signature, 0, signature.length, offset) === signature.length &&
			signature.equals(Buffer.from("PE\0\0"))
		);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Preserve explicit installed shells; otherwise select Bash from a real Git installation. */
export function bazelShell(
	env: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (platform !== "win32") return env.BAZEL_SH;
	if (env.BAZEL_SH && isInstalledFile(env.BAZEL_SH)) return env.BAZEL_SH;
	const toolPath = bazelToolPath(env.PATH ?? env.Path ?? "", platform);
	for (const entry of toolPath.split(";")) {
		const directory = entry.replace(/^"(.*)"$/, "$1");
		if (!directory) continue;
		if (!isInstalledFile(path.join(directory, "git.exe"))) continue;
		let root = path.resolve(directory);
		for (let depth = 0; depth < 4; depth++) {
			// Git's cmd, bin and mingw64/bin entry points share this MSYS runtime.
			if (isInstalledFile(path.join(root, "usr", "bin", "msys-2.0.dll"))) {
				for (const relative of [
					["bin", "bash.exe"],
					["usr", "bin", "bash.exe"],
				]) {
					const bash = path.join(root, ...relative);
					if (isInstalledFile(bash)) return bash;
				}
			}
			const parent = path.dirname(root);
			if (parent === root) break;
			root = parent;
		}
	}
	throw new Error("Bazel requires an installed Bash: set BAZEL_SH to a real shell or install Git for Windows on PATH");
}
