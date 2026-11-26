import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserPlatform, computeExecutablePath, detectBrowserPlatform } from "@oh-my-pi/pi-utils/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";
import { FULLTEST_BUN_CAPACITY_FILE, testTimeoutMs } from "./ci-test-ts";
import { gatePoolWidth } from "./fastcheck";
import {
	fulltestCommands,
	fulltestWorkerAllocation,
	gateCpuBudget,
	removeFulltestHome,
	runFulltest,
	selectChangedScriptTests,
} from "./fulltest";
import { runGate, type GateCommand, type GateRun } from "./test-gate-runtime";
import { bunRequiresFullSelection, captureChangedPaths, type SourceRevision } from "./test-gate-source";
import type { TestReportRun } from "./test-reporting";
import { runGateCommands } from "./test-gate-scheduler";

const ordinaryToolPath = "packages/coding-agent/src/tools/read.ts";

test("debug changes only the isolated smoke diagnostic argument, not test scope", () => {
	for (const full of [false, true]) {
		const normal = fulltestCommands({ debug: false, full }, "/tmp/home", "a".repeat(40));
		const debug = fulltestCommands({ debug: true, full }, "/tmp/home", "a".repeat(40));
		const smoke = debug.find(command => command.label === "smoke/isolated native TUI PTY")!;
		expect(smoke.argv).toEqual(["bun", "scripts/test-report-ui-smoke.ts", "--debug"]);
		expect(debug.map(command => ({ ...command, argv: command.argv.filter(arg => arg !== "--debug") }))).toEqual(
			normal,
		);
		expect(debug.filter(command => command.argv.includes("--debug"))).toHaveLength(1);
	}
});

test("fork and full plans leave distribution packaging out of the verification gate", () => {
	for (const full of [false, true]) {
		const commands = fulltestCommands({ debug: false, full }, "/tmp/home");
		for (const command of commands) {
			expect(command.argv.some(arg => /(?:bundle-dist|build-binary|compile-binary)\.ts$/.test(arg))).toBe(false);
		}
	}
});

describe("fulltest worker allocation", () => {
	test("bounds total reservations and keeps all requested test lanes viable", () => {
		for (const cores of [1, 3, 4, 5, 8, 16, 64]) {
			for (const [ordinary, rust, startup, staticChecks, scripts] of [
				[true, true, true, 12, 4],
				[true, true, true, 1, 0],
				[true, false, true, 0, 1],
				[false, true, false, 2, 0],
			] as const) {
				const allocation = fulltestWorkerAllocation(cores, ordinary, rust, startup, staticChecks, scripts);
				const workers = [allocation.ordinary, allocation.rust, allocation.startup];
				for (const [index, enabled] of [ordinary, rust, startup].entries()) {
					expect(workers[index]! > 0).toBe(enabled);
					expect(Number.isInteger(workers[index])).toBe(true);
				}
				expect(allocation.staticWorkers).toBeLessThanOrEqual(staticChecks);
				expect(allocation.scripts).toBeLessThanOrEqual(scripts);
				const allWorkers = [...workers, allocation.staticWorkers, allocation.scripts];
				const peak = allocation.serial
					? Math.max(...allWorkers)
					: allWorkers.reduce((sum, count) => sum + count, 0);
				expect(peak).toBeLessThanOrEqual(Math.min(28, cores));
			}
		}
	});

	test("full Bun uses the slots not needed by static or Cargo work at a five-slot ceiling", () => {
		expect(fulltestWorkerAllocation(5, true, true, false, 12, 4, true)).toEqual({
			ordinary: 3,
			rust: 1,
			startup: 0,
			staticWorkers: 1,
			scripts: 0,
			serial: false,
		});
	});

	test("the workspace Nextest lane can run two workers without starving the shared Bun pool", () => {
		const { rust, ordinary, staticWorkers, scripts } = fulltestWorkerAllocation(8, true, true, false, 12, 4, true);
		expect(rust).toBe(2);
		expect(ordinary).toBeGreaterThanOrEqual(2);
		expect(rust + ordinary + staticWorkers + scripts).toBe(8);
	});

	test("fork Bun keeps two ordinary slots with startup and Rust static checks", () => {
		expect(fulltestWorkerAllocation(5, true, true, true, 12, 4)).toEqual({
			ordinary: 2,
			rust: 1,
			startup: 1,
			staticWorkers: 1,
			scripts: 0,
			serial: false,
		});
	});
});

test("script selection uses changed modules and existing tests, not business files or a clean tree", () => {
	const files = [
		"scripts/fulltest.test.ts",
		"scripts/ci-test-ts.test.ts",
		"scripts/test-reporting.test.ts",
		"scripts/run-rs-task.test.ts",
		"scripts/release.test.ts",
	];
	expect(selectChangedScriptTests([], files)).toEqual([]);
	expect(
		selectChangedScriptTests(["packages/natives/src/lib.rs", "packages/coding-agent/src/index.ts"], files),
	).toEqual([]);
	expect(selectChangedScriptTests(["scripts/fulltest.ts", "scripts/test-reporting.ts"], files)).toEqual([
		"scripts/ci-test-ts.test.ts",
		"scripts/fulltest.test.ts",
		"scripts/run-rs-task.test.ts",
		"scripts/test-reporting.test.ts",
	]);
	expect(selectChangedScriptTests(["scripts/release.test.ts", "scripts/unknown.ts"], files)).toEqual([
		"scripts/release.test.ts",
	]);
});

test("Bun traces only known static inputs; unknown and dynamic inputs fall back", () => {
	expect(bunRequiresFullSelection([])).toBe(false);
	expect(bunRequiresFullSelection([ordinaryToolPath])).toBe(false);
	for (const file of [
		"Cargo.lock",
		"packages/natives/src/lib.rs",
		"packages/coding-agent/src/config/settings.ts",
		"packages/coding-agent/src/generated/bindings.ts",
		"packages/coding-agent/test/fixtures/input.ts",
		"scripts/build.ts",
		"bun.lock",
	]) {
		expect(bunRequiresFullSelection([file])).toBe(true);
	}
});

