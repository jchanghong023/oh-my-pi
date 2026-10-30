import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	bunCleanBaseline,
	budgetedParallel,
	bunTestSelection,
	isIntegrationCommand,
	prioritizeLocalCommands,
	runBoundedPool,
	testConcurrency,
} from "./ci-test-ts";
import { latestLocalTestProducers, type TestProducerRecord } from "./test-reporting";
import { fulltestCommands } from "./fulltest";
import { testConcurrencyLimit } from "./test-gate-scheduler";

test("affected selection needs a qualifying full TS baseline reachable in Git", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-baseline-"));
	const previous = process.env.OMP_FULLTEST_AFFECTED;
	const previousDigest = process.env.OMP_FULLTEST_SOURCE_DIGEST;
	const git = async (...args: string[]) => {
		const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, err).toBe(0);
		return out.trim();
	};
	try {
		process.env.OMP_FULLTEST_AFFECTED = "1";
		delete process.env.OMP_FULLTEST_SOURCE_DIGEST;
		expect((await bunTestSelection(root)).mode).toBe("full");
		await git("init", "-q");
		await git("config", "user.email", "fixture@example.invalid");
		await git("config", "user.name", "Fixture");
		await fs.writeFile(path.join(root, "fixture.ts"), "export const value = 1;\n");
		await fs.writeFile(path.join(root, ".gitignore"), "runs/\n");
		await git("add", "fixture.ts", ".gitignore");
		await git("commit", "-qm", "fixture baseline");
		const revision = await git("rev-parse", "HEAD");
		const dir = path.join(root, "runs", "test-timing", "fixture");
		await fs.mkdir(dir, { recursive: true });
		const report = {
			scope: "fulltest: fork feature suites",
			completion: "complete",
			exitCode: 0,
			dirtyState: "clean",
			sourceRevision: revision,
			sourceDigest: "a".repeat(64),
			platform: process.platform,
			architecture: process.arch,
			runtimeVersions: { bun: Bun.version },
			startedAtUtc: new Date().toISOString(),
			reconciliation: { status: "validated" },
			producers: [
				{
					scope: "ci-test-ts:local-ts",
					exitCode: 0,
					status: "passed",
					report: "available",
					selection: { mode: "full", group: "ordinary" },
				},
				{
					scope: "ci-test-ts:local-ts",
					exitCode: 0,
					status: "passed",
					report: "available",
					selection: { mode: "full", group: "startup" },
				},
				{
					scope: "rust-fork-features",
					producer: "cargo nextest run",
					exitCode: 0,
					status: "passed",
					report: "available",
					selection: { mode: "full" },
				},
				{
					scope: "rust-fork-features",
					producer: "cargo test --doc",
					exitCode: 0,
					status: "stage",
					selection: { mode: "full" },
				},
				{ scope: "all scenarios", producer: "ui-smoke/runner-stage", exitCode: 0, status: "stage" },
			] as {
				scope: string;
				producer?: string;
				exitCode: number;
				status: string;
				report?: string;
				selection?: { mode: string; group?: string };
			}[],
		};
		const save = () => fs.writeFile(path.join(dir, "run.json"), JSON.stringify(report));
		await save();
		report.scope = "fulltest: full current-platform project suites";
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.scope = "fulltest: fork feature suites";
		await save();
		expect(await bunTestSelection(root)).toMatchObject({ mode: "affected", baseline: revision });
		expect((await bunTestSelection(root, true, "f".repeat(40))).mode).toBe("full");
		report.completion = "partial";
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.completion = "complete";
		await save();
		expect(await bunCleanBaseline({ tool: "bun", mode: "affected", baseline: revision }, root)).toBe(true);
		await fs.writeFile(path.join(root, "new-source.ts"), "export {};\n");
		expect(await bunCleanBaseline({ tool: "bun", mode: "affected", baseline: revision }, root)).toBe(false);
		await fs.rm(path.join(root, "new-source.ts"));
		await fs.appendFile(path.join(root, "fixture.ts"), "// working tree change\n");
		expect(await bunCleanBaseline({ tool: "bun", mode: "affected", baseline: revision }, root)).toBe(false);
		expect(await bunTestSelection(root)).toMatchObject({ mode: "affected", baseline: revision });
		report.dirtyState = "dirty";
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		process.env.OMP_FULLTEST_SOURCE_DIGEST = "b".repeat(64);
		expect((await bunTestSelection(root)).mode).toBe("full");
		process.env.OMP_FULLTEST_SOURCE_DIGEST = "a".repeat(64);
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.dirtyState = "clean";
		report.producers[0] = {
			...report.producers[0]!,
			selection: { mode: "affected" },
		} as (typeof report.producers)[number];
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.producers[0] = {
			scope: "ci-test-ts:local-ts",
			exitCode: 0,
			status: "passed",
			report: "available",
			selection: { mode: "full", group: "ordinary" },
		};
		const startup = report.producers.splice(1, 1)[0]!;
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.producers.push(startup);
		await save();
		expect(await bunTestSelection(root)).toMatchObject({ mode: "affected", baseline: revision });
		await git("add", "fixture.ts");
		await git("commit", "-qm", "working tree change");
		await git("checkout", "-q", "--orphan", "unrelated");
		await git("add", "fixture.ts");
		await git("commit", "-qm", "unrelated history");
		expect((await bunTestSelection(root)).mode).toBe("full");
	} finally {
		if (previous === undefined) delete process.env.OMP_FULLTEST_AFFECTED;
		else process.env.OMP_FULLTEST_AFFECTED = previous;
		if (previousDigest === undefined) delete process.env.OMP_FULLTEST_SOURCE_DIGEST;
		else process.env.OMP_FULLTEST_SOURCE_DIGEST = previousDigest;
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("shared test concurrency limit respects platform and available cores", () => {
	for (const platform of ["win32", "linux", "darwin"] as const) {
		const cap = platform === "win32" ? 14 : 28;
		expect(testConcurrencyLimit(0, platform)).toBe(1);
		expect(testConcurrencyLimit(1, platform)).toBe(1);
		expect(testConcurrencyLimit(6.9, platform)).toBe(6);
		expect(testConcurrencyLimit(14, platform)).toBe(14);
		expect(testConcurrencyLimit(28, platform)).toBe(cap);
		expect(testConcurrencyLimit(64, platform)).toBe(cap);
	}
});

test("chunk pools respect CPU, command count and explicit concurrency limits", () => {
	expect(testConcurrency(40, undefined, 1)).toBe(1);
	expect(testConcurrency(40, undefined, 6)).toBe(6);
	expect(testConcurrency(40, undefined, 28)).toBe(testConcurrencyLimit(28));
	expect(testConcurrency(40, undefined, 64)).toBe(testConcurrencyLimit(64));
	expect(testConcurrency(3, undefined, 64)).toBe(3);
	expect(testConcurrency(40, "all", 64)).toBe(testConcurrencyLimit(64));
	expect(testConcurrency(40, "max", 64)).toBe(testConcurrencyLimit(64));
	expect(testConcurrency(40, "100", 6)).toBe(6);
	expect(testConcurrency(40, "2", 64)).toBe(2);
	expect(testConcurrency(3, "27", 64)).toBe(3);
	expect(testConcurrency(40, "4.9", 6)).toBe(4);
	expect(() => testConcurrency(40, "invalid", 64)).toThrow();
	expect(testConcurrency(40, "all", 64, false, "win32")).toBe(14);
	expect(testConcurrency(40, "all", 64, true, "win32")).toBe(20);
	expect(testConcurrency(40, "all", 16, true, "win32")).toBe(16);
	expect(testConcurrency(3, "all", 64, true, "win32")).toBe(3);
	expect(testConcurrency(40, "2", 64, true, "win32")).toBe(2);
	expect(testConcurrency(40, "all", 64, true, "linux")).toBe(28);
});

test("integration chunk classification matches coding-agent test paths only", () => {
	const command = (cwd: string, files: string[]) => ({ label: "chunk", cwd, command: ["bun", "test", ...files] });
	expect(
		isIntegrationCommand(command("packages/coding-agent", ["test/unit.test.ts", "test/process.e2e.test.ts"])),
	).toBe(true);
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/integration/session.test.ts"]))).toBe(true);
	for (const file of [
		"zcode-process.test.ts",
		"zcode-process-projection.test.ts",
		"zcode-process-session.test.ts",
		"zcode-process-catalog.test.ts",
		"zcode-process-execution.test.ts",
		"zcode-workflow-process.test.ts",
		"zcode-workflow-sandbox-process.test.ts",
	]) {
		expect(isIntegrationCommand(command("packages/coding-agent", [`test/modes/${file}`]))).toBe(true);
	}
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/modes/zcode-process-unit.test.ts"]))).toBe(
		false,
	);
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/other/zcode-process.test.ts"]))).toBe(false);
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/modes/zcode-workflow.test.ts"]))).toBe(false);
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/integrationish.test.ts"]))).toBe(false);
	expect(isIntegrationCommand(command("packages/tui", ["test/process.e2e.test.ts"]))).toBe(false);
});

