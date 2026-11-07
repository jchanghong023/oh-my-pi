import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
	artifactVersion,
	hasSpecCloseSideEffects,
	containedSpecPath,
	importDevBusiness,
	readDevMaterial,
	resolveDevMaterials,
	SpecArtifactStore,
} from "../../src/spec-driven/artifacts";
import { DevGitService } from "../../src/spec-driven/git";
import { saveDevRequirement } from "../../src/spec-driven/records";
import { ensureSpecDrivenResources } from "../../src/spec-driven/resources";
import { syncDevRequirement } from "../../src/spec-driven/native-sync";
import type { DevRequirementRecord, SpecArtifactPaths, SpecCloseProgress } from "../../src/spec-driven/types";

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

async function fixture(native = false, changeId = "sample-change"): Promise<Fixture> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-artifacts- (test)-"));
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
		changeId,
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
		"## Why\n\nProvide sample behavior for existing callers while keeping the expected public API guarantees stable across revisions.\n\n## What Changes\n\n- Add sample behavior.\n\n## Capabilities\n\n### New Capabilities\n- `sample`: sample behavior.\n\n### Modified Capabilities\n\nNone.\n\n## Impact\n\nSample public API.\n",
	);
	await write(
		paths.requirements[1]!.replace(/\*+/, "sample"),
		"## ADDED Requirements\n\n### Requirement: Sample\nThe system SHALL preserve sample behavior.\n\n#### Scenario: Works\n- **WHEN** the sample API is used\n- **THEN** the expected result is returned\n",
	);
	return { cwd, store, paths, write };
}

test("business document admission rejects incomplete drafts without creating development artifacts", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-artifacts-"));
	roots.push(cwd);
	const store = new SpecArtifactStore({ cwd, changeId: "business-only" });
	const paths = await store.initialize("business-requirements.md");
	expect(await Bun.file(path.join(cwd, "openspec/changes/business-only/.openspec.yaml")).exists()).toBe(false);
	await expect(store.readBusiness(paths.business)).rejects.toThrow();
	await Bun.write(path.join(cwd, paths.business!), "# 业务需求：订单\n\n## 基本信息\n订单业务。\n");
	await expect(store.readBusiness(paths.business)).rejects.toThrow("业务背景与目标");
	const content =
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
			.map(heading => `## ${heading}\n已确认的业务事实。\n`)
			.join("\n");
	await Bun.write(path.join(cwd, paths.business!), content);
	const document = await store.readBusiness(paths.business);
	expect(document.content).toBe(content);
	expect(document.version).toBe(artifactVersion(new TextEncoder().encode(content)));
});

