import { describe, expect, test } from "bun:test";
import { buildFulltestPhases, CORE_RUST_CRATES, parseFulltestArgs, WHITELIST_TEST_GROUPS } from "./fulltest.ts";

const options = { debug: false, cargoBinary: "cargo", rustEnv: undefined };

describe("fulltest phase plan", () => {
	test("phases run in contract order with the expected entries", () => {
		const phases = buildFulltestPhases(options);
		expect(phases.map(phase => phase.label)).toEqual([
			"static/fastcheck",
			"build/native",
			"ts/whitelist",
			"rust/compile",
			"rust/core",
			"scripts",
			"ui/smoke",
		]);
	});

	test("only test-execution phases carry the timeout flag", () => {
		const phases = buildFulltestPhases(options);
		expect(phases.filter(phase => phase.timed).map(phase => phase.label)).toEqual([
			"rust/core",
			"scripts",
			"ui/smoke",
		]);
	});

	test("Rust compile is untimed and warms exactly the core crates' test binaries", () => {
		const compile = buildFulltestPhases(options).find(phase => phase.label === "rust/compile");
		expect(compile?.argv).toEqual(["cargo", "test", "--no-run", ...CORE_RUST_CRATES.flatMap(crate => ["-p", crate])]);
		expect(compile?.timed).toBeFalsy();
	});

	test("Rust phase targets exactly the fork core crates via nextest", () => {
		const rust = buildFulltestPhases(options).find(phase => phase.label === "rust/core");
		expect(rust?.argv).toEqual(["cargo", "nextest", "run", ...CORE_RUST_CRATES.flatMap(crate => ["-p", crate])]);
		// pi-builtins stays out of local verification by contract.
		expect(CORE_RUST_CRATES).not.toContain("pi-builtins");
	});

	test("--debug only reaches the UI smoke phase", () => {
		const phases = buildFulltestPhases({ ...options, debug: true });
		const withDebug = phases.filter(phase => phase.argv.includes("--debug"));
		expect(withDebug.map(phase => phase.label)).toEqual(["ui/smoke"]);
	});

	test("resolved cargo binary is used instead of a PATH lookup", () => {
		const rust = buildFulltestPhases({ ...options, cargoBinary: "C:/toolchain/cargo.exe" }).find(
			phase => phase.label === "rust/core",
		);
		expect(rust?.argv[0]).toBe("C:/toolchain/cargo.exe");
	});

	test("rust env is forwarded to the Rust phases only", () => {
		const phases = buildFulltestPhases({ ...options, rustEnv: { PATH: "augmented" } });
		expect(phases.filter(phase => phase.env !== undefined).map(phase => phase.label)).toEqual([
			"rust/compile",
			"rust/core",
		]);
	});
});

describe("whitelist green set", () => {
	test("groups are non-empty with unique labels, package cwds, and test files", () => {
		expect(WHITELIST_TEST_GROUPS.length).toBeGreaterThan(0);
		const labels = WHITELIST_TEST_GROUPS.map(group => group.label);
		expect(new Set(labels).size).toBe(labels.length);
		for (const group of WHITELIST_TEST_GROUPS) {
			expect(group.cwd.startsWith("packages/")).toBe(true);
			expect(group.files.length).toBeGreaterThan(0);
			for (const file of group.files) {
				expect(file.endsWith(".test.ts")).toBe(true);
				expect(file.startsWith("test/") || file.startsWith("bench/")).toBe(true);
			}
		}
	});

	test("fork feature tests stay in the local green set", () => {
		const forkGroup = WHITELIST_TEST_GROUPS.find(group => group.label === "coding-agent/fork-features");
		expect(forkGroup?.files).toContain("test/modes/fullsend.test.ts");
		expect(forkGroup?.files).toContain("test/slash-commands/jch-git.test.ts");
		const tuiGroup = WHITELIST_TEST_GROUPS.find(group => group.label === "core/tui");
		expect(tuiGroup?.files).toContain("test/magic-keywords.test.ts");
	});
});

describe("parseFulltestArgs", () => {
	test("no arguments defaults to a non-debug run", () => {
		expect(parseFulltestArgs([])).toEqual({ debug: false });
	});

	test("--debug opts into the UI smoke dump", () => {
		expect(parseFulltestArgs(["--debug"])).toEqual({ debug: true });
	});

	test("unknown or mixed arguments are rejected", () => {
		expect(parseFulltestArgs(["full"])).toBeNull();
		expect(parseFulltestArgs(["--debug", "extra"])).toBeNull();
	});
});
