import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { artifactVersion, SpecArtifactStore } from "../../src/spec-driven/artifacts";
import { syncDevRequirement } from "../../src/spec-driven/native-sync";
import { hasExplicitRepairIntent, SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import type {
	DevActionIntent,
	DevDecision,
	DevRequirementRecord,
	DevStage,
	SpecAgentInput,
	SpecConversationRecipient,
	SpecDrivenPorts,
	SpecStageRole,
} from "../../src/spec-driven/types";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const business =
	"# 业务需求：订单\n\n" +
	[
		"基本信息",
		"业务背景与目标",
		"实际使用场景与现状",
		"期望结果",
		"业务规则与边界",
		"典型例子",
		"业务验收预期",
		"待确认事项",
		"资料来源",
		"业务确认与交接",
	]
		.map(heading => `## ${heading}\n已确认的完整业务事实 Ω。\n`)
		.join("\n");
const proposal =
	"## Why\n\nThe sample capability currently lacks a stable, documented behavior contract, so callers cannot rely on consistent results across supported workflows.\n\n## What Changes\n\n- Add sample behavior.\n\n## Capabilities\n\n### New Capabilities\n- `sample`: sample behavior.\n\n### Modified Capabilities\n\nNone.\n\n## Impact\n\nSample public API.\n";
const delta =
	"## ADDED Requirements\n\n### Requirement: Sample\nThe system SHALL preserve sample behavior.\n\n#### Scenario: Works\n- **WHEN** the sample API is used\n- **THEN** the expected result is returned\n";
const report =
	"# 完成报告\n\n## 完成情况\n实现批准范围。\n\n## 验证结果\nUT 未运行：无授权。独立审查未运行。\n\n## 未完成项\nWindows 尚未验证，存在平台限制。\n";
function record(): DevRequirementRecord {
	return {
		schemaVersion: 1,
		requirementId: "sample-change",
		changeId: "sample-change",
		branch: "main",
		stage: "business",
		lifecycle: "active",
		materials: [],
		decisions: [],
		marks: {},
		solutionBasis: null,
		report: { development: null, st: null },
		syncRevisions: [],
		gitOperations: [],
		pr: null,
		testing: "not-started",
		relatedRequirementIds: [],
	};
}
async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eight-stages-"));
	roots.push(cwd);
	const businessPath = "docs/business-requirements/sample-change.md";
	const initial = new SpecArtifactStore({ cwd, changeId: "sample-change" });
	const paths = await initial.initialize(businessPath);
	const store = new SpecArtifactStore({ cwd, changeId: "sample-change", paths });
	await store.initialize();
	const write = async (file: string, content: string) => {
		await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
		await fs.writeFile(path.join(cwd, file), content);
	};
	await write(businessPath, business);
	await write(paths.requirements[0]!, proposal);
	const spec = paths.requirements[1]!.replace(/\*+/, "sample");
	await write(spec, delta);
	await write(
		paths.solution,
		JSON.stringify({
			recommendedCandidateId: "one",
			candidates: [{ id: "one", title: "One", content: "# 完整方案\n\n唯一方向及其风险。" }],
		}),
	);
	await write(paths.plan, "# Sample Implementation Plan\n\nImplement the approved sample API.\n");
	await write(paths.report, report);
	const initialRecord = record();
	initialRecord.materials = [
		{ id: "business", kind: "business", path: businessPath, version: artifactVersion(business) },
		{ id: "proposal", kind: "proposal", path: paths.requirements[0]!, version: artifactVersion(proposal) },
		{ id: "delta:sample", kind: "delta", path: spec, version: artifactVersion(delta) },
		...(await Promise.all(
			(["solution", "plan", "report"] as const).map(async kind => ({
				id: kind,
				kind,
				path: paths[kind],
				version: artifactVersion(await fs.readFile(path.join(cwd, paths[kind]))),
			})),
		)),
	];
	const inputs: SpecAgentInput[] = [];
	const events: string[] = [];
	const persisted: DevRequirementRecord[] = [];
	const refs: Partial<Record<SpecStageRole, SpecConversationRecipient>> = {};
	const settings = { saveFailure: false, prepareFailure: false, busy: false, team: false, closeCalls: 0 };
	const ports: SpecDrivenPorts = {
		agents: {
			async prepare(role) {
				events.push(`prepare:${role}`);
				if (settings.prepareFailure) throw new Error("prepare failed");
				refs[role] = { role, actorId: role, sessionId: `session-${role}` };
			},
			recipient: role => refs[role],
			originalRequest: () => "",
			async run(input) {
				inputs.push(structuredClone(input));
				events.push(`run:${input.role}`);
				return { text: "native reply, not approval" };
			},
			async solutionBasis(solution) {
				return {
					solutionVersion: solution.version,
					candidateIds: solution.candidates.map(item => item.id),
					usableCandidateIds: solution.candidates.map(item => item.id),
					source: "single-agent",
					sourceSessionId: "session-solution",
					sourceEntryIds: ["native-result"],
				};
			},
		},
		artifacts: {
			initialize: (_id, _context, file) => store.initialize(file),
			readBusiness: () => store.readBusiness(businessPath),
			readRequirements: () => store.readRequirements(),
			readSolution: () => store.readSolution(),
			readPlan: () => store.readPlan(),
			readReport: () => store.readReport(),
			checkVersions: (files, archived) => store.checkVersions(files, archived),
			async close(input) {
				settings.closeCalls++;
				return store.close(input);
			},
		},
	};
	const core = new SpecDrivenOrchestrator(ports, {
		record: initialRecord,
		paths,
		getUseTeam: () => settings.team,
		async persist(value) {
			events.push(`save:${value.stage}`);
			if (settings.saveFailure) throw new Error("disk full");
			persisted.push(structuredClone(value));
		},
		getSessions: () => refs,
		persistSessions: async () => {},
		assertTransitionAllowed() {
			if (settings.busy) throw new Error("native work pending");
		},
	});
	let operation = 0;
	async function act(intent: DevActionIntent, userReply = "  人员原始决定\n保留空白 Ω  ") {
		const inspected = await core.inspect(intent);
		const current = core.record();
		const decision: DevDecision = {
			operationId: `operation-${++operation}`,
			stage: current.stage,
			actor: { name: "人员", source: "local" },
			at: "2026-11-07T12:00:00.000Z",
			userReply,
			files: inspected.files,
			...(inspected.candidateId ? { candidateId: inspected.candidateId } : {}),
		};
		if (intent.kind === "mark" || intent.kind === "set-test-state" || intent.kind === "link-fix") {
			core.replaceRecord(await core.decide(current, intent, decision));
		} else await core.execute(intent, decision);
		return decision;
	}
	async function through(stage: DevStage) {
		while (core.record().stage !== stage) await act({ kind: "next" });
	}
	return { cwd, core, ports, store, paths, spec, inputs, events, persisted, refs, settings, write, act, through };
}

