import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { artifactVersion, containedSpecPath, SpecArtifactStore } from "../../src/spec-driven/artifacts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const report = "# 完成报告\n\n## 完成情况\n实现规定范围。\n\n## 验证结果\n未运行：等待授权。\n\n## 未完成项\n无。\n";
async function fixture(native = false) {
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
		});
		await write(paths.solution, content);
		expect(await store.readSolution()).toMatchObject({
			path: paths.solution,
			content,
			version: artifactVersion(content),
		});
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
		const { store, paths, write } = await fixture();
		await write(paths.report, report);
		const specification = await store.readRequirements();
		const acceptedReport = await store.readReport();
		await write(paths.report, `${report}\nChanged after review.\n`);
		await expect(store.close({ specification, report: acceptedReport })).rejects.toThrow("changed");
	});
});

test("existing Markdown remains authoritative while its native change is really archived", async () => {
	const { cwd, store, paths, write } = await fixture();
	await write(paths.report, report);
	const specification = await store.readRequirements();
	const original = specification.files.find(file => file.path === "requirements/sample.md")!;
	const result = await store.close({ specification, report: await store.readReport() });
	expect(result.archivedChangePath).toContain("openspec/changes/archive/");
	expect(await fs.readFile(path.join(cwd, result.archivedChangePath, "proposal.md"), "utf8")).toContain(
		"Provide sample behavior",
	);
	expect(await fs.readFile(path.join(cwd, original.path), "utf8")).toBe(original.content);
	await expect(fs.stat(path.join(cwd, "openspec", "specs", "sample", "spec.md"))).rejects.toThrow();
}, 120_000);

test("native requirements are validated and acceptance uses the real archive without moving execution files", async () => {
	const { cwd, store, paths, write } = await fixture(true);
	await write(
		paths.requirements[0]!,
		"## Why\n\nProvide sample behavior.\n\n## What Changes\n\n- Add sample behavior.\n\n## Capabilities\n\n### New Capabilities\n- `sample`: sample behavior.\n\n### Modified Capabilities\n\nNone.\n\n## Impact\n\nSample public API.\n",
	);
	await write(
		paths.requirements[1]!.replace("*", "sample"),
		"## ADDED Requirements\n\n### Requirement: Sample\nThe system SHALL preserve sample behavior.\n\n#### Scenario: Works\n- **WHEN** the sample API is used\n- **THEN** the expected result is returned\n",
	);
	const specification = await store.readRequirements();
	await write(paths.solution, '{"candidates":[{"id":"sample","title":"Sample","content":"Complete solution."}]}');
	await write(paths.plan, "# Sample Implementation Plan\n\nUse the approved sample public API.\n");
	await write(paths.report, report);
	const result = await store.close({ specification, report: await store.readReport() });
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

test("contained paths reject traversal, devices, selectors and escaping junctions", async () => {
	const { cwd } = await fixture();
	for (const file of ["../escape", "xd://bash", "sample.md:1", "C:\\elsewhere"])
		await expect(containedSpecPath(cwd, file)).rejects.toThrow();
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-outside-"));
	roots.push(outside);
	await fs.symlink(outside, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
	await expect(containedSpecPath(cwd, "linked/file.md")).rejects.toThrow();
});
