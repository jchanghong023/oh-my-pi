#!/usr/bin/env bun
// Fork full local verification. Thin orchestration over upstream entries: the
// upstream TS static gate (check:ts; see the phase comment for why the clippy
// half of check:rs is temporarily excluded), the host native addon build, the
// fork's own TS tests (discovered from the diff against the upstream baseline —
// no hand-maintained whitelist or full upstream suite), the affected Rust crates
// through the upstream `test:rs` runner, repo script tests, and dev-TUI PTY smoke.
// Python components are not tested locally. The verdict is black and white: no
// failure exemptions. slowtest runs this gate on Windows and WSL2 before the
// build-only release CI; CI adds no tests, CLI smoke, or installer E2E coverage.
// No fork-side stage timeouts: children own their own budgets (`bun test`
// per-test limits). Only run on explicit user
// request (AGENTS.md「验证」).

import { existsSync } from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { buildChildEnv, testTimeoutMs } from "./ci-test-ts";

const repoRoot = path.resolve(import.meta.dir, "..");

export interface FulltestCommand {
	label: string;
	argv: readonly string[];
	env?: Record<string, string>;
}

export interface FulltestOptions {
	debug: boolean;
}

function isDocumentation(file: string): boolean {
	return (
		/(^|\/)(docs|docs-zh-CN)\//.test(file) ||
		/(^|\/)(README|CHANGELOG|CONTRIBUTING|AGENTS)(?:\.[^/]*)?\.md$/i.test(file)
	);
}

/** Phases in contract order; `ts/fork` is driven by {@link runForkTestsPhase}
 * (the placeholder keeps it visible in the plan). The Rust phase tests only
 * the crates the fork diff touches (test:rs --affected over
 * `changedPaths`); everything upstream in the workspace stays out of the
 * local gate except what a changed crate drags in. */
export function buildFulltestPhases(
	options: FulltestOptions,
	changedPaths: readonly string[],
): readonly FulltestCommand[] {
	return [
		// TS static only (check:ts). The clippy/fmt half of check:rs is excluded
		// while upstream's own Windows-only code fails it on the pinned nightly
		// (pi-vfs/src/native/windows.rs, clippy::map_unwrap_or under -D warnings;
		// upstream CI only lints on Linux and never sees the file). Restore the
		// static phase to `["bun", "run", "fastcheck"], env: { CI: "1" }` once
		// upstream turns green. CI=1 on the Rust phase below disables run-rs-task's
		// "skip when no Rust files changed" local-dev shortcut: fulltest is a
		// deliberate gate over a possibly clean tree.
		{ label: "static/check:ts", argv: ["bun", "run", "check:ts"] },
		{ label: "build/native", argv: ["bun", "run", "build:native"] },
		{ label: "ts/fork", argv: ["(fork-diff-set)"] },
		{
			label: "rust/affected",
			argv: ["bun", "run", "test:rs", "--affected"],
			// Only known documentation paths are ignored: arbitrary Markdown may
			// be a compile-time payload (for example pi-edit/prompts/*.md).
			env: {
				CI: "1",
				OMP_FULLTEST_CHANGED_PATHS: JSON.stringify(changedPaths.filter(file => !isDocumentation(file))),
			},
		},
		{ label: "scripts", argv: ["bun", "run", "test:scripts"] },
		{
			label: "ui/smoke",
			argv: ["bun", "scripts/fulltest-ui-smoke.ts", ...(options.debug ? ["--debug"] : [])],
		},
	];
}

function printUsage(): void {
	console.log("Usage: bun run fulltest [--debug]");
	console.log("  --debug  forward to the UI smoke phase (dump raw TUI output)");
}

