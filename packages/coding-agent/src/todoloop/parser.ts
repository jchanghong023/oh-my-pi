import * as fs from "node:fs/promises";
import { Lexer, type Links } from "@oh-my-pi/pi-utils/marked";
import { CloserIndexes } from "@oh-my-pi/pi-utils/marked/inline-closers";

export interface TodoLoopTask {
	id: string;
	/** Human-readable identity for Superpowers steps and unnumbered tasks. */
	label?: string;
	text: string;
	done: boolean;
	/** One-based checkbox line; identity is always the task id. */
	line: number;
}

export interface TodoLoopGroup {
	id: string;
	title: string;
	tasks: TodoLoopTask[];
}

export interface TodoLoopSnapshot {
	content: string;
	tasks: TodoLoopTask[];
	groups: TodoLoopGroup[];
}

// Adapted from OpenSpec's task-progress.ts list and paragraph recognition.
// Kept independent: TodoLoop rejects malformed tasks and excludes code examples.
const LIST_PATTERN = /^( *)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const TEXT_BREAK_PATTERN = /^(?:\s*$|\s*#{1,6}(?:\s|$)|\s*>|\s*<[!?]|\s*(?:=+|-+)\s*$|\s*([-*_])(?:\s*\1){2,}\s*$)/;

interface LocatedTask {
	task: TodoLoopTask;
	/** Section identity includes empty sections, unlike dispatched group ids. */
	section: number;
	contentIndent: number;
	/** First subsequent list item outside this task. */
	nextListLine?: number;
}

interface ParsedDocument {
	lines: string[];
	located: LocatedTask[];
	groups: TodoLoopGroup[];
	headings: { line: number; raw: string }[];
}

function expandIndent(line: string): string {
	let column = 0;
	const prefix = line.match(/^[ \t]*/)?.[0] ?? "";
	for (const char of prefix) column += char === "\t" ? 4 - (column % 4) : 1;
	return " ".repeat(column) + line.slice(prefix.length);
}

/** Find a comment that continues onto the next line, excluding literal Markdown. */
function unclosedCommentStart(line: string): number {
	if (!line.includes("<!--")) return -1;
	const markers = /\\[\\`<]|`+|<!--/g;
	let indexes: CloserIndexes | undefined;
	for (let marker = markers.exec(line); marker; marker = markers.exec(line)) {
		if (marker[0] === "<!--") {
			const close = line.indexOf("-->", markers.lastIndex);
			if (close === -1) return marker.index;
			markers.lastIndex = close + 3;
		} else if (marker[0][0] === "`") {
			indexes ??= new CloserIndexes(line);
			const width = marker[0].length;
			const close = indexes.codeRuns.closerAfter(markers.lastIndex, width);
			if (close !== -1) markers.lastIndex = close + width;
		}
	}
	return -1;
}

function parseDocument(content: string): ParsedDocument {
	const lines = content.split(/\r\n|\n|\r/);
	// A terminal newline is a line delimiter, not an immutable empty paragraph.
	if (lines.at(-1) === "") lines.pop();
	const located: LocatedTask[] = [];
	const sections: { title: string; tasks: TodoLoopTask[]; steps: Set<string> }[] = [
		{ title: "Default", tasks: [], steps: new Set() },
	];
	const headings: ParsedDocument["headings"] = [];
	const ids = new Set<string>();
	const lists: number[] = [];
	let current: LocatedTask | undefined;
	let fence: { char: string; length: number; base: number; line: number } | undefined;
	let commentLine: number | undefined;
	let paragraph: { start: number; title: string } | undefined;
	let nearestHeading: { level: number; title: string } | undefined;
	let groupLevel: number | undefined;
	let groupCount = 0;
	let shortcutReferences: Links | undefined;

	for (let index = 0; index < lines.length; index++) {
		let raw = lines[index];
		let line = expandIndent(index === 0 && raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
		const indent = line.length - line.trimStart().length;
		if (fence) {
			const closing = line.trimStart().match(/^(`+|~+)[ \t]*$/)?.[1];
			if (indent <= fence.base + 3 && closing?.[0] === fence.char && closing.length >= fence.length) {
				fence = undefined;
			}
			continue;
		}
		if (commentLine !== undefined) {
			const close = line.indexOf("-->");
			if (close !== -1) {
				commentLine = unclosedCommentStart(line.slice(close + 3)) === -1 ? undefined : index + 1;
			}
			current = undefined;
			paragraph = undefined;
			continue;
		}
		if (!line.trim()) {
			current = undefined;
			paragraph = undefined;
			continue;
		}
		while (lists.length && indent < lists[lists.length - 1]) lists.pop();
		const base = lists.at(-1) ?? 0;
		// Four spaces relative to the containing list denote code, not a child list.
		if (indent >= base + 4) {
			// An indented continuation of an open paragraph is still task prose.
			if (current) {
				current.task.text += `\n${raw.trimStart()}`;
			}
			continue;
		}
		if (line.trimStart().startsWith("<!--")) {
			if (unclosedCommentStart(line) !== -1) commentLine = index + 1;
			current = undefined;
			paragraph = undefined;
			continue;
		}
		const opening = line.trimStart().match(/^(`{3,}|~{3,})(.*)$/);
		if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
			fence = { char: opening[1][0], length: opening[1].length, base, line: index + 1 };
			current = undefined;
			paragraph = undefined;
			continue;
		}
		let list = line.match(LIST_PATTERN);
		let contentIndent = indent;
		if (list) {
			const previousTask = located.at(-1);
			if (previousTask && previousTask.nextListLine === undefined && indent < previousTask.contentIndent) {
				previousTask.nextListLine = index + 1;
			}
			const markerEnd = indent + list[2].length;
			contentIndent = markerEnd;
			for (const char of list[3]) contentIndent += char === "\t" ? 4 - (contentIndent % 4) : 1;
			// Five or more columns after the marker mean one column of list
			// padding followed by indented code, not a checkbox or a fence.
			if (contentIndent > markerEnd + 4) {
				lists.push(markerEnd + 1);
				current = undefined;
				paragraph = undefined;
				continue;
			}
		}
		const listFence = list?.[4].match(/^(`{3,}|~{3,})(.*)$/);
		const startsListFence = listFence && !(listFence[1][0] === "`" && listFence[2].includes("`"));
		if (!startsListFence) {
			const comment = unclosedCommentStart(line);
			if (comment !== -1) {
				commentLine = index + 1;
				raw = raw.slice(0, raw.length - (line.length - comment));
				line = line.slice(0, comment).trimEnd();
				list = line.match(LIST_PATTERN);
			}
		}
		const heading = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);
		const setext = paragraph && line.match(/^ {0,3}(=+|-+)[ \t]*$/);
		if (heading || setext) {
			const start = heading ? index : paragraph!.start;
			for (let position = start; position <= index; position++) {
				headings.push({ line: position + 1, raw: lines[position] });
			}
			const level = heading ? heading[1].length : setext![1][0] === "=" ? 1 : 2;
			const title = heading ? (heading[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim() : paragraph!.title;
			nearestHeading = { level, title };
			paragraph = undefined;
			if (located.length && level === groupLevel) {
				sections.push({ title, tasks: [], steps: new Set() });
			}
			current = undefined;
			continue;
		}
		if (list) {
			current = undefined;
			paragraph = undefined;
			lists.push(contentIndent);
			if (startsListFence) {
				fence = {
					char: listFence[1][0],
					length: listFence[1].length,
					base: contentIndent,
					line: index + 1,
				};
				continue;
			}
			const checkbox = list[4].match(/^\[([^\]]*)\](.*)$/);
			if (!checkbox) {
				if (list[4].startsWith("[ ") || /^\[[xX](?:\s|$)/.test(list[4])) {
					throw new Error(`TodoLoop: malformed checkbox at line ${index + 1}`);
				}
				continue;
			}
			// Markdown links are context, not checkboxes (including one-letter labels).
			if (/^[([]/.test(checkbox[2]) && checkbox[1] !== " ") continue;
			if (![" ", "x", "X"].includes(checkbox[1])) {
				shortcutReferences ??= Lexer.lex(content.replace(/^\uFEFF/, "")).links;
				const label = checkbox[1].replace(/\s+/g, " ").toLowerCase();
				if (Object.hasOwn(shortcutReferences, label)) continue;
				throw new Error(`TodoLoop: invalid checkbox state at line ${index + 1}`);
			}
			// The first real checkbox, including an already completed one, fixes
			// grouping for every subsequent read independently of remaining work.
			if (!located.length && nearestHeading) {
				groupLevel = nearestHeading.level;
				sections[0].title = nearestHeading.title;
			}
			const section = sections[sections.length - 1];
			if (!section.tasks.length) groupCount++;
			const body = checkbox[2].trimStart();
			const step = body.match(/^\*\*Step (\d+):[ \t]*(.*?)\*\*[ \t]*$/);
			let task: TodoLoopTask;
			if (step) {
				const number = step[1];
				if (!step[2].trim()) throw new Error(`TodoLoop: empty task body for Step ${number} at line ${index + 1}`);
				if (section.steps.has(number)) {
					throw new Error(`TodoLoop: duplicate Step number ${number} at line ${index + 1}`);
				}
				section.steps.add(number);
				task = {
					id: `step:${groupCount}:${number}`,
					label: `Step ${number}`,
					text: step[2],
					done: checkbox[1] !== " ",
					line: index + 1,
				};
			} else {
				const identity = body.match(/^(\d+(?:\.\d+)*)(?:[ \t]+(.*)|$)/);
				if (!identity && /^\*\*Step\b/.test(body)) {
					throw new Error(`TodoLoop: invalid Step task at line ${index + 1}`);
				}
				const id = identity?.[1] ?? `auto:${located.length + 1}`;
				if (ids.has(id)) throw new Error(`TodoLoop: duplicate task number ${id} at line ${index + 1}`);
				ids.add(id);
				task = {
					id,
					label: identity ? undefined : String(located.length + 1),
					text: identity ? (identity[2] ?? "") : body,
					done: checkbox[1] !== " ",
					line: index + 1,
				};
			}
			current = { task, section: sections.length - 1, contentIndent };
			section.tasks.push(task);
			located.push(current);
		} else if (current && !TEXT_BREAK_PATTERN.test(line)) {
			// Preserve hard breaks and all continuation prose, unlike a first-line-only parser.
			current.task.text += `\n${raw.trimStart()}`;
		} else {
			current = undefined;
			if (!lists.length && !TEXT_BREAK_PATTERN.test(line)) {
				if (paragraph) paragraph.title += `\n${line.trim()}`;
				else paragraph = { start: index, title: line.trim() };
			} else paragraph = undefined;
		}
	}
	if (fence) throw new Error(`TodoLoop: unclosed code fence at line ${fence.line}`);
	if (commentLine !== undefined) throw new Error(`TodoLoop: unclosed HTML comment at line ${commentLine}`);
	for (const { task } of located) {
		if (!task.text.trim()) throw new Error(`TodoLoop: empty task body for ${task.id} at line ${task.line}`);
	}
	if (!located.length) throw new Error("TodoLoop: no executable tasks in file");
	const groups = sections
		.filter(section => section.tasks.length > 0)
		.map((section, index) => ({ id: String(index + 1), title: section.title, tasks: section.tasks }));
	return { lines, located, groups, headings };
}

export function parseTodoLoop(content: string): TodoLoopSnapshot {
	const parsed = parseDocument(content);
	return { content, tasks: parsed.located.map(({ task }) => task), groups: parsed.groups };
}

export async function readTodoLoop(filePath: string): Promise<TodoLoopSnapshot> {
	// Bun.file().text() removes a UTF-8 BOM; snapshots must preserve the source.
	return parseTodoLoop(await fs.readFile(filePath, "utf8"));
}

/** Freeze the original document; only current-group checkboxes and appended notes may change. */
export function validateTodoLoopChange(
	before: TodoLoopSnapshot,
	after: TodoLoopSnapshot,
	currentGroupId?: string,
): void {
	const previous = parseDocument(before.content);
	const next = parseDocument(after.content);
	if (previous.located.length !== next.located.length) throw new Error("TodoLoop: tasks added or removed");
	if (
		previous.headings.length !== next.headings.length ||
		previous.headings.some((heading, index) => heading.raw !== next.headings[index].raw)
	) {
		throw new Error("TodoLoop: original content changed: heading structure changed");
	}
	const currentGroup = previous.groups.find(group => group.id === currentGroupId);
	if (currentGroupId !== undefined && !currentGroup) {
		throw new Error(`TodoLoop: unknown current group ${currentGroupId}`);
	}
	const currentTaskIds = new Set(currentGroup?.tasks.map(task => task.id));
	for (let index = 0; index < previous.located.length; index++) {
		const oldLocated = previous.located[index];
		const newLocated = next.located[index];
		const oldTask = oldLocated.task;
		const newTask = newLocated.task;
		if (oldTask.id !== newTask.id) throw new Error(`TodoLoop: task number or order changed at ${oldTask.id}`);
		if (oldLocated.section !== newLocated.section) throw new Error(`TodoLoop: task group changed for ${oldTask.id}`);
		// New prose may extend the current task's paragraph, but never replace
		// any original line. The raw-line check below also protects old notes.
		if (
			oldTask.text !== newTask.text &&
			!(currentTaskIds.has(oldTask.id) && newTask.text.startsWith(`${oldTask.text}\n`))
		) {
			throw new Error(`TodoLoop: task body changed for ${oldTask.id}`);
		}
		if (oldTask.done && !newTask.done) throw new Error(`TodoLoop: completed task ${oldTask.id} was unchecked`);
		if (oldTask.done !== newTask.done && !currentTaskIds.has(oldTask.id)) {
			throw new Error(`TodoLoop: non-current group task ${oldTask.id} changed checkbox`);
		}
	}

	// Checking task.text alone would let an inserted blank line hide a changed
	// continuation as a new note. Preserve every old line, including old notes,
	// and admit only insertions after the last existing record in each task's region.
	const oldLines = previous.lines;
	const newLines = next.lines;
	const oldEndings = before.content.match(/\r\n|\n|\r/g) ?? [];
	const newEndings = after.content.match(/\r\n|\n|\r/g) ?? [];
	for (let index = 0; index < previous.located.length; index++) {
		const oldTask = previous.located[index].task;
		const newTask = next.located[index].task;
		if (oldTask.done !== newTask.done) {
			newLines[newTask.line - 1] = newLines[newTask.line - 1].replace(/\[[xX]\]/, "[ ]");
		}
	}
	const noteRegions = previous.located.flatMap((located, index) => {
		if (!currentTaskIds.has(located.task.id)) return [];
		const nextTaskLine = previous.located[index + 1]?.task.line ?? oldLines.length + 1;
		const nextHeadingLine =
			previous.headings.find(heading => heading.line > located.task.line)?.line ?? oldLines.length + 1;
		const end = Math.min(nextTaskLine, nextHeadingLine, located.nextListLine ?? oldLines.length + 1) - 1;
		let start = end;
		// A new record can precede the trailing blank separators, but never
		// precede or interrupt any previously accepted Markdown content.
		while (start >= located.task.line && !oldLines[start - 1].trim()) start--;
		return [{ start, end }];
	});
	const sameLine = (index: number, cursor: number): boolean =>
		newLines[cursor] === oldLines[index] &&
		(oldEndings[index] === newEndings[cursor] ||
			// An appended note may supply the first delimiter for the old final line.
			(index === oldLines.length - 1 && oldEndings[index] === undefined && cursor + 1 < newLines.length));
	let cursor = 0;
	for (let index = 0; index <= oldLines.length; index++) {
		if (noteRegions.some(region => index >= region.start && index <= region.end)) {
			while (cursor < newLines.length && !sameLine(index, cursor)) cursor++;
		}
		if (index === oldLines.length) {
			if (cursor === newLines.length) return;
			break;
		}
		if (!sameLine(index, cursor)) break;
		cursor++;
	}
	throw new Error("TodoLoop: original content changed outside append-only current-group task notes");
}
