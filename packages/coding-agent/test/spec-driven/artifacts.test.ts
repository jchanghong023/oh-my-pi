import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	artifactVersion,
	containedSpecPath,
	SpecArtifactStore,
	type SpecCloseProgress,
} from "../../src/spec-driven/artifacts";
import type { SpecArtifactPaths } from "../../src/spec-driven/types";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const report = "# 完成报告\n\n## 完成情况\n实现规定范围。\n\n## 验证结果\n未运行：等待授权。\n\n## 未完成项\n无。\n";
interface Fixture {
	cwd: string;
	store: SpecArtifactStore;
	paths: SpecArtifactPaths;
	write: (file: string, content: string) => Promise<void>;
}

async function fixture(native = false): Promise<Fixture> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-artifacts-"));
	roots.push(cwd);
	if (!native) {
		await fs.mkdir(path.join(cwd, "requirements"));
		await fs.writeFile(
			path.join(cwd, "requirements", "sample.md"),
			"# Sample\n\nSHALL preserve existing behavior.\n",
		);
	}
	const store = new SpecArtifactStore({
		cwd,
		changeId: "sample-change",
		requirementsDir: native ? undefined : "requirements",
	});
	const paths = await store.initialize();
	const write = async (file: string, content: string) => {
		const target = path.join(cwd, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, content);
	};
	await write(
		paths.requirements[0]!,
		"## Why\n\nProvide sample behavior.\n\n## What Changes\n\n- Add sample behavior.\n\n## Capabilities\n\n### New Capabilities\n- `sample`: sample behavior.\n\n### Modified Capabilities\n\nNone.\n\n## Impact\n\nSample public API.\n",
	);
	await write(
		paths.requirements[1]!.replace("*", "sample"),
		"## ADDED Requirements\n\n### Requirement: Sample\nThe system SHALL preserve sample behavior.\n\n#### Scenario: Works\n- **WHEN** the sample API is used\n- **THEN** the expected result is returned\n",
	);
	return { cwd, store, paths, write };
}

async function acceptance(context: Fixture) {
	const { store, paths, write } = context;
	await write(
		paths.solution,
		'{"recommendedCandidateId":"sample","candidates":[{"id":"sample","title":"Sample","content":"Complete solution."}]}',
	);
	await write(paths.plan, "# Sample Implementation Plan\n\nUse the approved sample public API.\n");
	await write(paths.report, report);
	const specification = await store.readRequirements();
	const acceptedReport = await store.readReport();
	const acceptedVersions = [
		...specification.files,
		await store.readSolution(),
		await store.readPlan(),
		acceptedReport,
	].map(({ path, version }) => ({ path, version }));
	return { specification, report: acceptedReport, acceptedVersions };
}

