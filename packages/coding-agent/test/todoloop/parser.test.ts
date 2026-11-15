import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseTodoLoop, readTodoLoop, validateTodoLoopChange } from "../../src/todoloop/parser";

const directories: string[] = [];

async function fixture(content: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "todoloop-parser-"));
	directories.push(directory);
	const filePath = path.join(directory, "ordinary tasks.md");
	await fs.writeFile(filePath, content);
	return filePath;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("TodoLoop file parsing", () => {
	it("retains full context, document order, non-contiguous ids and all list markers", async () => {
		const content = [
			"# Work",
			"Read [requirements](./requirements.md).",
			"",
			"- [x] 20.8 Previous work",
			"* [ ] 3 Next work  ",
			"  with indented acceptance\\",
			"    and a hard-break continuation",
			"+ [X] 1.9 Completed work",
			"2. [ ] 41 Ordered list task",
			"7) [ ] 5.2 Another task",
			"",
			"  Independent execution record.",
			"",
		].join("\r\n");
		const path = await fixture(content);
		const snapshot = await readTodoLoop(path);
		expect(snapshot.content).toBe(content);
		expect(snapshot.tasks).toEqual([
			{ id: "20.8", text: "Previous work", done: true, line: 4 },
			{
				id: "3",
				text: "Next work  \nwith indented acceptance\\\nand a hard-break continuation",
				done: false,
				line: 5,
			},
			{ id: "1.9", text: "Completed work", done: true, line: 8 },
			{ id: "41", text: "Ordered list task", done: false, line: 9 },
			{ id: "5.2", text: "Another task", done: false, line: 10 },
		]);
		expect(snapshot.groups.map(group => group.tasks)).toEqual([snapshot.tasks]);
		expect(await fs.readFile(path, "utf8")).toBe(content);
	});

	it("ignores both fence styles and indented code but retains real nested tasks", async () => {
		const path = await fixture(
			[
				"    - [~] bad indented example",
				"\t- [ ] no-number tabbed example",
				"```markdown",
				"- [ ] 9 Hidden",
				"~~~",
				"````",
				"~~~ markdown",
				"- [ ] 9 Also hidden",
				"~~~",
				"- [ ] 8 Parent",
				"    - [ ] 2 Child",
				"      - [X] 2.7 Grandchild",
				"",
				"            - [ ] bad nested code",
				"- Supporting examples",
				"  ~~~",
				"  - [ ] no-number fenced example",
				"  ~~~",
				"- ```md",
				"  - [ ] no-number list-fenced example",
				"  ```",
				"- [ ] 1 Outside",
				"- [A](./context.md)",
				"- [Reference][context]",
			].join("\n"),
		);
		expect((await readTodoLoop(path)).tasks.map(task => task.id)).toEqual(["8", "2", "2.7", "1"]);
	});

	it("retains nested tasks after tab-padded list markers at different tab stops", () => {
		const snapshot = parseTodoLoop(
			"-\t[x] 1 Parent\n      - [ ] 2 Child\n123.\t[x] 3 Ordered parent\n          - [ ] 4 Ordered child\n",
		);
		expect(snapshot.tasks).toEqual([
			{ id: "1", text: "Parent", done: true, line: 1 },
			{ id: "2", text: "Child", done: false, line: 2 },
			{ id: "3", text: "Ordered parent", done: true, line: 3 },
			{ id: "4", text: "Ordered child", done: false, line: 4 },
		]);
	});

	it("keeps deeply indented first-paragraph prose instead of treating it as a note", () => {
		const snapshot = parseTodoLoop("- [ ] 1 Work\n        must preserve this requirement\n\n  Execution note");
		expect(snapshot.tasks[0].text).toBe("Work\nmust preserve this requirement");
	});

	it("uses nonempty section ordinals, not task numbers, and retains duplicate and empty titles", () => {
		const snapshot = parseTodoLoop(
			[
				"# Background",
				"## Empty section",
				"## Shared title ##",
				"- [ ] 7 First",
				"### Details",
				"- [x] 40 Nested",
				"# Background inside section",
				"- [ ] 3 Still first section",
				"## Shared title",
				"- [ ] 1 Second",
				"##",
				"- [ ] 8 Untitled",
				"## Empty trailing section",
			].join("\n"),
		);
		expect(
			snapshot.groups.map(group => ({ id: group.id, title: group.title, ids: group.tasks.map(task => task.id) })),
		).toEqual([
			{ id: "1", title: "Shared title", ids: ["7", "40", "3"] },
			{ id: "2", title: "Shared title", ids: ["1"] },
			{ id: "3", title: "", ids: ["8"] },
		]);
		expect(snapshot.groups.flatMap(group => group.tasks)).toEqual(snapshot.tasks);
	});

	it("ignores fenced and indented headings when inferring the nearest real heading level", () => {
		const snapshot = parseTodoLoop(
			[
				"```md",
				"## Fenced",
				"- [ ] 100 Fenced task",
				"```",
				"~~~",
				"## Also fenced",
				"- [x] 101 Also fenced task",
				"~~~",
				"    ## Indented",
				"\t## Tabbed",
				"### Details only",
				"- [ ] 4 First",
				"",
				"    ## Indented after task",
				"- [ ] 9 Second",
				"##Not a heading",
			].join("\n"),
		);
		expect(snapshot.groups.map(group => ({ title: group.title, tasks: group.tasks }))).toEqual([
			{ title: "Details only", tasks: snapshot.tasks },
		]);
	});

	for (const level of [1, 2, 3, 4, 5, 6]) {
		it(`infers H${level} groups from a completed checkbox and freezes the level across rereads`, async () => {
			const heading = "#".repeat(level);
			const other = level === 6 ? "#" : "#".repeat(level + 1);
			const content = [
				"# Plan",
				`${heading} First`,
				"- [X] 1 Already done",
				`${other} Background before remaining work`,
				"- [ ] 2 Finish first",
				`${heading} Empty`,
				`${heading} Second`,
				"- [ ] 3 Finish second",
				"",
			].join("\n");
			const filePath = await fixture(content);
			const before = await readTodoLoop(filePath);
			expect(before.groups.map(group => group.tasks.map(task => task.id))).toEqual([["1", "2"], ["3"]]);
			await fs.writeFile(filePath, content.replace("[ ] 2", "[x] 2"));
			const completedFirst = await readTodoLoop(filePath);
			validateTodoLoopChange(before, completedFirst, "1");
			expect(completedFirst.groups.map(group => ({ id: group.id, ids: group.tasks.map(task => task.id) }))).toEqual([
				{ id: "1", ids: ["1", "2"] },
				{ id: "2", ids: ["3"] },
			]);
			expect(completedFirst.groups.find(group => group.tasks.some(task => !task.done))?.id).toBe("2");
			await fs.writeFile(filePath, completedFirst.content.replace("[ ] 3", "[x] 3"));
			validateTodoLoopChange(completedFirst, await readTodoLoop(filePath), "2");
		});
	}

	it("keeps a headerless first checkbox in one whole-file group despite later headings", async () => {
		const content = "- [x] 1 Prefix\n## Later\n- [ ] 2 Work\n### Child\n- [ ] 3 More\n## Final\n- [ ] 4 End";
		const filePath = await fixture(content);
		const before = await readTodoLoop(filePath);
		expect(before.groups.map(group => group.tasks.map(task => task.id))).toEqual([["1", "2", "3", "4"]]);
		await fs.writeFile(filePath, content.replace("[ ] 2", "[x] 2"));
		const after = await readTodoLoop(filePath);
		validateTodoLoopChange(before, after, before.groups[0].id);
		expect(after.groups.map(group => group.id)).toEqual(before.groups.map(group => group.id));
	});

	it("preserves original Superpowers syntax, numeric identities and group-local Step identities", async () => {
		const content = [
			"# Implementation Plan",
			"```markdown",
			"###### Example",
			"- [ ] **Step 99: Ignore this**",
			"```",
			"    ### Indented example",
			"    - [ ] **Step 99: Ignore this too**",
			"### Task: Shared",
			"- [X] **Step 1: Inspect `source.ts`**",
			"- [ ] **Step 2: Implement behavior**",
			"  preserving continuation\\",
			"",
			"## Chunk background, not a group",
			"- [ ] 1 Numeric task",
			"#### Checks",
			"- [ ] 1.2 Numeric child",
			"### Empty",
			"### Task: Shared",
			"- [ ] **Step 1: Inspect `source.ts`**",
			"",
		].join("\r\n");
		const filePath = await fixture(content);
		const snapshot = await readTodoLoop(filePath);
		expect(snapshot.content).toBe(content);
		expect(snapshot.groups.map(group => ({ id: group.id, ids: group.tasks.map(task => task.id) }))).toEqual([
			{ id: "1", ids: ["step:1:1", "step:1:2", "1", "1.2"] },
			{ id: "2", ids: ["step:2:1"] },
		]);
		expect(snapshot.tasks[0]).toEqual({
			id: "step:1:1",
			label: "Step 1",
			text: "Inspect `source.ts`",
			done: true,
			line: 9,
		});
		expect(snapshot.tasks[1].text).toBe("Implement behavior\npreserving continuation\\");
		expect(snapshot.tasks[2]).toEqual({ id: "1", text: "Numeric task", done: false, line: 14 });
		expect(snapshot.tasks[4].label).toBe("Step 1");
		expect(await fs.readFile(filePath, "utf8")).toBe(content);
	});

	it("assigns automatic identities to unnumbered text without colliding with explicit numbers", async () => {
		const snapshot = await readTodoLoop(
			await fixture("- [x] Previous work\n- [ ] 1..2 Work\n- [ ] 1 Numbered work\n- [ ] Next work\n"),
		);
		expect(snapshot.tasks.map(task => task.id)).toEqual(["auto:1", "auto:2", "1", "auto:4"]);
		expect(snapshot.tasks.map(task => task.done)).toEqual([true, false, false, false]);
		expect(snapshot.tasks[1].text).toBe("1..2 Work");
	});

	for (const [name, content, error] of [
		["duplicate id", "- [ ] 2 Work\n+ [X] 2 Other", /duplicate task number 2/],
		["empty body", "- [ ] 1.2   ", /empty task body/],
		["duplicate numeric across groups", "## One\n- [ ] 1 Work\n## Two\n- [ ] 1 Other", /duplicate task number 1/],
		[
			"duplicate Step in group",
			"### Work\n- [ ] **Step 1: Work**\n#### Detail\n- [x] **Step 1: Other**",
			/duplicate Step number 1/,
		],
		[
			"duplicate headerless Step",
			"- [ ] **Step 1: Work**\n## Later\n- [ ] **Step 1: Other**",
			/duplicate Step number 1/,
		],
		["missing Step number", "- [ ] **Step : Work**", /invalid Step task/],
		["invalid Step number", "- [ ] **Step 1.2: Work**", /invalid Step task/],
		["missing Step colon", "- [ ] **Step 1 Work**", /invalid Step task/],
		["unclosed Step bold", "- [ ] **Step 1: Work", /invalid Step task/],
		["single closing Step bold", "- [ ] **Step 1: Work*", /invalid Step task/],
		["empty Step body", "- [ ] **Step 1: **", /empty task body/],
		["missing Step body", "- [ ] **Step 1:**\n  continuation cannot supply the description", /empty task body/],
		["trailing Step content", "- [ ] **Step 1: Work** extra", /invalid Step task/],
		["invalid state", "- [~] 1 Work", /invalid checkbox state/],
		["empty state", "- [] 1 Work", /invalid checkbox state/],
		["padded state", "- [ x ] 1 Work", /invalid checkbox state/],
		["multi-character state", "- [WIP] 1 Work", /invalid checkbox state/],
		["missing closing bracket", "- [ ] 1 Work\n- [x 2 Other", /malformed checkbox/],
		["unclosed backtick fence", "- [ ] 1 Work\n```\n- [ ] 2 Hidden", /unclosed code fence/],
		["unclosed tilde fence", "~~~\n- [ ] 1 Hidden", /unclosed code fence/],
		["short closing fence", "````\n```\n- [ ] 1 Hidden", /unclosed code fence/],
		["wrong closing fence", "```\n~~~\n- [ ] 1 Hidden", /unclosed code fence/],
		["unclosed HTML comment", "## G\n- [x] A\n<!--\n- [ ] B\n", /unclosed HTML comment at line 3/],
		["no tasks", "# Background\nOnly prose", /no executable tasks/],
	] as const) {
		it(`rejects ${name} through the file consumer`, async () => {
			await expect(readTodoLoop(await fixture(content))).rejects.toThrow(error);
		});
	}
});

