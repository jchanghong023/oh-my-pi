import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BUSINESS, closePublicWorkbenches, WorkbenchFixture } from "../dev-workbench/fixture";
afterEach(closePublicWorkbenches);

test("business drafts import once and require complete chapters before approval without a business actor", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	const created = await fixture.create();
	const id = created.record.requirementId;
	const invalidDrafts = [
		"No requirement title\n",
		BUSINESS.replace("## 典型例子", "## omitted chapter"),
		BUSINESS.replace(/## 资料来源[\s\S]*?(?=## 业务确认与交接)/u, "## 资料来源\n\n"),
	];
	expect((await fixture.upload(id, invalidDrafts[0]!)).ok).toBe(true);
	const imported = await fixture.get(id);
	const business = imported.record.materials.find(material => material.kind === "business");
	if (!business) throw new Error("Imported business draft was not registered");
	const businessPath = path.join(fixture.cwd, business.path);
	// Import never overwrites an existing owned document; repair edits its bytes instead.
	const replacement = await fixture.upload(id);
	expect(replacement.status).toBe(409);
	const replacementError = await replacement.json();
	expect(replacementError).toMatchObject({ category: "workbench-operation", error: expect.any(String) });
	const afterReplacement = await fixture.get(id);
	expect(afterReplacement.record).toEqual(imported.record);
	expect(afterReplacement.recordVersion).toBe(imported.recordVersion);
	expect(await fs.readFile(businessPath, "utf8")).toBe(invalidDrafts[0]!);
	for (const [index, invalid] of invalidDrafts.entries()) {
		if (index > 0) await fs.writeFile(businessPath, invalid);
		const snapshot = await fixture.get(id);
		expect(snapshot.runtime?.recipient ?? null).toBeNull();
		const response = await fixture.response("action-preview", {
			requirementId: id,
			expectedRecordVersion: snapshot.recordVersion,
			expectedStage: "business",
			intent: { kind: "next" },
			gitTarget: null,
		});
		expect(response.status).toBe(409);
		const error = await response.json();
		expect(error).toMatchObject({ category: "workbench-operation", error: expect.any(String) });
		const after = await fixture.get(id);
		expect(after.record).toEqual(snapshot.record);
		expect(after.recordVersion).toBe(snapshot.recordVersion);
		expect(after.runtime?.recipient ?? null).toBeNull();
		expect(await fs.readFile(businessPath, "utf8")).toBe(invalid);
		expect(fixture.provider.requests).toEqual([]);
	}
	await fs.writeFile(businessPath, BUSINESS);
	const snapshot = await fixture.get(id);
	expect(snapshot.runtime?.recipient ?? null).toBeNull();
	await fixture.act(snapshot, { kind: "next" });
	expect((await fixture.stage(id, "requirements")).record.decisions[0]?.stage).toBe("business");
}, 180_000);

test("host path import copies Markdown and rejects network URLs and non-Markdown sources", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	const created = await fixture.create();
	const id = created.record.requirementId;
	const external = fixture.root.join("external-source.md");
	await fs.writeFile(external, BUSINESS);
	for (const source of [
		"https://example.invalid/business.md",
		"http://127.0.0.1/business.md",
		fixture.root.join("business.pdf"),
	]) {
		const response = await fixture.response(`business/${id}`, { kind: "host-path", path: source });
		expect(response.ok).toBe(false);
	}
	const response = await fixture.response(`business/${id}`, { kind: "host-path", path: external });
	expect(response.ok).toBe(true);
	const snapshot = await fixture.get(id);
	const business = snapshot.record.materials.find(material => material.kind === "business");
	if (!business) throw new Error("Imported business material was not registered");
	const downloaded = await fixture.response(`materials/${id}/${business.id}`);
	expect(await downloaded.text()).toBe(BUSINESS);
	expect(await fs.readFile(external, "utf8")).toBe(BUSINESS);
	expect(fixture.provider.requests).toEqual([]);
}, 180_000);
