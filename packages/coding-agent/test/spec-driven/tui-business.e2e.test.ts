import { expect, test } from "bun:test";
import { createWorkflowStage } from "./tui-materials-cases";

test("complete native IR and SR intake remains an unapproved requirement draft", async () => {
	const { fixture, process, projectId, irId, view } = await createWorkflowStage("requirements");
	await using owned = fixture;
	const draft = view.drafts.find(group => group.id === irId)!;
	expect(draft.title).toBeTruthy();
	expect(draft.snapshot?.srs.length).toBeGreaterThan(0);
	expect(draft.confirmation).toBeUndefined();
	expect(draft.review).toBeUndefined();
	expect(view.groups).toEqual([]);
	expect(view.srs.filter(sr => sr.irId === irId).every(sr => sr.status === "pending" && sr.stage === undefined)).toBe(
		true,
	);
	const requests = fixture.provider.requests.length;
	const rejected = await process.command({
		type: "confirmRequirements",
		projectId,
		irId,
		snapshotDigest: "0".repeat(64),
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
	});
	// Transport acceptance is not workflow approval: command failures are
	// durable domain receipts returned by the successfully handled request.
	expect(rejected.response.ok).toBe(true);
	expect(rejected.result.status).toBe("failed");
	expect(rejected.result.receipt.status).toBe("failed");
	expect(rejected.result.receipt.error).toBe("Requirements changed; confirm current snapshot");
	const after = await process.view(projectId);
	expect(after.drafts.find(group => group.id === irId)?.confirmation).toBeUndefined();
	expect(after.groups).toEqual([]);
	expect(after.operations.find(receipt => receipt.operationId === rejected.result.operationId)).toEqual(
		rejected.result.receipt,
	);
	expect(after.srs.filter(sr => sr.irId === irId).every(sr => sr.status === "pending" && sr.stage === undefined)).toBe(
		true,
	);
	expect(fixture.provider.requests).toHaveLength(requests);
}, 180_000);
