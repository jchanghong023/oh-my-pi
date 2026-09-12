import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
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

function session(agentDir: string, cwd: string) {
	return {
		cwd,
		hasUI: false,
		settings: { getAgentDir: () => agentDir } as unknown as Settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
}

function text(result: ToolResult): string {
	return result.content.map(item => item.text ?? "").join("\n");
}

/** Runs the tool with unvalidated arguments, as the agent loop does for this tool. */
function run(tool: WikiTool, params: unknown): Promise<ToolResult> {
	return tool.execute("t", params as never) as Promise<ToolResult>;
}

/** Indexes `files` (name → Markdown) into a throwaway agent directory. */
async function indexedFixture(files: Record<string, string>): Promise<{ root: string; agent: string }> {
	const root = await tempDir("docs-tool-root-");
	const agent = await tempDir("docs-tool-agent-");
	for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(root, name), body);
	const service = new DocsService({ agentDir: agent, cwd: root });
	try {
		await service.init(".", "manual");
	} finally {
		service.close();
	}
	return { root, agent };
}

describe("WikiTool", () => {
	it("returns the stored section text after the source directory is removed", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nCommand: scan\n" });
		await fs.rm(fixture.root, { recursive: true });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const result = text(await run(tool, { query: "scan" }));
		expect(result).toContain("guide.md:1-2");
		expect(result).toContain("Command: scan");
	});

	it("ignores stray keys but names what arrived when the query is missing", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nCommand: scan\n" });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		expect(text(await run(tool, { query: "scan", limit: 5 }))).toContain("Command: scan");
		await expect(run(tool, { q: "scan" })).rejects.toThrow("Received: q");
		await expect(run(tool, {})).rejects.toThrow("Received: nothing");
	});

	it("fills a page to the character budget and reports the matches left out", async () => {
		const filler = "pad ".repeat(600);
		const files = Object.fromEntries(
			Array.from({ length: 12 }, (_, index) => [`sec-${index}.md`, `# sec-${index}\n${filler}\nneedle ${index}\n`]),
		);
		const fixture = await indexedFixture(files);
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const page = text(await run(tool, { query: "needle" }));
		expect(page).toContain("12 matching section(s)");
		expect(page.length).toBeLessThan(21_000);
		// The page fills up to the budget and reports the sections it left out.
		const shown = [...page.matchAll(/^\[\d+\] sec-\d+\.md/gmu)].length;
		expect(shown).toBeGreaterThan(3);
		expect(shown).toBeLessThan(12);
		expect(page).toContain(`carries ${shown} of 12 sections within 20000 characters`);
	});

	it("delivers a long section whole inside one page", async () => {
		// ~17.2k characters: the largest a stored section can be (the parser caps at
		// 18k so that every hit fits the 20000-character page), delivered unabridged.
		const fixture = await indexedFixture({ "long.md": `# Long\n${"pad ".repeat(4300)}\nneedle here\n` });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const page = text(await run(tool, { query: "needle" }));
		expect(page).toContain("1 matching section(s)");
		expect(page).not.toContain("truncated");
		expect(page.length).toBeGreaterThan(17_000);
		expect(page).toContain("needle here");
	});

	it("keeps a heading-only requirement line as a pointer hit", async () => {
		const fixture = await indexedFixture({
			"req.md": "# 需求\n## 支持单DIE/多DIE同构分组\n",
			"noise.md": "# Noise\n#### Cell\n",
		});
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const result = text(await run(tool, { query: "支持单DIE 多DIE同构" }));
		// Requirement documents state the requirement in the heading itself.
		expect(result).toContain("支持单DIE/多DIE同构分组");
		expect(result).toContain("heading only");
		// The converter's structural label is indexed nowhere, so the query finds
		// nothing at all rather than a page of `#### Cell` noise.
		await expect(run(tool, { query: "Cell" })).rejects.toThrow("No section matches");
	});

	it("answers from the known terms when part of the query matches nothing", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nCommand: scan\n" });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const result = text(await run(tool, { query: "scan absentterm" }));
		expect(result).toContain("Command: scan");
		expect(result).toContain("1 matching section(s)");
	});

	it("skips heading-only sections so the budget carries body text", async () => {
		const fixture = await indexedFixture({
			"stub.md": "# 6 MBIST 方案选择\n",
			"body.md": "# MBIST 方案选择\n选择依据见下表。\n",
		});
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const result = text(await run(tool, { query: "MBIST 方案选择" }));
		expect(result).toContain("选择依据见下表");
		expect(result.split("\n").filter(line => line.includes("# 6 MBIST 方案选择"))).toHaveLength(0);
	});

	it("keeps body sections on the page when matched titles alone would fill it", async () => {
		// Every document keeps its first section so the file name stays searchable, and
		// that section is a title. A shared title therefore matches once per document:
		// with more documents than page slots, those structural hits must not crowd out
		// the readable sections, which is what the page and the error check look at.
		const files = Object.fromEntries(
			Array.from({ length: 250 }, (_, index) => [
				`guide-${index}.md`,
				`# Guide\n## 安装\n这里是 guide 的安装说明，第 ${index} 份。\n`,
			]),
		);
		const fixture = await indexedFixture(files);
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const page = text(await run(tool, { query: "guide" }));
		const shown = [...page.matchAll(/^\[(\d+)\] (\S+):(\d+)-(\d+)/gmu)].map(match => ({
			path: match[2],
			body: page.slice(match.index, (match.index ?? 0) + 400),
		}));
		expect(shown.length).toBeGreaterThan(0);
		for (const hit of shown) expect(hit.body).toContain("的安装说明");
		expect(shown.map(hit => hit.path).includes("guide-0.md")).toBe(true);
	});

	it("never points at a copy it did not deliver", async () => {
		// The filler takes almost the whole budget, so no copy of the shared text
		// fits: each one is dropped for size, and the page must not then claim the
		// text was already delivered above.
		const shared = `## Body\n${"长".repeat(4_800)} needle needle\n`;
		const fixture = await indexedFixture({
			"filler.md": `# Needle notes\n${"pad ".repeat(3_800)}\nneedle\n`,
			...Object.fromEntries(
				Array.from({ length: 8 }, (_, index) => [`dup-${index + 1}.md`, `# Copy ${index + 1}\n${shared}`]),
			),
		});
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const page = text(await run(tool, { query: "needle" }));
		const pointers = [...page.matchAll(/^\[(\d+)\][^\n]*\n\(identical text to an earlier hit on this page\)$/gmu)];
		// Nothing was delivered whole, so nothing may be reduced to a pointer at it.
		expect(pointers).toEqual([]);
	});

	it("answers a document-name query whose only hit is a structural label", async () => {
		// A document's first section is indexed whatever it holds, so that its file
		// name stays reachable; a page break or single-word heading then means the
		// name search matches nothing but that label. The header still locates the
		// file, so the call answers with it instead of reporting no match.
		const fixture = await indexedFixture({
			"SailorV6Scan培训_v3_ppt.md": "-----\n",
			"OLE_12345.md": "# Glossary\n",
			"normal.md": "# Guide\nordinary body\n",
		});
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		expect(text(await run(tool, { query: "SailorV6Scan" }))).toContain("SailorV6Scan培训_v3_ppt.md:1-1");
		const glossary = text(await run(tool, { query: "Glossary" }));
		expect(glossary).toContain("OLE_12345.md:1-1 · Glossary");
		// The label is not turned into evidence: the body text is never returned.
		expect(glossary).not.toContain("-----");
	});

	it("reports user-run FTS initialization without creating an index", async () => {
		const root = await tempDir("docs-tool-empty-root-");
		const agent = await tempDir("docs-tool-empty-agent-");
		const tool = new WikiTool(session(agent, root));
		await expect(run(tool, { query: "anything" })).rejects.toThrow("No document indexes");

		const service = new DocsService({ agentDir: agent, cwd: root });
		try {
			expect(service.list()).toEqual([]);
		} finally {
			service.close();
		}
	});
});
