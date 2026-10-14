#!/usr/bin/env bun
// Full current-platform validation. No WSL, remote pipelines, publication,
// desktop input, or quality-definition changes belong in this entry point.
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { removeWithRetries } from "@oh-my-pi/pi-utils/temp";
import { buildChildEnv, testTimeoutMs } from "./ci-test-ts";
import { gateRepoRoot, gatePoolWidth, runFastcheck, runGateCommands } from "./fastcheck";
import { GateCommandError, runGate, type GateCommand, type GateRun } from "./test-gate-runtime";
import { captureSourceIdentity } from "./test-gate-source";
import { beginTestRun, finalizeTestRun } from "./test-reporting";

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
	const env = buildChildEnv();
	// GateRun overlays command environments on the host environment. Preserve
	// the shared scrubber's deletions so that overlay cannot restore credentials.
	for (const key of Object.keys(process.env)) {
		if (!(key in env)) env[key] = undefined;
	}
	return {
		...env,
		HOME: home,
		USERPROFILE: home,
		// Ignore host profile/root selectors; children may explicitly select fixtures.
		OMP_CONFIG_ROOT: "",
		PI_CODING_AGENT_DIR: "",
		OMP_PROFILE: undefined,
		PI_PROFILE: undefined,
		PI_CONFIG_DIR: "",
		XDG_DATA_HOME: "",
		XDG_STATE_HOME: "",
		XDG_CACHE_HOME: "",
		// Empty XDG_CACHE_HOME must not put Bun's transpiler cache in the source tree.
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(gateRepoRoot, "node_modules", ".cache", "bun-transpiler"),
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
	logger.info("Fork test scope selected", {
		component: "test-gate-fulltest",
		event: "fulltest_scope_selected",
		stage: "scope",
		result: "completed",
		scope: "fork-affected",
		baseline,
		selection: "user-requested-prior-scope",
		changed_path_count: paths.length,
	});
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
			argv: [
				"bun",
				"../../scripts/test-report-bun.ts",
				"--bail=1",
				`--timeout=${testTimeoutMs()}`,
				file.slice(separator + 1),
			],
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
		{
			label: "smoke/isolated dev TUI PTY",
			argv: ["bun", "scripts/test-report-ui-smoke.ts", ...(options.debug ? ["--debug"] : [])],
			cwd: root,
			env,
		},
	);
	return commands;
}

/** Detach Windows directory junctions without reading their denied ACLs or targets. */
export async function removeFulltestHome(home: string): Promise<void> {
	if (process.platform === "win32") {
		const detachJunctions = async (directory: string): Promise<void> => {
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				const target = path.join(directory, entry.name);
				if (entry.isSymbolicLink()) {
					try {
						await fs.rmdir(target);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
						await fs.unlink(target);
					}
				} else if (entry.isDirectory()) {
					await detachJunctions(target);
				}
			}
		};
		await detachJunctions(home);
	}
	await removeWithRetries(home);
}