describe("stage files are the sole artifact inputs", () => {
	test("keeps execution material together and reads authoritative Markdown in place", async () => {
		const { cwd, store, paths, write } = await fixture();
		expect(paths.requirements).toEqual([
			`${store.changeDir}/proposal.md`,
			`${store.changeDir}/specs/*/spec.md`,
			"requirements/sample.md",
		]);
		expect(path.dirname(paths.solution)).toBe(path.dirname(paths.plan));
		expect(path.dirname(paths.report)).toBe(path.dirname(paths.plan));
		const before = await store.readRequirements();
		expect(before.files.some(file => file.path === "requirements/sample.md")).toBe(true);
		await write("requirements/sample.md", "# Changed\n\nNew actual authoritative bytes.\n");
		expect((await store.readRequirements()).version).not.toBe(before.version);
		await expect(fs.stat(path.join(cwd, store.changeDir, "requirements.md"))).rejects.toThrow();
		await expect(fs.stat(path.join(cwd, ".omp", "spec-sessions"))).rejects.toThrow();
	});

	test("explains missing requirement specs and report without hiding other errors", async () => {
		const { cwd, store, paths, write } = await fixture(true);
		const specs = `${store.changeDir}/specs`;
		await fs.rm(path.join(cwd, specs), { recursive: true });
		await expect(store.readRequirements()).rejects.toThrow("缺少需求规格，请补齐后重试 /dev next");
		await expect(store.readRequirements()).rejects.toThrow(`${specs}/*/spec.md`);
		await expect(store.readRequirements()).rejects.toThrow("ENOENT");

		await fs.mkdir(path.join(cwd, specs));
		await expect(store.readRequirements()).rejects.toThrow("缺少需求规格，请补齐后重试 /dev next");
		await expect(store.readRequirements()).rejects.toThrow(`${specs}/*/spec.md`);
		await fs.rm(path.join(cwd, specs), { recursive: true });
		await fs.writeFile(path.join(cwd, specs), "not a directory");
		await expect(store.readRequirements()).rejects.toThrow("ENOTDIR");

		await expect(store.readReport()).rejects.toThrow("缺少完成报告，请补齐后重试 /dev next");
		await expect(store.readReport()).rejects.toThrow(paths.report);
		await expect(store.readReport()).rejects.toThrow("ENOENT");
		await fs.mkdir(path.join(cwd, paths.report), { recursive: true });
		await expect(store.readReport()).rejects.toThrow("EISDIR");
		await fs.rm(path.join(cwd, paths.report), { recursive: true });
		await write(paths.report, "# Invalid report\n");
		await expect(store.readReport()).rejects.toThrow("Completion report requires title");
	});

	test("rejects absent, malformed, empty and duplicate candidates, accepts any positive count", async () => {
		const { store, paths, write } = await fixture();
		await expect(store.readSolution()).rejects.toThrow();
		for (const content of [
			"not JSON",
			"{}",
			'{"candidates":[]}',
			'{"candidates":[{"id":"a","title":" ","content":"x"}]}',
			'{"candidates":[{"id":"方案 一","title":"方案","content":"完整方案"}]}',
			JSON.stringify({
				candidates: [
					{ id: "a", title: "A", content: "A" },
					{ id: "a", title: "B", content: "B" },
				],
			}),
		]) {
			await write(paths.solution, content);
			await expect(store.readSolution()).rejects.toThrow();
		}
		const content = JSON.stringify({
			candidates: [{ id: "a", title: "原方案", content: "# 完整方案\n\n未经摘要的全文。" }],
			recommendedCandidateId: "a",
		});
		await write(paths.solution, content);
		expect(await store.readSolution()).toMatchObject({
			path: paths.solution,
			content,
			version: artifactVersion(content),
			candidates: [{ id: "a", title: "原方案", content: "# 完整方案\n\n未经摘要的全文。" }],
			recommendedCandidateId: "a",
		});
	});

	test("requires an explicit valid recommendation for one or multiple candidates", async () => {
		const { store, paths, write } = await fixture();
		const candidates = [
			{ id: "a", title: "A", content: "完整 A" },
			{ id: "b", title: "B", content: "完整 B" },
		];
		for (const recommendedCandidateId of [undefined, "", "missing", " a", 1, null]) {
			await write(paths.solution, JSON.stringify({ candidates, recommendedCandidateId }));
			await expect(store.readSolution()).rejects.toThrow("recommendedCandidateId");
		}
		await write(paths.solution, JSON.stringify({ candidates: [candidates[0]] }));
		await expect(store.readSolution()).rejects.toThrow("recommendedCandidateId");
		await write(paths.solution, JSON.stringify({ candidates, recommendedCandidateId: "b" }));
		expect(await store.readSolution()).toMatchObject({ candidates, recommendedCandidateId: "b" });
	});

	test("versions the actual readable plan without any task projection", async () => {
		const { store, paths, write } = await fixture();
		await expect(store.readPlan()).rejects.toThrow();
		await write(paths.plan, " \n");
		await expect(store.readPlan()).rejects.toThrow("Empty");
		await write(paths.plan, "# Original Superpowers plan\n\nOriginal free-form task content.\n");
		const original = await store.readPlan();
		expect(original.version).toBe(artifactVersion(original.content));
		await write(paths.plan, `${original.content}\nChanged actual file.\n`);
		expect((await store.readPlan()).version).not.toBe(original.version);
	});

	test("requires the documented report title and nonempty sections, not claimed success", async () => {
		const { store, paths, write } = await fixture();
		for (const content of [
			"# Finished\n",
			report.replace("# 完成报告", "# 交付"),
			report.replace("未运行：等待授权。", ""),
			report.replace("## 未完成项", "## 剩余问题"),
		]) {
			await write(paths.report, content);
			await expect(store.readReport()).rejects.toThrow();
		}
		await write(paths.report, report);
		expect((await store.readReport()).content).toBe(report);
	});

	test("rejects stale acceptance without publishing an archive", async () => {
		const context = await fixture();
		const input = await acceptance(context);
		const archivePath = path.join(context.cwd, "openspec/changes/archive");
		await fs.mkdir(archivePath, { recursive: true });
		const archiveEntries = await fs.readdir(archivePath);
		await context.write(context.paths.report, `${report}\nChanged after review.\n`);
		await expect(context.store.close(input)).rejects.toThrow("changed");
		expect(await fs.readdir(archivePath)).toEqual(archiveEntries);
		for (const file of input.specification.files)
			expect(await fs.readFile(path.join(context.cwd, file.path), "utf8")).toBe(file.content);
	});
});

