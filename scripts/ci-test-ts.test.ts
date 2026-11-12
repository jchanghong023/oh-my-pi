import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	bunCleanBaseline,
	budgetedParallel,
	bunTestSelection,
	devWorkbenchInputsChanged,
	isDevFrontendInput,
	isIntegrationCommand,
	isLimitedIntegrationCommand,
	prioritizeLocalCommands,
	runBoundedPool,
	testConcurrency,
	verifiedFulltestRevision,
} from "./ci-test-ts";
import { latestLocalTestProducers, type TestProducerRecord } from "./test-reporting";
import { fulltestCommands } from "./fulltest";
import { testConcurrencyLimit } from "./test-gate-scheduler";

test("Bun discovery keeps OMP consumers but excludes vendor and explicit packaged verification", async () => {
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
		await Bun.write(
			path.join(root, "packages/coding-agent/scripts/verify-dev-workbench-package.ts"),
			'throw new Error("PACKAGED_VERIFICATION_RAN_WITHOUT_AUTHORIZATION");\n',
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
		expect(stdout + stderr).not.toContain("PACKAGED_VERIFICATION_RAN_WITHOUT_AUTHORIZATION");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("Dev dynamic resource inputs select their consumers without selecting original WebGUI or upstream suites", () => {
	const command = (cwd: string, file: string) => ({ cwd, command: ["bun", "test", file] });
	const consumers = [
		command("packages/coding-agent", "test/dev-workbench/resources.test.ts"),
		command("packages/coding-agent", "test/dev-workbench/workflow-process.e2e.test.ts"),
		command("packages/collab-web", "test/dev-workbench.test.tsx"),
	];
	for (const input of [
		"packages/dev-frontend/preview/main.tsx",
		"packages/dev-frontend/preview/vite.config.ts",
		"packages/dev-frontend/packages/ui/src/styles.css",
		"packages/dev-frontend/packages/ui/src/workers/fileSearch.worker.ts",
		"packages/dev-frontend/packages/ui/vite/pdfJsCMapsPlugin.ts",
		"packages/dev-frontend/packages/web/public/material-icons/dark/file.svg",
		"packages/dev-frontend/packages/client/src/index.ts",
		"packages/dev-frontend/package.json",
		"packages/dev-frontend/bun.lock",
		"packages/dev-frontend/copy-manifest.json",
		"packages/dev-frontend/tsconfig.base.json",
	]) {
		expect(isDevFrontendInput(input)).toBe(true);
		for (const consumer of consumers) expect(devWorkbenchInputsChanged(consumer, [input])).toBe(true);
		for (const unrelated of [
			command("packages/coding-agent", "test/webgui/core-browser.e2e.test.ts"),
			command("packages/coding-agent", "test/team/integration.test.ts"),
			command("packages/coding-agent", "test/dev-workbench/workflow-store.test.ts"),
			command("packages/natives", "test/dev-workbench-vcs.test.ts"),
		])
			expect(devWorkbenchInputsChanged(unrelated, [input])).toBe(false);
	}
	for (const input of [
		"packages/dev-frontend/NOTICE.md",
		"packages/dev-frontend/build/dev/assets/index.js",
		"packages/dev-frontend/node_modules/react/index.js",
		"packages/coding-agent/src/dev-workbench/assets.generated.json",
		"vendor/zcode-frontend/preview/main.tsx",
		"packages/collab-web/src/main.tsx",
	]) {
		expect(isDevFrontendInput(input)).toBe(false);
		for (const consumer of consumers) expect(devWorkbenchInputsChanged(consumer, [input])).toBe(false);
	}
	for (const input of [
		"packages/coding-agent/scripts/dev-workbench-resources.ts",
		"packages/coding-agent/src/dev-workbench/assets.ts",
	])
		for (const consumer of consumers) expect(devWorkbenchInputsChanged(consumer, [input])).toBe(true);
});

test("affected selection needs a qualifying full TS baseline reachable in Git", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-baseline-"));
	const previous = process.env.OMP_FULLTEST_AFFECTED;
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
		expect(await verifiedFulltestRevision(undefined, root)).toBeUndefined();
		expect(await verifiedFulltestRevision("invalid", root)).toBeUndefined();
		expect(await verifiedFulltestRevision("a".repeat(40), root)).toBeUndefined();
		expect((await bunTestSelection(root)).mode).toBe("full");
		await git("init", "-q");
		await git("config", "user.email", "fixture@example.invalid");
		await git("config", "user.name", "Fixture");
		await fs.writeFile(path.join(root, "fixture.ts"), "export const value = 1;\n");
		await fs.writeFile(path.join(root, ".gitignore"), "runs/\n");
		await git("add", "fixture.ts", ".gitignore");
		await git("commit", "-qm", "fixture baseline");
		const revision = await git("rev-parse", "HEAD");
		expect(await verifiedFulltestRevision(revision, root)).toBe(revision);
		expect(await verifiedFulltestRevision("b".repeat(40), root)).toBeUndefined();
		const dir = path.join(root, "runs", "test-timing", "fixture");
		await fs.mkdir(dir, { recursive: true });
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
					selection: { mode: "full", group: "ordinary", suiteRevision: 4 },
				},
				{
					scope: "ci-test-ts:local-ts",
					exitCode: 0,
					status: "passed",
					report: "available",
					selection: { mode: "full", group: "startup", suiteRevision: 4 },
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
				selection?: { mode: string; group?: string; suiteRevision?: number };
			}[],
		};
		const save = () => fs.writeFile(path.join(dir, "run.json"), JSON.stringify(report));
		await save();
		report.scope = "fulltest: full current-platform project suites";
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.scope = "fulltest: fork feature suites";
		await save();
		// Ordinary and startup producers together cover the current fork TS scope.
		expect(await bunTestSelection(root)).toMatchObject({ mode: "affected", baseline: revision });
		// A newer failure/cancellation/incomplete attempt must not inherit an
		// older clean success and omit the unchanged tests that just failed.
		const newer = path.join(root, "runs", "test-timing", "zz-newer-attempt");
		await fs.mkdir(newer);
		for (const [completion, exitCode] of [
			["partial", 23],
			["partial", 130],
			["running", null],
		] as const) {
			await fs.writeFile(
				path.join(newer, "run.json"),
				JSON.stringify({ ...report, completion, exitCode, startedAtUtc: new Date().toISOString() }),
			);
			expect((await bunTestSelection(root)).mode).toBe("full");
		}
		await fs.writeFile(
			path.join(newer, "run.json"),
			JSON.stringify({ ...report, runId: "zz-newer-attempt", completion: "running", exitCode: null }),
		);
		expect(await bunTestSelection(root, true, null, "zz-newer-attempt")).toMatchObject({
			mode: "affected",
			baseline: revision,
		});
		expect((await bunTestSelection(root, true, null, "different-current-run")).mode).toBe("full");
		await fs.rm(newer, { recursive: true });
		// Reports from before the workbench cutover do not cover the current consumers.
		report.producers[0]!.selection = { mode: "full", group: "ordinary" };
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.producers[0]!.selection = { mode: "full", group: "ordinary", suiteRevision: 4 };
		report.producers[1]!.selection = { mode: "full", group: "startup" };
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.producers[1]!.selection = { mode: "full", group: "startup", suiteRevision: 4 };
		await save();
		for (const index of [0, 1]) {
			report.producers[index]!.selection!.suiteRevision = 3;
			await save();
			expect((await bunTestSelection(root)).mode).toBe("full");
			report.producers[index]!.selection!.suiteRevision = 4;
		}
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
		// Scheduling provenance is the Git revision, not a worktree content snapshot.
		expect(await verifiedFulltestRevision(revision, root)).toBe(revision);
		report.dirtyState = "dirty";
		await save();
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
			selection: { mode: "full", group: "ordinary", suiteRevision: 4 },
		};
		const startup = report.producers.splice(1, 1)[0]!;
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.producers.push(startup);
		await save();
		expect(await bunTestSelection(root)).toMatchObject({ mode: "affected", baseline: revision });
		report.producers.splice(report.producers.indexOf(startup), 1);
		report.producers.push({ ...startup, exitCode: 1, status: "failed" });
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.producers.pop();
		report.producers.push({ ...startup, selection: { mode: "full", group: "ordinary", suiteRevision: 4 } });
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.producers.pop();
		report.producers.push({ ...startup, report: "missing" });
		await save();
		expect((await bunTestSelection(root)).mode).toBe("full");
		report.producers.pop();
		report.producers.push(startup);
		await save();
		expect(await bunTestSelection(root)).toMatchObject({ mode: "affected", baseline: revision });
		await git("add", "fixture.ts");
		await git("commit", "-qm", "working tree change");
		expect(await verifiedFulltestRevision(revision, root)).toBeUndefined();
		await git("checkout", "-q", "--orphan", "unrelated");
		await git("add", "fixture.ts");
		await git("commit", "-qm", "unrelated history");
		expect((await bunTestSelection(root)).mode).toBe("full");
	} finally {
		if (previous === undefined) delete process.env.OMP_FULLTEST_AFFECTED;
		else process.env.OMP_FULLTEST_AFFECTED = previous;
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
	for (const file of ["test/dev-workbench/git.test.ts", "test/dev-workbench/workflow-domain.test.ts"]) {
		expect(isIntegrationCommand(command("packages/coding-agent", [file]))).toBe(true);
		expect(isLimitedIntegrationCommand(command("packages/coding-agent", [file]))).toBe(true);
		expect(isIntegrationCommand(command("packages/tui", [file]))).toBe(false);
	}
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/dev-workbench/cancel-policy.test.ts"]))).toBe(
		false,
	);
	expect(isIntegrationCommand(command("packages/coding-agent", ["test/integrationish.test.ts"]))).toBe(false);
	expect(isIntegrationCommand(command("packages/tui", ["test/process.e2e.test.ts"]))).toBe(false);
});

