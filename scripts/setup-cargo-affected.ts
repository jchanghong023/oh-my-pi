#!/usr/bin/env bun
// Explicit, offline setup from the crates.io 0.4.1 source already in Cargo's cache.
// Usage: bun scripts/setup-cargo-affected.ts <cargo-affected-0.4.1-source-dir>
// Add target/omp-tools/bin to the process PATH when running the native gate.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const source = process.argv[2];
if (!source || process.argv.length !== 3) {
	throw new Error("Usage: bun scripts/setup-cargo-affected.ts <cargo-affected-0.4.1-source-dir>");
}
const root = path.resolve(import.meta.dir, "..");
const toolRoot = path.join(root, "target", "omp-tools");
const work = path.join(toolRoot, "cargo-affected-0.4.1-source");
const hashes: Record<string, string> = {
	"src/project.rs": "7327cd602c67c346629e6c0a6b8e2c4a9309d009b3189127366db38dde806e0d",
	"src/main.rs": "2cc96947403602835ffcc3796f297328ca61380e227797def4198163ce4cbf35",
};
for (const [file, expected] of Object.entries(hashes)) {
	const actual = createHash("sha256")
		.update(fs.readFileSync(path.join(source, file)))
		.digest("hex");
	if (actual !== expected) throw new Error(`Unexpected upstream cargo-affected 0.4.1 ${file}: ${actual}`);
}
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(toolRoot, { recursive: true });
fs.cpSync(source, work, { recursive: true });
// Keep the copied crate out of the enclosing repository's workspace.
const manifest = path.join(work, "Cargo.toml");
await Bun.write(manifest, `${await Bun.file(manifest).text()}\n[workspace]\n`);
function run(command: string[], cwd: string) {
	const result = Bun.spawnSync(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${result.exitCode})`);
}
const patch = await Bun.file(path.join(root, "patches", "cargo-affected-0.4.1-cdylib.patch")).text();
const relative = path.relative(root, work).replaceAll(path.sep, "/");
await vcs
	.requireGit(root)
	.applyPatch(patch.replaceAll("a/src/", `a/${relative}/src/`).replaceAll("b/src/", `b/${relative}/src/`), {});
run(
	[
		"cargo",
		"install",
		"--path",
		work,
		"--root",
		toolRoot,
		"--target-dir",
		path.join(toolRoot, "build"),
		"--locked",
		"--offline",
		"--force",
	],
	work,
);
console.log(`Patched cargo-affected 0.4.1-omp-cdylib.1 installed in ${path.join(toolRoot, "bin")}`);