test("bounded pool runs eligible chunks in order, caps heavy work and drains the entire queue", async () => {
	const items = ["h1", "h2", "h3", "h4", "h5", "h6", "l1", "l2"];
	const started: string[] = [];
	const finished: string[] = [];
	const releases = new Map<string, () => void>();
	let active = 0;
	let heavy = 0;
	let peakActive = 0;
	let peakHeavy = 0;
	const pool = runBoundedPool(
		items,
		6,
		item =>
			isIntegrationCommand({
				label: item,
				cwd: "packages/coding-agent",
				command: ["bun", "test", item.startsWith("h") ? "test/modes/zcode-process.test.ts" : "test/unit.test.ts"],
			}),
		4,
		async item => {
			started.push(item);
			active++;
			if (item.startsWith("h")) heavy++;
			peakActive = Math.max(peakActive, active);
			peakHeavy = Math.max(peakHeavy, heavy);
			await new Promise<void>(resolve => releases.set(item, resolve));
			active--;
			if (item.startsWith("h")) heavy--;
			finished.push(item);
		},
	);
	const release = async (item: string) => {
		const resolve = releases.get(item);
		expect(resolve).toBeDefined();
		resolve!();
		await Promise.resolve();
		await Promise.resolve();
	};
	expect(started).toEqual(["h1", "h2", "h3", "h4", "l1", "l2"]);
	await release("l1");
	await release("l2");
	expect(started).toHaveLength(6);
	await release("h2");
	expect(started).toEqual(["h1", "h2", "h3", "h4", "l1", "l2", "h5"]);
	await release("h1");
	expect(started.at(-1)).toBe("h6");
	for (const item of ["h3", "h4", "h5", "h6"]) await release(item);
	await pool;
	expect(peakActive).toBe(6);
	expect(peakHeavy).toBe(4);
	expect(started.toSorted()).toEqual(items.toSorted());
	expect(finished.toSorted()).toEqual(items.toSorted());
	expect(active).toBe(0);
});