export function parseFulltestArgs(args: readonly string[]): { debug: boolean } | null {
	if (args.length === 0) return { debug: false };
	if (args.every(arg => arg === "--debug")) return { debug: true };
	printUsage();
	return null;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runPhase(
	command: FulltestCommand,
	cwd: string = repoRoot,
	baseEnv: Record<string, string | undefined> = process.env,
): Promise<void> {
	console.log(`\n==> ${command.label}`);
	console.log(`(cd ${path.relative(repoRoot, cwd) || "."} && ${command.argv.map(shellQuote).join(" ")})`);
	const child = Bun.spawn([...command.argv], {
		cwd,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: command.env ? { ...baseEnv, ...command.env } : baseEnv,
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${command.label} failed with exit code ${exitCode}`);
}

/**
 * One package's fork test batch: the package directory plus the test files
 * (relative to it) that differ from the upstream baseline.
 */
export interface ForkTestBatch {
	readonly cwd: string;
	readonly files: readonly string[];
}

/**
 * Discover the fork's TS tests: every test file under a package `test/`
 * directory — or colocated under `src/`, where upstream also keeps a few —
 * that differs from the upstream baseline ref (`git diff --name-only` against
 * it plus `git ls-files --others`, so uncommitted and not-yet-staged files
 * both count). New fork tests join automatically; reverted files (identical
 * to upstream again) drop out automatically.
 */
export function resolveForkTestBatches(
	changedPaths: readonly string[],
	exists: (file: string) => boolean,
): ForkTestBatch[] {
	const testFiles = changedPaths
		.filter(changed => /^packages\/[^/]+\/(test|src)\/.+\.test\.(ts|tsx)$/.test(changed))
		.filter(exists)
		.sort();
	const byPackage = new Map<string, string[]>();
	for (const file of testFiles) {
		const separator = file.indexOf("/", "packages/".length);
		const packageName = file.slice("packages/".length, separator);
		const relative = file.slice(separator + 1);
		const batch = byPackage.get(packageName) ?? [];
		batch.push(relative);
		byPackage.set(packageName, batch);
	}
	return [...byPackage.entries()].map(([packageName, files]) => ({ cwd: `packages/${packageName}`, files }));
}

/** Choose the precise fork mirror, independent of the clone's remote name. */
export function selectUpstreamBaselineRef(refs: readonly { name: string; commit: string }[]): string {
	const local = refs.find(ref => ref.name === "refs/heads/upstream");
	if (local) return local.name;
	const mirrors = refs
		.filter(ref => /^refs\/remotes\/.+\/upstream$/.test(ref.name))
		.sort((left, right) => left.name.localeCompare(right.name));
	if (mirrors.length === 0) {
		throw new Error(
			"fulltest needs the upstream baseline (local `upstream` branch or a remote's `upstream` mirror) to discover fork tests; run the upstream sync once or create the branch.",
		);
	}
	if (mirrors.some(ref => ref.commit !== mirrors[0]!.commit)) {
		throw new Error(
			`fulltest found conflicting remote upstream baselines: ${mirrors.map(ref => ref.name).join(", ")}`,
		);
	}
	return mirrors.find(ref => ref.name === "refs/remotes/origin/upstream")?.name ?? mirrors[0]!.name;
}

async function resolveUpstreamBaselineRef(): Promise<string> {
	const result = await $`git for-each-ref --format='%(refname)%09%(objectname)' refs/heads/upstream refs/remotes`
		.cwd(repoRoot)
		.quiet()
		.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git for-each-ref failed: ${result.stderr.toString().trim()}`);
	}
	const refs = result.stdout
		.toString()
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => {
			const [name, commit] = line.trim().split("\t");
			return { name: name!, commit: commit! };
		});
	return selectUpstreamBaselineRef(refs);
}

/** Max test files per `bun test` process. Match the upstream runner's Windows
 * isolation: sharing a heap can wedge runtime/native suites there. Elsewhere,
 * bounded chunks keep native handles from accumulating across the whole suite. */
const TEST_CHUNK_SIZE = process.platform === "win32" ? 1 : 40;

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}

