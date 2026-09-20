import { describe, expect, test } from "bun:test";
import {
	buildFulltestPhases,
	CORE_RUST_CRATES,
	type GroupChild,
	type GroupRunPlan,
	parseFulltestArgs,
	runGroupPool,
	WHITELIST_TEST_GROUPS,
} from "./fulltest.ts";

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

	test("the static stage reuses the fastcheck gate without its quick-feedback budget", () => {
		// Regression: fulltest used to inherit fastcheck's 60s hard budget, so a
		// cold Rust cache killed the whole run at its very first phase.
		const fastcheck = buildFulltestPhases(options).find(phase => phase.label === "static/fastcheck");
		expect(fastcheck?.env).toEqual({ FASTCHECK_BUDGET_MS: "0" });
	});

	test("rust env is forwarded to the Rust phases only", () => {
		const phases = buildFulltestPhases({ ...options, rustEnv: { PATH: "augmented" } });
		expect(phases.filter(phase => phase.env !== undefined).map(phase => phase.label)).toEqual([
			"static/fastcheck",
			"rust/compile",
			"rust/core",
		]);
		const rust = phases.find(phase => phase.label === "rust/core");
		expect(rust?.env).toEqual({ PATH: "augmented" });
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
		expect(tuiGroup?.files).toContain("test/macos-spelling.test.ts");
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

function groupPlan(label: string): GroupRunPlan {
	return { label, cwd: "packages/x", argv: ["bun", "test", "example.test.ts"] };
}

/** A child whose exit only ever happens via kill() or an explicit exit() call. */
function hangingChild(): GroupChild & { exit(code: number): void } {
	const { promise, resolve } = Promise.withResolvers<number>();
	return { exited: promise, kill: () => resolve(137), exit: resolve };
}

describe("runGroupPool", () => {
	test("runs every group within the concurrency bound and reports failures", async () => {
		const started: string[] = [];
		let active = 0;
		let maxActive = 0;
		const failures = await runGroupPool([groupPlan("a"), groupPlan("b"), groupPlan("c")], {
			label: "ts/test",
			concurrency: 2,
			spawn: plan => {
				started.push(plan.label);
				active++;
				maxActive = Math.max(maxActive, active);
				const code = plan.label === "b" ? 1 : 0;
				return { exited: Promise.resolve(code).finally(() => active--), kill: () => {} };
			},
		});
		expect(started.sort()).toEqual(["a", "b", "c"]);
		expect(maxActive).toBe(2);
		expect(failures).toEqual([{ label: "b", exitCode: 1 }]);
	});

	test("expiry stops the queue instead of only killing the running children", async () => {
		// Regression: the timeout verdict only killed the active children, and
		// their workers then drained the remaining queued groups — the phase
		// kept burning CPU after fulltest had already printed its FAIL verdict.
		const started: string[] = [];
		const run = runGroupPool(["g1", "g2", "g3", "g4", "g5", "g6"].map(groupPlan), {
			label: "ts/test",
			concurrency: 2,
			timeoutMs: 100,
			spawn: plan => {
				started.push(plan.label);
				return hangingChild();
			},
		});
		await expect(run).rejects.toThrow("exceeded the");
		await Bun.sleep(100);
		expect(started).toEqual(["g1", "g2"]);
	});
});
