import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DevWorkflowCommand } from "../../src/dev-workbench/workflow-types";
import { WorkflowConsumerFixture, pollWorkflow, workflowGit, WORKFLOW_BUSINESS } from "./workflow-fixture";

async function setup(fixture: WorkflowConsumerFixture) {
	const process = await fixture.start();
	const projects = await process.view();
	const root = await fs.realpath(fixture.project);
	const projectId = projects.projects.find(project => project.root === root)?.id;
	if (!projectId) throw new Error("Public Dev did not register its actual --cwd project");
	let view = await process.view(projectId);
	const release = await process.command({
		type: "createRelease",
		projectId,
		title: "Consumer acceptance",
		operationId: crypto.randomUUID(),
		expectedRevision: view.revision,
	});
	expect(release.response.ok).toBe(true);
	view = await process.view(projectId);
	const releaseId = view.releases.at(-1)?.id;
	if (!releaseId) throw new Error("Public release was not persisted");
	return { process, projectId, releaseId, view };
}

describe("Dev replacement public process consumer", () => {
	test("public capability authenticates; read-only views do not create actors; obsolete routes are absent", async () => {
		await using fixture = await WorkflowConsumerFixture.create();
		const process = await fixture.start();
		const projects = await process.view();
		const root = await fs.realpath(fixture.project);
		const projectId = projects.projects.find(project => project.root === root)?.id;
		if (!projectId) throw new Error("Public Dev did not register its actual --cwd project");
		expect(await (await process.request("api/browser")).json()).toMatchObject({ launchProjectId: projectId });
		const before = await process.view(projectId);
		const unauthenticated = await fetch(new URL("workflow", process.url));
		expect(unauthenticated.status).toBe(401);
		for (const endpoint of ["api/requirements", "api/requirements/example/action", "api/preview"])
			expect((await process.request(endpoint)).status).toBe(404);
		expect(
			(
				await process.request("workflow/command", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(400);
		const rejectedOrigin = await process.request("workflow", {
			headers: { origin: "https://outside.example.invalid" },
		});
		expect(rejectedOrigin.status).toBe(403);
		const after = await process.view(projectId);
		expect(after.revision).toBe(before.revision);
		expect(after.sessions).toEqual(before.sessions);
		expect(fixture.provider.requests).toHaveLength(0);
	}, 120_000);

	test("browser intake has no Git effects; duplicate receipts are idempotent and stale commands fail", async () => {
		await using fixture = await WorkflowConsumerFixture.create();
		const { process, projectId, releaseId, view } = await setup(fixture);
		const worktrees = await workflowGit(fixture.project, ["worktree", "list", "--porcelain"], fixture.env);
		const command: DevWorkflowCommand = {
			type: "createBrowserDraft",
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: view.revision,
		};
		const first = await process.command(command);
		expect(first.response.ok).toBe(true);
		const duplicate = await process.command(command);
		expect(duplicate.response.ok).toBe(true);
		expect(duplicate.result.irId).toBe(first.result.irId);
		expect((await process.view(projectId)).drafts).toHaveLength(1);
		expect(await workflowGit(fixture.project, ["worktree", "list", "--porcelain"], fixture.env)).toBe(worktrees);
		const stale = await process.command({ ...command, operationId: crypto.randomUUID() });
		expect(stale.response.status).toBe(409);
		const conflicting = await process.command({ ...command, type: "createLocalDraft" });
		expect(conflicting.response.status).toBe(409);
		expect(fixture.provider.requests).toHaveLength(0);
	}, 120_000);

	test("local intake uses a real separate worktree; state survives native settlement and reconnect", async () => {
		await using fixture = await WorkflowConsumerFixture.create();
		const { process, projectId, releaseId, view } = await setup(fixture);
		const branch = await workflowGit(fixture.project, ["branch", "--show-current"], fixture.env);
		const result = await process.command({
			type: "createLocalDraft",
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: view.revision,
		});
		expect(result.response.ok).toBe(true);
		const draft = (await process.view(projectId)).drafts.find(item => item.id === result.result.irId)!;
		expect(draft.worktree?.path).toBeTruthy();
		expect(path.resolve(draft.worktree!.path)).not.toBe(path.resolve(fixture.project));
		expect(await workflowGit(draft.worktree!.path, ["rev-parse", "HEAD"], fixture.env)).toBe(
			draft.worktree!.baseCommit,
		);
		expect(await workflowGit(fixture.project, ["branch", "--show-current"], fixture.env)).toBe(branch);
		await process.stop();
		const restarted = await fixture.start();
		expect((await restarted.view(projectId)).drafts.find(item => item.id === draft.id)?.worktree).toEqual(
			draft.worktree,
		);
		expect(await fs.readFile(path.join(fixture.project, "user-file.txt"), "utf8")).toBe("retain user bytes\n");
	}, 180_000);

	test("invalid ZIP fails before import effects and unknown object/session-round cannot dispatch", async () => {
		await using fixture = await WorkflowConsumerFixture.create();
		const { process, projectId, releaseId, view } = await setup(fixture);
		const before = await workflowGit(fixture.project, ["worktree", "list", "--porcelain"], fixture.env);
		const upload = await process.request(`workflow/packages?projectId=${projectId}`, {
			method: "POST",
			headers: { "content-type": "application/zip" },
			body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]),
		});
		expect(upload.ok).toBe(false);
		const wrong = await process.request("workflow/input", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId,
				irId: "missing-ir",
				sessionId: "foreign-session",
				round: 900,
				text: WORKFLOW_BUSINESS,
				operationId: crypto.randomUUID(),
				expectedRevision: view.revision,
			}),
		});
		expect([404, 409]).toContain(wrong.status);
		const invalidImport = await process.command({
			type: "importPackage",
			projectId,
			releaseId,
			packageId: "not-uploaded",
			operationId: crypto.randomUUID(),
			expectedRevision: view.revision,
		});
		expect(invalidImport.response.ok).toBe(false);
		expect(await workflowGit(fixture.project, ["worktree", "list", "--porcelain"], fixture.env)).toBe(before);
		expect(fixture.provider.requests).toHaveLength(0);
	}, 120_000);

	test("real native provider rejection is preserved, never converted into review or approval", async () => {
		await using fixture = await WorkflowConsumerFixture.create({ mode: "reject" });
		const { process, projectId, releaseId, view } = await setup(fixture);
		const created = await process.command({
			type: "createBrowserDraft",
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: view.revision,
		});
		const irId = created.result.irId!;
		await process.bind(projectId, irId);
		const current = await process.view(projectId);
		const sent = await process.request("workflow/input", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId,
				irId,
				text: WORKFLOW_BUSINESS,
				expectedRevision: current.revision,
				operationId: crypto.randomUUID(),
			}),
		});
		expect(sent.ok).toBe(true);
		await pollWorkflow(
			async () => await process.view(projectId),
			value =>
				fixture.provider.requests.length > 0 &&
				value.running.length === 0 &&
				value.operations.some(operation => operation.status === "failed"),
			"Actual provider failure receipt",
		);
		const failed = await process.view(projectId);
		expect(JSON.stringify(failed)).toContain("DETERMINISTIC_DEV_PROVIDER_REJECTION");
		expect(failed.groups).toHaveLength(0);
		expect(failed.drafts.find(draft => draft.id === irId)?.confirmation).toBeUndefined();
		const download = await process.request(`workflow/package?projectId=${projectId}&irId=${irId}`);
		expect(download.ok).toBe(false);
		expect(fixture.provider.failures).toEqual([]);
	}, 180_000);

	test("held native provider rejects stale session-round and settles only on explicit stop", async () => {
		await using fixture = await WorkflowConsumerFixture.create({ mode: "hold" });
		const { process, projectId, releaseId, view } = await setup(fixture);
		const created = await process.command({
			type: "createBrowserDraft",
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: view.revision,
		});
		const irId = created.result.irId!;
		await process.bind(projectId, irId);
		const current = await process.view(projectId);
		const response = await process.request("workflow/input", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId,
				irId,
				text: WORKFLOW_BUSINESS,
				expectedRevision: current.revision,
				operationId: crypto.randomUUID(),
			}),
		});
		expect(response.ok).toBe(true);
		await pollWorkflow(
			async () => process.view(projectId),
			value => value.running.some(ref => ref.irId === irId) && fixture.provider.requests.length > 0,
			"Running native binding and actual provider request",
		);
		const running = await process.view(projectId);
		const calls = fixture.provider.requests.length;
		const ref = running.running.find(item => item.irId === irId)!;
		const late = await process.request("workflow/input", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId,
				irId,
				sessionId: ref.sessionId,
				round: ref.round + 1,
				text: "Must not dispatch this stale native turn",
				expectedRevision: running.revision,
				operationId: crypto.randomUUID(),
			}),
		});
		expect(late.status).toBe(409);
		expect(fixture.provider.requests.length).toBe(calls);
		const stop = await process.command({
			type: "stop",
			projectId,
			irId,
			expectedRevision: running.revision,
			operationId: crypto.randomUUID(),
		});
		expect(stop.response.ok).toBe(true);
		await pollWorkflow(
			async () => process.view(projectId),
			value => value.running.length === 0,
			"Recursive native stop settlement",
		);
		expect((await process.view(projectId)).drafts.some(draft => draft.id === irId)).toBe(true);
	}, 180_000);

	test("HTTP requirement removal rejects stale authority, settles only its owned native turn and retains Git and history", async () => {
		await using fixture = await WorkflowConsumerFixture.create({ mode: "hold" });
		const { process, projectId, releaseId, view } = await setup(fixture);
		const survivor = await process.command({
			type: "createBrowserDraft",
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: view.revision,
		});
		expect(survivor.response.ok).toBe(true);
		const survivorId = survivor.result.irId!;
		await process.bind(projectId, survivorId);
		const prepared = await process.view(projectId);
		const priorNative = prepared.sessions.find(ref => ref.irId === survivorId)!;
		const created = await process.command({
			type: "createLocalDraft",
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: prepared.revision,
		});
		expect(created.response.ok).toBe(true);
		const irId = created.result.irId!;
		await process.bind(projectId, irId);
		const selected = await process.view(projectId);
		const worktree = selected.drafts.find(draft => draft.id === irId)!.worktree!;
		const userFile = path.join(worktree.path, "user-file.txt");
		const userBytes = await fs.readFile(userFile);
		const worktrees = await workflowGit(fixture.project, ["worktree", "list", "--porcelain"], fixture.env);
		const branchCommit = await workflowGit(fixture.project, ["rev-parse", worktree.branch], fixture.env);
		const stale = await process.request("workflow/input", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...priorNative,
				expectedRevision: selected.revision,
				operationId: crypto.randomUUID(),
				text: "REJECTED_OLD_IR_MUST_NOT_REPLAY",
			}),
		});
		expect(stale.ok).toBe(false);
		expect(await stale.json()).toMatchObject({ error: expect.stringContaining("binding changed") });
		expect(fixture.provider.requests).toHaveLength(0);
		const sent = await process.request("workflow/input", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectId,
				irId,
				expectedRevision: selected.revision,
				operationId: crypto.randomUUID(),
				text: "REQUIREMENT_REMOVAL_HELD_TURN",
			}),
		});
		expect(sent.ok).toBe(true);
		const running = await pollWorkflow(
			() => process.view(projectId),
			current => current.running.some(ref => ref.irId === irId) && fixture.provider.requests.length === 1,
			"Owned native turn before HTTP removal",
		);
		const native = running.running.find(ref => ref.irId === irId)!;
		expect(native.sessionId).not.toBe(priorNative.sessionId);
		expect(JSON.stringify(fixture.provider.requests)).not.toContain("REJECTED_OLD_IR_MUST_NOT_REPLAY");
		expect(await fs.readFile(priorNative.sessionFile, "utf8")).not.toContain("REQUIREMENT_REMOVAL_HELD_TURN");
		// Rejected HTTP controls cannot borrow the live input's authority to abort it.
		for (const control of [
			{ type: "deleteRequirement", version: 1, expectedRevision: running.revision - 1 },
			{ type: "deleteRequirement", version: 2, expectedRevision: running.revision },
			{ type: "stop", srId: "unrelated-sr", expectedRevision: running.revision },
			{ type: "backStage", stage: "planning", expectedRevision: running.revision },
		]) {
			const rejected = await process.request("workflow/command", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, irId, operationId: crypto.randomUUID(), ...control }),
			});
			expect(rejected.ok).toBe(false);
			expect(await rejected.json()).toMatchObject({ error: expect.any(String) });
			const unchanged = await process.view(projectId);
			expect(unchanged.revision).toBe(running.revision);
			expect(unchanged.running.some(ref => ref.sessionId === native.sessionId)).toBe(true);
			expect(unchanged.operations).toEqual(running.operations);
		}
		const removed = await process.command({
			type: "deleteRequirement",
			version: 1,
			projectId,
			irId,
			operationId: crypto.randomUUID(),
			expectedRevision: running.revision,
		});
		expect(removed.response.ok).toBe(true);
		expect(removed.result).toMatchObject({ status: "completed", irId });
		const deleted = await pollWorkflow(
			() => process.view(projectId),
			current =>
				!current.drafts.some(draft => draft.id === irId) &&
				current.operations.some(
					operation =>
						operation.type === "deleteRequirement" && operation.irId === irId && operation.status === "completed",
				),
			"Exact HTTP requirement deletion",
		);
		const receipt = deleted.operations.find(
			operation => operation.type === "deleteRequirement" && operation.irId === irId,
		)!;
		expect(receipt.srId).toBeUndefined();
		expect(receipt.deletion).toMatchObject({
			version: 1,
			operationId: receipt.operationId,
			manualCloseNeeded: false,
		});
		expect(receipt.steps.some(step => step.name === "owned-ir-settled" && step.detail === irId)).toBe(true);
		const heldInput = running.operations.find(
			operation => operation.type === "nativeInput" && operation.status === "running",
		)!;
		expect(deleted.operations.find(operation => operation.operationId === heldInput.operationId)?.status).toBe(
			"failed",
		);
		expect(deleted.operations.some(operation => operation.status === "running")).toBe(false);
		expect(deleted.drafts.some(draft => draft.id === survivorId)).toBe(true);
		expect(deleted.running.some(ref => ref.irId === irId)).toBe(false);
		expect(deleted.sessions.some(ref => ref.irId === irId)).toBe(false);
		expect(await fs.readFile(userFile)).toEqual(userBytes);
		expect(await fs.readFile(native.sessionFile, "utf8")).toContain("REQUIREMENT_REMOVAL_HELD_TURN");
		expect(await workflowGit(fixture.project, ["worktree", "list", "--porcelain"], fixture.env)).toBe(worktrees);
		expect(await workflowGit(fixture.project, ["rev-parse", worktree.branch], fixture.env)).toBe(branchCommit);
		expect(fixture.provider.requests).toHaveLength(1);
	}, 180_000);

	test("registered projects cannot borrow another project's object or material binding", async () => {
		await using fixture = await WorkflowConsumerFixture.create();
		await using secondary = await WorkflowConsumerFixture.create();
		const { process, projectId, releaseId, view } = await setup(fixture);
		const created = await process.command({
			type: "createBrowserDraft",
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: view.revision,
		});
		const irId = created.result.irId!;
		await process.bind(projectId, irId);
		const registered = await process.command({
			type: "registerProject",
			registrationScope: "target-root",
			root: secondary.project,
			name: "Separate consumer project",
			expectedRevision: 0,
			operationId: crypto.randomUUID(),
		});
		expect(registered.response.ok).toBe(true);
		const secondaryRoot = await fs.realpath(secondary.project);
		const secondId = (await process.view()).projects.find(project => project.root === secondaryRoot)?.id;
		if (!secondId) throw new Error("Public Dev did not register the second project");
		expect(secondId).not.toBe(projectId);
		const stolen = await process.request("workflow/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: secondId, irId }),
		});
		expect([404, 409]).toContain(stolen.status);
		const materials = await process.request(
			`workflow/material?projectId=${secondId}&irId=${irId}&path=${encodeURIComponent(`docs/dev/requirements/${irId}/ir.md`)}`,
		);
		expect(materials.ok).toBe(false);
		expect((await process.view(secondId)).drafts).toEqual([]);
		expect((await process.view(projectId)).drafts.some(draft => draft.id === irId)).toBe(true);
		expect(fixture.provider.requests).toHaveLength(0);
		expect(secondary.provider.requests).toHaveLength(0);
		await process.stop();
	}, 180_000);
});