test("bounded pool preserves order with fewer workers than the heavy limit", async () => {
	const items = ["h1", "l1", "h2", "l2"];
	const started: string[] = [];
	await runBoundedPool(
		items,
		1,
		item => item.startsWith("h"),
		4,
		async item => {
			started.push(item);
		},
	);
	expect(started).toEqual(items);
});

test("startup file workers use the fulltest budget without exceeding CPU or command count", async () => {
	const startup = fulltestCommands({ debug: false }, "home").find(
		command => command.label === "test/TypeScript startup suite",
	)!;
	for (const [cores, count, expected] of [
		[1, 3, 1],
		[8, 1, 1],
		[8, 3, 2],
	] as const) {
		const files = Array.from({ length: count }, (_, index) => index);
		const releases = new Map<number, () => void>();
		let active = 0;
		let peak = 0;
		const pool = runBoundedPool(
			files,
			testConcurrency(count, startup.env?.OMP_TEST_CONCURRENCY, cores),
			() => false,
			4,
			async file => {
				active++;
				peak = Math.max(peak, active);
				await new Promise<void>(resolve => releases.set(file, resolve));
				active--;
			},
		);
		for (const file of files) {
			expect(releases.has(file)).toBe(true);
			releases.get(file)!();
			await Promise.resolve();
			await Promise.resolve();
		}
		await pool;
		expect(peak).toBe(expected);
	}
});

