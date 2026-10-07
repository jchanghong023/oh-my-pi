import { describe, expect, test } from "bun:test";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { selectShard } from "./ci-test-ts";

async function affectedDryRun(packages: string[]) {
	return ptree.exec(
		[
			process.execPath,
			path.join(import.meta.dir, "ci-test-ts.ts"),
			"affected",
			`--packages=${JSON.stringify(packages)}`,
			"--dry-run",
		],
		{
			env: { ...Bun.env, OMP_TEST_SHARD: "malformed", NO_COLOR: "1" },
			timeout: 30_000,
			allowNonZero: true,
		},
	);
}

describe("affected test plans", () => {
	test("keeps coding-agent source-colocated suites and ignores shard selection", async () => {
		const result = await affectedDryRun(["packages/coding-agent"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("test/title-card.test.ts");
		expect(result.stdout).toContain("src/edit/auto-repair.test.ts");
		expect(result.stdout).not.toContain("packages/utils");
	});

	test("discovers extension variants and nested suites despite narrower package scripts", async () => {
		const stats = await affectedDryRun(["packages/stats"]);
		expect(stats.exitCode).toBe(0);
		expect(stats.stdout).toContain("test/client-query.test.tsx");
		expect(stats.stdout).not.toContain("packages/ai");

		const tui = await affectedDryRun(["packages/tui"]);
		expect(tui.exitCode).toBe(0);
		expect(tui.stdout).toContain("test/custom-editor.test.ts");
		expect(tui.stdout).toContain("test/native/encode.test.ts");
	});

	test("reports an empty workspace package as skipped", async () => {
		const result = await affectedDryRun(["packages/wire"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("packages/wire: skipped (no tests found)");
		expect(result.stdout).not.toContain("$ bun test");
	});

	test("rejects a directory outside the declared workspace", async () => {
		const result = await affectedDryRun(["scripts"]);

		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("not a package.json workspace directory");
		expect(result.stdout).not.toContain("$ bun test");
	});
});

describe("test runner watchdog", () => {
	// Parent fake timers cannot drive the real watchdog inside the isolated runner process.
	test("kills a stalled chunk, reports failure, and continues the queue", async () => {
		using dir = TempDir.createSync("omp-test-runner-watchdog-");
		const started = dir.join("started");
		const completed = dir.join("completed");
		const continued = dir.join("continued");
		const stalledCommand = [
			process.execPath,
			"-e",
			`await Bun.write(${JSON.stringify(started)}, "started"); await Bun.sleep(60_000); await Bun.write(${JSON.stringify(completed)}, "completed");`,
		];
		const nextCommand = [process.execPath, "-e", `await Bun.write(${JSON.stringify(continued)}, "continued");`];
		const commands = [
			{ label: "stalled chunk", cwd: ".", command: stalledCommand },
			{ label: "following chunk", cwd: ".", command: nextCommand },
		];
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`import { runTestCommandsInParallel } from ${JSON.stringify(import.meta.resolve("./ci-test-ts.ts"))}; await runTestCommandsInParallel(${JSON.stringify(commands)}, 1);`,
			],
			{
				// 3s watchdog: the stalled child must boot bun and write its marker
				// inside the budget; 1s loses the race to Windows spawn latency when
				// the suite runs under a loaded pipeline (marker never lands, the
				// watchdog kills a child that never started). 60s stall vs 3s kill
				// keeps the same semantics.
				env: { ...Bun.env, OMP_TEST_CHUNK_TIMEOUT: "3", NO_COLOR: "1" },
				timeout: 15_000,
				detached: true,
				allowNonZero: true,
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("[watchdog]");
		expect(await Bun.file(started).exists()).toBe(true);
		expect(await Bun.file(completed).exists()).toBe(false);
		expect(await Bun.file(continued).text()).toBe("continued");
	}, 15_000);
});

describe("OMP_TEST_SHARD", () => {
	test("shards partition every chunk exactly once, balanced to within one", () => {
		const chunks = Array.from({ length: 79 }, (_, i) => i);
		const shards = [1, 2, 3].map(i => selectShard(chunks, `${i}/3`));
		expect(shards.flat().sort((a, b) => a - b)).toEqual(chunks);
		const sizes = shards.map(s => s.length);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
		expect(selectShard(chunks, "1/1")).toEqual(chunks);
		expect(selectShard(chunks, undefined)).toEqual(chunks);
	});

	test("rejects malformed specs instead of running an empty or partial shard", () => {
		for (const spec of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3"]) {
			expect(() => selectShard([1, 2, 3], spec)).toThrow("Invalid OMP_TEST_SHARD");
		}
	});

	test("rejects a shard that selects no chunks", () => {
		expect(() => selectShard([1], "2/2")).toThrow("selects no chunks");
		expect(() => selectShard([], "1/1")).toThrow("selects no chunks");
	});
});
