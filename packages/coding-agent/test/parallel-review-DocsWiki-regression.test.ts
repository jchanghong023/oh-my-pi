import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { endingMarkdownFence, markdownSectionContexts } from "../src/docs/markdown";
import { DocsService } from "../src/docs/service";
import { WikiTool } from "../src/tools/wiki";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Document fence indexing regressions", () => {
	it("preserves whole-line fence semantics when delimiters, info strings and CRLF split across chunks", () => {
		const source =
			"\uFEFF   ````python\r\nbody\r\n   ````\t \r\n~~~~`info`\nbody\n~~~~\n    ```bad\nbody\n```bad`info\nbody\n```info\rinside\nbody\n```valid\nbody\n```\n";
		let byteStart = 0;
		const sections = [...source].map(rawMarkdown => {
			const section = {
				documentId: 1,
				byteStart,
				byteEnd: byteStart + Buffer.byteLength(rawMarkdown),
				rawMarkdown,
			};
			byteStart = section.byteEnd;
			return section;
		});
		let prefix = "";
		for (const { section, fencePrefix, continuesLine } of markdownSectionContexts(sections)) {
			const text = prefix.replace(/^\uFEFF/u, "");
			const end = text.lastIndexOf("\n") + 1;
			const fence = endingMarkdownFence(text.slice(0, end));
			expect(fencePrefix).toBe(fence?.marker.repeat(fence.length));
			expect(continuesLine).toBe(text.length > end);
			prefix += section.rawMarkdown;
		}
	});

	it("recovers fence context across a very long overlapping line without treating chunk starts as delimiters", () => {
		const chunkCount = 8192;
		const chunk = "x".repeat(18_000);
		function* sections() {
			let byteStart = 0;
			const section = (rawMarkdown: string, advance = Buffer.byteLength(rawMarkdown)) => {
				const row = {
					documentId: 1,
					byteStart,
					byteEnd: byteStart + Buffer.byteLength(rawMarkdown),
					rawMarkdown,
				};
				byteStart += advance;
				return row;
			};
			yield section("```python\n");
			for (let index = 0; index < chunkCount; index++)
				yield section(chunk, index === chunkCount - 1 ? chunk.length : chunk.length - 500);
			yield section("```\n"); // The end of the long line, not a closing delimiter.
			yield section("# Row\n");
			yield section("```\n");
			yield section("## ATPG\n");
			yield { documentId: 2, byteStart: 0, byteEnd: 8, rawMarkdown: "## Next\n" };
		}
		const headings: { text: string; fencePrefix?: string; continuesLine: boolean }[] = [];
		let count = 0;
		for (const { section, fencePrefix, continuesLine } of markdownSectionContexts(sections())) {
			count++;
			if (section.rawMarkdown.startsWith("#"))
				headings.push({ text: section.rawMarkdown, fencePrefix, continuesLine });
		}
		expect(count).toBe(chunkCount + 6);
		expect(headings).toEqual([
			{ text: "# Row\n", fencePrefix: "```", continuesLine: false },
			{ text: "## ATPG\n", fencePrefix: undefined, continuesLine: false },
			{ text: "## Next\n", fencePrefix: undefined, continuesLine: false },
		]);
	}, 10_000);

	it("recovers literal code from version-seven fence info with a Unicode separator without the source directory", async () => {
		const root = await tempDir("docs-unicode-fence-root-");
		const agentDir = await tempDir("docs-unicode-fence-agent-");
		const source = "# Notes\n```python\u2028metadata\ncounter*factor*next\n```\n";
		await Bun.write(path.join(root, "notes.md"), source);
		const writer = new DocsService({ agentDir });
		let sectionId: number;
		try {
			await writer.init(root, "manual");
			const fresh = writer.search("counter*factor*next").sections;
			expect(fresh).toHaveLength(1);
			expect(fresh[0].text).toBe(source);
			sectionId = fresh[0].sectionId;
			writer.storage.db
				.query(
					"UPDATE sections_fts SET section_id=?,index_id=?,relative_path=?,heading_path=?,body=? WHERE rowid=?",
				)
				.run(sectionId, writer.list()[0].id, "notes.md", "Notes", "Notes counterfactornext", sectionId);
			writer.storage.db.run("PRAGMA user_version=7");
			expect(writer.search("counter*factor*next").sections).toEqual([]);
		} finally {
			writer.close();
		}
		await fs.rm(root, { recursive: true });
		const reader = new DocsService({ agentDir });
		try {
			expect(reader.search("counter*factor*next").sections[0]).toMatchObject({ sectionId, text: source });
			expect(reader.search("counterfactornext").sections).toEqual([]);
		} finally {
			reader.close();
		}
	});

	it("returns fenced converter-like continuation text after migration instead of collapsing it to a locator", async () => {
		const root = await tempDir("docs-fence-shape-root-");
		const agentDir = await tempDir("docs-fence-shape-agent-");
		const source = `\uFEFF\`\`\`python\n${"x".repeat(18_001)}\n# Row\n${"y".repeat(18_001)}\ncounter*factor*next\n\`\`\`\n## Cell\n## ATPG\n`;
		await Bun.write(path.join(root, "code.md"), source);
		const overlapSource = `\`\`\`python\n${"z".repeat(35_000)}\`\`\`${" ".repeat(600)}\nmask*value*tail\n\`\`\`\n`;
		await Bun.write(path.join(root, "overlap.md"), overlapSource);
		const writer = new DocsService({ agentDir });
		try {
			await writer.init(root, "manual");
			const hit = writer.search("Row").sections[0];
			expect(hit.text).toBe("# Row\n");
			expect(hit.shape).toBe("content");
			writer.storage.db.run("PRAGMA user_version=7");
		} finally {
			writer.close();
		}
		await fs.rm(root, { recursive: true });
		const reader = new DocsService({ agentDir });
		try {
			expect(reader.search("Row").sections[0].text).toBe("# Row\n");
			expect(reader.search("Cell").sections).toEqual([]);
			expect(reader.search("counter*factor*next").sections[0].text).toContain("counter*factor*next");
			expect(reader.search("counterfactornext").sections).toEqual([]);
			expect(reader.search("mask*value*tail").sections[0].text).toContain("mask*value*tail");
			expect(reader.search("maskvaluetail").sections).toEqual([]);
			const tool = new WikiTool({
				cwd: root,
				hasUI: false,
				settings: { getAgentDir: () => agentDir } as unknown as Settings,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
			});
			const result = await tool.execute("continuation", { query: "Row" });
			const page = result.content.map(item => ("text" in item ? item.text : "")).join("\n");
			expect(page).toContain("# Row\n");
			expect(page).not.toContain("heading only");
			const headingResult = await tool.execute("heading", { query: "ATPG" });
			const headingPage = headingResult.content.map(item => ("text" in item ? item.text : "")).join("\n");
			expect(headingPage).toContain("heading only");
		} finally {
			reader.close();
		}
	});
});