test("requirements approval detects added native deltas before and after real relocation", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const extra = `${context.store.changeDir}/specs/extra/spec.md`;
	await context.write(extra, "Unstructured new requirements still invalidate approval.\n");
	for (const approved of [input.specification.files, input.acceptedVersions]) {
		expect(await context.store.checkVersions(approved)).toMatchObject({
			matches: false,
			changed: [{ path: extra }],
		});
	}
	await expect(context.store.close(input)).rejects.toThrow("Unapproved requirements");
	await fs.unlink(path.join(context.cwd, extra));
	await fs.rmdir(path.dirname(path.join(context.cwd, extra)));
	const result = await context.store.close(input);
	await context.write(`${result.archivedChangePath}/specs/extra/spec.md`, "New archived requirements.\n");
	expect(await context.store.checkVersions(input.acceptedVersions)).toMatchObject({
		matches: false,
		changed: [{ path: extra }],
	});
	await expect(context.store.close(input)).rejects.toThrow("Unapproved requirements");
}, 120_000);

test("Markdown authority additions invalidate approval without duplicating shared native paths", async () => {
	const context = await fixture();
	const input = await acceptance(context);
	const restored = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: context.store.changeId,
		requirementsDir: "requirements",
		paths: {
			...context.paths,
			requirements: [...context.paths.requirements, `${context.store.changeDir}/specs/sample/spec.md`],
		},
	});
	expect(await restored.checkVersions(input.acceptedVersions)).toEqual({ matches: true, changed: [] });
	await context.write("requirements/new.md", "# Additional authoritative requirements\n");
	expect(await restored.checkVersions(input.acceptedVersions)).toMatchObject({
		matches: false,
		changed: [{ path: "requirements/new.md" }],
	});
	await expect(restored.close(input)).rejects.toThrow("Unapproved requirements");
}, 120_000);

