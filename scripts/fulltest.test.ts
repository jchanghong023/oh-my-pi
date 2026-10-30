import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testTimeoutMs } from "./ci-test-ts";
import { parseFastcheckArgs, gatePoolWidth } from "./fastcheck";
import {
	fulltestCommands,
	gateCpuBudget,
	parseFulltestArgs,
	removeFulltestHome,
	runFulltest,
	selectChangedScriptTests,
} from "./fulltest";
import { runGate, GATE_LIMIT_SECONDS, type GateRun } from "./test-gate-runtime";
import { captureChangedPaths, classifyFulltestChanges, type SourceIdentity } from "./test-gate-source";
import type { TestReportRun } from "./test-reporting";
import { runGateCommands } from "./test-gate-scheduler";

test("fork plan excludes standalone Python suites while preserving the public TUI smoke", () => {
	const commands = fulltestCommands({ debug: false }, "/tmp/home", "digest");
	expect(commands.map(command => command.label)).toEqual([
		"test/TypeScript fork feature suite",
		"test/TypeScript startup suite",
		"test/Rust fork features",
		"smoke/isolated dev TUI PTY",
	]);
	expect(commands.flatMap(command => command.argv)).not.toContain("scripts/test-report-py.ts");
});

test("script selection uses changed modules and existing tests, not business files or a clean tree", () => {
	const files = [
		"scripts/fulltest.test.ts",
		"scripts/ci-test-ts.test.ts",
		"scripts/test-reporting.test.ts",
		"scripts/release.test.ts",
	];
	expect(selectChangedScriptTests([], files)).toEqual([]);
	expect(
		selectChangedScriptTests(["packages/natives/src/lib.rs", "packages/coding-agent/src/index.ts"], files),
	).toEqual([]);
	expect(selectChangedScriptTests(["scripts/fulltest.ts", "scripts/test-reporting.ts"], files)).toEqual([
		"scripts/ci-test-ts.test.ts",
		"scripts/fulltest.test.ts",
		"scripts/test-reporting.test.ts",
	]);
	expect(selectChangedScriptTests(["scripts/release.test.ts", "scripts/unknown.ts"], files)).toEqual([
		"scripts/release.test.ts",
	]);
});

test("affected boundary retains Rust for unknown inputs and UI for CLI and Repo changes", () => {
	expect(classifyFulltestChanges([])).toEqual({ bun: false, rust: false, ui: false });
	expect(
		classifyFulltestChanges(["packages/coding-agent/src/tools/wiki.ts", "packages/coding-agent/src/repo/files.ts"]),
	).toEqual({ bun: false, rust: false, ui: true });
	for (const file of [
		"Cargo.lock",
		"packages/natives/src/lib.rs",
		"packages/coding-agent/src/config/settings.ts",
		"packages/coding-agent/src/generated/bindings.ts",
		"packages/coding-agent/test/fixtures/input.ts",
		"scripts/build.ts",
		"bun.lock",
	]) {
		expect(classifyFulltestChanges([file])).toEqual({ bun: true, rust: true, ui: true });
	}
});

