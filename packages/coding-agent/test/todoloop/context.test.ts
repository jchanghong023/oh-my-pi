import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildTodoLoopGroupPrompt, type TodoLoopPreviousAttempt } from "../../src/todoloop/context";
import { readTodoLoop } from "../../src/todoloop/parser";

interface TaskPackage {
	cwd: string;
	filePath: string;
	group: { id: string; title: string; tasks: { id: string; label: string; raw: string }[] };
	completedTaskIds: string[];
	attempt: number;
	previous?: TodoLoopPreviousAttempt;
	materials?: { proposal: string; design?: string; deltaSpecs: string[] };
}

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-todoloop-context-"));
	roots.push(root);
	return root;
}

async function writeFile(filePath: string, content: string): Promise<void> {
	await Bun.write(filePath, content);
}

function taskPackage(rendered: string): TaskPackage {
	const match = /```json\r?\n([\s\S]*?)\r?\n```/.exec(rendered);
	if (!match) throw new Error("Missing task package");
	return JSON.parse(match[1]!) as TaskPackage;
}

async function build(filePath: string, cwd: string, previous?: TodoLoopPreviousAttempt): Promise<string> {
	const snapshot = await readTodoLoop(path.resolve(cwd, filePath));
	return buildTodoLoopGroupPrompt({
		filePath,
		cwd,
		group: snapshot.groups.find(group => group.tasks.some(task => !task.done))!,
		attempt: previous ? 2 : 1,
		previous,
	});
}

/**
 * Deterministic file consumer, NOT a native agent/model obedience test.
 * It consumes the rendered package, real Markdown references, and material
 * constraints to perform a group's file tasks. Native dispatch owns fresh sessions,
 * tools, cwd enforcement, and conversation isolation; its next-stage tests must
 * pass buildTodoLoopGroupPrompt's output through the real task bridge.
 */
async function consumeFiles(rendered: string): Promise<{ reads: string[]; output: string }> {
	const input = taskPackage(rendered);
	const reads: string[] = [];
	async function read(filePath: string): Promise<string> {
		reads.push(filePath);
		return Bun.file(filePath).text();
	}
	const tasks = await read(input.filePath);
	const references = [...tasks.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match =>
		path.resolve(path.dirname(input.filePath), match[1]!),
	);
	const materials = input.materials
		? [
				input.materials.proposal,
				...(input.materials.design ? [input.materials.design] : []),
				...input.materials.deltaSpecs,
			]
		: [];
	const fragments: string[] = [];
	for (const filePath of new Set([...references, ...materials])) {
		const content = await read(filePath);
		for (const match of content.matchAll(/^Output fragment: (.+)$/gm)) fragments.push(match[1]!);
	}
	if (fragments.length === 0) throw new Error("No readable output constraints");
	const output = path.join(input.cwd, "result.txt");
	const existing = await read(output);
	await Bun.write(output, existing + fragments.join("|"));
	const lines = tasks.split("\n");
	const snapshot = await readTodoLoop(input.filePath);
	const group = snapshot.groups.find(group => group.id === input.group.id);
	for (const task of input.group.tasks) {
		const located = group?.tasks.find(candidate => candidate.id === task.id);
		if (!located || lines[located.line - 1]?.replace(/\r$/, "") !== task.raw.split("\n")[0]?.replace(/\r$/, ""))
			throw new Error("Packaged task original absent from assigned group");
		lines[located.line - 1] = lines[located.line - 1]!.replace("[ ]", "[x]");
	}
	await Bun.write(input.filePath, lines.join("\n"));
	return { reads, output };
}

