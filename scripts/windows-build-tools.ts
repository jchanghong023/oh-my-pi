import * as fs from "node:fs";
import * as path from "node:path";

/** Put VS Build Tools' CMake and Ninja on PATH, behind any user-provided tools. */
export function ensureWindowsBuildTools(options?: { tolerateProbeFailure?: boolean }): void {
	if (process.platform !== "win32" || (Bun.which("cmake") && Bun.which("ninja"))) return;
	const vcToolsComponent =
		process.arch === "arm64"
			? "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
			: "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";
	const vswhere = path.join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
		"vswhere.exe",
	);
	let vsRoot: string;
	try {
		const probe = Bun.spawnSync(
			[vswhere, "-latest", "-products", "*", "-requires", vcToolsComponent, "-property", "installationPath"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		vsRoot = probe.exitCode === 0 ? probe.stdout.toString("utf-8").trim() : "";
	} catch (error) {
		if (options?.tolerateProbeFailure) return;
		throw error;
	}
	if (!vsRoot) return;

	const cmakeExt = path.join(vsRoot, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake");
	const extraDirs = [path.join(cmakeExt, "CMake", "bin"), path.join(cmakeExt, "Ninja")].filter(dir => fs.existsSync(dir));
	if (extraDirs.length > 0) {
		process.env.PATH = [process.env.PATH ?? "", ...extraDirs].filter(Boolean).join(path.delimiter);
	}
}