/** Fork-diff paths against the upstream baseline: tracked changes plus
 * untracked files, as repo-root-relative forward-slash paths. Drives both the
 * fork TS test discovery and the affected Rust crate selection. */
async function discoverForkChangedPaths(): Promise<string[]> {
	const baseline = await resolveUpstreamBaselineRef();
	// NUL delimiters preserve filenames verbatim; disabling rename detection
	// includes both changed crate paths when a file moves between crates.
	const diff = await $`git diff --no-renames --name-only -z ${baseline}`.cwd(repoRoot).quiet().nothrow();
	if (diff.exitCode !== 0) {
		throw new Error(`git diff against ${baseline} failed: ${diff.stderr.toString().trim()}`);
	}
	// `git diff` never lists untracked files; not-yet-staged new fork tests must
	// join the discovered set too, or the gate would silently skip them.
	const untracked = await $`git ls-files --others --exclude-standard -z`.cwd(repoRoot).quiet().nothrow();
	if (untracked.exitCode !== 0) {
		throw new Error(`git ls-files --others failed: ${untracked.stderr.toString().trim()}`);
	}
	return [...diff.stdout.toString().split("\0"), ...untracked.stdout.toString().split("\0")].filter(Boolean);
}

/** Run every fork test batch in bounded chunks, one `bun test` process per
 * chunk (sequential: the tests spawn subprocess-heavy fixtures and per-test
 * budgets lose to CPU contention). Any non-zero exit fails the phase. */
async function runForkTestsPhase(): Promise<void> {
	const changedPaths = await discoverForkChangedPaths();
	// Resolve existence against the repo root regardless of the caller's cwd.
	const batches = resolveForkTestBatches(changedPaths, file => existsSync(path.join(repoRoot, file)));
	if (batches.length === 0) {
		console.log("\n==> ts/fork (no changed package tests; skipped)");
		return;
	}
	const total = batches.reduce((count, batch) => count + batch.files.length, 0);
	console.log(`\n==> ts/fork (${total} fork test files across ${batches.length} packages)`);
	const childEnv = buildChildEnv();
	for (const batch of batches) {
		const chunks = chunk(batch.files, TEST_CHUNK_SIZE);
		for (const [index, files] of chunks.entries()) {
			const suffix = chunks.length > 1 ? ` chunk ${index + 1}/${chunks.length}` : "";
			await runPhase(
				{
					label: `ts/fork ${batch.cwd} (${files.length} files${suffix})`,
					argv: ["bun", "test", `--timeout=${testTimeoutMs()}`, ...files],
				},
				path.join(repoRoot, batch.cwd),
				childEnv,
			);
		}
	}
}

async function main(debug: boolean): Promise<void> {
	const platformSupported = (process.platform === "linux" || process.platform === "win32") && process.arch === "x64";
	if (!platformSupported) {
		throw new Error(`fulltest supports Windows x64 and Linux x64 (found ${process.platform}-${process.arch})`);
	}
	const changedPaths = await discoverForkChangedPaths();
	const phases = buildFulltestPhases({ debug }, changedPaths);
	console.log(`fulltest: ${phases.length} phases${debug ? " (ui-smoke debug dump on)" : ""}`);
	for (const phase of phases) {
		if (phase.label === "ts/fork") await runForkTestsPhase();
		else await runPhase(phase);
	}
}

if (import.meta.main) {
	const parsed = parseFulltestArgs(process.argv.slice(2));
	if (parsed === null) {
		process.exitCode = 2;
	} else {
		const startedAt = performance.now();
		main(parsed.debug)
			.then(() => {
				console.log(`\nfulltest: PASS`);
				console.log(`fulltest: total time ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
			})
			.catch(error => {
				console.error(`\nfulltest: FAIL — ${error instanceof Error ? error.message : String(error)}`);
				console.error(`fulltest: total time ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
				process.exitCode = 1;
			});
	}
}
