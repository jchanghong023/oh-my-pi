import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { DevNativeSessionRef, DevRequirementContent } from "../../src/dev-workbench/workflow-types";
import { WorkflowConsumerFixture, pollWorkflow, workflowNativeContext } from "../dev-workbench/workflow-fixture";
import { createWorkflowStage, successfulWorkflowReply } from "./tui-materials-cases";

test("cold workflow reads survive missing native history but exact recovery rejects without replay", async () => {
	await using fixture = await WorkflowConsumerFixture.create({
		reply: () => ({ text: "Native conversation only; no formal output or approval." }),
	});
	const process = await fixture.start();
	let view = await process.view();
	const projectRoot = await fs.realpath(fixture.project);
	const project = await Promise.all(
		view.projects.map(async entry => ({ entry, root: await fs.realpath(entry.root) })),
	);
	const projectId = project.find(({ root }) => root === projectRoot)?.entry.id;
	if (!projectId) throw new Error("Actual cwd project was not registered");
	view = await process.view(projectId);
	const release = await process.command({
		type: "createRelease",
		projectId,
		title: "History recovery",
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
	});
	expect(release.response.ok).toBe(true);
	view = await process.view(projectId);
	const draft = await process.command({
		type: "createLocalDraft",
		projectId,
		releaseId: view.releases.at(-1)!.id,
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
	});
	expect(draft.response.ok).toBe(true);
	const irId = draft.result.irId!;
	const bind = () => ({
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, irId }),
	});
	expect((await process.request("workflow/bind", bind())).ok).toBe(true);
	view = await process.view(projectId);
	const beforeInput = fixture.provider.requests.length;
	const operationId = crypto.randomUUID();
	const sent = await process.request("workflow/input", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			projectId,
			irId,
			text: "Keep this exact conversation",
			expectedRevision: view.revision,
			operationId,
		}),
	});
	expect(sent.ok).toBe(true);
	const native = ((await sent.json()) as { session: DevNativeSessionRef }).session;
	await pollWorkflow(
		() => process.view(projectId),
		value =>
			fixture.provider.requests.length > beforeInput &&
			value.running.length === 0 &&
			value.operations.some(receipt => receipt.operationId === operationId && receipt.status === "completed") &&
			!value.operations.some(receipt => receipt.status === "running"),
		"Native conversation settlement",
	);
	const snapshot = await process.view(projectId);
	await process.stop();
	await fs.rm(native.sessionFile);
	const count = fixture.provider.requests.length;
	const restarted = await fixture.start();
	const restored = await restarted.view(projectId);
	expect(restored.drafts).toEqual(snapshot.drafts);
	expect(restored.sessions).toEqual(snapshot.sessions);
	expect(restored.revision).toBe(snapshot.revision);
	expect((await restarted.request("workflow/bind", bind())).ok).toBe(true);
	const recovery = await restarted.request("workflow/input", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			projectId,
			irId,
			sessionId: native.sessionId,
			round: native.round,
			text: "Never substitute another session",
			expectedRevision: restored.revision,
			operationId: crypto.randomUUID(),
		}),
	});
	expect(recovery.ok).toBe(false);
	expect(await recovery.text()).toMatch(/history|session|missing|ENOENT/iu);
	expect(fixture.provider.requests).toHaveLength(count);
	expect((await restarted.view(projectId)).sessions).toEqual(snapshot.sessions);
}, 180_000);

test("one active SR rejects a sibling start without reserving a second worktree or replaying models", async () => {
	const { fixture, process, projectId, irId, srId, view } = await createWorkflowStage("solution", {
		reply(request) {
			const reply = successfulWorkflowReply(request);
			if (
				!(reply instanceof Response) &&
				workflowNativeContext(request)?.role === "requirements" &&
				reply.tool?.name.replace(/^_/u, "") === "write" &&
				typeof reply.tool.args.content === "string"
			) {
				const content = JSON.parse(reply.tool.args.content) as DevRequirementContent;
				const first = content.srs[0]!;
				const id = `${first.id}-sibling`;
				content.srs.push({
					...first,
					id,
					title: `${first.title} sibling`,
					document: {
						path: `docs/dev/requirements/${(workflowNativeContext(request)!.binding as { irId: string }).irId}/srs/${id}.md`,
						content: first.document.content,
					},
				});
				reply.tool.args.content = JSON.stringify(content);
			}
			return reply;
		},
	});
	await using owned = fixture;
	const sibling = view.srs.find(sr => sr.irId === irId && sr.id !== srId)!;
	expect(sibling).toMatchObject({ status: "pending" });
	const count = fixture.provider.requests.length;
	expect(
		(
			await process.request("workflow/bind", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, irId, srId: sibling.id }),
			})
		).ok,
	).toBe(true);
	const rejected = await process.command({
		type: "startSr",
		projectId,
		irId,
		srId: sibling.id,
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
	});
	expect(rejected.result.status).toBe("failed");
	expect(rejected.result.error).toMatch(/another SR.*development slot/iu);
	expect(rejected.result.receipt).toMatchObject({ type: "startSr", status: "failed", steps: [] });
	const after = await process.view(projectId);
	expect(after.activeSrId).toBe(srId);
	expect(after.srs.find(sr => sr.id === sibling.id)).toMatchObject({ status: "pending" });
	expect(after.srs.find(sr => sr.id === sibling.id)?.worktree).toBeUndefined();
	expect(fixture.provider.requests).toHaveLength(count);
	expect(await fs.readFile(`${fixture.project}/user-file.txt`, "utf8")).toBe("retain user bytes\n");
}, 240_000);
