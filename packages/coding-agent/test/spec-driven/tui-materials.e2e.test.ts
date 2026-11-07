import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkbenchFixture } from "../dev-workbench/fixture";
import { registerMaterialFailureTests } from "./tui-materials-cases";

registerMaterialFailureTests(["requirements", "planner"]);

test("candidate decisions reject absent and unknown IDs and Back preserves files without invoking models", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	const solution = await fixture.developUntil("solution");
	const id = solution.record.requirementId;
	const count = fixture.provider.requests.length;
	for (const intent of [{ kind: "next" }, { kind: "next", candidateId: "nonexistent" }]) {
		const response = await fixture.response("action-preview", {
			requirementId: id,
			expectedRecordVersion: solution.recordVersion,
			expectedStage: "solution",
			intent,
			gitTarget: null,
		});
		expect(response.ok).toBe(false);
		expect(await response.text()).toMatch(/candidate|方案|选择/iu);
		expect((await fixture.get(id)).recordVersion).toBe(solution.recordVersion);
	}
	expect(fixture.provider.requests).toHaveLength(count);
	await fixture.act(solution, { kind: "next", candidateId: "normalizer" });
	const planning = await fixture.stage(id, "planning");
	expect(planning.record.decisions.at(-1)?.candidateId).toBe("normalizer");
	const files = await Promise.all(
		planning.record.materials.map(async material => ({
			path: material.path,
			bytes: await fs.readFile(path.join(fixture.cwd, material.path), "utf8"),
		})),
	);
	const beforeBack = fixture.provider.requests.length;
	const backed = await fixture.act(planning, { kind: "back" });
	expect(backed.snapshot.record.stage).toBe("solution");
	expect(backed.snapshot.record.decisions.some(decision => decision.stage === "solution")).toBe(false);
	expect(fixture.provider.requests).toHaveLength(beforeBack);
	for (const file of files) expect(await fs.readFile(path.join(fixture.cwd, file.path), "utf8")).toBe(file.bytes);
}, 180_000);
