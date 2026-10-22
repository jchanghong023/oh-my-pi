import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowJournal } from "../../src/modes/zcode/workflows/journal";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
test("journal survives reopen with filtered events, actors, nodes and independent profiles", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-workflow-journal-"));
	roots.push(dir);
	let journal = createWorkflowJournal(join(dir, "profile-a"));
	journal.createRun({
		runId: "r",
		cwd: "/workspace/a",
		parentSessionId: "parent",
		caps: { maxConcurrency: 2 },
		spentTokens: 0,
		status: "running",
		scriptText: "return 1;",
	});
	journal.putActor({ runId: "r", siteId: "actor", ordinal: 0, name: "writer", sessionId: "native-actor" });
	journal.putNode({
		runId: "r",
		siteId: "report",
		ordinal: 0,
		kind: "report",
		inputHash: "h",
		status: "completed",
		result: "你好",
	});
	journal.putNode({
		runId: "r",
		siteId: "artifact",
		ordinal: 0,
		kind: "artifact",
		artifactId: "report",
		inputHash: "a",
		status: "completed",
		result: { id: "report", kind: "markdown", version: 1, uri: "artifact://native" },
	});
	const first = journal.appendEvent("r", { type: "run-started", runId: "r", caps: { maxConcurrency: 2 } });
	journal.updateRunStatus("r", "completed", { result: { actual: true } });
	journal.close();
	journal = createWorkflowJournal(join(dir, "profile-a"));
	expect(journal.getRun("r")?.result).toEqual({ actual: true });
	expect(journal.listActors("r", { withPersona: false })[0]?.sessionId).toBe("native-actor");
	expect(journal.listNodes("r", { kinds: ["report"], withResult: false })[0]?.result).toBeUndefined();
	expect(journal.sumResultBytes("r", "report")).toBe(Buffer.byteLength(JSON.stringify("你好")));
	expect(journal.getArtifact("r", "report", 1)).toMatchObject({ uri: "artifact://native", version: 1 });
	expect(journal.getArtifacts("r")).toHaveLength(1);
	expect(journal.listEvents("r", { types: ["run-started"], reportItems: "all", limit: 1 })[0]).toEqual(first);
	expect(journal.listEvents("r", { types: "all", reportItems: "all", afterSequence: first.sequence })).toEqual([]);
	expect(journal.listRuns({ cwd: "/workspace/b", limit: 10 })).toEqual([]);
	expect(journal.listRuns({ cwd: "/workspace/a", limit: 10 })).toHaveLength(1);
	const isolated = createWorkflowJournal(join(dir, "profile-b"));
	expect(isolated.getRun("r")).toBeUndefined();
	isolated.close();
	journal.close();
});
test("transactions roll back all records and usage/status writes retain independent fields", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-workflow-transaction-"));
	roots.push(dir);
	const journal = createWorkflowJournal(dir);
	expect(() =>
		journal.transaction(() => {
			journal.createRun({ runId: "rollback", caps: { maxConcurrency: 1 }, spentTokens: 0, status: "running" });
			throw new Error("reject");
		}),
	).toThrow("reject");
	expect(journal.getRun("rollback")).toBeUndefined();
	expect(() => journal.updateRunUsage("missing", 3)).toThrow();
	journal.createRun({ runId: "r", caps: { maxConcurrency: 1 }, spentTokens: 0, status: "running" });
	journal.updateRunStatus("r", "completed", { result: 42 });
	journal.updateRunUsage("r", 9);
	journal.updateRunCaps("r", { maxConcurrency: 3 });
	expect(journal.getRun("r")).toMatchObject({
		status: "completed",
		result: 42,
		spentTokens: 9,
		caps: { maxConcurrency: 3 },
	});
	journal.updateRunStatus("r", "running");
	expect(journal.getRun("r")?.result).toBeUndefined();
	journal.close();
});
test("event pages filter before limiting and report item cutoffs do not reset at cursors", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-workflow-pages-"));
	roots.push(dir);
	const journal = createWorkflowJournal(dir);
	journal.createRun({ runId: "r", caps: { maxConcurrency: 1 }, spentTokens: 0, status: "running" });
	journal.putNode({
		runId: "r",
		siteId: "report",
		ordinal: 0,
		kind: "report",
		artifactId: "board",
		inputHash: "a",
		status: "completed",
		result: { first: true },
	});
	journal.putNode({
		runId: "r",
		siteId: "report",
		ordinal: 1,
		kind: "report",
		artifactId: "board",
		inputHash: "b",
		status: "completed",
		result: { second: true },
	});
	const first = journal.appendEvent("r", {
		type: "report",
		instance: { siteId: "report", ordinal: 0 },
		item: { first: true },
	});
	journal.appendEvent("r", { type: "run-started", runId: "r", caps: { maxConcurrency: 1 } });
	const second = journal.appendEvent("r", {
		type: "report",
		instance: { siteId: "report", ordinal: 1 },
		item: { second: true },
	});
	const page = journal.listEvents("r", {
		types: ["report"],
		reportItems: { limit: 1 },
		afterSequence: first.sequence,
		limit: 1,
	});
	expect(page).toHaveLength(1);
	expect(page[0]?.sequence).toBe(second.sequence);
	expect(JSON.stringify(page[0]?.event)).toBe(
		JSON.stringify({ type: "report", instance: { siteId: "report", ordinal: 1 } }),
	);
	expect(journal.listEvents("r", { types: ["report"], reportItems: "all", limit: 1 })[0]?.event).toEqual(first.event);
	expect(journal.listArtifactItems("r", "board", { limit: 1, afterSequence: first.sequence })).toEqual({
		items: [{ sequence: second.sequence, siteId: "report", ordinal: 1, item: { second: true } }],
		hasMore: false,
	});
	journal.close();
});
test("workspace summaries retain admission timestamps across settlement and reopen without reading result bodies", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-workflow-workspace-"));
	roots.push(dir);
	let journal = createWorkflowJournal(dir);
	journal.createRun({ runId: "r", caps: { maxConcurrency: 1 }, spentTokens: 0, status: "running" });
	const before = Date.now();
	const node = {
		runId: "r",
		siteId: "command",
		ordinal: 0,
		kind: "world-run" as const,
		inputHash: "h",
		status: "running" as const,
		input: { op: "run", args: ["actual command"] },
	};
	journal.putNode(node);
	const admitted = journal.getNode("r", "command", 0)!;
	expect(admitted.createdAt).toBeGreaterThanOrEqual(before);
	const result = { exitCode: 2, stdout: "你好", stderr: "failure" };
	journal.putNode({ ...node, status: "completed", result });
	journal.close();
	journal = createWorkflowJournal(dir);
	const [summary] = journal.getWorkspaceNodes("r", { limit: 1 });
	expect(summary).toMatchObject({
		siteId: "command",
		status: "completed",
		createdAt: admitted.createdAt,
		resultBytes: Buffer.byteLength(JSON.stringify(result)),
		exitCode: 2,
		stdoutBytes: Buffer.byteLength(result.stdout),
		stderrBytes: Buffer.byteLength(result.stderr),
	});
	expect(summary?.updatedAt).toBeGreaterThanOrEqual(admitted.createdAt!);
	expect(summary?.result).toBeUndefined();
	journal.close();
});
