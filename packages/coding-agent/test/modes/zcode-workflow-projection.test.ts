import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowJournal } from "../../src/modes/zcode/workflows/journal";
import { projectWorkflowSession } from "../../src/modes/zcode/workflows/projection";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "zcode-workflow-projection-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const journal = createWorkflowJournal(dir);
	cleanup.push(async () => journal.close());
	return journal;
}

describe("durable workflow runtime projection boundaries", () => {
	// Historical rows remain available, but only the newest eight are current projection resources.
	test("keeps the latest eight runs and exposes background work only for pending or running facts", async () => {
		const journal = await fixture();
		for (let index = 0; index < 11; index++) {
			const runId = `run-${index}`;
			journal.createRun({
				runId,
				parentSessionId: "parent",
				status: index === 9 ? "pending" : "running",
				caps: { maxConcurrency: 2 },
				spentTokens: 0,
			});
			journal.appendEvent(runId, { type: "run-started", runId, caps: { maxConcurrency: 2 } });
			if (index < 9) journal.updateRunStatus(runId, "completed", { result: `result-${index}` });
		}
		const result = projectWorkflowSession(journal, "parent", 7);
		expect(result.workflowRuns.runs.map(run => run.runId).sort()).toEqual(
			["run-3", "run-4", "run-5", "run-6", "run-7", "run-8", "run-9", "run-10"].sort(),
		);
		expect(result.backgroundWorks.map(work => work.workId).sort()).toEqual(["run-10", "run-9"]);
		for (const work of result.backgroundWorks)
			expect(work).toMatchObject({ kind: "workflow", status: "running", cancellable: true, anchorRowId: null });
		expect(projectWorkflowSession(journal, "unrelated", 7)).toEqual({
			workflowRuns: { revision: 0, runs: [] },
			backgroundWorks: [],
		});
	});

	// A stale event stream must not replace the journal's terminal status or advance its event cursor.
	test("takes stopped supersession and completed results from durable rows without inventing settlement events", async () => {
		const journal = await fixture();
		for (const runId of ["superseded", "complete"]) {
			journal.createRun({
				runId,
				parentSessionId: "parent",
				status: "running",
				caps: { maxConcurrency: 1 },
				spentTokens: 0,
			});
			journal.appendEvent(runId, { type: "run-started", runId, caps: { maxConcurrency: 1 } });
		}
		journal.updateRunStatus("superseded", "stopped", { stopReason: "superseded", supersededBy: "complete" });
		journal.updateRunStatus("complete", "completed", { result: { proof: "persisted-result" } });
		const before = journal.getEvents("superseded", { types: "all", reportItems: "all", limit: 256 });
		const result = projectWorkflowSession(journal, "parent", 5);
		expect(result.workflowRuns.runs.find(run => run.runId === "superseded")).toMatchObject({
			status: "stopped",
			stopReason: "superseded",
			supersededBy: "complete",
		});
		expect(result.workflowRuns.runs.find(run => run.runId === "complete")).toMatchObject({
			status: "completed",
			resultPreview: expect.stringContaining("persisted-result"),
		});
		expect(result.backgroundWorks).toEqual([]);
		expect(journal.getEvents("superseded", { types: "all", reportItems: "all", limit: 256 })).toEqual(before);
		expect(journal.getRun("superseded")).toMatchObject({ status: "stopped", stopReason: "superseded" });
	});
});