test("chunk and file parallelism spend the same CPU budget", () => {
	for (const cores of [1, 6, 28, 64]) {
		for (const total of [1, 3, 40]) {
			for (const spec of [undefined, "2"]) {
				const pool = testConcurrency(total, spec, cores);
				const parallel = budgetedParallel(8, pool, cores);
				expect(pool * parallel).toBeLessThanOrEqual(testConcurrencyLimit(cores));
				expect(parallel).toBeLessThanOrEqual(8);
			}
		}
	}
	expect(budgetedParallel(8, 1, 64)).toBe(8);
	expect(budgetedParallel(8, 3, 6)).toBe(2);
});

test("historical chunk durations reorder only exact matches, retaining every command", () => {
	const commands = ["a", "b", "c", "d"].map(name => ({
		label: `packages/coding-agent (${name})`,
		cwd: "packages/coding-agent",
		command: ["bun", "test", "--only-failures", `test/${name}.test.ts`],
		parallel: 1,
	}));
	const producer = (index: number, durationSeconds: number): TestProducerRecord => ({
		producer: `ci-test-ts:local-ts:1234abcd:${commands[index].label}:attempt-1`,
		command: [
			...commands[index].command,
			"--parallel=1",
			"--timeout=30000",
			"--reporter=junit",
			"--reporter-outfile=x.xml",
		],
		scope: "ci-test-ts:local-ts",
		attempt: 1,
		startedAt: "2026-01-01T00:00:00Z",
		durationSeconds,
		exitCode: 0,
	});
	const ordered = prioritizeLocalCommands(commands, [producer(0, 1), producer(2, 20), producer(3, 20)]);
	expect(ordered).toEqual([commands[2], commands[3], commands[0], commands[1]]);
	expect(prioritizeLocalCommands(commands, [])).toEqual(commands);
	const changed = producer(2, 100);
	changed.command[3] = "test/other.test.ts";
	expect(prioritizeLocalCommands(commands, [changed])).toEqual(commands);
	expect(prioritizeLocalCommands(commands, [producer(2, 10), producer(2, 20)])).toEqual(commands);
	expect(commands.map(command => command.command[3])).toEqual([
		"test/a.test.ts",
		"test/b.test.ts",
		"test/c.test.ts",
		"test/d.test.ts",
	]);
});