describe("explicit repair authorization", () => {
	it("distinguishes a scoped imperative from discussion, assent and prohibition", () => {
		for (const text of [
			"修复这个错误，不要修改公开 API",
			"请继续完成已批准计划",
			"Please fix the obstruction, without changing the approved files",
		])
			expect(hasExplicitRepairIntent(text)).toBe(true);
		for (const text of [
			"修复这个错误是否影响调用？先解释",
			"修正这个问题需要改哪些文件",
			"不要修复，只解释",
			"修复这个错误，不要改代码",
			"好的",
		])
			expect(hasExplicitRepairIntent(text)).toBe(false);
	});
});

describe("material decisions, not chat, drive eight stages", () => {
	it("imports without a business actor, hands full bytes and raw decisions onward, and stops fifth Next at ST", async () => {
		const f = await fixture();
		expect(f.core.record().stage).toBe("business");
		expect(f.core.recipient()).toBeUndefined();
		expect(f.inputs).toEqual([]);
		const businessPath = f.paths.business;
		if (!businessPath) throw new Error("Expected the initialized business material path");
		const decision = await f.act({ kind: "next" });
		expect(f.inputs[0]?.role).toBe("requirements");
		expect(f.inputs[0]?.files).toContainEqual({
			path: businessPath,
			content: business,
			version: artifactVersion(business),
		});
		expect(f.inputs[0]?.userReply).toBe(decision.userReply);
		expect(f.refs.business).toBeUndefined();
		await f.through("st");
		expect(f.core.record().decisions.map(item => item.stage)).toEqual([
			"business",
			"requirements",
			"solution",
			"planning",
			"executing",
		]);
		expect(f.core.record().report.development?.userReply).toBe(decision.userReply);
		expect(f.core.record().report.development?.files).toContainEqual({
			path: f.paths.report,
			version: artifactVersion(report),
		});
		expect(f.settings.closeCalls).toBe(0);
		expect(await Bun.file(path.join(f.cwd, "openspec/changes/sample-change/proposal.md")).exists()).toBe(true);
		expect(f.inputs.map(input => input.role)).toEqual(["requirements", "solution", "planner", "executor"]);
	}, 120_000);

	it("accepts one candidate automatically, but preserves all alternatives and requires explicit choice for many", async () => {
		const f = await fixture();
		await f.through("solution");
		const candidates = [
			{ id: "a", title: "A", content: "# A\n\n完整方案 A Ω" },
			{ id: "b", title: "B", content: "# B\n\n完整方案 B Ω" },
		];
		await f.write(f.paths.solution, JSON.stringify({ candidates, recommendedCandidateId: "b" }));
		await expect(f.core.inspect({ kind: "next" })).rejects.toThrow();
		await expect(f.core.inspect({ kind: "next", candidateId: "absent" })).rejects.toThrow();
		await f.act({ kind: "next", candidateId: "a" });
		expect(f.core.record().decisions.at(-1)?.candidateId).toBe("a");
		expect(f.inputs.at(-1)?.files.find(file => file.path === f.paths.solution)?.content).toBe(
			JSON.stringify({ candidates, recommendedCandidateId: "b" }),
		);
		expect(f.inputs.at(-1)?.candidateId).toBe("a");
	}, 120_000);

	it("rejects changed approved bytes and newly introduced recursive specifications without advancing or starting a successor", async () => {
		for (const mutation of ["business", "delta", "recursive"] as const) {
			const f = await fixture();
			await f.through("solution");
			const before = f.core.record();
			const calls = f.inputs.length;
			await f.write(
				mutation === "business"
					? f.paths.business!
					: mutation === "delta"
						? f.spec
						: "openspec/changes/sample-change/specs/nested/extra/spec.md",
				"changed after approval\n",
			);
			await expect(f.act({ kind: "next" })).rejects.toThrow();
			expect(f.core.record().stage).toBe(before.stage);
			expect(f.core.record().decisions).toEqual(before.decisions);
			expect(f.inputs).toHaveLength(calls);
		}
	}, 120_000);

	it("persists before preparing a successor and does not report success after save failure", async () => {
		const f = await fixture();
		f.settings.saveFailure = true;
		await expect(f.act({ kind: "next" })).rejects.toThrow("disk full");
		expect(f.core.record().stage).toBe("business");
		expect(f.core.record().decisions).toEqual([]);
		expect(f.inputs).toEqual([]);
		expect(f.events).not.toContain("prepare:requirements");
		f.settings.saveFailure = false;
		await f.act({ kind: "next" });
		expect(f.events.indexOf("save:requirements")).toBeLessThan(f.events.indexOf("prepare:requirements"));
	}, 120_000);

	it("rejects busy native trees before material approval and does not turn conversation into a decision", async () => {
		const f = await fixture();
		f.settings.busy = true;
		await expect(f.act({ kind: "next" })).rejects.toThrow("native work pending");
		expect(f.core.record().decisions).toEqual([]);
		f.settings.busy = false;
		await f.act({ kind: "next" });
		const before = f.core.record().decisions;
		await f.core.converse("同意，但这只是普通会话");
		expect(f.core.record().decisions).toEqual(before);
		expect(f.core.record().stage).toBe("requirements");
	}, 120_000);

	it("Back is adjacent, keeps all bytes, invalidates target and later decisions, and never starts a model", async () => {
		const f = await fixture();
		await expect(f.act({ kind: "back" })).rejects.toThrow();
		await f.through("st");
		const files = await Promise.all(
			[f.paths.business!, f.paths.solution, f.paths.plan, f.paths.report, f.spec].map(
				async file => [file, await fs.readFile(path.join(f.cwd, file), "utf8")] as const,
			),
		);
		const count = f.inputs.length;
		await f.act({ kind: "back" });
		expect(f.core.record().stage).toBe("executing");
		expect(f.core.record().report.development).toBeNull();
		expect((await f.core.inspect({ kind: "next" })).files).toContainEqual({
			path: f.paths.report,
			version: artifactVersion(report),
		});
		expect(f.core.record().decisions.map(item => item.stage)).toEqual([
			"business",
			"requirements",
			"solution",
			"planning",
		]);
		expect(f.inputs).toHaveLength(count);
		for (const [file, content] of files) expect(await fs.readFile(path.join(f.cwd, file), "utf8")).toBe(content);
		await f.act({ kind: "back" });
		expect(f.core.record().stage).toBe("planning");
		expect(f.core.record().decisions.map(item => item.stage)).toEqual(["business", "requirements", "solution"]);
	}, 120_000);

	it("keeps the original development approval when ST appends truthful failures to the same report", async () => {
		const f = await fixture();
		await f.through("st");
		const development = structuredClone(f.core.record().report.development);
		await f.write(f.paths.report, `${report}\n## ST测试\n命令未运行；环境缺失。已执行用例失败，待人员决定。\n`);
		await f.act({ kind: "mark", mark: "st-complete" }, "ST 有失败，已知风险仍确认交 PR");
		expect(f.core.record().stage).toBe("pr");
		expect(f.core.record().report.development).toEqual(development);
		expect(f.core.record().report.st?.version).not.toBe(
			development?.files.find(file => file.path === f.paths.report)?.version,
		);
		expect(f.core.record().marks["st-complete"]?.userReply).toBe("ST 有失败，已知风险仍确认交 PR");
	}, 120_000);
});

