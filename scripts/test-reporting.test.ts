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
			sourceRevision: null,
			dirtyState: null,
			dirtyStateIdentity: null,
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

test("cargo-affected zero selection requires its native diagnostic", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cargo-selection-"));
	try {
		const reportPath = path.join(dir, "selection.json");
		await fs.writeFile(
			reportPath,
			JSON.stringify({
				schema_version: 1,
				cache: { status: "warm" },
				selection: { summary: { mode: "selection", selected: 0, skipped: 12 } },
			}),
		);
		const record = {
			status: "not-selected",
			selection: { tool: "cargo-affected", mode: "affected", selected: 0, deselected: 12, reportPath },
		};
		const report = await fixture([record]);
		expect(report.completion).toBe("complete");
		expect(report.reconciliation).toMatchObject({ cases: 0, executed: 0, deselected: 12 });
		expect(report.producers[0].selection.reportPath).toBe(reportPath);
		await fs.unlink(reportPath);
		expect((await fixture([record])).completion).toBe("partial");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
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
