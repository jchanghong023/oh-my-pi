import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { endTestRun, type TestReportRun } from "./test-reporting";

async function fixture(records: Record<string, unknown>[], exitCode = 0) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selection-report-"));
	try {
		for (const [index, record] of records.entries()) {
			if (typeof record.xml === "string") await fs.writeFile(path.join(dir, `${index}.xml`), record.xml);
			const { xml, ...producer } = record;
			await fs.writeFile(
				path.join(dir, `${index}.producer.json`),
				JSON.stringify({
					producer: `fixture-${index}`,
					command: [],
					scope: "fixture",
					startedAt: new Date().toISOString(),
					durationSeconds: 1,
					exitCode: 0,
					reportPath: xml ? `${index}.xml` : null,
					report: xml ? "available" : "not-supported",
					...producer,
				}),
			);
		}
		const run: TestReportRun = {
			id: "fixture",
			dir,
			startedAt: new Date().toISOString(),
			startedMs: performance.now(),
			scope: "fixture",
			owner: true,
			sourceRevision: "a".repeat(40),
			dirtyState: "dirty",
			dirtyStateIdentity: "b".repeat(64),
		};
		await endTestRun(run, exitCode);
		return JSON.parse(await fs.readFile(path.join(dir, "run.json"), "utf8"));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const oneCase = '<testsuite><testcase name="executed" time="0.1" /></testsuite>';
const emptyBun = {
	status: "not-selected",
	selection: { tool: "bun", mode: "affected", selected: 0, reason: "Bun reported no affected test files" },
};
const emptyGit = {
	status: "not-selected",
	durationSeconds: 0,
	selection: {
		tool: "git",
		mode: "affected",
		selected: 0,
		baseline: "a".repeat(40),
		reason: "No dependent source changed",
		changedPaths: ["packages/example/src/a.ts"],
	},
};
const emptyRustFork = {
	producer: "cargo nextest run",
	scope: "rust-fork-features",
	command: ["bun", "scripts/run-rs-task.ts", "test:rs"],
	status: "not-selected",
	durationSeconds: 0,
	exitCode: 0,
	selection: {
		tool: "fork-scope",
		mode: "full",
		selected: 0,
		packages: [],
		reason: "No fork-owned Rust tests are configured",
	},
};

test("affected selection reports only executed XML cases and native deselections", async () => {
	const report = await fixture([
		{
			xml: oneCase,
			status: "passed",
			selection: {
				tool: "pytest-testmon",
				mode: "affected",
				selected: 1,
				deselected: 7,
				baseline: "testmon.sqlite",
			},
		},
		emptyBun,
	]);
	expect(report.completion).toBe("complete");
	expect(report.sourceRevision).toBe("a".repeat(40));
	expect(report.dirtyState).toBe("dirty");
	expect(report.dirtyStateIdentity).toBe("b".repeat(64));
	expect(report).not.toHaveProperty("sourceDigest");
	expect(report.coverage).toBe("affected-tests-only");
	expect(report.reconciliation).toMatchObject({
		status: "validated",
		cases: 1,
		executed: 1,
		deselected: 7,
		failures: 0,
	});
	expect(report.producers[0].selection.baseline).toBe("testmon.sqlite");
});

test("proven zero selection completes without inventing XML cases", async () => {
	const report = await fixture([emptyBun]);
	expect(report.completion).toBe("complete");
	expect(report.coverage).toBe("affected-tests-only");
	expect(report.reconciliation).toMatchObject({ status: "validated", cases: 0, executed: 0, failures: 0 });
	expect(report.producers[0].reportPath).toBeNull();
});

test("missing selection evidence and failed commands stay partial", async () => {
	const invalid = await fixture([{ ...emptyBun, selection: { ...emptyBun.selection, reason: "unknown" } }]);
	expect(invalid.completion).toBe("partial");
	expect(invalid.reconciliation.status).toBe("invalid");
	const failed = await fixture([{ xml: oneCase, status: "failed", exitCode: 1 }]);
	expect(failed.completion).toBe("partial");
	const gateFailed = await fixture([emptyBun], 1);
	expect(gateFailed.completion).toBe("partial");
});

test("pytest selection count must agree with XML", async () => {
	const report = await fixture([
		{
			xml: oneCase,
			status: "passed",
			selection: { tool: "pytest-testmon", mode: "affected", selected: 2, deselected: 4 },
		},
	]);
	expect(report.completion).toBe("partial");
	expect(report.reconciliation.status).toBe("invalid");
});

test("Git-planned unselected stages complete without claiming executed cases", async () => {
	for (const changedPaths of [[], ["packages/example/src/a.ts"]]) {
		const report = await fixture([
			{ ...emptyGit, selection: { ...emptyGit.selection, changedPaths } },
			{ ...emptyGit, selection: { ...emptyGit.selection, baseline: "b".repeat(64), changedPaths } },
		]);
		expect(report.completion).toBe("complete");
		expect(report.coverage).toBe("affected-tests-only");
		expect(report.reconciliation).toMatchObject({ status: "validated", cases: 0, executed: 0, failures: 0 });
		expect(report.producers.every((producer: { reportPath: string | null }) => producer.reportPath === null)).toBe(
			true,
		);
	}
});

test("Git-planned stages coexist with real XML and never hide failures", async () => {
	const passed = await fixture([{ xml: oneCase, status: "passed" }, emptyGit]);
	expect(passed.completion).toBe("complete");
	expect(passed.coverage).toBe("affected-tests-only");
	expect(passed.reconciliation).toMatchObject({ status: "validated", cases: 1, executed: 1, failures: 0 });
	const failedXml = '<testsuite><testcase name="failed" time="0.2"><failure /></testcase></testsuite>';
	const failed = await fixture([{ xml: failedXml, status: "failed", exitCode: 1 }, emptyGit]);
	expect(failed.completion).toBe("partial");
	expect(failed.reconciliation).toMatchObject({ cases: 1, executed: 1, failures: 1 });
	const inconsistent = await fixture([{ xml: failedXml, status: "passed", exitCode: 0 }, emptyGit]);
	expect(inconsistent.completion).toBe("partial");
	expect(inconsistent.reconciliation.failures).toBe(1);
	for (const status of ["partial", "failed", "blocked", "error"]) {
		const report = await fixture([{ xml: oneCase, status }, emptyGit]);
		expect(report.completion).toBe("partial");
	}
});

test("Git selection rejects incomplete, contradictory or fabricated evidence", async () => {
	const selection = emptyGit.selection;
	const invalid = [
		{ ...emptyGit, selection: { ...selection, tool: "unknown" } },
		{ ...emptyGit, selection: { ...selection, mode: "full" } },
		{ ...emptyGit, selection: { ...selection, selected: 1 } },
		{ ...emptyGit, selection: { ...selection, baseline: undefined } },
		{ ...emptyGit, selection: { ...selection, baseline: "z".repeat(40) } },
		{ ...emptyGit, selection: { ...selection, reason: "  " } },
		{ ...emptyGit, selection: { ...selection, changedPaths: undefined } },
		{ ...emptyGit, selection: { ...selection, changedPaths: ["../outside"] } },
		{ ...emptyGit, selection: { ...selection, changedPaths: ["/absolute"] } },
		{ ...emptyGit, selection: { ...selection, changedPaths: ["C:\\outside"] } },
		{ ...emptyGit, selection: { ...selection, reportPath: "fake.xml" } },
		{ ...emptyGit, exitCode: 1 },
		{ ...emptyGit, durationSeconds: 1 },
		{ ...emptyGit, xml: oneCase },
		{ ...emptyGit, reportPath: "fake.xml" },
		{ ...emptyGit, cases: 1 },
		{ ...emptyGit, time: 0.1 },
		{ ...emptyGit, selection: { ...selection, testcases: ["fabricated"] } },
	];
	for (const record of invalid) {
		const report = await fixture([record]);
		expect(report.completion).toBe("partial");
		expect(report.reconciliation.status).toBe("invalid");
	}
	for (const status of ["partial", "failed", "blocked"]) {
		const report = await fixture([{ ...emptyGit, status }]);
		expect(report.completion).toBe("partial");
	}
});

test("default Rust fork scope completes without reporting any executed tests", async () => {
	const report = await fixture([emptyRustFork]);
	expect(report.completion).toBe("complete");
	expect(report.coverage).toBe("selected-producers-only");
	expect(report.reconciliation).toEqual({ status: "validated", cases: 0, executed: 0, failures: 0 });
	expect(report.producers).toEqual([
		{ ...emptyRustFork, startedAt: expect.any(String), reportPath: null, report: "not-supported" },
	]);
});

test("Rust fork scope rejects incomplete, contradictory or fabricated skip evidence", async () => {
	const selection = emptyRustFork.selection;
	for (const record of [
		{ ...emptyRustFork, scope: "rust-workspace" },
		{ ...emptyRustFork, producer: "cargo test --doc" },
		{ ...emptyRustFork, status: "stage" },
		{ ...emptyRustFork, durationSeconds: 1 },
		{ ...emptyRustFork, exitCode: 1 },
		{ ...emptyRustFork, xml: oneCase },
		{ ...emptyRustFork, reportPath: "fake.xml" },
		{ ...emptyRustFork, cases: 1 },
		{ ...emptyRustFork, selection: undefined },
		{ ...emptyRustFork, selection: { ...selection, mode: "affected" } },
		{ ...emptyRustFork, selection: { ...selection, selected: 1 } },
		{ ...emptyRustFork, selection: { ...selection, packages: undefined } },
		{ ...emptyRustFork, selection: { ...selection, packages: ["fixture-crate"] } },
		{ ...emptyRustFork, selection: { ...selection, reason: "No affected packages" } },
		{ ...emptyRustFork, selection: { ...selection, baseline: "a".repeat(40) } },
		{ ...emptyRustFork, selection: { ...selection, changedPaths: [] } },
		{ ...emptyRustFork, selection: { ...selection, testcases: ["fabricated"] } },
	]) {
		const report = await fixture([record]);
		expect(report.completion).toBe("partial");
		expect(report.reconciliation.status).toBe("invalid");
	}
});

test("workspace doctest stages preserve Nextest counts and cannot hide failures", async () => {
	const nextest = {
		producer: "cargo nextest run",
		scope: "rust-workspace",
		command: ["cargo", "nextest", "run", "--workspace"],
		xml: oneCase,
		status: "passed",
		selection: { tool: "cargo-nextest", mode: "full" },
	};
	const doctest = {
		producer: "cargo test --doc",
		scope: "rust-workspace",
		command: ["cargo", "test", "--doc", "--workspace"],
		status: "stage",
		selection: { tool: "cargo", mode: "full", reason: "workspace doctests" },
	};
	const passed = await fixture([nextest, doctest]);
	expect(passed.completion).toBe("complete");
	expect(passed.coverage).toBe("selected-producers-only");
	expect(passed.reconciliation).toMatchObject({ status: "validated", cases: 1, executed: 1, failures: 0 });
	expect(passed.producers).toContainEqual(
		expect.objectContaining({ ...doctest, reportPath: null, report: "not-supported" }),
	);
	const failed = await fixture([nextest, { ...doctest, status: "failed", exitCode: 1 }]);
	expect(failed.completion).toBe("partial");
	expect(failed.reconciliation).toMatchObject({ status: "validated", cases: 1, executed: 1, failures: 0 });
});