test("a real native retirement cleanup failure remains blocked until its backup is explicitly cleaned", async () => {
	const context = await fixture(true);
	await context.write(
		"openspec/specs/sample/spec.md",
		"# Sample\n\n## Purpose\nPreserve sample behavior for existing callers.\n\n## Requirements\n\n### Requirement: Sample\nThe system SHALL preserve sample behavior.\n\n#### Scenario: Works\n- **WHEN** the sample API is used\n- **THEN** the expected result is returned\n",
	);
	await context.write(
		`${context.store.changeDir}/specs/sample/spec.md`,
		"## REMOVED Requirements\n\n### Requirement: Sample\n**Reason**: Retire the sample capability.\n**Migration**: No replacement is required.\n",
	);
	await context.write(`${context.store.changeDir}/.openspec.yaml`, "schema: spec-driven\nretire_capabilities: true\n");
	const input = await acceptance(context);
	const preload = path.join(context.cwd, "fail-retirement-cleanup.mjs");
	await fs.writeFile(
		preload,
		[
			'import { promises as fs } from "node:fs";',
			"const unlink = fs.unlink;",
			"fs.unlink = async function (file, ...args) {",
			'  if (String(file).includes(".openspec-retire-")) throw Object.assign(new Error("injected backup permission failure"), { code: "EACCES" });',
			"  return unlink.call(this, file, ...args);",
			"};",
		].join("\n"),
	);
	const spawn = Bun.spawn;
	const launches: string[][] = [];
	const intercepted = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
		const command = args[0];
		if (Array.isArray(command) && command.some(arg => String(arg).endsWith("openspec.js"))) {
			launches.push(command.map(String));
			args[0] = [command[0], "--preload", preload, ...command.slice(1)];
		}
		return Reflect.apply(spawn, Bun, args);
	}) as typeof Bun.spawn);
	try {
		const progress: SpecCloseProgress = {};
		const published: SpecCloseProgress[] = [];
		await expect(
			context.store.close({
				...input,
				progress,
				onProgress: value => {
					published.push(structuredClone(value));
				},
			}),
		).rejects.toThrow("archive_retirement_cleanup_failed");
		expect(progress.archivedChangePath).toContain("openspec/changes/archive/");
		expect(progress.synced).toBe(true);
		expect(progress.retirementCleanup?.paths).toHaveLength(1);
		expect(published[0]?.retirementCleanup).toEqual(progress.retirementCleanup);
		await expect(fs.stat(path.join(context.cwd, context.store.changeDir))).rejects.toThrow();
		await expect(fs.stat(path.join(context.cwd, "openspec/specs/sample/spec.md"))).rejects.toThrow();
		const count = launches.length;
		const restored = new SpecArtifactStore({
			cwd: context.cwd,
			changeId: context.store.changeId,
			paths: context.paths,
		});
		await expect(restored.close({ ...input, progress })).rejects.toThrow("requires explicit cleanup");
		expect(launches).toHaveLength(count);
		for (const backup of progress.retirementCleanup!.paths) await fs.unlink(path.join(context.cwd, backup));
		expect(await restored.close({ ...input, progress })).toEqual({
			archivedChangePath: progress.archivedChangePath!,
		});
		expect(progress.retirementCleanup).toBeUndefined();
		expect(launches).toHaveLength(count);
	} finally {
		intercepted.mockRestore();
	}
}, 120_000);

test("existing Markdown remains authoritative while its native change is really archived", async () => {
	const context = await fixture();
	const { cwd, store } = context;
	const input = await acceptance(context);
	const original = input.specification.files.find(file => file.path === "requirements/sample.md")!;
	const result = await store.close(input);
	expect(result.archivedChangePath).toContain("openspec/changes/archive/");
	expect(await fs.readFile(path.join(cwd, result.archivedChangePath, "proposal.md"), "utf8")).toContain(
		"Provide sample behavior",
	);
	expect(await fs.readFile(path.join(cwd, original.path), "utf8")).toBe(original.content);
	await expect(fs.stat(path.join(cwd, "openspec", "specs", "sample", "spec.md"))).rejects.toThrow();
}, 120_000);

test("native requirements are validated and acceptance uses the real archive without moving execution files", async () => {
	const context = await fixture(true);
	const { cwd, store, paths } = context;
	const input = await acceptance(context);
	const result = await store.close(input);
	expect(result.archivedChangePath).toContain("openspec/changes/archive/");
	if (!result.archivedChangePath) throw new Error("Expected a real native archive");
	expect(await fs.readFile(path.join(cwd, result.archivedChangePath, "proposal.md"), "utf8")).toContain(
		"Provide sample behavior",
	);
	expect(await fs.readFile(path.join(cwd, "openspec", "specs", "sample", "spec.md"), "utf8")).toContain(
		"sample behavior",
	);
	for (const file of [paths.solution, paths.plan, paths.report])
		expect(await fs.stat(path.join(cwd, file))).toBeDefined();
	await expect(fs.stat(path.join(cwd, result.archivedChangePath, "plan.md"))).rejects.toThrow();
	await expect(fs.stat(path.join(cwd, result.archivedChangePath, "completion.md"))).rejects.toThrow();
}, 120_000);