for (const [stage, file, malformed] of [
	["business", "business", "# 业务需求\n\n## 基本信息\n不完整。\n"],
	["requirements", "proposal", "not a proposal\n"],
	["requirements", "delta", "## ADDED Requirements\n### Requirement: Broken\nThe system SHALL work.\n"],
	["solution", "solution", '{"candidates":[]}'],
	["planning", "plan", " \n"],
	["executing", "report", "# 完成报告\n## 完成情况\n仅一节\n"],
] as const) {
	for (const failure of ["missing", "malformed"] as const) {
		it(`${stage} ${file} ${failure} leaves stage, approval and successor calls unchanged`, async () => {
			const f = await fixture();
			await f.through(stage);
			const target =
				file === "business"
					? f.paths.business!
					: file === "proposal"
						? f.paths.requirements[0]!
						: file === "delta"
							? f.spec
							: f.paths[file];
			if (failure === "missing") await fs.unlink(path.join(f.cwd, target));
			else await f.write(target, malformed);
			const before = f.core.record();
			const calls = f.inputs.length;
			await expect(f.act({ kind: "next" })).rejects.toThrow();
			expect(f.core.record().stage).toBe(before.stage);
			expect(f.core.record().decisions).toEqual(before.decisions);
			expect(f.inputs).toHaveLength(calls);
		}, 120_000);
	}
}

