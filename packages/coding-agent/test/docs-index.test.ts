import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enumerateMarkdownFiles, parseMarkdown, readMarkdownDocument } from "../src/docs/markdown";
import { DocsService } from "../src/docs/service";

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
		expect(parsed.sections.map(section => section.rawMarkdown).join("")).toBe(text);
		expect(
			parsed.sections.every(section => section.byteEnd > section.byteStart && section.lineEnd >= section.lineStart),
		).toBe(true);
		expect(parsed.sections.find(section => section.headingPath.at(-1) === "Child")?.plainText).toContain(
			"child text",
		);
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

	it("caps sections below the page budget so every hit can be delivered whole", () => {
		const parsed = parseMarkdown(new TextEncoder().encode(`# Doc\n${"y".repeat(40_000)}\n`));
		expect(parsed.sections.length).toBeGreaterThan(1);
		expect(Math.max(...parsed.sections.map(section => section.rawMarkdown.length))).toBeLessThan(20_000);
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

	it("skips and refuses symbolic-link Markdown sources", async () => {
		const root = await tempDir("docs-safe-root-");
		const outside = path.join(await tempDir("docs-safe-outside-"), "outside.md");
		await fs.writeFile(outside, "# Outside\nsecret\n");
		await fs.symlink(outside, path.join(root, "linked.md"));
		expect(await enumerateMarkdownFiles(root)).toEqual([]);
		await expect(readMarkdownDocument(root, "linked.md")).rejects.toThrow();
	});
});
describe("DocsService indexing contract", () => {
	it("publishes only complete imports and discards cancellation or read failures", async () => {
		const root = await tempDir("docs-atomic-root-");
		const agentDir = await tempDir("docs-atomic-agent-");
		await fs.writeFile(path.join(root, "a.md"), "# A\nAlpha\n");
		await fs.writeFile(path.join(root, "b.md"), "# B\nBeta\n");
		const service = new DocsService({ agentDir, cwd: root });
		try {
			const controller = new AbortController();
			await expect(
				service.init(".", "cancelled", {
					signal: controller.signal,
					onProgress: progress => {
						if (progress.completed === 1) {
							expect(service.search("Alpha").sections).toEqual([]);
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
			expect(service.search("Alpha").sections).toEqual([]);
			const imported = await service.init(".", "manual");
			expect(imported.index.documentCount).toBe(1);
			await expect(service.init(".", "manual")).rejects.toThrow("already exists");
			expect(service.read({ sectionId: service.search("Alpha").sections[0].sectionId }).rawMarkdown).toBe(
				"# A\nAlpha\n",
			);
			service.remove("manual");
			expect(service.search("Alpha").sections).toEqual([]);
			await service.init(".", "again");
			expect(service.search("Alpha").sections.map(hit => hit.index)).toEqual(["again"]);
		} finally {
			service.close();
		}
	});

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

		const service = new DocsService({ agentDir });
		try {
			expect(service.list().map(index => index.name)).toEqual(["fulltext", "structured"]);
			for (const [id, name] of [
				[7, "structured"],
				[11, "fulltext"],
			] as const) {
				expect(service.search("Alpha 中文", { index: name }).sections.map(hit => hit.sectionId)).toEqual([id]);
				expect(service.read({ sectionId: id, index: name })).toMatchObject({
					path: `${name}.md`,
					lineStart: 1,
					lineEnd: 2,
					rawMarkdown: `# Guide\r\nAlpha 中文 ${name}\r\n`,
				});
			}
			expect(service.storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
			service.remove("structured");
			expect(service.search("Alpha").sections.map(hit => hit.index)).toEqual(["fulltext"]);
		} finally {
			service.close();
		}
		const reopened = new DocsService({ agentDir });
		try {
			expect(reopened.read({ sectionId: 11 }).rawMarkdown).toBe("# Guide\r\nAlpha 中文 fulltext\r\n");
		} finally {
			reopened.close();
		}
	});

	it("supports ASCII and Han character full-text search", async () => {
		const root = await tempDir("docs-search-root-");
		const agent = await tempDir("docs-search-agent-");
		await fs.writeFile(path.join(root, "mixed.md"), "# Mixed\nItem: Alpha\n中文接口说明\n");
		const service = new DocsService({ agentDir: agent, cwd: root });
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
		const service = new DocsService({ agentDir: agent, cwd: root });
		try {
			await service.init(".", "case");
			const hits = service.search("Alpha", { index: "case" }).sections;
			expect(hits.map(hit => hit.path).sort()).toEqual(["A.md", "a.md"]);
			expect(service.read({ sectionId: hits.find(hit => hit.path === "A.md")!.sectionId }).rawMarkdown).toContain(
				"Alpha one",
			);
			expect(service.read({ sectionId: hits.find(hit => hit.path === "a.md")!.sectionId }).rawMarkdown).toContain(
				"Alpha two",
			);
		} finally {
			service.close();
		}
	});

	it("keeps ordinary names containing the building pattern visible", async () => {
		const root = await tempDir("docs-visible-root-");
		const agent = await tempDir("docs-visible-agent-");
		await fs.writeFile(path.join(root, "guide.md"), "# Guide\nbuilding visibility\n");
		const service = new DocsService({ agentDir: agent, cwd: root });
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
		const service = new DocsService({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			await fs.rm(root, { recursive: true });
			const hits = service.search("缓存", { index: "manual" }).sections;
			// Scattered characters (`缓慢…存储`) no longer satisfy the word, and the
			// unbroken spelling outranks the punctuation-split one.
			expect(hits.map(hit => hit.path)).toEqual(["exact.md", "punctuated.md"]);
			expect(service.read({ sectionId: hits[0].sectionId }).rawMarkdown).toContain("缓**存**配置");
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
	])("prioritizes the complete technical name $query", async ({ query, exact, loose }) => {
		const root = await tempDir("docs-technical-rank-");
		const agentDir = await tempDir("docs-technical-agent-");
		await fs.writeFile(path.join(root, "exact.md"), `# Notes\n${exact}\n${"background ".repeat(100)}`);
		await fs.writeFile(path.join(root, "loose.md"), `# Notes\n${loose}\n`);
		const service = new DocsService({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const hits = service.search(query, { index: "manual" }).sections;
			expect(hits.map(hit => hit.path)).toEqual(["exact.md", "loose.md"]);
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
		const service = new DocsService({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const hits = service.search("cache invalidation", { index: "manual" }).sections;
			const topic = hits.findIndex(hit => hit.path === "topic.md");
			expect(topic).toBeGreaterThanOrEqual(0);
			expect(topic).toBeLessThan(hits.findIndex(hit => hit.path === "mention.md"));
			expect(topic).toBeLessThan(hits.findIndex(hit => hit.headingPath.endsWith("Unrelated appendix")));
		} finally {
			service.close();
		}
	});

	it("reranks beyond the requested result window and keeps index isolation", async () => {
		const root = await tempDir("docs-candidates-rank-");
		const agentDir = await tempDir("docs-candidates-agent-");
		for (let index = 0; index < 20; index++)
			await fs.writeFile(path.join(root, `loose-${index}.md`), "# Notes\nvector std\n");
		await fs.writeFile(path.join(root, "exact.md"), `# Notes\nUse std::vector.\n${"background ".repeat(150)}`);
		await fs.writeFile(path.join(root, "partial.md"), "# Notes\nstd only\n");
		const service = new DocsService({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			await service.init(".", "other");
			expect(service.search("std::vector", { index: "manual", limit: 1 }).sections.map(hit => hit.path)).toEqual([
				"exact.md",
			]);
			const all = service.search("std::vector", { index: "manual", limit: 50 }).sections;
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

	it("finds the readable hits of a query whose whole candidate window is stubs", async () => {
		const root = await tempDir("docs-stub-window-");
		const agentDir = await tempDir("docs-stub-window-agent-");
		for (let index = 0; index < 150; index++)
			await fs.writeFile(
				path.join(root, `req-${index}.md`),
				`# Requirement ${index}\n## 检查项\n${"背景说明 ".repeat(120)}本项检查 needle 的结果必须记录。\n`,
			);
		const service = new DocsService({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			const indexId = service.list()[0].id as number;
			// A legacy index keeps the converter's structural labels, and a short row
			// repeating the term outscores a long section that mentions it once: more
			// of them match than the first window can hold, so widening is the only
			// way to reach the readable sections ranked behind them.
			service.storage.transaction(() => {
				for (let index = 0; index < 700; index++) {
					const document = service.storage.db
						.query(
							"INSERT INTO documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms) VALUES(?,?,?,?,?,?,?) RETURNING id",
						)
						.get(indexId, `legacy/label-${index}.md`, "Cell", "doc", "0", 0, 0) as { id: number };
					const section = service.storage.db
						.query(
							"INSERT INTO sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
						)
						.get(indexId, document.id, 0, "Cell", 2, 1, 1, 0, 11, "## Cell\n") as { id: number };
					service.storage.db
						.query(
							"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
						)
						.run(section.id, section.id, indexId, "", "Cell", "needle needle needle needle needle needle");
				}
			});
			const hits = service.search("needle", { index: "manual", limit: 200 }).sections;
			// Every readable hit outranks the labels filling the window: without
			// widening, this page is 200 stubs and no body text at all. Stubs only
			// remain as padding after all of them, which the caller filters.
			const readable = hits.filter(hit => hit.text.includes("必须记录"));
			expect(readable.length).toBe(150);
			expect(hits.slice(0, 150).every(hit => hit.text.includes("必须记录"))).toBe(true);
		} finally {
			service.close();
		}
	});

	it("counts only the matches the page may serve", async () => {
		const root = await tempDir("docs-hidden-count-");
		const agentDir = await tempDir("docs-hidden-count-agent-");
		await fs.writeFile(path.join(root, "visible.md"), "# Visible\nneedle in the visible index\n");
		const service = new DocsService({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
			// A half-built import shares this database under a hidden name; its rows
			// must not pad a count the page is never allowed to serve from.
			const hidden = service.storage.create({ name: "__building__count", rootPath: root });
			const document = service.storage.db
				.query(
					"INSERT INTO documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms) VALUES(?,?,?,?,?,?,?) RETURNING id",
				)
				.get(hidden.id, "hidden.md", "Hidden", "doc", "0", 0, 0) as { id: number };
			const section = service.storage.db
				.query(
					"INSERT INTO sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
				)
				.get(hidden.id, document.id, 0, "Hidden", 1, 1, 2, 0, 30, "# Hidden\nneedle in the hidden index\n") as {
				id: number;
			};
			service.storage.db
				.query(
					"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
				)
				.run(section.id, section.id, hidden.id, "hidden.md", "Hidden", "needle hidden body");
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
		const service = new DocsService({ agentDir, cwd: root });
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
});
