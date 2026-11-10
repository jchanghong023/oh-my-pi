import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createWorkflowStage, successfulWorkflowReply } from "./tui-materials-cases";

const disclosedFailure =
	"ST FAILED: deterministic supplied report; Windows hardware was not exercised. Human acceptance is separate.";

test("executing keeps distinct UT and failed ST evidence when a human explicitly approves PR delivery", async () => {
	const { fixture, process, projectId, irId, srId, view } = await createWorkflowStage("executing", {
		reply(request) {
			const reply = successfulWorkflowReply(request);
			if (
				!(reply instanceof Response) &&
				reply.tool?.name.replace(/^_/u, "") === "write" &&
				typeof reply.tool.args.path === "string" &&
				reply.tool.args.path.endsWith("/st.md")
			)
				reply.tool.args.content = `${reply.tool.args.content}\n\n${disclosedFailure}\n`;
			return reply;
		},
	});
	await using owned = fixture;
	const sr = view.srs.find(item => item.id === srId)!;
	const ut = sr.materials.find(material => material.kind === "ut")!;
	const st = sr.materials.find(material => material.kind === "st")!;
	expect(ut.path).not.toBe(st.path);
	const utBytes = await fs.readFile(path.join(sr.worktree!.path, ut.path), "utf8");
	const stBytes = await fs.readFile(path.join(sr.worktree!.path, st.path), "utf8");
	expect(stBytes).toContain(disclosedFailure);
	const approved = await process.command({
		type: "approveStage",
		projectId,
		irId,
		srId,
		stage: "executing",
		round: sr.round,
		materialDigest: sr.materialDigest!,
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
	});
	expect(approved.response.ok).toBe(true);
	const after = await process.view(projectId);
	expect(after.srs.find(item => item.id === srId)).toMatchObject({ stage: "pr", status: "developing" });
	expect(after.activeSrId).toBe(srId);
	expect(await fs.readFile(path.join(sr.worktree!.path, st.path), "utf8")).toBe(stBytes);
	expect(await fs.readFile(path.join(sr.worktree!.path, ut.path), "utf8")).toBe(utBytes);
	expect(after.srs.find(item => item.id === srId)?.codeMerge).toBeUndefined();
}, 240_000);
