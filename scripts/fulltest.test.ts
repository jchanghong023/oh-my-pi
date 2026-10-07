import { describe, expect, test } from "bun:test";
import { parseFulltestArgs, resolveAffectedTestScope, type WorkspaceModule } from "./fulltest";

const modules: WorkspaceModule[] = [
	{ directory: "packages/utils", name: "utils", dependencies: [] },
	{ directory: "packages/natives", name: "natives", dependencies: [] },
	{ directory: "packages/ai", name: "ai", dependencies: ["utils"] },
	{ directory: "packages/coding-agent", name: "cli", dependencies: ["ai", "natives"] },
	{ directory: "packages/tui", name: "tui", dependencies: [] },
	{ directory: "python/robomp/web", name: "web", dependencies: [] },
];

describe("affected module suites", () => {
	test("a source-only change selects its whole module without requiring edited tests", () => {
		const scope = resolveAffectedTestScope(["packages/coding-agent/src/main.ts"], modules);
		expect(scope.packages).toEqual(["packages/coding-agent"]);
		expect(scope.rust).toBe(false);
		expect(scope.scripts).toBe(false);
		expect(scope.native).toBe(true);
		expect(scope.ui).toBe(true);
	});

	test("shared code selects only the changed module, not its consumers", () => {
		const scope = resolveAffectedTestScope(["packages/utils/src/removed.ts"], modules);
		expect(scope.packages).toEqual(["packages/utils"]);
	});

	test("moving code between modules selects both source and destination", () => {
		const scope = resolveAffectedTestScope(["packages/ai/src/old.ts", "packages/tui/src/new.ts"], modules);
		expect(scope.packages).toEqual(["packages/ai", "packages/tui"]);
	});

	test("removing a module cannot silently skip its consumers", () => {
		expect(resolveAffectedTestScope(["packages/deleted/src/index.ts"], modules).packages).toEqual(
			modules.map(module => module.directory).sort(),
		);
	});

	test("dependency cycles terminate and select only the changed module", () => {
		const cyclic: WorkspaceModule[] = [
			{ directory: "packages/a", name: "a", dependencies: ["b"] },
			{ directory: "packages/b", name: "b", dependencies: ["a"] },
			{ directory: "packages/c", name: "c", dependencies: [] },
		];
		expect(resolveAffectedTestScope(["packages/a/src/index.ts"], cyclic).packages).toEqual(["packages/a"]);
	});

	test("documentation-only and empty diffs skip all test suites", () => {
		for (const changed of [
			[],
			["docs-zh-CN/requirements/fork.md", "packages/ai/README.md", "crates/pi-builtins/CHANGELOG.md"],
		]) {
			expect(resolveAffectedTestScope(changed, modules)).toEqual({
				packages: [],
				rust: false,
				scripts: false,
				native: false,
				ui: false,
			});
		}
	});

	test("runtime Markdown is code input, not documentation-only noise", () => {
		expect(resolveAffectedTestScope(["packages/coding-agent/src/prompts/system.md"], modules).packages).toEqual([
			"packages/coding-agent",
		]);
	});

	test("the documentation-index source directory remains a tested module", () => {
		expect(resolveAffectedTestScope(["packages/coding-agent/src/docs/index.ts"], modules).packages).toEqual([
			"packages/coding-agent",
		]);
	});

	test("root script-only changes do not select untouched workspace modules", () => {
		const scope = resolveAffectedTestScope(["package.json"], modules, false);
		expect(scope.packages).toEqual([]);
		expect(scope.scripts).toBe(true);
	});

	test("shared dependency configuration selects all TS modules", () => {
		const scope = resolveAffectedTestScope(["bun.lock"], modules);
		expect(scope.packages).toEqual(modules.map(module => module.directory).sort());
		expect(scope.scripts).toBe(true);
		expect(scope.rust).toBe(false);
	});

	test("Rust changes still test the natives binding module", () => {
		const scope = resolveAffectedTestScope(["crates/pi-builtins/src/cksum.rs"], modules);
		expect(scope.rust).toBe(true);
		expect(scope.packages).toEqual(["packages/natives"]);
	});

	test("script changes select all script tests without unrelated package suites", () => {
		const scope = resolveAffectedTestScope(["scripts/fulltest.ts", "scripts/run-rs-task.ts"], modules);
		expect(scope.scripts).toBe(true);
		expect(scope.packages).toEqual([]);
		expect(scope.rust).toBe(false);
		expect(scope.ui).toBe(false);
	});

	test("Python components are out of fulltest scope entirely", () => {
		// fulltest/slowtest never run Python (test:py stays manual); Python paths
		// must not select any phase.
		const scope = resolveAffectedTestScope(
			["sdk/python/omp-rpc/omp_rpc/client.py", "python/robomp/src/tasks.py", "pyproject.toml"],
			modules,
		);
		expect(scope.packages).toEqual([]);
		expect(scope.rust).toBe(false);
		expect(scope.scripts).toBe(false);
		expect(scope.native).toBe(false);
		expect(scope.ui).toBe(false);
	});
});

describe("fulltest argument validation", () => {
	test("dry-run cannot silently fall through to test execution", () => {
		expect(parseFulltestArgs(["--dry-run", "--debug"])).toEqual({ debug: true, dryRun: true });
		expect(parseFulltestArgs([])).toEqual({ debug: false, dryRun: false });
		expect(parseFulltestArgs(["--dry-run", "--unknown"])).toBeNull();
	});
});