test("only the latest complete successful same-source fulltest supplies history", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-timing-history-"));
	const now = Date.now();
	const digest = "a".repeat(64);
	const producer: TestProducerRecord & { report: string } = {
		producer: "ci-test-ts:local-ts:1234abcd:packages/foo:attempt-1",
		command: ["bun", "test"],
		scope: "ci-test-ts:local-ts",
		attempt: 1,
		startedAt: new Date(now).toISOString(),
		durationSeconds: 12,
		exitCode: 0,
		selection: { tool: "bun", mode: "full" },
		report: "available",
	};
	const put = async (name: string, overrides: object = {}) => {
		const dir = path.join(root, name);
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			path.join(dir, "run.json"),
			JSON.stringify({
				scope: "fulltest: fork feature suites",
				startedAtUtc: new Date(now - 1000).toISOString(),
				completion: "complete",
				exitCode: 0,
				sourceDigest: digest,
				platform: process.platform,
				architecture: process.arch,
				reconciliation: { status: "validated", cases: 1, failures: 0 },
				unreconciledScope: null,
				producers: [producer],
				...overrides,
			}),
		);
	};
	const readHistory = () => latestLocalTestProducers(digest, root, now, "current");
	try {
		expect(await readHistory()).toEqual([]);
		await put("valid");
		expect(await readHistory()).toEqual([producer]);
		expect(await latestLocalTestProducers(undefined, root, now, "current")).toEqual([]);
		expect(await latestLocalTestProducers("b".repeat(64), root, now, "current")).toEqual([]);
		for (const overrides of [
			{ completion: "partial" },
			{ exitCode: 1 },
			{ scope: "fulltest: full current-platform project suites" },
			{ sourceDigest: "b".repeat(64) },
			{ startedAtUtc: new Date(now - 8 * 86400000).toISOString() },
			{ reconciliation: { status: "invalid", cases: 1, failures: 0 } },
			{ producers: [{ ...producer, report: "missing" }] },
			{ architecture: "other" },
			{ platform: "other" },
		]) {
			await put("valid", overrides);
			expect(await readHistory()).toEqual([]);
		}
		await put("valid");
		await put("current", { completion: "running", sourceDigest: null, startedAtUtc: new Date(now).toISOString() });
		expect(await readHistory()).toEqual([producer]);
		await put("newer", { completion: "partial", exitCode: 1, startedAtUtc: new Date(now - 500).toISOString() });
		expect(await readHistory()).toEqual([]);
		await put("newer", {
			startedAtUtc: new Date(now - 500).toISOString(),
			producers: [{ ...producer, durationSeconds: 30 }],
		});
		expect((await readHistory()).map(item => item.durationSeconds)).toEqual([30]);
		await fs.mkdir(path.join(root, "invalid"));
		await Bun.write(path.join(root, "invalid", "run.json"), "{");
		expect(await readHistory()).toEqual([]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

// Exercise the real driver with selected and upstream fixtures in the same checkout.
test("local suites select fork consumers and drain failures without widening to upstream", async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ts-full-"));
	const root = path.join(temp, "repo");
	const marker = path.join(temp, "executed");
	const sourceRoot = path.resolve(import.meta.dir, "..");
	const put = (file: string, content: string) => Bun.write(path.join(root, file), content);
	const run = async (argv: string[], env: Record<string, string | undefined> = {}, expectedExit = 0) => {
		const child = Bun.spawn(argv, {
			cwd: root,
			env: {
				...process.env,
				...env,
				CI: env.CI ?? "",
				OMP_TEST_SHARD: env.OMP_TEST_SHARD ?? "",
				OMP_GATE_EVENT_TOKEN: env.OMP_GATE_EVENT_TOKEN ?? "",
				OMP_GATE_EVENT_FILE: "",
				OMP_TEST_REPORT_DIR: "",
				OMP_TEST_RUN_ID: "",
				OMP_TEST_CONCURRENCY: env.OMP_TEST_CONCURRENCY ?? "1",
				FAIL_FIXTURE: env.FAIL_FIXTURE ?? "",
				MARKER: marker,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, `${argv.join(" ")}\n${stdout}\n${stderr}`).toBe(expectedExit);
		return stdout;
	};
	const executed = async () =>
		(await fs.readFile(marker, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).sort();
	const clear = () => fs.rm(marker, { force: true });
	try {
		await fs.mkdir(path.join(root, "scripts"), { recursive: true });
		for (const file of [
			"ci-test-ts.ts",
			"windows-test-temp.ts",
			"test-gate-failure-events.ts",
			"test-gate-events.ts",
			"test-gate-clock.ts",
			"test-gate-libc.ts",
			"test-gate-scheduler.ts",
			"test-gate-source.ts",
			"test-reporting.ts",
		]) {
			await fs.copyFile(path.join(import.meta.dir, file), path.join(root, "scripts", file));
		}
		await fs.symlink(
			path.join(sourceRoot, "node_modules"),
			path.join(root, "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const fixture = (name: string) =>
			`import { test } from "bun:test"; import { appendFileSync } from "node:fs"; test(${JSON.stringify(name)}, () => appendFileSync(process.env.MARKER!, ${JSON.stringify(`${name}\n`)}));\n`;
		const selected = [
			"packages/ai/test/proxy.test.ts",
			"packages/natives/test/python-symbols.test.ts",
			"packages/coding-agent/test/spec-driven/process.e2e.test.ts",
			"packages/coding-agent/test/team/integration.test.ts",
			"packages/coding-agent/test/goals/goal-runtime.test.ts",
			"packages/coding-agent/test/modes/zcode-permissions.e2e.ts",
			"packages/coding-agent/test/modes/zcode-process-session.test.ts",
			"packages/coding-agent/test/repo-index.test.ts",
			"packages/coding-agent/test/repo-review-regressions.test.ts",
			"packages/coding-agent/test/lsp/edits.test.ts",
			"packages/coding-agent/test/slash-commands/shared-skills.test.ts",
			"packages/coding-agent/test/acp-builtins.test.ts",
		];
		const excluded = [
			"packages/ai/test/unrelated.test.ts",
			"packages/natives/test/desktop.test.ts",
			"packages/coding-agent/test/tools/browser-launch.test.ts",
			"packages/coding-agent/test/tools/proc-service.test.ts",
			"packages/coding-agent/test/tools/lsp-regressions.test.ts",
			"packages/coding-agent/test/task/worktree.test.ts",
			"packages/coding-agent/test/rpc.test.ts",
		];
		for (const file of [...selected, ...excluded]) await put(file, fixture(file));
		await put(
			"packages/coding-agent/test/wiki-tool.test.ts",
			'import { test, expect } from "bun:test"; import { appendFileSync } from "node:fs"; test("failure", () => { appendFileSync(process.env.MARKER!, "failure\\n"); expect(Boolean(process.env.FAIL_FIXTURE)).toBe(false); }); test("after failure", () => appendFileSync(process.env.MARKER!, "after-failure\\n"));\n',
		);
		const fullMarkers = [...selected, "failure", "after-failure"].sort();
		const dry = await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--dry-run"]);
		expect(dry).toContain("scope=fork-features selected-files=13");
		expect(await executed()).toEqual([]);
		expect(dry).toContain("./test/modes/zcode-permissions.e2e.ts");
		for (const file of excluded) expect(dry).not.toContain(file.replace("packages/coding-agent/", ""));
		await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts"], { OMP_TEST_SHARD: "1/20" });
		expect(await executed()).toEqual(fullMarkers);
		await clear();
		const emptyStartup = await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--only-startup"]);
		expect(emptyStartup).toContain("test-command-group=startup chunks=0");
		expect(await executed()).toEqual([]);
		await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--defer-startup", "--only-startup"], {}, 1);
		const fulltest = fulltestCommands({ debug: false }, path.join(temp, "home")).find(
			command => command.label === "test/TypeScript fork feature suite",
		)!;
		await run([process.execPath, ...fulltest.argv.slice(1)], {
			...fulltest.env,
			CI: "true",
			OMP_TEST_CONCURRENCY: "2",
		});
		expect(await executed()).toEqual(fullMarkers);
		for (const concurrency of ["2", ""]) {
			await clear();
			await run(
				[process.execPath, "scripts/ci-test-ts.ts", "local-ts"],
				{
					CI: "true",
					OMP_TEST_CONCURRENCY: concurrency,
					OMP_GATE_EVENT_TOKEN: "isolated-fixture-token",
					FAIL_FIXTURE: "1",
				},
				1,
			);
			expect(await executed()).toEqual(fullMarkers);
		}
		const startupFiles = [
			"test/spec-driven/tui-start.e2e.test.ts",
			"test/spec-driven/tui-another.e2e.test.ts",
			"test/modes/zcode-hosts-goal.test.ts",
		];
		for (const file of startupFiles) {
			await put(
				`packages/coding-agent/${file}`,
				`import { test } from "bun:test"; import { appendFileSync } from "node:fs"; test(${JSON.stringify(file)}, () => { appendFileSync(process.env.MARKER!, ${JSON.stringify(`${file}\n`)}); appendFileSync(process.env.MARKER! + ".pids", process.pid + "\\n"); });\n`,
			);
		}
		await clear();
		const ordinaryOutput = await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--defer-startup"]);
		expect(ordinaryOutput).toContain("test-command-group=ordinary");
		for (const file of startupFiles) expect(await executed()).not.toContain(file);
		const startup = fulltestCommands({ debug: false }, path.join(temp, "home")).find(
			command => command.label === "test/TypeScript startup suite",
		)!;
		await run([process.execPath, ...startup.argv.slice(1)], { ...startup.env });
		expect(await executed()).toEqual([...fullMarkers, ...startupFiles].sort());
		const pids = (await fs.readFile(`${marker}.pids`, "utf8")).trim().split("\n");
		expect(new Set(pids).size).toBe(startupFiles.length);
		const singletonFiles = Array.from(
			{ length: 23 },
			(_, i) => `test/settings-${String(i).padStart(2, "0")}.test.ts`,
		);
		await put("packages/coding-agent/test/settings.test.ts", fixture("settings"));
		for (const file of singletonFiles) await put(`packages/coding-agent/${file}`, fixture(file));
		const output = await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--dry-run"]);
		for (const file of singletonFiles) expect(output).not.toContain(file);
		const shards = await Promise.all(
			["1/3", "2/3", "3/3"].map(shard =>
				run([process.execPath, "scripts/ci-test-ts.ts", "coding-agent-singleton", "--dry-run"], {
					CI: "true",
					OMP_TEST_SHARD: shard,
				}),
			),
		);
		for (const file of ["test/settings.test.ts", ...singletonFiles]) {
			expect(shards.join("\n").split(file).length - 1).toBe(1);
		}
		for (const [index, shardOutput] of shards.entries()) {
			const chunkNumbers = [...shardOutput.matchAll(/chunk (\d+)\/\d+/g)].map(match => Number(match[1]));
			for (const number of chunkNumbers) expect((number - 1) % 3).toBe(index);
		}
		const nativeFiles = Array.from({ length: 11 }, (_, i) => `test/native-${String(i).padStart(2, "0")}.test.ts`);
		await put("packages/coding-agent/test/native.test.ts", fixture("native"));
		for (const file of nativeFiles) await put(`packages/coding-agent/${file}`, fixture(file));
		const nativeShards = await Promise.all(
			["1/2", "2/2"].map(shard =>
				run([process.execPath, "scripts/ci-test-ts.ts", "coding-agent-native", "--dry-run"], {
					CI: "true",
					OMP_TEST_SHARD: shard,
				}),
			),
		);
		for (const file of ["test/native.test.ts", ...nativeFiles]) {
			expect(nativeShards.join("\n").split(file).length - 1).toBe(1);
		}
		for (const [index, shardOutput] of nativeShards.entries()) {
			const chunkNumbers = [...shardOutput.matchAll(/chunk (\d+)\/\d+/g)].map(match => Number(match[1]));
			for (const number of chunkNumbers) expect((number - 1) % 2).toBe(index);
		}
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}, 240_000);
