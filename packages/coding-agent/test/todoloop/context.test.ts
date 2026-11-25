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
 * It consumes the rendered package and real Markdown references to perform a group's
 * file tasks. Native dispatch owns fresh sessions,
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
	const fragments: string[] = [];
	for (const filePath of new Set(references)) {
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

	test("packages BOM-prefixed CR-only task lines without losing original text or continuation delimiters", async () => {
		const cwd = await workspace();
		const filePath = path.join(cwd, "work.md");
		await writeFile(filePath, "\uFEFF- [ ] 1 First\r  Keep this acceptance.\r- [ ] 2 Second\r");
		const pkg = taskPackage(await build(filePath, cwd));
		expect(pkg.group.tasks).toEqual([
			{ id: "1", label: "1", raw: "\uFEFF- [ ] 1 First\r  Keep this acceptance." },
			{ id: "2", label: "2", raw: "- [ ] 2 Second" },
		]);
	});

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
});
