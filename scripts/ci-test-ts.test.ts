import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	bunCleanBaseline,
	budgetedParallel,
	bunTestSelection,
	isIntegrationCommand,
	isLimitedIntegrationCommand,
	prioritizeBunCommands,
	runBoundedPool,
	testConcurrency,
	verifiedFulltestRevision,
} from "./ci-test-ts";
import {
	BUN_FORK_SUITE_REVISION,
	isActiveBunFulltest,
	latestFulltestBunProducers,
	type TestProducerRecord,
} from "./test-reporting";
import { fulltestCommands } from "./fulltest";
import { testConcurrencyLimit } from "./test-gate-scheduler";

test("Bun discovery keeps OMP consumers but excludes vendor tests", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-discovery-"));
	try {
		await fs.copyFile(path.join(import.meta.dir, "..", "bunfig.toml"), path.join(root, "bunfig.toml"));
		const vendor = path.join(root, "vendor", "openwiki");
		const consumer = path.join(root, "packages", "coding-agent", "test", "openwiki");
		await Promise.all([fs.mkdir(vendor, { recursive: true }), fs.mkdir(consumer, { recursive: true })]);
		await fs.writeFile(
			path.join(vendor, "vendor.test.ts"),
			'import { test } from "bun:test"; test("vendor should not run", () => { throw new Error("VENDOR_TEST_RAN"); });\n',
		);
		await fs.writeFile(
			path.join(consumer, "consumer.test.ts"),
			'import { test } from "bun:test"; test("consumer runs", () => { console.log("OMP_CONSUMER_RAN"); });\n',
		);
		const child = Bun.spawn([process.execPath, "test"], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stdout + stderr).toBe(0);
		expect(stdout + stderr).toContain("OMP_CONSUMER_RAN");
		expect(stdout + stderr).not.toContain("VENDOR_TEST_RAN");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("affected selection needs a qualifying full TS baseline reachable in Git", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-baseline-"));
	const select = (fixtureRoot: string, hint: string | null = null, currentRunId = "") =>
		bunTestSelection(fixtureRoot, true, hint, currentRunId);
	const git = async (...args: string[]) => {
		const child = Bun.spawn(
			[
				"git",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"user.name=Fixture",
				"-c",
				"commit.gpgSign=false",
				...args,
			],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, err).toBe(0);
		return out.trim();
	};
	try {
		const [noRevision, malformedRevision, noGitRevision, noReport] = await Promise.all([
			verifiedFulltestRevision(undefined, root),
			verifiedFulltestRevision("invalid", root),
			verifiedFulltestRevision("a".repeat(40), root),
			select(root),
			fs.writeFile(path.join(root, "fixture.ts"), "export const value = 1;\n"),
			fs.writeFile(path.join(root, ".gitignore"), "runs/\n"),
		]);
		expect(noRevision).toBeUndefined();
		expect(malformedRevision).toBeUndefined();
		expect(noGitRevision).toBeUndefined();
		expect(noReport.mode).toBe("full");
		await git("init", "-q");
		await git("add", "fixture.ts", ".gitignore");
		await git("commit", "-qm", "fixture baseline");
		const revision = await git("rev-parse", "HEAD");
		const unrelatedRevision = git("commit-tree", `${revision}^{tree}`, "-m", "unrelated history");
		const report = {
			scope: "fulltest: fork feature suites",
			completion: "complete",
			exitCode: 0,
			dirtyState: "clean",
			sourceRevision: revision,
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
					selection: { mode: "full", group: "ordinary", suiteRevision: BUN_FORK_SUITE_REVISION },
				},
				{
					scope: "ci-test-ts:local-ts",
					exitCode: 0,
					status: "passed",
					report: "available",
					selection: { mode: "full", group: "startup", suiteRevision: BUN_FORK_SUITE_REVISION },
				},
				{
					scope: "rust-fork-features",
					producer: "cargo nextest run",
					exitCode: 0,
					status: "not-selected",
					selection: { tool: "fork-scope", mode: "full", selected: 0, packages: [] },
				},
				{ scope: "all scenarios", producer: "ui-smoke/runner-stage", exitCode: 0, status: "stage" },
			] as const,
		};
		const baselineRunId = "2026-11-20T20-04-46.754Z-99788-2db8930f";
		const reportDir = (fixtureRoot: string, runId: string) => path.join(fixtureRoot, "runs", "test-timing", runId);
		const save = async (fixtureRoot: string, data: object, runId = baselineRunId) => {
			const dir = reportDir(fixtureRoot, runId);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(data));
		};
		// Isolate report variants under the same Git history: a wrongly accepted
		// report can reach Git and return affected, rather than failing for lack of a repo.
		const caseRoot = (name: string) => path.join(root, "runs", "cases", name);
		const [ordinary, startup, rust, ui] = report.producers;
		const withStartup = (producer: object) => ({ ...report, producers: [ordinary, producer, rust, ui] });
		const withRust = (producer: object) => ({ ...report, producers: [ordinary, startup, producer, ui] });
		const rejectedReports = [
			["other scope", { ...report, scope: "fulltest: full current-platform project suites" }],
			["missing suite revision", withStartup({ ...startup, selection: { mode: "full", group: "startup" } })],
			["old suite revision", withStartup({ ...startup, selection: { ...startup.selection, suiteRevision: 8 } })],
			["dirty baseline", { ...report, dirtyState: "dirty" }],
			["affected producer", withStartup({ ...startup, selection: { mode: "affected" } })],
			["missing startup group", { ...report, producers: [ordinary, rust, ui] }],
			["failed producer", withStartup({ ...startup, exitCode: 1, status: "failed" })],
			["missing producer report", withStartup({ ...startup, report: "missing" })],
			["missing Rust scope", { ...report, producers: [ordinary, startup, ui] }],
			["old Rust scope", withRust({ ...rust, status: "passed", selection: { mode: "full" } })],
			["nonempty Rust skip", withRust({ ...rust, selection: { ...rust.selection, selected: 1 } })],
			["Rust scope affected", withRust({ ...rust, selection: { ...rust.selection, mode: "affected" } })],
			["other skip", { ...report, producers: [...report.producers, { ...rust, producer: "other" }] }],
		] as const;
		const currentRunId = "2026-11-20T20-14-46.754Z-99789-2db8930a";
		const running = { ...report, runId: currentRunId, completion: "running", exitCode: null };
		const checkNewerAttempt = async (name: string, newer: object, runId?: string) => {
			const fixtureRoot = caseRoot(name);
			await Promise.all([save(fixtureRoot, report), save(fixtureRoot, newer, currentRunId)]);
			return select(fixtureRoot, null, runId);
		};
		const savedBaseline = Promise.all([
			save(root, report),
			fs.mkdir(reportDir(root, "wiki-semantic-real-bge"), { recursive: true }),
		]);
		const unreadableRoot = caseRoot("unreadable-newer-run");
		await Promise.all([
			save(unreadableRoot, report),
			fs.mkdir(reportDir(unreadableRoot, currentRunId), { recursive: true }),
		]);
		const unrelatedRoot = caseRoot("unreachable");
		const [baseline, clean, wrongHint, current, failed, incomplete, previousRunning, unreachable, rejected] =
			await Promise.all([
				savedBaseline.then(() => select(root)),
				bunCleanBaseline({ tool: "bun", mode: "affected", baseline: revision }, root),
				Promise.all([savedBaseline, unrelatedRevision]).then(([, unrelated]) => select(root, unrelated)),
				checkNewerAttempt("current run", running, currentRunId),
				checkNewerAttempt("failed run", { ...report, exitCode: 23 }),
				checkNewerAttempt("partial run", { ...report, completion: "partial" }),
				checkNewerAttempt("another running attempt", running, "different-current-run"),
				unrelatedRevision.then(async unrelated => {
					await save(unrelatedRoot, { ...report, sourceRevision: unrelated });
					return select(unrelatedRoot);
				}),
				Promise.all(
					rejectedReports.map(async ([name, candidate]) => {
						const fixtureRoot = caseRoot(name);
						await save(fixtureRoot, candidate);
						return [name, (await select(fixtureRoot)).mode] as const;
					}),
				),
			]);
		expect(baseline).toMatchObject({ mode: "affected", baseline: revision });
		expect(clean).toBe(true);
		expect(wrongHint.mode).toBe("full");
		expect(current).toMatchObject({ mode: "affected", baseline: revision });
		expect(failed.mode).toBe("full");
		expect(incomplete.mode).toBe("full");
		expect(await select(unreadableRoot)).toMatchObject({
			mode: "full",
			reason: "newer test report is unreadable or invalid",
		});
		expect(previousRunning.mode).toBe("full");
		expect(unreachable.mode).toBe("full");
		for (const [name, mode] of rejected) expect(mode, name).toBe("full");

		const untracked = path.join(root, "new-source.ts");
		await fs.writeFile(untracked, "export {};\n");
		expect(await bunCleanBaseline(baseline, root)).toBe(false);
		await Promise.all([fs.rm(untracked), fs.appendFile(path.join(root, "fixture.ts"), "// working tree change\n")]);
		const [trackedClean, dirtySelection, dirtyRevision] = await Promise.all([
			bunCleanBaseline(baseline, root),
			select(root),
			verifiedFulltestRevision(revision, root),
		]);
		expect(trackedClean).toBe(false);
		expect(dirtySelection).toMatchObject({ mode: "affected", baseline: revision });
		// Scheduling provenance is the Git revision, not a worktree content snapshot.
		expect(dirtyRevision).toBe(revision);
		await git("commit", "-qam", "working tree change");
		const [ancestorSelection, previousRevision] = await Promise.all([
			select(root),
			verifiedFulltestRevision(revision, root),
		]);
		expect(ancestorSelection).toMatchObject({ mode: "affected", baseline: revision });
		expect(previousRevision).toBeUndefined();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("shared test concurrency limit respects platform and available cores", () => {
	for (const platform of ["win32", "linux", "darwin"] as const) {
		const cap = 28;
		expect(testConcurrencyLimit(0, platform)).toBe(1);
		expect(testConcurrencyLimit(1, platform)).toBe(1);
		expect(testConcurrencyLimit(6.9, platform)).toBe(6);
		expect(testConcurrencyLimit(14, platform)).toBe(14);
		expect(testConcurrencyLimit(28, platform)).toBe(cap);
		expect(testConcurrencyLimit(64, platform)).toBe(cap);
	}
});

test("shared CPU budget cannot exceed available cores or the worker ceiling", () => {
	expect(testConcurrencyLimit(16, "win32", "6")).toBe(6);
	expect(testConcurrencyLimit(4, "win32", "6")).toBe(4);
	expect(testConcurrencyLimit(64, "win32", "100")).toBe(28);
	expect(testConcurrencyLimit(16, "win32", "0")).toBe(16);
	expect(testConcurrencyLimit(16, "win32", "invalid")).toBe(16);
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
	expect(testConcurrency(40, "all", 64, "win32")).toBe(28);
	expect(testConcurrency(40, "all", 16, "win32")).toBe(16);
	expect(testConcurrency(3, "all", 64, "win32")).toBe(3);
	expect(testConcurrency(40, "2", 64, "win32")).toBe(2);
	expect(testConcurrency(40, "all", 64, "linux")).toBe(28);
});

test("integration chunk classification matches coding-agent test paths only", () => {
	const command = (cwd: string, files: string[]) => ({ label: "chunk", cwd, command: ["bun", "test", ...files] });
	expect(
		isIntegrationCommand(command("packages/coding-agent", ["test/unit.test.ts", "test/process.e2e.test.ts"])),
	).toBe(true);
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/integration/session.test.ts"]))).toBe(true);
	for (const file of ["test/openwiki/native-pool.test.ts", "test/spec-driven/resources.test.ts"]) {
		expect(isIntegrationCommand(command("packages/coding-agent", [file]))).toBe(true);
		expect(isLimitedIntegrationCommand(command("packages/coding-agent", [file]))).toBe(true);
		expect(isIntegrationCommand(command("packages/tui", [file]))).toBe(false);
	}
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/integrationish.test.ts"]))).toBe(false);
	expect(isIntegrationCommand(command("packages/tui", ["test/process.e2e.test.ts"]))).toBe(false);
});

test("startup integration chunks bypass only the heavy integration limit", () => {
	const command = (file: string) => ({ label: "chunk", cwd: "packages/coding-agent", command: ["bun", "test", file] });
	for (const file of [
		"test/spec-driven/tui-compact-mixed.e2e.test.ts",
		"test/goals/goal-autopilot-tui.e2e.test.ts",
		"test/goals/goal-ctrl-enter-tui.e2e.test.ts",
	]) {
		expect(isIntegrationCommand(command(file))).toBe(true);
		expect(isLimitedIntegrationCommand(command(file))).toBe(false);
	}
	expect(isLimitedIntegrationCommand(command("test/integration/session.test.ts"))).toBe(true);
});

test("bounded pool fills ordinary workers past the cap4 heavy queue and drains every chunk once", async () => {
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
			isLimitedIntegrationCommand({
				label: item,
				cwd: "packages/coding-agent",
				command: [
					"bun",
					"test",
					item === "h1"
						? "test/openwiki/native-pool.test.ts"
						: item === "h5"
							? "test/spec-driven/resources.test.ts"
							: item.startsWith("h")
								? "test/integration/session.test.ts"
								: "test/unit.test.ts",
				],
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

test("weighted leases release both slots and keep only one browser active", async () => {
	const items = ["browser-1", "multi-file", "browser-2", "ordinary-1", "ordinary-2", "ordinary-3"];
	const released = new Map<string, () => void>();
	const launches: [string, number][] = [];
	let activeSlots = 0;
	let peakSlots = 0;
	const pool = runBoundedPool(
		items,
		3,
		() => false,
		4,
		async (item, slots) => {
			launches.push([item, slots]);
			activeSlots += slots;
			peakSlots = Math.max(peakSlots, activeSlots);
			await new Promise<void>(resolve => released.set(item, resolve));
			activeSlots -= slots;
		},
		item => item.startsWith("browser-"),
		{ budget: 3, slots: item => [1, item === "multi-file" ? 2 : 1] },
	);
	const release = async (item: string) => {
		released.get(item)!();
		await Promise.resolve();
	};
	expect(launches).toEqual([
		["browser-1", 1],
		["multi-file", 2],
	]);
	await release("multi-file");
	expect(launches.slice(2)).toEqual([
		["ordinary-1", 1],
		["ordinary-2", 1],
	]);
	await release("browser-1");
	expect(launches.at(-1)).toEqual(["browser-2", 1]);
	await release("browser-2");
	expect(launches.at(-1)).toEqual(["ordinary-3", 1]);
	for (const item of ["ordinary-1", "ordinary-2", "ordinary-3"]) await release(item);
	await pool;
	expect(peakSlots).toBe(3);
	expect(activeSlots).toBe(0);
	expect(launches.map(([item]) => item).sort()).toEqual(items.sort());
});

test("a live pool dispatches extra jobs only after its slot capacity grows", async () => {
	const unchangedPoll = Promise.withResolvers<void>();
	const expanded = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const started: [string, number][] = [];
	let budget = 2;
	let reads = 0;
	const pool = runBoundedPool(
		["weighted", "first", "second"],
		budget,
		() => false,
		4,
		async (job, slots) => {
			started.push([job, slots]);
			if (started.length === 3) expanded.resolve();
			await finish.promise;
		},
		undefined,
		{
			budget,
			slots: job => [1, job === "weighted" ? 2 : 1],
			readBudget: () => {
				if (++reads === 2) unchangedPoll.resolve();
				return budget;
			},
		},
	);
	try {
		await unchangedPoll.promise;
		expect(started).toEqual([["weighted", 2]]);
		budget = 4;
		await expanded.promise;
		expect(started).toEqual([
			["weighted", 2],
			["first", 1],
			["second", 1],
		]);
	} finally {
		finish.resolve();
		await pool;
	}
});

test("startup file workers use the fulltest budget without exceeding CPU or command count", async () => {
	const startup = fulltestCommands({ debug: false }, "home").find(
		command => command.label === "test/TypeScript startup suite",
	)!;
	for (const [cores, count, expected] of [
		[1, 3, 1],
		[8, 1, 1],
		[8, 3, 3],
		[64, 40, 28],
		[16, 40, 16],
	] as const) {
		const files = Array.from({ length: count }, (_, index) => index);
		const releases = new Map<number, () => void>();
		let active = 0;
		let peak = 0;
		const pool = runBoundedPool(
			files,
			testConcurrency(count, startup.env?.OMP_TEST_CONCURRENCY, cores),
			() =>
				isLimitedIntegrationCommand({
					label: "startup",
					cwd: "packages/coding-agent",
					command: ["bun", "test", "test/spec-driven/tui-compact-mixed.e2e.test.ts"],
				}),
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
	const rank = (producers: TestProducerRecord[]) => prioritizeBunCommands(commands, producers, "ci-test-ts:local-ts");
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
	const ordered = rank([producer(0, 1), producer(2, 20), producer(3, 20)]);
	expect(ordered).toEqual([commands[2], commands[3], commands[0], commands[1]]);
	expect(rank([])).toEqual(commands);
	const changed = producer(2, 100);
	changed.command[3] = "test/other.test.ts";
	expect(rank([changed])).toEqual(commands);
	const changedOption = producer(2, 100);
	changedOption.command.splice(4, 0, "--timeout=10");
	expect(rank([changedOption])).toEqual(commands);
	expect(rank([producer(2, 10), producer(2, 20)])).toEqual(commands);
	const relabeled = producer(2, 100);
	relabeled.producer = relabeled.producer.replace(commands[2].label, "packages/coding-agent (new chunk)");
	expect(rank([relabeled])).toEqual(commands);
	const duplicate = producer(2, 20);
	expect(rank([duplicate, { ...duplicate }])).toEqual(commands);
	expect(commands.map(command => command.command[3])).toEqual([
		"test/a.test.ts",
		"test/b.test.ts",
		"test/c.test.ts",
		"test/d.test.ts",
	]);
	const full = commands.slice(0, 3);
	const fullProducer = (index: number, duration: number): TestProducerRecord => ({
		...producer(index, duration),
		producer: `ci-test-ts:all:1234abcd:${full[index].label}:attempt-1`,
		scope: "ci-test-ts:all",
		command: [...full[index].command, ...(index === 1 ? [] : ["--parallel=1"]), "--timeout=30000"],
	});
	expect(prioritizeBunCommands(full, [producer(2, 40)], "ci-test-ts:all")).toEqual(full);
	expect(
		prioritizeBunCommands(full, [fullProducer(0, 2), fullProducer(1, 1), fullProducer(2, 40)], "ci-test-ts:all"),
	).toEqual([commands[2], commands[0], commands[1]]);
});

test("completed chunk hints do not require a successful or finalized fulltest", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-timing-history-"));
	const now = Date.now();
	const revision = "a".repeat(40);
	const currentRevision = "b".repeat(40);
	const producer = {
		producer: "ci-test-ts:local-ts:1234abcd:packages/foo (slow):attempt-1",
		command: ["bun", "test", "test/slow.test.ts", "--parallel=1", "--timeout=30000"],
		scope: "ci-test-ts:local-ts",
		attempt: 1,
		startedAt: new Date(now - 60_000).toISOString(),
		durationSeconds: 12,
		exitCode: 0,
		status: "passed",
		selection: { tool: "bun", mode: "full", group: "ordinary", suiteRevision: BUN_FORK_SUITE_REVISION },
		report: "available",
	} satisfies TestProducerRecord & { report: string };
	const put = async (overrides: object = {}, records: unknown[] = [producer]) => {
		const dir = path.join(root, "history");
		await fs.rm(dir, { recursive: true, force: true });
		await fs.mkdir(dir);
		await Bun.write(
			path.join(dir, "run.json"),
			JSON.stringify({
				runId: "history",
				scope: "fulltest: fork feature suites",
				startedAtUtc: new Date(now - 120_000).toISOString(),
				completion: "running",
				exitCode: null,
				sourceRevision: revision,
				platform: process.platform,
				architecture: process.arch,
				runtimeVersions: { bun: Bun.version },
				producers: [],
				...overrides,
			}),
		);
		await Promise.all(
			records.map((record, index) => Bun.write(path.join(dir, `${index}.producer.json`), JSON.stringify(record))),
		);
	};
	const readHistory = (source: string | undefined = currentRevision) =>
		latestFulltestBunProducers("ci-test-ts:local-ts", source, root, now, "current");
	try {
		expect(await readHistory()).toEqual([]);
		await put();
		expect(await readHistory()).toEqual([producer]);
		for (const overrides of [
			{ completion: "partial", exitCode: 1 },
			{ completion: "complete", exitCode: 1 },
			{ reconciliation: { status: "invalid", cases: 0, failures: 1 } },
			{ unreconciledScope: "cancelled before reconciliation" },
		]) {
			await put(overrides);
			expect(await readHistory()).toEqual([producer]);
		}
		await put({}, [{ ...producer, status: "failed", exitCode: 1 }]);
		expect(await readHistory()).toEqual([{ ...producer, status: "failed", exitCode: 1 }]);
		// Historical finalized summaries still work when no incremental records exist.
		await put({ completion: "complete", exitCode: 0, producers: [producer] }, []);
		expect(await readHistory()).toEqual([producer]);
		expect(await readHistory(revision)).toEqual([producer]);
		expect(await latestFulltestBunProducers("ci-test-ts:local-ts", undefined, root, now, "current")).toEqual([]);
		expect(await readHistory("invalid")).toEqual([]);
		expect(await readHistory("c".repeat(64))).toEqual([producer]);
		for (const overrides of [
			{ runId: "current" },
			{ scope: "fulltest: all test suites" },
			{ sourceRevision: "invalid" },
			{ sourceRevision: null },
			{ sourceRevision: "b".repeat(41) },
			{ runtimeVersions: { bun: "other" } },
			{ runtimeVersions: null },
			{ startedAtUtc: new Date(now - 8 * 86400000).toISOString() },
			{ startedAtUtc: new Date(now + 1000).toISOString() },
			{ startedAtUtc: "invalid" },
			{ architecture: "other" },
			{ platform: "other" },
		]) {
			await put(overrides);
			expect(await readHistory()).toEqual([]);
		}
		for (const overrides of [
			{ status: "partial" },
			{ status: "not-selected" },
			{ status: "failed", exitCode: 137 },
			{ status: "passed", exitCode: 1 },
			{ report: "missing" },
			{ durationSeconds: -1 },
			{ durationSeconds: null },
			{ attempt: 2 },
			{ startedAt: "invalid" },
			{ startedAt: new Date(now + 1000).toISOString() },
			{ startedAt: new Date(now - 180_000).toISOString() },
			{ selection: { ...producer.selection, mode: "affected" } },
			{ selection: { ...producer.selection, suiteRevision: 8 } },
			{ selection: { tool: "bun", mode: "full", group: "ordinary" } },
			{ selection: { ...producer.selection, group: "other" } },
		]) {
			// An unusable incremental record must not fall back to a stale summary.
			await put({ producers: [producer] }, [{ ...producer, ...overrides }]);
			expect(await readHistory()).toEqual([]);
		}
		await put({ producers: [producer] }, [null]);
		expect(await readHistory()).toEqual([]);
		await Bun.write(path.join(root, "history", "0.producer.json"), "{");
		expect(await readHistory()).toEqual([]);
		const fullRun = { scope: "fulltest: all test suites" };
		const fullProducer = {
			...producer,
			producer: producer.producer.replace("ci-test-ts:local-ts:", "ci-test-ts:all:"),
			scope: "ci-test-ts:all",
			status: "failed",
			exitCode: 1,
			selection: { tool: "bun", mode: "full", group: "ordinary" },
		};
		const readFullHistory = () => latestFulltestBunProducers("ci-test-ts:all", currentRevision, root, now, "current");
		const dir = path.join(root, "history");
		await put({}, [fullProducer]);
		expect(await readFullHistory()).toEqual([]);
		await put(fullRun, [producer, fullProducer]);
		expect(await readHistory()).toEqual([]);
		expect(await readFullHistory()).toEqual([fullProducer]);
		expect(await isActiveBunFulltest("ci-test-ts:all", dir, "history")).toBe(true);
		expect(await isActiveBunFulltest("ci-test-ts:local-ts", dir, "history")).toBe(false);
		expect(await isActiveBunFulltest("ci-test-ts:all", dir, "other-id")).toBe(false);
		await put({ ...fullRun, completion: "complete", exitCode: 1 }, [
			{ ...fullProducer, selection: { ...fullProducer.selection, mode: "affected" } },
		]);
		expect(await readFullHistory()).toEqual([]);
		expect(await isActiveBunFulltest("ci-test-ts:all", dir, "history")).toBe(false);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("each exact chunk keeps its latest usable measurement across interrupted runs", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-timing-order-"));
	const now = Date.now();
	const revision = "a".repeat(40);
	const commands = ["fast", "slow", "unknown-a", "unknown-b"].map(name => ({
		label: `packages/foo (${name})`,
		cwd: "packages/foo",
		command: ["bun", "test", `test/${name}.test.ts`],
		parallel: 1,
	}));
	const producer = (index: number, durationSeconds: number, age: number) => ({
		producer: `ci-test-ts:local-ts:1234abcd:${commands[index].label}:attempt-1`,
		command: [...commands[index].command, "--parallel=1", "--timeout=30000"],
		scope: "ci-test-ts:local-ts",
		attempt: 1,
		startedAt: new Date(now - age).toISOString(),
		durationSeconds,
		exitCode: 0,
		status: "passed",
		selection: { tool: "bun", mode: "full", group: "ordinary", suiteRevision: BUN_FORK_SUITE_REVISION },
		report: "available",
	});
	const put = async (name: string, age: number, records: object[], overrides: object = {}) => {
		const dir = path.join(root, name);
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			path.join(dir, "run.json"),
			JSON.stringify({
				runId: name,
				scope: "fulltest: fork feature suites",
				startedAtUtc: new Date(now - age).toISOString(),
				completion: "partial",
				exitCode: 1,
				sourceRevision: revision,
				platform: process.platform,
				architecture: process.arch,
				runtimeVersions: { bun: Bun.version },
				producers: [],
				...overrides,
			}),
		);
		await Promise.all(
			records.map((record, index) => Bun.write(path.join(dir, `${index}.producer.json`), JSON.stringify(record))),
		);
	};
	const rank = (items: typeof commands, producers: TestProducerRecord[]) =>
		prioritizeBunCommands(items, producers, "ci-test-ts:local-ts");
	const readHistory = () => latestFulltestBunProducers("ci-test-ts:local-ts", revision, root, now, "current");
	const ordered = async () => rank(commands, await readHistory());
	try {
		const fast = producer(0, 1, 180_000);
		const slow = producer(1, 20, 180_000);
		await put("older", 240_000, [fast, slow], { completion: "complete", exitCode: 0 });
		expect(await ordered()).toEqual([commands[1], commands[0], commands[2], commands[3]]);
		// Only the fast chunk finished in the failed run; the slow hint survives.
		const newerFast = producer(0, 30, 90_000);
		await put("failed", 120_000, [newerFast]);
		const history = await readHistory();
		expect(history).toHaveLength(2);
		expect(history).toEqual(expect.arrayContaining([newerFast, slow]));
		expect(await ordered()).toEqual(commands);
		// Cancellation left run.json running and only incremental completed records.
		const newerSlow = producer(1, 40, 60_000);
		await put("cancelled", 80_000, [newerSlow], { completion: "running", exitCode: null });
		expect(await ordered()).toEqual([commands[1], commands[0], commands[2], commands[3]]);
		// A killed or missing chunk never replaces its last complete measurement.
		await put("killed", 40_000, [
			{ ...producer(0, 100, 30_000), status: "partial", exitCode: 137 },
			{ ...producer(1, 100, 30_000), report: "missing" },
		]);
		expect(await ordered()).toEqual([commands[1], commands[0], commands[2], commands[3]]);
		await put("current", 20_000, [producer(0, 999, 10_000)], { completion: "running" });
		expect(await ordered()).toEqual([commands[1], commands[0], commands[2], commands[3]]);
		// Relabeling or changing argv makes a new identity, not an inherited duration.
		const changed = commands.map(command => ({ ...command, command: [...command.command] }));
		changed[1].command[2] = "test/changed.test.ts";
		expect(rank(changed, await readHistory())).toEqual(changed);
		changed[1].command = [...commands[1].command];
		changed[1].label = "packages/foo (relabeled)";
		expect(rank(changed, await readHistory())).toEqual(changed);
		// Equal-time conflicting records are ambiguous, not a fabricated duration.
		await put("ambiguous", 20_000, [producer(1, 5, 10_000), producer(1, 50, 10_000)]);
		expect(await ordered()).toEqual(commands);
		await fs.mkdir(path.join(root, "invalid"));
		await Bun.write(path.join(root, "invalid", "run.json"), "{");
		expect(await ordered()).toEqual(commands);
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
				OMP_FULLTEST_AFFECTED: env.OMP_FULLTEST_AFFECTED ?? "",
				OMP_FULLTEST_BASELINE: env.OMP_FULLTEST_BASELINE ?? "",
				OMP_FULLTEST_SOURCE_REVISION: env.OMP_FULLTEST_SOURCE_REVISION ?? "",
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
		// Only the failure observer's leaf import needs a package.
		const utils = "node_modules/@oh-my-pi/pi-utils";
		await fs.mkdir(path.join(root, utils, "src"), { recursive: true });
		for (const file of ["package.json", "src/expected-cleanup.ts"]) {
			await fs.copyFile(path.join(sourceRoot, "packages/utils", file), path.join(root, utils, file));
		}
		const fixture = (name: string) =>
			`import { test } from "bun:test"; import { appendFileSync } from "node:fs"; test(${JSON.stringify(name)}, () => appendFileSync(process.env.MARKER!, ${JSON.stringify(`${name}\n`)}));\n`;
		const selected = [
			"packages/ai/test/proxy.test.ts",
			"packages/collab-web/test/composer.test.tsx",
			"packages/collab-web/test/transcript.test.tsx",
			"packages/collab-web/test/tool-view.test.tsx",
			"packages/collab-web/test/markdown.test.tsx",
			"packages/coding-agent/test/spec-driven/resources.test.ts",
			"packages/coding-agent/test/spec-driven/skill-policy.test.ts",
			"packages/coding-agent/test/spec-driven/process.e2e.test.ts",
			"packages/coding-agent/test/team/integration.test.ts",
			"packages/coding-agent/test/goals/goal-runtime.test.ts",
			"packages/coding-agent/test/cli/openwiki.test.ts",
			"packages/coding-agent/test/openwiki/resources.test.ts",
			"packages/coding-agent/test/openwiki/model-selection.test.ts",
			"packages/coding-agent/test/lsp/edits.test.ts",
			"packages/coding-agent/test/acp-builtins.test.ts",
			"packages/tui/test/composer-inline-shrink.test.ts",
			"packages/tui/test/composer-welcome-scrollback.test.ts",
			"packages/tui/test/transcript-container.test.ts",
			"packages/tui/test/transcript-seam-loss.test.ts",
			"packages/coding-agent/test/ui/transcript/messages/assistant-message.test.tsx",
			"packages/coding-agent/test/event-controller-thinking-preview.test.ts",
			"packages/coding-agent/test/interactive-terminal-e2e.test.ts",
			"packages/coding-agent/test/modes/utils/render-initial-messages.test.ts",
		];
		const excluded = [
			"packages/ai/test/unrelated.test.ts",
			"packages/natives/test/desktop.test.ts",
			"packages/natives/test/vcs.test.ts",
			"packages/natives/test/relay.test.ts",
			"packages/collab-web/test/browser.test.tsx",
			"packages/collab-web/test/upload.test.tsx",
			"packages/collab-web/test/relay.test.ts",
			"packages/coding-agent/test/tools/browser-launch.test.ts",
			"packages/coding-agent/test/tools/proc-service.test.ts",
			"packages/coding-agent/test/tools/lsp-regressions.test.ts",
			"packages/coding-agent/test/task/worktree.test.ts",
			"packages/coding-agent/test/rpc.test.ts",
			"packages/coding-agent/test/settings-full-scope.test.ts",
		];
		for (const file of [...selected, ...excluded]) await put(file, fixture(file));
		await put(
			"packages/coding-agent/test/loop-limit.test.ts",
			'import { test, expect } from "bun:test"; import { appendFileSync } from "node:fs"; test("failure", () => { appendFileSync(process.env.MARKER!, "failure\\n"); expect(Boolean(process.env.FAIL_FIXTURE)).toBe(false); }); test("after failure", () => appendFileSync(process.env.MARKER!, "after-failure\\n"));\n',
		);
		const fullMarkers = [...selected, "failure", "after-failure"].sort();
		const dry = await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--dry-run"]);
		expect(await executed()).toEqual([]);
		expect(dry).toContain(`scope=fork-features selected-files=${selected.length + 1} `);
		for (const file of excluded) expect(dry).not.toContain(file.replace("packages/coding-agent/", ""));
		await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts"], { OMP_TEST_SHARD: "1/20" });
		const reportRoot = path.join(root, "runs/test-timing");
		const reportDirectories = await fs.readdir(reportRoot);
		expect(reportDirectories).toHaveLength(1);
		const report = JSON.parse(
			await fs.readFile(path.join(reportRoot, reportDirectories[0]!, "run.json"), "utf8"),
		) as { scope: string; producers: TestProducerRecord[] };
		// The inherited shard remains reporting provenance even though local-ts
		// executes the complete fork selection (verified by the execution markers).
		const expectedScope = "ci-test-ts:local-ts:shard-1/20";
		expect(report.scope).toBe(expectedScope);
		const bunProducers = report.producers.filter(producer => producer.scope === expectedScope);
		expect(bunProducers.length).toBeGreaterThan(0);
		for (const producer of bunProducers) {
			expect(producer.selection).toMatchObject({
				tool: "bun",
				mode: "full",
				suiteRevision: BUN_FORK_SUITE_REVISION,
			});
			expect(producer.exitCode).toBe(0);
			expect(producer.status).toBe("passed");
		}
		const collabProducer = bunProducers.find(producer => producer.command.includes("test/composer.test.tsx"));
		expect(collabProducer?.command.filter(arg => arg.endsWith(".test.tsx")).sort()).toEqual(
			[
				"test/composer.test.tsx",
				"test/markdown.test.tsx",
				"test/tool-view.test.tsx",
				"test/transcript.test.tsx",
			].sort(),
		);
		expect(await executed()).toEqual(fullMarkers);
		await clear();
		const emptyStartup = await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--only-startup"]);
		expect(emptyStartup).toContain("test-command-group=startup chunks=0");
		expect(await executed()).toEqual([]);
		await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--defer-startup", "--only-startup"], {}, 1);
		const startupFiles = [
			"test/spec-driven/tui-compact-mixed.e2e.test.ts",
			"test/spec-driven/tui-resources.e2e.test.ts",
			"test/spec-driven/tui-capabilities.e2e.test.ts",
			"test/goals/goal-autopilot-tui.e2e.test.ts",
			"test/goals/goal-ctrl-enter-tui.e2e.test.ts",
			"test/startup-composer.test.ts",
		];
		for (const file of startupFiles) {
			await put(
				`packages/coding-agent/${file}`,
				`import { test } from "bun:test"; import { appendFileSync } from "node:fs"; test(${JSON.stringify(file)}, () => { appendFileSync(process.env.MARKER!, ${JSON.stringify(`${file}\n`)}); appendFileSync(process.env.MARKER! + ".pids", process.pid + "\\n"); });\n`,
			);
		}
		await clear();
		const ordinary = fulltestCommands({ debug: false }, path.join(temp, "home")).find(
			command => command.label === "test/TypeScript fork feature suite",
		)!;
		const ordinaryOutput = await run(
			[process.execPath, ...ordinary.argv.slice(1)],
			{
				...ordinary.env,
				CI: "true",
				OMP_TEST_CONCURRENCY: "2",
				OMP_GATE_EVENT_TOKEN: "isolated-fixture-token",
				FAIL_FIXTURE: "1",
			},
			1,
		);
		expect(ordinaryOutput).toContain("test-command-group=ordinary");
		expect(await executed()).toEqual(fullMarkers);
		const startup = fulltestCommands({ debug: false }, path.join(temp, "home")).find(
			command => command.label === "test/TypeScript startup suite",
		)!;
		await run([process.execPath, ...startup.argv.slice(1)], { ...startup.env });
		expect(await executed()).toEqual([...fullMarkers, ...startupFiles].sort());
		const pids = (await fs.readFile(`${marker}.pids`, "utf8")).trim().split("\n");
		expect(new Set(pids).size).toBe(startupFiles.length);
		const affected = await run([
			process.execPath,
			"scripts/ci-test-ts.ts",
			"local-ts",
			"--changed=HEAD",
			"--dry-run",
		]);
		const testCommand = (file: string) =>
			affected.split("\n").find(line => line.startsWith("$ ") && line.includes(file));
		expect(testCommand("test/team/integration.test.ts")).toContain("--changed=HEAD");
		expect(testCommand("test/startup-composer.test.ts")).toContain("--changed=HEAD");
		const singletonFiles = Array.from(
			{ length: 23 },
			(_, i) => `test/settings-${String(i).padStart(2, "0")}.test.ts`,
		);
		await put("packages/coding-agent/test/settings.test.ts", fixture("settings"));
		for (const file of singletonFiles) await put(`packages/coding-agent/${file}`, fixture(file));
		const output = await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--dry-run"]);
		for (const file of singletonFiles) expect(output).not.toContain(file);
		const dryCommands = (output: string) =>
			output
				.split("\n")
				.filter(line => line.startsWith("$ "))
				.map(line => line.trimEnd().replace(/ --parallel=\S+ --timeout=\S+$/, ""));
		const verifyShards = async (mode: string, files: string[], count: number) => {
			const dryRun = (shard = "") =>
				run([process.execPath, "scripts/ci-test-ts.ts", mode, "--dry-run"], {
					CI: "true",
					OMP_TEST_SHARD: shard,
				});
			const [unsharded, ...shards] = await Promise.all([
				dryRun(),
				...Array.from({ length: count }, (_, index) => dryRun(`${index + 1}/${count}`)),
			]);
			const commands = dryCommands(unsharded);
			const shardedCommands = shards.flatMap(dryCommands);
			for (const file of files) expect(shardedCommands.filter(line => line.includes(file))).toHaveLength(1);
			// Shards are chosen before priority sorting, so compare their combined
			// membership without using the unsharded launch order as shard indices.
			expect(shardedCommands.sort()).toEqual(commands.sort());
			for (const [index, shard] of shards.entries()) {
				const expectedSize = Math.floor(commands.length / count) + Number(index < commands.length % count);
				expect(dryCommands(shard)).toHaveLength(expectedSize);
			}
			return unsharded;
		};
		await verifyShards("coding-agent-singleton", ["test/settings.test.ts", ...singletonFiles], 3);
		const nativeFiles = Array.from({ length: 11 }, (_, i) => `test/native-${String(i).padStart(2, "0")}.test.ts`);
		await put("packages/coding-agent/test/native.test.ts", fixture("native"));
		for (const file of nativeFiles) await put(`packages/coding-agent/${file}`, fixture(file));
		const before = await verifyShards("coding-agent-native", ["test/native.test.ts", ...nativeFiles], 2);
		if (process.platform === "win32") {
			const labelFor = (output: string, file: string) =>
				output.split("\n").find(line => line.startsWith("==> ") && line.includes(file));
			await put("packages/coding-agent/test/native-00-early.test.ts", fixture("earlier native"));
			const after = await run([process.execPath, "scripts/ci-test-ts.ts", "coding-agent-native", "--dry-run"]);
			for (const file of nativeFiles) {
				expect(labelFor(before, file)).toBeDefined();
				expect(labelFor(after, file)).toBe(labelFor(before, file));
			}
		}

		// The shared all-mode still includes the complete package list in this
		// artificial checkout, rather than replacing it with the fork selection.
		for (const cwd of [
			"packages/omptype",
			"packages/utils",
			"packages/catalog",
			"packages/snapcompact",
			"packages/agent",
			"packages/mnemopi",
			"packages/typescript-edit-benchmark",
			"packages/stats",
			"packages/metaharness",
			"python/robomp/web",
		]) {
			const file = `${cwd}/test/full.test.ts`;
			await put(file, fixture(file));
		}
		await put(".omp/tests/tui.test.ts", fixture("project tools"));
		await put(
			"packages/coding-agent/test/tools/browser-launch.test.ts",
			`// launchHeadlessBrowser()
import { writeFileSync } from "node:fs";
writeFileSync(process.env.MARKER! + ".startup-home", process.env.HOME!);
${fixture("browser acceptance")}`,
		);
		await put(
			"packages/ai/test/unrelated.test.ts",
			`import { writeFileSync } from "node:fs";
writeFileSync(process.env.MARKER! + ".ordinary-home", process.env.HOME!);
${fixture("packages/ai/test/unrelated.test.ts")}`,
		);
		const full = fulltestCommands({ debug: false, full: true }, path.join(temp, "home")).find(
			command => command.argv[1] === "scripts/ci-test-ts.ts",
		)!;
		const fullArgv = [process.execPath, ...full.argv.slice(1)];
		const fullEnv = { ...full.env, OMP_TEST_SHARD: "1/200" };
		const serialCommands = dryCommands(
			await run([...fullArgv, "--dry-run"], { ...fullEnv, OMP_TEST_CPU_BUDGET: "1" }),
		);
		const parallelCommands = dryCommands(
			await run([...fullArgv, "--dry-run"], { ...fullEnv, OMP_TEST_CPU_BUDGET: "3" }),
		);
		const isStartup = (command: string) =>
			[...startupFiles, "test/tools/browser-launch.test.ts"].some(file => command.includes(file));
		expect(serialCommands.slice(0, startupFiles.length + 1).every(isStartup)).toBe(true);
		expect(serialCommands.slice(startupFiles.length + 1).some(isStartup)).toBe(false);
		expect(parallelCommands[0]).toBe(serialCommands[0]);
		expect(parallelCommands.slice(1, 3).some(command => !isStartup(command))).toBe(true);
		await clear();
		const priorReports = new Set(await fs.readdir(reportRoot));
		await run(fullArgv, { ...fullEnv, OMP_TEST_CPU_BUDGET: "3" });
		expect(await executed()).toContain("packages/ai/test/unrelated.test.ts");
		expect(await executed()).toContain("browser acceptance");
		expect(await executed()).not.toContain("packages/natives/test/desktop.test.ts");
		expect(await fs.readFile(`${marker}.startup-home`, "utf8")).toBe(full.env?.OMP_FULLTEST_STARTUP_HOME);
		expect(await fs.readFile(`${marker}.ordinary-home`, "utf8")).toBe(full.env?.HOME);
		const fullReportDirs = (await fs.readdir(reportRoot)).filter(name => !priorReports.has(name));
		expect(fullReportDirs).toHaveLength(1);
		const fullReport = JSON.parse(
			await fs.readFile(path.join(reportRoot, fullReportDirs[0]!, "run.json"), "utf8"),
		) as { scope: string; producers: TestProducerRecord[] };
		expect(fullReport.scope).toBe("ci-test-ts:all");
		expect(fullReport.producers).toHaveLength(serialCommands.length);
		for (const producer of fullReport.producers) {
			const group = isStartup(producer.command.join(" ")) ? "startup" : "ordinary";
			expect(producer.selection).toMatchObject({ tool: "bun", mode: "full", group });
			expect(producer.status).toBe("passed");
		}
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}, 240_000);
