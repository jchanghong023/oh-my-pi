import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	WikiSearchEngine,
	wikiEnumerateMarkdownFiles as enumerateMarkdownFiles,
	wikiParseMarkdown as parseMarkdown,
	wikiReadMarkdownDocument as readMarkdownDocument,
	wikiSectionShape as sectionShape,
} from "@oh-my-pi/pi-natives";
import { DocsSearchEngine } from "../src/docs/engine";
import { readSqliteTables, withSqliteDatabase } from "./helpers/sqlite-inspect";

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Markdown parsing", () => {
	it("parses headings, setext headings, tables, fences, and oversized sections with source ranges", () => {
		const large = "x".repeat(24_100);
		const text = [
			"Document title",
			"===============",
			"Intro text",
			"## Commands",
			"| name | value |",
			"| --- | --- |",
			"| run | fast |",
			"```md",
			"# inside a fence",
			"```",
			large,
			"### Child",
			"child text",
		].join("\n");
		const parsed = parseMarkdown(new TextEncoder().encode(text));
		expect(parsed.title).toBe("Document title");
		expect(parsed.sections.some(section => section.headingPath.at(-1) === "Commands")).toBe(true);
		expect(parsed.sections.some(section => section.rawMarkdown.includes("# inside a fence"))).toBe(true);
		for (const section of parsed.sections)
			expect(
				Buffer.from(new TextEncoder().encode(text)).subarray(section.byteStart, section.byteEnd).toString(),
			).toBe(section.rawMarkdown);
		expect(parsed.sections[0].byteStart).toBe(0);
		expect(parsed.sections.at(-1)?.byteEnd).toBe(Buffer.byteLength(text));
		expect(
			parsed.sections.every(section => section.byteEnd > section.byteStart && section.lineEnd >= section.lineStart),
		).toBe(true);
		expect(parsed.sections.find(section => section.headingPath.at(-1) === "Child")?.plainText).toContain(
			"child text",
		);
	});

	it("preserves a UTF-8 BOM and CRLF bytes while recognizing the initial heading", () => {
		const text = "\uFEFF# 标题\r\n正文\r\n## 下一节\r\n后续\r\n";
		const bytes = new TextEncoder().encode(text);
		const parsed = parseMarkdown(bytes);
		expect(parsed.title).toBe("标题");
		expect(parsed.sections.map(section => section.rawMarkdown).join("")).toBe(text);
		expect(parsed.sections.map(section => [section.lineStart, section.lineEnd])).toEqual([
			[1, 2],
			[3, 4],
		]);
		for (const section of parsed.sections) {
			const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes.subarray(section.byteStart, section.byteEnd),
			);
			expect(original).toBe(section.rawMarkdown);
		}
		expect(parsed.sections.at(-1)?.byteEnd).toBe(bytes.length);
	});

	it("drops skipped-level gaps from stored heading paths but keeps level fallback", () => {
		const skipped = parseMarkdown(new TextEncoder().encode("# A\n\n#### B\n\nDeep needle\n"));
		expect(skipped.sections.map(section => section.headingPath)).toEqual([["A"], ["A", "B"]]);

		const belowRoot = parseMarkdown(new TextEncoder().encode("## X\n\nbody\n"));
		expect(belowRoot.sections[0]?.headingPath).toEqual(["X"]);

		const fallback = parseMarkdown(new TextEncoder().encode("# A\n\na\n\n## B\n\nb\n\n### C\n\nc\n\n# D\n\nd\n"));
		expect(fallback.sections.map(section => section.headingPath)).toEqual([
			["A"],
			["A", "B"],
			["A", "B", "C"],
			["D"],
		]);
	});

	it("drops converter structural labels but keeps heading-only requirement lines", () => {
		const text = [
			"# Doc",
			"#### Cell",
			"###### Cell",
			"##### Row",
			"## 12.2.1.1.2 支持单DIE/多DIE同构分组",
			"## 个人目录",
		].join("\n");
		const parsed = parseMarkdown(new TextEncoder().encode(text));
		const kept = parsed.sections.map(section => section.rawMarkdown.trim());
		// Structural labels index nothing; a heading that reads as a phrase is content.
		expect(kept).not.toContain("#### Cell");
		expect(kept).not.toContain("##### Row");
		expect(kept.some(section => section.includes("支持单DIE/多DIE同构分组"))).toBe(true);
		expect(kept.some(section => section.includes("个人目录"))).toBe(true);
	});

	it("splits oversized sections into bounded complete chunks", () => {
		const parsed = parseMarkdown(new TextEncoder().encode(`# Doc\n${"y".repeat(40_000)}\n`));
		expect(parsed.sections.length).toBeGreaterThan(1);
		expect(Math.max(...parsed.sections.map(section => section.rawMarkdown.length))).toBeLessThan(20_000);
	});

	it("keeps every chunk within the cap when a blank-line split leaves a long tail", () => {
		// A blank line near the top and a long blank-free block after it: the split keeps
		// that block whole, so the line that triggered the split must not be appended.
		const text = `# Doc\n\n${"| cell |\n".repeat(1_500)}${"z".repeat(5_000)}\n`;
		const parsed = parseMarkdown(new TextEncoder().encode(text));
		expect(parsed.sections.map(section => section.rawMarkdown).join("")).toBe(text);
		expect(Math.max(...parsed.sections.map(section => section.rawMarkdown.length))).toBeLessThanOrEqual(18_000);
	});

	it("preserves literal trailing hashes unless a spaced closing sequence is present", () => {
		const literal = parseMarkdown(new TextEncoder().encode("# C#\nbody\n## F#\nbody\n# Topic#\nbody\n"));
		expect(literal.title).toBe("C#");
		expect(literal.sections.map(section => section.headingPath.at(-1))).toEqual(["C#", "F#", "Topic#"]);

		const closed = parseMarkdown(new TextEncoder().encode("# C# ###\nbody\n"));
		expect(closed.title).toBe("C#");
		expect(closed.sections[0]?.headingPath).toEqual(["C#"]);
	});

	it("requires matching fence length and whitespace-only closing content", () => {
		const text = [
			"# Document",
			"````md",
			"```",
			"# inside fence",
			"``` trailing text",
			"```",
			"#### still inside",
			"````\t",
			"## Outside",
			"outside",
		].join("\n");
		const parsed = parseMarkdown(new TextEncoder().encode(text));
		expect(parsed.sections.some(section => section.headingPath.at(-1) === "inside fence")).toBe(false);
		expect(parsed.sections.some(section => section.headingPath.at(-1) === "still inside")).toBe(false);
		expect(parsed.sections.some(section => section.headingPath.at(-1) === "Outside")).toBe(true);
		expect(parsed.sections.find(section => section.headingPath.at(-1) === "Document")?.rawMarkdown).toContain(
			"# inside fence",
		);
	});

	// A plain (non-junction) symlink needs Windows Developer Mode or an
	// elevated token; without it fs.symlink fails with EPERM.
	it.skipIf(process.platform === "win32")("skips and refuses symbolic-link Markdown sources", async () => {
		const root = await tempDir("docs-safe-root-");
		const outside = path.join(await tempDir("docs-safe-outside-"), "outside.md");
		await fs.writeFile(outside, "# Outside\nsecret\n");
		await fs.symlink(outside, path.join(root, "linked.md"));
		expect(await enumerateMarkdownFiles(root)).toEqual([]);
		await expect(readMarkdownDocument(root, "linked.md")).rejects.toThrow();
	});

	it.skipIf(process.platform !== "win32")("does not recurse into cyclic Windows junctions", async () => {
		const root = await tempDir("docs-junction-root-");
		await fs.mkdir(path.join(root, "sub"));
		await fs.writeFile(path.join(root, "sub", "note.md"), "# Note\nbody\n");
		// A junction back at the root reports as a plain directory, so only the
		// resolved-path guard can stop the descent from looping forever.
		await fs.symlink(root, path.join(root, "loop"), "junction");
		expect(await enumerateMarkdownFiles(root)).toEqual([path.join("sub", "note.md")]);
	});

	it("judges indented-code heading lines as content, matching the parser's heading rules", () => {
		expect(sectionShape("#### Cell\n")).toBe("stub");
		expect(sectionShape("  ## Cell\n")).toBe("stub");
		expect(sectionShape("    # word\n")).toBe("content");
		expect(sectionShape("\t# word\n")).toBe("content");
		expect(sectionShape("Word\n    ---\n")).toBe("content");
	});

	it("classifies CRLF Setext headings like LF headings without retaining structural labels", () => {
		expect(sectionShape("Cell\r\n----\r\n")).toBe("stub");
		expect(sectionShape("需求条款\r\n----\r\n")).toBe("heading-only");
		const parsed = parseMarkdown(new TextEncoder().encode("# Doc\r\nCell\r\n----\r\n需求条款\r\n====\r\n"));
		expect(parsed.sections.map(section => section.rawMarkdown)).toEqual(["# Doc\r\n", "需求条款\r\n====\r\n"]);
	});
});
describe("DocsSearchEngine indexing contract", () => {
	it("keeps default technical-name search distinct from explicit raw Markdown regex matching", async () => {
		const root = await tempDir("docs-regex-root-");
		const agentDir = await tempDir("docs-regex-agent-");
		const sources = {
			"exact.md": "# Notes\nUse C++ and docs/src/main.rs.\nCaseBeacon\n`counter*factor`\n",
			"continued.md": "# Notes\nUse C++17 and docs/src/main.rs.bak.\ncasebeacon\n",
			"plain.md": "# Notes\nCCCC docs/src/mainXrs\ncounterfactor\n",
			"escaped.md": "# Notes\nmbist\\_check.rpt\nPAIR=echo echo\n",
		};
		for (const [name, source] of Object.entries(sources)) await Bun.write(path.join(root, name), source);
		const engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			await fs.rm(root, { recursive: true });
			for (const query of ["C++", "docs/src/main.rs"]) {
				const search = engine.search(query);
				expect(search.sections.find(hit => hit.path === "exact.md")?.matchKind).toBe("exact-name");
				expect(search.sections.find(hit => hit.path === "continued.md")?.matchKind).toBe("related");
				expect(engine.search(query, { mode: "search", case: true })).toEqual(search);
				expect(engine.search(query, { mode: "search", case: false })).toEqual(search);
			}
			const regex = (query: string, caseSensitive?: boolean) =>
				engine.search(query, { mode: "grep", case: caseSensitive, limit: 500 });
			expect(regex("C++").sections.map(hit => hit.path)).toEqual(["continued.md", "exact.md", "plain.md"]);
			expect(regex("C\\+\\+").sections.map(hit => hit.path)).toEqual(["continued.md", "exact.md"]);
			expect(regex("docs/src/main\\.rs").sections.map(hit => hit.path)).toEqual(["continued.md", "exact.md"]);
			expect(regex("docs/src/main.rs").sections.map(hit => hit.path)).toEqual([
				"continued.md",
				"exact.md",
				"plain.md",
			]);
			expect(regex("CaseBeacon").sections.map(hit => hit.path)).toEqual(["exact.md"]);
			expect(regex("CaseBeacon", true)).toEqual(regex("CaseBeacon"));
			expect(regex("CaseBeacon", false).sections.map(hit => hit.path)).toEqual(["continued.md", "exact.md"]);
			expect(regex("`counter\\*factor`").sections.map(hit => hit.path)).toEqual(["exact.md"]);
			expect(regex("mbist\\\\_check\\.rpt").sections.map(hit => hit.path)).toEqual(["escaped.md"]);
			expect(regex("mbist_check\\.rpt").total).toBe(0);
			expect(regex("(?<=PAIR=)(echo) \\1").sections.map(hit => hit.path)).toEqual(["escaped.md"]);
			expect(regex("C\\+\\+(?!17)").sections.map(hit => hit.path)).toEqual(["exact.md"]);
			for (const hit of regex("C\\+\\+").sections) {
				expect(hit.matchKind).toBe("regex");
				expect(hit.text).toBe(sources[hit.path as keyof typeof sources]);
			}
			expect(regex("C\\+\\+").exactNameMatches).toBe(0);
			expect(regex("C\\+\\+").technicalName).toBeUndefined();
		} finally {
			engine.close();
		}
	});

	it("scans every stored section beyond FTS candidates and returns only actual regex evidence", async () => {
		const root = await tempDir("docs-regex-candidates-root-");
		const agentDir = await tempDir("docs-regex-candidates-agent-");
		await Bun.write(
			path.join(root, "guide.md"),
			Array.from({ length: 1_205 }, (_, index) => `## Item ${index}\n!!!:${index}\n`).join("\n"),
		);
		const engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			withSqliteDatabase(engine.databasePath, db => db.run("DELETE FROM sections_fts"));
			await fs.rm(root, { recursive: true });
			let page = engine.search("^!!!:[0-9]+$", { mode: "grep", limit: 500 });
			const hits = [...page.sections];
			for (let count = 0; page.cursor && count < 20; count++) {
				page = engine.search("^!!!:[0-9]+$", { mode: "grep", limit: 137, cursor: page.cursor });
				hits.push(...page.sections);
			}
			expect(hits).toHaveLength(1_205);
			expect(new Set(hits.map(hit => hit.sectionId)).size).toBe(1_205);
			expect(hits.map(hit => Number(hit.text.match(/!!!:(\d+)/)![1]))).toEqual(
				Array.from({ length: 1_205 }, (_, index) => index),
			);
			expect(hits.every(hit => hit.matchKind === "regex")).toBe(true);
			expect(page).toMatchObject({ total: 1_205, exactNameMatches: 0, hasMore: false });
			expect(engine.search("^!!!:1204$", { mode: "grep" }).sections).toEqual(hits.slice(-1));
			expect(engine.search("^!!!:9999$", { mode: "grep" }).sections).toEqual([]);
		} finally {
			engine.close();
		}
	});

	it("rejects invalid and overlong regex without repair while preserving spaces and original line boundaries", async () => {
		const root = await tempDir("docs-regex-validation-root-");
		const agentDir = await tempDir("docs-regex-validation-agent-");
		const source = "# Notes\r\n padded \r\npadded\r\nPAIR=echo echo\r\nfirst\r\nsecond\r\nAND OR NOT\r\n";
		await Bun.write(path.join(root, "guide.md"), source);
		const engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			await fs.rm(root, { recursive: true });
			for (const query of ["[", "(", "\\", "foo.*(bar", " ", "\t\r\n"])
				expect(() => engine.search(query, { mode: "grep" })).toThrow();
			for (const query of ["x".repeat(501), "𐐀".repeat(251)])
				expect(() => engine.search(query, { mode: "grep" })).toThrow("500");
			expect(engine.search("x".repeat(500), { mode: "grep" })).toMatchObject({ total: 0, hasMore: false });
			expect(engine.search("𐐀".repeat(250), { mode: "grep" })).toMatchObject({ total: 0, hasMore: false });
			expect(engine.search(" padded ", { mode: "grep" }).sections[0]?.text).toBe(source);
			expect(engine.search("  padded ", { mode: "grep" }).total).toBe(0);
			expect(engine.search(" padded  ", { mode: "grep" }).total).toBe(0);
			expect(engine.search("^ padded \\r?$", { mode: "grep" }).total).toBe(1);
			expect(engine.search("^AND OR NOT\\r?$", { mode: "grep" }).total).toBe(1);
			for (const query of ["first\\nsecond", "(?s)first.*second", "(?m)^first\\s+second$"])
				expect(engine.search(query, { mode: "grep" })).toMatchObject({ sections: [], total: 0, hasMore: false });
			expect(engine.search("^ABSENT$", { mode: "grep" })).toEqual({
				sections: [],
				total: 0,
				exactNameMatches: 0,
				hasMore: false,
			});
			expect(engine.search("(?<=PAIR=)(echo) \\1", { mode: "grep" }).sections[0]?.text).toBe(source);
		} finally {
			engine.close();
		}
	});

	it("keeps omitted converter bytes out of DB-only grep while later sections and documents stay reachable", async () => {
		const root = await tempDir("docs-regex-gap-root-");
		const agentDir = await tempDir("docs-regex-gap-agent-");
		const source = "# Title\n\nbody\n\n#### Cell\n\n# Next\n\nbody2\n";
		await Bun.write(path.join(root, "guide.md"), source);
		await Bun.write(path.join(root, "later.md"), "# Later\nbody3\n");
		let engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			await fs.rm(root, { recursive: true });
			const first = engine.search("^body$", { mode: "grep" });
			const last = engine.search("^body2$", { mode: "grep" });
			expect(first.total).toBe(1);
			expect(last.total).toBe(1);
			expect(first.sections[0]).toMatchObject({
				text: "# Title\n\nbody\n\n",
				lineStart: 1,
				lineEnd: 4,
				matchKind: "regex",
			});
			expect(last.sections[0]).toMatchObject({
				text: "# Next\n\nbody2\n",
				lineStart: 7,
				lineEnd: 9,
				matchKind: "regex",
			});
			expect(last.sections[0]?.documentHash).toBe(new Bun.CryptoHasher("sha256").update(source).digest("hex"));
			expect(engine.search("^# Next$", { mode: "grep" }).sections).toEqual(last.sections);
			expect(engine.search("^#### Cell$", { mode: "grep" }).total).toBe(0);
			expect(engine.search("^bodybody2$", { mode: "grep" }).total).toBe(0);
			expect(engine.search("body\\nbody2", { mode: "grep" }).total).toBe(0);
			const page = engine.search("^body[23]?$", { mode: "grep", limit: 1 });
			expect(page.total).toBe(3);
			expect(page.sections).toEqual(first.sections);
			engine.close();
			engine = new DocsSearchEngine({ agentDir });
			const rest = engine.search("^body[23]?$", { mode: "grep", cursor: page.cursor });
			expect(rest.sections[0]).toEqual(last.sections[0]);
			expect(rest.sections[1]).toMatchObject({
				path: "later.md",
				text: "# Later\nbody3\n",
				lineStart: 1,
				lineEnd: 2,
				matchKind: "regex",
			});
			expect(rest.hasMore).toBe(false);
		} finally {
			engine.close();
		}
	});

	it("reconstructs overlapping Unicode CRLF slices before matching long lines and real anchors", async () => {
		const root = await tempDir("docs-regex-overlap-root-");
		const agentDir = await tempDir("docs-regex-overlap-agent-");
		const line = `中START${"前".repeat(17_300)}LEFT${"界".repeat(1_200)}RIGHT${"后".repeat(30_000)}END中`;
		const source = `# Long\r\n${line}\r\n`;
		await Bun.write(path.join(root, "long.md"), source);
		const bytes = Buffer.from(source);
		const parsed = parseMarkdown(bytes);
		expect(parsed.sections.length).toBeGreaterThan(2);
		const engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			await fs.rm(root, { recursive: true });
			const expected = (start: number, end: number) =>
				parsed.sections.filter(section => section.byteStart < end && section.byteEnd > start);
			const check = (query: string, start: number, end: number) => {
				const result = engine.search(query, { mode: "grep", limit: 500 });
				const sections = expected(start, end);
				expect(result.total).toBe(sections.length);
				expect(result.sections.map(hit => hit.text)).toEqual(sections.map(section => section.rawMarkdown));
				expect(result.sections.map(hit => [hit.lineStart, hit.lineEnd])).toEqual(
					sections.map(section => [section.lineStart, section.lineEnd]),
				);
				for (const hit of result.sections)
					expect(hit.documentHash).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
			};
			const begin = bytes.indexOf(Buffer.from("LEFT"));
			const end = bytes.indexOf(Buffer.from("RIGHT")) + Buffer.byteLength("RIGHT");
			expect(
				expected(begin, end).every(section => !section.rawMarkdown.includes(`LEFT${"界".repeat(1_200)}RIGHT`)),
			).toBe(true);
			check("LEFT界{1200}RIGHT", begin, end);
			check("LEFT", begin, begin + 4);
			const lineStart = Buffer.byteLength("# Long\r\n");
			const lineEnd = lineStart + Buffer.byteLength(line);
			check("^中START.*END中\\r?$", lineStart, lineEnd);
			check("^中START", lineStart, lineStart + Buffer.byteLength("中START"));
			check("END中\\r?$", lineEnd - Buffer.byteLength("END中"), lineEnd);
			for (const query of ["^前|^界|^后", "前$|界$|后$", "(?s)START.*\\r\\n"])
				expect(engine.search(query, { mode: "grep" }).total).toBe(0);
		} finally {
			engine.close();
		}
	});

	it("binds grep cache and cursors to exact expression, effective case, scope and snapshot across reopen", async () => {
		const root = await tempDir("docs-regex-pages-root-");
		const agentDir = await tempDir("docs-regex-pages-agent-");
		await Bun.write(path.join(root, "a.md"), "# First\n pagebeacon \n## Second\n PAGEBEACON \n");
		await Bun.write(path.join(root, "b.md"), "# Third\n pagebeacon \n");
		let native = new WikiSearchEngine(path.join(agentDir, "docs.db"), path.join(agentDir, "docs.db"));
		try {
			await native.init(root, "first");
			await native.init(root, "second");
			await fs.rm(root, { recursive: true });
			const options = { mode: "grep", case: false, limit: 500 };
			const query = " pagebeacon ";
			const complete = native.searchWindow(query, options);
			expect(complete.result.total).toBe(6);
			expect(complete.result.exactNameMatches).toBe(0);
			expect(complete.result.technicalName).toBeUndefined();
			expect(complete.result.sections.map(hit => [hit.index, hit.path, hit.lineStart])).toEqual([
				["first", "a.md", 1],
				["first", "a.md", 3],
				["first", "b.md", 1],
				["second", "a.md", 1],
				["second", "a.md", 3],
				["second", "b.md", 1],
			]);
			const first = native.searchWindow(query, { ...options, limit: 1 });
			expect(first.cacheHit).toBe(true);
			expect(first.result.sections).toEqual(complete.result.sections.slice(0, 1));
			const cursor = Buffer.from(JSON.stringify({ ...first.result.cursorBase, p: 1 })).toString("base64url");
			for (const [changedQuery, changedOptions] of [
				["pagebeacon ", options],
				[query, { ...options, case: true }],
				[query, { mode: "search" }],
				[query, { ...options, index: "first" }],
			] as const)
				expect(() => native.searchWindow(changedQuery, { ...changedOptions, cursor })).toThrow();
			const otherIdentity = new WikiSearchEngine(path.join(agentDir, "docs.db"), path.join(agentDir, "other.db"));
			try {
				expect(() => otherIdentity.searchWindow(query, { ...options, cursor })).toThrow();
			} finally {
				otherIdentity.close();
			}
			const insensitive = native.searchWindow(query, { ...options, cursor });
			expect(insensitive.cacheHit).toBe(true);
			expect(insensitive.result.sections).toEqual(complete.result.sections.slice(1));
			expect(native.searchWindow(query, { mode: "grep" }).result.total).toBe(4);
			expect(native.searchWindow(query, { mode: "grep", case: true }).cacheHit).toBe(true);
			const search = native.searchWindow("pagebeacon", { limit: 1 });
			const searchCursor = Buffer.from(JSON.stringify({ ...search.result.cursorBase, p: 1 })).toString("base64url");
			expect(native.searchWindow("pagebeacon", { mode: "search", case: false, limit: 1 }).result).toEqual(
				search.result,
			);
			expect(() => native.searchWindow("pagebeacon", { mode: "grep", cursor: searchCursor })).toThrow();
			const delivered = [...first.result.sections];
			let position = 1;
			while (position < complete.result.total) {
				const nextCursor = Buffer.from(JSON.stringify({ ...first.result.cursorBase, p: position })).toString(
					"base64url",
				);
				native.close();
				native = new WikiSearchEngine(path.join(agentDir, "docs.db"), path.join(agentDir, "docs.db"));
				const page = native.searchWindow(query, { ...options, limit: 2, cursor: nextCursor });
				expect(page.cacheHit).toBe(false);
				expect(page.result.cursorBase.p).toBe(position);
				expect(page.result.sections.length).toBeGreaterThan(0);
				delivered.push(...page.result.sections);
				position += page.result.sections.length;
			}
			expect(delivered).toEqual(complete.result.sections);
			expect(new Set(delivered.map(hit => hit.sectionId)).size).toBe(6);
			withSqliteDatabase(path.join(agentDir, "docs.db"), db =>
				db
					.query("UPDATE sections SET raw_markdown=replace(raw_markdown, 'pagebeacon', 'gonebeacon') WHERE id=?")
					.run(first.result.sections[0].sectionId),
			);
			expect(() => native.searchWindow(query, { ...options, cursor })).toThrow("Stale");
			const fresh = native.searchWindow(query, options);
			expect(fresh.cacheHit).toBe(false);
			expect(fresh.result.total).toBe(5);
			expect(fresh.result.sections.some(hit => hit.sectionId === first.result.sections[0].sectionId)).toBe(false);
			expect(native.searchWindow(query, options).cacheHit).toBe(true);
		} finally {
			native.close();
		}
	});

	it("indexes rejected backtick fence openers without losing paragraph or valid fenced code", async () => {
		const root = await tempDir("docs-invalid-fence-root-");
		const agentDir = await tempDir("docs-invalid-fence-agent-");
		const source =
			"# Notes\n``` `invalidfencebeacon`\nThis is a normal paragraph.\n\n~~~ `valid-language`\ncounter*factor*next\n~~~\n";
		await Bun.write(path.join(root, "notes.md"), source);
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			expect(service.search("invalidfencebeacon").sections[0]?.text).toBe(source);
			expect(service.search("counter*factor*next").sections[0]?.text).toContain("counter*factor*next");
			expect(service.search("counterfactornext").sections).toEqual([]);
		} finally {
			service.close();
		}
	});

	it("preserves existing version-five hits on rejected fence lines during migration without source files", async () => {
		const root = await tempDir("docs-v5-fence-root-");
		const agentDir = await tempDir("docs-v5-fence-agent-");
		const source = "# Notes\n``` `migrationfencebeacon`\nOrdinary paragraph.\n";
		await Bun.write(path.join(root, "notes.md"), source);
		const writer = new DocsSearchEngine({ agentDir });
		await writer.init(root, "manual");
		const row = withSqliteDatabase(writer.databasePath, db => {
			const row = db.query("SELECT id,index_id FROM sections ORDER BY id LIMIT 1").get() as {
				id: number;
				index_id: number;
			};
			db.query(
				"UPDATE sections_fts SET section_id=?,index_id=?,relative_path=?,heading_path=?,body=? WHERE rowid=?",
			).run(row.id, row.index_id, "notes.md", "Notes", "Notes migrationfencebeacon Ordinary paragraph", row.id);
			db.run("PRAGMA user_version=5");
			return row;
		});
		expect(writer.search("migrationfencebeacon").sections).toHaveLength(1);
		writer.close();
		await fs.rm(root, { recursive: true });
		const reader = new DocsSearchEngine({ agentDir });
		try {
			expect(reader.search("migrationfencebeacon").sections[0]).toMatchObject({ sectionId: row.id, text: source });
		} finally {
			reader.close();
		}
	});

	it("repairs version-six indexes that already lost an invalid-fence keyword from searchable text", async () => {
		const root = await tempDir("docs-v6-fence-root-");
		const agentDir = await tempDir("docs-v6-fence-agent-");
		const source = "# Notes\n``` `repairfencebeacon`\nOrdinary paragraph.\n";
		await Bun.write(path.join(root, "notes.md"), source);
		const writer = new DocsSearchEngine({ agentDir });
		await writer.init(root, "manual");
		const row = withSqliteDatabase(writer.databasePath, db => {
			const row = db.query("SELECT id,index_id FROM sections ORDER BY id LIMIT 1").get() as {
				id: number;
				index_id: number;
			};
			db.query(
				"UPDATE sections_fts SET section_id=?,index_id=?,relative_path=?,heading_path=?,body=? WHERE rowid=?",
			).run(row.id, row.index_id, "notes.md", "Notes", "Notes Ordinary paragraph", row.id);
			db.run("PRAGMA user_version=6");
			return row;
		});
		writer.close();
		await fs.rm(root, { recursive: true });
		const reader = new DocsSearchEngine({ agentDir });
		try {
			expect(reader.search("repairfencebeacon").sections[0]).toMatchObject({ sectionId: row.id, text: source });
		} finally {
			reader.close();
		}
	});

	it("keeps literal fenced and inline code searchable without inventing merged identifiers", async () => {
		const root = await tempDir("docs-code-root-");
		const agentDir = await tempDir("docs-code-agent-");
		await Bun.write(
			path.join(root, "code.md"),
			"# Formula\n```python\ncounter*factor\n```\nUse `mask~value` and 缓**存**配置.\n",
		);
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "code");
			expect(service.search("counter*factor").sections[0]?.text).toContain("counter*factor");
			expect(service.search("mask~value").sections[0]?.text).toContain("mask~value");
			expect(service.search("counterfactor").sections).toEqual([]);
			expect(service.search("maskvalue").sections).toEqual([]);
			expect(service.search("缓存").sections[0]?.text).toContain("缓**存**配置");
		} finally {
			service.close();
		}
	});

	it("preserves code punctuation after a fenced block is split into multiple sections", async () => {
		const root = await tempDir("docs-code-chunks-root-");
		const agentDir = await tempDir("docs-code-chunks-agent-");
		await Bun.write(
			path.join(root, "code.md"),
			"# Formula\n```python\n" + "padding = 1\n".repeat(1600) + "counter*factor*next\n```\n",
		);
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "code");
			expect(
				service.search("counter*factor*next").sections.some(hit => hit.text.includes("counter*factor*next")),
			).toBe(true);
			expect(service.search("counterfactornext").sections).toEqual([]);
		} finally {
			service.close();
		}
	});

	it("preserves quoted fences across sections and repairs stored version-ten FTS without source files", async () => {
		const root = await tempDir("docs-quoted-code-root-");
		const agentDir = await tempDir("docs-quoted-code-agent-");
		for (const [file, quote, fence, newline] of [
			["quote.md", "> ", "```", "\n"],
			["nested.md", "> > ", "````", "\r\n"],
		]) {
			await Bun.write(
				path.join(root, file),
				`${quote}${fence}${newline}` +
					`${quote}filler${newline}`.repeat(2200) +
					`${quote}> \`\`\`${newline}${quote}counter*factor*next${newline}${quote}${fence}${newline}`,
			);
		}
		const writer = new DocsSearchEngine({ agentDir });
		await writer.init(root, "quoted");
		const indexId = writer.list()[0].id;
		const fresh = writer.search("counter factor next").sections;
		expect(fresh.map(hit => hit.path).sort()).toEqual(["nested.md", "quote.md"]);
		expect(
			writer
				.search("counter*factor*next")
				.sections.map(hit => hit.sectionId)
				.sort(),
		).toEqual(fresh.map(hit => hit.sectionId).sort());
		expect(writer.search("counterfactornext").sections).toEqual([]);
		withSqliteDatabase(writer.databasePath, db => {
			for (const hit of fresh) {
				db.query(
					"UPDATE sections_fts SET section_id=?,index_id=?,relative_path=?,heading_path=?,body=? WHERE rowid=?",
				).run(hit.sectionId, indexId, hit.path, "", "counterfactornext", hit.sectionId);
			}
			db.run("PRAGMA user_version=10");
		});
		writer.close();
		await fs.rm(root, { recursive: true });
		const reader = new DocsSearchEngine({ agentDir });
		try {
			expect(reader.search("counter factor next").sections).toEqual(fresh);
			expect(
				reader
					.search("counter*factor*next")
					.sections.map(hit => hit.sectionId)
					.sort(),
			).toEqual(fresh.map(hit => hit.sectionId).sort());
			expect(reader.search("counterfactornext").sections).toEqual([]);
		} finally {
			reader.close();
		}
	});

	it("retains one-word technical checklist headings while discarding converter labels", async () => {
		const root = await tempDir("docs-checklist-root-");
		const agentDir = await tempDir("docs-checklist-agent-");
		await Bun.write(
			path.join(root, "features.md"),
			"# Features\nAuthoritative list.\n## ATPG\n## C#\n#### Cell\n##### Row\n## MBIST\nMemory flow.\n",
		);
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "features");
			expect(service.search("ATPG").sections[0]?.text.trim()).toBe("## ATPG");
			expect(service.search("C#").sections[0]?.text.trim()).toBe("## C#");
			expect(
				withSqliteDatabase(
					service.databasePath,
					db =>
						db
							.query(
								"SELECT raw_markdown FROM sections WHERE raw_markdown LIKE '%Cell%' OR raw_markdown LIKE '%Row%'",
							)
							.all(),
					{ readonly: true },
				),
			).toEqual([]);
		} finally {
			service.close();
		}
	});

	it("retrieves whole words crossing long-line cuts with truthful UTF-8 source ranges", async () => {
		const root = await tempDir("docs-overlap-root-");
		const agentDir = await tempDir("docs-overlap-agent-");
		const text = "# Long\n" + "x ".repeat(8998) + "boundarybeacon " + "𐐀".repeat(10_000) + "\n";
		await Bun.write(path.join(root, "long.md"), text);
		const parsed = parseMarkdown(new TextEncoder().encode(text));
		const bytes = Buffer.from(text);
		for (const section of parsed.sections) {
			expect(section.rawMarkdown.length).toBeLessThanOrEqual(18_000);
			expect(bytes.subarray(section.byteStart, section.byteEnd).toString()).toBe(section.rawMarkdown);
		}
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "long");
			expect(service.search("boundarybeacon").sections.some(hit => hit.text.includes("boundarybeacon"))).toBe(true);
		} finally {
			service.close();
		}
	});

	it("repairs version-five searchable code from stored Markdown without source files", async () => {
		const root = await tempDir("docs-old-code-root-");
		const agentDir = await tempDir("docs-old-code-agent-");
		await Bun.write(path.join(root, "formula.md"), "# Formula\n`counter*factor`\n");
		const writer = new DocsSearchEngine({ agentDir });
		await writer.init(root, "legacy");
		const sectionId = writer.search("counter*factor").sections[0].sectionId;
		const indexId = writer.list().find(index => index.name === "legacy")!.id;
		withSqliteDatabase(writer.databasePath, db => {
			db.query(
				"UPDATE sections_fts SET section_id=?,index_id=?,relative_path=?,heading_path=?,body=? WHERE rowid=?",
			).run(sectionId, indexId, "formula.md", "Formula", "Formula counterfactor", sectionId);
			db.run("PRAGMA user_version=5");
		});
		writer.close();
		await fs.rm(root, { recursive: true });
		const reader = new DocsSearchEngine({ agentDir });
		try {
			expect(reader.search("counter*factor").sections[0]).toMatchObject({
				sectionId,
				index: "legacy",
				path: "formula.md",
			});
			expect(reader.search("counterfactor").sections).toEqual([]);
		} finally {
			reader.close();
		}
	});
	it("rejects invalid UTF-8 without publishing silently replaced text or a partial import", async () => {
		const root = await tempDir("docs-utf8-root-");
		const agentDir = await tempDir("docs-utf8-agent-");
		await fs.writeFile(path.join(root, "a.md"), "# Guide\nvalid corpus needle\n");
		await fs.writeFile(path.join(root, "b.md"), new Uint8Array([0x23, 0x20, 0xff, 0x0a]));
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await expect(service.init(".", "manual")).rejects.toThrow('Unable to parse Markdown "b.md"');
			expect(service.list()).toEqual([]);
			await fs.rm(path.join(root, "b.md"));
			await service.init(".", "manual");
			expect(service.search("needle").sections[0].text).toBe("# Guide\nvalid corpus needle\n");
		} finally {
			service.close();
		}
	});

	it("publishes only complete imports and discards cancellation or read failures", async () => {
		const root = await tempDir("docs-atomic-root-");
		const agentDir = await tempDir("docs-atomic-agent-");
		await fs.writeFile(path.join(root, "a.md"), "# A\nAlpha\n");
		await fs.writeFile(path.join(root, "b.md"), "# B\nBeta\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			const controller = new AbortController();
			await expect(
				service.init(".", "cancelled", {
					signal: controller.signal,
					onProgress: progress => {
						if (progress.completed === 1) {
							expect(service.list()).toEqual([]);
							controller.abort();
						}
					},
				}),
			).rejects.toMatchObject({ name: "AbortError" });
			expect(service.list()).toEqual([]);
			await expect(
				service.init(".", "failed", {
					onProgress: progress => {
						if (progress.completed === 1) {
							// The next source disappears after enumeration.
							unlinkSync(path.join(root, "b.md"));
						}
					},
				}),
			).rejects.toThrow();
			expect(service.list()).toEqual([]);
			const imported = await service.init(".", "manual");
			expect(imported.index.documentCount).toBe(1);
			await expect(service.init(".", "manual")).rejects.toThrow("already exists");
			expect(service.search("Alpha").sections[0].text).toBe("# A\nAlpha\n");
			service.remove("manual");
			expect(service.list()).toEqual([]);
			await service.init(".", "again");
			expect(service.search("Alpha").sections.map(hit => hit.index)).toEqual(["again"]);
		} finally {
			service.close();
		}
	});

	it("keeps a live import exclusive across process temp directories and physical database aliases", async () => {
		const root = await tempDir("docs-process-lease-source-");
		const agentDir = await tempDir("docs-process-lease-agent-");
		const childTemp = await tempDir("docs-process-lease-temp-");
		const independentDir = await tempDir("docs-process-lease-independent-");
		await fs.writeFile(path.join(root, "a.md"), "# A\nfirstleasebeacon\n");
		await fs.writeFile(path.join(root, "b.md"), "# B\nsecondleasebeacon\n");
		const service = new DocsSearchEngine({ agentDir });
		const hardlink = path.join(agentDir, "hardlink.db");
		const directoryAlias = path.join(agentDir, "alias");
		const removeAlias = () => {
			if (process.platform === "win32") rmdirSync(directoryAlias);
			else unlinkSync(directoryAlias);
		};
		let attempted = false;
		try {
			await fs.link(service.databasePath, hardlink);
			symlinkSync(agentDir, directoryAlias, process.platform === "win32" ? "junction" : "dir");
			const script = `
				import { FileLock, WikiSearchEngine, wikiImportLeasePath } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-natives"))};
				const database = ${JSON.stringify(service.databasePath)};
				const root = ${JSON.stringify(root)};
				const aliases = ${JSON.stringify([hardlink, path.join(directoryAlias, "docs.db")])};
				const aliasAcquired = aliases.map(alias => {
					const lease = FileLock.tryAcquire(wikiImportLeasePath(alias));
					try { return lease.acquired; } finally { lease.release(); }
				});
				const shared = new WikiSearchEngine(database, database);
				let contended = false;
				try {
					await shared.init(root, "second-importer");
				} catch (error) {
					if (!error.message.includes("Another document index build")) throw error;
					contended = true;
				} finally {
					shared.close();
				}
				const independentPath = ${JSON.stringify(path.join(independentDir, "docs.db"))};
				const independent = new WikiSearchEngine(independentPath, independentPath);
				let separate;
				try { separate = await independent.init(root, "independent"); }
				finally { independent.close(); }
				console.log(JSON.stringify({ aliasAcquired, contended, separate }));
			`;
			const result = await service.init(root, "first-importer", {
				onProgress: progress => {
					if (progress.phase !== "fts" || progress.completed !== 1 || attempted) return;
					attempted = true;
					const retained = readSqliteTables(service.databasePath, ["doc_indexes", "documents", "sections"]);
					// The native worker waits for this synchronous callback. The second
					// process must reject before it can reclaim the live hidden build.
					const child = Bun.spawnSync([process.execPath, "--eval", script], {
						cwd: childTemp,
						env: { ...process.env, TMP: childTemp, TEMP: childTemp, TMPDIR: childTemp },
						stdout: "pipe",
						stderr: "pipe",
						timeout: 10_000,
					});
					expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
						exitCode: 0,
						stderr: "",
					});
					expect(JSON.parse(child.stdout.toString())).toMatchObject({
						aliasAcquired: [false, false],
						contended: true,
						separate: { processed: 2, index: { name: "independent", documentCount: 2 } },
					});
					expect(readSqliteTables(service.databasePath, ["doc_indexes", "documents", "sections"])).toEqual(
						retained,
					);
				},
			});
			expect(attempted).toBe(true);
			expect(result).toMatchObject({
				processed: 2,
				index: { name: "first-importer", documentCount: 2 },
			});
			expect(service.list().map(index => index.name)).toEqual(["first-importer"]);
			expect(service.search("firstleasebeacon").sections).toHaveLength(1);
			expect(service.search("secondleasebeacon").sections).toHaveLength(1);
		} finally {
			service.close();
			if (existsSync(directoryAlias)) removeAlias();
		}
	}, 20_000);

	it.each(["continue", "cancel"] as const)(
		"preserves a colliding published index when a progress callback replaces the database (%s)",
		async transition => {
			const owned = await tempDir("docs-callback-replacement-");
			const root = path.join(owned, "source");
			const replacementRoot = path.join(owned, "replacement-source");
			const agentDir = path.join(owned, "agent");
			const replacementDir = path.join(owned, "replacement-agent");
			const originalDir = path.join(owned, "original-agent");
			await fs.mkdir(root);
			await fs.mkdir(replacementRoot);
			await fs.mkdir(originalDir);
			const aliasType = process.platform === "win32" ? "junction" : "dir";
			symlinkSync(originalDir, agentDir, aliasType);
			const removeAgentAlias = () => {
				if (process.platform === "win32") rmdirSync(agentDir);
				else unlinkSync(agentDir);
			};
			await fs.writeFile(path.join(root, "old.md"), "# Original\noldbuildboundarybeacon\n");
			const body = "# Replacement\nreplacementboundarybeacon\nFull retained evidence.\n";
			await fs.writeFile(path.join(replacementRoot, "kept.md"), body);
			const replacement = new DocsSearchEngine({ agentDir: replacementDir });
			const published = await replacement
				.init(replacementRoot, "published")
				.then(result => result.index)
				.finally(() => replacement.close());
			expect(published).toMatchObject({ name: "published", documentCount: 1, sectionCount: 1 });
			const tables = ["doc_indexes", "documents", "sections", "sections_fts"] as const;
			const retained = withSqliteDatabase(
				replacement.databasePath,
				db => tables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()),
				{ readonly: true },
			);
			const service = new DocsSearchEngine({ agentDir });
			try {
				const controller = new AbortController();
				let swapped = false;
				const importing = service.init(root, "old-build", {
					signal: controller.signal,
					onProgress: progress => {
						// Native scan progress runs after hidden-build creation, before the first commit.
						if (progress.phase !== "scan" || swapped) return;
						expect(progress.completed).toBe(0);
						const builds = withSqliteDatabase(
							service.databasePath,
							db =>
								db.query("SELECT id,name FROM doc_indexes ORDER BY id").all() as { id: number; name: string }[],
							{ readonly: true },
						);
						expect(builds).toHaveLength(1);
						expect(builds[0].name).toStartWith("__building__");
						expect(builds[0].id).toBe(published.id);
						expect(service.list()).toEqual([]);
						// Retarget only the owned alias; both physical databases and open handles stay put.
						removeAgentAlias();
						symlinkSync(replacementDir, agentDir, aliasType);
						swapped = true;
						// Reenter the real native owner so rollback also sees the replacement connection.
						expect(service.list()).toEqual([published]);
						if (transition === "cancel") controller.abort();
					},
				});
				if (transition === "cancel") {
					await expect(importing).rejects.toMatchObject({ name: "AbortError" });
				} else {
					await expect(importing).rejects.toThrow("Documentation database changed during document indexing");
				}
				expect(swapped).toBe(true);
				expect(
					withSqliteDatabase(
						service.databasePath,
						db => tables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()),
						{ readonly: true },
					),
				).toEqual(retained);
				expect(service.list()).toEqual([published]);
				await fs.rm(replacementRoot, { recursive: true });
				await fs.rm(root, { recursive: true });
				const result = service.search("replacementboundarybeacon", { index: "published" });
				expect(result.total).toBe(1);
				expect(result.sections.map(section => section.text)).toEqual([body]);
				expect(service.search("oldbuildboundarybeacon").sections).toEqual([]);
			} finally {
				service.close();
				if (existsSync(agentDir)) removeAgentAlias();
			}
		},
	);

	it.each([1, 2, 3])("migrates v%i structured and FTS indexes without source files", async version => {
		const agentDir = await tempDir("docs-legacy-agent-");
		const legacy = new Database(path.join(agentDir, "docs.db"), { strict: true, create: true });
		legacy.run(await Bun.file(path.join(import.meta.dir, "fixtures/docs-v3.sql")).text());
		if (version === 1) legacy.run("ALTER TABLE doc_indexes DROP COLUMN mode");
		if (version < 3) {
			legacy.run("DROP TABLE sections_fts");
			legacy.run(
				"CREATE VIRTUAL TABLE sections_fts USING fts5(section_id UNINDEXED,index_id UNINDEXED,relative_path,heading_path,body)",
			);
			legacy.run("ALTER TABLE sections ADD COLUMN plain_text TEXT NOT NULL DEFAULT ''");
		}
		for (const [id, name, mode] of [
			[7, "structured", "structured"],
			[11, "fulltext", "fts"],
		] as const) {
			legacy
				.query(`INSERT INTO doc_indexes(id,name,root_path,schema_id,schema_version,schema_json,schema_hash,state,created_at,updated_at${version > 1 ? ",mode" : ""})
				VALUES(?,?,'/source-no-longer-exists','dft',1,'{}','old','ready','created','updated'${version > 1 ? ",?" : ""})`)
				.run(id, name, ...(version > 1 ? [mode] : []));
			legacy
				.query(
					"INSERT INTO documents(id,index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms,status) VALUES(?,?,?,'Guide','markdown','hash',40,0,'ready')",
				)
				.run(id, id, `${name}.md`);
			legacy
				.query(
					"INSERT INTO sections(id,index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,0,'Guide',1,1,2,0,40,?)",
				)
				.run(id, id, id, `# Guide\r\nAlpha 中文 ${name}\r\n`);
			legacy
				.query(
					"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,'Guide',?)",
				)
				.run(id, id, id, `${name}.md`, `Alpha 中 文 ${name}`);
		}
		legacy.run(
			"INSERT INTO entities(id,index_id,kind,canonical_key,display_name) VALUES(1,7,'item','alpha','Alpha')",
		);
		legacy.run(
			"INSERT INTO evidence(index_id,section_id,entity_id,quote,line_start,line_end,byte_start,byte_end,confidence) VALUES(7,7,1,'Alpha',2,2,9,14,1)",
		);
		legacy.run(`PRAGMA user_version=${version}`);
		legacy.close();

		const service = new DocsSearchEngine({ agentDir });
		try {
			expect(service.list().map(index => index.name)).toEqual(["fulltext", "structured"]);
			for (const [id, name] of [
				[7, "structured"],
				[11, "fulltext"],
			] as const) {
				expect(service.search("Alpha 中文", { index: name }).sections.map(hit => hit.sectionId)).toEqual([id]);
				expect(service.search("Alpha 中文", { index: name }).sections[0]).toMatchObject({
					path: `${name}.md`,
					lineStart: 1,
					lineEnd: 2,
					text: `# Guide\r\nAlpha 中文 ${name}\r\n`,
				});
			}
			expect(
				withSqliteDatabase(service.databasePath, db => db.query("PRAGMA foreign_key_check").all(), {
					readonly: true,
				}),
			).toEqual([]);
			service.remove("structured");
			expect(service.search("Alpha").sections.map(hit => hit.index)).toEqual(["fulltext"]);
		} finally {
			service.close();
		}
		const reopened = new DocsSearchEngine({ agentDir });
		try {
			expect(reopened.search("Alpha", { index: "fulltext" }).sections[0].text).toBe(
				"# Guide\r\nAlpha 中文 fulltext\r\n",
			);
		} finally {
			reopened.close();
		}
	});

	it("supports ASCII and Han character full-text search", async () => {
		const root = await tempDir("docs-search-root-");
		const agent = await tempDir("docs-search-agent-");
		await fs.writeFile(path.join(root, "mixed.md"), "# Mixed\nItem: Alpha\n中文接口说明\n");
		const service = new DocsSearchEngine({ agentDir: agent, cwd: root });
		try {
			await service.init(".", "mixed");
			expect(service.search("Alpha", { index: "mixed" }).sections.length).toBe(1);
			expect(service.search("中文", { index: "mixed" }).sections.length).toBe(1);
		} finally {
			service.close();
		}
	});

	it.skipIf(process.platform !== "linux")("keeps case-distinct source documents separate", async () => {
		const root = await tempDir("docs-case-root-");
		const agent = await tempDir("docs-case-agent-");
		await fs.writeFile(path.join(root, "A.md"), "# Upper\nItem: Alpha one\n");
		await fs.writeFile(path.join(root, "a.md"), "# Lower\nItem: Alpha two\n");
		const service = new DocsSearchEngine({ agentDir: agent, cwd: root });
		try {
			await service.init(".", "case");
			const hits = service.search("Alpha", { index: "case" }).sections;
			expect(hits.map(hit => hit.path).sort()).toEqual(["A.md", "a.md"]);
			expect(hits.find(hit => hit.path === "A.md")!.text).toContain("Alpha one");
			expect(hits.find(hit => hit.path === "a.md")!.text).toContain("Alpha two");
		} finally {
			service.close();
		}
	});

	it("keeps ordinary names containing the building pattern visible", async () => {
		const root = await tempDir("docs-visible-root-");
		const agent = await tempDir("docs-visible-agent-");
		await fs.writeFile(path.join(root, "guide.md"), "# Guide\nbuilding visibility\n");
		const service = new DocsSearchEngine({ agentDir: agent, cwd: root });
		const name = "abbuildingcd";
		try {
			await service.init(".", name);
			expect(service.list().map(index => index.name)).toEqual([name]);
			expect(service.list()[0]?.rootPath).toBe(root);
			expect(service.search("visibility", { index: name }).sections).toHaveLength(1);
			await expect(service.init(".", "__building__user")).rejects.toThrow("reserved prefix");
			service.remove(name);
			expect(service.list()).toEqual([]);
		} finally {
			service.close();
		}
	});

	it("matches Chinese words by adjacency, ranking the unbroken spelling first", async () => {
		const root = await tempDir("docs-chinese-rank-");
		const agentDir = await tempDir("docs-chinese-agent-");
		await fs.writeFile(path.join(root, "exact.md"), `# Notes\n缓**存**配置。\n${"背景说明 ".repeat(100)}`);
		await fs.writeFile(path.join(root, "scattered.md"), "# Notes\n缓慢增长，存储优化。\n");
		await fs.writeFile(path.join(root, "punctuated.md"), "# Notes\n缓，存。\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			await fs.rm(root, { recursive: true });
			const hits = service.search("缓存", { index: "manual" }).sections;
			// Scattered characters (`缓慢…存储`) no longer satisfy the word, and the
			// unbroken spelling outranks the punctuation-split one.
			expect(hits.map(hit => hit.path)).toEqual(["exact.md", "punctuated.md"]);
			expect(hits[0].text).toContain("缓**存**配置");
		} finally {
			service.close();
		}
	});

	it.each([
		{ query: "C++", exact: "支持C++接口。", loose: "C C# C++17" },
		{ query: "std::vector", exact: "Use `std::vector`.", loose: "vector std" },
		{ query: "--flag", exact: "Set `--flag=value`.", loose: "flag" },
		{ query: "foo_bar", exact: "Call `foo_bar`.", loose: "foo bar foo_bar_baz" },
		{ query: "v1.2.3", exact: "Install v1.2.3.", loose: "v1 2 3 v1.2.30" },
		{ query: "src/foo.ts", exact: "Edit `src/foo.ts`.", loose: "ts elsewhere foo src src/foo.ts.bak" },
		{ query: "MBIST_CHECK.RPT", exact: "Read `mbist_check.rpt`.", loose: "rpt mbist_check.rpt.bak" },
		{ query: "E123", exact: "Handle e123.", loose: "E1234 E123_extra" },
		{ query: "ERR-123", exact: "Handle `err-123`.", loose: "ERR 123 ERR-1234 prefixERR-123 ERR-123-extra" },
		{ query: "E-FATAL", exact: "Handle `e-fatal`.", loose: "E FATAL E-FATALity prefixE-FATAL E-FATAL-next" },
	])("prioritizes the complete technical name $query", async ({ query, exact, loose }) => {
		const root = await tempDir("docs-technical-rank-");
		const agentDir = await tempDir("docs-technical-agent-");
		await fs.writeFile(path.join(root, "exact.md"), `# Notes\n${exact}\n${"background ".repeat(100)}`);
		await fs.writeFile(path.join(root, "loose.md"), `# Notes\n${loose}\n`);
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const hits = service.search(query, { index: "manual" }).sections;
			expect(hits.map(hit => hit.path)).toEqual(["exact.md", "loose.md"]);
			expect(hits[0].matchKind).toBe("exact-name");
			expect(hits[1].matchKind).toBe("related");
			expect(service.search(query, { index: "manual" })).toMatchObject({
				total: 2,
				exactNameMatches: 1,
				technicalName: query,
				hasMore: false,
			});
		} finally {
			service.close();
		}
	});

	it.each(["hisms", "scan", "resolveWidget"])(
		"classifies the bounded plain command or identifier %s without trusting prefixes or filenames",
		async command => {
			const root = await tempDir("docs-plain-name-root-");
			const agentDir = await tempDir("docs-plain-name-agent-");
			await fs.writeFile(path.join(root, "exact.md"), `# Notes\nInvoke \`${command.toUpperCase()}\`.\n`);
			await fs.writeFile(
				path.join(root, "continued.md"),
				`# Notes\n${command}_extended prefix${command} ${command}-next\n`,
			);
			await fs.writeFile(path.join(root, `${command}.md`), "# Notes\nMetadata only; no command evidence.\n");
			const service = new DocsSearchEngine({ agentDir, cwd: root });
			try {
				await service.init(".", "manual");
				const result = service.search(command, { index: "manual" });
				expect(result).toMatchObject({ total: 3, technicalName: command, exactNameMatches: 1, hasMore: false });
				expect(result.sections[0]).toMatchObject({ path: "exact.md", matchKind: "exact-name" });
				expect(result.sections.find(hit => hit.path === "continued.md")?.matchKind).toBe("related");
				expect(result.sections.find(hit => hit.path === `${command}.md`)?.matchKind).toBe("related");
			} finally {
				service.close();
			}
		},
	);

	it.each([
		{ query: "Why does err-123 occur?", name: "err-123" },
		{ query: "How should e-fatal be handled?", name: "e-fatal" },
		{ query: "Explain mbist_check.rpt.", name: "mbist_check.rpt" },
		{ query: "Explain v1.2.3.", name: "v1.2.3" },
		{ query: "Explain std::vector.", name: "std::vector" },
		{ query: "Explain src/foo.ts.", name: "src/foo.ts" },
	])("recognizes the complete technical name inside $query", async ({ query, name }) => {
		const root = await tempDir("docs-hyphen-name-root-");
		const agentDir = await tempDir("docs-hyphen-name-agent-");
		await fs.writeFile(path.join(root, "exact.md"), `# Notes\nHandle \`${name.toUpperCase()}\`.\n`);
		await fs.writeFile(path.join(root, "continued.md"), `# Notes\nprefix${name} ${name}_extra ${name}-next\n`);
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const result = service.search(query, { index: "manual" });
			expect(result).toMatchObject({ total: 2, technicalName: name, exactNameMatches: 1, hasMore: false });
			expect(result.sections.map(hit => ({ path: hit.path, matchKind: hit.matchKind }))).toEqual([
				{ path: "exact.md", matchKind: "exact-name" },
				{ path: "continued.md", matchKind: "related" },
			]);
		} finally {
			service.close();
		}
	});

	it.each(["file.rpt.", "`file.rpt.`"])("keeps terminal punctuation in the standalone spelling %s", async query => {
		const root = await tempDir("docs-literal-punctuation-root-");
		const agentDir = await tempDir("docs-literal-punctuation-agent-");
		await fs.writeFile(path.join(root, "literal.md"), "# Notes\nfile.rpt.\n");
		await fs.writeFile(path.join(root, "dotless.md"), "# Notes\nfile.rpt\n");
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			const result = service.search(query, { index: "manual" });
			expect(result).toMatchObject({ total: 2, technicalName: "file.rpt.", exactNameMatches: 1, hasMore: false });
			expect(result.sections.map(hit => ({ path: hit.path, matchKind: hit.matchKind }))).toEqual([
				{ path: "literal.md", matchKind: "exact-name" },
				{ path: "dotless.md", matchKind: "related" },
			]);
		} finally {
			service.close();
		}
	});

	it.each([
		{ spelling: "C++", suffix: "17", query: "C++" },
		{ spelling: "Ｃ＋＋", suffix: "17", query: "C++" },
		{ spelling: "mbist\\_check.rpt", suffix: ".bak", query: "mbist_check.rpt" },
	])("rejects the artificial right boundary after $spelling", async ({ spelling, suffix, query }) => {
		const root = await tempDir("docs-right-boundary-root-");
		const agentDir = await tempDir("docs-right-boundary-agent-");
		const padding = "x ".repeat(Math.floor((18_000 - spelling.length) / 2));
		const body = `${padding}${" ".repeat(18_000 - padding.length - spelling.length)}${spelling}${suffix}\n`;
		const source = `# Notes\n${body}`;
		await fs.writeFile(path.join(root, "continued.md"), source);
		await fs.writeFile(path.join(root, "standalone.md"), query);
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			const truncated = withSqliteDatabase(
				service.databasePath,
				db =>
					db.query("SELECT id,raw_markdown FROM sections WHERE raw_markdown=?").get(body.slice(0, 18_000)) as {
						id: number;
						raw_markdown: string;
					},
				{ readonly: true },
			);
			await fs.rm(root, { recursive: true });
			const result = service.search(query, { index: "manual", limit: 500 });
			expect(result.exactNameMatches).toBe(1);
			expect(result.sections[0]).toMatchObject({ path: "standalone.md", text: query, matchKind: "exact-name" });
			expect(result.sections.find(hit => hit.sectionId === truncated.id)).toMatchObject({
				text: truncated.raw_markdown,
				matchKind: "related",
			});
			if (query === "C++") {
				const complete = service.search("C++17", { index: "manual", limit: 500 });
				expect(complete.exactNameMatches).toBe(1);
				expect(complete.sections[0]).toMatchObject({ path: "continued.md", matchKind: "exact-name" });
				expect(complete.sections[0].text.normalize("NFKC")).toContain("C++17");
			}
		} finally {
			service.close();
		}
	});

	it.each([2, 36_000])(
		"normalizes all %i combining marks across stored chunks before classifying exact names",
		async marks => {
			const root = await tempDir("docs-combining-boundary-root-");
			const agentDir = await tempDir("docs-combining-boundary-agent-");
			const source = `${"x ".repeat(8998)}scan${"\u0334".repeat(marks)}\u0303`;
			await fs.writeFile(path.join(root, "continued.md"), source);
			const service = new DocsSearchEngine({ agentDir });
			try {
				await service.init(root, "manual");
				await fs.rm(root, { recursive: true });
				const partial = service.search("scan", { index: "manual", limit: 500 });
				expect(partial.exactNameMatches).toBe(0);
				expect(partial.sections.every(hit => hit.matchKind === "related")).toBe(true);
				if (marks === 2) {
					const complete = service.search("scañ", { index: "manual", limit: 500 });
					expect(complete.exactNameMatches).toBe(1);
					expect(complete.sections[0]).toMatchObject({ path: "continued.md", matchKind: "exact-name" });
					expect(complete.sections[0].text.normalize("NFKC")).toContain("scañ");
				}
			} finally {
				service.close();
			}
		},
	);

	it.each([
		{ padding: `${"x ".repeat(8749)} p`, whole: "pC++" },
		{ padding: `${"x ".repeat(8748)}x 𐐀`, whole: "𐐀C++" },
	])("rejects the artificial left boundary inside $whole using UTF-8 offsets", async ({ padding, whole }) => {
		const root = await tempDir("docs-left-boundary-root-");
		const agentDir = await tempDir("docs-left-boundary-agent-");
		const source = `# Notes\n${padding}C++ ${"x ".repeat(1000)}\n`;
		await fs.writeFile(path.join(root, "continued.md"), source);
		await fs.writeFile(path.join(root, "standalone.md"), "C++");
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			const fragment = withSqliteDatabase(
				service.databasePath,
				db =>
					db.query("SELECT id,raw_markdown FROM sections WHERE raw_markdown LIKE 'C++ %'").get() as {
						id: number;
						raw_markdown: string;
					},
				{ readonly: true },
			);
			await fs.rm(root, { recursive: true });
			const result = service.search("C++", { index: "manual", limit: 500 });
			expect(result.exactNameMatches).toBe(1);
			expect(result.sections[0]).toMatchObject({ path: "standalone.md", text: "C++", matchKind: "exact-name" });
			expect(result.sections.find(hit => hit.sectionId === fragment.id)).toMatchObject({
				text: fragment.raw_markdown,
				matchKind: "related",
			});
			const complete = service.search(whole, { index: "manual", limit: 500 });
			expect(complete.exactNameMatches).toBe(1);
			expect(complete.sections[0].text).toContain(whole);
		} finally {
			service.close();
		}
	});

	it("never borrows an exact name that exists only before the overlapping body", async () => {
		const root = await tempDir("docs-boundary-evidence-root-");
		const agentDir = await tempDir("docs-boundary-evidence-agent-");
		const source = `# Notes\n${"x ".repeat(8749)}E1. ${"x ".repeat(1000)}\n`;
		await fs.writeFile(path.join(root, "evidence.md"), source);
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			await fs.rm(root, { recursive: true });
			const result = service.search("E1", { index: "manual", limit: 500 });
			expect(result).toMatchObject({ total: 1, exactNameMatches: 1, hasMore: false });
			expect(result.sections[0].text).toContain("E1.");
		} finally {
			service.close();
		}
	});

	it("prefers complete topical evidence over partial path or inherited-heading matches", async () => {
		const root = await tempDir("docs-metadata-rank-");
		const agentDir = await tempDir("docs-metadata-agent-");
		await fs.writeFile(path.join(root, "body-all.md"), "# Notes\npathparent appears first; needle appears later.\n");
		await fs.mkdir(path.join(root, "needle"), { recursive: true });
		await fs.writeFile(path.join(root, "needle", "path.md"), "# PathParent\nlocal body\n");
		await fs.writeFile(path.join(root, "inherited.md"), "# PathParent\n## Local\nneedle here\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const hits = service.search("pathparent needle", { index: "manual" }).sections;
			const bodyIndex = hits.findIndex(hit => hit.path === "body-all.md");
			expect(bodyIndex).toBeGreaterThanOrEqual(0);
			expect(bodyIndex).toBeLessThan(hits.findIndex(hit => hit.path === "needle/path.md"));
			expect(bodyIndex).toBeLessThan(
				hits.findIndex(hit => hit.path === "inherited.md" && hit.headingPath.endsWith("Local")),
			);
		} finally {
			service.close();
		}
	});

	it("ranks full stored evidence beyond its opening text above scattered terms", async () => {
		const root = await tempDir("docs-late-phrase-rank-");
		const agentDir = await tempDir("docs-late-phrase-agent-");
		await fs.writeFile(
			path.join(root, "late-exact.md"),
			`# Notes\nstd and vector mentioned separately at first.\n${"background ".repeat(400)}\nUse std::vector here.\n`,
		);
		await fs.writeFile(path.join(root, "early-loose.md"), "# Notes\nstd and vector mentioned separately.\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const hits = service.search("std::vector", { index: "manual" }).sections;
			expect(hits.map(hit => hit.path)).toEqual(["late-exact.md", "early-loose.md"]);
			expect(hits[0].matchKind).toBe("exact-name");
			expect(hits[0].text).toContain("Use std::vector here.");
		} finally {
			service.close();
		}
	});

	it("preserves long astral Unicode evidence when matching a technical name", async () => {
		const root = await tempDir("docs-astral-phrase-root-");
		const agentDir = await tempDir("docs-astral-phrase-agent-");
		await fs.writeFile(path.join(root, "exact.md"), `# Notes\n${"\u{1d11e}".repeat(2_500)}\nUse std::vector here.\n`);
		await fs.writeFile(path.join(root, "loose.md"), "# Notes\nvector std\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const hits = service.search("std::vector").sections;
			expect(hits.map(hit => hit.path)).toEqual(["exact.md", "loose.md"]);
			expect(hits[0].text).toContain("Use std::vector here.");
		} finally {
			service.close();
		}
	});

	it("prefers a topical section title over an incidental mention or inherited heading", async () => {
		const root = await tempDir("docs-title-rank-");
		const agentDir = await tempDir("docs-title-agent-");
		await fs.writeFile(path.join(root, "topic.md"), `# Cache invalidation\n${"background ".repeat(150)}`);
		await fs.writeFile(path.join(root, "mention.md"), "# Notes\nCache invalidation.\n");
		await fs.writeFile(path.join(root, "inherited.md"), "# Cache invalidation\n## Unrelated appendix\nNotes.\n");
		await fs.writeFile(path.join(root, "indented-code.md"), "    # cache invalidation\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const result = service.search("cache invalidation", { index: "manual" });
			expect(result.technicalName).toBeUndefined();
			expect(service.search("How does cache invalidation work?", { index: "manual" }).technicalName).toBeUndefined();
			const hits = result.sections;
			const topic = hits.findIndex(hit => hit.path === "topic.md");
			expect(topic).toBeGreaterThanOrEqual(0);
			expect(topic).toBeLessThan(hits.findIndex(hit => hit.path === "mention.md"));
			expect(topic).toBeLessThan(hits.findIndex(hit => hit.headingPath.endsWith("Unrelated appendix")));
			expect(topic).toBeLessThan(hits.findIndex(hit => hit.path === "indented-code.md"));
		} finally {
			service.close();
		}
	});

	it.each([
		"# Cache invalidation\n",
		"   # Cache invalidation\n",
		"Cache invalidation\n---\n",
		"   Cache invalidation\n   ---\n",
	])("recognizes legal title indentation without promoting code for %j", async heading => {
		const root = await tempDir("docs-title-context-root-");
		const agentDir = await tempDir("docs-title-context-agent-");
		const topic = `${heading}${"background ".repeat(160)}`;
		await fs.writeFile(path.join(root, "topic.md"), topic);
		await fs.writeFile(path.join(root, "indented-atx.md"), "    # cache invalidation\n");
		await fs.writeFile(path.join(root, "tab-atx.md"), "\t# cache invalidation\n");
		await fs.writeFile(path.join(root, "indented-setext.md"), "    cache invalidation\n    ---\n");
		await fs.writeFile(
			path.join(root, "fenced.md"),
			`# Notes\n\`\`\`md\n${"x\n".repeat(8993)}# cache invalidation\n\`\`\`\n`,
		);
		await fs.writeFile(
			path.join(root, "continued-line.md"),
			`# Notes\n${"x ".repeat(8750)}# cache invalidation ${"x ".repeat(300)}\n`,
		);
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			await fs.rm(root, { recursive: true });
			const result = service.search("cache invalidation", { index: "manual", limit: 500 });
			expect(result.sections[0]).toMatchObject({ path: "topic.md", text: topic });
			for (const file of ["indented-atx.md", "tab-atx.md", "indented-setext.md", "fenced.md", "continued-line.md"])
				expect(result.sections.some(hit => hit.path === file)).toBe(true);
			expect(
				result.sections.some(hit => hit.path === "fenced.md" && hit.text.startsWith("# cache invalidation")),
			).toBe(true);
			expect(
				result.sections.some(
					hit => hit.path === "continued-line.md" && hit.text.startsWith("# cache invalidation"),
				),
			).toBe(true);
		} finally {
			service.close();
		}
	});

	it.each(["constructor", "toString", "prototype"])("treats %s as a topic rather than a function word", async term => {
		const root = await tempDir("docs-own-term-root-");
		const agentDir = await tempDir("docs-own-term-agent-");
		const topic = `# ${term} diagnostics\n${term} troubleshooting log analysis.\n`;
		await fs.writeFile(path.join(root, "topic.md"), topic);
		await fs.writeFile(path.join(root, "log.md"), "# Log\nlog.\n");
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			const result = service.search(`${term} log`, { index: "manual" });
			expect(result).toMatchObject({ total: 2, exactNameMatches: 0, hasMore: false });
			expect(result.sections.map(hit => hit.path)).toEqual(["topic.md", "log.md"]);
			expect(result.sections[0].text).toBe(topic);
		} finally {
			service.close();
		}
	});

	it("treats quotes as ordinary query characters for literal-phrase ranking", async () => {
		const root = await tempDir("docs-quoted-rank-");
		const agentDir = await tempDir("docs-quoted-agent-");
		await fs.writeFile(path.join(root, "quoted.md"), `# Notes\n"foo"\n${"background ".repeat(300)}`);
		await fs.writeFile(path.join(root, "plain.md"), "# Notes\nfoo\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const hits = service.search('"foo"', { index: "manual" }).sections;
			expect(hits.map(hit => hit.path)).toEqual(["quoted.md", "plain.md"]);
		} finally {
			service.close();
		}
	});

	it("globally ranks complete names beyond a thousand misleading matches with index isolation", async () => {
		const root = await tempDir("docs-candidates-rank-");
		const agentDir = await tempDir("docs-candidates-agent-");
		await fs.writeFile(
			path.join(root, "misleading.md"),
			Array.from({ length: 1_201 }, (_, index) => `## Notes ${index}\nvector std\n`).join("\n"),
		);
		await fs.writeFile(path.join(root, "exact.md"), `# Notes\nUse std::vector.\n${"background ".repeat(150)}`);
		await fs.writeFile(path.join(root, "partial.md"), "# Notes\nstd only\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			await service.init(".", "other");
			expect(service.search("std::vector", { index: "manual", limit: 1 }).sections.map(hit => hit.path)).toEqual([
				"exact.md",
			]);
			let page = service.search("std::vector", { index: "manual", limit: 500 });
			const all = [...page.sections];
			while (page.cursor) {
				page = service.search("std::vector", { index: "manual", limit: 500, cursor: page.cursor });
				all.push(...page.sections);
			}
			expect(all).toHaveLength(1_203);
			expect(new Set(all.map(hit => hit.sectionId)).size).toBe(1_203);
			expect(all.every(hit => hit.index === "manual")).toBe(true);
			// A section holding one term only still matches the union, but ranks below
			// the section carrying the complete name.
			expect(all.findIndex(hit => hit.path === "partial.md")).toBeGreaterThan(
				all.findIndex(hit => hit.path === "exact.md"),
			);
			// An unknown term does not empty the result: the known terms still answer.
			expect(service.search("std::vector nonexistent", { index: "manual" }).sections.length).toBeGreaterThan(0);
			expect(service.search("!!!", { index: "manual" }).sections).toEqual([]);
		} finally {
			service.close();
		}
	});

	it("keeps legacy stubs reachable after distinct readable evidence", async () => {
		const root = await tempDir("docs-stub-window-");
		const agentDir = await tempDir("docs-stub-window-agent-");
		for (let index = 0; index < 150; index++)
			await fs.writeFile(
				path.join(root, `req-${index}.md`),
				`# Requirement ${index}\n## 检查项\n${"背景说明 ".repeat(120)}本项检查 needle 的结果必须记录。\n`,
			);
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const indexId = service.list()[0].id as number;
			// Legacy converter labels remain indexed, but never displace readable
			// evidence. They must still be reachable through continuation pages.
			withSqliteDatabase(service.databasePath, db => {
				db.transaction(() => {
					for (let index = 0; index < 700; index++) {
						const document = db
							.query(
								"INSERT INTO documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms) VALUES(?,?,?,?,?,?,?) RETURNING id",
							)
							.get(indexId, `legacy/label-${index}.md`, "Cell", "doc", "0", 0, 0) as { id: number };
						const section = db
							.query(
								"INSERT INTO sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
							)
							.get(indexId, document.id, 0, "Cell", 2, 1, 1, 0, 11, "## Cell\n") as { id: number };
						db.query(
							"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
						).run(section.id, section.id, indexId, "", "Cell", "needle needle needle needle needle needle");
					}
				})();
			});
			const hits = service.search("needle", { index: "manual", limit: 200 }).sections;
			// Readable evidence comes first; stubs retain their own locators later.
			const readable = hits.filter(hit => hit.text.includes("必须记录"));
			expect(readable.length).toBe(150);
			expect(hits.slice(0, 150).every(hit => hit.text.includes("必须记录"))).toBe(true);
			const delivered = [...hits];
			let page = service.search("needle", { index: "manual", limit: 200 });
			while (page.cursor) {
				page = service.search("needle", { index: "manual", limit: 200, cursor: page.cursor });
				delivered.push(...page.sections);
			}
			expect(delivered).toHaveLength(850);
			expect(new Set(delivered.map(hit => hit.sectionId)).size).toBe(850);
			expect(page).toMatchObject({ total: 850, hasMore: false });
		} finally {
			service.close();
		}
	});

	it("counts only the matches the page may serve", async () => {
		const root = await tempDir("docs-hidden-count-");
		const agentDir = await tempDir("docs-hidden-count-agent-");
		await fs.writeFile(path.join(root, "visible.md"), "# Visible\nneedle in the visible index\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			// A half-built import shares this database under a hidden name; its rows
			// must not pad a count the page is never allowed to serve from.
			withSqliteDatabase(service.databasePath, db => {
				db.transaction(() => {
					const hidden = db
						.query("INSERT INTO doc_indexes(name,root_path) VALUES(?,?) RETURNING id")
						.get("__building__count", root) as { id: number };
					const document = db
						.query(
							"INSERT INTO documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms) VALUES(?,?,?,?,?,?,?) RETURNING id",
						)
						.get(hidden.id, "hidden.md", "Hidden", "doc", "0", 0, 0) as { id: number };
					const section = db
						.query(
							"INSERT INTO sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
						)
						.get(
							hidden.id,
							document.id,
							0,
							"Hidden",
							1,
							1,
							2,
							0,
							30,
							"# Hidden\nneedle in the hidden index\n",
						) as {
						id: number;
					};
					db.query(
						"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
					).run(section.id, section.id, hidden.id, "hidden.md", "Hidden", "needle hidden body");
				})();
			});
			const result = service.search("needle");
			expect(result.sections.map(hit => hit.path)).toEqual(["visible.md"]);
			expect(result.total).toBe(1);
		} finally {
			service.close();
		}
	});

	it("keeps the tail of a query that exceeds the term budget", async () => {
		const root = await tempDir("docs-query-tail-");
		const agentDir = await tempDir("docs-query-tail-agent-");
		await fs.writeFile(path.join(root, "tail.md"), "# Tail\nneedle here\n");
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			// 33 filler terms push the query past the 32-term sampling budget; a
			// sentence's final term must still reach the corpus.
			const query = [...Array.from({ length: 33 }, (_, index) => `zz${index}`), "needle"].join(" ");
			expect(service.search(query).sections.map(hit => hit.path)).toEqual(["tail.md"]);
		} finally {
			service.close();
		}
	});

	it("prefers the natural-language technology topic over generic checklist term saturation", async () => {
		const root = await tempDir("docs-topic-query-root-");
		const agentDir = await tempDir("docs-topic-query-agent-");
		await fs.writeFile(
			path.join(root, "topic.md"),
			"# SERDES sim log\n编译必须完成，仿真日志必须包含 Test Finished，错误计数为零。\n",
		);
		await fs.writeFile(
			path.join(root, "template.md"),
			"# 全面的检查项\n检查项和通过判据有哪些：仿真 log 检查项，通过判据。技术清单含 SERDES、ATPG、CPU。\n",
		);
		await fs.writeFile(
			path.join(root, "inherited.md"),
			"# SERDES\n## 无关模板\n检查项和通过判据有哪些，仿真 log，检查项，通过判据。\n",
		);
		await fs.writeFile(path.join(root, "clock-checklist.md"), "# SERDES 仿真检查项和通过判据有哪些：时钟必须正常\n");
		await fs.writeFile(
			path.join(root, "quality.md"),
			"# SERDES 过程质量检查\n检查仿真设计是否最新，检查各阶段 log 和报告，确认各项 pass。\n",
		);
		await fs.writeFile(
			path.join(root, "overview.md"),
			"# SERDES 概述\n仿真 log 的检查项和通过判据有哪些，SERDES 包括编译、运行和结果分析。\n",
		);
		await fs.writeFile(
			path.join(root, "different-flow.md"),
			"# MASIS waveform 检查\n仿真 log 检查项和通过判据有哪些，SERDES 是其他流程。\n",
		);
		await fs.writeFile(path.join(root, "heading-only.md"), "# SERDES sim log\n");
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			const result = service.search("serdes 仿真 log 的检查项和通过判据有哪些", { index: "manual" });
			expect(result.sections[0].path).toBe("topic.md");
			expect(result.sections[0].text).toContain("错误计数为零");
			expect(result.total).toBeGreaterThan(1);
		} finally {
			service.close();
		}
	});

	it("recovers literal names absent from FTS without labeling inherited or continued names exact", async () => {
		const root = await tempDir("docs-literal-scan-root-");
		const agentDir = await tempDir("docs-literal-scan-agent-");
		await fs.writeFile(path.join(root, "exact.md"), "# Notes\nRead MBIST_CHECK.RPT for evidence.\n");
		await fs.writeFile(
			path.join(root, "continued.md"),
			"# Notes\nrpt mbist_check.rpt.bak prefixmbist_check.rpt mbist_check.rpt_extra mbist_check.rpt/next\n",
		);
		await fs.writeFile(path.join(root, "inherited.md"), "# mbist_check.rpt\n## Other\nrpt only.\n");
		await fs.writeFile(path.join(root, "escaped.md"), "# Notes\nRead mbist\\_check.rpt for evidence.\n");
		await fs.writeFile(path.join(root, "path.md"), "# Notes\nRead /reports/mbist_check.rpt for evidence.\n");
		await fs.writeFile(
			path.join(root, "escaped-path.md"),
			"# Notes\nRead /reports/mbist\\_check.rpt for evidence.\n",
		);
		await fs.writeFile(
			path.join(root, "windows-path.md"),
			"# Notes\nRead C:\\reports\\mbist_check.rpt for evidence.\n",
		);
		await fs.writeFile(
			path.join(root, "spliced.md"),
			"# Notes\nrpt only: `mbist`_check.rpt and mbist_`check`.rpt and `mbist_``check.rpt`.\n",
		);
		await fs.writeFile(
			path.join(root, "escaped-continued.md"),
			"# Notes\nrpt mbist\\_check.rpt.bak my\\_mbist\\_check.rpt namespace::mbist\\_check.rpt\n",
		);
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			const initial = service.search("mbist_check.rpt", { limit: 500 }).sections;
			const exact = initial.find(hit => hit.path === "exact.md")!;
			withSqliteDatabase(service.databasePath, db => {
				db.transaction(() => {
					for (const file of ["exact.md", "escaped.md", "path.md", "escaped-path.md", "windows-path.md"])
						db.query("DELETE FROM sections_fts WHERE rowid=?").run(
							initial.find(hit => hit.path === file)!.sectionId,
						);
				})();
			});
			await fs.rm(root, { recursive: true });
			const result = service.search("mbist_check.rpt", { index: "manual", limit: 500 });
			expect(result.exactNameMatches).toBe(6);
			expect(result.sections.find(hit => hit.path === "exact.md")).toMatchObject({
				sectionId: exact.sectionId,
				matchKind: "exact-name",
				text: "# Notes\nRead MBIST_CHECK.RPT for evidence.\n",
			});
			expect(result.sections.find(hit => hit.path === "continued.md")?.matchKind).toBe("related");
			expect(result.sections.find(hit => hit.headingPath.endsWith("Other"))?.matchKind).toBe("related");
			for (const file of ["escaped.md", "path.md", "escaped-path.md", "windows-path.md"])
				expect(result.sections.find(hit => hit.path === file)?.matchKind).toBe("exact-name");
			for (const file of ["spliced.md", "escaped-continued.md"])
				expect(result.sections.find(hit => hit.path === file)?.matchKind).toBe("related");
			const firstRelated = result.sections.findIndex(hit => hit.matchKind === "related");
			expect(result.sections.slice(0, firstRelated).every(hit => hit.matchKind === "exact-name")).toBe(true);
		} finally {
			service.close();
		}
	});

	it("recovers table names after streamed fenced chunks without joining code spans outside FTS", async () => {
		const root = await tempDir("docs-streamed-render-root-");
		const agentDir = await tempDir("docs-streamed-render-agent-");
		const table = "# Rendered\n| Name |\n| --- |\n| mbist\\_check.rpt |\n";
		await fs.writeFile(
			path.join(root, "chunked.md"),
			`# Literal\n~~~~txt\n${"padding=1\n".repeat(4000)}mbist\\_check.rpt\n~~~~\n\n${table}`,
		);
		await fs.writeFile(path.join(root, "spliced.md"), "# Notes\n| Name |\n| --- |\n| `mbist`_check.rpt |\n");
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			const chunks = withSqliteDatabase(
				service.databasePath,
				db =>
					db
						.query(
							"SELECT count(*) count FROM sections s JOIN documents d ON d.id=s.document_id WHERE d.relative_path=?",
						)
						.get("chunked.md") as { count: number },
				{ readonly: true },
			);
			expect(chunks.count).toBeGreaterThan(3);
			withSqliteDatabase(service.databasePath, db => db.run("DELETE FROM sections_fts"));
			await fs.rm(root, { recursive: true });
			const result = service.search("mbist_check.rpt", { index: "manual", limit: 500 });
			expect(result).toMatchObject({ total: 1, exactNameMatches: 1, hasMore: false });
			expect(result.sections[0]).toMatchObject({
				path: "chunked.md",
				text: table,
				shape: "content",
				matchKind: "exact-name",
			});
		} finally {
			service.close();
		}
	});

	it("traverses contiguous full evidence exactly once across budgets, limits and service reopen", async () => {
		const root = await tempDir("docs-pagination-root-");
		const agentDir = await tempDir("docs-pagination-agent-");
		const sources: Record<string, string> = {
			"a.md": `# Notes\nmbist_check.rpt evidence\n${"same background ".repeat(30)}`,
			"b.md": `# Notes\nmbist_check.rpt evidence\n${"same background ".repeat(30)}`,
			"distinct.md": `# Notes\nmbist_check.rpt distinct evidence\n${"long background ".repeat(400)}`,
			"related.md": "# Notes\nrpt related evidence\n",
			"other.md": "# Notes\nrpt additional evidence\n",
		};
		for (const [name, text] of Object.entries(sources)) await fs.writeFile(path.join(root, name), text);
		let service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			await fs.rm(root, { recursive: true });
			const complete = service.search("mbist_check.rpt", { index: "manual", limit: 500 });
			expect(complete).toMatchObject({ total: 5, exactNameMatches: 3, hasMore: false });
			expect(complete.sections.findIndex(hit => hit.path === "distinct.md")).toBeLessThan(
				complete.sections.findIndex(hit => hit.path === "b.md"),
			);
			const ordered = complete.sections.map(hit => hit.sectionId);
			const cost = (hit: (typeof complete.sections)[number]) => (hit.sectionId === ordered[1] ? 20_000 : 10);
			let page = service.search("mbist_check.rpt", {
				index: "manual",
				limit: 500,
				characterBudget: 30,
				sectionCost: cost,
			});
			expect(page.sections.map(hit => hit.sectionId)).toEqual(ordered.slice(0, 1));
			const delivered = [...page.sections];
			let pageNumber = 0;
			while (page.cursor) {
				const cursor = page.cursor;
				service.close();
				service = new DocsSearchEngine({ agentDir });
				const positions: number[] = [];
				page = service.search("mbist_check.rpt", {
					index: "manual",
					cursor,
					limit: pageNumber === 0 ? 500 : 2,
					characterBudget: pageNumber === 0 ? 5 : 35,
					sectionCost: (hit, position) => {
						positions.push(position);
						return cost(hit);
					},
				});
				expect(positions).toEqual(Array.from({ length: positions.length }, (_, index) => index));
				if (pageNumber === 0) expect(page.sections.map(hit => hit.sectionId)).toEqual(ordered.slice(1, 2));
				expect(page.total).toBe(5);
				expect(page.exactNameMatches).toBe(3);
				delivered.push(...page.sections);
				pageNumber++;
			}
			expect(delivered.map(hit => hit.sectionId)).toEqual(ordered);
			expect(page).toMatchObject({ hasMore: false });
			expect(page.cursor).toBeUndefined();
			for (const hit of delivered) {
				expect(hit.text).toBe(sources[hit.path]);
				expect(hit.documentHash).toBe(new Bun.CryptoHasher("sha256").update(sources[hit.path]).digest("hex"));
				expect(hit.lineStart).toBe(1);
				expect(hit.lineEnd).toBeGreaterThanOrEqual(2);
			}
		} finally {
			service.close();
		}
	});

	it("rejects malformed, mismatched and stale continuations instead of returning empty success", async () => {
		const root = await tempDir("docs-cursor-root-");
		const agentDir = await tempDir("docs-cursor-agent-");
		await fs.writeFile(path.join(root, "guide.md"), "# One\nneedle first\n## Two\nneedle second\n");
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			const first = service.search("needle", { index: "manual", limit: 1 });
			expect(first.hasMore).toBe(true);
			expect(first.total).toBe(2);
			expect(() => service.search("needle", { cursor: "not a cursor" })).toThrow(
				"Invalid documentation search cursor",
			);
			expect(() => service.search("needle", { cursor: "" })).toThrow("Invalid documentation search cursor");
			expect(() => service.search("different", { index: "manual", cursor: first.cursor })).toThrow(
				"does not match query or index",
			);
			expect(() => service.search("needle", { index: "other", cursor: first.cursor })).toThrow(
				"does not match query or index",
			);
			withSqliteDatabase(service.databasePath, db => {
				db.query("UPDATE sections SET raw_markdown=raw_markdown || ? WHERE id=?").run(
					"\nChanged stored evidence.\n",
					first.sections[0].sectionId,
				);
			});
			expect(() => service.search("needle", { index: "manual", cursor: first.cursor })).toThrow(
				"Stale documentation search cursor",
			);
		} finally {
			service.close();
		}
	});

	it("reopens original relative-path cursors when the worker uses an absolute database opening path", async () => {
		const root = await tempDir("docs-relative-cursor-root-");
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const cacheDir = path.join(repoRoot, "node_modules", ".cache");
		await fs.mkdir(cacheDir, { recursive: true });
		const agentDir = await fs.mkdtemp(path.join(cacheDir, "docs-relative-cursor-agent-"));
		tempDirs.push(agentDir);
		const source = "# One\nneedle evidence first\n## Two\nneedle evidence second\n";
		await fs.writeFile(path.join(root, "guide.md"), source);
		const relativeAgentDir = path.relative(process.cwd(), agentDir);
		const relativeDatabasePath = path.join(relativeAgentDir, "docs.db");
		expect(path.isAbsolute(relativeDatabasePath)).toBe(false);
		const query = "needle evidence";
		const legacyQueryKey = new Bun.CryptoHasher("sha256")
			.update(JSON.stringify([query, "manual", relativeDatabasePath]))
			.digest("hex");
		let engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			const complete = engine.search(query, { index: "manual" });
			const first = engine.search(query, { index: "manual", limit: 1 });
			expect(first).toMatchObject({ total: 2, hasMore: true });
			expect(first.sections).toHaveLength(1);
			expect(first.cursor).toBeDefined();
			const absoluteCursor = JSON.parse(Buffer.from(first.cursor!, "base64url").toString("utf8"));
			expect(absoluteCursor.q).not.toBe(legacyQueryKey);
			// Independently reproduce the legacy relative-path query identity, retaining
			// the real database snapshot and page position without opening a relative directory.
			const legacyCursor = Buffer.from(JSON.stringify({ ...absoluteCursor, q: legacyQueryKey })).toString(
				"base64url",
			);
			engine.close();
			await fs.rm(root, { recursive: true });
			engine = new DocsSearchEngine({ agentDir, cursorPath: relativeDatabasePath });
			expect(() => engine.search(query, { index: "manual", cursor: first.cursor })).toThrow(
				"does not match query or index",
			);
			const reopenedFirst = engine.search(query, { index: "manual", limit: 1 });
			expect(reopenedFirst.sections).toEqual(first.sections);
			expect(reopenedFirst.cursor).toBe(legacyCursor);
			const last = engine.search(query, { index: "manual", cursor: legacyCursor });
			expect(last).toMatchObject({ total: 2, hasMore: false });
			expect(last.sections).toHaveLength(1);
			expect(last.sections[0].sectionId).not.toBe(first.sections[0].sectionId);
			expect(last.cursor).toBeUndefined();
			const delivered = [...first.sections, ...last.sections];
			expect(delivered).toEqual(complete.sections);
			expect(delivered.map(hit => hit.text).sort()).toEqual(
				["# One\nneedle evidence first\n", "## Two\nneedle evidence second\n"].sort(),
			);
			for (const hit of delivered) {
				expect(hit).toMatchObject({
					index: "manual",
					path: "guide.md",
					documentHash: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
				});
				expect([hit.lineStart, hit.lineEnd]).toEqual(hit.text.startsWith("# One") ? [1, 2] : [3, 4]);
			}
		} finally {
			engine.close();
		}
	});

	it("preserves complete evidence ordering across bounded sync and async windows with start-based cursors", async () => {
		const root = await tempDir("docs-rank-cache-root-");
		const agentDir = await tempDir("docs-rank-cache-agent-");
		await fs.writeFile(
			path.join(root, "guide.md"),
			"# One\nneedle evidence first\n## Two\nneedle evidence second\n## Three\nneedle evidence third\n",
		);
		const engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			await fs.rm(root, { recursive: true });
			const complete = engine.search("needle evidence", { index: "manual", limit: 500 });
			const first = engine.searchWindow("needle evidence", { index: "manual", limit: 1 });
			expect(first).toMatchObject({ total: 3, exactNameMatches: 0, cursorBase: { v: 1, p: 0 } });
			expect(first.sections).toEqual(complete.sections.slice(0, 1));
			const cursor = Buffer.from(JSON.stringify({ ...first.cursorBase, p: 1 })).toString("base64url");
			const rest = engine.searchWindow("needle evidence", { index: "manual", limit: 500, cursor });
			expect(rest.cursorBase.p).toBe(1);
			expect(rest.sections).toEqual(complete.sections.slice(1));
			const asyncFirst = await engine.searchWindowAsync("needle evidence", { index: "manual", limit: 1 });
			expect(asyncFirst).toEqual(first);
			const asyncRest = await engine.searchWindowAsync("needle evidence", { index: "manual", limit: 500, cursor });
			expect(asyncRest).toEqual(rest);
			expect([...asyncFirst.sections, ...asyncRest.sections]).toEqual(complete.sections);
			const positions: number[] = [];
			const budgeted = engine.search("needle evidence", {
				index: "manual",
				limit: 500,
				characterBudget: 0,
				sectionCost: (_hit, position) => {
					positions.push(position);
					return 1;
				},
			});
			expect(positions).toEqual([0, 1]);
			expect(budgeted.sections).toEqual(complete.sections.slice(0, 1));
			expect(engine.search("needle evidence", { index: "manual", cursor: budgeted.cursor }).sections).toEqual(
				complete.sections.slice(1),
			);
		} finally {
			engine.close();
		}
	});

	it.each([
		["i\u0307", "İ"],
		["İ", "i\u0307"],
	])("keeps equivalent Unicode queries stable across cache rebuilds (warm=%s, query=%s)", async (warm, query) => {
		const root = await tempDir("docs-equivalent-query-root-");
		const agentDir = await tempDir("docs-equivalent-query-agent-");
		await fs.writeFile(path.join(root, "a.md"), `# Long\n/İ ${"background ".repeat(600)}\n`);
		await fs.writeFile(path.join(root, "b.md"), "# Short\ni related evidence\n");
		let engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			await fs.rm(root, { recursive: true });
			engine.search(warm, { index: "manual" });
			const first = engine.search(query, { index: "manual", limit: 1 });
			expect(first).toMatchObject({ technicalName: query, exactNameMatches: 1, total: 2 });
			expect(first.sections.map(hit => [hit.path, hit.matchKind])).toEqual([["a.md", "exact-name"]]);
			expect(first.cursor).toBeDefined();
			const cached = engine.search(query, { index: "manual", cursor: first.cursor });
			expect(cached.sections.map(hit => [hit.path, hit.matchKind])).toEqual([["b.md", "related"]]);
			for (let index = 0; index < 8; index++) engine.search(`other topic${index}`, { index: "manual" });
			expect(engine.search(query, { index: "manual", cursor: first.cursor })).toEqual(cached);
			engine.close();
			engine = new DocsSearchEngine({ agentDir });
			const reopened = engine.search(query, { index: "manual", cursor: first.cursor });
			expect(reopened).toEqual(cached);
			expect([...first.sections, ...reopened.sections].map(hit => hit.path)).toEqual(["a.md", "b.md"]);
		} finally {
			engine.close();
		}
	});

	it.each([false, true])("invalidates external SQL continuations (FTS-only=%s)", async ftsOnly => {
		const root = await tempDir("docs-cache-mutation-root-");
		const agentDir = await tempDir("docs-cache-mutation-agent-");
		await fs.writeFile(path.join(root, "guide.md"), "# One\nneedle evidence first\n## Two\nneedle evidence second\n");
		const reader = new DocsSearchEngine({ agentDir });
		try {
			await reader.init(root, "manual");
			await fs.rm(root, { recursive: true });
			const first = reader.search("needle evidence", { index: "manual", limit: 1 });
			expect(first).toMatchObject({ total: 2, hasMore: true });
			// Warm the continuation too, so this covers reuse rather than cold ranking.
			expect(reader.search("needle evidence", { index: "manual", cursor: first.cursor }).sections).toHaveLength(1);
			// Mutate through a connection independent of the native engine's owning connection.
			withSqliteDatabase(reader.databasePath, db => {
				if (ftsOnly) {
					db.query("DELETE FROM sections_fts WHERE rowid=?").run(first.sections[0].sectionId);
				} else {
					db.query("UPDATE sections SET raw_markdown=raw_markdown || ? WHERE id=?").run(
						"\nChanged stored evidence.\n",
						first.sections[0].sectionId,
					);
				}
			});
			expect(() => reader.search("needle evidence", { index: "manual", cursor: first.cursor })).toThrow(
				"Stale documentation search cursor",
			);
			const fresh = reader.search("needle evidence", { index: "manual" });
			if (ftsOnly) {
				expect(fresh.total).toBe(1);
				expect(fresh.sections.some(hit => hit.sectionId === first.sections[0].sectionId)).toBe(false);
			} else {
				expect(fresh.total).toBe(2);
				expect(fresh.sections.find(hit => hit.sectionId === first.sections[0].sectionId)?.text).toContain(
					"Changed stored evidence.",
				);
			}
		} finally {
			reader.close();
		}
	});

	it("returns successful complete metadata for no terms, zero matches and related-only names", async () => {
		const root = await tempDir("docs-zero-query-root-");
		const agentDir = await tempDir("docs-zero-query-agent-");
		await fs.writeFile(path.join(root, "guide.md"), "# Notes\nrpt evidence\n");
		await fs.writeFile(path.join(root, "missingcmd.md"), "# Notes\nMetadata only; no command evidence.\n");
		const service = new DocsSearchEngine({ agentDir });
		try {
			await service.init(root, "manual");
			for (const query of ["!!!", "absentword"]) {
				expect(service.search(query, { index: "manual" })).toEqual({
					sections: [],
					total: 0,
					hasMore: false,
					exactNameMatches: 0,
					...(query === "absentword" ? { technicalName: query } : {}),
				});
			}
			const result = service.search("missing_check.rpt", { index: "manual" });
			expect(result).toMatchObject({
				total: 1,
				hasMore: false,
				technicalName: "missing_check.rpt",
				exactNameMatches: 0,
			});
			expect(result.sections[0].matchKind).toBe("related");
			const plainName = service.search("missingcmd", { index: "manual" });
			expect(plainName).toMatchObject({
				total: 1,
				hasMore: false,
				technicalName: "missingcmd",
				exactNameMatches: 0,
			});
			expect(plainName.sections[0]).toMatchObject({ path: "missingcmd.md", matchKind: "related" });
		} finally {
			service.close();
		}
	});
});