test("restoration keeps the original paths without recreating an archived change", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const { archivedChangePath } = await context.store.close(input);
	const paths = {
		...context.paths,
		plan: "docs/superpowers/plans/2001-02-03-fixed.md",
		solution: context.paths.solution,
		report: context.paths.report,
	};
	const restored = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: context.store.changeId,
		paths,
	});
	expect(await restored.initialize()).toEqual(paths);
	expect(restored.planPath).toBe(paths.plan);
	expect((await restored.readSolution()).path).toBe(paths.solution);
	expect((await restored.readReport()).path).toBe(paths.report);
	expect(await restored.checkVersions(input.acceptedVersions)).toEqual({ matches: true, changed: [] });
	expect(await restored.close(input)).toEqual({ archivedChangePath });
	await expect(fs.stat(path.join(context.cwd, context.store.changeDir))).rejects.toThrow();
	const fixed = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: "another-change",
		planPath: paths.plan,
	});
	expect(fixed.planPath).toBe(paths.plan);
}, 120_000);

test("native archive progress survives failed persistence and retry performs only remaining checks", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const progress: SpecCloseProgress = {};
	const observed: SpecCloseProgress[] = [];
	await expect(
		context.store.close({
			...input,
			progress,
			onProgress: async value => {
				observed.push(value);
				throw new Error("state persistence failed");
			},
		}),
	).rejects.toThrow("state persistence failed");
	expect(observed).toHaveLength(1);
	expect(progress.synced).toBe(true);
	expect(progress.archivedChangePath).toContain("openspec/changes/archive/");
	if (!progress.archivedChangePath) throw new Error("Expected a real native archive");
	const nativeMain = path.join(context.cwd, "openspec/specs/sample/spec.md");
	const mainBefore = await fs.readFile(nativeMain);
	const mainStat = await fs.stat(nativeMain);
	const result = await context.store.close({ ...input, progress });
	expect(result.archivedChangePath).toBe(progress.archivedChangePath);
	expect(await fs.readFile(nativeMain)).toEqual(mainBefore);
	expect((await fs.stat(nativeMain)).mtimeMs).toBe(mainStat.mtimeMs);
	// Simulate a crash before the progress could be durably saved: discover the actual native result.
	const restored = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: context.store.changeId,
		paths: context.paths,
	});
	const recovered: SpecCloseProgress[] = [];
	expect(
		await restored.close({
			...input,
			onProgress: value => {
				recovered.push(value);
			},
		}),
	).toEqual(result);
	expect(recovered).toEqual([{ synced: true, archivedChangePath: result.archivedChangePath }]);
}, 120_000);

test("a conflicting native destination is not mistaken for completed archive progress", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const now = new Date();
	const date = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
	const obstruction = path.join(context.cwd, "openspec/changes/archive", `${date}-${context.store.changeId}`);
	await fs.mkdir(obstruction, { recursive: true });
	const progress: SpecCloseProgress = {};
	const published: SpecCloseProgress[] = [];
	await expect(
		context.store.close({
			acceptedVersions: input.acceptedVersions,
			progress,
			onProgress: value => {
				published.push(value);
			},
		}),
	).rejects.toThrow("already exists");
	expect(progress).toEqual({});
	expect(published).toEqual([]);
	expect(await context.store.checkVersions(input.acceptedVersions)).toEqual({ matches: true, changed: [] });
	await fs.rmdir(obstruction);
	const result = await context.store.close({ acceptedVersions: input.acceptedVersions, progress });
	expect(progress.archivedChangePath).toBe(result.archivedChangePath);
}, 120_000);

