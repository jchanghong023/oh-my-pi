import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { OmpSpecDrivenBridge } from "../../src/modes/zcode/spec-driven";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "../../src/modes/zcode/sessions";
import * as controllers from "../../src/spec-driven/controller";
import type { SpecControllerObservation } from "../../src/spec-driven/controller";
import type { SpecReviewArtifact } from "../../src/spec-driven/types";

afterEach(() => vi.restoreAllMocks());

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const change = "openspec/changes/materials";
const reviewContent = '{"verdict":"pass"}';
const review: SpecReviewArtifact = {
	slotId: "R1",
	actorId: "reviewer",
	sessionId: "reviewer-session",
	model: "fixture",
	path: "checks/review.json",
	version: hash(reviewContent),
};

function fixture(cwd: string) {
	let publish: (observation: SpecControllerObservation) => void = () => {
		throw new Error("Native observer has not been attached");
	};
	vi.spyOn(controllers, "observeSpecDrivenController").mockImplementation((_scope, listener) => {
		publish = listener;
		return () => {};
	});
	const sessionFile = path.join(cwd, "session.jsonl");
	const record = {
		id: "session",
		cwd,
		session: { sessionGeneration: 0, sessionManager: { getSessionFile: () => sessionFile } },
	} as unknown as ZCodeSessionRecord;
	const manager = {
		get: () => record,
		read: async () => ({ cwd, info: { path: sessionFile } }),
	} as unknown as ZCodeSessionManager;
	const bridge = new OmpSpecDrivenBridge(manager);
	bridge.attach(record, () => {});
	const observation: SpecControllerObservation = {
		runId: "material-run",
		cwd,
		createdAt: 1,
		updatedAt: 2,
		active: false,
		released: false,
		disposed: false,
		status: {
			changeId: "materials",
			phase: "awaiting-acceptance",
			paused: false,
			generation: 0,
			questions: [],
			tasks: [],
			reviews: [],
			pendingClosure: [],
			acceptanceVersion: "acceptance-v1",
			specification: {
				version: "spec-v1",
				proposal: "Approved proposal",
				specs: [{ path: "specs/capability/spec.md", content: "Approved specification" }],
				requirements: [{ id: "R1", text: "Approved behavior" }],
				questions: [],
			},
			handoffs: [
				{
					actorId: "requirements",
					sessionId: "requirements-session",
					role: "requirements",
					runId: "material-run",
					generation: 0,
					transition: "requirements-to-solution",
					path: `${change}/handoffs/requirements-to-solution.md`,
					digest: hash("Native handoff"),
					body: "Native handoff",
					versions: { "proposal.md": "spec-v1" },
				},
			],
		},
		interaction: { mode: "dev", draft: "", messages: [], actions: [] },
	};
	const write = async (file: string, content: string) => {
		const target = path.join(cwd, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, content);
	};
	const state = (archivedChangePath?: string) =>
		write(
			".omp/spec-sessions/material-run/state.json",
			JSON.stringify({ status: { reviewArtifacts: [review], archivedChangePath } }),
		);
	const capture = async () => {
		publish(observation);
		return (await bridge.runs(record.id))[0]!;
	};
	return { bridge, manager, observation, state, write, capture };
}