it("a successful seventh-stage archive is not terminal, Back preserves upstream approval and a new legal revision can synchronize", async () => {
	const f = await fixture();
	await f.through("st");
	await f.act({ kind: "mark", mark: "st-complete" });
	const inspected = await f.core.inspect({ kind: "sync-archive" });
	const first = await syncDevRequirement(
		{
			cwd: f.cwd,
			changeId: "sample-change",
			changeDirectory: f.store.changeDir,
			acceptedVersions: inspected.files,
			previous: null,
			operationId: "seventh-archive",
			onProgress: async () => {},
		},
		new AbortController().signal,
	);
	const archived = f.core.record();
	archived.syncRevisions.push(first);
	f.core.replaceRecord(archived);
	expect(f.core.record().stage).toBe("pr");
	expect(f.core.record().lifecycle).toBe("active");
	const development = f.core.record().report.development;
	const count = f.inputs.length;
	await f.act({ kind: "back" });
	expect(f.core.record().stage).toBe("st");
	expect(f.core.record().report.development).toEqual(development);
	expect(f.core.record().syncRevisions).toEqual([first]);
	expect(f.inputs).toHaveLength(count);
	await f.write(f.paths.report, `${report}\n## ST测试\n首次失败后重新执行，仍存在未验证平台。\n`);
	await f.act({ kind: "mark", mark: "st-complete" });
	for (const stage of ["st", "executing", "planning", "solution", "requirements"] as const) {
		await f.act({ kind: "back" });
		expect(f.core.record().stage).toBe(stage);
	}
	const archive = first.archivedChangePath!;
	await f.write(
		`${archive}/specs/sample/spec.md`,
		delta
			.replace("## ADDED Requirements", "## MODIFIED Requirements")
			.replace("preserve sample behavior", "preserve revised sample behavior"),
	);
	await f.through("st");
	await f.act({ kind: "mark", mark: "st-complete" });
	const revised = await f.core.inspect({ kind: "sync-archive" });
	const second = await syncDevRequirement(
		{
			cwd: f.cwd,
			changeId: "sample-change",
			changeDirectory: archive,
			acceptedVersions: revised.files,
			previous: first,
			operationId: "seventh-resync",
			onProgress: async () => {},
		},
		new AbortController().signal,
	);
	expect(second.archivedChangePath).toBe(archive);
	expect(await fs.readFile(path.join(f.cwd, "openspec/specs/sample/spec.md"), "utf8")).toContain(
		"preserve revised sample behavior",
	);
	await expect(fs.stat(path.join(f.cwd, f.store.changeDir))).rejects.toMatchObject({ code: "ENOENT" });
	expect(f.core.record().stage).toBe("pr");
}, 120_000);