describe("TodoLoop Markdown format and update compatibility", () => {
	for (const { name, lines, eol, ids, next } of [
		{
			name: "Grill Todo unnumbered tasks with multiline Chinese acceptance",
			lines: [
				"## 组 1：配置闭环",
				"- [ ] 核对实施前置。",
				"  读取既有规格，不修改无关文件。",
				"  验收：所需检查通过。",
				"- [ ] 贯通配置入口。",
				"## 组 2：业务闭环",
				"- [ ] 完成业务验收。",
			],
			eol: "\n",
			ids: ["auto:1", "auto:2", "auto:3"],
			next: "auto:2",
		},
		{
			name: "OpenSpec numbered tasks in ordered lists with CRLF hard breaks",
			lines: [
				"## Implement",
				"1. [ ] 1.1 Load commands\\",
				"   Preserve external overrides.  ",
				"2) [ ] 1.2 Verify the public entry",
				"## Deliver",
				"+ [ ] 2.1 Record results",
			],
			eol: "\r\n",
			ids: ["1.1", "1.2", "2.1"],
			next: "1.2",
		},
		{
			name: "Superpowers Steps with CR newlines and group-local repeated numbers",
			lines: [
				"### Implement",
				"- [ ] **Step 1: Write the regression**",
				"  Exercise the real file consumer.",
				"* [ ] **Step 2: Fix the parser**",
				"### Deliver",
				"- [ ] **Step 1: Report evidence**",
			],
			eol: "\r",
			ids: ["step:1:1", "step:1:2", "step:2:1"],
			next: "step:1:2",
		},
		{
			name: "BOM-prefixed headerless nested tasks with tab-padded markers",
			lines: ["\uFEFF-\t[ ] Parent task", "      * [ ] 8 Child task", "+ [ ] Final task"],
			eol: "\n",
			ids: ["auto:1", "8", "auto:3"],
			next: "8",
		},
	] as const) {
		it(`continues ${name} after inline execution notes without a blank separator`, async () => {
			const content = lines.join(eol);
			const filePath = await fixture(content);
			const before = await readTodoLoop(filePath);
			expect(before.content).toBe(content);
			expect(before.tasks.map(task => task.id)).toEqual([...ids]);
			const first = before.tasks[0];
			const updated = [...lines] as string[];
			updated[first.line - 1] = updated[first.line - 1]!.replace("[ ]", "[x]");
			updated.splice(first.line - 1 + first.text.split("\n").length, 0, "    执行记录：定向检查通过。");
			await fs.writeFile(filePath, updated.join(eol));
			const after = await readTodoLoop(filePath);
			validateTodoLoopChange(before, after, "1");
			expect(after.tasks.map(task => task.id)).toEqual([...ids]);
			expect(after.tasks.map(task => task.done)).toEqual([true, ...ids.slice(1).map(() => false)]);
			expect(
				after.groups.find(group => group.tasks.some(task => !task.done))?.tasks.find(task => !task.done)?.id,
			).toBe(next);
			// A second progress refresh must accept further append-only evidence,
			// without allowing the previous record or original requirement to change.
			const continued = after.content.replace(
				"    执行记录：定向检查通过。",
				`    执行记录：定向检查通过。${eol}    补充记录：公开入口已核验。`,
			);
			await fs.writeFile(filePath, continued);
			const reread = await readTodoLoop(filePath);
			validateTodoLoopChange(after, reread, "1");
			expect(reread.tasks.filter(task => !task.done).map(task => task.id)).toEqual(ids.slice(1));
			await fs.writeFile(filePath, continued.replace("定向检查通过。", "未执行检查。"));
			const changed = await readTodoLoop(filePath);
			expect(() => validateTodoLoopChange(reread, changed, "1")).toThrow(/body changed|original content changed/);
		});
	}

	it("infers mixed Setext and ATX groups and freezes multiline Setext titles across rereads", async () => {
		const content = [
			"Implementation plan",
			"===================",
			"",
			"Build",
			"and verify",
			"----------",
			"- [ ] **Step 1: Implement**",
			"",
			"Review",
			"------",
			"- [ ] **Step 2: Inspect**",
			"## Deliver",
			"- [ ] **Step 3: Publish**",
		].join("\n");
		const filePath = await fixture(content);
		const before = await readTodoLoop(filePath);
		expect(before.groups.map(group => [group.title, group.tasks.map(task => task.id)])).toEqual([
			["Build\nand verify", ["step:1:1"]],
			["Review", ["step:2:2"]],
			["Deliver", ["step:3:3"]],
		]);
		await fs.writeFile(filePath, content.replace("[ ] **Step 1: Implement", "[x] **Step 1: Implement"));
		const after = await readTodoLoop(filePath);
		validateTodoLoopChange(before, after, "1");
		expect(after.groups.find(group => group.tasks.some(task => !task.done))?.title).toBe("Review");
		for (const changed of [
			after.content.replace("and verify", "and skip verification"),
			after.content.replace("Review\n------", "Review\n======"),
		]) {
			const parsed = parseTodoLoop(changed);
			expect(() => validateTodoLoopChange(after, parsed, "2")).toThrow(
				/heading structure changed|task group changed/,
			);
		}
	});

	it("retains BOM-prefixed ATX grouping and ignores headings and checkboxes inside HTML comments", async () => {
		const content = [
			"\uFEFF## Prepare",
			"<!--",
			"### Not a group",
			"- [~] Not a task",
			"```markdown",
			"-->", // A fence inside a comment must not hide the following real task.
			"- [ ] Prepare configuration",
			"  <!--",
			"  - [ ] Not a nested task",
			"  -->",
			"## Deliver",
			"<!-- - [ ] Also hidden -->",
			"* [ ] Verify entry",
		].join("\r\n");
		const filePath = await fixture(content);
		const before = await readTodoLoop(filePath);
		expect(before.groups.map(group => [group.title, group.tasks.map(task => task.id)])).toEqual([
			["Prepare", ["auto:1"]],
			["Deliver", ["auto:2"]],
		]);
		await fs.writeFile(filePath, content.replace("[ ] Prepare", "[X] Prepare"));
		const after = await readTodoLoop(filePath);
		validateTodoLoopChange(before, after, "1");
		expect(after.groups.find(group => group.tasks.some(task => !task.done))?.title).toBe("Deliver");
	});

	it("allows appending a record at EOF without requiring an extra trailing newline", async () => {
		const content = "## Finish\n- [ ] Record results\n  Preserve acceptance.\n";
		const filePath = await fixture(content);
		const before = await readTodoLoop(filePath);
		await fs.writeFile(filePath, `${content.replace("[ ]", "[x]")}  Execution: verified.`);
		const after = await readTodoLoop(filePath);
		validateTodoLoopChange(before, after, "1");
		expect(after.tasks.map(task => ({ id: task.id, done: task.done }))).toEqual([{ id: "auto:1", done: true }]);
		expect(after.tasks[0].text).toBe("Record results\nPreserve acceptance.\nExecution: verified.");
	});

	it("rejects a changed requirement or foreign inline note even when the current checkbox completes", async () => {
		const content = "## Current\n- [ ] Work\n  Required acceptance.\n## Later\n- [ ] Publish\n  Required review.\n";
		const filePath = await fixture(content);
		const before = await readTodoLoop(filePath);
		for (const changed of [
			content.replace("Required acceptance.", "Replaced acceptance.\n  Execution: passed."),
			content.replace("Required acceptance.", "Required acceptance. Changed."),
			content.replace("Required review.", "Required review.\n  Execution: foreign."),
		]) {
			await fs.writeFile(filePath, changed.replace("[ ] Work", "[x] Work"));
			const after = await readTodoLoop(filePath);
			expect(() => validateTodoLoopChange(before, after, "1")).toThrow(/body changed|original content changed/);
			expect(after.tasks[1].done).toBe(false);
		}
	});
});