describe("TodoLoop group file context", () => {
	test("consumes ordinary file explicit references in session cwd and preserves earlier work", async () => {
		const cwd = await workspace();
		const filePath = path.join(cwd, "notes with spaces", "work.md");
		const reference = path.join(path.dirname(filePath), "requirements.md");
		const original =
			"# Work\n\nRead [requirements](requirements.md).\n\n## Active\n- [x] 9 Earlier work\n- [ ] 2 Write result.txt using material output fragments\n  Preserve the existing prefix.\n- [ ] 3 Continue in same context\n## Later\n- [ ] 1 Later work\n";
		await writeFile(filePath, original);
		await writeFile(reference, "# Requirement\nOutput fragment: ordinary Ω\n");
		await writeFile(path.join(path.dirname(filePath), "proposal.md"), "Output fragment: unrelated\n");
		await writeFile(path.join(cwd, "result.txt"), "prior edit:");
		const rendered = await build(path.relative(cwd, filePath), cwd);
		const pkg = taskPackage(rendered);
		expect(pkg.group.tasks.map(task => task.id)).toEqual(["2", "3"]);
		expect(pkg.group.tasks.map(task => task.label)).toEqual(["2", "3"]);
		expect(pkg.group.tasks[0]?.raw).toBe(
			"- [ ] 2 Write result.txt using material output fragments\n  Preserve the existing prefix.",
		);
		expect(pkg.completedTaskIds).toEqual(["9"]);
		const consumed = await consumeFiles(rendered);
		expect(consumed.reads).toContain(reference);
		expect(await Bun.file(consumed.output).text()).toBe("prior edit:ordinary Ω");
		expect(await Bun.file(filePath).text()).toBe(
			original.replace("- [ ] 2", "- [x] 2").replace("- [ ] 3", "- [x] 3"),
		);
		expect(await fs.readdir(path.dirname(filePath))).not.toContain("result.txt");
	});

	test("packages CR-only task lines without losing original text or continuation delimiters", async () => {
		const cwd = await workspace();
		const filePath = path.join(cwd, "work.md");
		await writeFile(filePath, "# Work\r## Active\r- [ ] 1 First\r  Keep this acceptance.\r- [ ] 2 Second\r");
		const pkg = taskPackage(await build(filePath, cwd));
		expect(pkg.group.tasks).toEqual([
			{ id: "1", label: "1", raw: "- [ ] 1 First\r  Keep this acceptance." },
			{ id: "2", label: "2", raw: "- [ ] 2 Second" },
		]);
	});

	test("consumes repeated Superpowers Step labels by scoped identity and retries only remaining raw tasks", async () => {
		const cwd = await workspace();
		const filePath = path.join(cwd, "work.md");
		const original = [
			"# Implementation Plan",
			"[rules](rules.md)",
			"```markdown",
			"- [ ] **Step 1: Write result.txt using material output fragments**",
			"```",
			"## Chunk 1",
			"### Task 7: Write artifacts",
			"- [X] **Step 0: Existing work**",
			"#### Instructions",
			"- [ ] **Step 1: Write result.txt using material output fragments**",
			"  Preserve `existing` content.",
			"- [ ] **Step 2: Continue in the same context**",
			"## Chunk 2",
			"### Task 7: Write artifacts",
			"- [ ] **Step 1: Write result.txt using material output fragments**",
			"",
		].join("\r\n");
		await writeFile(filePath, original);
		await writeFile(path.join(cwd, "rules.md"), "Output fragment: Ω");
		await writeFile(path.join(cwd, "result.txt"), "kept:");
		const rendered = await build(filePath, cwd);
		const first = taskPackage(rendered);
		expect(first.group.id).toBe("1");
		expect(first.group.tasks).toEqual([
			{
				id: "step:1:1",
				label: "Step 1",
				raw: "- [ ] **Step 1: Write result.txt using material output fragments**\r\n  Preserve `existing` content.",
			},
			{ id: "step:1:2", label: "Step 2", raw: "- [ ] **Step 2: Continue in the same context**" },
		]);
		expect(first.completedTaskIds).toEqual(["step:1:0"]);
		// Consume only the first task, as a partially successful fresh executor would.
		const partial = rendered.replace(
			JSON.stringify(first, null, 2),
			JSON.stringify({ ...first, group: { ...first.group, tasks: first.group.tasks.slice(0, 1) } }, null, 2),
		);
		await consumeFiles(partial);
		const retry = await build(filePath, cwd, { text: "partial", observation: "Step 2 remains" });
		const retryPackage = taskPackage(retry);
		expect(retryPackage.group.tasks).toEqual([first.group.tasks[1]!]);
		expect(retryPackage.completedTaskIds).toEqual(["step:1:0", "step:1:1"]);
		await consumeFiles(retry);
		const next = await build(filePath, cwd);
		expect(taskPackage(next).group.tasks).toEqual([
			{
				id: "step:2:1",
				label: "Step 1",
				raw: "- [ ] **Step 1: Write result.txt using material output fragments**",
			},
		]);
		await consumeFiles(next);
		expect(await Bun.file(path.join(cwd, "result.txt")).text()).toBe("kept:ΩΩΩ");
		expect(await Bun.file(filePath).text()).toBe(
			original.replaceAll("[ ]", "[x]").replace("```markdown\r\n- [x]", "```markdown\r\n- [ ]"),
		);
	});

	for (const withDesign of [true, false]) {
		test(`consumes same Change proposal and delta constraints ${withDesign ? "with" : "without"} optional design`, async () => {
			const cwd = await workspace();
			const change = path.join(cwd, "openspec", "changes", "sample");
			const filePath = path.join(change, "tasks.md");
			const proposal = path.join(change, "proposal.md");
			const design = path.join(change, "design.md");
			const delta = path.join(change, "specs", "result", "spec.md");
			await writeFile(
				filePath,
				"# Task\n\n## Active\n- [ ] 1 Write result.txt using material output fragments\n## Later\n- [ ] 2 Later\n",
			);
			await writeFile(proposal, "# Proposal\nOutput fragment: proposal\n");
			await writeFile(delta, "# Result delta\nOutput fragment: delta\n");
			if (withDesign) await writeFile(design, "# Design\nOutput fragment: design\n");
			await writeFile(path.join(cwd, "result.txt"), "kept:");
			await writeFile(
				path.join(cwd, "openspec", "changes", "other", "proposal.md"),
				"Output fragment: wrong-change\n",
			);
			const rendered = await build(filePath, cwd);
			const consumed = await consumeFiles(rendered);
			expect(consumed.reads).toContain(proposal);
			expect(consumed.reads).toContain(delta);
			expect(consumed.reads.includes(design)).toBe(withDesign);
			expect(await Bun.file(consumed.output).text()).toBe(
				withDesign ? "kept:proposal|design|delta" : "kept:proposal|delta",
			);
			expect((await readTodoLoop(filePath)).tasks.map(task => task.done)).toEqual([true, false]);
			if (!withDesign) expect(await fs.readdir(change)).not.toContain("design.md");
		});
	}

	test("reads updated reference constraints on retry without losing prior edits", async () => {
		const cwd = await workspace();
		const filePath = path.join(cwd, "work.md");
		const reference = path.join(cwd, "rules.md");
		await writeFile(
			filePath,
			"# Work\n[rules](rules.md)\n\n- [ ] 1 Write result.txt using material output fragments\n",
		);
		await writeFile(reference, "Output fragment: stale\n");
		await writeFile(path.join(cwd, "result.txt"), "first-attempt:");
		await build(filePath, cwd);
		await Bun.write(reference, "Output fragment: changed\n");
		const previous = { text: "Partial file edit retained", observation: "Current item remains unchecked" };
		const rendered = await build(filePath, cwd, previous);
		const consumed = await consumeFiles(rendered);
		expect(await Bun.file(consumed.output).text()).toBe("first-attempt:changed");
	});

	test("reports missing or unreadable required/discovered materials without generation", async () => {
		const cwd = await workspace();
		const change = path.join(cwd, "openspec", "changes", "broken");
		const filePath = path.join(change, "tasks.md");
		await writeFile(filePath, "- [ ] 1 Work\n");
		await expect(build(filePath, cwd)).rejects.toThrow();
		await writeFile(path.join(change, "proposal.md"), "# Proposal\n");
		// A directory at a material path fails portably; no chmod/root dependence.
		await fs.mkdir(path.join(change, "design.md"));
		await expect(build(filePath, cwd)).rejects.toThrow();
		await fs.rmdir(path.join(change, "design.md"));
		await fs.mkdir(path.join(change, "specs", "broken-capability", "spec.md"), { recursive: true });
		await expect(build(filePath, cwd)).rejects.toThrow();
		expect(await fs.readdir(change)).not.toContain("design.md");
	});
});
