#!/usr/bin/env bun
/** Fast local check for changed TypeScript files. */
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");

/** Use Biome's static musl binary on Linux hosts that may have an older glibc. */
async function resolveBiomeEnv(): Promise<Record<string, string>> {
	if (process.platform !== "linux") return {};
	const muslPath = path.join(repoRoot, "node_modules/@biomejs/cli-linux-x64-musl/biome");
	return (await Bun.file(muslPath).exists()) ? { BIOME_BINARY: muslPath } : {};
}

function isTsFile(file: string): boolean {
	return file.endsWith(".ts") || file.endsWith(".tsx");
}

function isExcludedTsPath(file: string): boolean {
	const normalized = file.replace(/\\/g, "/");
	return (
		normalized.includes("node_modules/") ||
		normalized.includes("vendor/") ||
		normalized.endsWith("test-sessions.ts") ||
		normalized.endsWith("agent_pb.ts") ||
		normalized.includes("devin-gen/") ||
		normalized === "packages/natives/native/index.d.ts" ||
		normalized === "packages/catalog/src/discovery/cursor-proto.ts" ||
		normalized === "packages/catalog/src/discovery/devin-proto.ts" ||
		normalized.startsWith(".worktrees/") ||
		normalized.startsWith(".wt/") ||
		normalized.startsWith(".git/")
	);
}

function parsePorcelain(buffer: Uint8Array): string[] {
	const entries = new TextDecoder().decode(buffer).split("\0").filter(Boolean);
	const files: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		files.push(entry.slice(3));
		if (status.includes("R") || status.includes("C")) {
			const previousPath = entries[index + 1];
			if (previousPath) files.push(previousPath);
			index++;
		}
	}
	return files;
}

async function resolveBaseRef(): Promise<string | null> {
	for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
		const result = await $`git rev-parse --verify ${candidate}`.cwd(repoRoot).quiet().nothrow();
		if (result.exitCode === 0) return candidate;
	}
	return null;
}

async function getChangedTsFiles(): Promise<string[]> {
	const changed = new Set<string>();
	const status = await $`git status --porcelain -z`.cwd(repoRoot).quiet().nothrow();
	if (status.exitCode !== 0) throw new Error(status.stderr.toString().trim() || "git status failed");
	for (const file of parsePorcelain(status.stdout)) changed.add(file);

	const baseRef = await resolveBaseRef();
	if (baseRef) {
		const diff = await $`git diff --name-only -z ${baseRef}...HEAD`.cwd(repoRoot).quiet().nothrow();
		if (diff.exitCode !== 0) throw new Error(diff.stderr.toString().trim() || `git diff against ${baseRef} failed`);
		for (const file of new TextDecoder().decode(diff.stdout).split("\0")) {
			if (file) changed.add(file);
		}
	}

	const files = [...changed].filter(file => isTsFile(file) && !isExcludedTsPath(file));
	const existing = await Promise.all(
		files.map(async file => ({ file, exists: await Bun.file(path.join(repoRoot, file)).exists() })),
	);
	return existing
		.filter(({ exists }) => exists)
		.map(({ file }) => file)
		.sort();
}

async function main(): Promise<void> {
	const files = await getChangedTsFiles();
	if (files.length === 0) {
		console.log("FASTCHECK SKIPPED: no changed TypeScript files");
		return;
	}

	console.log(`FASTCHECK: checking ${files.length} changed TypeScript file(s)`);
	const child = Bun.spawn([process.execPath, "x", "@biomejs/biome", "check", "--no-errors-on-unmatched", ...files], {
		cwd: repoRoot,
		env: { ...Bun.env, ...(await resolveBiomeEnv()) },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) process.exit(exitCode);
	console.log("FASTCHECK PASSED");
}

await main();
