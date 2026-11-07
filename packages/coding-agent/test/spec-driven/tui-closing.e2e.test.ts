import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DevGitTarget } from "../../src/spec-driven/types";
import { closePublicWorkbenches, WorkbenchFixture } from "../dev-workbench/fixture";
afterEach(closePublicWorkbenches);

test("fifth Next hands off only to ST; human ST marking preserves disclosed failures and archive remains explicit", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	let snapshot = await fixture.developUntil("st");
	const id = snapshot.record.requirementId;
	expect(snapshot.record.syncRevisions).toEqual([]);
	expect(
		await fs
			.stat(path.join(fixture.cwd, "openspec/changes", snapshot.record.changeId))
			.then(stat => stat.isDirectory()),
	).toBe(true);
	const report = snapshot.record.materials.find(material => material.kind === "report");
	if (!report) throw new Error("ST must reuse the existing completion report");
	const original = await fs.readFile(path.join(fixture.cwd, report.path), "utf8");
	await fs.appendFile(
		path.join(fixture.cwd, report.path),
		"\n## ST 测试\n\nFailed: deterministic ST probe; Windows platform not run. Human decision is separate.\n",
	);
	const targets = await fixture.request<DevGitTarget[]>(`git-targets/${id}`);
	if (!targets[0]) throw new Error("Real existing Git target not discoverable");
	const result = await fixture.act(snapshot, { kind: "mark", mark: "st-complete" }, targets[0]);
	expect(result.snapshot.record.stage).toBe("pr");
	expect(result.persistence.commit.status).toBe("succeeded");
	expect(result.persistence.push.status).toBe("succeeded");
	expect(result.snapshot.record.report.development).toEqual(snapshot.record.report.development);
	expect(await fs.readFile(path.join(fixture.cwd, report.path), "utf8")).toContain("Failed: deterministic ST probe");
	expect(original).not.toContain("Failed: deterministic ST probe");
	expect(result.snapshot.record.syncRevisions).toEqual([]);
	snapshot = await fixture.get(id);
	const synced = await fixture.act(snapshot, { kind: "sync-archive" });
	expect(synced.snapshot.record.stage).toBe("pr");
	expect(synced.snapshot.record.lifecycle).toBe("active");
	expect(synced.snapshot.record.syncRevisions.at(-1)?.archivedChangePath).toBeTruthy();
	const archive = synced.snapshot.record.syncRevisions.at(-1)!.archivedChangePath!;
	expect((await fs.stat(path.join(fixture.cwd, archive))).isDirectory()).toBe(true);
	expect(await fs.readFile(path.join(fixture.cwd, "openspec/specs/greeting/spec.md"), "utf8")).toContain(
		"Requirement: Greeting",
	);
}, 180_000);