test("fulltest applies one baseline to both TS lanes and omits only unaffected independent stages", async () => {
	const baseline = "a".repeat(40);
	const identity: SourceIdentity = { head: baseline, digest: "digest", dirty: true, status: "", files: [] };
	const gate = {
		signal: new AbortController().signal,
		charged: async <T>(work: () => T | Promise<T>) => work(),
		run: async () => {},
		childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
		record: (error: unknown) => error,
		fail: (error: unknown) => error,
	} as unknown as GateRun;
	for (const [changed, full, expectRust] of [
		[["packages/coding-agent/src/tools/wiki.ts", "packages/coding-agent/src/repo/files.ts"], false, false],
		[["Cargo.lock"], false, true],
		[["packages/coding-agent/src/tools/wiki.ts"], true, true],
	] as const) {
		const commands: { label: string; env?: Record<string, string | undefined> }[] = [];
		let observedBase: string | undefined;
		await runFulltest(
			gate,
			{ debug: false, full },
			{
				captureSourceIdentity: async () => identity,
				captureChangedPaths: async (_gate, _root, base) => {
					observedBase = base;
					return [...changed];
				},
				bunTestSelection: async () => ({ tool: "bun", mode: "affected", baseline }),
				fastcheckCommands: async () => [],
				runGateCommands: async (_gate, selected) => {
					commands.push(...selected);
				},
			},
		);
		expect(observedBase).toBe(full ? "HEAD" : baseline);
		expect(commands.some(command => command.label.startsWith("test/Rust"))).toBe(expectRust);
		expect(commands.some(command => command.label === "smoke/isolated dev TUI PTY")).toBe(true);
		const ts = commands.filter(command => command.label.startsWith("test/TypeScript"));
		expect(ts).toHaveLength(2);
		expect(ts.map(command => command.env?.OMP_FULLTEST_BASELINE)).toEqual(
			full || expectRust ? ["none", "none"] : [baseline, baseline],
		);
	}
});

