import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { WorkflowConsumerFixture } from "../dev-workbench/workflow-fixture";

test("browser object selection never authorizes another browser's IR input", async () => {
	await using fixture = await WorkflowConsumerFixture.create();
	const process = await fixture.start();
	const projects = await process.view();
	const root = await fs.realpath(fixture.project);
	const projectId = projects.projects.find(project => project.root === root)?.id;
	if (!projectId) throw new Error("Public Dev did not register its actual --cwd project");
	let view = await process.view(projectId);
	expect(
		(
			await process.command({
				type: "createRelease",
				projectId,
				title: "Browser isolation",
				operationId: crypto.randomUUID(),
				expectedRevision: view.revision,
			})
		).response.ok,
	).toBe(true);
	view = await process.view(projectId);
	const releaseId = view.releases.at(-1)!.id;
	const ids: string[] = [];
	for (let index = 0; index < 2; index++) {
		view = await process.view(projectId);
		const created = await process.command({
			type: "createBrowserDraft",
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: view.revision,
		});
		expect(created.response.ok).toBe(true);
		ids.push(created.result.irId!);
	}
	const otherClientId = crypto.randomUUID();
	const bootstrap = await fetch(new URL("api/browser", process.url), { headers: { "X-Dev-Client": otherClientId } });
	const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
	expect(cookie).not.toBe(process.cookie);
	const post = (irId: string, other = false) => ({
		method: "POST",
		headers: { "content-type": "application/json", ...(other ? { cookie, "X-Dev-Client": otherClientId } : {}) },
		body: JSON.stringify({ projectId, irId }),
	});
	expect((await process.request("workflow/bind", post(ids[0]!))).ok).toBe(true);
	expect((await process.request("workflow/bind", post(ids[1]!, true))).ok).toBe(true);
	view = await process.view(projectId);
	for (const [irId, other] of [
		[ids[1]!, false],
		[ids[0]!, true],
	] as const) {
		const forged = await process.request("workflow/input", {
			...post(irId, other),
			body: JSON.stringify({
				projectId,
				irId,
				text: "must not reach any model",
				operationId: crypto.randomUUID(),
				expectedRevision: view.revision,
			}),
		});
		expect(forged.ok).toBe(false);
	}
	const after = await process.view(projectId);
	expect(after.revision).toBe(view.revision);
	expect(after.sessions).toEqual(view.sessions);
	expect(after.drafts).toEqual(view.drafts);
	expect(fixture.provider.requests).toEqual([]);
}, 120_000);
