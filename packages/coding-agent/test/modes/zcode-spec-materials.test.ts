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
		...document(`${stem}-solutions.json`, '{"candidates":[{"id":"reuse","title":"复用","content":"完整方案"}]}'),
		candidates: [{ id: "reuse", title: "复用", content: "完整方案" }],
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
		status: {
			changeId: "materials",
			phase: "awaiting-acceptance",
			paused: false,
			generation: 0,
			specification: { version: "requirements-v1", files: [proposal, spec] },
			solution,
			selection: { candidateId: "reuse", userReply: "用户原始确认" },
			plan,
			report,
		},
		interaction: { mode: "dev", draft: "", messages: [], actions: [] },
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
	return { bridge, manager, observation, write, capture, initialize, originals };
}

describe("desktop real file materials", () => {
	it("captures the five formal files without fabricated task, handoff or review facts", async () => {
		await using root = await TempDir.create("@omp-spec-file-materials-");
		const f = fixture(root.path());
		try {
			await f.initialize();
			const run = await f.capture();
			expect(run.spec.candidates).toEqual(f.observation.status.solution!.candidates);
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

	it("does not change capture versions on repeated observations, retains history and reports external file deletion", async () => {
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
			const original = await f.bridge.artifactRead({
				sessionId: "session",
				runId: "material-run",
				artifactId: "report",
				version: 1,
				offset: 0,
				limit: 8192,
			});
			expect(Buffer.from(original!.dataBase64, "base64").toString()).toBe(f.originals[4]!.content);
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
			f.observation.status.phase = "completed";
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
});