it("keeps observed merge facts distinct from human marks and becomes business-read-only only after tested", async () => {
	const f = await fixture();
	await f.through("st");
	await f.act({ kind: "mark", mark: "st-complete" });
	await expect(f.act({ kind: "next" })).rejects.toThrow();
	await expect(f.act({ kind: "mark", mark: "pr-merged" })).rejects.toThrow();
	await f.act({ kind: "mark", mark: "pr-submitted" }, "人员已提交 PR");
	expect(f.core.record().stage).toBe("pr");
	expect(f.core.record().marks["pr-merged"]).toBeUndefined();
	await expect(f.act({ kind: "mark", mark: "pr-merged" })).rejects.toThrow();
	const observed = f.core.record();
	observed.pr = {
		pr: {
			forge: "github",
			repository: "fixture/repo",
			number: 1,
			url: "https://example.invalid/pr/1",
			sourceRef: "main",
			baseRef: "release",
		},
		state: "merged",
		headSha: "a".repeat(40),
		baseSha: "b".repeat(40),
		mergeSha: "c".repeat(40),
		observedAt: "2026-11-07T12:00:00.000Z",
	};
	f.core.replaceRecord(observed);
	expect(f.core.record().stage).toBe("pr");
	await f.act({ kind: "mark", mark: "pr-merged" }, "人员确认这个 PR 已真实合入");
	expect(f.core.record().stage).toBe("testing");
	await expect(f.act({ kind: "back" })).rejects.toThrow();
	await f.act({ kind: "set-test-state", state: "failed" });
	expect(f.core.record().testing).toBe("failed");
	await f.act({ kind: "link-fix", fixRequirementId: "related-fix" });
	expect(f.core.record().relatedRequirementIds).toEqual(["related-fix"]);
	await f.act({ kind: "set-test-state", state: "retest-pending" });
	expect(f.core.record().testing).toBe("retest-pending");
	await f.act({ kind: "mark", mark: "tested" }, "人员确认已测试，失败和限制已知");
	expect(f.core.record().lifecycle).toBe("completed");
	expect(f.core.record().marks.tested?.userReply).toBe("人员确认已测试，失败和限制已知");
	for (const intent of [
		{ kind: "back" },
		{ kind: "next" },
		{ kind: "commit" },
		{ kind: "set-test-state", state: "failed" },
		{ kind: "link-fix", fixRequirementId: "later-fix" },
	] satisfies DevActionIntent[]) {
		await expect(f.core.inspect(intent)).rejects.toThrow();
	}
	await expect(f.core.converse("修复旧需求")).rejects.toThrow();
}, 120_000);

