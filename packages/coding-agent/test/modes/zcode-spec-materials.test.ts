import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { OmpSpecDrivenBridge } from "../../src/modes/zcode/spec-driven";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "../../src/modes/zcode/sessions";
import * as controllers from "../../src/spec-driven/controller";
import type { SpecControllerObservation } from "../../src/spec-driven/controller";
import type { SpecDocument } from "../../src/spec-driven/types";
import { DevWorkspace } from "../../src/spec-driven/workspace";

afterEach(() => vi.restoreAllMocks());
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const change = "openspec/changes/materials";
const stem = "docs/superpowers/plans/2026-10-26-materials";
const document = (path: string, content: string): SpecDocument => ({ path, content, version: hash(content) });

function fixture(cwd: string) {
	let publish: (observation: SpecControllerObservation) => void = () => {
		throw new Error("Observer not attached");
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
	const proposal = document(`${change}/proposal.md`, "Approved proposal");
	const spec = document(`${change}/specs/capability/spec.md`, "Approved specification");
	const solution = {
		...document(
			`${stem}-solutions.json`,
			'{"recommendedCandidateId":"reuse","candidates":[{"id":"reuse","title":"复用","content":"完整方案"}]}',
		),
		candidates: [{ id: "reuse", title: "复用", content: "完整方案" }],
		recommendedCandidateId: "reuse",
	};
	const plan = document(`${stem}.md`, "# Superpowers Plan\n原有模板不变");
	const report = document(
		`${stem}-completion.md`,
		"# 完成报告\n## 完成情况\n已完成\n## 验证结果\n命令、状态、结果与限制\n## 未完成项\n无",
	);
	const observation: SpecControllerObservation = {
		runId: "material-run",
		cwd,
		createdAt: 1,
		updatedAt: 2,
		active: false,
		released: false,
		disposed: false,
		teamMutable: false,
		approvals: {
			requirements: { files: [proposal, spec], userReply: "/dev next" },
			solution: { files: [solution], userReply: "/dev next reuse", candidateId: "reuse" },
			planner: { files: [plan], userReply: "/dev next" },
		},
		status: {
			changeId: "materials",
			phase: "executing",
			awaitingAcceptance: true,
			useTeam: true,
			generation: 0,
			paths: {
				requirements: [`${change}/proposal.md`, `${change}/specs/*/spec.md`],
				solution: solution.path,
				plan: plan.path,
				report: report.path,
			},
			specification: { version: "requirements-v1", files: [proposal, spec] },
			solution,
			selection: { candidateId: "reuse", userReply: "用户原始确认" },
			plan,
			report,
		},
		interaction: {
			mode: "dev",
			recipient: { role: "executor", actorId: "executor", sessionId: "native-executor" },
			actions: [],
		},
	};
	const write = async (file: string, content: string) => {
		const target = path.join(cwd, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, content);
	};
	const originals = [proposal, spec, solution, plan, report];
	const initialize = async () => {
		for (const file of originals) await write(file.path, file.content);
	};
	const capture = async () => {
		publish(observation);
		return (await bridge.runs(record.id))[0]!;
	};
	return { bridge, manager, record, observation, write, capture, initialize, originals };
}

describe("desktop real file materials", () => {
	it("reads every written capability before next without approving or copying pending requirements", async () => {
		await using root = await TempDir.create("@omp-spec-pending-materials-");
		const f = fixture(root.path());
		try {
			f.observation.approvals = {};
			f.observation.status.phase = "requirements";
			f.observation.status.awaitingAcceptance = false;
			f.observation.status.specification = undefined;
			f.observation.status.solution = undefined;
			f.observation.status.selection = undefined;
			f.observation.status.plan = undefined;
			f.observation.status.report = undefined;
			const pending = [
				document(`${change}/proposal.md`, "# Draft proposal\nNot yet approved"),
				document(`${change}/specs/alpha/spec.md`, "# Alpha\nFull pending alpha requirement"),
				document(`${change}/specs/beta/spec.md`, "# Beta\nFull pending beta requirement"),
			];
			for (const file of pending) await f.write(file.path, file.content);
			const run = await f.capture();
			expect(
				run.spec.materials.filter(material => material.id.startsWith("requirement:")).map(material => material.id),
			).toEqual(pending.map(file => `requirement:${file.path}`));
			expect(run.spec.materials.some(material => material.id.includes("*"))).toBe(false);
			expect(run.spec.versions).not.toHaveProperty("specification");
			expect(f.observation.status.specification).toBeUndefined();
			expect(f.observation.status.phase).toBe("requirements");
			for (const file of pending) {
				const material = run.spec.materials.find(item => item.id === `requirement:${file.path}`)!;
				expect(material.readiness).toBe("present");
				const read = await f.bridge.artifactRead({
					sessionId: "session",
					runId: run.runId,
					artifactId: material.artifactId!,
					version: material.version!,
					offset: 0,
					limit: 8192,
				});
				expect(Buffer.from(read!.dataBase64, "base64").toString()).toBe(file.content);
			}
			const index = JSON.parse(await fs.readFile(root.join(".omp/spec-sessions/material-run/zcode.json"), "utf8"));
			expect(index).not.toHaveProperty("specificationVersion");
			for (const artifact of index.artifacts) {
				expect(artifact).not.toHaveProperty("expectedVersion");
				expect(artifact).not.toHaveProperty("content");
			}
			const artifacts = await f.bridge.artifacts("session", run.runId);
			expect(artifacts!.artifacts.map(artifact => artifact.sourcePath)).toEqual(pending.map(file => file.path));
			const archive = "openspec/changes/archive/2026-10-26-materials";
			await fs.mkdir(root.join("openspec/changes/archive"), { recursive: true });
			await fs.rename(root.join(change), root.join(archive));
			f.observation.status.archivedChangePath = archive;
			const relocated = await f.capture();
			expect(
				relocated.spec.materials
					.filter(material => material.id.startsWith("requirement:"))
					.map(material => material.id),
			).toEqual(pending.map(file => `requirement:${file.path}`));
			const cold = new OmpSpecDrivenBridge(f.manager);
			try {
				const history = (await cold.runs("session"))[0]!;
				expect(history.spec).toMatchObject({ live: false, readOnly: true, actions: [] });
				expect(history.spec).not.toHaveProperty("interaction");
				expect(history.spec.versions).not.toHaveProperty("specification");
				for (const file of pending) {
					const material = history.spec.materials.find(item => item.id === `requirement:${file.path}`)!;
					expect(material.readiness).toBe("present");
					const read = await cold.artifactRead({
						sessionId: "session",
						runId: history.runId,
						artifactId: material.artifactId!,
						version: material.version!,
						offset: 0,
						limit: 8192,
					});
					expect(Buffer.from(read!.dataBase64, "base64").toString()).toBe(file.content);
				}
			} finally {
				await cold.dispose();
			}
		} finally {
			await f.bridge.dispose();
		}
	});

	it("does not invent wildcard materials when pending capability files have not been generated", async () => {
		await using root = await TempDir.create("@omp-spec-pending-empty-");
		const f = fixture(root.path());
		f.observation.approvals = {};
		try {
			f.observation.status.specification = undefined;
			f.observation.status.solution = undefined;
			f.observation.status.plan = undefined;
			f.observation.status.report = undefined;
			const empty = await f.capture();
			expect(empty.spec.materials.map(material => material.id)).toEqual([
				`requirement:${change}/proposal.md`,
				"solution",
				"plan",
				"report",
			]);
			expect(empty.spec.materials.every(material => material.readiness === "not_generated")).toBe(true);
			expect(empty.spec.versions).not.toHaveProperty("specification");
			expect(f.observation.status.paths!.requirements).toContain(`${change}/specs/*/spec.md`);
		} finally {
			await f.bridge.dispose();
		}
	});

	it("captures the five formal files without fabricated task, handoff or review facts", async () => {
		await using root = await TempDir.create("@omp-spec-file-materials-");
		const f = fixture(root.path());
		try {
			await f.initialize();
			const run = await f.capture();
			expect(run.spec.candidates).toEqual(f.observation.status.solution!.candidates);
			expect(run.spec.recommendedCandidateId).toBe("reuse");
			expect(run.spec.selectedCandidate).toEqual({ id: "reuse", userReply: "用户原始确认" });
			expect(run.spec).not.toHaveProperty("tasks");
			expect(run.spec).not.toHaveProperty("progress");
			expect(run.spec.materials.map(material => material.id)).toEqual([
				`requirement:${change}/proposal.md`,
				`requirement:${change}/specs/capability/spec.md`,
				"solution",
				"plan",
				"report",
			]);
			for (const material of run.spec.materials) expect(material.readiness).toBe("present");
			const report = await f.bridge.artifactRead({
				sessionId: "session",
				runId: "material-run",
				artifactId: "report",
				version: 1,
				offset: 0,
				limit: 8192,
			});
			expect(Buffer.from(report!.dataBase64, "base64").toString()).toBe(f.observation.status.report!.content);
		} finally {
			await f.bridge.dispose();
		}
	});

	it("keeps observed version metadata without copying obsolete material bodies and reports deletion", async () => {
		await using root = await TempDir.create("@omp-spec-file-history-");
		const f = fixture(root.path());
		try {
			await f.initialize();
			await f.capture();
			const revised = document(`${stem}-completion.md`, `${f.observation.status.report!.content}\n补充真实限制`);
			f.observation.status.report = revised;
			await f.write(revised.path, revised.content);
			await f.capture();
			const repeated = await f.capture();
			expect(repeated.spec.materials.find(material => material.id === "report")).toMatchObject({
				readiness: "present",
				version: 2,
				sourceVersion: revised.version,
			});
			await expect(
				f.bridge.artifactRead({
					sessionId: "session",
					runId: "material-run",
					artifactId: "report",
					version: 1,
					offset: 0,
					limit: 8192,
				}),
			).rejects.toThrow("no longer available");
			const current = await f.bridge.artifactRead({
				sessionId: "session",
				runId: "material-run",
				artifactId: "report",
				version: 2,
				offset: 0,
				limit: 8192,
			});
			expect(Buffer.from(current!.dataBase64, "base64").toString()).toBe(revised.content);
			const index = JSON.parse(await fs.readFile(root.join(".omp/spec-sessions/material-run/zcode.json"), "utf8"));
			expect(index).not.toHaveProperty("row");
			expect(index).not.toHaveProperty("interaction");
			expect(index).not.toHaveProperty("useGoal");
			expect(index.artifacts.every((artifact: Record<string, unknown>) => !("content" in artifact))).toBe(true);
			expect(await fs.readdir(root.join(".omp/spec-sessions/material-run"))).toEqual(["zcode.json"]);
			await fs.unlink(root.join(revised.path));
			expect((await f.capture()).spec.materials.find(material => material.id === "report")?.readiness).toBe(
				"missing",
			);
		} finally {
			await f.bridge.dispose();
		}
	});

	it("archives only requirements and keeps execution materials at their Superpowers paths in live and cold views", async () => {
		await using root = await TempDir.create("@omp-spec-file-archive-");
		const f = fixture(root.path());
		try {
			await f.initialize();
			await f.capture();
			const archive = "openspec/changes/archive/2026-10-26-materials";
			await fs.mkdir(root.join("openspec/changes/archive"), { recursive: true });
			await fs.rename(root.join(change), root.join(archive));
			f.observation.status.archivedChangePath = archive;
			f.observation.status.phase = "idle";
			f.observation.released = true;
			const completed = await f.capture();
			const cold = new OmpSpecDrivenBridge(f.manager);
			try {
				const history = (await cold.runs("session"))[0]!;
				for (const run of [completed, history])
					for (const material of run.spec.materials) expect(material.readiness).toBe("present");
				for (const file of f.originals.filter(file => file.path.startsWith("docs/")))
					expect(await fs.readFile(root.join(file.path), "utf8")).toBe(file.content);
				await fs.unlink(root.join(`${archive}/specs/capability/spec.md`));
				const lost = (await cold.runs("session"))[0]!;
				expect(
					lost.spec.materials.find(material => material.id === `requirement:${change}/specs/capability/spec.md`)
						?.readiness,
				).toBe("missing");
			} finally {
				await cold.dispose();
			}
		} finally {
			await f.bridge.dispose();
		}
	});
	it("cold queries remain read-only without subscribing, restoring an owner or granting controls", async () => {
		await using root = await TempDir.create("@omp-spec-cold-");
		const f = fixture(root.path());
		await f.initialize();
		await f.capture();
		await f.bridge.dispose();
		await f.write(".omp/dev/state.json", JSON.stringify({ version: 1, team: true, run: { runId: "material-run" } }));
		const observe = vi.spyOn(controllers, "observeSpecDrivenController");
		observe.mockClear();
		const peek = vi.spyOn(controllers, "peekSpecDrivenController");
		const cold = new OmpSpecDrivenBridge(f.manager);
		try {
			const history = (await cold.runs("session"))[0]!;
			expect(history.status).toBe("stopped");
			expect(history.spec).toMatchObject({
				live: false,
				readOnly: true,
				useTeam: true,
				teamMutable: false,
				actions: [],
			});
			expect(history.spec).not.toHaveProperty("interaction");
			expect(history.spec.selectedCandidate).toEqual({ id: "reuse", userReply: "用户原始确认" });
			expect(history.spec.candidates).toEqual(f.observation.status.solution!.candidates);
			expect(history.spec.recommendedCandidateId).toBe("reuse");
			expect(observe).not.toHaveBeenCalled();
			expect(peek).not.toHaveBeenCalled();
			const workspace = await DevWorkspace.acquire(root.path());
			workspace.release();
		} finally {
			await cold.dispose();
		}
	});

	it("projects transient native notices without replacing errors or persisting a protocol field", async () => {
		await using root = await TempDir.create("@omp-spec-notice-");
		const f = fixture(root.path());
		try {
			await f.initialize();
			f.observation.notice = "Cleared invalid Dev state";
			expect((await f.capture()).spec.explanation).toBe(f.observation.notice);
			f.observation.error = "Native action failed";
			expect((await f.capture()).spec.explanation).toBe(f.observation.error);
			f.observation.status.blockedReason = "Approval changed";
			expect((await f.capture()).spec.explanation).toBe(f.observation.status.blockedReason);
			const saved = JSON.parse(await fs.readFile(root.join(".omp/spec-sessions/material-run/zcode.json"), "utf8"));
			expect(saved).not.toHaveProperty("notice");
		} finally {
			await f.bridge.dispose();
		}
	});

	it("isolates malformed saved rows before caching and can read repaired observations", async () => {
		await using root = await TempDir.create("@omp-spec-malformed-index-");
		const f = fixture(root.path());
		await f.initialize();
		await f.capture();
		await f.bridge.dispose();
		const saved = JSON.parse(await fs.readFile(root.join(".omp/spec-sessions/material-run/zcode.json"), "utf8"));
		const malformed = [
			{ changeId: "" },
			{ createdAt: "not-a-timestamp" },
			{ updatedAt: "not-a-timestamp" },
			{ generation: -1 },
		];
		for (const [index, fields] of malformed.entries())
			await f.write(
				`.omp/spec-sessions/bad-${index}/zcode.json`,
				JSON.stringify({ ...saved, runId: `bad-${index}`, ...fields }),
			);
		await f.write(".omp/spec-sessions/broken/zcode.json", "{");
		const cold = new OmpSpecDrivenBridge(f.manager);
		try {
			for (let read = 0; read < 2; read++)
				expect((await cold.runs("session")).map(run => run.runId)).toEqual(["material-run"]);
			await f.write(".omp/spec-sessions/bad-0/zcode.json", JSON.stringify({ ...saved, runId: "bad-0" }));
			expect((await cold.runs("session")).map(run => run.runId).sort()).toEqual(["bad-0", "material-run"]);
			const workspace = await DevWorkspace.acquire(root.path());
			workspace.release();
		} finally {
			await cold.dispose();
		}
	});

	it("reports missing and corrupt materials without turning a state read into a transition failure", async () => {
		await using root = await TempDir.create("@omp-spec-material-gaps-");
		const f = fixture(root.path());
		try {
			f.observation.approvals = {};
			f.observation.status.specification = undefined;
			f.observation.status.solution = undefined;
			f.observation.status.plan = undefined;
			f.observation.status.report = undefined;
			const empty = await f.capture();
			expect(empty.spec.materials.every(material => material.readiness === "not_generated")).toBe(true);
			expect(empty.spec.phase).toBe("executing");
			expect(empty.spec.state).toBe("waiting");
			const broken = document(`${stem}-solutions.json`, "{broken JSON");
			f.observation.status.solution = { ...broken, candidates: [], recommendedCandidateId: "reuse" };
			await f.write(broken.path, broken.content);
			expect((await f.capture()).spec.materials.find(material => material.id === "solution")?.readiness).toBe(
				"unreadable",
			);
			await fs.unlink(root.join(broken.path));
			expect((await f.capture()).spec.materials.find(material => material.id === "solution")?.readiness).toBe(
				"missing",
			);
		} finally {
			await f.bridge.dispose();
		}
	});
	it("marks solutions with missing or invalid recommendations unreadable without exposing candidates", async () => {
		await using root = await TempDir.create("@omp-spec-recommendation-gaps-");
		const f = fixture(root.path());
		try {
			f.observation.approvals = {};
			const candidates = [{ id: "one", title: "方案", content: "完整正文" }];
			for (const recommendedCandidateId of [undefined, "other"]) {
				await f.write(f.observation.status.paths!.solution, JSON.stringify({ candidates, recommendedCandidateId }));
				const run = await f.capture();
				expect(run.spec.materials.find(material => material.id === "solution")?.readiness).toBe("unreadable");
				expect(run.spec.candidates).toEqual([]);
				expect(run.spec.recommendedCandidateId).toBeNull();
			}
		} finally {
			await f.bridge.dispose();
		}
	});
	it("captures edited solution candidates after back revokes approval despite retained snapshots", async () => {
		await using root = await TempDir.create("@omp-spec-backed-solution-");
		const f = fixture(root.path());
		try {
			await f.initialize();
			const before = await f.capture();
			f.observation.status.phase = "solution";
			f.observation.status.awaitingAcceptance = false;
			f.observation.status.selection = undefined;
			delete f.observation.approvals.solution;
			delete f.observation.approvals.planner;
			const candidates = [{ id: "pure", title: "纯实现", content: "回退后修订的完整方案" }];
			const content = JSON.stringify({ candidates, recommendedCandidateId: "pure" });
			await f.write(f.observation.status.paths!.solution, content);
			f.observation.interaction.actions = [{ id: "next", label: "Next", command: "/dev next", available: true }];
			vi.spyOn(controllers, "peekSpecDrivenController").mockReturnValue({
				observation: () => f.observation,
				actions: () => f.observation.interaction.actions,
			} as ReturnType<typeof controllers.peekSpecDrivenController>);
			const current = await f.capture();
			expect(current.spec.candidates).toEqual(candidates);
			expect(current.spec.recommendedCandidateId).toBe("pure");
			expect(current.spec.materials.find(material => material.id === "solution")).toMatchObject({
				readiness: "present",
				sourceVersion: hash(content),
				version: 2,
			});
			expect(current.spec.versions.solution).not.toBe(before.spec.versions.solution);
			const binding = current.spec.actions[0]!.binding;
			expect(binding.files).toContainEqual({
				path: f.observation.status.paths!.solution,
				version: hash(content),
			});
			await expect(f.bridge.validate(f.record, "/dev next pure", binding)).resolves.toBeUndefined();
			await expect(f.bridge.validate(f.record, "/dev back", binding)).rejects.toThrow("allowed");
			await expect(f.bridge.validate(f.record, "/dev next pure extra", binding)).rejects.toThrow("allowed");
			f.observation.interaction.actions[0]!.available = false;
			await expect(f.bridge.validate(f.record, "/dev next pure", binding)).rejects.toThrow("allowed");
			f.observation.interaction.actions[0]!.available = true;
			await f.write(f.observation.status.paths!.solution, JSON.stringify({ candidates: [] }));
			await expect(f.bridge.validate(f.record, "/dev next pure", binding)).rejects.toThrow("stale");
		} finally {
			await f.bridge.dispose();
		}
	});

	it("captures revised requirements and plans after back while retaining approved upstream guards", async () => {
		await using root = await TempDir.create("@omp-spec-backed-materials-");
		const f = fixture(root.path());
		try {
			await f.initialize();
			await f.capture();
			f.observation.status.phase = "planning";
			delete f.observation.approvals.planner;
			const plan = "# Updated plan\nCurrent workspace and remaining work";
			await f.write(f.observation.status.paths!.plan, plan);
			const planning = await f.capture();
			expect(planning.spec.materials.find(material => material.id === "plan")).toMatchObject({
				readiness: "present",
				sourceVersion: hash(plan),
				version: 2,
			});
			await f.write(f.observation.status.solution!.path, '{"candidates":[]}');
			const changedUpstream = await f.capture();
			expect(changedUpstream.spec.materials.find(material => material.id === "solution")?.readiness).toBe("unknown");
			expect(changedUpstream.spec.versions.solution).toBe(f.observation.status.solution!.version);
			f.observation.status.phase = "requirements";
			f.observation.approvals = {};
			const proposal = "# Revised proposal\nChanged scope";
			const added = document(`${change}/specs/added/spec.md`, "# Added capability\nNew acceptance");
			await f.write(f.observation.status.specification!.files[0]!.path, proposal);
			await f.write(added.path, added.content);
			const requirements = await f.capture();
			expect(
				requirements.spec.materials.find(material => material.id === `requirement:${change}/proposal.md`),
			).toMatchObject({
				readiness: "present",
				sourceVersion: hash(proposal),
				version: 2,
			});
			expect(
				requirements.spec.materials.find(material => material.id === `requirement:${added.path}`),
			).toMatchObject({
				readiness: "present",
				sourceVersion: added.version,
			});
		} finally {
			await f.bridge.dispose();
		}
	});

	it("rejects a stale phase or changed formal bytes before admitting an advertised decision", async () => {
		await using root = await TempDir.create("@omp-spec-stale-action-");
		const f = fixture(root.path());
		try {
			await f.initialize();
			f.observation.interaction.actions = [{ id: "next", label: "Next", command: "/dev next", available: true }];
			vi.spyOn(controllers, "peekSpecDrivenController").mockReturnValue({
				observation: () => f.observation,
				actions: () => f.observation.interaction.actions,
			} as ReturnType<typeof controllers.peekSpecDrivenController>);
			const run = await f.capture();
			const binding = run.spec.actions[0]!.binding;
			await expect(f.bridge.validate(f.record, "/dev next", binding)).resolves.toBeUndefined();
			await expect(f.bridge.validate(f.record, "/dev next pure", binding)).rejects.toThrow("allowed");
			f.observation.status.phase = "planning";
			await expect(f.bridge.validate(f.record, "/dev next", binding)).rejects.toThrow("stale");
			f.observation.status.phase = "executing";
			await f.write(f.observation.status.plan!.path, "unapproved external edit");
			await expect(f.bridge.validate(f.record, "/dev next", binding)).rejects.toThrow("stale");
			const recaptured = await f.capture();
			expect(recaptured.spec.materials.find(material => material.id === "plan")?.readiness).toBe("unknown");
			expect(recaptured.spec.versions.plan).toBe(run.spec.versions.plan);
			await expect(f.bridge.validate(f.record, "/dev next", recaptured.spec.actions[0]!.binding)).rejects.toThrow(
				"stale",
			);
		} finally {
			await f.bridge.dispose();
		}
	});
});