export async function runFulltest(gate: GateRun, options: FulltestOptions): Promise<void> {
	const started = performance.now();
	logger.info("Current platform fulltest started", {
		component: "test-gate-fulltest",
		event: "fulltest_started",
		stage: "current-platform",
		result: "started",
		platform: process.platform,
		arch: process.arch,
		scope: "fork-affected",
	});
	try {
		await runFulltestObserved(gate, options);
		logger.info("Current platform fulltest completed", {
			component: "test-gate-fulltest",
			event: "fulltest_settled",
			stage: "current-platform",
			result: "completed",
			elapsed_ms: performance.now() - started,
		});
	} catch (error) {
		const cancelled =
			gate.signal.aborted &&
			gate.signal.reason instanceof GateCommandError &&
			gate.signal.reason.status === "INTERRUPTED";
		(cancelled ? logger.info : logger.error)("Current platform fulltest failed", {
			component: "test-gate-fulltest",
			event: "fulltest_settled",
			stage: "current-platform",
			result: cancelled ? "cancelled" : "failed",
			elapsed_ms: performance.now() - started,
			status: error instanceof GateCommandError ? error.status : "FAIL",
			...logger.diagnosticError(error),
		});
		throw error;
	}
}
async function runFulltestObserved(gate: GateRun, options: FulltestOptions): Promise<void> {
	if (!((process.platform === "win32" || process.platform === "linux") && process.arch === "x64")) {
		throw new GateCommandError(
			`UNVERIFIED: supported local platform is Windows/Linux x64, found ${process.platform}-${process.arch}`,
			1,
		);
	}
	const before = await captureSourceIdentity(gate, gateRepoRoot);
	logger.info("Fulltest source identity resolved", {
		component: "test-gate-fulltest",
		event: "fulltest_source_identity",
		stage: "source-before",
		result: "completed",
		head: before.head,
		dirty: before.dirty,
		source_fingerprint: before.digest,
		bun_version: Bun.version,
	});
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
		logger.info("Fulltest command plan selected", {
			component: "test-gate-fulltest",
			event: "fulltest_plan_selected",
			stage: "test-plan",
			result: "completed",
			command_count: tests.length,
			concurrent_fastcheck: true,
			scope: "fork-affected",
		});
		for (const command of tests) {
			if (command.env?.HOME) await gate.charged(() => fs.mkdir(command.env!.HOME!, { recursive: true }));
		}
		const afterBuild = await captureSourceIdentity(gate, gateRepoRoot);
		logger.info("Fulltest post-build source identity resolved", {
			component: "test-gate-fulltest",
			event: "fulltest_source_identity",
			stage: "source-after-build",
			result: "completed",
			head: afterBuild.head,
			dirty: afterBuild.dirty,
			source_fingerprint: afterBuild.digest,
		});
		console.log(
			`source tested after builds: HEAD=${afterBuild.head} dirty=${afterBuild.dirty} digest=${afterBuild.digest}`,
		);
		// Share one bounded command budget instead of opening two full pools.
		// Reserve one live test worker; release the other slots after the strict
		// fastcheck gate settles. Each side still runs independent work in
		// parallel: per-file tests spread wide, multithreaded static checks
		// (tsgo/clippy) keep their narrower pool so they do not thrash.
		const concurrency = gatePoolWidth();
		const fastcheck = gate.childGate("fastcheck", child => runFastcheck(child, gatePoolWidth(undefined, 3, 12)));
		const results = await Promise.allSettled([fastcheck, runGateCommands(gate, tests, concurrency, fastcheck)]);
		for (const result of results) if (result.status === "rejected") throw result.reason;
		// Runtime mechanism selftests use short injected charged budgets. Run
		// them after process-heavy tests, rather than racing their stub startup
		// against nextest and CLI/PTY subprocess storms on the same platform.
		await gate.charged(() =>
			gate.run({
				label: "test/repository scripts",
				argv: ["bun", "run", "test:scripts", "--bail=1"],
				cwd: gateRepoRoot,
				env: localTestEnvironment(home),
				kind: "charged",
			}),
		);
		const after = await captureSourceIdentity(gate, gateRepoRoot);
		logger.info("Fulltest source stability resolved", {
			component: "test-gate-fulltest",
			event: "fulltest_source_identity",
			stage: "source-after-tests",
			result: after.digest === afterBuild.digest && after.head === afterBuild.head ? "unchanged" : "changed",
			head: after.head,
			dirty: after.dirty,
			source_fingerprint: after.digest,
		});
		if (after.digest !== afterBuild.digest || after.head !== afterBuild.head) {
			throw new GateCommandError(
				"Source changed while tests were running; result does not verify one source snapshot",
				1,
			);
		}
	} catch (error) {
		// Record the triggering failure before cleanup can report its own error.
		throw gate.fail(error);
	} finally {
		const cleanupStarted = performance.now();
		logger.info("Fulltest isolated home cleanup started", {
			component: "test-gate-fulltest",
			event: "fulltest_home_cleanup_started",
			stage: "isolated-home-cleanup",
			result: "started",
		});
		try {
			await gate.charged(() => removeFulltestHome(home));
			logger.info("Fulltest isolated home cleanup completed", {
				component: "test-gate-fulltest",
				event: "fulltest_home_cleanup_settled",
				stage: "isolated-home-cleanup",
				result: "completed",
				elapsed_ms: performance.now() - cleanupStarted,
			});
		} catch (error) {
			logger.error("Fulltest isolated home cleanup failed", {
				component: "test-gate-fulltest",
				event: "fulltest_home_cleanup_settled",
				stage: "isolated-home-cleanup",
				result: "failed",
				elapsed_ms: performance.now() - cleanupStarted,
				...logger.diagnosticError(error),
			});
			throw gate.fail(error);
		}
	}
}

if (import.meta.main) {
	const options = parseFulltestArgs(process.argv.slice(2));
	const result = await runGate(
		"fulltest",
		async gate => {
			if (!options)
				throw new GateCommandError("Usage: bun run fulltest [--debug] [--limit-seconds=<seconds <= 900>]", 2);
			const run = await gate.charged(() => beginTestRun("fulltest: fork-affected current-platform tests"));
			finalizeTestRun(gate, run);
			await runFulltest(gate, options);
		},
		{ limitSeconds: options?.limitSeconds, reportFailure: true },
	);
	process.exitCode = result.exitCode;
}