it("ST cannot rewrite the original development conclusion under the name of a test update", async () => {
	const f = await fixture();
	await f.through("st");
	const before = f.core.record();
	await f.write(
		f.paths.report,
		report.replace("实现批准范围。", "改为实现另一未经确认范围。") + "\n## ST测试\n测试完成。\n",
	);
	await expect(f.act({ kind: "mark", mark: "st-complete" })).rejects.toThrow();
	expect(f.core.record().stage).toBe("st");
	expect(f.core.record().report.development).toEqual(before.report.development);
	expect(f.core.record().marks["st-complete"]).toBeUndefined();
	expect(f.core.record().decisions).toEqual(before.decisions);
}, 120_000);

it("unsettled native synchronization facts block Back and approvals without deleting real materials", async () => {
	const f = await fixture();
	await f.through("st");
	await f.act({ kind: "mark", mark: "st-complete" });
	const before = f.core.record();
	const main = "openspec/specs/sample/spec.md";
	await f.write(main, "native write awaiting explicit recovery");
	before.syncRevisions.push({
		operationId: "partial-sync",
		files: [],
		mainSpecs: [{ path: main, version: artifactVersion("native write awaiting explicit recovery") }],
		archivedChangePath: null,
		progress: { synced: false, sideEffects: { paths: [main], diagnostic: "Native rollback incomplete" } },
	});
	f.core.replaceRecord(before);
	for (const intent of [
		{ kind: "back" },
		{ kind: "sync-archive" },
		{ kind: "mark", mark: "pr-submitted" },
	] satisfies DevActionIntent[]) {
		await expect(f.core.inspect(intent)).rejects.toThrow();
	}
	expect(f.core.record()).toEqual(before);
	expect(await fs.readFile(path.join(f.cwd, main), "utf8")).toBe("native write awaiting explicit recovery");
	expect(await fs.readFile(path.join(f.cwd, f.paths.report), "utf8")).toBe(report);
}, 120_000);

it("explicit implementation repair invalidates old report eligibility across a cold record reload without erasing original approval", async () => {
	const f = await fixture();
	await f.through("st");
	const approval = structuredClone(f.core.record().report.development);
	await f.core.beginRepair();
	expect(f.core.record().stage).toBe("executing");
	expect(f.core.record().decisions.some(decision => decision.stage === "executing")).toBe(false);
	expect(f.core.record().report.development).toEqual(approval);
	await expect(f.core.inspect({ kind: "next" })).rejects.toThrow();
	const cold = new SpecDrivenOrchestrator(f.ports, {
		record: f.core.record(),
		paths: f.paths,
		getUseTeam: () => false,
		persist: async () => {},
	});
	await expect(cold.inspect({ kind: "next" })).rejects.toThrow();
	const revised = report.replace("实现批准范围。", "实现批准范围，并修复本轮已知错误。");
	await f.write(f.paths.report, revised);
	expect((await cold.inspect({ kind: "next" })).files).toContainEqual({
		path: f.paths.report,
		version: artifactVersion(revised),
	});
	expect(cold.record().report.development).toEqual(approval);
}, 120_000);

it("a scoped business draft commit is not Next, template approval or a model handoff", async () => {
	const f = await fixture();
	const draft = "# 业务草稿\n\n尚未完成十章节，不伪造交接。\n";
	await f.write(f.paths.business!, draft);
	const current = f.core.record();
	current.materials = current.materials
		.filter(file => file.kind === "business")
		.map(file => ({ ...file, version: artifactVersion(draft) }));
	f.core.replaceRecord(current);
	const inspected = await f.core.inspect({ kind: "commit" });
	const decision: DevDecision = {
		operationId: "commit-business-draft",
		stage: "business",
		actor: { name: "人员", source: "local" },
		at: "2026-11-07T12:00:00.000Z",
		userReply: "仅提交本轮业务草稿，不批准材料",
		files: inspected.files,
	};
	const next = await f.core.decide(current, { kind: "commit" }, decision);
	expect(next).toEqual(current);
	expect(next.stage).toBe("business");
	expect(next.decisions).toEqual([]);
	expect(f.inputs).toEqual([]);
	expect(f.refs).toEqual({});
	await expect(f.core.inspect({ kind: "next" })).rejects.toThrow();
	expect(await fs.readFile(path.join(f.cwd, f.paths.business!), "utf8")).toBe(draft);
}, 120_000);

