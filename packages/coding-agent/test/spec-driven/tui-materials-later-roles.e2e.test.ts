import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkbenchFixture } from "../dev-workbench/fixture";
import { registerMaterialFailureTests } from "./tui-materials-cases";

registerMaterialFailureTests(["solution", "executor"]);

test("failed initialization preserves configuration and unrelated user files", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	await fixture.request("team-config", { requirementId: null, expectedRecordVersion: null, useTeam: true });
	await fs.writeFile(path.join(fixture.cwd, "user-source.txt"), "preserve user work\n");
	await fs.writeFile(path.join(fixture.cwd, "openspec"), "not a directory\n");
	const imported = await fixture.imported();
	await fixture.act(imported, { kind: "next" });
	const failed = await fixture.stage(imported.record.requirementId, "requirements");
	expect(failed.runtime?.execution).toBe("failed");
	expect(failed.runtime?.blockedReason?.trim().length).toBeGreaterThan(0);
	expect(await fs.readFile(path.join(fixture.cwd, "openspec"), "utf8")).toBe("not a directory\n");
	expect((await fs.lstat(path.join(fixture.cwd, "openspec"))).isFile()).toBe(true);
	expect(failed.record.materials.map(material => material.kind)).toEqual(["business"]);
	expect(await fixture.request("team-config")).toMatchObject({ useTeam: true });
	expect(await fs.readFile(path.join(fixture.cwd, "user-source.txt"), "utf8")).toBe("preserve user work\n");
	expect(fixture.provider.requests).toEqual([]);
	expect(failed.record.decisions.map(decision => decision.stage)).toEqual(["business"]);
}, 180_000);
