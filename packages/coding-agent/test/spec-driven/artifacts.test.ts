import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	SpecArtifactStore,
	containedSpecPath,
	specPatchVersion,
	type SpecPatch,
	type SpecPatchApproval,
	type SpecSourceMap,
} from "../../src/spec-driven/artifacts";
import { createSpecPairedReport, summarizeSpecRun, type SpecRunMeasurement } from "../../src/spec-driven/metrics";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-artifact-"));
	roots.push(cwd);
	await fs.mkdir(path.join(cwd, "requirements"));
	const store = new SpecArtifactStore({
		cwd,
		changeId: "change-one",
		requirementsDir: "requirements",
		checkPaths: ["checks/review.json"],
	});
	await store.writeRequirements({
		proposal: "# Why\n\nA real change.\n",
		specs: [
			{
				path: "specs/sample/spec.md",
				content:
					"## ADDED Requirements\n### Requirement: Sample\nSHALL work.\n#### Scenario: Works\n- **WHEN** used\n- **THEN** works\n",
			},
		],
	});
	return { cwd, store };
}
async function approval(
	store: SpecArtifactStore,
	map: SpecSourceMap,
	patches: SpecPatch[],
): Promise<SpecPatchApproval> {
	return {
		accepted: true,
		authorized: true,
		requirementsVersion: (await store.readRequirements()).version,
		sourceMapVersion: map.version,
		patchVersion: specPatchVersion(patches),
		reviewer: "independent-review",
		reviewEvidence: "artifact://review-with-scenario-preservation",
		coveredSourceIds: map.entries.map(entry => entry.id),
	};
}
describe("specification authority and exact patches", () => {
	test("only writes requirements and the single content-versioned plan", async () => {
		const { store, cwd } = await fixture();
		await expect(
			store.writeRequirements({ proposal: "must not publish", specs: [{ path: "design.md", content: "design" }] }),
		).rejects.toThrow();
		expect((await store.readRequirements()).proposal.content).toContain("A real change");
		const first = await store.writePlan("# Plan\nTask T001\n");
		const second = await store.writePlan("# Plan\nTask T001 revised\n");
		expect(first.path).toBe("openspec/changes/change-one/plan.md");
		expect(first.version).not.toBe(second.version);
		expect(await fs.readFile(path.join(cwd, second.path), "utf8")).toBe(second.content);
		await expect(
			store.writeRequirements({ proposal: "x", specs: [], checks: [{ path: "../escape.md", content: "bad" }] }),
		).rejects.toThrow();
	});
	test("rejects lexical escapes and symlink/junction escapes before any write", async () => {
		const { cwd, store } = await fixture();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-outside-"));
		roots.push(outside);
		await fs.symlink(outside, path.join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
		await expect(containedSpecPath(cwd, "../escape.md")).rejects.toThrow();
		await expect(containedSpecPath(cwd, "escape/new.md")).rejects.toThrow();
		const unsafe = new SpecArtifactStore({ cwd, changeId: "other-change", changeDir: "escape/change" });
		await expect(unsafe.writePlan("must not escape")).rejects.toThrow();
		expect(await fs.readdir(outside)).toEqual([]);
		expect((await store.readRequirements()).proposal.content).toContain("A real change");
	});
	test("preserves unrelated bytes/scenarios through add, modify, section removal and file rename", async () => {
		const { cwd, store } = await fixture();
		const original =
			"# Product\r\n\r\n## AC-01 Keep\r\nunchanged scenario\r\n\r\n## AC-02 Change\r\nold scenario\r\n\r\n## AC-03 Remove\r\nobsolete\r\n";
		await fs.writeFile(path.join(cwd, "requirements/product.md"), original);
		await fs.writeFile(path.join(cwd, "requirements/rename.md"), "# Rename\nscenario preserved\n");
		const map = await store.prepareSourceMap();
		const changed = map.entries.find(entry => entry.headingPath.at(-1) === "AC-02 Change")!;
		const removed = map.entries.find(entry => entry.headingPath.at(-1) === "AC-03 Remove")!;
		const renamed = map.entries.find(entry => entry.path.endsWith("rename.md"))!;
		const patches: SpecPatch[] = [
			{
				operation: "modify",
				sourceId: changed.id,
				replacement: changed.original.replace("old scenario", "new scenario"),
			},
			{ operation: "remove", sourceId: removed.id, replacement: "" },
			{
				operation: "rename",
				sourceId: renamed.id,
				destinationPath: "requirements/renamed.md",
				replacement: renamed.original,
			},
			{ operation: "add", path: "requirements/new.md", content: "# New\nnew scenario\n" },
		];
		await store.applySpecChanges(patches, map, await approval(store, map, patches));
		expect(await fs.readFile(path.join(cwd, "requirements/product.md"), "utf8")).toBe(
			original.slice(0, changed.start) + changed.original.replace("old scenario", "new scenario"),
		);
		expect(await fs.readFile(path.join(cwd, "requirements/renamed.md"), "utf8")).toBe(renamed.original);
		await expect(fs.stat(path.join(cwd, "requirements/rename.md"))).rejects.toThrow();
		expect(await fs.readFile(path.join(cwd, "requirements/new.md"), "utf8")).toContain("new scenario");
	});
	test("rejects stale, ambiguous, partially reviewed and overlapping changes without publishing any file", async () => {
		const { cwd, store } = await fixture();
		const file = path.join(cwd, "requirements/main.md");
		await fs.writeFile(file, "# Product\n## AC-01 One\nscenario\n");
		const map = await store.prepareSourceMap();
		const child = map.entries[1]!;
		const patches: SpecPatch[] = [
			{ operation: "modify", sourceId: child.id, replacement: "## AC-01 One\nnew scenario\n" },
			{ operation: "add", path: "requirements/new.md", content: "# New\n" },
		];
		const approved = await approval(store, map, patches);
		await expect(store.applySpecChanges(patches, map, { ...approved, coveredSourceIds: [] })).rejects.toThrow();
		await expect(fs.stat(path.join(cwd, "requirements/new.md"))).rejects.toThrow();
		await fs.appendFile(file, "user change\n");
		await expect(store.applySpecChanges(patches, map, approved)).rejects.toThrow("changed");
		expect(await fs.readFile(file, "utf8")).toContain("user change");
		await fs.writeFile(file, "# Product\n## Same\none\n## Same\ntwo\n");
		await expect(store.prepareSourceMap()).rejects.toThrow("Ambiguous");
	});
	test("preflights all files in a failed multi-file operation", async () => {
		const { cwd, store } = await fixture();
		await fs.writeFile(path.join(cwd, "requirements/a.md"), "# A\noriginal\n");
		await fs.mkdir(path.join(cwd, "requirements/blocked.md"));
		const map = await store.prepareSourceMap(["requirements/a.md"]);
		const patches: SpecPatch[] = [
			{ operation: "modify", sourceId: map.entries[0]!.id, replacement: "# A\nchanged\n" },
			{ operation: "add", path: "requirements/blocked.md", content: "# Blocked\n" },
		];
		await expect(store.applySpecChanges(patches, map, await approval(store, map, patches))).rejects.toThrow();
		expect(await fs.readFile(path.join(cwd, "requirements/a.md"), "utf8")).toBe("# A\noriginal\n");
	});
	test("requires current final acceptance before native sync/archive", async () => {
		const { store } = await fixture();
		await expect(store.archive({ accepted: true, authorized: true, requirementsVersion: "stale" })).rejects.toThrow(
			"stale",
		);
	});
});
test("real OpenSpec native archive retains the plan and failed native sync preserves originals", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-native-close-"));
	roots.push(cwd);
	const store = new SpecArtifactStore({ cwd, changeId: "native-change" });
	await store.initialize();
	const proposal =
		"# Native change\n\n## Why\n\nAdd observable sample behavior.\n\n## What Changes\n\n- Add a sample requirement.\n\n## Capabilities\n\n### New Capabilities\n\n- `sample`: Sample behavior.\n\n## Impact\n\nSpecification only.\n";
	const delta =
		"## ADDED Requirements\n\n### Requirement: Sample behavior\nThe system SHALL return a sample result when requested.\n\n#### Scenario: Sample requested\n- **WHEN** a caller requests a sample\n- **THEN** the system returns a sample result\n";
	await store.writeRequirements({ proposal, specs: [{ path: "specs/sample/spec.md", content: delta }] });
	await store.writePlan("# Approved plan\n\nTask T001: specification-only change.\n");
	const accepted = {
		accepted: true as const,
		authorized: true as const,
		requirementsVersion: (await store.readRequirements()).version,
	};
	const result = await store.archive(accepted);
	expect(await fs.readFile(path.join(cwd, result.archivePath, "plan.md"), "utf8")).toContain("Task T001");
	expect(await fs.readFile(path.join(cwd, "openspec/specs/sample/spec.md"), "utf8")).toContain("Sample behavior");
	const failed = new SpecArtifactStore({ cwd, changeId: "failed-change" });
	await failed.initialize();
	await failed.writeRequirements({
		proposal,
		specs: [
			{
				path: "specs/sample/spec.md",
				content:
					"## MODIFIED Requirements\n\n### Requirement: Missing original\nThe system SHALL reject an update without a matching original requirement.\n\n#### Scenario: Missing source\n- **WHEN** the requirement is absent\n- **THEN** merging is rejected\n",
			},
		],
	});
	await failed.writePlan("# Approved plan\n\nTask T002.\n");
	const original = await fs.readFile(path.join(cwd, "openspec/specs/sample/spec.md"), "utf8");
	await expect(
		failed.archive({
			accepted: true,
			authorized: true,
			requirementsVersion: (await failed.readRequirements()).version,
		}),
	).rejects.toThrow();
	expect(await fs.readFile(path.join(cwd, "openspec/specs/sample/spec.md"), "utf8")).toBe(original);
	expect((await failed.readPlan()).content).toContain("Task T002");
});
async function nativeFixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-native-modes-"));
	roots.push(cwd);
	const store = new SpecArtifactStore({ cwd, changeId: "native-change" });
	await store.initialize();
	await store.writeRequirements({
		proposal:
			"# Native change\n\n## Why\n\nAdd observable sample behavior.\n\n## What Changes\n\n- Add sample behavior.\n\n## Capabilities\n\n### New Capabilities\n\n- `sample`: Sample behavior.\n\n## Impact\n\nSpecification only.\n",
		specs: [
			{
				path: "specs/sample/spec.md",
				content:
					"## ADDED Requirements\n\n### Requirement: Sample behavior\nThe system SHALL return a sample result when requested.\n\n#### Scenario: Sample requested\n- **WHEN** a caller requests a sample\n- **THEN** the system returns a sample result\n",
			},
		],
	});
	const plan = await store.writePlan("# Approved plan\n\nTask T001: specification-only change.\n");
	const accepted = {
		accepted: true as const,
		authorized: true as const,
		requirementsVersion: (await store.readRequirements()).version,
	};
	return { cwd, store, plan, accepted };
}
async function tree(root: string, prefix = ""): Promise<Array<[string, string]>> {
	const result: Array<[string, string]> = [];
	for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
		const name = path.join(prefix, entry.name);
		result.push([name, entry.isDirectory() ? "<directory>" : await fs.readFile(path.join(root, name), "utf8")]);
		if (entry.isDirectory()) result.push(...(await tree(root, name)));
	}
	return result.sort(([a], [b]) => a.localeCompare(b));
}
describe("independently authorized real upstream closure", () => {
	test("native sync-only publishes upstream master semantics without moving any change material", async () => {
		const { cwd, store, plan, accepted } = await nativeFixture();
		const before = await tree(path.join(cwd, store.changeDir));
		await store.sync(accepted);
		expect(await fs.readFile(path.join(cwd, "openspec/specs/sample/spec.md"), "utf8")).toContain(
			"### Requirement: Sample behavior",
		);
		expect(await tree(path.join(cwd, store.changeDir))).toEqual(before);
		expect((await store.readPlan()).version).toBe(plan.version);
		await expect(fs.stat(path.join(cwd, "openspec/changes/archive"))).rejects.toThrow();
	});
	test("native archive-only uses upstream skip-specs and preserves masters byte-for-byte", async () => {
		const { cwd, store, plan, accepted } = await nativeFixture();
		await fs.mkdir(path.join(cwd, "openspec/specs/sample"), { recursive: true });
		const original = "# Existing authority\r\n\r\nDo not synchronize this document.\r\n";
		await fs.writeFile(path.join(cwd, "openspec/specs/sample/spec.md"), original);
		const before = await tree(path.join(cwd, "openspec/specs"));
		const result = await store.archive(accepted, undefined, undefined, { sync: false });
		expect(await tree(path.join(cwd, "openspec/specs"))).toEqual(before);
		expect(await fs.readFile(path.join(cwd, result.archivePath, "plan.md"), "utf8")).toBe(plan.content);
		await expect(fs.stat(path.join(cwd, store.changeDir))).rejects.toThrow();
	});
	test("native combined closure publishes the real master and approved archived plan", async () => {
		const { cwd, store, plan, accepted } = await nativeFixture();
		const result = await store.archive(accepted);
		expect(await fs.readFile(path.join(cwd, "openspec/specs/sample/spec.md"), "utf8")).toContain("Sample behavior");
		expect(await fs.readFile(path.join(cwd, result.archivePath, "plan.md"), "utf8")).toBe(plan.content);
		await expect(fs.stat(path.join(cwd, store.changeDir))).rejects.toThrow();
	});
	test("upstream merge rejection and stale approvals leave all original files and directories unchanged", async () => {
		const { cwd, store, accepted } = await nativeFixture();
		await store.writeRequirements({
			proposal: (await store.readRequirements()).proposal.content,
			specs: [
				{
					path: "specs/sample/spec.md",
					content:
						"## MODIFIED Requirements\n\n### Requirement: Missing original\nThe system SHALL reject missing source requirements.\n\n#### Scenario: Absent requirement\n- **WHEN** no original exists\n- **THEN** merging fails\n",
				},
			],
		});
		const before = await tree(cwd);
		await expect(store.sync(accepted)).rejects.toThrow("stale");
		await expect(store.archive(accepted, undefined, undefined, { sync: false })).rejects.toThrow("stale");
		const current = { ...accepted, requirementsVersion: (await store.readRequirements()).version };
		await expect(store.sync(current)).rejects.toThrow();
		expect(await tree(cwd)).toEqual(before);
		await expect(store.archive(current)).rejects.toThrow();
		expect(await tree(cwd)).toEqual(before);
	});
	test("linked native trees are rejected without publishing master or archive material", async () => {
		const { cwd, store, accepted } = await nativeFixture();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-linked-"));
		roots.push(outside);
		await fs.symlink(outside, path.join(cwd, "openspec/linked"), process.platform === "win32" ? "junction" : "dir");
		await expect(store.sync(accepted)).rejects.toThrow("Linked");
		await expect(store.archive(accepted, undefined, undefined, { sync: false })).rejects.toThrow("Linked");
		expect(await fs.readdir(outside)).toEqual([]);
		expect((await store.readPlan()).content).toContain("Task T001");
	});
	test("Markdown sync-only applies reviewed exact patches while archive-only cannot apply them", async () => {
		const { cwd, store } = await fixture();
		const plan = await store.writePlan("# Approved Markdown plan\n");
		const original = "# Product\r\n\r\n## AC-01 Behavior\r\nold scenario\r\n";
		const file = path.join(cwd, "requirements/product.md");
		await fs.writeFile(file, original);
		const sourceMap = await store.prepareSourceMap();
		const entry = sourceMap.entries.find(item => item.headingPath.at(-1) === "AC-01 Behavior")!;
		const patches: SpecPatch[] = [
			{
				operation: "modify",
				sourceId: entry.id,
				replacement: entry.original.replace("old scenario", "new scenario"),
			},
		];
		const markdown = { patches, sourceMap, approval: await approval(store, sourceMap, patches) };
		const accepted = {
			accepted: true as const,
			authorized: true as const,
			requirementsVersion: (await store.readRequirements()).version,
		};
		const before = await tree(cwd);
		await expect(store.archive(accepted, undefined, markdown, { sync: false })).rejects.toThrow("Archive-only");
		expect(await tree(cwd)).toEqual(before);
		await expect(
			store.sync(accepted, undefined, { ...markdown, approval: { ...markdown.approval, patchVersion: "stale" } }),
		).rejects.toThrow("stale");
		expect(await tree(cwd)).toEqual(before);
		await store.sync(accepted, undefined, markdown);
		expect(await fs.readFile(file, "utf8")).toBe(original.replace("old scenario", "new scenario"));
		expect((await store.readPlan()).version).toBe(plan.version);
		await expect(fs.stat(path.join(cwd, "openspec/changes/archive"))).rejects.toThrow();
		const result = await store.archive(accepted, undefined, undefined, { sync: false });
		expect(await fs.readFile(file, "utf8")).toBe(original.replace("old scenario", "new scenario"));
		expect(await fs.readFile(path.join(cwd, result.archivePath, "plan.md"), "utf8")).toBe(plan.content);
	});
	test("Markdown combined closure rechecks reviewed patch versions before upstream publication", async () => {
		const { cwd, store } = await fixture();
		await store.writePlan("# Approved plan\n");
		const file = path.join(cwd, "requirements/product.md");
		await fs.writeFile(file, "# Product\nold scenario\n");
		const sourceMap = await store.prepareSourceMap();
		const patches: SpecPatch[] = [
			{ operation: "modify", sourceId: sourceMap.entries[0]!.id, replacement: "# Product\nnew scenario\n" },
		];
		const markdown = { patches, sourceMap, approval: await approval(store, sourceMap, patches) };
		const accepted = {
			accepted: true as const,
			authorized: true as const,
			requirementsVersion: (await store.readRequirements()).version,
		};
		await fs.appendFile(file, "user change\n");
		const before = await tree(cwd);
		await expect(store.archive(accepted, undefined, markdown)).rejects.toThrow("changed");
		expect(await tree(cwd)).toEqual(before);
		await fs.writeFile(file, sourceMap.files[0]!.content);
		const result = await store.archive(accepted, undefined, markdown);
		expect(await fs.readFile(file, "utf8")).toBe("# Product\nnew scenario\n");
		expect(await fs.readFile(path.join(cwd, result.archivePath, "plan.md"), "utf8")).toBe("# Approved plan\n");
		await expect(fs.stat(path.join(cwd, "openspec/specs"))).rejects.toThrow();
	});
});
test("paired reports preserve unknown costs and unassessed findings rather than invented zeros", () => {
	const baseline: SpecRunMeasurement = {
		task: "same-task",
		codeBaseline: "same-head",
		modelConfiguration: "same-model",
		acceptanceCriteria: "same-criteria",
		mode: "baseline",
		startedAt: 10,
		endedAt: 100,
		requests: [
			{
				id: "actual-request",
				node: "implementation",
				model: "provider/model",
				startedAt: 20,
				endedAt: 80,
				inputTokens: 123,
				outputTokens: 45,
				cacheReadTokens: null,
				cacheWriteTokens: null,
				cost: null,
				evidence: "session://request",
			},
		],
		observations: [],
		plannedDecisionWaitMs: null,
		executionWaitMs: 60,
		assessmentComplete: false,
	};
	const report = createSpecPairedReport(baseline, { ...baseline, mode: "workflow" });
	expect(report.baselineSummary.unknownCostRequests).toBe(1);
	expect(report.workflowSummary.costs).toEqual({});
	expect(report.workflowSummary.acceptedFindings.omission).toBeNull();
	expect(report.workflowSummary.inputTokens).toBe(123);
	expect(
		summarizeSpecRun({
			...baseline,
			observations: [
				{
					id: "finding",
					kind: "human-correction",
					description: "Actual intervention",
					evidence: "review://finding",
					accepted: true,
				},
			],
		}).acceptedFindings["human-correction"],
	).toBe(1);
	expect(() => createSpecPairedReport(baseline, { ...baseline, mode: "workflow", codeBaseline: "other" })).toThrow(
		"Unpaired",
	);
});