test("root documentation does not force full Bun selection or hide changed runtime inputs", () => {
	const docs = ["docs/guide.md", "docs-zh-CN/guide.md", "AGENTS.md"];
	expect(bunRequiresFullSelection(docs)).toBe(false);
	expect(bunRequiresFullSelection([...docs, ordinaryToolPath])).toBe(false);
	expect(bunRequiresFullSelection([...docs, "Cargo.lock"])).toBe(true);
	expect(bunRequiresFullSelection(["packages/coding-agent/src/prompts/system.md"])).toBe(true);
	expect(bunRequiresFullSelection(["packages/coding-agent/docs/guide.md"])).toBe(true);
});

test("fulltest preserves Bun selection and schedules Rust tests only with --full", async () => {
	const baseline = "a".repeat(40);
	const revision: SourceRevision = { head: baseline, dirty: true, status: "" };
	const gate = {
		signal: new AbortController().signal,
		charged: async <T>(work: () => T | Promise<T>) => work(),
		run: async () => {},
		childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
		record: (error: unknown) => error,
		fail: (error: unknown) => error,
	} as unknown as GateRun;
	const cases = [
		{ changed: [ordinaryToolPath], affected: true, full: false, bunFull: false },
		{ changed: ["Cargo.lock"], affected: true, full: false, bunFull: true },
		{ changed: [ordinaryToolPath], affected: false, full: false, bunFull: true },
		{ changed: [ordinaryToolPath], affected: true, full: true, bunFull: true },
	] as const;
	for (const scenario of cases) {
		const commands: { label: string; argv: readonly string[]; env?: Record<string, string | undefined> }[] = [];
		let observedBase: string | undefined;
		await runFulltest(
			gate,
			{ debug: false, full: scenario.full },
			{
				cpuBudget: 28,
				captureSourceRevision: async () => revision,
				scriptTestFiles: async () =>
					scenario.full
						? ["scripts/fulltest.test.ts", "scripts/install-tests/fork-installer-routing.test.ts"]
						: [],
				captureChangedPaths: async (_gate, _root, base) => {
					observedBase = base;
					return [...scenario.changed];
				},
				bunTestSelection: async () =>
					scenario.affected
						? { tool: "bun", mode: "affected", baseline }
						: { tool: "bun", mode: "full", reason: "no baseline" },
				fastcheckCommands: async () => [],
				runGateCommands: async (_gate, selected) => {
					commands.push(...selected);
				},
			},
		);
		expect(observedBase).toBe(!scenario.full && scenario.affected ? baseline : "HEAD");
		expect(commands.some(command => command.label === "smoke/isolated native TUI PTY")).toBe(true);
		if (!scenario.full) {
			expect(commands.flatMap(command => command.argv)).not.toContain("scripts/test-report-py.ts");
		}
		const rust = commands.filter(command => command.label.startsWith("test/Rust"));
		expect(rust.map(command => command.label).sort()).toEqual(
			scenario.full ? ["test/Rust SDK", "test/Rust workspace"] : [],
		);
		if (scenario.full) {
			expect(rust.find(command => command.label === "test/Rust workspace")?.argv).toEqual([
				"bun",
				"scripts/run-rs-task.ts",
				"test:rs",
				"--full",
			]);
		}
		const ts = commands.filter(command => command.label.startsWith("test/TypeScript"));
		for (const command of ts) expect(command.env?.OMP_TEST_CONCURRENCY).toBe("all");
		if (scenario.full) {
			expect(
				commands
					.filter(command => command.argv[1] === "scripts/test-report-bun.ts")
					.map(command => command.argv[2]),
			).toEqual(["scripts/fulltest.test.ts"]);
			expect(ts).toHaveLength(1);
			expect(ts[0]!.argv).toEqual([
				"bun",
				"scripts/ci-test-ts.ts",
				"all",
				"--exclude-desktop",
				"--unsharded",
				"--shared-fulltest-pool",
			]);
			expect(ts[0]!.env?.OMP_FULLTEST_AFFECTED).toBeUndefined();
			expect(ts[0]!.env?.OMP_FULLTEST_BASELINE).toBe("none");
		} else {
			expect(ts).toHaveLength(2);
			expect(ts.map(command => command.argv.at(-1)).sort()).toEqual(["--defer-startup", "--only-startup"]);
			expect(ts.map(command => command.env?.OMP_FULLTEST_BASELINE)).toEqual(
				scenario.bunFull ? ["none", "none"] : [baseline, baseline],
			);
		}
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
		await Bun.write(path.join(root, "docs", "guide.md"), "original\n");
		await Bun.write(path.join(root, "AGENTS.md"), "original\n");
		await git("add", ".");
		await git("commit", "-qm", "baseline");
		const baseline = (await git("rev-parse", "HEAD")).trim();
		await fs.writeFile(path.join(root, "scripts", "committed.ts"), "committed\n");
		await git("add", "scripts/committed.ts");
		await git("commit", "-qm", "later unverified commit");
		expect(await captureChangedPaths(gate, root)).toEqual([]);
		await Bun.write(path.join(root, "docs", "guide.md"), "changed\n");
		await Bun.write(path.join(root, "AGENTS.md"), "changed\n");
		await git("add", "AGENTS.md");
		await Bun.write(path.join(root, "docs-zh-CN", "guide.md"), "untracked\n");
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

test("direct scheduler overlaps commands, continues independent work, and preserves the first actual failure", async () => {
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
  process.exit(23);
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
		expect(result.failures?.some(failure => failure.message.includes("first"))).toBe(true);
		expect(result.failures?.some(failure => failure.message.includes("second"))).toBe(true);
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

test("fulltest records revision once and passes scheduling hints after native generation", async () => {
	const revision: SourceRevision = { head: "a".repeat(40), dirty: true, status: " M scripts/fulltest.ts\n" };
	let captures = 0;
	const commands: { label: string; env?: Record<string, string | undefined> }[] = [];
	const gate = {
		signal: new AbortController().signal,
		charged: async <T>(operation: () => T | Promise<T>) => operation(),
		run: async () => {},
		childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
		record: (error: unknown) => error,
		fail: (error: unknown) => error,
	} as unknown as GateRun;
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fulltest-report-"));
	try {
		const report: TestReportRun = {
			id: path.basename(directory),
			dir: directory,
			startedAt: new Date().toISOString(),
			startedMs: performance.now(),
			scope: "fulltest",
			owner: true,
			sourceRevision: null,
			dirtyState: null,
			dirtyStateIdentity: null,
		};
		await runFulltest(
			gate,
			{ debug: false },
			{
				captureSourceRevision: async () => {
					captures++;
					return revision;
				},
				captureChangedPaths: async () => ["scripts/fulltest.ts"],
				scriptTestFiles: async () => ["scripts/fulltest.test.ts"],
				bunTestSelection: async () => ({ tool: "bun", mode: "full", reason: "fixture" }),
				fastcheckCommands: async () => [],
				runGateCommands: async (_gate, selected) => {
					commands.push(...selected);
				},
			},
			report,
		);
		expect(captures).toBe(1);
		expect(commands[0]?.label).toBe("build/native");
		for (const label of [
			"test/repository scripts scripts/fulltest.test.ts",
			"test/TypeScript fork feature suite",
			"test/TypeScript startup suite",
		]) {
			const command = commands.find(command => command.label === label);
			expect(command?.env?.OMP_FULLTEST_SOURCE_REVISION).toBe(revision.head);
			expect(command?.env?.OMP_FULLTEST_AFFECTED).toBe("1");
		}
		expect(report.sourceRevision).toBe(revision.head);
		expect(report.dirtyState).toBe("dirty");
		const producers = (await fs.readdir(directory)).filter(file => file.endsWith(".producer.json"));
		expect(producers).toHaveLength(1);
		expect(await Bun.file(path.join(directory, producers[0]!)).json()).toMatchObject({
			scope: "rust-fork-features",
			status: "not-selected",
			selection: { selected: 0, packages: [] },
		});
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

for (const full of [false, true]) {
	test(`${full ? "full" : "fork"} fulltest collects ordinary failures and runs the remaining suites`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-lanes-"));
		const worker = path.join(directory, "worker.ts");
		const ordinaryLabel = full ? "test/TypeScript full suite" : "test/TypeScript fork feature suite";
		const startupLabel = "test/TypeScript startup suite";
		const revision: SourceRevision = { head: "head", dirty: false, status: "" };
		try {
			await fs.writeFile(
				worker,
				`
import * as fs from "node:fs/promises";
import * as path from "node:path";
const [dir, label, originalArgv] = process.argv.slice(2);
const file = (name, event) => path.join(dir, encodeURIComponent(name) + "." + event);
const exists = async name => !!(await fs.stat(name).catch(() => null));
const ordinary = ${JSON.stringify(ordinaryLabel)};
await fs.appendFile(file(label, "start"), JSON.stringify({
  argv: JSON.parse(originalArgv),
  home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
  configRoot: process.env.OMP_CONFIG_ROOT,
  affected: process.env.OMP_FULLTEST_AFFECTED,
  budget: process.env.OMP_TEST_CPU_BUDGET,
  nativeFinished: await exists(file("build/native", "end")),
  startupHome: process.env.OMP_FULLTEST_STARTUP_HOME,
}) + "\\n");
await fs.writeFile(file(label, "end"), "finished");
if (label === ordinary) process.exit(17);
`,
			);
			const result = await runGate("fulltest", async realGate => {
				const gate = {
					signal: realGate.signal,
					charged: async <T>(operation: () => T | Promise<T>) => operation(),
					run: async () => {},
					childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
					record: (error: unknown) => realGate.record(error),
					fail: (error: unknown) => realGate.fail(error),
				} as unknown as GateRun;
				await runFulltest(
					gate,
					{ debug: false, full },
					{
						cpuBudget: 16,
						captureSourceRevision: async () => revision,
						scriptTestFiles: async () => [],
						captureChangedPaths: async () => ["packages/tui/src/tui.ts"],
						bunTestSelection: async () => ({ tool: "bun", mode: "affected", baseline: "a".repeat(40) }),
						fastcheckCommands: async () => [{ label: "static/TS", argv: ["ts"] }],
						runGateCommands: async (_runner, commands, options) => {
							await runGateCommands(
								realGate,
								commands.map(command => ({
									...command,
									argv: [process.execPath, worker, directory, command.label, JSON.stringify(command.argv)],
								})),
								options,
							);
						},
					},
				);
			});
			type Start = {
				argv: string[];
				home?: string;
				userprofile?: string;
				configRoot?: string;
				affected?: string;
				budget?: string;
				nativeFinished: boolean;
				startupHome?: string;
			};
			const starts = async (label: string): Promise<Start[]> => {
				const text = await fs
					.readFile(path.join(directory, `${encodeURIComponent(label)}.start`), "utf8")
					.catch(() => "");
				return text.trim()
					? text
							.trim()
							.split("\n")
							.map(line => JSON.parse(line) as Start)
					: [];
			};
			const ordinary = await starts(ordinaryLabel);
			const startup = await starts(startupLabel);
			const rust = await starts("test/Rust workspace");
			expect(ordinary).toHaveLength(1);
			expect(startup).toHaveLength(full ? 0 : 1);
			expect(rust).toHaveLength(full ? 1 : 0);
			expect(ordinary[0]!.nativeFinished).toBe(true);
			expect((await starts("static/TS"))[0]!.nativeFinished).toBe(true);
			if (full) {
				expect(rust[0]!.nativeFinished).toBe(true);
				expect(ordinary[0]!.argv).toContain("--shared-fulltest-pool");
				expect(ordinary[0]!.argv).not.toContain("--defer-startup");
				expect(ordinary[0]!.startupHome).toBeDefined();
				expect(ordinary[0]!.startupHome).not.toBe(ordinary[0]!.home);
			} else {
				expect(ordinary[0]!.argv).toContain("--defer-startup");
				expect(startup[0]!.argv).toContain("--only-startup");
				expect(startup[0]!.nativeFinished).toBe(true);
				expect(startup[0]!.home).toBeDefined();
				expect(startup[0]!.home).not.toBe(ordinary[0]!.home);
			}
			expect(ordinary[0]!.home).toBeDefined();
			expect(ordinary[0]!.userprofile).toBe(ordinary[0]!.home);
			expect(ordinary[0]!.configRoot).toBe("");
			expect(await starts("smoke/isolated native TUI PTY")).toHaveLength(1);
			if (full) {
				for (const label of ["test/Python suites", "test/Go SDK", "test/Rust SDK"]) {
					expect(await starts(label)).toHaveLength(1);
				}
			}
			expect(result.exitCode).toBe(17);
			expect(result.failures?.some(failure => failure.message.includes(ordinaryLabel))).toBe(true);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
}

describe("fulltest lane scheduling", () => {
	for (const rustCheck of ["success", "failure", "absent"] as const) {
		test(`releases workspace Rust tests independently of TypeScript static checks when Rust checks are ${rustCheck}`, async () => {
			const tsStarted = Promise.withResolvers<void>();
			const finishTs = Promise.withResolvers<void>();
			const rustStarted = Promise.withResolvers<void>();
			const finishFirstRust = Promise.withResolvers<void>();
			const secondRustStarted = Promise.withResolvers<void>();
			const finishSecondRust = Promise.withResolvers<void>();
			const rustTestsStarted = Promise.withResolvers<void>();
			let rustTestsHaveStarted = false;
			const revision: SourceRevision = { head: "head", dirty: false, status: "" };
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
				{ debug: false, full: true },
				{
					cpuBudget: 16,
					captureSourceRevision: async () => revision,
					scriptTestFiles: async () => [],
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
						if (commands.some(command => command.label.startsWith("static/"))) {
							await runGateCommands(runner, commands, options);
						} else if (commands.some(command => command.label === "test/Rust workspace")) {
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

	test("shares released slots with Bun without preempting scripts, Python/Go or the Cargo chain", async () => {
		const ts = "static/TS";
		const tsSecond = "static/TS second";
		const scriptFile = "scripts/slowtest.test.ts";
		const script = `test/repository scripts ${scriptFile}`;
		const rustCheck = "static/Rust";
		const typeScript = "test/TypeScript full suite";
		const workspace = "test/Rust workspace";
		const python = "test/Python suites";
		const go = "test/Go SDK";
		const rustSdk = "test/Rust SDK";
		const smoke = "smoke/isolated native TUI PTY";
		const latches = new Map(
			[ts, tsSecond, script, rustCheck, typeScript, workspace, python, go, rustSdk, smoke].map(label => [
				label,
				{ started: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>() },
			]),
		);
		const started = (label: string) => latches.get(label)!.started.promise;
		const finish = (label: string) => latches.get(label)!.finish.resolve();
		const seen = new Map<string, GateCommand>();
		const capacityPath = () => path.join(path.dirname(seen.get(typeScript)!.env!.HOME!), FULLTEST_BUN_CAPACITY_FILE);
		const capacity = async () => {
			await new Promise<void>(resolve => setImmediate(resolve));
			return (await fs.stat(capacityPath())).size;
		};
		const active = new Set<string>();
		const failures: unknown[] = [];
		const pythonFailure = new Error("Python test failure");
		let peak = 0;
		const gate = {
			signal: new AbortController().signal,
			charged: async <T>(operation: () => T | Promise<T>) => operation(),
			run: async (command: GateCommand) => {
				const lane = latches.get(command.label);
				if (!lane) return;
				seen.set(command.label, command);
				active.add(command.label);
				peak = Math.max(
					peak,
					[...active].reduce((sum, label) => sum + Number(seen.get(label)?.env?.OMP_TEST_CPU_BUDGET ?? 1), 0),
				);
				lane.started.resolve();
				await lane.finish.promise;
				active.delete(command.label);
				if (command.label === python) throw pythonFailure;
			},
			childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
			record: (error: unknown) => {
				failures.push(error);
				return error;
			},
			fail: (error: unknown) => error,
		} as unknown as GateRun;
		const run = runFulltest(
			gate,
			{ debug: false, full: true },
			{
				cpuBudget: 8,
				captureSourceRevision: async () => ({ head: "head", dirty: false, status: "" }),
				captureChangedPaths: async () => [],
				scriptTestFiles: async () => [scriptFile],
				fastcheckCommands: async () => [
					{ label: ts, argv: ["ts"] },
					{ label: tsSecond, argv: ["ts2"] },
					{ label: rustCheck, argv: ["rust"] },
				],
				runGateCommands,
			},
		);
		try {
			await Promise.all([ts, tsSecond, script, rustCheck, typeScript].map(started));
			expect(seen.get(typeScript)?.env?.OMP_TEST_CPU_BUDGET).toBe("3");
			expect(seen.get(typeScript)?.env?.OMP_FULLTEST_BUN_MAX_CAPACITY).toBe("8");
			expect(await capacity()).toBe(3);
			expect(seen.has(python)).toBe(false);
			expect(seen.has(workspace)).toBe(false);
			finish(ts);
			expect(await capacity()).toBe(3);
			finish(tsSecond);
			await started(python);
			expect(seen.has(go)).toBe(false);
			expect(await capacity()).toBe(4);
			finish(script);
			expect(await capacity()).toBe(5);
			finish(python);
			await started(go);
			expect(seen.get(go)?.env?.GOMAXPROCS).toBe("1");
			expect(await capacity()).toBe(5);
			finish(rustCheck);
			await started(workspace);
			expect(seen.get(workspace)?.env?.OMP_TEST_CPU_BUDGET).toBe("2");
			expect(await capacity()).toBe(5);
			expect(seen.has(rustSdk)).toBe(false);
			finish(workspace);
			await started(rustSdk);
			expect([...active].toSorted()).toEqual([go, typeScript, rustSdk].toSorted());
			expect(seen.get(rustSdk)?.argv).toEqual(["bun", "scripts/sdk-test-rust.ts", "--full"]);
			expect(seen.has(smoke)).toBe(false);
			expect(seen.get(rustSdk)?.env?.OMP_TEST_CPU_BUDGET).toBe("2");
			expect(await capacity()).toBe(5);
			finish(rustSdk);
			expect(await capacity()).toBe(7);
			finish(go);
			expect(await capacity()).toBe(8);
			expect(peak).toBe(8);
		} finally {
			for (const { finish } of latches.values()) finish.resolve();
			await run;
		}
		expect(seen.has(smoke)).toBe(true);
		expect(await fs.stat(capacityPath()).catch(() => null)).toBeNull();
		expect(failures).toEqual([pythonFailure]);
	});

	test("cancels the shared TypeScript runner through the gate signal", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const active = new Set<string>();
		const cancelled: string[] = [];
		const interruption = new Error("caller cancelled concurrent work");
		const gate = {
			signal: controller.signal,
			charged: async <T>(operation: () => T | Promise<T>) => operation(),
			run: async (command: GateCommand) => {
				if (!command.label.startsWith("test/TypeScript")) return;
				active.add(command.label);
				started.resolve();
				try {
					await new Promise<void>((_resolve, reject) => {
						const abort = () => reject(controller.signal.reason);
						if (controller.signal.aborted) abort();
						else controller.signal.addEventListener("abort", abort, { once: true });
					});
				} finally {
					active.delete(command.label);
					cancelled.push(command.label);
				}
			},
			childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
			record: (error: unknown) => error,
			fail: (error: unknown) => error,
		} as unknown as GateRun;
		const run = runFulltest(
			gate,
			{ debug: false, full: true },
			{
				cpuBudget: 16,
				captureSourceRevision: async () => ({ head: "head", dirty: false, status: "" }),
				captureChangedPaths: async () => [],
				scriptTestFiles: async () => [],
				fastcheckCommands: async () => [],
				runGateCommands,
			},
		).catch(error => error);
		try {
			await started.promise;
			controller.abort(interruption);
			expect(await run).toBe(interruption);
			expect(active.size).toBe(0);
			expect(cancelled).toEqual(["test/TypeScript full suite"]);
		} finally {
			controller.abort(interruption);
			await run;
		}
	});

	for (const inheritedBudget of [2, 6]) {
		test(`respects the caller's ${inheritedBudget}-worker ceiling across concurrent pools`, async () => {
			const previousBudget = process.env.OMP_TEST_CPU_BUDGET;
			const script = "scripts/test-reporting.test.ts";
			process.env.OMP_TEST_CPU_BUDGET = String(inheritedBudget);
			const commands: GateCommand[] = [];
			let scriptConcurrency: number | undefined;
			const gate = {
				signal: new AbortController().signal,
				charged: async <T>(operation: () => T | Promise<T>) => operation(),
				run: async () => {},
				childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
				record: (error: unknown) => error,
				fail: (error: unknown) => error,
			} as unknown as GateRun;
			try {
				await runFulltest(
					gate,
					{ debug: false, full: true },
					{
						cpuBudget: 28,
						captureSourceRevision: async () => ({ head: "head", dirty: false, status: "" }),
						captureChangedPaths: async () => [],
						scriptTestFiles: async () => [script],
						fastcheckCommands: async () => [],
						runGateCommands: async (_runner, selected, options) => {
							commands.push(...selected);
							if (selected.some(command => command.argv[2] === script)) scriptConcurrency = options?.concurrency;
						},
					},
				);
				const budgetOf = (label: string) =>
					Number(commands.find(command => command.label === label)?.env?.OMP_TEST_CPU_BUDGET);
				expect(scriptConcurrency).toBe(1);
				const workers = [budgetOf("test/TypeScript full suite"), budgetOf("test/Rust workspace")];
				const peak =
					inheritedBudget === 2 ? Math.max(...workers) : 1 + workers.reduce((sum, count) => sum + count, 0);
				expect(peak).toBeLessThanOrEqual(inheritedBudget);
				expect(budgetOf("smoke/isolated native TUI PTY")).toBeLessThanOrEqual(inheritedBudget);
			} finally {
				if (previousBudget === undefined) delete process.env.OMP_TEST_CPU_BUDGET;
				else process.env.OMP_TEST_CPU_BUDGET = previousBudget;
			}
		});
	}

	for (const cpuBudget of [1, 5, 28]) {
		test(`isolates clock and subprocess selftests and bounds independent script workers on ${cpuBudget} CPUs`, async () => {
			const independent = ["scripts/slowtest.test.ts", "scripts/test-reporting.test.ts"];
			const isolated = [
				"scripts/ci-test-ts.test.ts",
				"scripts/fulltest.test.ts",
				"scripts/run-rs-task.test.ts",
				"scripts/slowtest-wsl-stage.test.ts",
				"scripts/stamp-native-version.test.ts",
				"scripts/test-gate-runtime.test.ts",
			];
			const isolatedStarted = Promise.withResolvers<void>();
			const finishIsolated = Promise.withResolvers<void>();
			const scriptsStarted = Promise.withResolvers<void>();
			const finishScripts = Promise.withResolvers<void>();
			const staticStarted = Promise.withResolvers<void>();
			const finishStatic = Promise.withResolvers<void>();
			const ordinaryStarted = Promise.withResolvers<void>();
			const heavySettled = Promise.withResolvers<void>();
			const finishHeavy = Promise.withResolvers<void>();
			const isolatedFinished: string[] = [];
			const scriptsSeen: string[] = [];
			const scriptHomes = new Set<string | undefined>();
			const trailingSeen: string[] = [];
			const failures: unknown[] = [];
			const clockFailure = new Error("isolated clock fixture failure");
			const scriptFailure = new Error("independent script fixture failure");
			const serial = cpuBudget === 1;
			const scriptWorkers = cpuBudget === 28 ? 2 : 1;
			let activeScripts = 0;
			let activeHeavyWorkers = 0;
			let isolatedActive = false;
			let heavyFinished = 0;
			let ordinaryHasStarted = false;
			let ordinary: GateCommand | undefined;
			const gate = {
				signal: new AbortController().signal,
				charged: async <T>(operation: () => T | Promise<T>) => operation(),
				run: async (command: GateCommand) => {
					const file = command.argv[2]!;
					if (isolated.includes(file)) {
						expect(activeScripts).toBe(0);
						expect(activeHeavyWorkers).toBe(0);
						expect(isolatedActive).toBe(false);
						isolatedActive = true;
						isolatedStarted.resolve();
						await finishIsolated.promise;
						isolatedActive = false;
						isolatedFinished.push(file);
						if (file === "scripts/test-gate-runtime.test.ts") throw clockFailure;
					} else if (independent.includes(file)) {
						expect(isolatedActive).toBe(false);
						expect(isolatedFinished.toSorted()).toEqual(isolated.toSorted());
						scriptsSeen.push(file);
						scriptHomes.add(command.env?.HOME);
						activeScripts++;
						expect(activeScripts).toBeLessThanOrEqual(scriptWorkers);
						expect(activeScripts + activeHeavyWorkers).toBeLessThanOrEqual(cpuBudget);
						if (activeScripts === scriptWorkers) scriptsStarted.resolve();
						await finishScripts.promise;
						activeScripts--;
						if (file === independent[0]) throw scriptFailure;
					} else if (
						command.label === "static/TS" ||
						command.label === "test/TypeScript full suite" ||
						command.label === "test/Rust workspace"
					) {
						expect(isolatedActive).toBe(false);
						expect(isolatedFinished.toSorted()).toEqual(isolated.toSorted());
						const workers = Number(command.env?.OMP_TEST_CPU_BUDGET ?? 1);
						activeHeavyWorkers += workers;
						expect(activeScripts + activeHeavyWorkers).toBeLessThanOrEqual(cpuBudget);
						if (command.label === "static/TS") staticStarted.resolve();
						if (command.label === "test/TypeScript full suite") {
							ordinary = command;
							ordinaryHasStarted = true;
							ordinaryStarted.resolve();
						}
						await (command.label === "static/TS" ? finishStatic.promise : finishHeavy.promise);
						activeHeavyWorkers -= workers;
						if (++heavyFinished === 3) heavySettled.resolve();
					} else if (command.label === "smoke/isolated native TUI PTY") {
						expect(activeScripts).toBe(0);
						expect(activeHeavyWorkers).toBe(0);
						if (cpuBudget === 1) expect(command.env?.OMP_TEST_CPU_BUDGET).toBe("1");
						trailingSeen.push(command.label);
					}
				},
				childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
				record: (error: unknown) => {
					failures.push(error);
					return error;
				},
				fail: (error: unknown) => error,
			} as unknown as GateRun;
			const run = runFulltest(
				gate,
				{ debug: false, full: true },
				{
					cpuBudget,
					captureSourceRevision: async () => ({ head: "head", dirty: false, status: "" }),
					captureChangedPaths: async () => [],
					scriptTestFiles: async () => [...independent, ...isolated],
					fastcheckCommands: async () => [{ label: "static/TS", argv: ["ts"] }],
					runGateCommands,
				},
			);
			try {
				await isolatedStarted.promise;
				expect(scriptsSeen).toEqual([]);
				expect(ordinaryHasStarted).toBe(false);
				finishIsolated.resolve();
				if (cpuBudget === 5) {
					await Promise.all([staticStarted.promise, ordinaryStarted.promise]);
					expect(scriptsSeen).toEqual([]);
					finishStatic.resolve();
				}
				await scriptsStarted.promise;
				if (cpuBudget === 5) {
					const current = path.join(path.dirname(ordinary!.env!.HOME!), FULLTEST_BUN_CAPACITY_FILE);
					expect((await fs.stat(current)).size).toBe(3);
				}
				if (serial) {
					expect(ordinaryHasStarted).toBe(false);
					finishScripts.resolve();
					await staticStarted.promise;
					finishStatic.resolve();
					finishHeavy.resolve();
				} else {
					await Promise.all([staticStarted.promise, ordinaryStarted.promise]);
					finishStatic.resolve();
					finishHeavy.resolve();
					await heavySettled.promise;
					expect(trailingSeen).toEqual([]);
					finishScripts.resolve();
				}
				await run;
				expect(scriptsSeen.toSorted()).toEqual(independent.toSorted());
				expect(scriptHomes.size).toBe(independent.length);
				expect(scriptHomes.has(undefined)).toBe(false);
				expect(trailingSeen).toEqual(["smoke/isolated native TUI PTY"]);
				expect(failures).toEqual([clockFailure, scriptFailure]);
			} finally {
				finishIsolated.resolve();
				finishScripts.resolve();
				finishStatic.resolve();
				finishHeavy.resolve();
				await run;
			}
		});
	}

	for (const failedLane of ["smoke", "startup"] as const) {
		test(`starts startup consumers before ordinary work drains and continues after ${failedLane} failure`, async () => {
			const staticStarted = Promise.withResolvers<void>();
			const ordinaryStarted = Promise.withResolvers<void>();
			const smokeStarted = Promise.withResolvers<void>();
			const startupStarted = Promise.withResolvers<void>();
			const finishStatic = Promise.withResolvers<void>();
			const finishOrdinary = Promise.withResolvers<void>();
			const finishSmoke = Promise.withResolvers<void>();
			const finishStartup = Promise.withResolvers<void>();
			const ordinarySettled = Promise.withResolvers<void>();
			const failures: unknown[] = [];
			const trailingStarted: string[] = [];
			const trailingBudgets: number[] = [];
			let ordinaryHome: string | undefined;
			let smokeHome: string | undefined;
			const revision: SourceRevision = { head: "head", dirty: false, status: "" };
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
					captureSourceRevision: async () => revision,
					scriptTestFiles: async () => [],
					cpuBudget: 16,
					bunTestSelection: async () => ({ tool: "bun", mode: "full", reason: "fixture" }),
					fastcheckCommands: async () => [{ label: "static/TS", argv: ["ts"] }],
					runGateCommands: async (_runner, commands, options) => {
						const ordinary = commands.find(command => command.label === "test/TypeScript fork feature suite");
						const startup = commands.find(command => command.label === "test/TypeScript startup suite");
						const smoke = commands.find(command => command.label === "smoke/isolated native TUI PTY");
						if (commands.some(command => command.label === "static/TS")) {
							staticStarted.resolve();
							await finishStatic.promise;
						} else if (ordinary) {
							expect(startup).toBeUndefined();
							expect(ordinary.argv).toContain("--defer-startup");
							expect(ordinary.env?.OMP_FULLTEST_AFFECTED).toBe("1");
							expect(ordinary.env?.OMP_FULLTEST_SOURCE_REVISION).toBe("head");
							ordinaryHome = ordinary.env?.HOME;
							ordinaryStarted.resolve();
							await finishOrdinary.promise;
							ordinarySettled.resolve();
							throw new Error("ordinary failure");
						} else if (smoke) {
							smokeHome = smoke.env?.HOME;
							trailingBudgets.push(Number(smoke.env?.OMP_TEST_CPU_BUDGET));
							trailingStarted.push("smoke");
							smokeStarted.resolve();
							await finishSmoke.promise;
							if (failedLane === "smoke") throw new Error("smoke failure");
						} else if (startup) {
							expect(commands).toHaveLength(1);
							expect(startup.argv).toContain("--only-startup");
							expect(startup.env?.HOME).toBeDefined();
							expect(startup.env?.HOME).not.toBe(ordinaryHome);
							expect(startup.env?.HOME).not.toBe(smokeHome);
							expect(startup.env?.OMP_FULLTEST_AFFECTED).toBe("1");
							expect(startup.env?.OMP_FULLTEST_SOURCE_REVISION).toBe("head");
							expect(startup.env?.OMP_TEST_CONCURRENCY).toBe("all");
							expect(options?.concurrency).toBe(1);
							trailingBudgets.push(Number(startup.env?.OMP_TEST_CPU_BUDGET));
							trailingStarted.push("startup");
							startupStarted.resolve();
							await finishStartup.promise;
							if (failedLane === "startup") throw new Error("startup failure");
						}
					},
				},
			);
			try {
				await Promise.all([staticStarted.promise, ordinaryStarted.promise, startupStarted.promise]);
				expect(trailingStarted).toEqual(["startup"]);
				finishOrdinary.resolve();
				await ordinarySettled.promise;
				expect(trailingStarted).toEqual(["startup"]);
				finishStatic.resolve();
				finishStartup.resolve();
				await smokeStarted.promise;
				expect(trailingStarted).toEqual(["startup", "smoke"]);
				expect(Math.max(...trailingBudgets)).toBeLessThanOrEqual(16);
				finishSmoke.resolve();
			} finally {
				finishOrdinary.resolve();
				finishStatic.resolve();
				finishSmoke.resolve();
				finishStartup.resolve();
				await run;
			}
			expect(failures.map(error => String(error))).toEqual([
				"Error: ordinary failure",
				`Error: ${failedLane} failure`,
			]);
		});
	}
	test("serializes heavy lanes on 3 CPUs without omitting suites", async () => {
		const revision: SourceRevision = { head: "head", dirty: false, status: "" };
		const seen: string[] = [];
		const staticStarted = Promise.withResolvers<void>();
		const ordinaryStarted = Promise.withResolvers<void>();
		const rustStarted = Promise.withResolvers<void>();
		const smokeStarted = Promise.withResolvers<void>();
		const finishStatic = Promise.withResolvers<void>();
		const finishOrdinary = Promise.withResolvers<void>();
		const finishRust = Promise.withResolvers<void>();
		const finishSmoke = Promise.withResolvers<void>();
		const gate = {
			signal: new AbortController().signal,
			charged: async <T>(operation: () => T | Promise<T>) => operation(),
			run: async () => {},
			childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
			record: (error: unknown) => error,
			fail: (error: unknown) => error,
		} as unknown as GateRun;
		const run = runFulltest(
			gate,
			{ debug: false, full: true },
			{
				cpuBudget: 3,
				captureSourceRevision: async () => revision,
				scriptTestFiles: async () => [],
				captureChangedPaths: async () => [],
				fastcheckCommands: async () => [{ label: "static/TS", argv: ["ts"] }],
				runGateCommands: async (_runner, commands, options) => {
					for (const command of commands) {
						seen.push(command.label);
						if (command.label === "static/TS") {
							expect(options?.concurrency).toBe(1);
							staticStarted.resolve();
							await finishStatic.promise;
						} else if (command.label === "test/TypeScript full suite") {
							expect(command.argv).toContain("--shared-fulltest-pool");
							expect(command.env?.OMP_TEST_CPU_BUDGET).toBe("1");
							expect(command.env?.OMP_FULLTEST_BUN_MAX_CAPACITY).toBeUndefined();
							ordinaryStarted.resolve();
							await finishOrdinary.promise;
						} else if (command.label === "test/Rust workspace") {
							expect(command.env?.OMP_TEST_CPU_BUDGET).toBe("1");
							rustStarted.resolve();
							await finishRust.promise;
						} else if (command.label === "smoke/isolated native TUI PTY") {
							expect(command.env?.OMP_TEST_CPU_BUDGET).toBe("3");
							smokeStarted.resolve();
							await finishSmoke.promise;
						}
					}
				},
			},
		);
		try {
			await staticStarted.promise;
			expect(seen).not.toContain("test/TypeScript full suite");
			expect(seen).not.toContain("test/Rust workspace");
			finishStatic.resolve();
			await ordinaryStarted.promise;
			expect(seen.indexOf("static/TS")).toBeLessThan(seen.indexOf("test/TypeScript full suite"));
			expect(seen).not.toContain("test/Rust workspace");
			finishOrdinary.resolve();
			await rustStarted.promise;
			expect(seen).not.toContain("smoke/isolated native TUI PTY");
			finishRust.resolve();
			await smokeStarted.promise;
			finishSmoke.resolve();
			await run;
			for (const label of [
				"test/Python suites",
				"test/Go SDK",
				"test/Rust SDK",
				"smoke/isolated native TUI PTY",
				"test/TypeScript full suite",
			])
				expect(seen).toContain(label);
		} finally {
			finishStatic.resolve();
			finishOrdinary.resolve();
			finishRust.resolve();
			finishSmoke.resolve();
			await run;
		}
	});
});

describe("gate-local profile fixture isolation", () => {
	for (const explicitExecutable of [false, true]) {
		const platform = detectBrowserPlatform();
		test.skipIf(!platform || platform === BrowserPlatform.LINUX_ARM)(
			`browser consumer reuses ${explicitExecutable ? "the explicit executable before the host cache" : "the host binary cache"} without sharing application state`,
			async () => {
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-isolation-"));
				const home = path.join(directory, "gate-home");
				const host = path.join(directory, "host");
				const cacheDir = path.join(host, "puppeteer");
				const cachedExecutable = computeExecutablePath({
					buildId: PUPPETEER_REVISIONS.chrome,
					cacheDir,
					platform,
				});
				const override = path.join(directory, "explicit-chrome");
				try {
					await Bun.write(cachedExecutable, "cached binary");
					await Bun.write(override, "explicit binary");
					const consumer = `
import { spyOn } from "bun:test";
import * as path from "node:path";
import * as browsers from "@oh-my-pi/pi-utils/browsers";
import { getAgentDir, getPuppeteerDir } from ${JSON.stringify(new URL("../packages/utils/src/dirs.ts", import.meta.url).href)};
import { ensureChromiumExecutable, loadPuppeteer } from ${JSON.stringify(new URL("../packages/coding-agent/src/tools/browser/launch.ts", import.meta.url).href)};
spyOn(browsers, "install").mockImplementation(async () => {
	throw new Error("The isolated browser consumer must reuse a local executable, not download one");
});
const executable = await ensureChromiumExecutable();
await loadPuppeteer();
const sandbox = getPuppeteerDir();
console.log(JSON.stringify({ executable, agent: getAgentDir(), sandbox, sandboxReady: await Bun.file(path.join(sandbox, "package.json")).exists() }));
`;
					const construction = `
import { localTestEnvironment } from ${JSON.stringify(new URL("./fulltest.ts", import.meta.url).href)};
const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(consumer)}], {
	env: localTestEnvironment(${JSON.stringify(home)}),
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
							PI_CODING_AGENT_DIR: "",
							OMP_PROFILE: "",
							PI_PROFILE: "",
							PI_CONFIG_DIR: "",
							OMP_CACHE_DIR: "",
							OMP_OFFLINE: "",
							XDG_DATA_HOME: "",
							XDG_STATE_HOME: "",
							XDG_CACHE_HOME: "",
							BUN_RUNTIME_TRANSPILER_CACHE_PATH:
								process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ??
								path.join(import.meta.dir, "..", "node_modules", ".cache", "bun-transpiler"),
							PUPPETEER_EXECUTABLE_PATH: explicitExecutable ? override : "",
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
					expect(JSON.parse(stdout)).toEqual({
						executable: explicitExecutable ? override : cachedExecutable,
						agent: path.join(home, ".omp", "agent"),
						sandbox: path.join(home, ".omp", "puppeteer"),
						sandboxReady: true,
					});
					expect(await Bun.file(path.join(cacheDir, "package.json")).exists()).toBe(false);
					expect(await Bun.file(cachedExecutable).text()).toBe("cached binary");
				} finally {
					await fs.rm(directory, { recursive: true, force: true });
				}
			},
			20_000,
		);
	}

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
	test("Windows subprocess trees and shared WSL cores leave headroom without changing native Unix budgets", () => {
		expect(gateCpuBudget(26, "6.18.54.1-microsoft-standard-WSL2", "linux")).toBe(13);
		expect(gateCpuBudget(2, "microsoft", "linux")).toBe(1);
		expect(gateCpuBudget(8, "5.15.153.1-microsoft-standard-WSL2", "linux")).toBe(4);
		expect(gateCpuBudget(26, "6.8.0-48-generic", "linux")).toBe(26);
		expect(gateCpuBudget(32, "10.0.26100", "win32", 32 * 1024 ** 3)).toBe(16);
		const lowMemoryBudget = gateCpuBudget(32, "10.0.26100", "win32", 5.9 * 1024 ** 3);
		expect(lowMemoryBudget).toBe(5);
		const allocation = fulltestWorkerAllocation(lowMemoryBudget, true, true, true, 12, 0);
		expect(allocation.serial).toBe(false);
		expect(allocation.ordinary).toBeGreaterThan(1);
		expect(allocation.scripts).toBe(0);
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
