import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserPlatform, computeExecutablePath, detectBrowserPlatform } from "@oh-my-pi/pi-utils/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";
import { testTimeoutMs } from "./ci-test-ts";
import { parseFastcheckArgs, gatePoolWidth } from "./fastcheck";
import {
	fulltestCommands,
	fulltestWorkerAllocation,
	gateCpuBudget,
	parseFulltestArgs,
	removeFulltestHome,
	runFulltest,
	selectChangedScriptTests,
} from "./fulltest";
import { runGate, GATE_LIMIT_SECONDS, type GateCommand, type GateRun } from "./test-gate-runtime";
import { bunRequiresFullSelection, captureChangedPaths, type SourceRevision } from "./test-gate-source";
import type { TestReportRun } from "./test-reporting";
import { runGateCommands } from "./test-gate-scheduler";

test("fork plan excludes standalone Python suites while preserving the public TUI smoke", () => {
	const commands = fulltestCommands({ debug: false }, "/tmp/home", "a".repeat(40));
	expect(commands.some(command => command.label === "smoke/isolated native TUI PTY")).toBe(true);
	expect(commands.flatMap(command => command.argv)).not.toContain("scripts/test-report-py.ts");
});

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
		expect(normal.some(command => command.label === "test/compact_display")).toBe(false);
	}
});

test("fork and full plans never schedule the independently authorized packaged workbench verifier", () => {
	for (const full of [false, true]) {
		const commands = fulltestCommands({ debug: false, full }, "/tmp/home");
		expect(commands.some(command => command.label === "smoke/isolated native TUI PTY")).toBe(true);
		for (const command of commands) {
			expect(command.argv.some(arg => arg.includes("verify-aireq-workbench-package"))).toBe(false);
			expect(command.argv.some(arg => /(?:bundle-dist|build-binary|compile-binary)\.ts$/.test(arg))).toBe(false);
		}
	}
});

test("both TypeScript lanes use the available worker budget in fork and full plans", () => {
	for (const full of [false, true]) {
		const commands = fulltestCommands({ debug: false, full }, "/tmp/home");
		for (const label of ["test/TypeScript fork feature suite", "test/TypeScript startup suite"]) {
			expect(commands.find(command => command.label === label)?.env?.OMP_TEST_CONCURRENCY).toBe("all");
		}
	}
});

describe("fulltest worker allocation", () => {
	test("bounds startup, ordinary and Rust overlap while preserving static headroom", () => {
		for (let cores = 1; cores <= 64; cores++) {
			const capacity = Math.max(1, Math.min(28, cores) - 4);
			for (const ordinary of [false, true]) {
				for (const rust of [false, true]) {
					for (const startup of [false, true]) {
						const allocation = fulltestWorkerAllocation(cores, ordinary, rust, startup);
						const workers = [allocation.ordinary, allocation.rust, allocation.startup];
						for (const [index, enabled] of [ordinary, rust, startup].entries()) {
							expect(workers[index]! > 0).toBe(enabled);
							expect(Number.isInteger(workers[index])).toBe(true);
						}
						const peak = allocation.serial
							? Math.max(...workers)
							: workers.reduce((sum, count) => sum + count, 0);
						expect(peak).toBeLessThanOrEqual(capacity);
						if (rust && ordinary) expect(allocation.rust).toBeLessThanOrEqual(4);
						expect(allocation.serial).toBe(
							capacity < Math.max(2, Number(ordinary) + Number(rust) + Number(startup)),
						);
					}
				}
			}
		}
	});
});