const businessHeadings = [
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
] as const;
function completeBusiness(): string {
	return "# 业务需求：订单 Ω\n\n" + businessHeadings.map(heading => `## ${heading}\n真实完整业务事实。\n`).join("\n");
}
function importedRecord(changeId = "import-business"): DevRequirementRecord {
	return {
		schemaVersion: 1,
		requirementId: changeId,
		changeId,
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

describe("business imports use real bytes and owned Markdown", () => {
	test("uploads selected content rather than reading the submitted filename as a host path", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-upload-"));
		roots.push(cwd);
		const bytes = new TextEncoder().encode(completeBusiness());
		const record = importedRecord();
		const document = await importDevBusiness(cwd, record, { kind: "upload", name: "not-on-host.md", bytes });
		expect(document).toEqual({
			path: "docs/business-requirements/import-business.md",
			content: completeBusiness(),
			version: artifactVersion(bytes),
		});
		expect(await fs.readFile(path.join(cwd, document.path), "utf8")).toBe(completeBusiness());
		expect(record.decisions).toEqual([]);
		await expect(fs.stat(path.join(cwd, "openspec"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(importDevBusiness(cwd, record, { kind: "upload", name: "again.md", bytes })).rejects.toThrow();
		expect(await fs.readFile(path.join(cwd, document.path), "utf8")).toBe(completeBusiness());
	});

	test("copies a host file without acquiring ownership of or changing the source", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-host-import-"));
		const external = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-external-"));
		roots.push(cwd, external);
		const source = path.join(external, "source Ω.MD");
		await fs.writeFile(source, completeBusiness());
		const document = await importDevBusiness(cwd, importedRecord(), { kind: "host-path", path: source });
		expect(document.content).toBe(completeBusiness());
		await fs.writeFile(source, "source changed independently");
		expect(await fs.readFile(path.join(cwd, document.path), "utf8")).toBe(completeBusiness());
		expect(await fs.readFile(source, "utf8")).toBe("source changed independently");
	});

	test("rejects URLs, non-Markdown and missing host files without publishing an internal copy", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-import-invalid-"));
		roots.push(cwd);
		for (const name of ["https://example.invalid/business.md", "business.pdf", "business.docx"]) {
			await expect(
				importDevBusiness(cwd, importedRecord(), {
					kind: "upload",
					name,
					bytes: new TextEncoder().encode(completeBusiness()),
				}),
			).rejects.toThrow();
			await expect(importDevBusiness(cwd, importedRecord(), { kind: "host-path", path: name })).rejects.toThrow();
		}
		await expect(
			importDevBusiness(cwd, importedRecord(), { kind: "host-path", path: path.join(cwd, "missing.md") }),
		).rejects.toThrow();
		await expect(fs.stat(path.join(cwd, "docs/business-requirements/import-business.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	for (const heading of businessHeadings) {
		for (const failure of ["missing", "empty"] as const) {
			test(`imports but cannot approve ${failure} business section ${heading}, retaining bytes for repair`, async () => {
				const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-sections-"));
				roots.push(cwd);
				const content =
					"# 业务需求：订单\n\n" +
					businessHeadings
						.filter(item => failure !== "missing" || item !== heading)
						.map(item => `## ${item}\n${failure === "empty" && item === heading ? "" : "业务事实。"}\n`)
						.join("\n");
				const document = await importDevBusiness(cwd, importedRecord(), {
					kind: "upload",
					name: "business.md",
					bytes: new TextEncoder().encode(content),
				});
				expect(document.content).toBe(content);
				await expect(
					new SpecArtifactStore({ cwd, changeId: "import-business" }).readBusiness(document.path),
				).rejects.toThrow();
				expect(await fs.readFile(path.join(cwd, document.path), "utf8")).toBe(content);
			});
		}
	}

	test("does not write through a junction or overwrite a hard-linked destination", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-import-links-"));
		const external = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-import-target-"));
		roots.push(cwd, external);
		await fs.mkdir(path.join(cwd, "docs"));
		await fs.symlink(
			external,
			path.join(cwd, "docs/business-requirements"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const upload = {
			kind: "upload" as const,
			name: "business.md",
			bytes: new TextEncoder().encode(completeBusiness()),
		};
		await expect(importDevBusiness(cwd, importedRecord(), upload)).rejects.toThrow();
		await expect(fs.stat(path.join(external, "import-business.md"))).rejects.toMatchObject({ code: "ENOENT" });
		await fs.unlink(path.join(cwd, "docs/business-requirements"));
		await fs.mkdir(path.join(cwd, "docs/business-requirements"));
		const source = path.join(external, "source.md");
		await fs.writeFile(source, "must remain unchanged");
		await fs.link(source, path.join(cwd, "docs/business-requirements/import-business.md"));
		await expect(importDevBusiness(cwd, importedRecord(), upload)).rejects.toThrow();
		expect(await fs.readFile(source, "utf8")).toBe("must remain unchanged");
	});
});

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
		await expect(store.readRequirements()).rejects.toThrow("缺少需求规格");
		await expect(store.readRequirements()).rejects.toThrow(`${specs}/*/spec.md`);
		await expect(store.readRequirements()).rejects.toThrow("ENOENT");

		await fs.mkdir(path.join(cwd, specs));
		await expect(store.readRequirements()).rejects.toThrow("缺少需求规格");
		await expect(store.readRequirements()).rejects.toThrow(`${specs}/*/spec.md`);
		await fs.rm(path.join(cwd, specs), { recursive: true });
		await fs.writeFile(path.join(cwd, specs), "not a directory");
		await expect(store.readRequirements()).rejects.toThrow("ENOTDIR");

		await expect(store.readReport()).rejects.toThrow("缺少完成报告");
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
		for (const [content, reason] of [
			["not JSON", /valid JSON/],
			["{}", /at least one candidate/],
			['{"candidates":[],"recommendedCandidateId":"a"}', /at least one candidate/],
			[
				'{"candidates":[{"id":"a","title":" ","content":"x"}],"recommendedCandidateId":"a"}',
				/nonempty title\/content/,
			],
			[
				'{"candidates":[{"id":"a","title":"","content":"x"}],"recommendedCandidateId":"a"}',
				/nonempty title\/content/,
			],
			[
				'{"candidates":[{"id":"a","title":"A","content":""}],"recommendedCandidateId":"a"}',
				/nonempty title\/content/,
			],
			[
				'{"candidates":[{"id":"方案 一","title":"方案","content":"完整方案"}],"recommendedCandidateId":"方案 一"}',
				/whitespace-free id/,
			],
			[
				JSON.stringify({
					candidates: [
						{ id: "a", title: "A", content: "A" },
						{ id: "a", title: "B", content: "B" },
					],
					recommendedCandidateId: "a",
				}),
				/Duplicate solution candidate ID/,
			],
		] as const) {
			await write(paths.solution, content);
			await expect(store.readSolution()).rejects.toThrow(reason);
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
	const extra = `${context.store.changeDir}/specs/area/extra/spec.md`;
	await context.write(extra, "Unstructured new requirements still invalidate approval.\n");
	for (const approved of [input.specification.files, input.acceptedVersions]) {
		expect(await context.store.checkVersions(approved)).toMatchObject({
			matches: false,
			changed: [{ path: extra }],
		});
	}
	await expect(context.store.close(input)).rejects.toThrow("Unapproved requirements");
	await fs.unlink(path.join(context.cwd, extra));
	await fs.rm(path.join(context.cwd, context.store.changeDir, "specs/area"), { recursive: true });
	const result = await context.store.close(input);
	await context.write(`${result.archivedChangePath}/specs/area/extra/spec.md`, "New archived requirements.\n");
	expect(await context.store.checkVersions(input.acceptedVersions)).toMatchObject({
		matches: false,
		changed: [{ path: extra }],
	});
	await expect(context.store.close(input)).rejects.toThrow("Unapproved requirements");
}, 120_000);

test("nested native specifications are included in requirements handoff", async () => {
	const context = await fixture(true);
	const nested = `${context.store.changeDir}/specs/area/extra/spec.md`;
	const content = await fs.readFile(path.join(context.cwd, context.store.changeDir, "specs/sample/spec.md"), "utf8");
	await context.write(nested, content.replaceAll("Sample", "Extra").replaceAll("sample", "extra"));
	const requirements = await context.store.readRequirements();
	expect(requirements.files.find(file => file.path === nested)?.content).toBe(
		content.replaceAll("Sample", "Extra").replaceAll("sample", "extra"),
	);
}, 120_000);

test("native rollback failure preserves changed main specs as closing side effects", async () => {
	const context = await fixture(true);
	const main = "openspec/specs/sample/spec.md";
	await context.write(
		main,
		"# Sample\n\n## Purpose\nPreserve sample behavior for existing callers.\n\n## Requirements\n\n### Requirement: Sample\nThe system SHALL preserve sample behavior.\n\n#### Scenario: Works\n- **WHEN** the sample API is used\n- **THEN** the expected result is returned\n",
	);
	await context.write(
		`${context.store.changeDir}/specs/sample/spec.md`,
		"## MODIFIED Requirements\n\n### Requirement: Sample\nThe system SHALL preserve updated sample behavior.\n\n#### Scenario: Works\n- **WHEN** the sample API is used\n- **THEN** the updated result is returned\n",
	);
	const input = await acceptance(context);
	const preload = path.join(context.cwd, "fail-rollback.mjs");
	await fs.writeFile(
		preload,
		[
			'import { promises as fs } from "node:fs";',
			'import path from "node:path";',
			"const write = fs.writeFile, rename = fs.rename; let writes = 0;",
			"fs.writeFile = async function (file, ...args) {",
			'  if (String(file).endsWith(path.join("openspec", "specs", "sample", "spec.md")) && ++writes > 1) throw Object.assign(new Error("injected rollback failure"), { code: "EACCES" });',
			"  return write.call(this, file, ...args);",
			"};",
			"fs.rename = async function (src, dest, ...args) {",
			'  if (String(src).endsWith(path.join("changes", "sample-change")) && String(dest).includes(path.join("changes", "archive"))) throw Object.assign(new Error("injected move failure"), { code: "EACCES" });',
			"  return rename.call(this, src, dest, ...args);",
			"};",
		].join("\n"),
	);
	const spawn = Bun.spawn;
	const intercepted = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
		const command = args[0];
		if (Array.isArray(command) && command.some(arg => String(arg).endsWith("openspec.js")))
			args[0] = [command[0], "--preload", preload, ...command.slice(1)];
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
		).rejects.toThrow("Rollback also failed");
		expect(await fs.readFile(path.join(context.cwd, main), "utf8")).toContain("updated sample behavior");
		expect(progress.sideEffects?.paths).toEqual([main]);
		expect(hasSpecCloseSideEffects(progress)).toBe(true);
		expect(published[0]?.sideEffects).toEqual(progress.sideEffects);
	} finally {
		intercepted.mockRestore();
	}
}, 120_000);

test("native fallback copy retains unfinished source cleanup across retry", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const preload = path.join(context.cwd, "fail-move-cleanup.mjs");
	await fs.writeFile(
		preload,
		[
			'import { promises as fs } from "node:fs";',
			'import path from "node:path";',
			"const rename = fs.rename, rm = fs.rm;",
			"fs.rename = async function (src, dest, ...args) {",
			'  if (String(src).endsWith(path.join("changes", "sample-change")) && String(dest).includes(path.join("changes", "archive"))) throw Object.assign(new Error("injected cross-device move"), { code: "EXDEV" });',
			"  return rename.call(this, src, dest, ...args);",
			"};",
			"fs.rm = async function (file, ...args) {",
			'  if (String(file).includes(".openspec-move-") && String(file).includes(".openspec-claim-")) throw Object.assign(new Error("injected source cleanup failure"), { code: "EACCES" });',
			"  return rm.call(this, file, ...args);",
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
		await expect(context.store.close({ ...input, progress })).rejects.toThrow("could not remove the source");
		expect(progress.archivedChangePath).toBeDefined();
		expect(progress.archiveCleanup?.path).toContain(".openspec-move-");
		const count = launches.length;
		await expect(context.store.close({ ...input, progress })).rejects.toThrow("requires explicit cleanup");
		expect(launches).toHaveLength(count);
		await fs.rm(path.join(context.cwd, progress.archiveCleanup!.path), { recursive: true });
		expect(await context.store.close({ ...input, progress })).toEqual({
			archivedChangePath: progress.archivedChangePath!,
		});
		expect(progress.archiveCleanup).toBeUndefined();
		expect(launches).toHaveLength(count);
	} finally {
		intercepted.mockRestore();
	}
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
	for (const file of [paths.solution, paths.plan, paths.report]) {
		const accepted = input.acceptedVersions.find(version => version.path === file)!;
		expect(artifactVersion(await fs.readFile(path.join(cwd, file)))).toBe(accepted.version);
	}
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
	const restarted = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: context.store.changeId,
		planPath: context.paths.plan,
	});
	expect(await restarted.initialize()).toEqual(context.paths);
	const businessPath = "docs/business-requirements/sample-change.md";
	await context.write(businessPath, completeBusiness());
	expect(await restarted.initialize(businessPath)).toEqual({ ...context.paths, business: businessPath });
	expect((await restarted.readBusiness(businessPath)).content).toBe(completeBusiness());
	expect(
		(await restarted.readRequirements()).files.every(file => file.path.startsWith(`${archivedChangePath}/`)),
	).toBe(true);
	await expect(fs.stat(path.join(context.cwd, context.store.changeDir))).rejects.toMatchObject({ code: "ENOENT" });
	const fixed = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: "another-change",
		planPath: paths.plan,
	});
	expect(fixed.planPath).toBe(paths.plan);
	const duplicate = path.join(context.cwd, "openspec/changes/archive", `1999-01-01-${context.store.changeId}`);
	await fs.cp(path.join(context.cwd, archivedChangePath), duplicate, { recursive: true });
	const explicit = new SpecArtifactStore({ cwd: context.cwd, changeId: context.store.changeId, paths: context.paths });
	expect(await explicit.checkVersions(input.acceptedVersions, archivedChangePath)).toEqual({
		matches: true,
		changed: [],
	});
	await expect(explicit.checkVersions(input.acceptedVersions)).rejects.toBeInstanceOf(Error);
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
	const context = await fixture(true, "2026-10-26-sample-change");
	const input = await acceptance(context);
	const obstruction = path.join(context.cwd, "openspec/changes/archive", context.store.changeId);
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
	await write(paths.requirements[1]!.replace(/\*+/, "sample"), "# Not a native delta specification\n");
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

test("every business template section requires nonempty content without inventing confirmation", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-business-sections-"));
	roots.push(cwd);
	const store = new SpecArtifactStore({ cwd, changeId: "business-sections" });
	const paths = await store.initialize("docs/business-requirements/business-sections.md");
	const headings = [
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
	];
	const sections = headings.map(heading => `## ${heading}\n${heading}：待用户确认，尚未交付。\n`);
	const full = `# 订单核对需求\n\n${sections.join("\n")}`;
	const file = path.join(cwd, paths.business!);
	await fs.mkdir(path.dirname(file), { recursive: true });
	for (const [index, heading] of headings.entries()) {
		for (const replacement of ["", `## ${heading}\n \t\n`]) {
			await fs.writeFile(file, full.replace(sections[index]!, replacement));
			await expect(store.readBusiness(paths.business)).rejects.toThrow(heading);
		}
	}
	await fs.writeFile(file, full);
	expect(await store.readBusiness(paths.business)).toEqual({
		path: paths.business!,
		content: full,
		version: artifactVersion(Buffer.from(full)),
	});
	await expect(fs.stat(path.join(cwd, "openspec"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("unreadable recursive Markdown authority invalidates unchanged approved files with its actual cause", async () => {
	const context = await fixture();
	const approved = (await context.store.readRequirements()).files;
	const originalReaddir = fs.readdir;
	const denied = Object.assign(new Error("authority enumeration denied"), { code: "EACCES" });
	const readdir = spyOn(fs, "readdir").mockImplementation(((
		target: Parameters<typeof fs.readdir>[0],
		...options: unknown[]
	) =>
		String(target).replaceAll("\\", "/").endsWith("/requirements")
			? Promise.reject(denied)
			: Reflect.apply(originalReaddir, fs, [target, ...options])) as typeof fs.readdir);
	try {
		const checked = await context.store.checkVersions(approved);
		expect(checked).toEqual({
			matches: false,
			changed: [
				{ path: "requirements", reason: "Cannot enumerate approved requirements: authority enumeration denied" },
			],
		});
	} finally {
		readdir.mockRestore();
	}
	for (const file of approved)
		expect(artifactVersion(await fs.readFile(path.join(context.cwd, file.path)))).toBe(file.version);
	expect(await context.store.checkVersions(approved)).toEqual({ matches: true, changed: [] });
}, 120_000);

test("external omp-spec shadow blocks initialization, requirement approval and archive without mutating the change", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const resources = await ensureSpecDrivenResources();
	const override = path.join(context.cwd, "openspec/schemas/omp-spec");
	await fs.mkdir(path.dirname(override), { recursive: true });
	await fs.cp(path.dirname(resources.specSchemaPath), override, { recursive: true });
	const newStore = new SpecArtifactStore({ cwd: context.cwd, changeId: "blocked-new" });
	await expect(newStore.initialize()).rejects.toThrow("an external schema shadows it");
	await expect(context.store.readRequirements()).rejects.toThrow("an external schema shadows it");
	await expect(context.store.close(input)).rejects.toThrow("an external schema shadows it");
	await expect(fs.stat(path.join(context.cwd, "openspec/changes/blocked-new"))).rejects.toMatchObject({
		code: "ENOENT",
	});
	await expect(fs.stat(path.join(context.cwd, "openspec/changes/archive"))).rejects.toMatchObject({ code: "ENOENT" });
	for (const approved of input.acceptedVersions)
		expect(artifactVersion(await fs.readFile(path.join(context.cwd, approved.path)))).toBe(approved.version);
	expect(await fs.readFile(path.join(context.cwd, context.store.changeDir, ".openspec.yaml"), "utf8")).toContain(
		"schema: omp-spec",
	);
}, 120_000);

test("all material readers retain logical IDs and return actual archive paths after native synchronization", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const record = importedRecord("sample-change");
	record.stage = "pr";
	record.materials = [
		...input.specification.files.map((file, index) => ({
			id: index === 0 ? "proposal-original-id" : `delta-original-${index}`,
			kind: index === 0 ? ("proposal" as const) : ("delta" as const),
			path: file.path,
			version: file.version,
		})),
		...(["solution", "plan", "report"] as const).map(kind => ({
			id: kind,
			kind,
			path: context.paths[kind],
			version: input.acceptedVersions.find(file => file.path === context.paths[kind])!.version,
		})),
	];
	const revision = await syncDevRequirement(
		{
			cwd: context.cwd,
			changeId: record.changeId,
			changeDirectory: context.store.changeDir,
			acceptedVersions: input.acceptedVersions,
			previous: null,
			operationId: "first-archive",
			onProgress: async () => {},
		},
		new AbortController().signal,
	);
	record.syncRevisions.push(revision);
	expect(revision.archivedChangePath).toBeTruthy();
	const archive = revision.archivedChangePath!;
	const materials = await resolveDevMaterials(context.cwd, record);
	for (const original of input.specification.files) {
		const current = materials.find(file => file.id === record.materials.find(ref => ref.path === original.path)?.id)!;
		expect(current.path).toBe(original.path.replace(context.store.changeDir, archive));
		expect(await readDevMaterial(context.cwd, record, current.id)).toEqual({
			path: current.path,
			version: original.version,
			content: original.content,
		});
	}
	const reopened = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: record.changeId,
		paths: context.paths,
		archivedChangePath: archive,
	});
	const requirements = await reopened.readRequirements();
	expect(requirements.files.every(file => file.path.startsWith(`${archive}/`))).toBe(true);
	expect(await reopened.checkVersions(input.acceptedVersions)).toEqual({ matches: true, changed: [] });
	expect(await reopened.readSolution()).toEqual(await context.store.readSolution());
	expect(await reopened.readPlan()).toEqual(await context.store.readPlan());
	expect(await reopened.readReport()).toEqual(await context.store.readReport());
	await expect(fs.stat(path.join(context.cwd, context.store.changeDir))).rejects.toMatchObject({ code: "ENOENT" });
	await expect(readDevMaterial(context.cwd, record, "../../private")).rejects.toThrow();
}, 120_000);

test("archived revisions require native MODIFIED deltas and repeat the same operation without a second apply or archive", async () => {
	const context = await fixture(true);
	const input = await acceptance(context);
	const first = await syncDevRequirement(
		{
			cwd: context.cwd,
			changeId: "sample-change",
			changeDirectory: context.store.changeDir,
			acceptedVersions: input.acceptedVersions,
			previous: null,
			operationId: "archive-once",
			onProgress: async () => {},
		},
		new AbortController().signal,
	);
	const archive = first.archivedChangePath!;
	const deltaPath = `${archive}/specs/sample/spec.md`;
	const originalDelta = await fs.readFile(path.join(context.cwd, deltaPath), "utf8");
	const modified = originalDelta
		.replace("## ADDED Requirements", "## MODIFIED Requirements")
		.replace("preserve sample behavior", "preserve revised sample behavior");
	await context.write(deltaPath, modified);
	const reopened = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: "sample-change",
		planPath: context.paths.plan,
	});
	expect(await reopened.initialize()).toEqual(context.paths);
	const requirements = await reopened.readRequirements();
	const accepted = [
		...requirements.files,
		await reopened.readSolution(),
		await reopened.readPlan(),
		await reopened.readReport(),
	].map(({ path, version }) => ({ path, version }));
	const archives = await fs.readdir(path.join(context.cwd, "openspec/changes/archive"));
	const second = await syncDevRequirement(
		{
			cwd: context.cwd,
			changeId: "sample-change",
			changeDirectory: archive,
			acceptedVersions: accepted,
			previous: first,
			operationId: "revised-sync",
			onProgress: async () => {},
		},
		new AbortController().signal,
	);
	expect(second.archivedChangePath).toBe(archive);
	const main = path.join(context.cwd, "openspec/specs/sample/spec.md");
	const bytes = await fs.readFile(main);
	expect(bytes.toString("utf8")).toContain("preserve revised sample behavior");
	const repeated = await syncDevRequirement(
		{
			cwd: context.cwd,
			changeId: "sample-change",
			changeDirectory: archive,
			acceptedVersions: accepted,
			previous: second,
			operationId: "revised-sync",
			onProgress: async () => {},
		},
		new AbortController().signal,
	);
	expect(repeated).toEqual(second);
	expect(await fs.readFile(main)).toEqual(bytes);
	expect(await fs.readdir(path.join(context.cwd, "openspec/changes/archive"))).toEqual(archives);
	await expect(fs.stat(path.join(context.cwd, context.store.changeDir))).rejects.toMatchObject({ code: "ENOENT" });

	await context.write(
		deltaPath,
		modified
			.replace("## MODIFIED Requirements", "## ADDED Requirements")
			.replace("revised sample", "different sample"),
	);
	const changedRequirements = await reopened.readRequirements();
	await expect(
		syncDevRequirement(
			{
				cwd: context.cwd,
				changeId: "sample-change",
				changeDirectory: archive,
				acceptedVersions: [
					...changedRequirements.files,
					await reopened.readSolution(),
					await reopened.readPlan(),
					await reopened.readReport(),
				].map(({ path, version }) => ({ path, version })),
				previous: second,
				operationId: "invalid-added-resync",
				onProgress: async () => {},
			},
			new AbortController().signal,
		),
	).rejects.toThrow();
	expect(await fs.readFile(main)).toEqual(bytes);
	expect(await fs.readdir(path.join(context.cwd, "openspec/changes/archive"))).toEqual(archives);
}, 120_000);

