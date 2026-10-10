#!/usr/bin/env bun
// Full current-platform validation. No WSL, remote pipelines, publication,
// desktop input, or quality-definition changes belong in this entry point.
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildEnv, testTimeoutMs } from "./ci-test-ts";
import { gateRepoRoot, runFastcheck, runGateCommands } from "./fastcheck";
import { GateCommandError, runGate, type GateCommand, type GateRun } from "./test-gate-runtime";
import { captureSourceIdentity } from "./test-gate-source";

export interface FulltestOptions {
	debug: boolean;
	limitSeconds?: number;
}

export function parseFulltestArgs(args: readonly string[]): FulltestOptions | null {
	let debug = false;
	let limitSeconds: number | undefined;
	for (const arg of args) {
		if (arg === "--debug") debug = true;
		else if (arg.startsWith("--limit-seconds=") && limitSeconds === undefined) {
			limitSeconds = Number(arg.slice("--limit-seconds=".length));
			if (!Number.isFinite(limitSeconds) || limitSeconds <= 0 || limitSeconds > 900) return null;
		} else return null;
	}
	return limitSeconds === undefined ? { debug } : { debug, limitSeconds };
}

/** Runtime tests use local fixtures, never the owner's live model credentials. */
export function localTestEnvironment(home: string): Record<string, string | undefined> {
	return {
		...buildChildEnv(),
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: path.join(home, ".omp"),
		// Toolchain caches retain their normal per-platform locations despite the
		// isolated application HOME. These are not fresh build/cache variants.
		CARGO_HOME: process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"),
		RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), ".rustup"),
		RUSTUP_AUTO_INSTALL: "0",
		E2E: "",
		GITHUB_EVENT_NAME: "",
		OMP_TEST_SHARD: "",
		ROBOMP_INTEGRATION: "",
	};
}

/** Use the complete fork delta, including new unstaged tests, as before. */
async function discoverForkChangedPaths(gate: GateRun): Promise<string[]> {
	const requirements = await Bun.file(path.join(gateRepoRoot, "docs-zh-CN/requirements/fork.md")).text();
	const baseline = requirements.match(/\*\*Upstream commit\*\*：`([0-9a-f]{40})`/)?.[1];
	if (!baseline) throw new GateCommandError("Fork requirements do not identify the upstream baseline", 1);
	const diff = await gate.capture({
		label: "scope/complete fork delta",
		argv: ["git", "diff", "--no-renames", "--name-only", "-z", baseline],
		cwd: gateRepoRoot,
	});
	const untracked = await gate.capture({
		label: "scope/untracked fork files",
		argv: ["git", "ls-files", "--others", "--exclude-standard", "-z"],
		cwd: gateRepoRoot,
	});
	const paths = [...new Set([...diff.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))].sort();
	console.log(`scope=fork-affected baseline=${baseline} selection=user-requested-prior-scope`);
	console.log(
		"coverage: existing TS/Rust static checks; fork TS tests; affected Rust crates; repository scripts; native build; dev-TUI smoke",
	);
	console.log(
		"omitted: full upstream TS suite; Python and standalone SDK checks/tests; unrelated workspace/package builds",
	);
	return paths;
}

function isDocumentation(file: string): boolean {
	return (
		/(^|\/)(docs|docs-zh-CN)\//.test(file) ||
		/(^|\/)(README|CHANGELOG|CONTRIBUTING|AGENTS)(?:\.[^/]*)?\.md$/i.test(file)
	);
}