test("script selection uses changed modules and existing tests, not business files or a clean tree", () => {
	const files = [
		"scripts/fulltest.test.ts",
		"scripts/ci-test-ts.test.ts",
		"scripts/test-reporting.test.ts",
		"scripts/test-gate-delta.test.ts",
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
	expect(selectChangedScriptTests(["scripts/test-gate-delta.ts"], files)).toEqual([
		"scripts/fulltest.test.ts",
		"scripts/run-rs-task.test.ts",
		"scripts/test-gate-delta.test.ts",
	]);
	expect(selectChangedScriptTests(["scripts/release.test.ts", "scripts/unknown.ts"], files)).toEqual([
		"scripts/release.test.ts",
	]);
});

test("Bun traces only known static inputs; unknown and dynamic inputs fall back", () => {
	expect(bunRequiresFullSelection([])).toBe(false);
	expect(bunRequiresFullSelection(["packages/coding-agent/src/tools/knowledge-search.ts"])).toBe(false);
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
	expect(bunRequiresFullSelection([...docs, "packages/coding-agent/src/tools/knowledge-search.ts"])).toBe(false);
	expect(bunRequiresFullSelection([...docs, "Cargo.lock"])).toBe(true);
	expect(bunRequiresFullSelection(["packages/coding-agent/src/prompts/system.md"])).toBe(true);
	expect(bunRequiresFullSelection(["packages/coding-agent/docs/guide.md"])).toBe(true);
});

test("fulltest uses cargo-delta for Rust independently of Bun and bypasses it for --full", async () => {
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
		{ changed: ["packages/coding-agent/src/tools/knowledge-search.ts"], packages: [], full: false, bunFull: false },
		{ changed: ["Cargo.lock"], packages: [], full: false, bunFull: true },
		{
			changed: ["packages/coding-agent/src/tools/knowledge-search.ts"],
			packages: ["pi-knowledge", "other-crate"],
			full: false,
			bunFull: false,
		},
		{
			changed: ["packages/coding-agent/src/tools/knowledge-search.ts"],
			packages: ["other-crate"],
			full: false,
			bunFull: false,
		},
		{ changed: ["Cargo.lock"], packages: ["pi-natives"], full: false, bunFull: true },
		{ changed: ["packages/coding-agent/src/tools/knowledge-search.ts"], packages: [], full: true, bunFull: true },
	] as const;
	for (const scenario of cases) {
		const commands: { label: string; argv: readonly string[]; env?: Record<string, string | undefined> }[] = [];
		let observedBase: string | undefined;
		let deltaBase: string | undefined;
		let deltaCalls = 0;
		await runFulltest(
			gate,
			{ debug: false, full: scenario.full },
			{
				cpuBudget: 28,
				captureSourceRevision: async () => revision,
				scriptTestFiles: async () => [],
				captureChangedPaths: async (_gate, _root, base) => {
					observedBase = base;
					return [...scenario.changed];
				},
				bunTestSelection: async () => ({ tool: "bun", mode: "affected", baseline }),
				selectRustPackages: async (_gate, _root, base) => {
					deltaCalls++;
					deltaBase = base;
					return {
						tool: "cargo-delta",
						mode: "affected",
						baseline,
						packages: [...scenario.packages],
						reason: "fixture",
					};
				},
				fastcheckCommands: async () => [],
				runGateCommands: async (_gate, selected) => {
					commands.push(...selected);
				},
			},
		);
		expect(observedBase).toBe(scenario.full ? "HEAD" : baseline);
		expect(deltaCalls).toBe(scenario.full ? 0 : 1);
		if (!scenario.full) expect(deltaBase).toBe(baseline);
		const rust = commands.filter(
			command => command.label === (scenario.full ? "test/Rust workspace" : "test/Rust fork features"),
		);
		const forkAffected = scenario.packages.some(pkg => pkg === "pi-knowledge" || pkg === "pi-natives");
		expect(rust).toHaveLength(scenario.full || forkAffected ? 1 : 0);
		if (rust.length) {
			expect(rust[0]!.argv).toEqual([
				"bun",
				"scripts/run-rs-task.ts",
				"test:rs",
				...(scenario.full ? ["--full"] : []),
			]);
			if (!scenario.full) {
				expect(JSON.parse(rust[0]!.env!.OMP_RUST_DELTA_SELECTION!)).toMatchObject({
					tool: "cargo-delta",
					mode: "affected",
					baseline,
					packages: [...scenario.packages],
				});
				expect(JSON.parse(rust[0]!.env!.OMP_FULLTEST_CHANGED_PATHS!)).toEqual([...scenario.changed]);
			}
		}
		expect(commands.some(command => command.label === "smoke/isolated native TUI PTY")).toBe(true);
		const ts = commands.filter(command => command.label.startsWith("test/TypeScript"));
		expect(ts).toHaveLength(2);
		expect(ts.map(command => command.env?.OMP_FULLTEST_BASELINE)).toEqual(
			scenario.bunFull ? ["none", "none"] : [baseline, baseline],
		);
	}
});

