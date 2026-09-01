import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { MarkdownDocument, MarkdownSection } from "./types";

const MAX_SECTION_CHARS = 24_000;
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

interface SourceLine {
	text: string;
	line: number;
	byteStart: number;
	byteEnd: number;
}

interface SectionDraft {
	headingPath: string[];
	headingLevel: number;
	lines: SourceLine[];
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

function splitLines(bytes: Uint8Array): SourceLine[] {
	const text = new TextDecoder().decode(bytes);
	const lines: SourceLine[] = [];
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
	const atx = line.replace(/\r?\n$/, "").match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
	if (atx) return { level: atx[1].length, text: atx[2].trim(), setext: false };
	if (nextLine !== undefined && line.trim() !== "" && /^ {0,3}(=+|-+)[ \t]*\r?\n?$/.test(nextLine)) {
		return { level: nextLine.trimStart().startsWith("=") ? 1 : 2, text: line.trim(), setext: true };
	}
	return undefined;
}

function normalizePlainText(markdown: string): string {
	return markdown
		.replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
		.replace(/^ {0,3}(=+|-+)[ \t]*$/gm, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*~`]+/g, "")
		.replace(/[ \t]+/g, " ")
		.trim();
}

function chunkDraft(draft: SectionDraft): SectionDraft[] {
	if (draft.lines.reduce((sum, line) => sum + line.text.length, 0) <= MAX_SECTION_CHARS) return [draft];
	const chunks: SectionDraft[] = [];
	let current: SourceLine[] = [];
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
				const text = line.text.slice(consumedChars, consumedChars + MAX_SECTION_CHARS);
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
		if (current.lines.length > 0 && current.lines.some(line => line.text.length > 0)) drafts.push(current);
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const fenceMatch = parseFence(line.text);
		const heading = parseHeading(line.text, lines[index + 1]?.text, fence !== undefined);
		if (heading) {
			finish();
			headingPath = headingPath.slice(0, heading.level - 1);
			headingPath[heading.level - 1] = heading.text;
			title ??= heading.text;
			current = { headingPath: [...headingPath], headingLevel: heading.level, lines: [line] };
			if (heading.setext && lines[index + 1]) current.lines.push(lines[++index]);
			continue;
		}
		current.lines.push(line);
		if (fenceMatch) {
			if (!fence) fence = { marker: fenceMatch.marker, length: fenceMatch.length };
			else if (
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
		const last = draft.lines.at(-1) as SourceLine;
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

async function enumerateDirectory(root: string, relative = ""): Promise<string[]> {
	const entries = await readdir(path.join(root, relative), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const child = relative ? path.join(relative, entry.name) : entry.name;
		if (entry.isDirectory()) files.push(...(await enumerateDirectory(root, child)));
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
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error(`Markdown path escapes root: ${relativePath}`);
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
