import { describe, expect, test } from "bun:test";
import { buildFulltestPhases, parseFulltestArgs, resolveForkTestBatches, selectUpstreamBaselineRef } from "./fulltest";

describe("fulltest phase plan", () => {
	test("runs the thin upstream-delegating phases in contract order", () => {
		const phases = buildFulltestPhases({ debug: false }, ["crates/pi-edit/src/lib.rs", "packages/utils/src/x.ts"]);
		expect(phases.map(phase => phase.label)).toEqual([
			"static/check:ts",
			"build/native",
			"ts/fork",
			"rust/affected",
			"scripts",
			"ui/smoke",
		]);
		expect(phases[0]!.argv).toEqual(["bun", "run", "check:ts"]);
		expect(phases[3]!.argv).toEqual(["bun", "run", "test:rs", "--affected"]);
		// The static phase stays at check:ts while upstream's own Windows-only
		// code fails clippy on the pinned nightly; the Rust phase forces the CI
		// semantic so run-rs-task's local-dev self-skip cannot hollow out the
		// deliberate gate, and hands the fork-diff paths to the affected-crate
		// selection.
		expect(phases[0]!.env).toBeUndefined();
		expect(phases[3]!.env).toEqual({
			CI: "1",
			OMP_FULLTEST_CHANGED_PATHS: JSON.stringify(["crates/pi-edit/src/lib.rs", "packages/utils/src/x.ts"]),
		});
	});

	test("forwards --debug only to the ui/smoke phase", () => {
		const phases = buildFulltestPhases({ debug: true }, []);
		expect(phases.at(-1)!.argv).toEqual(["bun", "scripts/fulltest-ui-smoke.ts", "--debug"]);
	});

	test("documentation-only crate changes do not select Rust tests, but embedded Markdown still does", () => {
		const paths = [
			"crates/pi-shell/README.md",
			"crates/pi-edit/docs/design.md",
			"docs-zh-CN/requirements/fork.md",
			"crates/pi-edit/prompts/patch.md",
			"crates/pi-edit/src/context.md",
			"crates/pi-shell/src/lib.rs",
		];
		const rustPhase = buildFulltestPhases({ debug: false }, paths).find(phase => phase.label === "rust/affected")!;
		expect(JSON.parse(rustPhase.env!.OMP_FULLTEST_CHANGED_PATHS!)).toEqual([
			"crates/pi-edit/prompts/patch.md",
			"crates/pi-edit/src/context.md",
			"crates/pi-shell/src/lib.rs",
		]);
		const docsOnly = buildFulltestPhases({ debug: false }, paths.slice(0, 3)).find(
			phase => phase.label === "rust/affected",
		)!;
		expect(JSON.parse(docsOnly.env!.OMP_FULLTEST_CHANGED_PATHS!)).toEqual([]);
	});
});

describe("parseFulltestArgs", () => {
	test("accepts no args and --debug; rejects anything else", () => {
		expect(parseFulltestArgs([])).toEqual({ debug: false });
		expect(parseFulltestArgs(["--debug"])).toEqual({ debug: true });
		expect(parseFulltestArgs(["--debug", "--debug"])).toEqual({ debug: true });
		expect(parseFulltestArgs(["--other"])).toBeNull();
		expect(parseFulltestArgs(["--debug", "--extra"])).toBeNull();
	});
});

describe("resolveForkTestBatches", () => {
	const allExist = () => true;

	test("groups fork test files by package and keeps upstream-shaped noise out", () => {
		const batches = resolveForkTestBatches(
			[
				"packages/coding-agent/src/main.ts",
				"packages/coding-agent/test/team/controller.test.ts",
				"packages/coding-agent/test/wiki-tool.test.ts",
				"packages/coding-agent/src/edit/auto-repair.test.ts",
				"packages/tui/test/fork-default-keybindings.test.ts",
				"packages/utils/src/ptree.ts",
				"docs-zh-CN/requirements/fork.md",
				"packages/coding-agent/test/fixtures/helper.ts",
			],
			allExist,
		);
		expect(batches).toEqual([
			{
				cwd: "packages/coding-agent",
				files: ["src/edit/auto-repair.test.ts", "test/team/controller.test.ts", "test/wiki-tool.test.ts"],
			},
			{ cwd: "packages/tui", files: ["test/fork-default-keybindings.test.ts"] },
		]);
	});

	test("drops files that no longer exist on disk (reverted/renamed diffs)", () => {
		const batches = resolveForkTestBatches(
			["packages/coding-agent/test/gone.test.ts", "packages/coding-agent/test/kept.test.ts"],
			file => file.endsWith("kept.test.ts"),
		);
		expect(batches).toEqual([{ cwd: "packages/coding-agent", files: ["test/kept.test.ts"] }]);
	});

	test("returns nothing when no package test differs", () => {
		expect(resolveForkTestBatches(["packages/coding-agent/src/cli.ts", "scripts/fulltest.ts"], allExist)).toEqual([]);
	});
});

describe("upstream baseline discovery", () => {
	test("a local mirror wins even when remote mirrors disagree", () => {
		expect(
			selectUpstreamBaselineRef([
				{ name: "refs/remotes/github/upstream", commit: "remote" },
				{ name: "refs/heads/upstream", commit: "local" },
				{ name: "refs/remotes/origin/upstream", commit: "other-remote" },
			]),
		).toBe("refs/heads/upstream");
	});

	test("fresh clones can use a renamed remote's exact upstream mirror", () => {
		expect(
			selectUpstreamBaselineRef([
				{ name: "refs/remotes/github/main", commit: "fork" },
				{ name: "refs/remotes/github/upstream/main", commit: "not-the-mirror" },
				{ name: "refs/remotes/github/upstream", commit: "baseline" },
			]),
		).toBe("refs/remotes/github/upstream");
	});

	test("equal remote mirrors choose deterministically without changing the baseline", () => {
		const mirrors = [
			{ name: "refs/remotes/zcode/upstream", commit: "baseline" },
			{ name: "refs/remotes/github/upstream", commit: "baseline" },
		];
		expect(selectUpstreamBaselineRef(mirrors)).toBe("refs/remotes/github/upstream");
		expect(selectUpstreamBaselineRef([...mirrors].reverse())).toBe("refs/remotes/github/upstream");
		expect(
			selectUpstreamBaselineRef([...mirrors, { name: "refs/remotes/origin/upstream", commit: "baseline" }]),
		).toBe("refs/remotes/origin/upstream");
	});

	test("missing or conflicting mirrors fail instead of selecting an unrelated baseline", () => {
		expect(() => selectUpstreamBaselineRef([{ name: "refs/remotes/github/main", commit: "fork" }])).toThrow(
			"needs the upstream baseline",
		);
		expect(() =>
			selectUpstreamBaselineRef([
				{ name: "refs/remotes/github/upstream", commit: "one" },
				{ name: "refs/remotes/origin/upstream", commit: "two" },
			]),
		).toThrow("conflicting remote upstream baselines");
	});
});
