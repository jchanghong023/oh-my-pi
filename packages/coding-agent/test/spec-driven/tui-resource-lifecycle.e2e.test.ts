import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closePublicWorkbenches, WorkbenchFixture } from "../dev-workbench/fixture";
afterEach(closePublicWorkbenches);

test("cold host reads Git requirement facts without replaying missing native history", async () => {
	await using fixture = await WorkbenchFixture.create();
	const process = await fixture.start();
	const snapshot = await fixture.developUntil("requirements");
	const id = snapshot.record.requirementId;
	const recipient = snapshot.runtime?.recipient;
	await process[Symbol.asyncDispose]();
	if (recipient?.sessionFile) await fs.rm(recipient.sessionFile);
	const count = fixture.provider.requests.length;
	await fixture.start();
	const restored = await fixture.get(id);
	expect(restored.record).toEqual(snapshot.record);
	expect(restored.recordVersion).toBe(snapshot.recordVersion);
	expect(restored.runtime?.history ?? "unavailable").not.toBe("available");
	expect(fixture.provider.requests).toHaveLength(count);
}, 180_000);

test("same canonical workspace does not admit a second active development requirement", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	const first = await fixture.developUntil("requirements");
	const response = await fixture.response("requirements", { source: "import" });
	expect(response.ok).toBe(false);
	expect(await response.text()).toMatch(/active|occupied|开发|占用|名额/iu);
	expect((await fixture.get(first.record.requirementId)).recordVersion).toBe(first.recordVersion);
	expect(await fs.readFile(path.join(fixture.cwd, "baseline.txt"), "utf8")).toBe("Original user bytes\n");
}, 180_000);

test("Team configuration persists across host restarts without starting Team or models", async () => {
	await using fixture = await WorkbenchFixture.create();
	const process = await fixture.start();
	expect(
		await fixture.request("team-config", { requirementId: null, expectedRecordVersion: null, useTeam: true }),
	).toMatchObject({ useTeam: true });
	await process[Symbol.asyncDispose]();
	await fixture.start();
	expect(await fixture.request("team-config")).toMatchObject({ useTeam: true });
	expect(fixture.provider.requests).toEqual([]);
	expect(await fixture.list()).toEqual([]);
}, 180_000);
