#!/usr/bin/env bun
// Full current-platform validation. No WSL, remote pipelines, publication,
// desktop input, or quality-definition changes belong in this entry point.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { removeWithRetries } from "@oh-my-pi/pi-utils/temp";
import { buildChildEnv, testTimeoutMs } from "./ci-test-ts";
import { gateRepoRoot, gatePoolWidth, fastcheckCommands } from "./fastcheck";
import { GATE_LIMIT_SECONDS, runGate, type GateCommand, type GateRun } from "./test-gate-runtime";
import { GateAbortError, GateCommandError } from "./test-gate-failure-events";
import { captureSourceIdentity, type SourceIdentity } from "./test-gate-source";
import { beginTestRun, finalizeTestRun, type TestReportRun } from "./test-reporting";
import { exitGateProcess } from "./test-gate-watchdog";
import { runGateCommands, testConcurrencyLimit } from "./test-gate-scheduler";

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
			if (!Number.isFinite(limitSeconds) || limitSeconds <= 0 || limitSeconds > GATE_LIMIT_SECONDS.fulltest)
				return null;
		} else return null;
	}
	return limitSeconds === undefined ? { debug } : { debug, limitSeconds };
}

/** Pool sizing assumes its cores are truly available to this scheduler. WSL2
 * vCPUs share the host's physical cores with the Windows side, so native pool
 * widths starve latency-sensitive PTY/CLI tests there; halve the budget on
 * WSL hosts and leave native Windows/Linux widths unchanged. */
export function gateCpuBudget(cores: number = os.availableParallelism(), release: string = os.release()): number {
	return release.toLowerCase().includes("microsoft") ? Math.max(4, Math.floor(cores / 2)) : cores;
}

/** Runtime tests use local fixtures, never the owner's live model credentials. */
export function localTestEnvironment(home: string): Record<string, string | undefined> {
	const env = buildChildEnv();
	// App execution aliases are not installed interpreters. Keep the same
	// process-only Windows PATH normalization used by the prior gate acceptance.
	if (process.platform === "win32") {
		for (const key of Object.keys(env)) {
			if (key.toUpperCase() !== "PATH" || !env[key]) continue;
			env[key] = env[key]
				.split(";")
				.filter(
					directory => !/[\\/]Microsoft[\\/]WindowsApps(?:[\\/]|$)/i.test(directory.replace(/^"(.*)"$/, "$1")),
				)
				.join(";");
		}
	}
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
		// Bun serializes fixture stdin as UTF-8; detached Windows Python must
		// not decode that protocol using the machine's legacy ANSI code page.
		PYTHONUTF8: "1",
		E2E: "",
		GITHUB_EVENT_NAME: "",
		OMP_TEST_SHARD: "",
		ROBOMP_INTEGRATION: "",
	};
}