test("archived Back edits retain active strict warning and main-spec scenario-loss gates", async () => {
	const context = await fixture(true);
	const activeDelta = `${context.store.changeDir}/specs/sample/spec.md`;
	const original = await fs.readFile(path.join(context.cwd, activeDelta), "utf8");
	const extraScenario =
		"\n#### Scenario: Also works\n- **WHEN** another supported request is used\n- **THEN** the same guarantee holds\n";
	const complete = original + extraScenario;
	await context.write(activeDelta, complete.replace("SHALL", "should"));
	await expect(context.store.readRequirements()).rejects.toThrow("WARNING");
	await context.write(activeDelta, complete);
	const input = await acceptance(context);
	const { archivedChangePath } = await context.store.close(input);
	const reopened = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: context.store.changeId,
		planPath: context.paths.plan,
	});
	expect(await reopened.initialize()).toEqual(context.paths);
	const archivedDelta = `${archivedChangePath}/specs/sample/spec.md`;
	const mainPath = path.join(context.cwd, "openspec/specs/sample/spec.md");
	const main = await fs.readFile(mainPath);
	await context.write(archivedDelta, original.replace("## ADDED Requirements", "## MODIFIED Requirements"));
	await expect(reopened.readRequirements()).rejects.toThrow(/scenario/i);
	const modified = complete.replace("## ADDED Requirements", "## MODIFIED Requirements");
	await context.write(archivedDelta, modified.replace("SHALL", "should"));
	await expect(reopened.readRequirements()).rejects.toThrow("WARNING");
	await context.write(archivedDelta, modified);
	expect((await reopened.readRequirements()).files.find(file => file.path === archivedDelta)?.content).toBe(modified);
	expect(await fs.readFile(mainPath)).toEqual(main);
	await expect(fs.stat(path.join(context.cwd, context.store.changeDir))).rejects.toMatchObject({ code: "ENOENT" });
}, 120_000);

