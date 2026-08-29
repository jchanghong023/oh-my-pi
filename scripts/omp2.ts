#!/usr/bin/env bun
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import nativePackage from "../packages/natives/package.json" with { type: "json" };

const repoRoot = path.join(import.meta.dir, "..");
const nativeDir = path.join(homedir(), ".omp", "natives", nativePackage.version);
const addonPrefix = `pi_natives.${process.platform}-${process.arch}`;

function fail(message: string): never {
	console.error(`omp2: ${message}`);
	process.exit(1);
}

let addonNames: string[];
try {
	addonNames = readdirSync(nativeDir);
} catch {
	fail(
		`native cache ${nativeDir} is unavailable; start the installed omp ${nativePackage.version} once to populate it`,
	);
}

const hasPlatformAddon = addonNames.some(
	name => name === `${addonPrefix}.node` || (name.startsWith(`${addonPrefix}-`) && name.endsWith(".node")),
);
if (!hasPlatformAddon) {
	fail(`native cache ${nativeDir} has no addon for ${process.platform}-${process.arch}`);
}

const env: Record<string, string | undefined> = {
	...process.env,
	PI_NATIVE_DIR: nativeDir,
};
// Source mode must not inherit standalone-binary behavior from the caller.
delete env.PI_COMPILED;

const proc = Bun.spawn(
	[process.execPath, path.join(repoRoot, "packages/coding-agent/src/cli.ts"), ...process.argv.slice(2)],
	{
		cwd: repoRoot,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	},
);

process.exit(await proc.exited);
