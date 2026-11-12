import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { WorkflowConsumerFixture } from "../aireq-workbench/workflow-fixture";
import {
	registerMaterialFailureTests,
	successfulWorkflowReply,
	submitWorkflowMaterial,
	workflowCommand,
	type MaterialFailure,
} from "./tui-materials-cases";

registerMaterialFailureTests(["requirements", "planner"]);

test("native intake missing JSON, malformed JSON and unknown fields never become formal IR/SR authority", async () => {
	let failure: MaterialFailure = { role: "requirements", kind: "missing" };
	await using fixture = await WorkflowConsumerFixture.create({
		reply: request => successfulWorkflowReply(request, failure),
	});
	const process = await fixture.start();
	const initial = await process.view();
	const root = await fs.realpath(fixture.project);
	const projectId = initial.projects.find(project => project.root === root)?.id;
	if (!projectId) throw new Error("Public Dev did not register its actual --cwd project");
	const released = await workflowCommand(process, {
		type: "createRelease",
		projectId,
		title: "Native intake validation",
	});
	const releaseId = released.releases.at(-1)!.id;
	for (const kind of ["missing", "malformed", "unknown"] as const) {
		failure = { role: "requirements", kind };
		const created = await workflowCommand(process, { type: "createBrowserDraft", projectId, releaseId });
		const irId = created.drafts.at(-1)!.id;
		const h = { fixture, process, projectId, irId, srId: `sr-${irId}` };
		const before = await submitWorkflowMaterial(h, "requirements", true);
		const draft = before.drafts.find(group => group.id === irId)!;
		expect(draft.snapshot).toBeUndefined();
		expect(draft.confirmation).toBeUndefined();
		expect(draft.review).toBeUndefined();
		expect(draft.files).toEqual([]);
		expect(before.srs.some(sr => sr.irId === irId)).toBe(false);
		const count = fixture.provider.requests.length;
		const rejected = await process.command({
			type: "confirmRequirements",
			projectId,
			irId,
			snapshotDigest: "0".repeat(64),
			expectedRevision: before.revision,
			operationId: crypto.randomUUID(),
		});
		expect(rejected.response.ok && rejected.result.status === "completed").toBe(false);
		expect(fixture.provider.requests).toHaveLength(count);
		expect((await process.view(projectId)).groups.some(group => group.id === irId)).toBe(false);
	}
}, 180_000);