it("an execution batch commit cannot substitute for fifth-stage report acceptance", async () => {
	const f = await fixture();
	await f.through("executing");
	await f.write("src/batch.ts", "export const implementedBatch = 1;\n");
	const reportDraft = "# 完成报告\n\n尚在执行，没有完整交付报告。\n";
	await f.write(f.paths.report, reportDraft);
	const current = f.core.record();
	current.materials = current.materials.map(file =>
		file.kind === "report" ? { ...file, version: artifactVersion(reportDraft) } : file,
	);
	f.core.replaceRecord(current);
	const calls = f.inputs.length;
	const inspected = await f.core.inspect({ kind: "commit" });
	const decision: DevDecision = {
		operationId: "commit-execution-batch",
		stage: "executing",
		actor: { name: "人员", source: "local" },
		at: "2026-11-07T12:00:00.000Z",
		userReply: "只提交当前实现批次，继续执行",
		files: inspected.files,
	};
	expect(await f.core.decide(current, { kind: "commit" }, decision)).toEqual(current);
	expect(f.core.record().stage).toBe("executing");
	expect(f.core.record().report.development).toBeNull();
	expect(f.core.record().decisions.map(item => item.stage)).toEqual([
		"business",
		"requirements",
		"solution",
		"planning",
	]);
	expect(f.inputs).toHaveLength(calls);
	await expect(f.core.inspect({ kind: "next" })).rejects.toThrow();
	expect(await fs.readFile(path.join(f.cwd, "src/batch.ts"), "utf8")).toBe("export const implementedBatch = 1;\n");
}, 120_000);

it("a testing commit carries no business-code or material authorization and does not replace the human tested mark", async () => {
	const f = await fixture();
	await f.through("st");
	await f.act({ kind: "mark", mark: "st-complete" });
	await f.act({ kind: "mark", mark: "pr-submitted" });
	const observed = f.core.record();
	observed.pr = {
		pr: {
			forge: "github",
			repository: "fixture/repo",
			number: 2,
			url: "https://example.invalid/pr/2",
			sourceRef: "main",
			baseRef: "release",
		},
		state: "merged",
		headSha: "d".repeat(40),
		baseSha: "e".repeat(40),
		mergeSha: "f".repeat(40),
		observedAt: "2026-11-07T12:00:00.000Z",
	};
	f.core.replaceRecord(observed);
	await f.act({ kind: "mark", mark: "pr-merged" });
	await f.write("src/unrelated.ts", "must not enter this testing commit\n");
	const current = f.core.record();
	const calls = f.inputs.length;
	const inspected = await f.core.inspect({ kind: "commit" });
	expect(inspected.files).toEqual([]);
	const decision: DevDecision = {
		operationId: "commit-testing-record",
		stage: "testing",
		actor: { name: "人员", source: "local" },
		at: "2026-11-07T12:00:00.000Z",
		userReply: "仅同步自身测试状态记录，不标记已测试",
		files: inspected.files,
	};
	expect(await f.core.decide(current, { kind: "commit" }, decision)).toEqual(current);
	expect(f.core.record().stage).toBe("testing");
	expect(f.core.record().lifecycle).toBe("active");
	expect(f.core.record().marks.tested).toBeUndefined();
	expect(f.inputs).toHaveLength(calls);
}, 120_000);

