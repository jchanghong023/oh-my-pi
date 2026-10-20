import { statSync } from "node:fs";
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
