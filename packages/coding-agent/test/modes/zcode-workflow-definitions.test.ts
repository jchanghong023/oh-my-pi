import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	WorkflowDefinitions,
	serializeSavedWorkflow,
	validateWorkflowArgs,
} from "../../src/modes/zcode/workflows/definitions";
import { createWorkflowJournal } from "../../src/modes/zcode/workflows/journal";
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
test("metadata updates preserve exact script and moves preserve exact file without clobbering", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-definitions-"));
	roots.push(dir);
	const journal = createWorkflowJournal(join(dir, "agent"));
	const definitions = new WorkflowDefinitions({
		journal,
		homeDir: join(dir, "home"),
		validateScript: () => ({ ok: true }),
	});
	const workspace = { workspacePath: join(dir, "project") };
	const global = join(dir, "home", ".zcode", "workflows");
	await mkdir(global, { recursive: true });
	const script = "\r\n// spacing  \r\nreturn 1;\r\n";
	await writeFile(join(global, "demo.dwf.ts"), serializeSavedWorkflow({ description: "before" }, script));
	expect(
		await definitions.updateMeta({ workspace, name: "demo", scope: "global", meta: { description: "after" } }),
	).toMatchObject({ ok: true });
	expect(await definitions.get({ workspace, name: "demo", scope: "global" })).toMatchObject({ ok: true, script });
	const bytes = await readFile(join(global, "demo.dwf.ts"));
	expect(await definitions.move({ workspace, name: "demo" })).toMatchObject({ ok: true });
	expect(await readFile(join(workspace.workspacePath, ".zcode/workflows/demo.dwf.ts"))).toEqual(bytes);
	await writeFile(join(global, "demo.dwf.ts"), "source remains");
	expect(await definitions.move({ workspace, name: "demo" })).toMatchObject({ ok: false, reason: "target_exists" });
	expect(await readFile(join(global, "demo.dwf.ts"), "utf8")).toBe("source remains");
	journal.close();
});
test("saving uses actual run script and rejects compile errors and invalid metadata before writing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-save-run-"));
	roots.push(dir);
	const journal = createWorkflowJournal(join(dir, "agent"));
	const definitions = new WorkflowDefinitions({
		journal,
		homeDir: dir,
		validateScript: script => ({ ok: script !== "bad", detail: "invalid script" }),
	});
	const workspace = { workspacePath: join(dir, "project") };
	journal.createRun({
		runId: "r",
		cwd: workspace.workspacePath,
		scriptText: "bad",
		caps: { maxConcurrency: 1 },
		spentTokens: 0,
		status: "completed",
	});
	expect(
		await definitions.saveFromRun({ workspace, runId: "r", name: "demo", meta: { description: "test" } }),
	).toMatchObject({ ok: false, reason: "compile_failed" });
	expect((await definitions.list({ workspace })).workflows).toEqual([]);
	journal.updateRunScript("r", "return 42;\r\n", "hash");
	await expect(
		definitions.saveFromRun({ workspace, runId: "r", name: "demo", meta: { description: "" } }),
	).rejects.toThrow();
	expect((await definitions.list({ workspace })).workflows).toEqual([]);
	expect(
		await definitions.saveFromRun({ workspace, runId: "r", name: "demo", meta: { description: "test" } }),
	).toMatchObject({ ok: true });
	expect(await definitions.forRun({ workspace, runId: "r" })).toMatchObject({
		match: "script",
		entry: { name: "demo" },
	});
	expect(
		await definitions.saveFromRun({ workspace, runId: "r", name: "demo", meta: { description: "test" } }),
	).toMatchObject({ ok: false, reason: "target_exists" });
	expect(validateWorkflowArgs({ n: { type: "number", default: "wrong" } }, {})).toMatchObject({ ok: false });
	expect(validateWorkflowArgs({ n: { type: "number", default: 3 } }, {})).toEqual({ ok: true, args: { n: 3 } });
	journal.close();
});
