import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { MarkdownDocument, MarkdownSection, MarkdownSourceLine } from "./types";

/**
 * Sections are capped below the `wiki` tool's page budget so that any stored
 * section can be delivered whole by one call; a larger cap would put content
 * beyond the page and leave no way to read it.
 */
const MAX_SECTION_CHARS = 18_000;

/**
 * Longest heading segment kept in `headingPath`. A heading line can be as long as
 * the whole document (a one-line file starting with `#`), and the path is stored —
 * and repeated — for every chunk of a split section, so only a readable prefix is
 * kept. The section text still carries the full line; the `wiki` page header is
 * bounded by the same limit so an index built before this rule cannot overshoot
 * the page budget either.
 */
export const HEADING_LABEL_MAX_CHARS = 300;

/**
 * Bounds a heading label. `truncate` cuts by UTF-16 unit, so an astral character
 * straddling the cut would leave a lone high surrogate that SQLite recombines with
 * the next character on encode (and that the page header would render). Back off one
 * unit instead, the same way `chunkDraft` refuses to split a pair.
 */
export function truncateHeading(text: string, maxChars = HEADING_LABEL_MAX_CHARS): string {
	if (text.length <= maxChars) return text;
	let end = Math.max(0, maxChars - 1);
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…`;
}
const SOURCE_KINDS: Record<string, true> = {
	doc: true,
	docx: true,
	pdf: true,
	ppt: true,
	pptx: true,
	xls: true,
	xlsx: true,
	mp4: true,
	m4a: true,
};

interface SectionDraft {
	headingPath: string[];
	headingLevel: number;
	lines: MarkdownSourceLine[];
}

type FenceMarker = "`" | "~";

interface Fence {
	marker: FenceMarker;
	length: number;
}

interface FenceMatch extends Fence {
	trailing: string;
}

function parseFence(line: string): FenceMatch | undefined {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/);
	if (!match) return undefined;
	return { marker: match[1][0] as FenceMarker, length: match[1].length, trailing: match[2] };
}

function sourceKind(relativePath: string): string {
	const kind = path
		.basename(relativePath)
		.match(/_([a-z0-9]+)\.md$/i)?.[1]
		?.toLowerCase();
	return kind && SOURCE_KINDS[kind] ? kind : "markdown";
}

function splitLines(bytes: Uint8Array): MarkdownSourceLine[] {
	const text = new TextDecoder().decode(bytes);
	const lines: MarkdownSourceLine[] = [];
	let charStart = 0;
	let byteStart = 0;
	let line = 1;
	for (const match of text.matchAll(/\n/g)) {
		const charEnd = (match.index ?? 0) + 1;
		const value = text.slice(charStart, charEnd);
		const byteEnd = byteStart + Buffer.byteLength(value);
		lines.push({ text: value, line, byteStart, byteEnd });
		charStart = charEnd;
		byteStart = byteEnd;
		line++;
	}
	if (charStart < text.length) {
		const value = text.slice(charStart);
		lines.push({ text: value, line, byteStart, byteEnd: byteStart + Buffer.byteLength(value) });
	}
	return lines;
}

function parseHeading(
	line: string,
	nextLine: string | undefined,
	inFence: boolean,
): { level: number; text: string; setext: boolean } | undefined {
	if (inFence) return undefined;
	const atx = line.replace(/\r?\n$/, "").match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
	if (atx) return { level: atx[1].length, text: atx[2].trim(), setext: false };
	if (nextLine !== undefined && line.trim() !== "" && /^ {0,3}(=+|-+)[ \t]*\r?\n?$/.test(nextLine)) {
		return { level: nextLine.trimStart().startsWith("=") ? 1 : 2, text: line.trim(), setext: true };
	}
	return undefined;
}