/** Preserve the earlier fork-test range and the existing runner's test budgets. */
export function fulltestCommands(
	options: FulltestOptions,
	home: string,
	changedPaths: readonly string[],
): GateCommand[] {
	const env = localTestEnvironment(home);
	const root = gateRepoRoot;
	const commands: GateCommand[] = [];
	for (const file of changedPaths) {
		if (!/^packages\/[^/]+\/(test|src)\/.+\.test\.(ts|tsx)$/.test(file) || !existsSync(path.join(root, file)))
			continue;
		if (file === "packages/natives/test/desktop.test.ts") {
			console.log(`NOT_RUN_SEPARATE_USER_INSTRUCTION_REQUIRED: ${file}`);
			continue;
		}
		const separator = file.indexOf("/", "packages/".length);
		const packageRoot = file.slice(0, separator);
		const testHome = path.join(home, "fork-tests", String(commands.length));
		commands.push({
			label: `test/fork ${file}`,
			argv: ["bun", "test", `--timeout=${testTimeoutMs()}`, file.slice(separator + 1)],
			cwd: path.join(root, packageRoot),
			env: localTestEnvironment(testHome),
		});
	}
	console.log(`fork TS test files=${commands.length}; changed Rust paths drive the existing --affected runner`);
	commands.push(
		{
			label: "test/Rust affected crates",
			argv: ["bun", "run", "test:rs", "--affected"],
			cwd: root,
			env: {
				...env,
				CI: "1",
				OMP_FULLTEST_CHANGED_PATHS: JSON.stringify(changedPaths.filter(file => !isDocumentation(file))),
			},
		},
		{ label: "test/repository scripts", argv: ["bun", "run", "test:scripts"], cwd: root, env, kind: "charged" },
		{
			label: "smoke/isolated dev TUI PTY",
			argv: ["bun", "scripts/fulltest-ui-smoke.ts", ...(options.debug ? ["--debug"] : [])],
			cwd: root,
			env,
		},
	);
	return commands;
}

export async function runFulltest(gate: GateRun, options: FulltestOptions): Promise<void> {
	if (!((process.platform === "win32" || process.platform === "linux") && process.arch === "x64")) {
		throw new GateCommandError(
			`UNVERIFIED: supported local platform is Windows/Linux x64, found ${process.platform}-${process.arch}`,
			1,
		);
	}
	const before = await captureSourceIdentity(gate, gateRepoRoot);
	console.log(`source: HEAD=${before.head} dirty=${before.dirty} digest=${before.digest}`);
	if (before.dirty) console.log(`source: uncommitted summary\n${before.status.trimEnd()}`);
	console.log(`platform=${process.platform}-${process.arch} bun=${Bun.version}; scope=fork-affected`);
	console.log("coverage outside gates: real desktop input; live credential-backed model/gateway integration");
	const changedPaths = await discoverForkChangedPaths(gate);
	await runGateCommands(gate, [
		{ label: "version/Git", argv: ["git", "--version"], cwd: gateRepoRoot },
		{
			label: "version/Python",
			argv: [process.platform === "win32" ? "python" : "python3", "--version"],
			cwd: gateRepoRoot,
		},
		{ label: "version/Rust", argv: ["cargo", "--version"], cwd: gateRepoRoot, env: { RUSTUP_AUTO_INSTALL: "0" } },
	]);
	const home = await gate.charged(() => fs.mkdtemp(path.join(os.tmpdir(), "omp-fulltest-home-")));
	try {
		// Native source/binding generation must finish before static/test readers.
		await gate.run({
			label: "build/native",
			argv: ["bun", "run", "build:native"],
			cwd: gateRepoRoot,
			env: { RUSTUP_AUTO_INSTALL: "0", CROSS_TARGET: "" },
		});
		const tests = fulltestCommands(options, home, changedPaths);
		for (const command of tests) {
			if (command.env?.HOME) await gate.charged(() => fs.mkdir(command.env!.HOME!, { recursive: true }));
		}
		const afterBuild = await captureSourceIdentity(gate, gateRepoRoot);
		console.log(
			`source tested after builds: HEAD=${afterBuild.head} dirty=${afterBuild.dirty} digest=${afterBuild.digest}`,
		);
		const results = await Promise.allSettled([
			gate.childGate("fastcheck", runFastcheck),
			runGateCommands(gate, tests),
		]);
		for (const result of results) if (result.status === "rejected") throw result.reason;
		const after = await captureSourceIdentity(gate, gateRepoRoot);
		if (after.digest !== afterBuild.digest || after.head !== afterBuild.head) {
			throw new GateCommandError(
				"Source changed while tests were running; result does not verify one source snapshot",
				1,
			);
		}
	} finally {
		await gate.charged(() => fs.rm(home, { recursive: true, force: true }));
	}
}

if (import.meta.main) {
	const options = parseFulltestArgs(process.argv.slice(2));
	const result = await runGate(
		"fulltest",
		async gate => {
			if (!options)
				throw new GateCommandError("Usage: bun run fulltest [--debug] [--limit-seconds=<seconds <= 900>]", 2);
			await runFulltest(gate, options);
		},
		options ? { limitSeconds: options.limitSeconds } : {},
	);
	process.exitCode = result.exitCode;
}