it("Back and implementation repair retain commit history without treating commit replies as stage approvals", async () => {
	const f = await fixture();
	await f.through("solution");
	const addCommitHistory = (stage: "solution" | "executing", operationId: string) => {
		const current = f.core.record();
		const decision: DevDecision = {
			operationId,
			stage,
			actor: { name: "人员", source: "local" },
			at: "2026-11-07T12:00:00.000Z",
			userReply: "仅提交当前批次，不选择方案或验收交付",
			files: [],
		};
		current.decisions.push(decision);
		current.gitOperations.push({
			operationId,
			kind: "commit",
			actor: decision.actor,
			at: decision.at,
			files: [],
			target: {
				localSourceRef: "refs/heads/main",
				sourceRepository: "fixture/repo",
				sourceRef: "main",
				baseRepository: "fixture/repo",
				baseRef: "release",
				remote: "fixture",
				remoteUrl: "file:///isolated-fixture",
				targetRef: "refs/heads/main",
				observedTip: null,
			},
			authorizedCommits: [],
			knownCommitShas: [],
		});
		f.core.replaceRecord(current);
		return decision;
	};
	const solutionCommit = addCommitHistory("solution", "historical-solution-commit");
	expect(f.core.save().approvals.solution).toBeUndefined();
	expect(f.core.status().selection).toBeUndefined();
	await f.act({ kind: "next" });
	expect(f.inputs.at(-1)?.candidateId).toBe("one");
	expect(f.inputs.at(-1)?.userReply).not.toBe(solutionCommit.userReply);
	await f.act({ kind: "back" });
	expect(f.core.record().decisions).toContainEqual(solutionCommit);
	expect(f.core.save().approvals.solution).toBeUndefined();
	expect(f.core.status().selection).toBeUndefined();
	await f.through("st");
	const executionCommit = addCommitHistory("executing", "historical-execution-commit");
	await f.core.beginRepair();
	expect(f.core.record().stage).toBe("executing");
	expect(f.core.record().decisions).toContainEqual(solutionCommit);
	expect(f.core.record().decisions).toContainEqual(executionCommit);
	expect(f.core.save().approvals.executor).toBeUndefined();
	expect(f.core.record().gitOperations.map(operation => operation.operationId)).toEqual([
		solutionCommit.operationId,
		executionCommit.operationId,
	]);
}, 120_000);

it("Next cannot replace the person's inspected material version with bytes changed before its core save", async () => {
	const f = await fixture();
	const intent = { kind: "next" } as const;
	const inspected = await f.core.inspect(intent);
	const decision: DevDecision = {
		operationId: "changed-before-next-save",
		stage: "business",
		actor: { name: "人员", source: "local" },
		at: "2026-11-07T12:00:00.000Z",
		userReply: "只批准预览中的原始字节",
		files: inspected.files,
	};
	await f.write(f.paths.business!, `${business}\n预览之后、核心保存之前的新字节。\n`);
	await expect(f.core.execute(intent, decision)).rejects.toThrow();
	expect(f.core.record().stage).toBe("business");
	expect(f.core.record().decisions).toEqual([]);
	expect(f.persisted).toEqual([]);
	expect(f.inputs).toEqual([]);
}, 120_000);

it("an otherwise legal ST append still requires a fresh human material confirmation when it races the mark", async () => {
	const f = await fixture();
	await f.through("st");
	const before = f.core.record();
	const intent = { kind: "mark", mark: "st-complete" } as const;
	const inspected = await f.core.inspect(intent);
	const decision: DevDecision = {
		operationId: "changed-before-st-mark",
		stage: "st",
		actor: { name: "人员", source: "local" },
		at: "2026-11-07T12:00:00.000Z",
		userReply: "只确认预览中的 ST 报告",
		files: inspected.files,
	};
	await f.write(f.paths.report, `${report}\n## ST测试\n预览之后追加的实际失败结果。\n`);
	await expect(f.core.decide(before, intent, decision)).rejects.toThrow();
	expect(f.core.record()).toEqual(before);
	expect(f.core.record().marks["st-complete"]).toBeUndefined();
	const fresh = await f.core.inspect(intent);
	expect(fresh.files).not.toEqual(inspected.files);
	const freshReport = fresh.files.find(file => file.path === f.paths.report);
	if (!freshReport) throw new Error("Expected the inspected ST report version");
	expect(
		(await f.core.decide(before, intent, { ...decision, operationId: "fresh-st-mark", files: fresh.files })).report
			.st,
	).toEqual(freshReport);
}, 120_000);