test("a completed synchronization is not replayed when only native archive remains", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const main = "openspec/specs/sample/spec.md";
	const existing = "# Existing user-maintained main specification\n\nDo not replay synchronization.\n";
	await context.write(main, existing);
	await context.write("unrelated/user.txt", "Keep unrelated bytes\n");
	const progress: SpecCloseProgress = { synced: true };
	const result = await context.store.close({ acceptedVersions: input.acceptedVersions, progress });
	expect(progress.archivedChangePath).toBe(result.archivedChangePath);
	expect(await fs.readFile(path.join(context.cwd, main), "utf8")).toBe(existing);
	expect(await fs.readFile(path.join(context.cwd, "unrelated/user.txt"), "utf8")).toBe("Keep unrelated bytes\n");
}, 120_000);

test("post-archive verification failure retains progress and rejects every changed accepted material", async () => {
	const context = await fixture();
	const input = await acceptance(context);
	const progress: SpecCloseProgress = {};
	const originalPlan = await fs.readFile(path.join(context.cwd, context.paths.plan), "utf8");
	await expect(
		context.store.close({
			...input,
			progress,
			onProgress: async () => context.write(context.paths.plan, "# External plan replacement\n"),
		}),
	).rejects.toThrow("changed");
	expect(progress.archivedChangePath).toBeDefined();
	await expect(context.store.close({ ...input, progress })).rejects.toThrow("changed");
	await context.write(context.paths.plan, originalPlan);
	for (const file of input.acceptedVersions) {
		const actual = file.path.startsWith(`${context.store.changeDir}/`)
			? `${progress.archivedChangePath}/${file.path.slice(context.store.changeDir.length + 1)}`
			: file.path;
		const original = await fs.readFile(path.join(context.cwd, actual));
		await fs.writeFile(path.join(context.cwd, actual), Buffer.concat([original, Buffer.from("\nExternal change\n")]));
		const checked = await context.store.checkVersions(input.acceptedVersions, progress.archivedChangePath);
		expect(checked.matches).toBe(false);
		expect(checked.changed.map(change => change.path)).toEqual([file.path]);
		await expect(context.store.close({ ...input, progress })).rejects.toThrow("changed");
		await fs.writeFile(path.join(context.cwd, actual), original);
	}
	expect(await context.store.close({ ...input, progress })).toEqual({
		archivedChangePath: progress.archivedChangePath!,
	});
	await expect(fs.stat(path.join(context.cwd, "openspec/specs/sample/spec.md"))).rejects.toThrow();
}, 120_000);

test("byte checks accept matching unstructured bytes and ignore unrelated files", async () => {
	const { cwd, store, paths, write } = await fixture();
	const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x0a]);
	await fs.mkdir(path.dirname(path.join(cwd, paths.solution)), { recursive: true });
	await fs.writeFile(path.join(cwd, paths.solution), bytes);
	await write("unrelated/user.md", "# User-owned unrelated content\n");
	const versions = [{ path: paths.solution, version: artifactVersion(bytes) }];
	expect(await store.checkVersions(versions)).toEqual({ matches: true, changed: [] });
	await write("unrelated/user.md", "Changed unrelated content\n");
	expect(await store.checkVersions(versions)).toEqual({ matches: true, changed: [] });
	await expect(store.readSolution()).rejects.toThrow("JSON");
});

test("no approved materials requires no filesystem access", async () => {
	const store = new SpecArtifactStore({
		cwd: path.join(os.tmpdir(), randomUUID(), "nonexistent-workspace"),
		changeId: "not-created",
	});
	expect(await store.checkVersions([])).toEqual({ matches: true, changed: [] });
});

test("malformed native requirements fail the real native validator", async () => {
	const { store, paths, write } = await fixture(true);
	await write(paths.requirements[1]!.replace("*", "sample"), "# Not a native delta specification\n");
	await expect(store.readRequirements()).rejects.toThrow("validation failed");
}, 120_000);

test("contained paths reject traversal, devices, selectors and escaping junctions", async () => {
	const { cwd } = await fixture();
	for (const file of ["../escape", "xd://bash", "sample.md:1", "C:\\elsewhere"])
		await expect(containedSpecPath(cwd, file)).rejects.toThrow();
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-outside-"));
	roots.push(outside);
	await fs.symlink(outside, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
	await expect(containedSpecPath(cwd, "linked/file.md")).rejects.toThrow();
});