test("delta failure and absence of a qualified baseline retain the full Rust fork", async () => {
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
	for (const missingBaseline of [false, true]) {
		const commands: { label: string; env?: Record<string, string | undefined> }[] = [];
		let deltaBase: string | undefined;
		await runFulltest(
			gate,
			{ debug: false },
			{
				captureSourceRevision: async () => revision,
				scriptTestFiles: async () => [],
				captureChangedPaths: async () => [],
				bunTestSelection: async () =>
					missingBaseline
						? { tool: "bun", mode: "full", reason: "no baseline" }
						: { tool: "bun", mode: "affected", baseline },
				selectRustPackages: async (_gate, _root, base) => {
					deltaBase = base;
					throw new Error("delta unavailable");
				},
				fastcheckCommands: async () => [],
				runGateCommands: async (_gate, selected) => {
					commands.push(...selected);
				},
			},
		);
		expect(deltaBase).toBe(missingBaseline ? undefined : baseline);
		const rust = commands.filter(command => command.label.startsWith("test/Rust"));
		expect(rust).toHaveLength(1);
		expect(JSON.parse(rust[0]!.env!.OMP_RUST_DELTA_SELECTION!)).toMatchObject({
			tool: "cargo-delta",
			mode: "full",
			packages: ["pi-knowledge", "pi-natives"],
		});
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
	const report = { owner: true } as TestReportRun;
	const gate = {
		signal: new AbortController().signal,
		charged: async <T>(operation: () => T | Promise<T>) => operation(),
		run: async () => {},
		childGate: async (_level: string, work: (child: GateRun) => Promise<unknown>) => work(gate),
		record: (error: unknown) => error,
		fail: (error: unknown) => error,
	} as unknown as GateRun;
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
			selectRustPackages: async () => ({
				tool: "cargo-delta",
				mode: "full",
				packages: ["pi-knowledge", "pi-natives"],
				reason: "fixture",
			}),
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
});

for (const full of [false, true]) {
	test(`${full ? "full" : "fork"} fulltest collects ordinary failures and runs the remaining suites`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-lanes-"));
		const worker = path.join(directory, "worker.ts");
		const ordinaryLabel = "test/TypeScript fork feature suite";
		const startupLabel = "test/TypeScript startup suite";
		const rustLabel = full ? "test/Rust workspace" : "test/Rust fork features";
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
const ordinary = "test/TypeScript fork feature suite";
await fs.appendFile(file(label, "start"), JSON.stringify({
  argv: JSON.parse(originalArgv),
  home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
  configRoot: process.env.OMP_CONFIG_ROOT,
  affected: process.env.OMP_FULLTEST_AFFECTED,
  budget: process.env.OMP_TEST_CPU_BUDGET,
  nativeFinished: await exists(file("build/native", "end")),
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
						selectRustPackages: async () => ({
							tool: "cargo-delta",
							mode: "full",
							packages: ["pi-knowledge", "pi-natives"],
							reason: "fixture",
						}),
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
			const rust = await starts(rustLabel);
			expect(ordinary).toHaveLength(1);
			expect(startup).toHaveLength(1);
			expect(rust).toHaveLength(1);
			expect(ordinary[0]!.nativeFinished).toBe(true);
			expect(rust[0]!.nativeFinished).toBe(true);
			expect(startup[0]!.nativeFinished).toBe(true);
			expect((await starts("static/TS"))[0]!.nativeFinished).toBe(true);
			expect(ordinary[0]!.argv).toContain("--defer-startup");
			expect(startup[0]!.argv).toContain("--only-startup");
			expect(ordinary[0]!.home).toBeDefined();
			expect(startup[0]!.home).toBeDefined();
			expect(startup[0]!.home).not.toBe(ordinary[0]!.home);
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
		test(`releases Rust tests independently of TypeScript static checks when Rust checks are ${rustCheck}`, async () => {
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
				{ debug: false },
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

	test("cancels active startup and ordinary lanes through the shared gate signal", async () => {
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
				if (active.size === 2) started.resolve();
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
			expect(cancelled.toSorted()).toEqual(["test/TypeScript fork feature suite", "test/TypeScript startup suite"]);
		} finally {
			controller.abort(interruption);
			await run;
		}
	});

	for (const inheritedBudget of [2, 6]) {
		test(`respects the caller's ${inheritedBudget}-worker ceiling across concurrent pools`, async () => {
			const previousBudget = process.env.OMP_TEST_CPU_BUDGET;
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
						scriptTestFiles: async () => ["scripts/ci-test-ts.test.ts"],
						fastcheckCommands: async () => [],
						runGateCommands: async (_runner, selected, options) => {
							commands.push(...selected);
							if (selected.some(command => command.argv[2] === "scripts/ci-test-ts.test.ts"))
								scriptConcurrency = options?.concurrency;
						},
					},
				);
				const budgetOf = (label: string) =>
					Number(commands.find(command => command.label === label)?.env?.OMP_TEST_CPU_BUDGET);
				expect(scriptConcurrency).toBe(inheritedBudget <= 6 ? 1 : 2);
				const workers = [
					budgetOf("test/TypeScript fork feature suite"),
					budgetOf("test/Rust workspace"),
					budgetOf("test/TypeScript startup suite"),
				];
				const peak = inheritedBudget <= 6 ? Math.max(...workers) : workers.reduce((sum, count) => sum + count, 0);
				expect(peak).toBeLessThanOrEqual(Math.max(1, inheritedBudget - 4));
				expect(budgetOf("smoke/isolated native TUI PTY")).toBeLessThanOrEqual(inheritedBudget);
			} finally {
				if (previousBudget === undefined) delete process.env.OMP_TEST_CPU_BUDGET;
				else process.env.OMP_TEST_CPU_BUDGET = previousBudget;
			}
		});
	}

	for (const cpuBudget of [1, 5, 6, 28]) {
		test(`keeps clock selftests isolated and bounds independent script workers on ${cpuBudget} CPUs`, async () => {
			const independent = [
				"scripts/ci-test-ts.test.ts",
				"scripts/fulltest.test.ts",
				"scripts/run-rs-task.test.ts",
				"scripts/slowtest.test.ts",
				"scripts/test-reporting.test.ts",
			];
			const isolated = [
				"scripts/slowtest-wsl-stage.test.ts",
				"scripts/stamp-native-version.test.ts",
				"scripts/test-gate-runtime.test.ts",
			];
			const isolatedStarted = Promise.withResolvers<void>();
			const finishIsolated = Promise.withResolvers<void>();
			const scriptsStarted = Promise.withResolvers<void>();
			const finishScripts = Promise.withResolvers<void>();
			const staticStarted = Promise.withResolvers<void>();
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
			const serial = cpuBudget <= 6;
			let activeScripts = 0;
			let activeHeavyWorkers = 0;
			let isolatedActive = false;
			let heavyFinished = 0;
			let ordinaryHasStarted = false;
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
						expect(activeScripts).toBeLessThanOrEqual(serial ? 1 : 2);
						expect(activeScripts + activeHeavyWorkers).toBeLessThanOrEqual(cpuBudget);
						if (activeScripts === (serial ? 1 : 2)) scriptsStarted.resolve();
						await finishScripts.promise;
						activeScripts--;
						if (file === independent[0]) throw scriptFailure;
					} else if (
						command.label === "static/TS" ||
						command.label === "test/TypeScript fork feature suite" ||
						command.label === "test/TypeScript startup suite" ||
						command.label === "test/Rust workspace"
					) {
						expect(isolatedActive).toBe(false);
						expect(isolatedFinished.toSorted()).toEqual(isolated.toSorted());
						const workers = Number(command.env?.OMP_TEST_CPU_BUDGET ?? 1);
						activeHeavyWorkers += workers;
						expect(activeScripts + activeHeavyWorkers).toBeLessThanOrEqual(cpuBudget);
						if (command.label === "static/TS") staticStarted.resolve();
						if (command.label === "test/TypeScript fork feature suite") {
							ordinaryHasStarted = true;
							ordinaryStarted.resolve();
						}
						await finishHeavy.promise;
						activeHeavyWorkers -= workers;
						if (++heavyFinished === 4) heavySettled.resolve();
					} else if (command.label === "smoke/isolated native TUI PTY") {
						expect(activeScripts).toBe(0);
						expect(activeHeavyWorkers).toBe(0);
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
				await scriptsStarted.promise;
				if (serial) {
					expect(ordinaryHasStarted).toBe(false);
					finishScripts.resolve();
					await staticStarted.promise;
					finishHeavy.resolve();
				} else {
					await Promise.all([staticStarted.promise, ordinaryStarted.promise]);
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
				finishHeavy.resolve();
				await run;
			}
		});
	}

	for (const failedLane of ["smoke", "startup"] as const) {
		test(`starts startup consumers before ordinary work drains and continues after ${failedLane} failure`, async () => {
			const staticStarted = Promise.withResolvers<void>();
			const ordinaryStarted = Promise.withResolvers<void>();
			const rustStarted = Promise.withResolvers<void>();
			const smokeStarted = Promise.withResolvers<void>();
			const startupStarted = Promise.withResolvers<void>();
			const finishStatic = Promise.withResolvers<void>();
			const finishOrdinary = Promise.withResolvers<void>();
			const finishRust = Promise.withResolvers<void>();
			const finishSmoke = Promise.withResolvers<void>();
			const finishStartup = Promise.withResolvers<void>();
			const ordinarySettled = Promise.withResolvers<void>();
			const rustSettled = Promise.withResolvers<void>();
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
						} else if (commands.some(command => command.label.startsWith("test/Rust"))) {
							rustStarted.resolve();
							await finishRust.promise;
							rustSettled.resolve();
							throw new Error("Rust failure");
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
				await Promise.all([
					staticStarted.promise,
					ordinaryStarted.promise,
					rustStarted.promise,
					startupStarted.promise,
				]);
				expect(trailingStarted).toEqual(["startup"]);
				finishOrdinary.resolve();
				await ordinarySettled.promise;
				expect(trailingStarted).toEqual(["startup"]);
				finishRust.resolve();
				await rustSettled.promise;
				expect(trailingStarted).toEqual(["startup"]);
				finishStatic.resolve();
				finishStartup.resolve();
				await smokeStarted.promise;
				expect(trailingStarted).toEqual(["startup", "smoke"]);
				expect(Math.max(...trailingBudgets)).toBeLessThanOrEqual(16);
				finishSmoke.resolve();
			} finally {
				finishOrdinary.resolve();
				finishRust.resolve();
				finishStatic.resolve();
				finishSmoke.resolve();
				finishStartup.resolve();
				await run;
			}
			expect(failures.map(error => String(error))).toEqual([
				"Error: ordinary failure",
				"Error: Rust failure",
				`Error: ${failedLane} failure`,
			]);
		});
	}
	for (const cpuBudget of [1, 2, 4, 5]) {
		test(`serializes heavy lanes on ${cpuBudget} CPUs without omitting suites`, async () => {
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
					cpuBudget,
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
							} else if (command.label === "test/TypeScript fork feature suite") {
								expect(command.env?.OMP_TEST_CPU_BUDGET).toBe("1");
								ordinaryStarted.resolve();
								await finishOrdinary.promise;
							} else if (command.label === "test/Rust workspace") {
								expect(command.env?.OMP_TEST_CPU_BUDGET).toBe("1");
								rustStarted.resolve();
								await finishRust.promise;
							} else if (command.label === "smoke/isolated native TUI PTY") {
								expect(command.env?.OMP_TEST_CPU_BUDGET).toBe(String(Math.min(3, cpuBudget)));
								smokeStarted.resolve();
								await finishSmoke.promise;
							}
						}
					},
				},
			);
			try {
				await staticStarted.promise;
				expect(seen).not.toContain("test/TypeScript fork feature suite");
				expect(seen).not.toContain("test/Rust workspace");
				finishStatic.resolve();
				await ordinaryStarted.promise;
				expect(seen.indexOf("test/TypeScript startup suite")).toBeLessThan(
					seen.indexOf("test/TypeScript fork feature suite"),
				);
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
					"test/TypeScript startup suite",
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
	}
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
	test("WSL hosts halve the pool-sizing core budget; native hosts stay unchanged", () => {
		expect(gateCpuBudget(26, "6.18.54.1-microsoft-standard-WSL2")).toBe(13);
		expect(gateCpuBudget(2, "microsoft")).toBe(1);
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
