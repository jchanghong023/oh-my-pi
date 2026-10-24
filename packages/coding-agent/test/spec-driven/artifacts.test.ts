import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
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
import type { SpecPlanDraft } from "../../src/spec-driven/types";

const requirementDocument = {
	path: "requirements.md",
	content:
		"# Requirements\r\n\r\n## Background and goal\r\nReturn a sample result.\r\n\r\n## Scope\r\nSample capability only; no unrelated migration.\r\n\r\n## Constraints\r\nPreserve existing scenarios.\r\n\r\n## R1 Sample\r\nThe public entry SHALL return the sample result.\r\n\r\n### Acceptance scenario\r\nWHEN requested, THEN return the sample result.\r\n\r\n## Decisions and references\r\nReuse the existing public entry.\r\n",
};
function formalPlan(content: string): SpecPlanDraft {
	return {
		content,
		workspace: { executionPath: ".", isolation: "native", integration: "native" },
		tasks: [
			{
				id: "T001",
				title: "Preserve sample behavior",
				instructions: "Review the sample specification.",
				requirementIds: ["R1"],
				dependencies: [],
				conditionIds: [],
				ownedPaths: ["requirements"],
				implementationPaths: [],
				solutionBinding: "existing public entry",
				validation: [
					{
						id: "review",
						command: "review specification",
						behavior: "Sample scenario is preserved",
						inputPaths: ["requirements"],
					},
				],
				tdd: {
					mode: "exception",
					reason: "Specification-only change",
					alternativeCommands: ["review specification"],
				},
			},
		],
		conditions: [],
		finalValidation: [
			{
				id: "entry",
				command: "review public entry contract",
				behavior: "Sample public contract is preserved",
				inputPaths: ["requirements"],
				realEntry: true,
			},
		],
		closure: { sync: true, archive: true },
	};
}
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
		document: requirementDocument,
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
			store.writeRequirements({
				document: requirementDocument,
				proposal: "must not publish",
				specs: [{ path: "design.md", content: "design" }],
			}),
		).rejects.toThrow();
		expect((await store.readRequirements()).proposal.content).toContain("A real change");
		const first = await store.writePlan(formalPlan("# Plan\nTask T001\n"));
		const second = await store.writePlan(formalPlan("# Plan\nTask T001 revised\n"));
		expect(first.path).toBe("openspec/changes/change-one/plan.md");
		expect(first.version).not.toBe(second.version);
		expect(await fs.readFile(path.join(cwd, second.path), "utf8")).toBe(second.content);
		await expect(
			store.writeRequirements({
				document: requirementDocument,
				proposal: "x",
				specs: [],
				checks: [{ path: "../escape.md", content: "bad" }],
			}),
		).rejects.toThrow();
	});
	test("publishes the formal requirements document verbatim and binds edits of every approval input", async () => {
		const { cwd, store } = await fixture();
		const documentPath = path.join(cwd, store.changeDir, "requirements.md");
		expect(await fs.readFile(documentPath, "utf8")).toBe(requirementDocument.content);
		const approved = await store.readRequirements();
		for (const [relative, replacement] of [
			["requirements.md", `${requirementDocument.content}\r\nChanged acceptance.\r\n`],
			["proposal.md", "# Changed proposal\n"],
			["specs/sample/spec.md", "## ADDED Requirements\nChanged scenario.\n"],
		]) {
			const file = path.join(cwd, store.changeDir, relative!);
			const original = await fs.readFile(file, "utf8");
			await fs.writeFile(file, replacement!);
			expect((await store.readRequirements()).version).not.toBe(approved.version);
			await fs.writeFile(file, original);
			expect((await store.readRequirements()).version).toBe(approved.version);
		}
	});
	test("rejects a caller-selected formal document path without publishing proposal or escaped bytes", async () => {
		const { cwd, store } = await fixture();
		const before = await store.readRequirements();
		await expect(
			store.writeRequirements({
				document: { path: "../escaped.md", content: "must not escape" },
				proposal: "must not replace approved proposal",
				specs: [],
			}),
		).rejects.toThrow();
		expect((await store.readRequirements()).version).toBe(before.version);
		await expect(fs.stat(path.join(cwd, "openspec/changes/escaped.md"))).rejects.toThrow();
	});
	test("renders coverage from structured tasks into the sole plan and versions actual body and coverage bytes", async () => {
		const { cwd, store } = await fixture();
		const draft = formalPlan("# Plan\n\nImplement the chosen interface.\n");
		draft.tasks[0]!.requirementIds = ["R1", "R3"];
		draft.tasks.push({ ...structuredClone(draft.tasks[0]!), id: "T002", requirementIds: ["R2", "R3"] });
		const plan = await store.writePlan(draft);
		expect(plan.content).toContain(draft.content);
		const rows = plan.content.split(/\r?\n/).filter(line => line.startsWith("|"));
		for (const [requirement, taskIds] of [
			["R1", ["T001"]],
			["R2", ["T002"]],
			["R3", ["T001", "T002"]],
		] as const) {
			const row = rows.find(line => line.includes(requirement));
			expect(row).toBeDefined();
			for (const id of taskIds) expect(row).toContain(id);
		}
		const file = path.join(cwd, plan.path);
		for (const content of [
			plan.content.replace("Implement the chosen interface.", "Implement an unapproved interface."),
			plan.content.replace(
				rows.find(line => line.includes("R3"))!,
				"| R3 | T999 |",
			),
		]) {
			await fs.writeFile(file, content);
			expect((await store.readPlan()).version).not.toBe(plan.version);
		}
		await expect(fs.stat(path.join(cwd, store.changeDir, "tasks.md"))).rejects.toThrow();
		await expect(fs.stat(path.join(cwd, store.changeDir, "design.md"))).rejects.toThrow();
	});
	test("persists the selected solution bytes, selection identity and conditions in solution.md", async () => {
		const { cwd, store } = await fixture();
		expect(await fs.readFile(path.join(cwd, store.changeDir, "requirements.md"), "utf8")).toBe(
			requirementDocument.content,
		);
		const solution = {
			specificationVersion: (await store.readRequirements()).version,
			runId: "discussion-1",
			candidateId: "A",
			candidateVersion: "candidate-v1",
			proposal: "# Selected design\r\n\r\n接口 `sample()` → result.  \r\nKeep exact ordering.\r\n",
			conditions: [{ id: "C1", description: "Keep compatibility", command: "check compatibility" }],
		};
		const saved = await store.writeSolution(solution);
		expect(saved.path).toBe(`${store.changeDir}/solution.md`);
		const bytes = await fs.readFile(path.join(cwd, saved.path), "utf8");
		expect(bytes).toContain(solution.proposal);
		for (const value of [
			solution.specificationVersion,
			solution.runId,
			solution.candidateId,
			solution.candidateVersion,
			"C1",
			"Keep compatibility",
			"check compatibility",
		])
			expect(bytes).toContain(value);
		expect((await store.readSolution()).content).toBe(bytes);
		await fs.appendFile(path.join(cwd, saved.path), "\nUnapproved design change.\n");
		expect((await store.readSolution()).version).not.toBe(saved.version);
	});
	test("rejects lexical escapes and symlink/junction escapes before any write", async () => {
		const { cwd, store } = await fixture();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-outside-"));
		roots.push(outside);
		await fs.symlink(outside, path.join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
		await expect(containedSpecPath(cwd, "../escape.md")).rejects.toThrow();
		await expect(containedSpecPath(cwd, "escape/new.md")).rejects.toThrow();
		const unsafe = new SpecArtifactStore({ cwd, changeId: "other-change", changeDir: "escape/change" });
		await expect(unsafe.writePlan(formalPlan("must not escape"))).rejects.toThrow();
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
	for (const existing of [true, false]) {
		test(`rollback preserves externally modified ${existing ? "existing" : "newly created"} A after B publication fails`, async () => {
			const { cwd, store } = await fixture();
			const a = path.join(cwd, "requirements/a.md");
			const b = path.join(cwd, "requirements/b.md");
			const original = "# A original recovery sentinel";
			const owned = "# A published recovery sentinel";
			const external = "# A external owner sentinel";
			const originalB = "# B original sentinel";
			if (existing) await fs.writeFile(a, original);
			await fs.writeFile(b, originalB);
			const map = await store.prepareSourceMap(
				existing ? ["requirements/a.md", "requirements/b.md"] : ["requirements/b.md"],
			);
			const patches: SpecPatch[] = [
				existing
					? {
							operation: "modify",
							sourceId: map.entries.find(entry => entry.path === "requirements/a.md")!.id,
							replacement: owned,
						}
					: { operation: "add", path: "requirements/a.md", content: owned },
				{
					operation: "modify",
					sourceId: map.entries.find(entry => entry.path === "requirements/b.md")!.id,
					replacement: "# B unpublished sentinel",
				},
			];
			const approved = await approval(store, map, patches);
			const canonicalB = await fs.realpath(b);
			const rename = nodeFs.promises.rename.bind(nodeFs.promises);
			let publishedA: string | undefined;
			let injected = false;
			// Observe the real atomic rename boundary; only B's first publication fails.
			// A's external write is real IO, after its owned bytes became visible.
			const fault = spyOn(nodeFs.promises, "rename").mockImplementation(async (source, destination) => {
				if (!injected && String(destination) === canonicalB && String(source).endsWith(".tmp")) {
					publishedA = await fs.readFile(a, "utf8");
					await fs.writeFile(a, external);
					injected = true;
					throw Object.assign(new Error("injected B publication IO failure"), { code: "EIO" });
				}
				return rename(source, destination);
			});
			let failure: unknown;
			try {
				await store.applySpecChanges(patches, map, approved);
			} catch (error) {
				failure = error;
			} finally {
				fault.mockRestore();
			}
			expect(injected).toBe(true);
			expect(publishedA).toBe(owned);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain("injected B publication IO failure");
			for (const content of [original, owned, external, originalB])
				expect((failure as Error).message).not.toContain(content);
			expect(await fs.readFile(a, "utf8")).toBe(external);
			expect(await fs.readFile(b, "utf8")).toBe(originalB);
			const describeFailure = (error: unknown): string =>
				error instanceof AggregateError
					? `${error.message}\n${error.errors.map(describeFailure).join("\n")}`
					: error instanceof Error
						? `${error.message}\n${error.cause ? describeFailure(error.cause) : ""}`
						: String(error);
			const diagnostic = describeFailure(failure);
			expect(diagnostic).toMatch(/partial|conflict|ownership/i);
			expect(diagnostic).toMatch(/recover/i);
			const recovery = (await tree(cwd))
				.filter(
					([name, content]) =>
						content !== "<directory>" &&
						!["requirements/a.md", "requirements/b.md"].includes(name.replaceAll(path.sep, "/")),
				)
				.map(([, content]) => content)
				.join("\n");
			if (existing) expect(recovery).toContain(original);
			expect(recovery).toContain(owned);
		});
	}
	for (const replaced of [false, true]) {
		test(`recovery-save failure ${replaced ? "preserves external replacement of" : "exclusively restores removed"} A after real B IO failure`, async () => {
			const { cwd, store } = await fixture();
			const a = path.join(cwd, "requirements/a.md");
			const b = path.join(cwd, "requirements/b.md");
			const original = "# A unique original recovery-save sentinel";
			const external = "# A external replacement recovery-save sentinel";
			await fs.writeFile(a, original);
			// A regular file makes recovery-directory creation fail with real IO.
			await fs.writeFile(path.join(cwd, ".omp"), "not a recovery directory");
			const map = await store.prepareSourceMap(["requirements/a.md"]);
			const patches: SpecPatch[] = [
				{
					operation: "rename",
					sourceId: map.entries[0]!.id,
					destinationPath: "requirements/b.md",
					replacement: original,
				},
			];
			const approved = await approval(store, map, patches);
			const canonicalB = path.join(await fs.realpath(path.dirname(b)), path.basename(b));
			const rename = nodeFs.promises.rename.bind(nodeFs.promises);
			let removedA = false;
			let injected = false;
			const fault = spyOn(nodeFs.promises, "rename").mockImplementation(async (source, destination) => {
				if (!injected && String(destination) === canonicalB && String(source).endsWith(".tmp")) {
					removedA = !(await fs.stat(a).catch(error => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					}));
					if (replaced) await fs.writeFile(a, external, { flag: "wx" });
					// Remove the staged source so the actual OS rename fails with ENOENT
					// on every platform, without invoking Windows replacement fallback.
					await fs.unlink(String(source));
					await fs.writeFile(b, "# B external recovery-save sentinel", { flag: "wx" });
					injected = true;
				}
				return rename(source, destination);
			});
			let failure: unknown;
			try {
				await store.applySpecChanges(patches, map, approved);
			} catch (error) {
				failure = error;
			} finally {
				fault.mockRestore();
			}
			expect(injected).toBe(true);
			expect(removedA).toBe(true);
			expect(failure).toBeInstanceOf(AggregateError);
			expect((failure as Error).message).toContain("rename");
			expect((failure as Error).message).toContain("Recovery: unavailable (recovery save failed)");
			expect(
				(failure as AggregateError).errors.some(error => error.message.includes("could not be fully saved")),
			).toBe(true);
			expect(await fs.readFile(a, "utf8")).toBe(replaced ? external : original);
			expect(await fs.readFile(b, "utf8")).toBe("# B external recovery-save sentinel");
			expect(await fs.readFile(path.join(cwd, ".omp"), "utf8")).toBe("not a recovery directory");
			expect((failure as Error).message).not.toContain(original);
			expect((failure as Error).message).not.toContain(external);
		});
	}
	test("rollback restores owned A through a real directory alias after B publication fails", async () => {
		const { cwd } = await fixture();
		const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-artifact-alias-"));
		roots.push(aliasParent);
		const alias = path.join(aliasParent, "project");
		await fs.symlink(await fs.realpath(cwd), alias, process.platform === "win32" ? "junction" : "dir");
		const store = new SpecArtifactStore({ cwd: alias, changeId: "change-one", requirementsDir: "requirements" });
		const a = path.join(alias, "requirements/a.md");
		const b = path.join(alias, "requirements/b.md");
		const original = "# A alias original sentinel";
		const owned = "# A alias published sentinel";
		await fs.writeFile(a, original);
		await fs.writeFile(b, "# B alias original sentinel");
		const map = await store.prepareSourceMap(["requirements/a.md", "requirements/b.md"]);
		const patches: SpecPatch[] = [
			{ operation: "modify", sourceId: map.entries[0]!.id, replacement: owned },
			{ operation: "modify", sourceId: map.entries[1]!.id, replacement: "# B alias attempted sentinel" },
		];
		const approved = await approval(store, map, patches);
		const canonicalB = await fs.realpath(b);
		const rename = nodeFs.promises.rename.bind(nodeFs.promises);
		let publishedA: string | undefined;
		let injected = false;
		const fault = spyOn(nodeFs.promises, "rename").mockImplementation(async (source, destination) => {
			if (!injected && String(destination) === canonicalB && String(source).endsWith(".tmp")) {
				publishedA = await fs.readFile(a, "utf8");
				injected = true;
				throw Object.assign(new Error("injected alias B publication IO failure"), { code: "EIO" });
			}
			return rename(source, destination);
		});
		let failure: unknown;
		try {
			await store.applySpecChanges(patches, map, approved);
		} catch (error) {
			failure = error;
		} finally {
			fault.mockRestore();
		}
		expect(injected).toBe(true);
		expect(publishedA).toBe(owned);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as Error).message).toContain("injected alias B publication IO failure");
		expect(await fs.readFile(a, "utf8")).toBe(original);
		expect(await fs.readFile(b, "utf8")).toBe("# B alias original sentinel");
		expect(
			(failure as AggregateError).errors.some(error => error.message.includes("Unsafe specification path")),
		).toBe(false);
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
	await store.writeRequirements({
		document: requirementDocument,
		proposal,
		specs: [{ path: "specs/sample/spec.md", content: delta }],
	});
	await store.writePlan(formalPlan("# Approved plan\n\nTask T001: specification-only change.\n"));
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
		document: requirementDocument,
		proposal,
		specs: [
			{
				path: "specs/sample/spec.md",
				content:
					"## MODIFIED Requirements\n\n### Requirement: Missing original\nThe system SHALL reject an update without a matching original requirement.\n\n#### Scenario: Missing source\n- **WHEN** the requirement is absent\n- **THEN** merging is rejected\n",
			},
		],
	});
	await failed.writePlan(formalPlan("# Approved plan\n\nTask T002.\n"));
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
		document: requirementDocument,
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
	const plan = await store.writePlan(formalPlan("# Approved plan\n\nTask T001: specification-only change.\n"));
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
async function closureMaterial(cwd: string, store: SpecArtifactStore): Promise<Array<[string, string]>> {
	await store.writeSolution({
		specificationVersion: (await store.readRequirements()).version,
		runId: "closure-discussion",
		candidateId: "selected",
		candidateVersion: "selected-v1",
		proposal: "# Selected closure solution\r\nPreserve every formal document verbatim.\r\n",
		conditions: [],
	});
	const evidence: Array<[string, string]> = [
		["checks/review.json", '{"observed":"original command output","status":"passed"}\n'],
		["handoffs/requirements-to-solution.md", "# Native requirements handoff\r\nApproved requirements.\r\n"],
		["handoffs/solution-to-plan.md", "# Native solution handoff\r\nSelected solution.\r\n"],
		["handoffs/plan-to-execution.md", "# Native plan handoff\r\nApproved coverage.\r\n"],
		[
			"verification.md",
			"# Verification\n\n[Raw check](checks/review.json)\n\n[Requirements handoff](handoffs/requirements-to-solution.md)\n\n[Solution handoff](handoffs/solution-to-plan.md)\n\n[Plan handoff](handoffs/plan-to-execution.md)\n",
		],
	];
	for (const [relative, content] of evidence) {
		const file = path.join(cwd, store.changeDir, relative);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	}
	return Promise.all(
		["requirements.md", "solution.md", "plan.md", ...evidence.map(([relative]) => relative)].map(
			async relative =>
				[relative, await fs.readFile(path.join(cwd, store.changeDir, relative), "utf8")] as [string, string],
		),
	);
}
async function expectClosureMaterial(cwd: string, directory: string, material: Array<[string, string]>) {
	for (const [relative, content] of material)
		expect(await fs.readFile(path.join(cwd, directory, relative), "utf8")).toBe(content);
	const verification = await fs.readFile(path.join(cwd, directory, "verification.md"), "utf8");
	for (const match of verification.matchAll(/\]\(([^)]+)\)/g)) {
		const relative = match[1]!;
		expect(path.isAbsolute(relative)).toBe(false);
		expect(await fs.readFile(path.join(cwd, directory, relative), "utf8")).toBe(
			material.find(([name]) => name === relative)![1],
		);
	}
}
describe("independently authorized real upstream closure", () => {
	test("native sync-only publishes upstream master semantics without moving any change material", async () => {
		const { cwd, store, plan, accepted } = await nativeFixture();
		const material = await closureMaterial(cwd, store);
		const before = await tree(path.join(cwd, store.changeDir));
		await store.sync(accepted);
		expect(await fs.readFile(path.join(cwd, "openspec/specs/sample/spec.md"), "utf8")).toContain(
			"### Requirement: Sample behavior",
		);
		expect(await tree(path.join(cwd, store.changeDir))).toEqual(before);
		await expectClosureMaterial(cwd, store.changeDir, material);
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
		const material = await closureMaterial(cwd, store);
		const result = await store.archive(accepted);
		expect(await fs.readFile(path.join(cwd, "openspec/specs/sample/spec.md"), "utf8")).toContain("Sample behavior");
		expect(await fs.readFile(path.join(cwd, result.archivePath, "plan.md"), "utf8")).toBe(plan.content);
		await expectClosureMaterial(cwd, result.archivePath, material);
		await expect(fs.stat(path.join(cwd, store.changeDir))).rejects.toThrow();
	});
	test("upstream merge rejection and stale approvals leave all original files and directories unchanged", async () => {
		const { cwd, store, accepted } = await nativeFixture();
		await store.writeRequirements({
			document: requirementDocument,
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
		const plan = await store.writePlan(formalPlan("# Approved Markdown plan\n"));
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
		const approvedPlan = await store.writePlan(formalPlan("# Approved plan\n"));
		const material = await closureMaterial(cwd, store);
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
		expect(await fs.readFile(path.join(cwd, result.archivePath, "plan.md"), "utf8")).toBe(approvedPlan.content);
		await expectClosureMaterial(cwd, result.archivePath, material);
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