test("changed paths include staged, deleted, rename sides and untracked paths", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fulltest-changes-"));
	const git = async (...args: string[]) => {
		const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		return stdout;
	};
	const gate = {
		charged: async <T>(operation: () => T | Promise<T>) => operation(),
		capture: async ({ argv }: { argv: string[] }) => ({ stdout: await git(...argv.slice(1)) }),
	} as unknown as GateRun;
	try {
		await git("init", "-q");
		await git("config", "user.email", "fixture@example.invalid");
		await git("config", "user.name", "Fixture");
		await fs.mkdir(path.join(root, "scripts"));
		for (const name of ["old.ts", "deleted.ts", "staged.ts"])
			await fs.writeFile(path.join(root, "scripts", name), "original\n");
		await git("add", ".");
		await git("commit", "-qm", "baseline");
		const baseline = (await git("rev-parse", "HEAD")).trim();
		await fs.writeFile(path.join(root, "scripts", "committed.ts"), "committed\n");
		await git("add", "scripts/committed.ts");
		await git("commit", "-qm", "later unverified commit");
		expect(await captureChangedPaths(gate, root)).toEqual([]);
		await git("mv", "scripts/old.ts", "scripts/new.ts");
		await fs.rm(path.join(root, "scripts", "deleted.ts"));
		await fs.writeFile(path.join(root, "scripts", "staged.ts"), "staged\n");
		await git("add", "scripts/staged.ts");
		await fs.writeFile(path.join(root, "scripts", "staged.ts"), "original\n");
		await fs.writeFile(path.join(root, "scripts", "untracked.ts"), "new\n");
		expect(await captureChangedPaths(gate, root)).toEqual([
			"scripts/deleted.ts",
			"scripts/new.ts",
			"scripts/old.ts",
			"scripts/staged.ts",
			"scripts/untracked.ts",
		]);
		expect(await captureChangedPaths(gate, root, baseline)).toEqual([
			"scripts/committed.ts",
			"scripts/deleted.ts",
			"scripts/new.ts",
			"scripts/old.ts",
			"scripts/staged.ts",
			"scripts/untracked.ts",
		]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("direct scheduler overlaps commands and continues after a failure", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gate-scheduler-"));
	try {
		const script = path.join(directory, "worker.ts");
		const settled: string[] = [];
		await fs.writeFile(
			script,
			`
import * as fs from "node:fs/promises";
import * as path from "node:path";
const [dir, role] = process.argv.slice(2);
await fs.writeFile(path.join(dir, role), "started");
if (role !== "later") {
  const other = path.join(dir, role === "first" ? "second" : "first");
  const deadline = Date.now() + 5000;
  while (!(await fs.stat(other).catch(() => null))) {
    if (Date.now() > deadline) process.exit(90);
    await Bun.sleep(20);
  }
}
if (role === "first") process.exit(17);
if (role === "second") {
  const deadline = Date.now() + 5000;
  while (!(await fs.stat(path.join(dir, "later")).catch(() => null))) {
    if (Date.now() > deadline) process.exit(91);
    await Bun.sleep(20);
  }
}
`,
		);
		const result = await runGate("fulltest", gate =>
			runGateCommands(
				gate,
				["first", "second", "later"].map(role => ({
					label: role,
					argv: [process.execPath, script, directory, role],
				})),
				{ concurrency: 2, onCommandSettled: command => settled.push(command.label) },
			),
		);
		expect(result.exitCode).toBe(17);
		expect(settled.sort()).toEqual(["first", "later", "second"]);
		expect(await fs.readFile(path.join(directory, "second"), "utf8")).toBe("started");
		expect(await fs.readFile(path.join(directory, "later"), "utf8")).toBe("started");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 20_000);

test("fulltest reaches its CLI error boundary without loading the native addon", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fulltest-bootstrap-"));
	const tsconfig = path.join(directory, "tsconfig.json");
	try {
		// Copy only the real JS loader and its pure dependencies, never an addon.
		// Route the root native import here without changing the working tree.
		await fs.mkdir(path.join(directory, "native"));
		for (const file of [
			"package.json",
			"native/index.js",
			"native/loader-state.js",
			"native/desktop-adapter.js",
			"native/embedded-addon.js",
			"native/offline-root.js",
			"native/version-sentinel.js",
		]) {
			await fs.copyFile(path.join(import.meta.dir, "..", "packages", "natives", file), path.join(directory, file));
		}
		await fs.writeFile(
			tsconfig,
			JSON.stringify({
				compilerOptions: {
					baseUrl: directory,
					paths: { "@oh-my-pi/pi-natives": ["./native/index.js"] },
				},
			}),
		);
		const env = {
			...process.env,
			OMP_CONFIG_ROOT: path.join(directory, "config"),
			PI_NATIVES_DIR: path.join(directory, "addon-cache"),
			OMP_OFFLINE: "",
			NODE_PATH: "",
			// This deliberately invalid invocation must not fail the enclosing gate.
			OMP_GATE_EVENT_TOKEN: "",
			OMP_GATE_EVENT_FILE: "",
			OMP_GATE_CLOCK_TOKEN: "",
		};
		const options = { cwd: path.join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" } as const;
		// The same resolver must make a direct import fail in the actual loader.
		const control = Bun.spawn(
			[process.execPath, "--tsconfig-override", tsconfig, "-e", 'import "@oh-my-pi/pi-natives";'],
			options,
		);
		const [controlExit, , controlError] = await Promise.all([
			control.exited,
			new Response(control.stdout).text(),
			new Response(control.stderr).text(),
		]);
		expect(controlExit).not.toBe(0);
		expect(controlError).toContain("Failed to load pi_natives native addon");
		expect(controlError).toContain(directory);
		const child = Bun.spawn(
			[process.execPath, "--tsconfig-override", tsconfig, path.join(import.meta.dir, "fulltest.ts"), "--unknown"],
			options,
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(2);
		expect(stdout).toContain("Usage: bun run fulltest");
		expect(stdout).toMatch(
			/fulltest: FAIL total=\d+\.\ds compile_excluded=\d+\.\ds budgeted=\d+\.\ds limit=1800\.0s exit=2/,
		);
		expect(stderr).not.toContain("Failed to load pi_natives native addon");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 20_000);

describe("shared per-test budget", () => {
	test("converts valid second overrides to Bun's millisecond budget", () => {
		expect(testTimeoutMs(" 2.5 ")).toBe(2500);
		expect(testTimeoutMs("1")).toBe(1000);
	});

	test("invalid overrides preserve the upstream hang ceiling", () => {
		expect(testTimeoutMs("0.5")).toBe(30_000);
		expect(testTimeoutMs("invalid")).toBe(30_000);
	});
});

describe("fulltest source snapshot checkpoints", () => {
	const sourcePath = "packages/metaharness/adapters/edit/runner.test.ts";
	const generatedPaths = ["packages/natives/native/index.js", "packages/natives/native/index.d.ts"];

	async function exercise(
		change: "source" | "new-test" | "head" | "bindings" | "binding-mode",
		interval: "preparation" | "native" | "scripts" | "tests",
	) {
		let identity: SourceIdentity = {
			head: "initial-head",
			digest: "initial-digest",
			dirty: false,
			status: "",
			files: [sourcePath, ...generatedPaths, "scripts/fulltest.test.ts"]
				.filter(file => change !== "new-test" || file !== sourcePath)
				.map(file => ({
					path: file,
					kind: "file",
					sha256: "initial",
					executable: false,
				})),
		};
		let mutated = false;
		let testsRun = false;
		let scriptEnv: Record<string, string | undefined> | undefined;
		let tsAffected: string | undefined;
		let childDigest: string | undefined;
		const report = { owner: true } as TestReportRun;
		const mutate = () => {
			if (mutated) return;
			mutated = true;
			const paths = change === "bindings" || change === "binding-mode" ? generatedPaths : [sourcePath];
			identity = {
				...identity,
				head: change === "head" ? "moved-head" : identity.head,
				digest: change === "head" ? identity.digest : "changed-digest",
				dirty: change !== "head",
				status: change === "head" ? "" : paths.map(file => ` M ${file}\n`).join(""),
				files: identity.files.map(file =>
					change !== "head" && paths.includes(file.path)
						? { ...file, sha256: "changed", executable: change === "binding-mode" }
						: file,
				),
			};
			if (change === "new-test") {
				identity.files = [
					...identity.files,
					{ path: sourcePath, kind: "file", sha256: "new-test", executable: false },
				];
			}
		};
		const gate = {
			signal: new AbortController().signal,
			charged: async <T>(operation: () => T | Promise<T>) => operation(),
			run: async () => {
				if (interval === "preparation") mutate();
			},
			childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
			record: (error: unknown) => error,
			fail: (error: unknown) => error,
		} as unknown as GateRun;
		let failure: unknown;
		try {
			await runFulltest(
				gate,
				{ debug: false },
				{
					captureSourceIdentity: async () => identity,
					captureChangedPaths: async () => ["scripts/fulltest.ts"],
					fastcheckCommands: async () => [],
					runGateCommands: async (_gate, commands) => {
						if (commands.some(command => command.label === "build/native")) {
							if (interval === "native") mutate();
						} else if (commands.some(command => command.label.startsWith("test/repository scripts "))) {
							scriptEnv = commands.find(command => command.label.startsWith("test/repository scripts "))?.env;
							if (interval === "scripts") mutate();
						} else {
							const typescript = commands.find(
								command => command.label === "test/TypeScript fork feature suite",
							);
							if (typescript) {
								childDigest = typescript.env?.OMP_FULLTEST_SOURCE_DIGEST;
								tsAffected = typescript.env?.OMP_FULLTEST_AFFECTED;
							}
							if (commands.some(command => command.label.startsWith("test/"))) testsRun = true;
							if (interval === "tests") mutate();
						}
					},
				},
				report,
			);
		} catch (error) {
			failure = error;
		}
		expect(mutated).toBe(true);
		return { failure, testsRun, childDigest, tsAffected, scriptEnv, report };
	}

	for (const interval of ["preparation", "native", "scripts", "tests"] as const) {
		for (const change of ["source", "new-test", "head"] as const) {
			test(`rejects ${change} movement during ${interval} rather than certifying an omitted snapshot`, async () => {
				const { failure } = await exercise(change, interval);
				expect(failure).toBeInstanceOf(Error);
				expect(String(failure)).toContain("Source changed");
			});
		}
	}
	for (const interval of ["preparation", "scripts", "tests"] as const) {
		test(`rejects binding regeneration outside native generation during ${interval}`, async () => {
			const { failure } = await exercise("bindings", interval);
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).toContain("Source changed");
		});
	}

	test("rejects generated binding mode changes even during native generation", async () => {
		const { failure } = await exercise("binding-mode", "native");
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toContain("Source changed");
	});

	test("allows native binding regeneration and still executes the full test plan", async () => {
		const { failure, testsRun, childDigest, tsAffected, scriptEnv, report } = await exercise("bindings", "native");
		expect(failure).toBeUndefined();
		expect(testsRun).toBe(true);
		expect(childDigest).toBe("changed-digest");
		expect(report.sourceDigest).toBe("changed-digest");
		expect(report.sourceRevision).toBe("initial-head");
		expect(report.dirtyState).toBe("dirty");
		expect(tsAffected).toBe("1");
		expect(scriptEnv?.OMP_FULLTEST_AFFECTED).toBe("1");
		expect(scriptEnv?.OMP_FULLTEST_SOURCE_DIGEST).toBe("changed-digest");
	});
});

describe("fulltest lane scheduling", () => {
	for (const rustCheck of ["success", "failure", "absent"] as const) {
		test(`releases Rust tests independently of TypeScript static checks when Rust checks are ${rustCheck}`, async () => {
			const tsStarted = Promise.withResolvers<void>();
			const finishTs = Promise.withResolvers<void>();
			const rustStarted = Promise.withResolvers<void>();
			const finishFirstRust = Promise.withResolvers<void>();
			const secondRustStarted = Promise.withResolvers<void>();
			const finishSecondRust = Promise.withResolvers<void>();
			const rustTestsStarted = Promise.withResolvers<void>();
			let rustTestsHaveStarted = false;
			const identity: SourceIdentity = {
				head: "head",
				digest: "digest",
				dirty: false,
				status: "",
				files: [],
			};
			const gate = {
				signal: new AbortController().signal,
				charged: async <T>(operation: () => T | Promise<T>) => operation(),
				run: async (command: { label: string }) => {
					if (command.label === "static/TS") {
						tsStarted.resolve();
						await finishTs.promise;
					} else if (command.label === "static/Rust first") {
						rustStarted.resolve();
						await finishFirstRust.promise;
						if (rustCheck === "failure") throw new Error("Rust static failure");
					} else if (command.label === "static/Rust second") {
						secondRustStarted.resolve();
						await finishSecondRust.promise;
					}
				},
				childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
				record: (error: unknown) => error,
				fail: (error: unknown) => error,
			} as unknown as GateRun;
			const run = runFulltest(
				gate,
				{ debug: false },
				{
					captureSourceIdentity: async () => identity,
					captureChangedPaths: async () => [],
					fastcheckCommands: async () => [
						{ label: "static/TS", argv: ["ts"] },
						...(rustCheck === "absent"
							? []
							: [
									{ label: "static/Rust first", argv: ["rust-first"] },
									{ label: "static/Rust second", argv: ["rust-second"] },
								]),
					],
					runGateCommands: async (runner, commands, options) => {
						if (commands.some(command => command.label === "static/TS")) {
							await runGateCommands(runner, commands, options);
						} else if (commands.some(command => command.label.startsWith("test/Rust"))) {
							rustTestsHaveStarted = true;
							rustTestsStarted.resolve();
						}
					},
				},
			);
			try {
				await tsStarted.promise;
				if (rustCheck !== "absent") {
					await rustStarted.promise;
					finishFirstRust.resolve();
					await secondRustStarted.promise;
					expect(rustTestsHaveStarted).toBe(false);
					finishSecondRust.resolve();
				}
				await rustTestsStarted.promise;
			} finally {
				finishTs.resolve();
				finishFirstRust.resolve();
				finishSecondRust.resolve();
				await run;
			}
		});
	}

	test("runs startup tests only after static and ordinary test lanes settle, even on failure", async () => {
		const staticStarted = Promise.withResolvers<void>();
		const ordinaryStarted = Promise.withResolvers<void>();
		const rustStarted = Promise.withResolvers<void>();
		const finishStatic = Promise.withResolvers<void>();
		const finishOrdinary = Promise.withResolvers<void>();
		const finishRust = Promise.withResolvers<void>();
		const ordinarySettled = Promise.withResolvers<void>();
		const rustSettled = Promise.withResolvers<void>();
		const failures: unknown[] = [];
		let startupHasStarted = false;
		let ordinaryHome: string | undefined;
		let sourceCaptures = 0;
		const identity: SourceIdentity = {
			head: "head",
			digest: "digest",
			dirty: false,
			status: "",
			files: [],
		};
		const gate = {
			signal: new AbortController().signal,
			charged: async <T>(operation: () => T | Promise<T>) => operation(),
			run: async () => {},
			childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
			record: (error: unknown) => {
				failures.push(error);
				return error;
			},
			fail: (error: unknown) => error,
		} as unknown as GateRun;
		const run = runFulltest(
			gate,
			{ debug: false },
			{
				captureChangedPaths: async () => [],
				captureSourceIdentity: async () => {
					sourceCaptures++;
					if (sourceCaptures === 4) expect(startupHasStarted).toBe(true);
					return identity;
				},
				fastcheckCommands: async () => [{ label: "static/TS", argv: ["ts"] }],
				runGateCommands: async (_runner, commands, options) => {
					const ordinary = commands.find(command => command.label === "test/TypeScript fork feature suite");
					const startup = commands.find(command => command.label === "test/TypeScript startup suite");
					if (commands.some(command => command.label === "static/TS")) {
						staticStarted.resolve();
						await finishStatic.promise;
					} else if (ordinary) {
						expect(startup).toBeUndefined();
						expect(ordinary.argv).toEqual([
							"bun",
							"scripts/ci-test-ts.ts",
							"local-ts",
							"--exclude-desktop",
							"--defer-startup",
						]);
						expect(ordinary.env?.OMP_FULLTEST_AFFECTED).toBe("1");
						expect(ordinary.env?.OMP_FULLTEST_SOURCE_DIGEST).toBe("digest");
						ordinaryHome = ordinary.env?.HOME;
						ordinaryStarted.resolve();
						await finishOrdinary.promise;
						ordinarySettled.resolve();
						throw new Error("ordinary failure");
					} else if (commands.some(command => command.label.startsWith("test/Rust"))) {
						rustStarted.resolve();
						await finishRust.promise;
						rustSettled.resolve();
						throw new Error("Rust failure");
					} else if (startup) {
						expect(commands).toHaveLength(1);
						expect(startup.argv).toEqual([
							"bun",
							"scripts/ci-test-ts.ts",
							"local-ts",
							"--exclude-desktop",
							"--only-startup",
						]);
						expect(startup.env?.HOME).toBeDefined();
						expect(startup.env?.HOME).not.toBe(ordinaryHome);
						expect(startup.env?.OMP_FULLTEST_AFFECTED).toBe("1");
						expect(startup.env?.OMP_FULLTEST_SOURCE_DIGEST).toBe("digest");
						expect(options?.concurrency).toBe(1);
						startupHasStarted = true;
					}
				},
			},
		);
		try {
			await Promise.all([staticStarted.promise, ordinaryStarted.promise, rustStarted.promise]);
			expect(startupHasStarted).toBe(false);
			finishOrdinary.resolve();
			await ordinarySettled.promise;
			expect(startupHasStarted).toBe(false);
			finishRust.resolve();
			await rustSettled.promise;
			expect(startupHasStarted).toBe(false);
			finishStatic.resolve();
			await run;
			expect(startupHasStarted).toBe(true);
			expect(sourceCaptures).toBe(4);
			expect(failures.map(error => String(error))).toEqual(["Error: ordinary failure", "Error: Rust failure"]);
		} finally {
			finishOrdinary.resolve();
			finishRust.resolve();
			finishStatic.resolve();
			await run;
		}
	});
});

describe("gate-local profile fixture isolation", () => {
	for (const selector of [
		"HOME",
		"PI_CONFIG_DIR",
		"OMP_CONFIG_ROOT",
		"PI_CODING_AGENT_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
	] as const) {
		test(`actual directory consumer honors isolated ${selector} selection over host selectors`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-isolation-"));
			const home = path.join(directory, "gate-home");
			const host = path.join(directory, "host");
			const overrides: Record<string, string> = {};
			let root = path.join(home, ".omp");
			let profile: string | null = null;
			if (selector === "PI_CONFIG_DIR") {
				overrides.PI_CONFIG_DIR = "fixture-config";
				root = path.join(home, overrides.PI_CONFIG_DIR);
			} else if (selector === "OMP_CONFIG_ROOT") {
				overrides.OMP_CONFIG_ROOT = root = path.join(directory, "fixture-root");
			} else if (selector === "OMP_PROFILE" || selector === "PI_PROFILE") {
				overrides[selector] = profile = "fixture-profile";
				root = path.join(root, "profiles", profile);
			}
			const agent =
				selector === "PI_CODING_AGENT_DIR" ? path.join(directory, "fixture-agent") : path.join(root, "agent");
			if (selector === "PI_CODING_AGENT_DIR") overrides.PI_CODING_AGENT_DIR = agent;
			try {
				await fs.mkdir(agent, { recursive: true });
				await fs.mkdir(host, { recursive: true });
				await Bun.write(path.join(agent, "fixture.txt"), "isolated fixture");
				await Bun.write(path.join(host, "keep.txt"), "host files remain untouched");
				const consumer = `
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, getActiveProfile } from ${JSON.stringify(new URL("../packages/utils/src/dirs.ts", import.meta.url).href)};
const agent = getAgentDir();
const fixture = await Bun.file(path.join(agent, "fixture.txt")).text();
await Bun.write(path.join(agent, "child-write.txt"), fixture);
console.log(JSON.stringify({ root: getConfigRootDir(), agent, profile: getActiveProfile() ?? null, fixture }));
`;
				const construction = `
import { localTestEnvironment } from ${JSON.stringify(new URL("./fulltest.ts", import.meta.url).href)};
const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(consumer)}], {
	env: { ...localTestEnvironment(${JSON.stringify(home)}), ...${JSON.stringify(overrides)} },
	stdout: "pipe",
	stderr: "pipe",
});
const [exitCode, stdout, stderr] = await Promise.all([
	child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
]);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(exitCode);
`;
				const child = Bun.spawn([process.execPath, "-e", construction], {
					env: {
						...process.env,
						HOME: host,
						USERPROFILE: host,
						OMP_CONFIG_ROOT: host,
						PI_CODING_AGENT_DIR: host,
						OMP_PROFILE: "host-omp-profile",
						PI_PROFILE: "host-pi-profile",
						PI_CONFIG_DIR: "host-config",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
				expect(JSON.parse(stdout)).toEqual({ root, agent, profile, fixture: "isolated fixture" });
				expect(await Bun.file(path.join(agent, "child-write.txt")).text()).toBe("isolated fixture");
				expect(await Bun.file(path.join(host, "child-write.txt")).exists()).toBe(false);
				expect(await Bun.file(path.join(host, "keep.txt")).text()).toBe("host files remain untouched");
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		}, 20_000);
	}
});

describe("standard gate charged-budget parameters", () => {
	test("independent-command pool width scales with the host and stays clamped", () => {
		expect(gatePoolWidth(0)).toBe(4);
		expect(gatePoolWidth(1)).toBe(4);
		expect(gatePoolWidth(4)).toBe(4);
		expect(gatePoolWidth(8)).toBe(4);
		expect(gatePoolWidth(9)).toBe(4);
		expect(gatePoolWidth(10)).toBe(5);
		expect(gatePoolWidth(32)).toBe(16);
		expect(gatePoolWidth(64)).toBe(16);
		// The narrower multithreaded static-check pool (tsgo/clippy lanes).
		expect(gatePoolWidth(32, 3, 12)).toBe(10);
		expect(gatePoolWidth(12, 3, 12)).toBe(4);
		expect(gatePoolWidth(48, 3, 12)).toBe(12);
	});
	test("WSL hosts halve the pool-sizing core budget; native hosts stay unchanged", () => {
		expect(gateCpuBudget(26, "6.18.54.1-microsoft-standard-WSL2")).toBe(13);
		expect(gateCpuBudget(8, "5.15.153.1-microsoft-standard-WSL2")).toBe(4);
		expect(gateCpuBudget(26, "6.8.0-48-generic")).toBe(26);
		expect(gateCpuBudget(32, "10.0.26100")).toBe(32);
	});

	test("fastcheck accepts only a finite positive downward limit", () => {
		expect(parseFastcheckArgs(["--limit-seconds=0.25"])).toEqual({ limitSeconds: 0.25 });
		const fastcheckMax = GATE_LIMIT_SECONDS.fastcheck;
		expect(parseFastcheckArgs([`--limit-seconds=${fastcheckMax}`])).toEqual({ limitSeconds: fastcheckMax });
		for (const args of [
			[`--limit-seconds=${fastcheckMax + 0.01}`],
			["--limit-seconds=0"],
			["--limit-seconds=-1"],
			["--limit-seconds=Infinity"],
			["--limit-seconds=NaN"],
			["--limit-seconds=1", "--limit-seconds=2"],
			["--limit=1"],
			["--debug"],
			["anything"],
		]) {
			expect(parseFastcheckArgs(args)).toBeNull();
		}
	});

	test("fulltest retains debug and rejects budget relaxation or ambiguous options", () => {
		expect(parseFulltestArgs(["--debug", "--debug"])).toEqual({ debug: true });
		const max = GATE_LIMIT_SECONDS.fulltest;
		expect(parseFulltestArgs([`--limit-seconds=${max}`, "--debug"])).toEqual({ debug: true, limitSeconds: max });
		expect(parseFulltestArgs(["--debug", "--limit-seconds=0.25"])).toEqual({ debug: true, limitSeconds: 0.25 });
		for (const args of [
			[`--limit-seconds=${max + 0.01}`],
			["--limit-seconds=0"],
			["--limit-seconds=-1"],
			["--limit-seconds=Infinity"],
			["--limit-seconds=NaN"],
			["--limit-seconds=1", "--limit-seconds=2"],
			["--limit=1"],
			["--other"],
			["--debug", "anything"],
		]) {
			expect(parseFulltestArgs(args)).toBeNull();
		}
	});
});

test("mechanism selftests cannot exempt simulated compilation from a real gate", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-charged-selftest-"));
	try {
		const stub = path.join(directory, "stub.ts");
		await fs.writeFile(
			stub,
			`
process.stderr.write("OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + ' {"id":"simulated","kind":"compile"}\\n');
await Bun.sleep(300);
process.stderr.write("OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + ' {"id":"simulated","kind":"idle"}\\n');
`,
		);
		const result = await runGate(
			"fulltest",
			gate =>
				gate.charged(() =>
					gate.run({
						label: "isolated mechanism fixture",
						argv: [process.execPath, stub],
						kind: "charged",
					}),
				),
			{ print: () => {} },
		);
		expect(result.status).toBe("PASS");
		expect(result.compileExcludedSeconds).toBe(0);
		expect(result.budgetedSeconds).toBeGreaterThanOrEqual(0.3);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "win32")(
	"removes denied Windows junctions without deleting their targets",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-junction-cleanup-"));
		const home = path.join(directory, "home");
		const outside = path.join(directory, "outside");
		const junction = path.join(home, "cache");
		await fs.mkdir(home);
		await fs.mkdir(outside);
		await Bun.write(path.join(outside, "keep"), "outside gate ownership");
		await fs.symlink(outside, junction, "junction");
		try {
			const acl = Bun.spawn(["icacls.exe", junction, "/deny", "*S-1-1-0:(RD)", "/L"], {
				stdout: "ignore",
				stderr: "inherit",
			});
			expect(await acl.exited).toBe(0);
			await expect(fs.readdir(junction)).rejects.toMatchObject({ code: "EPERM" });
			await removeFulltestHome(home);
			await expect(fs.lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await Bun.file(path.join(outside, "keep")).text()).toBe("outside gate ownership");
		} finally {
			await removeFulltestHome(directory);
		}
	},
);
