import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { closePublicWorkbenches, WorkbenchFixture } from "../dev-workbench/fixture";
import { type FixtureRole, rolePayload } from "./provider-fixture";
afterEach(closePublicWorkbenches);

/** The old PTY matrix now uses the actual source CLI's public workbench API. */
export async function assertMaterialFailure(
	role: FixtureRole,
	kind: "missing" | "malformed" | "unknown",
): Promise<void> {
	await using fixture = await WorkbenchFixture.create({ fileFailure: { role, kind } });
	await fixture.start();
	const stage = role === "planner" ? "planning" : role === "executor" ? "executing" : role;
	const before = await fixture.developUntil(stage);
	const count = fixture.provider.requests.length;
	const recipient = before.runtime?.recipient;
	const transcript = recipient?.sessionFile ? await fs.readFile(recipient.sessionFile, "utf8") : null;
	const response = await fixture.response("action-preview", {
		requirementId: before.record.requirementId,
		expectedRecordVersion: before.recordVersion,
		expectedStage: stage,
		intent: role === "solution" ? { kind: "next", candidateId: "pure" } : { kind: "next" },
		gitTarget: null,
	});
	expect(response.status).toBe(409);
	const error = await response.json();
	expect(error).toMatchObject({ category: "workbench-operation", error: expect.any(String) });
	const after = await fixture.get(before.record.requirementId);
	expect(after.record).toEqual(before.record);
	expect(after.recordVersion).toBe(before.recordVersion);
	expect(after.runtime?.recipient).toEqual(recipient);
	if (transcript !== null && recipient?.sessionFile)
		expect(await fs.readFile(recipient.sessionFile, "utf8")).toBe(transcript);
	expect(fixture.provider.requests).toHaveLength(count);
	const roles = ["requirements", "solution", "planner", "executor"];
	expect(
		fixture.provider.requests
			.map(rolePayload)
			.filter(Boolean)
			.every(payload => roles.indexOf(payload!.specDrivenRole) <= roles.indexOf(role)),
	).toBe(true);
	expect(fixture.provider.failures).toEqual([]);
}

export function registerMaterialFailureTests(roles: readonly FixtureRole[]): void {
	for (const role of roles)
		for (const kind of ["missing", "malformed", "unknown"] as const) {
			test(
				`public workbench ${role} rejects ${kind} formal material without consuming approval or native history`,
				() => assertMaterialFailure(role, kind),
				180_000,
			);
		}
}