/** Use the native repository and real ownership ledger, without invoking a Git executable. */
async function ownedSyncFixture(context: Fixture, files: readonly string[]) {
	const gitDir = path.join(context.cwd, ".git");
	for (const child of ["objects", "refs/heads"]) await fs.mkdir(path.join(gitDir, child), { recursive: true });
	await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(gitDir, "config"),
		"[core]\nrepositoryformatversion = 0\nbare = false\nautocrlf = false\nhooksPath = disabled-hooks\n[user]\nname = Material Fixture\nemail = material@example.invalid\n[commit]\ngpgsign = false\n",
	);
	await context.write(".gitignore", ".omp/\n");
	const record = importedRecord(context.store.changeId);
	record.stage = "pr";
	await saveDevRequirement(context.cwd, record, null);
	const repo = vcs.requireGit(context.cwd);
	await repo.stageFiles([".gitignore", `docs/dev-requirements/${record.requirementId}.json`, ...files]);
	await repo.commitCreate("material ownership baseline", {});
	const service = new DevGitService({ cwd: context.cwd, repo });
	await service.initializeRequirementGit(record.requirementId);
	return { repo, service, requirementId: record.requirementId };
}

test.each(["active", "archived"] as const)(
	"resumes failed %s ownership settlement from its original capture without reapplying",
	async location => {
		const context = await fixture(true);
		const accepted = await acceptance(context);
		const previous =
			location === "archived"
				? await syncDevRequirement(
						{
							cwd: context.cwd,
							changeId: context.store.changeId,
							changeDirectory: context.store.changeDir,
							acceptedVersions: accepted.acceptedVersions,
							previous: null,
							operationId: "baseline-archive",
							onProgress: async () => {},
						},
						new AbortController().signal,
					)
				: null;
		const directory = previous?.archivedChangePath ?? context.store.changeDir;
		if (location === "archived") {
			const delta = `${directory}/specs/sample/spec.md`;
			await context.write(
				delta,
				(await fs.readFile(path.join(context.cwd, delta), "utf8"))
					.replace("## ADDED Requirements", "## MODIFIED Requirements")
					.replace("preserve sample", "preserve updated sample"),
			);
		}
		const store = new SpecArtifactStore({
			cwd: context.cwd,
			changeId: context.store.changeId,
			planPath: context.paths.plan,
		});
		const requirements = await store.readRequirements();
		const files = [
			...requirements.files,
			await store.readSolution(),
			await store.readPlan(),
			await store.readReport(),
		].map(({ path, version }) => ({ path, version }));
		const main = "openspec/specs/sample/spec.md";
		const before = location === "archived" ? artifactVersion(await fs.readFile(path.join(context.cwd, main))) : null;
		const owned = await ownedSyncFixture(context, [
			...files.map(file => file.path),
			`${directory}/.openspec.yaml`,
			...(before ? [main] : []),
		]);
		await context.write("unrelated.txt", "user-owned unrelated bytes\n");
		let captures = 0;
		let captureId = "";
		let persisted: SpecCloseProgress = {};
		const operationId = `owned-${location}-sync`;
		await expect(
			syncDevRequirement(
				{
					cwd: context.cwd,
					changeId: context.store.changeId,
					changeDirectory: directory,
					acceptedVersions: files,
					previous,
					operationId,
					onProgress: async progress => {
						persisted = structuredClone(progress);
					},
					onBeforeWrite: async paths => {
						captures++;
						captureId = await owned.service.beginOwnedPaths(owned.requirementId, operationId, paths);
						return captureId;
					},
					onAfterWrite: async () => {
						throw new Error("ownership settlement unavailable");
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow("ownership settlement unavailable");
		expect(persisted.synced).toBe(true);
		expect(persisted.ownership).toEqual({ captureId, state: "pending" });
		const mainBytes = await fs.readFile(path.join(context.cwd, main));
		const mainStat = await fs.stat(path.join(context.cwd, main));
		const archives = await fs.readdir(path.join(context.cwd, "openspec/changes/archive"));
		const cold = new DevGitService({ cwd: context.cwd, repo: owned.repo });
		// Neither a saved revision nor an in-memory capture variable is needed after restart.
		const recovered = await syncDevRequirement(
			{
				cwd: context.cwd,
				changeId: context.store.changeId,
				changeDirectory: directory,
				acceptedVersions: files,
				previous: null,
				operationId,
				onProgress: async progress => {
					persisted = structuredClone(progress);
				},
				onBeforeWrite: async () => {
					throw new Error("must not recapture a postimage");
				},
				onAfterWrite: async originalCapture => {
					expect(originalCapture).toBe(captureId);
					await cold.endOwnedPaths(owned.requirementId, originalCapture);
				},
			},
			new AbortController().signal,
		);
		expect(captures).toBe(1);
		expect(recovered.progress.ownership).toEqual({ captureId, state: "settled" });
		expect(persisted.ownership?.state).toBe("settled");
		expect(await fs.readFile(path.join(context.cwd, main))).toEqual(mainBytes);
		expect((await fs.stat(path.join(context.cwd, main))).mtimeMs).toBe(mainStat.mtimeMs);
		expect(await fs.readdir(path.join(context.cwd, "openspec/changes/archive"))).toEqual(archives);
		const changes = await cold.getOwnedChanges(owned.requirementId);
		const mainChange = changes.find(change => change.path === main)!;
		expect(mainChange.beforeVersion).toBe(before);
		expect(mainChange.afterVersion).toBe(artifactVersion(mainBytes));
		expect(changes.some(change => change.path === "unrelated.txt")).toBe(false);
		const cancellation = await owned.repo.previewOwnedPatch(mainChange.patch, { reverse: true });
		expect(cancellation.expected.find(file => file.path === main)).toEqual({
			path: main,
			beforeVersion: artifactVersion(mainBytes),
			afterVersion: before,
		});
		await expect(fs.stat(path.join(context.cwd, context.store.changeDir))).rejects.toMatchObject({ code: "ENOENT" });
	},
	120_000,
);

test("completed native receipts recover pending original ownership even when host progress was never saved", async () => {
	const context = await fixture(true);
	const accepted = await acceptance(context);
	const first = await syncDevRequirement(
		{
			cwd: context.cwd,
			changeId: context.store.changeId,
			changeDirectory: context.store.changeDir,
			acceptedVersions: accepted.acceptedVersions,
			previous: null,
			operationId: "receipt-baseline",
			onProgress: async () => {},
		},
		new AbortController().signal,
	);
	const archive = first.archivedChangePath!;
	const delta = `${archive}/specs/sample/spec.md`;
	await context.write(
		delta,
		(await fs.readFile(path.join(context.cwd, delta), "utf8"))
			.replace("## ADDED Requirements", "## MODIFIED Requirements")
			.replace("preserve sample", "preserve receipt-recovered sample"),
	);
	const store = new SpecArtifactStore({
		cwd: context.cwd,
		changeId: context.store.changeId,
		planPath: context.paths.plan,
	});
	const files = [
		...(await store.readRequirements()).files,
		await store.readSolution(),
		await store.readPlan(),
		await store.readReport(),
	].map(({ path, version }) => ({ path, version }));
	const main = "openspec/specs/sample/spec.md";
	const before = artifactVersion(await fs.readFile(path.join(context.cwd, main)));
	const owned = await ownedSyncFixture(context, [...files.map(file => file.path), `${archive}/.openspec.yaml`, main]);
	const operationId = "completed-receipt-owned";
	let captureId = "";
	let captures = 0;
	let settlements = 0;
	const originalWriteFile = fs.writeFile;
	const unavailable = spyOn(fs, "writeFile").mockImplementation(((
		target: Parameters<typeof fs.writeFile>[0],
		data: Parameters<typeof fs.writeFile>[1],
		...options: unknown[]
	) =>
		String(target).endsWith(".ownership.json.tmp") && String(data).includes('"synced":true')
			? Promise.reject(new Error("host progress journal unavailable"))
			: Reflect.apply(originalWriteFile, fs, [target, data, ...options])) as typeof fs.writeFile);
	try {
		await expect(
			syncDevRequirement(
				{
					cwd: context.cwd,
					changeId: context.store.changeId,
					changeDirectory: archive,
					acceptedVersions: files,
					previous: first,
					operationId,
					onProgress: async () => {},
					onBeforeWrite: async paths => {
						captures++;
						captureId = await owned.service.beginOwnedPaths(owned.requirementId, operationId, paths);
						return captureId;
					},
					onAfterWrite: async originalCapture => {
						settlements++;
						await owned.service.endOwnedPaths(owned.requirementId, originalCapture);
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow("host progress journal unavailable");
	} finally {
		unavailable.mockRestore();
	}
	const receiptBase = path.join(context.cwd, ".omp/dev-workbench/sync", artifactVersion(operationId));
	expect((JSON.parse(await fs.readFile(`${receiptBase}.json`, "utf8")) as { state: string }).state).toBe("completed");
	const journal = JSON.parse(await fs.readFile(`${receiptBase}.ownership.json`, "utf8")) as {
		progress: SpecCloseProgress;
	};
	expect(journal.progress.synced).toBeUndefined();
	expect(journal.progress.ownership).toEqual({ captureId, state: "pending" });
	expect(settlements).toBe(0);
	const bytes = await fs.readFile(path.join(context.cwd, main));
	const stat = await fs.stat(path.join(context.cwd, main));
	const retry = {
		cwd: context.cwd,
		changeId: context.store.changeId,
		changeDirectory: archive,
		acceptedVersions: files,
		previous: null,
		operationId,
		onProgress: async () => {},
		onBeforeWrite: async () => {
			throw new Error("must not recapture");
		},
	};
	await expect(
		syncDevRequirement(
			{
				...retry,
				onAfterWrite: async () => {
					throw new Error("endOwnedPaths unavailable");
				},
			},
			new AbortController().signal,
		),
	).rejects.toThrow("endOwnedPaths unavailable");
	const cold = new DevGitService({ cwd: context.cwd, repo: owned.repo });
	const recovered = await syncDevRequirement(
		{
			...retry,
			onAfterWrite: async originalCapture => {
				expect(originalCapture).toBe(captureId);
				await cold.endOwnedPaths(owned.requirementId, originalCapture);
			},
		},
		new AbortController().signal,
	);
	expect(captures).toBe(1);
	expect(recovered.progress.ownership).toEqual({ captureId, state: "settled" });
	expect(recovered.progress.synced).toBe(true);
	expect(await fs.readFile(path.join(context.cwd, main))).toEqual(bytes);
	expect((await fs.stat(path.join(context.cwd, main))).mtimeMs).toBe(stat.mtimeMs);
	const mainChange = (await cold.getOwnedChanges(owned.requirementId)).find(change => change.path === main)!;
	expect(mainChange.beforeVersion).toBe(before);
	expect(mainChange.afterVersion).toBe(artifactVersion(bytes));
	const cancellation = await owned.repo.previewOwnedPatch(mainChange.patch, { reverse: true });
	expect(cancellation.expected.find(file => file.path === main)?.afterVersion).toBe(before);
}, 120_000);

test("pending ownership remains recoverable independently of native sync completion", () => {
	expect(hasSpecCloseSideEffects({ ownership: { captureId: "original-capture", state: "pending" } })).toBe(true);
	expect(hasSpecCloseSideEffects({ ownership: { captureId: "original-capture", state: "settled" } })).toBe(false);
});

test.each(["active", "archived"] as const)(
	"the %s proposal uses the native change parser before requirement approval",
	async location => {
		const context = await fixture(true);
		const accepted = await acceptance(context);
		const directory =
			location === "archived" ? (await context.store.close(accepted)).archivedChangePath : context.store.changeDir;
		const proposal = `${directory}/proposal.md`;
		const original = await fs.readFile(path.join(context.cwd, proposal), "utf8");
		for (const [content, nativeDiagnostic] of [
			["not a proposal\n", "Why section"],
			["## Why\n\nProvide sample behavior.\n", "What Changes section"],
		] as const) {
			await context.write(proposal, content);
			await expect(context.store.readRequirements()).rejects.toThrow(nativeDiagnostic);
			expect(await fs.readFile(path.join(context.cwd, proposal), "utf8")).toBe(content);
		}
		await context.write(proposal, original);
		expect((await context.store.readRequirements()).files.find(file => file.path === proposal)?.content).toBe(
			original,
		);
		if (location === "archived")
			await expect(fs.stat(path.join(context.cwd, context.store.changeDir))).rejects.toMatchObject({
				code: "ENOENT",
			});
	},
	120_000,
);
