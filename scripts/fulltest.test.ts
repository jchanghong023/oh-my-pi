import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testTimeoutMs } from "./ci-test-ts";
import { parseFastcheckArgs, gatePoolWidth } from "./fastcheck";
import { fulltestCommands, gateCpuBudget, parseFulltestArgs, removeFulltestHome } from "./fulltest";
import { runGate } from "./test-gate-runtime";

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
			/fulltest: FAIL total=\d+\.\ds compile_excluded=\d+\.\ds budgeted=\d+\.\ds limit=900\.0s exit=2/,
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

describe("complete fork-delta TS selection", () => {
	test("selects existing changed tests anywhere in a package, with package-local execution", () => {
		const changedTests = [
			"packages/metaharness/adapters/edit/runner.test.ts",
			"packages/coding-agent/src/edit/auto-repair.test.ts",
			"packages/collab-web/test/markdown.test.tsx",
		];
		const desktop = "packages/natives/test/desktop.test.ts";
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const commands = fulltestCommands({ debug: false }, path.join(os.tmpdir(), "omp-selection-home"), [
				...changedTests,
				"packages/metaharness/adapters/edit/runner.ts",
				"packages/metaharness/adapters/edit/removed-runner.test.ts",
				desktop,
			]);
			const tests = commands.filter(command => command.label.startsWith("test/fork "));
			expect(tests.map(command => command.label)).toEqual(changedTests.map(file => `test/fork ${file}`));
			for (const [index, file] of changedTests.entries()) {
				const separator = file.indexOf("/", "packages/".length);
				expect(tests[index].cwd).toBe(path.resolve(import.meta.dir, "..", file.slice(0, separator)));
				expect(tests[index].argv).toEqual([
					"bun",
					"../../scripts/test-report-bun.ts",
					"--bail=1",
					`--timeout=${testTimeoutMs()}`,
					file.slice(separator + 1),
				]);
			}
			expect(log.mock.calls).toContainEqual([`NOT_RUN_SEPARATE_USER_INSTRUCTION_REQUIRED: ${desktop}`]);
		} finally {
			log.mockRestore();
		}
	});

	test("does not discover unchanged workspace tests when the delta has no package tests", () => {
		const commands = fulltestCommands({ debug: false }, path.join(os.tmpdir(), "omp-selection-home"), [
			"packages/metaharness/adapters/edit/runner.ts",
			"scripts/fulltest.test.ts",
		]);
		expect(commands.map(command => command.label)).toEqual([
			"test/Rust affected crates",
			"smoke/isolated dev TUI PTY",
		]);
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
		expect(parseFastcheckArgs(["--limit-seconds=90"])).toEqual({ limitSeconds: 90 });
		for (const args of [
			["--limit-seconds=90.01"],
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
		expect(parseFulltestArgs(["--limit-seconds=900", "--debug"])).toEqual({ debug: true, limitSeconds: 900 });
		expect(parseFulltestArgs(["--debug", "--limit-seconds=0.25"])).toEqual({ debug: true, limitSeconds: 0.25 });
		for (const args of [
			["--limit-seconds=900.01"],
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