export function normalizePlainText(markdown: string): string {
	return markdown
		.replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
		.replace(/^ {0,3}(=+|-+)[ \t]*$/gm, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*~`]+/g, "")
		.replace(/[ \t]+/g, " ")
		.trim();
}

// Heading recognition here must agree with `parseHeading`: at most three
// spaces of indentation, so an indented-code `# word` line (4+ spaces, or a
// tab) counts as content rather than as a heading.
const HEADING_LINE = /^ {0,3}#{1,6}[ \t].*$/gmu;
const SETEXT_LINE = /^ {0,3}(?:=+|-+)[ \t]*$/gmu;
const HEADING_MARKER = /^ {0,3}#{1,6}[ \t]?/gmu;
// A setext heading's text line together with its underline — the ATX strips
// cover only `#` lines, so this pair is what keeps setext heading-only
// sections from being misread as content.
const SETEXT_HEADING_PAIR = /^[^\n]*\S[^\n]*\n {0,3}(?:=+|-+)[ \t]*$/gmu;

/**
 * What a stored section holds. Converter output (docx/pptx/xlsx) emits its
 * structural labels as headings with no body — `#### Cell` alone appears
 * hundreds of thousands of times — and those index nothing readable (`stub`).
 * A heading whose text is a real phrase (Chinese, or several words) is kept as
 * `heading-only`: requirement and checklist documents often state the whole
 * requirement in the heading itself.
 */
export function sectionShape(markdown: string): "stub" | "heading-only" | "content" {
	if (markdown.replace(SETEXT_HEADING_PAIR, "").replace(HEADING_LINE, "").replace(SETEXT_LINE, "").trim().length > 0)
		return "content";
	const heading = markdown.replace(HEADING_MARKER, "").replace(SETEXT_LINE, "").trim();
	if (heading.length === 0) return "stub";
	return /[\s\u3400-\u4dbf\u4e00-\u9fff]/u.test(heading) ? "heading-only" : "stub";
}

function chunkDraft(draft: SectionDraft): SectionDraft[] {
	if (draft.lines.reduce((sum, line) => sum + line.text.length, 0) <= MAX_SECTION_CHARS) return [draft];
	const chunks: SectionDraft[] = [];
	let current: MarkdownSourceLine[] = [];
	let chars = 0;
	const flush = () => {
		if (current.length === 0) return;
		chunks.push({ ...draft, lines: current });
		current = [];
		chars = 0;
	};
	for (const line of draft.lines) {
		if (line.text.length > MAX_SECTION_CHARS) {
			flush();
			let consumedChars = 0;
			let consumedBytes = 0;
			while (consumedChars < line.text.length) {
				let text = line.text.slice(consumedChars, consumedChars + MAX_SECTION_CHARS);
				// Never cut between the halves of a surrogate pair: the lone half would be
				// stored as U+FFFD and shift every later byte offset.
				const lastChar = text.charCodeAt(text.length - 1);
				if (lastChar >= 0xd800 && lastChar <= 0xdbff && consumedChars + text.length < line.text.length) {
					text = text.slice(0, -1);
				}
				const length = Buffer.byteLength(text);
				chunks.push({
					...draft,
					lines: [
						{
							text,
							line: line.line,
							byteStart: line.byteStart + consumedBytes,
							byteEnd: line.byteStart + consumedBytes + length,
						},
					],
				});
				consumedChars += text.length;
				consumedBytes += length;
			}
			continue;
		}
		if (chars + line.text.length > MAX_SECTION_CHARS && current.length > 0) {
			let split = current.length;
			for (let index = current.length - 1; index >= 0; index--) {
				if (current[index].text.trim() === "") {
					split = index + 1;
					break;
				}
			}
			if (split < current.length) {
				const remainder = current.splice(split);
				flush();
				current = remainder;
				chars = remainder.reduce((sum, item) => sum + item.text.length, 0);
				// The split honours the blank-line boundary, not the budget: the tail it
				// keeps can still be one line short of the cap, and pushing the trigger
				// line onto it would store a section past MAX_SECTION_CHARS — the cap the
				// wiki page budget is sized against. Emit the tail on its own instead.
				if (chars + line.text.length > MAX_SECTION_CHARS) flush();
			} else flush();
		}
		current.push(line);
		chars += line.text.length;
	}
	flush();
	return chunks;
}

export function parseMarkdown(bytes: Uint8Array): { title?: string; sections: MarkdownSection[] } {
	const lines = splitLines(bytes);
	const drafts: SectionDraft[] = [];
	let headingPath: string[] = [];
	let current: SectionDraft = { headingPath: [], headingLevel: 0, lines: [] };
	let fence: Fence | undefined;
	let title: string | undefined;
	const finish = () => {
		if (current.lines.length === 0 || !current.lines.some(line => line.text.length > 0)) return;
		// Keep the document's first section whatever it holds: it is the only FTS
		// row that carries the relative path, so dropping it would hide the file name.
		if (drafts.length > 0 && sectionShape(current.lines.map(line => line.text).join("")) === "stub") return;
		drafts.push(current);
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const fenceMatch = parseFence(line.text);
		// A fence delimiter line can never begin a heading: an ATX line cannot
		// start with backticks or tildes, and a setext text line must be a
		// paragraph line, which a fence opener is not.
		const heading = parseHeading(line.text, lines[index + 1]?.text, fence !== undefined || fenceMatch !== undefined);
		if (heading) {
			finish();
			headingPath = headingPath.slice(0, heading.level - 1);
			headingPath[heading.level - 1] = truncateHeading(heading.text);
			title ??= heading.text;
			// `headingPath` is indexed by heading level, so a skipped level (# A then
			// #### B) or a document that opens below `#` leaves holes. They exist only
			// to keep level-based truncation working; the stored path drops them so it
			// never renders as "A >  >  > B" or " > X".
			current = {
				headingPath: headingPath.filter(segment => segment !== undefined),
				headingLevel: heading.level,
				lines: [line],
			};
			if (heading.setext && lines[index + 1]) current.lines.push(lines[++index]);
			continue;
		}
		current.lines.push(line);
		if (fenceMatch) {
			if (!fence) {
				// CommonMark: a backtick fence's info string cannot contain
				// backticks — such a line is a paragraph, not a fence opener.
				if (!(fenceMatch.marker === "`" && fenceMatch.trailing.includes("`"))) {
					fence = { marker: fenceMatch.marker, length: fenceMatch.length };
				}
			} else if (
				fence.marker === fenceMatch.marker &&
				fenceMatch.length >= fence.length &&
				/^[ \t]*$/.test(fenceMatch.trailing)
			)
				fence = undefined;
		}
	}
	finish();
	let ordinal = 0;
	const sections = drafts.flatMap(chunkDraft).map(draft => {
		const rawMarkdown = draft.lines.map(line => line.text).join("");
		const first = draft.lines[0];
		const last = draft.lines.at(-1) as MarkdownSourceLine;
		return {
			ordinal: ordinal++,
			headingPath: draft.headingPath,
			headingLevel: draft.headingLevel,
			lineStart: first.line,
			lineEnd: last.line,
			byteStart: first.byteStart,
			byteEnd: last.byteEnd,
			rawMarkdown,
			plainText: normalizePlainText(rawMarkdown),
		};
	});
	return { title, sections };
}

async function enumerateDirectory(root: string, relative = "", visited?: Set<string>): Promise<string[]> {
	// Windows junctions report as directories without the symlink bit, so the
	// `isSymbolicLink` skip above cannot see them. Resolve each directory to its
	// real path and refuse to descend twice: a junction pointing at an ancestor
	// would otherwise recurse forever.
	const seen = visited ?? new Set<string>();
	const directory = path.join(root, relative);
	const real = await realpath(directory);
	if (seen.has(real)) return [];
	seen.add(real);
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const child = relative ? path.join(relative, entry.name) : entry.name;
		if (entry.isDirectory()) files.push(...(await enumerateDirectory(root, child, seen)));
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(child);
	}
	return files;
}

export async function enumerateMarkdownFiles(rootPath: string): Promise<string[]> {
	const root = path.resolve(rootPath);
	const rootStat = await stat(root).catch(() => undefined);
	if (!rootStat?.isDirectory()) throw new Error(`Markdown root is not a directory: ${root}`);
	return (await enumerateDirectory(root)).sort((left, right) => left.localeCompare(right, "en"));
}

export async function readMarkdownDocument(rootPath: string, relativePath: string): Promise<MarkdownDocument> {
	const root = path.resolve(rootPath);
	const absolutePath = path.resolve(root, relativePath);
	const relative = path.relative(root, absolutePath);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error(`Markdown path escapes root: ${relativePath}`);
	// `O_NOFOLLOW` is undefined on Windows (0 | undefined === 0), so an lstat
	// precheck is the only cross-platform way to keep refusing symlink sources.
	if ((await lstat(absolutePath)).isSymbolicLink())
		throw new Error(`Markdown path is a symbolic link: ${relativePath}`);
	const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let bytes: Uint8Array;
	let metadata: Stats;
	try {
		[bytes, metadata] = await Promise.all([handle.readFile(), handle.stat()]);
		if (!metadata.isFile()) throw new Error(`Markdown path is not a regular file: ${relativePath}`);
	} finally {
		await handle.close();
	}
	const parsed = parseMarkdown(bytes);
	const digest = createHash("sha256").update(bytes).digest("hex");
	return {
		relativePath: relative.split(path.sep).join("/"),
		absolutePath,
		title: parsed.title ?? path.basename(relativePath, path.extname(relativePath)),
		sourceKind: sourceKind(relativePath),
		sha256: digest,
		sizeBytes: bytes.byteLength,
		mtimeMs: metadata.mtimeMs,
		sections: parsed.sections,
	};
}
