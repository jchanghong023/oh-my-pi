import { describe, expect, test } from "bun:test";
import { buildFulltestPhases, parseFulltestArgs, resolveForkTestBatches } from "./fulltest";

describe("fulltest phase plan", () => {
	test("runs the thin upstream-delegating phases in contract order", () => {
		const phases = buildFulltestPhases({ debug: false });
		expect(phases.map(phase => phase.label)).toEqual([
			"static/check:ts",
			"build/native",
			"ts/fork",
			"rust/workspace",
			"scripts",
			"ui/smoke",
		]);
		expect(phases[0]!.argv).toEqual(["bun", "run", "check:ts"]);
		expect(phases[3]!.argv).toEqual(["bun", "run", "test:rs"]);
		// The static phase stays at check:ts while upstream's own Windows-only
		// code fails clippy on the pinned nightly; the Rust phase forces the CI
		// semantic so run-rs-task's local-dev self-skip cannot hollow out the
		// deliberate full test gate.
		expect(phases[0]!.env).toBeUndefined();
		expect(phases[3]!.env).toEqual({ CI: "1" });
	});

	test("forwards --debug only to the ui/smoke phase", () => {
		const phases = buildFulltestPhases({ debug: true });
		expect(phases.at(-1)!.argv).toEqual(["bun", "scripts/fulltest-ui-smoke.ts", "--debug"]);
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
