import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileEntry } from "../../src/session/session-entries";
import { closePublicWorkbenches, WorkbenchFixture, eventually } from "../dev-workbench/fixture";
import { contentText, rolePayload, teamStage } from "./provider-fixture";
afterEach(closePublicWorkbenches);

test("native Team uses real proposal, alignment, review and synthesis and ordinary dialogue does not rerun it", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	await fixture.request("team-config", { requirementId: null, expectedRecordVersion: null, useTeam: true });
	const entered = await fixture.developUntil("solution");
	const solution = await eventually(
		() => fixture.get(entered.record.requirementId),
		snapshot =>
			snapshot.record.solutionBasis?.source === "team" &&
			snapshot.record.materials.some(material => material.kind === "solution"),
	);
	const teamCalls = fixture.provider.requests.filter(request => teamStage(request));
	expect(teamCalls.length).toBeGreaterThan(0);
	expect(new Set(teamCalls.map(teamStage))).toEqual(new Set(["proposal", "alignment", "review", "synthesis"]));
	const material = solution.record.materials.find(material => material.kind === "solution");
	if (!material) throw new Error("Team did not produce a formal solution");
	const bytes = await fs.readFile(path.join(fixture.cwd, material.path), "utf8");
	const candidates = JSON.parse(bytes) as { candidates: Array<{ id: string; content: string }> };
	expect(candidates.candidates.length).toBeGreaterThan(0);
	const runtime = solution.runtime;
	if (!runtime?.recipient) throw new Error("Team solution native recipient missing");
	const basis = solution.record.solutionBasis;
	expect(basis).toMatchObject({
		source: "team",
		sourceSessionId: runtime.recipient.sessionId,
		solutionVersion: material.version,
		candidateIds: candidates.candidates.map(candidate => candidate.id),
		usableCandidateIds: candidates.candidates.map(candidate => candidate.id),
	});
	if (!basis || !runtime.recipient.sessionFile) throw new Error("Team solution native provenance missing");
	const history = (await fs.readFile(runtime.recipient.sessionFile, "utf8"))
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as FileEntry);
	expect(history.find(entry => entry.id === basis.sourceEntryIds[0])).toMatchObject({
		type: "custom",
		customType: "dev-solution-source",
		data: {
			team: true,
			candidates: expect.arrayContaining(
				candidates.candidates.map(candidate =>
					expect.objectContaining({ id: candidate.id, proposal: candidate.content, adoptable: true }),
				),
			),
		},
	});
	expect(history.find(entry => entry.id === basis.sourceEntryIds[1])).toMatchObject({
		type: "custom",
		customType: "dev-solution-version",
		data: { version: material.version },
	});
	const prepared = await fixture.request<{ requestId: string }>("input-preview", {
		requirementId: solution.record.requirementId,
		sessionId: runtime.recipient.sessionId,
		generation: runtime.generation,
	});
	const text = "Compare complete candidates without approval or further Team discussion";
	expect(await fixture.request("input", { requestId: prepared.requestId, text })).toMatchObject({ kind: "accepted" });
	await eventually(
		async () =>
			fixture.provider.requests.some(request =>
				request.messages.some(message => message.role === "user" && contentText(message.content).includes(text)),
			),
		Boolean,
	);
	expect(fixture.provider.requests.filter(request => teamStage(request))).toHaveLength(teamCalls.length);
	expect(await fs.readFile(path.join(fixture.cwd, material.path), "utf8")).toBe(bytes);
	expect((await fixture.get(solution.record.requirementId)).record.decisions).toEqual(solution.record.decisions);
	await fixture.act(await fixture.get(solution.record.requirementId), {
		kind: "next",
		candidateId: candidates.candidates[0]!.id,
	});
	const planning = await fixture.stage(solution.record.requirementId, "planning");
	const count = fixture.provider.requests.length;
	await fixture.act(planning, { kind: "back" });
	expect(fixture.provider.requests).toHaveLength(count);
	expect(await fixture.request("team-config")).toMatchObject({ useTeam: true });
	expect(fixture.provider.failures).toEqual([]);
}, 300_000);

test("explicit native Stop settles Team children and only human Back Next starts fresh discussion", async () => {
	let held = false;
	let aborted = false;
	const release = Promise.withResolvers<void>();
	await using fixture = await WorkbenchFixture.create({
		delay: async (request, signal) => {
			if (held || !teamStage(request)) return;
			held = true;
			await Promise.race([
				release.promise,
				new Promise<void>(resolve =>
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					),
				),
			]);
		},
	});
	try {
		await fixture.start();
		await fixture.request("team-config", { requirementId: null, expectedRecordVersion: null, useTeam: true });
		const requirements = await fixture.developUntil("requirements");
		await fixture.act(requirements, { kind: "next" });
		await eventually(async () => held, Boolean);
		const running = await fixture.get(requirements.record.requirementId);
		const runtime = running.runtime;
		if (!runtime?.recipient) throw new Error("Running Team does not expose an owned stoppable native target");
		expect(
			await fixture.request("native-command", {
				target: {
					requirementId: running.record.requirementId,
					sessionId: runtime.recipient.sessionId,
					generation: runtime.generation,
				},
				command: "abort",
				args: [],
			}),
		).toMatchObject({ kind: "accepted" });
		const stopped = await fixture.stage(running.record.requirementId, "solution");
		expect(aborted).toBe(true);
		expect(stopped.record.solutionBasis).toBeNull();
		expect(
			fixture.provider.requests.filter(request =>
				["planner", "executor"].includes(rolePayload(request)?.specDrivenRole ?? ""),
			),
		).toEqual([]);
		const calls = fixture.provider.requests.filter(request => teamStage(request)).length;
		await fixture.get(running.record.requirementId);
		expect(fixture.provider.requests.filter(request => teamStage(request))).toHaveLength(calls);
		const back = await fixture.act(stopped, { kind: "back" });
		expect(back.snapshot.record.stage).toBe("requirements");
		expect(fixture.provider.requests.filter(request => teamStage(request))).toHaveLength(calls);
		await fixture.act(back.snapshot, { kind: "next" });
		await fixture.stage(running.record.requirementId, "solution");
		const retry = await eventually(
			() => fixture.get(running.record.requirementId),
			snapshot => snapshot.record.solutionBasis?.source === "team",
		);
		expect(fixture.provider.requests.filter(request => teamStage(request)).length).toBeGreaterThan(calls);
		expect(retry.record.solutionBasis?.source).toBe("team");
		const recipient = retry.runtime?.recipient;
		if (!recipient?.sessionFile) throw new Error("Retried Team native history missing");
		const history = (await fs.readFile(recipient.sessionFile, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as FileEntry);
		const attempts = history.filter(entry => entry.type === "custom" && entry.customType === "dev-solution-attempt");
		expect(attempts).toHaveLength(2);
		const sourceIndex = history.findIndex(entry => entry.id === retry.record.solutionBasis?.sourceEntryIds[0]);
		expect(sourceIndex).toBeGreaterThan(history.indexOf(attempts[1]!));
		expect(retry.record.decisions.some(decision => decision.stage === "solution")).toBe(false);
	} finally {
		release.resolve();
	}
}, 300_000);