/** Execute every project suite; only independently authorized integrations stay separate. */
export function fulltestCommands(options: FulltestOptions, home: string, sourceDigest?: string): GateCommand[] {
	const env = localTestEnvironment(home);
	return [
		{
			label: "test/TypeScript full suite",
			argv: ["bun", "scripts/ci-test-ts.ts", "local-ts", "--exclude-desktop"],
			cwd: gateRepoRoot,
			env: {
				...localTestEnvironment(path.join(home, "typescript")),
				OMP_TEST_CONCURRENCY: "all",
				OMP_FULLTEST_AFFECTED: "1",
				OMP_FULLTEST_SOURCE_DIGEST: sourceDigest,
			},
		},
		{
			label: "test/Rust full workspace",
			argv: ["bun", "scripts/run-rs-task.ts", "test:rs"],
			cwd: gateRepoRoot,
			env,
		},
		{
			label: process.platform === "win32" ? "test/Python RPC SDK" : "test/Python full suites",
			argv: ["bun", "scripts/test-report-py.ts"],
			cwd: gateRepoRoot,
			env: localTestEnvironment(path.join(home, "python")),
		},
		{
			label: "smoke/isolated dev TUI PTY",
			argv: ["bun", "scripts/test-report-ui-smoke.ts", ...(options.debug ? ["--debug"] : [])],
			cwd: gateRepoRoot,
			env,
		},
	];
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

/** Only the native producer's two tracked regular-file bindings may change content. */
function assertFulltestSourceStable(before: SourceIdentity, after: SourceIdentity, allowNativeBindings = false): void {
	const unchanged =
		before.head === after.head &&
		(allowNativeBindings
			? before.files.length === after.files.length &&
				before.files.every((file, index) => {
					const next = after.files[index];
					const generated =
						file.kind === "file" &&
						(file.path === "packages/natives/native/index.js" ||
							file.path === "packages/natives/native/index.d.ts");
					return (
						file.path === next.path &&
						file.kind === next.kind &&
						file.executable === next.executable &&
						file.link === next.link &&
						(generated || file.sha256 === next.sha256)
					);
				})
			: before.digest === after.digest);
	if (!unchanged) {
		throw new GateAbortError(
			"Source changed while preparing or running tests; result does not verify one source snapshot",
			1,
		);
	}
}

interface FulltestInfrastructure {
	captureSourceIdentity: typeof captureSourceIdentity;
	runGateCommands: typeof runGateCommands;
	fastcheckCommands: typeof fastcheckCommands;
}

const fulltestInfrastructure: FulltestInfrastructure = {
	captureSourceIdentity,
	runGateCommands,
	fastcheckCommands,
};

export async function runFulltest(
	gate: GateRun,
	options: FulltestOptions,
	infrastructure: FulltestInfrastructure = fulltestInfrastructure,
	report?: TestReportRun,
): Promise<void> {
	const started = performance.now();
	logger.info("Current platform fulltest started", {
		component: "test-gate-fulltest",
		event: "fulltest_started",
		stage: "current-platform",
		result: "started",
		platform: process.platform,
		arch: process.arch,
		scope: "full-project",
	});
	try {
		await runFulltestObserved(gate, options, infrastructure, report);
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
async function runFulltestObserved(
	gate: GateRun,
	options: FulltestOptions,
	infrastructure: FulltestInfrastructure,
	report?: TestReportRun,
): Promise<void> {
	const { captureSourceIdentity, runGateCommands, fastcheckCommands } = infrastructure;
	if (!((process.platform === "win32" || process.platform === "linux") && process.arch === "x64")) {
		throw new GateAbortError(
			`UNVERIFIED: supported local platform is Windows/Linux x64, found ${process.platform}-${process.arch}`,
			1,
		);
	}
	/** A prerequisite whose failure makes the remaining snapshot invalid. */
	const acquire = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
		try {
			return await work();
		} catch (error) {
			const failure = gate.record(error);
			console.error(`fulltest: prerequisite failed (${label}): ${failure.message}`);
			gate.fail(failure);
			throw gate.signal.reason instanceof GateCommandError ? gate.signal.reason : failure;
		}
	};
	/** A verification stage whose failure is collected while independent work continues. */
	const attempt = async (label: string, work: () => Promise<unknown>): Promise<boolean> => {
		try {
			await work();
			return true;
		} catch (error) {
			const failure = gate.record(error);
			if (gate.signal.aborted) throw gate.signal.reason instanceof GateCommandError ? gate.signal.reason : failure;
			console.error(`fulltest: stage failed (${label}): ${failure.message}`);
			return false;
		}
	};
	const before = await acquire("source identity", () => captureSourceIdentity(gate, gateRepoRoot));
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
	console.log(`platform=${process.platform}-${process.arch} bun=${Bun.version}; scope=full-project`);
	console.log(
		process.platform === "win32"
			? "coverage: TypeScript, repository script, Rust workspace/Nextest/doctest and Python RPC SDK suites (native affected selection where available); native build; dev-TUI smoke; SKIPPED: Robomp tests are unsupported on native Windows"
			: "coverage: TypeScript, repository script, Rust workspace/Nextest/doctest and Python suites (native affected selection where available); native build; dev-TUI smoke",
	);
	console.log(
		"coverage outside gates: real desktop input; live credential-backed integrations; standalone Go/Rust SDKs",
	);
	await Promise.all(
		[
			{ label: "version/Git", argv: ["git", "--version"], cwd: gateRepoRoot },
			{
				label: "version/Python",
				argv: [process.platform === "win32" ? "python" : "python3", "--version"],
				cwd: gateRepoRoot,
			},
			{ label: "version/Rust", argv: ["cargo", "--version"], cwd: gateRepoRoot, env: { RUSTUP_AUTO_INSTALL: "0" } },
		].map(command => attempt(command.label, () => gate.run(command))),
	);
	const home = await acquire("isolated test home", () => fs.mkdtemp(path.join(os.tmpdir(), "omp-fulltest-home-")));
	try {
		// Preparation is not a producer: even generated bindings must remain unchanged here.
		const beforeNative = await acquire("pre-build source identity", () => captureSourceIdentity(gate, gateRepoRoot));
		await acquire("pre-build source check", async () => assertFulltestSourceStable(before, beforeNative));
		// Native source/binding generation must finish before static/test readers.
		await attempt("native build", () =>
			runGateCommands(
				gate,
				[
					{
						label: "build/native",
						argv: ["bun", "run", "build:native"],
						cwd: gateRepoRoot,
						env: { RUSTUP_AUTO_INSTALL: "0", CROSS_TARGET: "" },
					},
				],
				{ concurrency: 1 },
			),
		);
		const afterBuild = await acquire("post-build source identity", () => captureSourceIdentity(gate, gateRepoRoot));
		await acquire("post-build source check", async () => assertFulltestSourceStable(beforeNative, afterBuild, true));
		if (report?.owner) {
			report.sourceDigest = afterBuild.digest;
			report.sourceRevision = afterBuild.head;
			report.dirtyState = afterBuild.dirty ? "dirty" : "clean";
			// The pre-build Git diff identity may no longer describe generated bindings.
			report.dirtyStateIdentity = null;
		}
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
		// Keep gate orchestration selftests isolated from the heavy suites.
		// All script files run, irrespective of the Git diff or CI environment.
		const scriptTests = new Set<string>();
		await attempt("repository script selection", async () => {
			const scriptConfig = Bun.TOML.parse(await Bun.file(path.join(gateRepoRoot, "bunfig.toml")).text()) as {
				test?: { pathIgnorePatterns?: string[] };
			};
			const ignored = (scriptConfig.test?.pathIgnorePatterns ?? []).map(pattern => new Bun.Glob(pattern));
			for (const pattern of ["**/*.{test,spec}.{js,jsx,ts,tsx}", "**/*_{test,spec}.{js,jsx,ts,tsx}"])
				for await (const file of new Bun.Glob(pattern).scan({
					cwd: path.join(gateRepoRoot, "scripts"),
					onlyFiles: true,
				})) {
					const relative = `scripts/${file.replaceAll("\\", "/")}`;
					if (!ignored.some(glob => glob.match(relative))) scriptTests.add(relative);
				}
		});
		if (scriptTests.size) {
			// These fixture-only scripts use independent temporary or in-memory state.
			// Keep every other script serial, including timing-sensitive gate selftests.
			const parallelScripts = new Set([
				"scripts/ci-release-checksums.test.ts",
				"scripts/gen-nix-bun.test.ts",
				"scripts/inline-functions.test.ts",
				"scripts/install-tests/fork-installer-routing.test.ts",
			]);
			const commands = [...scriptTests].sort().map((file, index) => ({
				label: `test/repository scripts ${file}`,
				// Use the shared hang ceiling, not bun's 5s default.
				argv: ["bun", "scripts/test-report-bun.ts", file, `--timeout=${testTimeoutMs()}`],
				cwd: gateRepoRoot,
				env: {
					...localTestEnvironment(path.join(home, "script-tests", String(index))),
					OMP_FULLTEST_AFFECTED: "1",
					OMP_FULLTEST_SOURCE_DIGEST: afterBuild.digest,
				},
				kind: "charged" as const,
			}));
			await attempt("independent repository scripts", () =>
				runGateCommands(
					gate,
					commands.filter(command => parallelScripts.has(command.argv[2]!)),
					{
						concurrency: testConcurrencyLimit(),
					},
				),
			);
			await attempt("repository scripts", () =>
				runGateCommands(
					gate,
					commands.filter(command => !parallelScripts.has(command.argv[2]!)),
					{ concurrency: 1 },
				),
			);
		} else console.error("fulltest: NOT_RUN repository script tests");
		let tests: GateCommand[] = [];
		await attempt("test plan", async () => {
			tests = fulltestCommands(options, home, afterBuild.digest);
		});
		logger.info("Fulltest command plan selected", {
			component: "test-gate-fulltest",
			event: "fulltest_plan_selected",
			stage: "test-plan",
			result: "completed",
			command_count: tests.length,
			concurrent_fastcheck: true,
			scope: "full-project",
		});
		await attempt("test homes", async () => {
			for (const command of tests)
				if (command.env?.HOME) await gate.charged(() => fs.mkdir(command.env!.HOME!, { recursive: true }));
		});
		// Rust tests need only wait for the Cargo static lane, not unrelated TS checks.
		const rustChecksFinished = Promise.withResolvers<void>();
		const cpuBudget = gateCpuBudget();
		const concurrency = gatePoolWidth(cpuBudget, 4, 4);
		const staticRun = (async () => {
			try {
				await attempt("static checks", () =>
					gate.childGate("fastcheck", async child => {
						const checks = (await child.charged(fastcheckCommands)).map(command =>
							command.label.startsWith("static/Rust")
								? { ...command, env: { ...localTestEnvironment(home), ...command.env } }
								: command,
						);
						if (!checks.length) console.error("fulltest: NOT_RUN static checks");
						let remainingRustChecks = checks.filter(command => command.label.startsWith("static/Rust")).length;
						if (!remainingRustChecks) rustChecksFinished.resolve();
						await runGateCommands(child, checks, {
							concurrency: 2,
							onCommandSettled: command => {
								if (command.label.startsWith("static/Rust") && --remainingRustChecks === 0)
									rustChecksFinished.resolve();
							},
						});
					}),
				);
			} finally {
				// Also release on selection failure or cancellation before a Rust check starts.
				rustChecksFinished.resolve();
			}
		})();
		const otherTests = tests.filter(command => !command.label.startsWith("test/Rust"));
		const rustTests = tests.filter(command => command.label.startsWith("test/Rust"));
		const testRun = attempt("non-Rust tests", () =>
			runGateCommands(gate, otherTests, { concurrency: concurrency - 1 }),
		);
		const rustRun = (async () => {
			await rustChecksFinished.promise;
			await attempt("Rust tests", () => runGateCommands(gate, rustTests, { concurrency: 1 }));
		})();
		await Promise.all([staticRun, testRun, rustRun]);
		const after = await acquire("post-test source identity", () => captureSourceIdentity(gate, gateRepoRoot));
		logger.info("Fulltest source stability resolved", {
			component: "test-gate-fulltest",
			event: "fulltest_source_identity",
			stage: "source-after-tests",
			result: after.digest === afterBuild.digest && after.head === afterBuild.head ? "unchanged" : "changed",
			head: after.head,
			dirty: after.dirty,
			source_fingerprint: after.digest,
		});
		await acquire("post-test source check", async () => assertFulltestSourceStable(afterBuild, after));
	} catch (error) {
		// Record the triggering failure before cleanup can report its own error.
		throw gate.record(error);
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
			gate.record(error);
		}
	}
}

if (import.meta.main) {
	const options = parseFulltestArgs(process.argv.slice(2));
	const result = await runGate(
		"fulltest",
		async gate => {
			if (!options)
				throw new GateCommandError(
					`Usage: bun run fulltest [--debug] [--limit-seconds=<seconds <= ${GATE_LIMIT_SECONDS.fulltest}>]`,
					2,
				);
			const run = await gate.charged(() => beginTestRun("fulltest: full current-platform project suites"));
			finalizeTestRun(gate, run);
			await runFulltest(gate, options, fulltestInfrastructure, run);
		},
		{ limitSeconds: options?.limitSeconds, reportFailure: true, exitOnFailure: true, failureOnlyOutput: true },
	);
	exitGateProcess(result.exitCode);
}