const original =
	"# Work\n\n## Earlier\n- [x] 8 Earlier\n## Current\n- [ ] 3 Current\\\n  required continuation\n## Later\n- [ ] 1 Later\n";

describe("TodoLoop snapshot invariants", () => {
	it("scopes repeated Step 1 updates and append-only notes by full group identity on real rereads", async () => {
		const content = [
			"# Superpowers plan",
			"### Same task title",
			"- [ ] **Step 1: Run the check**",
			"",
			"  Original first-group evidence",
			"### Same task title",
			"- [ ] **Step 1: Run the check**",
			"",
			"  Original second-group evidence",
			"",
		].join("\n");
		const filePath = await fixture(content);
		const before = await readTodoLoop(filePath);
		const firstDone = content.replace("- [ ] **Step 1:", "- [x] **Step 1:");
		await fs.writeFile(filePath, firstDone);
		const wrongGroup = await readTodoLoop(filePath);
		expect(() => validateTodoLoopChange(before, wrongGroup, "2")).toThrow(/non-current group task step:1:1/);
		validateTodoLoopChange(before, wrongGroup, "1");
		const currentDone = firstDone
			.replace("- [ ] **Step 1:", "- [X] **Step 1:")
			.replace(
				"  Original second-group evidence",
				"  Original second-group evidence\n\n  Current-group check passed",
			);
		await fs.writeFile(filePath, currentDone);
		const after = await readTodoLoop(filePath);
		validateTodoLoopChange(wrongGroup, after, "2");
		expect(after.tasks.map(task => task.id)).toEqual(["step:1:1", "step:2:1"]);
		expect(after.groups.every(group => group.tasks.every(task => task.done))).toBe(true);
		for (const changed of [
			currentDone.replace("[x] **Step 1:", "[X] **Step 1:"),
			currentDone.replace("Original first-group evidence", "Changed first-group evidence"),
			currentDone.replace("Original second-group evidence", "Changed second-group evidence"),
			currentDone.replace(
				"  Original first-group evidence",
				"  Original first-group evidence\n\n  Wrong-group note",
			),
		]) {
			await fs.writeFile(filePath, changed);
			expect(() => validateTodoLoopChange(after, parseTodoLoop(changed), "2")).toThrow(/original content changed/);
		}
	});

	it("rejects changing Step identities, group boundaries and immutable raw bold source", () => {
		const content = "### First\n- [ ] **Step 1: Work**\n### Second\n- [ ] **Step 1: Work**\n";
		const before = parseTodoLoop(content);
		for (const changed of [
			content.replace("**Step 1: Work**", "**Step 2: Work**"),
			content.replace("### Second", "## Second"),
			content.replace("### First", "#### First"),
			content.replace("**Step 1: Work**", "**Step 1:  Work**"),
		]) {
			expect(() => validateTodoLoopChange(before, parseTodoLoop(changed), "1")).toThrow();
		}
	});

	it("accepts current completion and append-only independent notes despite changed line numbers", async () => {
		const path = await fixture(original);
		const before = await readTodoLoop(path);
		await fs.writeFile(
			path,
			original
				.replace("[ ] 3", "[X] 3")
				.replace("## Later", "\n  Verified with targeted checks.\n  - Detailed result\n## Later"),
		);
		const after = await readTodoLoop(path);
		validateTodoLoopChange(before, after, "2");
		expect(after.tasks[2].line).toBe(before.tasks[2].line + 3);
		expect(after.tasks[1].done).toBe(true);
		await fs.writeFile(path, after.content.replace("## Later", "\n  Additional retry evidence.\n## Later"));
		expect(() => validateTodoLoopChange(after, before, "2")).toThrow(/unchecked/);
		expect(() => validateTodoLoopChange(after, parseTodoLoop(after.content), "missing")).toThrow(
			/unknown current group/,
		);
		const continued = await readTodoLoop(path);
		validateTodoLoopChange(after, continued, "2");
		expect(continued.tasks.map(task => ({ id: task.id, done: task.done }))).toEqual([
			{ id: "8", done: true },
			{ id: "3", done: true },
			{ id: "1", done: false },
		]);
		expect(continued.tasks[2].line).toBe(after.tasks[2].line + 2);
		expect(continued.content).toContain("Additional retry evidence.");
	});

	it("permits standalone bullet notes and unchanged dispatch-time snapshots", async () => {
		const filePath = await fixture(original);
		const before = await readTodoLoop(filePath);
		const unchanged = await readTodoLoop(filePath);
		validateTodoLoopChange(before, unchanged);
		expect(unchanged.tasks.find(task => !task.done)?.id).toBe("3");
		await fs.writeFile(filePath, original.replace("## Later", "  - Execution: complete\n## Later"));
		const after = await readTodoLoop(filePath);
		validateTodoLoopChange(before, after, "2");
		expect(after.tasks.map(task => task.id)).toEqual(["8", "3", "1"]);
		expect(after.tasks[2].line).toBe(before.tasks[2].line + 1);
		expect(after.content).toContain("  - Execution: complete\n");
		expect(() => validateTodoLoopChange(before, after)).toThrow(/original content changed/);
	});

	for (const [name, transform, error] of [
		["task addition", (value: string) => `${value}- [ ] 7 New\n`, /added or removed/],
		["task removal", (value: string) => value.replace("- [ ] 1 Later\n", ""), /added or removed/],
		["id rename", (value: string) => value.replace("[ ] 3", "[ ] 4"), /number or order/],
		[
			"task reorder",
			(value: string) =>
				value.replace("- [x] 8 Earlier\n", "").replace("- [ ] 1 Later", "- [x] 8 Earlier\n- [ ] 1 Later"),
			/number or order/,
		],
		["first-line rename", (value: string) => value.replace("3 Current", "3 Changed"), /body changed/],
		[
			"continuation change",
			(value: string) => value.replace("required continuation", "changed continuation"),
			/body changed/,
		],
		[
			"body hidden as note",
			(value: string) => value.replace("  required continuation", "\n  changed continuation"),
			/body changed/,
		],
		["hard-break change", (value: string) => value.replace("Current\\", "Current  "), /body changed/],
		["other group task completed", (value: string) => value.replace("[ ] 1", "[x] 1"), /non-current group/],
		["completed task unchecked", (value: string) => value.replace("[x] 8", "[ ] 8"), /was unchecked/],
		[
			"completed checkbox spelling changed",
			(value: string) => value.replace("[x] 8", "[X] 8"),
			/original content changed/,
		],
		["context changed", (value: string) => value.replace("# Work", "# New work"), /original content changed/],
		[
			"other task note",
			(value: string) => value.replace("- [ ] 3", "  - Unrelated note\n- [ ] 3"),
			/original content changed/,
		],
	] as const) {
		it(`stops on ${name} after rereading the file`, async () => {
			const path = await fixture(original);
			const before = await readTodoLoop(path);
			await fs.writeFile(path, transform(original));
			const after = await readTodoLoop(path);
			expect(() => validateTodoLoopChange(before, after, "2")).toThrow(error);
		});
	}

	it("does not allow editing or deleting an existing independent record", async () => {
		const content = original.replace("## Later", "\n  Original evidence\n## Later");
		const path = await fixture(content);
		const before = await readTodoLoop(path);
		for (const replacement of ["Changed evidence", ""]) {
			await fs.writeFile(path, content.replace("  Original evidence\n", replacement ? `  ${replacement}\n` : ""));
			const after = await readTodoLoop(path);
			expect(() => validateTodoLoopChange(before, after, "2")).toThrow(/original content changed/);
		}
	});

	it("accepts several advances and separate notes throughout one group, including completed members", () => {
		const content = "## Batch\n- [x] 7 Done\n- [ ] 8 First\n- [ ] 9 Second\n## Next\n- [ ] 10 Later\n";
		const before = parseTodoLoop(content);
		const after = parseTodoLoop(
			content
				.replace("- [ ] 8", "\n  Existing-work evidence\n- [x] 8")
				.replace("- [ ] 9", "\n  First-work evidence\n- [X] 9")
				.replace("## Next", "\n  Second-work evidence\n## Next"),
		);
		validateTodoLoopChange(before, after, "1");
		expect(after.groups[0].tasks.every(task => task.done)).toBe(true);
		expect(after.groups[1].tasks[0].done).toBe(false);
		expect(() => validateTodoLoopChange(before, after)).toThrow(/non-current group/);
		expect(() => validateTodoLoopChange(before, after, "8")).toThrow(/unknown current group/);
	});

	it("keeps empty section boundaries and deeper headings immutable instead of treating them as notes", () => {
		const content = "## Batch\n- [ ] 8 First\n\n### Detail\nOriginal detail\n## Empty\n## Next\n- [ ] 9 Later\n";
		const before = parseTodoLoop(content);
		for (const changed of [
			content.replace("## Empty\n", ""),
			content.replace("## Empty", "## Renamed"),
			content.replace("## Empty", "## Extra\n## Empty"),
			content.replace("### Detail", "### Changed"),
			content.replace("### Detail", "### Added\n### Detail"),
			content.replace("### Detail", "## Hidden appended group\n### Detail"),
			content.replace("Original detail", "Original detail\n\n  Misplaced task note"),
			`${content}\n## Empty trailing group`,
		]) {
			expect(() => validateTodoLoopChange(before, parseTodoLoop(changed), "1")).toThrow(/original content changed/);
		}
	});

	it("rejects moving a task across otherwise unchanged duplicate headings", () => {
		const before = parseTodoLoop("## Same\n- [ ] 8 First\n## Same\n- [ ] 9 Second\n");
		const after = parseTodoLoop("## Same\n## Same\n- [ ] 8 First\n- [ ] 9 Second\n");
		expect(() => validateTodoLoopChange(before, after, "1")).toThrow(/task group changed/);
	});

	it("propagates read failures and reparsing failures without returning a cached snapshot", async () => {
		const path = await fixture(original);
		const before = await readTodoLoop(path);
		await fs.writeFile(path, original.replace("[ ] 3", "[~] 3"));
		await expect(readTodoLoop(path)).rejects.toThrow(/invalid checkbox state/);
		expect(() =>
			validateTodoLoopChange(before, { content: "```", tasks: before.tasks, groups: before.groups }, "2"),
		).toThrow(/unclosed code fence/);
		await fs.rm(path);
		await expect(readTodoLoop(path)).rejects.toThrow();
		expect(before.tasks[1].done).toBe(false);
	});
});