test("startup integration chunks bypass only the heavy integration limit", () => {
	const command = (file: string) => ({ label: "chunk", cwd: "packages/coding-agent", command: ["bun", "test", file] });
	for (const file of [
		"test/dev-workbench/process.e2e.test.ts",
		"test/dev-workbench/workflow-process.e2e.test.ts",
		"test/spec-driven/tui-compact-mixed.e2e.test.ts",
		"test/goals/goal-autopilot-tui.e2e.test.ts",
		"test/goals/goal-ctrl-enter-tui.e2e.test.ts",
	]) {
		expect(isIntegrationCommand(command(file))).toBe(true);
		expect(isLimitedIntegrationCommand(command(file))).toBe(false);
	}
	expect(isLimitedIntegrationCommand(command("test/dev-workbench/host.test.ts"))).toBe(false);
	expect(isLimitedIntegrationCommand(command("test/dev-workbench/other.e2e.test.ts"))).toBe(true);
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
						? "test/dev-workbench/git.test.ts"
						: item === "h5"
							? "test/dev-workbench/workflow-domain.test.ts"
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
					command: ["bun", "test", "test/dev-workbench/process.e2e.test.ts"],
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
	const relabeled = producer(2, 100);
	relabeled.producer = relabeled.producer.replace(commands[2].label, "packages/coding-agent (new chunk)");
	expect(prioritizeLocalCommands(commands, [relabeled])).toEqual(commands);
	const duplicate = producer(2, 20);
	expect(prioritizeLocalCommands(commands, [duplicate, { ...duplicate }])).toEqual(commands);
	expect(commands.map(command => command.command[3])).toEqual([
		"test/a.test.ts",
		"test/b.test.ts",
		"test/c.test.ts",
		"test/d.test.ts",
	]);
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
		selection: { tool: "bun", mode: "full", group: "ordinary", suiteRevision: 4 },
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
	const readHistory = () => latestLocalTestProducers(currentRevision, root, now, "current");
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
		expect(await latestLocalTestProducers(revision, root, now, "current")).toEqual([producer]);
		expect(await latestLocalTestProducers(undefined, root, now, "current")).toEqual([]);
		expect(await latestLocalTestProducers("invalid", root, now, "current")).toEqual([]);
		expect(await latestLocalTestProducers("c".repeat(64), root, now, "current")).toEqual([producer]);
		for (const overrides of [
			{ runId: "current" },
			{ scope: "fulltest: full current-platform project suites" },
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
			{ selection: { ...producer.selection, suiteRevision: 3 } },
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
		selection: { tool: "bun", mode: "full", group: "ordinary", suiteRevision: 4 },
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
	const readHistory = () => latestLocalTestProducers(revision, root, now, "current");
	const ordered = async () => prioritizeLocalCommands(commands, await readHistory());
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
		expect(prioritizeLocalCommands(changed, await readHistory())).toEqual(changed);
		changed[1].command = [...commands[1].command];
		changed[1].label = "packages/foo (relabeled)";
		expect(prioritizeLocalCommands(changed, await readHistory())).toEqual(changed);
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
			"packages/natives/test/dev-workbench-vcs.test.ts",
			"packages/collab-web/test/dev-workbench.test.tsx",
			"packages/collab-web/test/composer.test.tsx",
			"packages/collab-web/test/transcript.test.tsx",
			"packages/collab-web/test/tool-view.test.tsx",
			"packages/collab-web/test/markdown.test.tsx",
			...[
				"records",
				"git",
				"cancel",
				"host",
				"server",
				"collab",
				"cli",
				"resources",
				"workflow-store",
				"workflow-git",
				"workflow-runtime",
				"requirement-package",
			].map(name => `packages/coding-agent/test/dev-workbench/${name}.test.ts`),
			"packages/coding-agent/test/spec-driven/process.e2e.test.ts",
			"packages/coding-agent/test/team/integration.test.ts",
			"packages/coding-agent/test/goals/goal-runtime.test.ts",
			"packages/coding-agent/test/knowledge-index.test.ts",
			"packages/coding-agent/test/knowledge-models.test.ts",
			"packages/coding-agent/test/knowledge-semantic.test.ts",
			"packages/coding-agent/test/lsp/edits.test.ts",
			"packages/coding-agent/test/slash-commands/shared-skills.test.ts",
			"packages/coding-agent/test/acp-builtins.test.ts",
			"packages/coding-agent/test/webgui/mcp-disabled.test.ts",
			"packages/tui/test/composer-inline-shrink.test.ts",
			"packages/tui/test/composer-welcome-scrollback.test.ts",
			"packages/tui/test/transcript-container.test.ts",
			"packages/tui/test/transcript-seam-loss.test.ts",
			"packages/tui/test/thinking-preview.test.ts",
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
			"packages/coding-agent/test/webgui/native-mcp.test.ts",
			"packages/coding-agent/test/webgui/native-mcp-binding.test.ts",
		];
		for (const file of [...selected, ...excluded]) await put(file, fixture(file));
		await put(
			"packages/coding-agent/scripts/verify-dev-workbench-package.ts",
			'throw new Error("PACKAGED_VERIFICATION_RAN_WITHOUT_AUTHORIZATION");\n',
		);
		await put(
			"packages/coding-agent/test/knowledge-search-tool.test.ts",
			'import { test, expect } from "bun:test"; import { appendFileSync } from "node:fs"; test("failure", () => { appendFileSync(process.env.MARKER!, "failure\\n"); expect(Boolean(process.env.FAIL_FIXTURE)).toBe(false); }); test("after failure", () => appendFileSync(process.env.MARKER!, "after-failure\\n"));\n',
		);
		const fullMarkers = [...selected, "failure", "after-failure"].sort();
		const dry = await run([process.execPath, "scripts/ci-test-ts.ts", "local-ts", "--dry-run"]);
		expect(await executed()).toEqual([]);
		expect(dry).toContain(`scope=fork-features selected-files=${selected.length + 1} `);
		expect(dry).not.toContain("verify-dev-workbench-package.ts");
		const fullDry = await run([process.execPath, "scripts/ci-test-ts.ts", "all", "--unsharded", "--dry-run"]);
		expect(fullDry).not.toContain("verify-dev-workbench-package.ts");
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
			expect(producer.selection).toMatchObject({ tool: "bun", mode: "full", suiteRevision: 4 });
			expect(producer.exitCode).toBe(0);
			expect(producer.status).toBe("passed");
		}
		const collabProducer = bunProducers.find(producer => producer.command.includes("test/dev-workbench.test.tsx"));
		expect(collabProducer?.command.filter(arg => arg.endsWith(".test.tsx")).sort()).toEqual([
			"test/composer.test.tsx",
			"test/dev-workbench.test.tsx",
			"test/markdown.test.tsx",
			"test/tool-view.test.tsx",
			"test/transcript.test.tsx",
		]);
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
			"test/dev-workbench/process.e2e.test.ts",
			"test/dev-workbench/workflow-process.e2e.test.ts",
			"test/spec-driven/tui-compact-mixed.e2e.test.ts",
			"test/spec-driven/tui-resources.e2e.test.ts",
			"test/spec-driven/tui-capabilities.e2e.test.ts",
			"test/goals/goal-autopilot-tui.e2e.test.ts",
			"test/goals/goal-ctrl-enter-tui.e2e.test.ts",
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