describe("native desktop material locations", () => {
	it("projects only the latest review per slot without changing versions on repeated observations", async () => {
		await using root = await TempDir.create("@omp-spec-review-revisions-");
		const f = fixture(root.path());
		try {
			await f.state();
			await f.write(`${change}/${review.path}`, reviewContent);
			await f.capture();
			const revisedContent = '{"verdict":"pass","summary":"Rechecked repair"}';
			const revised = { ...review, path: "checks/review-revised.json", version: hash(revisedContent) };
			await f.write(`${change}/${revised.path}`, revisedContent);
			await f.write(
				".omp/spec-sessions/material-run/state.json",
				JSON.stringify({ status: { reviewArtifacts: [review, revised] } }),
			);
			await f.capture();
			const repeated = await f.capture();
			expect(repeated.spec.materials.filter(material => material.id === "review:R1")).toEqual([
				{
					id: "review:R1",
					title: "R1",
					readiness: "present",
					sourceVersion: revised.version,
					artifactId: "review:R1",
					version: 2,
				},
			]);
			const listed = await f.bridge.artifacts("session", "material-run");
			expect(listed!.artifacts.find(artifact => artifact.id === "review:R1")?.version).toBe(2);
			const original = await f.bridge.artifactRead({
				sessionId: "session",
				runId: "material-run",
				artifactId: "review:R1",
				version: 1,
				offset: 0,
				limit: 1024,
			});
			expect(Buffer.from(original!.dataBase64, "base64").toString()).toBe(reviewContent);
		} finally {
			await f.bridge.dispose();
		}
	});

	it("reads review originals relative to the change and reports an external deletion", async () => {
		await using root = await TempDir.create("@omp-spec-review-material-");
		const f = fixture(root.path());
		try {
			await f.state();
			await f.write(`${change}/checks/review.json`, reviewContent);
			const run = await f.capture();
			expect(run.spec.materials.find(material => material.id === "review:R1")).toMatchObject({
				readiness: "present",
				artifactId: "review:R1",
				sourceVersion: review.version,
				version: 1,
			});
			const original = await f.bridge.artifactRead({
				sessionId: "session",
				runId: "material-run",
				artifactId: "review:R1",
				version: 1,
				offset: 0,
				limit: 1024,
			});
			expect(Buffer.from(original!.dataBase64, "base64").toString()).toBe(reviewContent);
			await fs.unlink(root.join(`${change}/checks/review.json`));
			expect((await f.capture()).spec.materials.find(material => material.id === "review:R1")?.readiness).toBe(
				"missing",
			);
		} finally {
			await f.bridge.dispose();
		}
	});

	it("keeps normally archived materials readable in live and cold views without hiding later loss", async () => {
		await using root = await TempDir.create("@omp-spec-archive-material-");
		const f = fixture(root.path());
		try {
			await f.state();
			const originals = new Map<string, readonly [string, string]>([
				["proposal", ["proposal.md", "Approved proposal"]],
				["spec:specs/capability/spec.md", ["specs/capability/spec.md", "Approved specification"]],
				["verification", ["verification.md", "Final verification"]],
				[
					"handoff:requirements:requirements-to-solution",
					["handoffs/requirements-to-solution.md", "Native handoff"],
				],
				["review:R1", ["checks/review.json", reviewContent]],
			]);
			for (const [file, content] of originals.values()) await f.write(`${change}/${file}`, content);
			await f.capture();
			const archive = "openspec/changes/archive/2026-10-25-materials";
			await fs.mkdir(root.join("openspec/changes/archive"), { recursive: true });
			await fs.rename(root.join(change), root.join(archive));
			await f.state(archive);
			f.observation.status.phase = "completed";
			f.observation.released = true;
			const completed = await f.capture();
			const cold = new OmpSpecDrivenBridge(f.manager);
			const history = (await cold.runs("session"))[0]!;
			for (const [id, [, content]] of originals) {
				for (const run of [completed, history])
					expect(run.spec.materials.find(material => material.id === id)).toMatchObject({
						readiness: "present",
						artifactId: id,
					});
				const material = history.spec.materials.find(item => item.id === id)!;
				const bytes = await cold.artifactRead({
					sessionId: "session",
					runId: history.runId,
					artifactId: id,
					version: material.version!,
					offset: 0,
					limit: 1024,
				});
				expect(Buffer.from(bytes!.dataBase64, "base64").toString()).toBe(content);
			}
			await fs.unlink(root.join(`${archive}/specs/capability/spec.md`));
			const lost = (await cold.runs("session"))[0]!;
			expect(lost.spec.materials.find(material => material.id === "spec:specs/capability/spec.md")?.readiness).toBe(
				"missing",
			);
		} finally {
			await f.bridge.dispose();
		}
	});
});
