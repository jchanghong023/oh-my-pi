import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { DocsSearchEngine } from "../src/docs/engine";
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
	it("recovers literal code from version-seven fence info with a Unicode separator without the source directory", async () => {
		const root = await tempDir("docs-unicode-fence-root-");
		const agentDir = await tempDir("docs-unicode-fence-agent-");
		const source = "# Notes\n```python\u2028metadata\ncounter*factor*next\n```\n";
		await Bun.write(path.join(root, "notes.md"), source);
		const writer = new DocsSearchEngine({ agentDir });
		let sectionId: number;
		try {
			await writer.init(root, "manual");
			const fresh = writer.search("counter*factor*next").sections;
			expect(fresh).toHaveLength(1);
			expect(fresh[0].text).toBe(source);
			sectionId = fresh[0].sectionId;
			const db = new Database(writer.databasePath, { strict: true });
			try {
				db.exec("PRAGMA foreign_keys=ON");
				db.query(
					"UPDATE sections_fts SET section_id=?,index_id=?,relative_path=?,heading_path=?,body=? WHERE rowid=?",
				).run(sectionId, writer.list()[0].id, "notes.md", "Notes", "Notes counterfactornext", sectionId);
				db.run("PRAGMA user_version=7");
			} finally {
				db.close();
			}
			expect(writer.search("counter*factor*next").sections).toEqual([]);
		} finally {
			writer.close();
		}
		await fs.rm(root, { recursive: true });
		const reader = new DocsSearchEngine({ agentDir });
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
		const writer = new DocsSearchEngine({ agentDir });
		try {
			await writer.init(root, "manual");
			const hit = writer.search("Row").sections[0];
			expect(hit.text).toBe("# Row\n");
			expect(hit.shape).toBe("content");
			const db = new Database(writer.databasePath, { strict: true });
			try {
				db.run("PRAGMA user_version=7");
			} finally {
				db.close();
			}
		} finally {
			writer.close();
		}
		await fs.rm(root, { recursive: true });
		const reader = new DocsSearchEngine({ agentDir });
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
			try {
				const result = await tool.execute("continuation", { query: "Row" });
				const page = result.content.map(item => ("text" in item ? item.text : "")).join("\n");
				expect(page).toContain("# Row\n");
				expect(page).not.toContain("heading only");
				const headingResult = await tool.execute("heading", { query: "ATPG" });
				const headingPage = headingResult.content.map(item => ("text" in item ? item.text : "")).join("\n");
				expect(headingPage).toContain("heading only");
			} finally {
				await tool.dispose();
			}
		} finally {
			reader.close();
		}
	});
});

describe("Document literal boundary regressions", () => {
	it("normalizes across chunk edges without inventing exact names or discarding combining marks", async () => {
		const root = await tempDir("docs-literal-edge-root-");
		const agentDir = await tempDir("docs-literal-edge-agent-");
		const sources = {
			"boundary.md": `${"x".repeat(17_995)} cafe\u0301.log\n`,
			"composed.md": "café.log\n",
			"decomposed.md": "cafe\u0301.log\n",
			"version.md": `${"x".repeat(17_996)} C++17\n`,
			"noncomposing.md": `${"x".repeat(17_995)} scan\u034f\n`,
		};
		for (const [name, source] of Object.entries(sources)) {
			await Bun.write(path.join(root, name), source);
		}
		const engine = new DocsSearchEngine({ agentDir });
		try {
			await engine.init(root, "manual");
			await fs.rm(root, { recursive: true });
			expect(engine.search("cafe").exactNameMatches).toBe(0);
			for (const query of ["café.log", "cafe\u0301.log"]) {
				const result = engine.search(query);
				expect(
					[...new Set(result.sections.filter(hit => hit.matchKind === "exact-name").map(hit => hit.path))].sort(),
				).toEqual(["boundary.md", "composed.md", "decomposed.md"]);
			}
			expect(engine.search("C++").exactNameMatches).toBe(0);
			expect(engine.search("C++17").sections.some(hit => hit.matchKind === "exact-name")).toBe(true);
			expect(engine.search("scan").sections.some(hit => hit.matchKind === "exact-name")).toBe(true);
		} finally {
			engine.close();
		}
	});
});
