import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { DocsService } from "../src/docs/service";
import { WikiTool } from "../src/tools/wiki";

const tempDirs: string[] = [];
const sessionCleanups: Array<() => void | Promise<void>> = [];
const tools = new Set<WikiTool>();
async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const cleanup of sessionCleanups.splice(0)) await cleanup();
	for (const tool of tools) await tool.dispose();
	tools.clear();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function session(agentDir: string, cwd: string) {
	return {
		cwd,
		hasUI: false,
		settings: { getAgentDir: () => agentDir } as unknown as Settings,
		getSessionFile: () => null,
		registerDisposeCallback: (callback: () => void | Promise<void>) => {
			sessionCleanups.push(callback);
			return () => {
				const index = sessionCleanups.indexOf(callback);
				if (index !== -1) sessionCleanups.splice(index, 1);
			};
		},
		registerSessionChangeCallback: () => () => {},
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
	tools.add(tool);
	return tool.execute("t", params as never) as Promise<ToolResult>;
}

function continuation(page: string): { query: string; cursor: string } | undefined {
	const json = page.match(/^More results remain\. Continue with the same query: (.+)$/m)?.[1];
	return json ? (JSON.parse(json) as { query: string; cursor: string }) : undefined;
}

async function pages(tool: WikiTool, query: string): Promise<string[]> {
	const result: string[] = [];
	let params: { query: string; cursor?: string } = { query };
	for (let count = 0; count < 100; count += 1) {
		const page = text(await run(tool, params));
		result.push(page);
		const next = continuation(page);
		if (!next) {
			expect(page).toContain("All matching results exhausted");
			return result;
		}
		expect(next.query).toBe(query);
		expect(next.cursor).toBeTruthy();
		params = next;
	}
	throw new Error("Wiki continuation did not exhaust within 100 pages");
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
		await service.close();
	}
	return { root, agent };
}

describe("WikiTool", () => {
	it("awaits explicit disposal after the real session callback starts teardown", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nshutdownbeacon complete evidence\n" });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		expect(text(await run(tool, { query: "shutdownbeacon" }))).toContain("complete evidence");
		for (const cleanup of sessionCleanups.splice(0)) await cleanup();
		const shutdown = tool.dispose();
		expect(tool.dispose()).toBe(shutdown);
		await shutdown;
		expect(tool.dispose()).toBe(shutdown);
		await expect(run(tool, { query: "shutdownbeacon" })).rejects.toThrow("disposed");
		await fs.rm(fixture.agent, { recursive: true });
		expect(await Bun.file(path.join(fixture.agent, "docs.db")).exists()).toBe(false);
	});

	it("identifies conflicting same-path evidence by index and stable document fingerprint", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Policy\nsharedpolicybeacon requires five cycles.\n" });
		const second = await tempDir("docs-tool-other-");
		await Bun.write(path.join(second, "guide.md"), "# Policy\nsharedpolicybeacon requires seven cycles.\n");
		const service = new DocsService({ agentDir: fixture.agent });
		try {
			await service.init(second, "other-version");
		} finally {
			await service.close();
		}
		const page = text(await run(new WikiTool(session(fixture.agent, fixture.root)), { query: "sharedpolicybeacon" }));
		expect(page).toContain("guide.md:1-2 · Policy · index=manual");
		expect(page).toContain("guide.md:1-2 · Policy · index=other-version");
		const hashes = [...page.matchAll(/sha256=([a-f0-9]{64})/g)].map(match => match[1]);
		expect(new Set(hashes).size).toBe(2);
		expect(page).toContain("five cycles");
		expect(page).toContain("seven cycles");
	});

	it("keeps duplicate sources reachable while prioritizing distinct evidence", async () => {
		const duplicate = "# Topic\ndedupbeacon " + "same boilerplate ".repeat(25) + "\n";
		const files: Record<string, string> = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => [`copy-${i}.md`, duplicate]),
		);
		files["unique.md"] = "# Topic\ndedupbeacon UNIQUE_CRITICAL_CONTENT " + "supporting material ".repeat(180) + "\n";
		const fixture = await indexedFixture(files);
		const result = await pages(new WikiTool(session(fixture.agent, fixture.root)), "dedupbeacon");
		expect(result[0]).toContain("UNIQUE_CRITICAL_CONTENT");
		const locators = result.flatMap(page => [...page.matchAll(/^\[\d+\] (\S+\.md):/gm)].map(match => match[1]));
		expect(locators).toHaveLength(41);
		expect(new Set(locators).size).toBe(41);
		expect(result.join("\n")).toContain("collapsed to a page-local pointer");
		for (const page of result) expect(page.length).toBeLessThanOrEqual(8_000);
	});
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

	it("reports the missing query when lenient argument validation passes a null payload", async () => {
		const root = await tempDir("docs-tool-null-root-");
		const agent = await tempDir("docs-tool-null-agent-");
		const tool = new WikiTool(session(agent, root));
		await expect(run(tool, null)).rejects.toThrow(
			'wiki requires a query. Received: nothing. Example: {"query":"MBIST"}',
		);
	});

	it("resumes complete contiguous budget pages after sources disappear", async () => {
		const filler = "pad ".repeat(600);
		const files = Object.fromEntries(
			Array.from({ length: 12 }, (_, index) => [`sec-${index}.md`, `# sec-${index}\n${filler}\nneedle ${index}\n`]),
		);
		const fixture = await indexedFixture(files);
		const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
		let ranked: string[];
		try {
			ranked = (await service.search("needle", { limit: 200 })).sections.map(section => section.path);
		} finally {
			await service.close();
		}
		await fs.rm(fixture.root, { recursive: true });
		const result = await pages(new WikiTool(session(fixture.agent, fixture.root)), "needle");
		expect(result.length).toBeGreaterThan(1);
		const shown: string[] = [];
		for (const page of result) {
			expect(page.length).toBeLessThanOrEqual(8_000);
			expect(page).toContain("12 matching section(s)");
			for (const hit of page.matchAll(/^\[\d+\] (sec-\d+\.md):/gm)) {
				shown.push(hit[1]!);
				expect(page).toContain(files[hit[1]!]!);
			}
		}
		expect(shown).toEqual(ranked);
		expect(new Set(shown).size).toBe(12);
	});

	it("carries a fresh best hit whole when its locator exceeds the page budget", async () => {
		const root = await tempDir("docs-tool-long-locator-");
		const agent = await tempDir("docs-tool-agent-");
		const relative = `${Array.from({ length: 20 }, (_, index) => `folder-${index}-${"x".repeat(90)}`).join("/")}/guide.md`;
		const filename = path.join(root, relative);
		const body = `# Requirements\nneedle ${"x".repeat(17_950)}\n`;
		await fs.mkdir(path.dirname(filename), { recursive: true });
		await fs.writeFile(filename, body);
		const service = new DocsService({ agentDir: agent, cwd: root });
		try {
			await service.init(".", "manual");
		} finally {
			await service.close();
		}

		const page = text(await run(new WikiTool(session(agent, root)), { query: "needle" }));
		expect(page).toContain(`${relative}:1-2`);
		expect(page).toContain(body);
		expect(page.length).toBeGreaterThan(20_000);
		expect(page).toContain("carried whole");
		expect(page).not.toContain("predates the ingest cap");
		expect(page).not.toContain("search again");
	});

	it("cuts a query that would outgrow the page it asks for", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nCommand: scan\n" });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const page = text(await run(tool, { query: `scan ${"x".repeat(5_000)}` }));
		// The cut query is what gets searched and echoed, so the page still
		// answers and never carries the untruncated run.
		expect(page).toContain("Command: scan");
		expect(page).toContain("…");
		expect(page).not.toContain("x".repeat(1_000));
	});

	it("returns bounded successful zero-match text scoped to the imported corpus", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nCommand: scan\n" });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const page = text(await run(tool, { query: `zzz ${"q".repeat(5_000)}` }));
		expect(page).toContain("0 matching section(s) in the searched imported corpus");
		expect(page).toContain("does not establish");
		expect(page).toContain("All matching results exhausted");
		expect(page.length).toBeLessThan(1_000);
	});

	it("delivers heading-only sections as complete evidence alongside body sections", async () => {
		const fixture = await indexedFixture({
			"title.md": "# Guide\n",
			"body.md": "# Guide\nCommand: scan\n",
		});
		const page = text(await run(new WikiTool(session(fixture.agent, fixture.root)), { query: "guide" }));
		expect(page).toContain("2 matching section(s)");
		expect(page).toContain("title.md:1-1");
		expect(page).toContain("(heading only)\n# Guide\n");
		expect(page).toContain("Command: scan");
		expect(page).toContain("All matching results exhausted");
	});

	it("collapses duplicate bodies only after complete text while preserving each citation", async () => {
		const section = `## Shared\n${"长".repeat(220)} needle\n`;
		const fixture = await indexedFixture({ "a.md": section, "b.md": section });
		const page = text(await run(new WikiTool(session(fixture.agent, fixture.root)), { query: "needle" }));
		expect(page).toContain(section);
		expect(page).toContain("(identical text to hit [1] on this page)");
		expect(page).toContain("1 repeated hit(s) collapsed to a page-local pointer");
		expect(page).toContain("a.md:1-2");
		expect(page).toContain("b.md:1-2");
		expect([...page.matchAll(/sha256=[a-f0-9]{64} · sectionId=\d+/g)]).toHaveLength(2);
		expect(page).toContain("All matching results exhausted");
	});

	it("collapses repeated long heading-only sections without exceeding the page budget", async () => {
		const section = `## ${"重复要求 ".repeat(60)}LONG_HEADING_DUPLICATE_BEACON\n`;
		const fixture = await indexedFixture({ "a.md": section, "b.md": section });
		const page = text(
			await run(new WikiTool(session(fixture.agent, fixture.root)), { query: "LONG_HEADING_DUPLICATE_BEACON" }),
		);

		expect(page).toContain("2 matching section(s)");
		expect(page.split(section).length - 1).toBe(1);
		expect(page).toContain("(identical text to hit [1] on this page)");
		expect(page).toContain("1 repeated hit(s) collapsed to a page-local pointer");
		expect(page.length).toBeLessThan(20_000);
	});

	it("keeps short repeated heading-only sections rather than folding them", async () => {
		const section = "## 支持多层级任务\n";
		const fixture = await indexedFixture({ "a.md": section, "b.md": section });
		const page = text(await run(new WikiTool(session(fixture.agent, fixture.root)), { query: "支持多层级任务" }));

		expect(page).toContain("2 matching section(s)");
		expect(page).toContain("a.md:1-1");
		expect(page).toContain("b.md:1-1");
		expect(page.split(section).length - 1).toBe(2);
		expect(page).not.toContain("repeated hit(s) collapsed");
	});

	it("carries an oversized first section whole and resumes remaining evidence", async () => {
		const body = `# Long\n${"pad ".repeat(4300)}\nneedle here\n`;
		const fixture = await indexedFixture({
			"long.md": body,
			"other.md": "# Other\nneedle and other evidence\n",
		});
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const result = await pages(tool, "needle here");
		expect(result[0]).toContain("long.md:");
		expect(result[0]).toContain(body);
		expect(result[0]).not.toContain("other.md:");
		expect(result[0]).toContain("carried whole");
		expect(result.slice(1).join("\n")).toContain("needle and other evidence");
	});

	it("keeps a heading-only requirement line as complete evidence", async () => {
		const fixture = await indexedFixture({
			"req.md": "# 需求\n## 支持单DIE/多DIE同构分组\n",
			"noise.md": "# Noise\n#### Cell\n",
		});
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const result = text(await run(tool, { query: "支持单DIE 多DIE同构" }));
		// Requirement documents state the requirement in the heading itself.
		expect(result).toContain("支持单DIE/多DIE同构分组");
		expect(result).toContain("heading only");
		// Converter-only structural noise is not a corpus match.
		expect(text(await run(tool, { query: "Cell" }))).toContain("0 matching section(s)");
	});

	it("returns the full heading-only requirement when its label is truncated", async () => {
		const requirement = `支持 ${"完整需求 ".repeat(100)}TAIL_REQUIREMENT_BEACON`;
		const markdown = `## ${requirement}\n`;
		const fixture = await indexedFixture({ "long-requirement.md": markdown });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const page = text(await run(tool, { query: "TAIL_REQUIREMENT_BEACON" }));
		expect(page).toContain("long-requirement.md:1-1");
		expect(page).toContain(markdown);
		expect(page.length).toBeLessThan(20_000);
	});

	it("answers from the known terms when part of the query matches nothing", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nCommand: scan\n" });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const result = text(await run(tool, { query: "scan absentterm" }));
		expect(result).toContain("Command: scan");
		expect(result).toContain("1 matching section(s)");
	});

	it("never skips a nonfitting section in order to fit a later smaller one", async () => {
		const files = {
			"a.md": `# Budget\nbudgetbeacon ${"first ".repeat(550)}\n`,
			"b.md": `# Budget\nbudgetbeacon ${"second ".repeat(900)}\n`,
			"c.md": "# Budget\nbudgetbeacon small tail\n",
		};
		const fixture = await indexedFixture(files);
		const service = new DocsService({ agentDir: fixture.agent });
		let ranked: string[];
		try {
			ranked = (await service.search("budgetbeacon")).sections.map(section => section.path);
		} finally {
			await service.close();
		}
		const result = await pages(new WikiTool(session(fixture.agent, fixture.root)), "budgetbeacon");
		const delivered = result.flatMap(page => [...page.matchAll(/^\[\d+\] (\S+\.md):/gm)].map(hit => hit[1]));
		expect(delivered).toEqual(ranked);
		for (const [name, body] of Object.entries(files)) {
			expect(result.join("\n")).toContain(`${name}:`);
			expect(result.join("\n")).toContain(body);
		}
	});

	it("starts duplicate text afresh on a new page, never pointing across pages", async () => {
		const shared = `## Shared\nneedle ${"shared ".repeat(1_200)}\n`;
		const fixture = await indexedFixture({ "a.md": shared, "b.md": shared });
		const result = await pages(new WikiTool(session(fixture.agent, fixture.root)), "needle");
		expect(result).toHaveLength(2);
		for (const page of result) {
			expect(page).toContain(shared);
			expect(page).not.toContain("(identical text to hit");
		}
	});

	it("delivers stored structural-label text and its provenance", async () => {
		const fixture = await indexedFixture({ "SailorV6Scan培训_v3_ppt.md": "-----\n" });
		const page = text(await run(new WikiTool(session(fixture.agent, fixture.root)), { query: "SailorV6Scan" }));
		expect(page).toContain("SailorV6Scan培训_v3_ppt.md:1-1");
		expect(page).toContain("(structural label)\n-----\n");
		expect(page).toMatch(/sha256=[a-f0-9]{64} · sectionId=\d+/);
		expect(page).toContain("All matching results exhausted");
	});

	it("labels complete technical names separately from related partial evidence", async () => {
		const fixture = await indexedFixture({
			"exact.md": "# Output\nInspect MBIST_CHECK.RPT for the pass criterion.\n",
			"partial.md": "# Output\nInspect another_check.rpt for unrelated reports.\n",
		});
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		for (const query of ["mbist_check.rpt", "Explain mbist_check.rpt."]) {
			const page = text(await run(tool, { query }));
			expect(page).toMatch(/exact\.md:[^\n]+match=exact-name/);
			expect(page).toMatch(/partial\.md:[^\n]+match=related/);
			expect(page.indexOf("exact.md:")).toBeLessThan(page.indexOf("partial.md:"));
			expect(page).toContain("Inspect MBIST_CHECK.RPT for the pass criterion.");
			expect(page).not.toContain("未找到完整名称命中");
		}
		// A standalone name preserves its literal punctuation; only prose has a sentence delimiter.
		for (const query of ["missing_check.rpt", "mbist_check.rpt."]) {
			const absent = text(await run(tool, { query }));
			expect(absent).toContain("未找到完整名称命中");
			expect(absent).toMatch(/exact\.md:[^\n]+match=related/);
			expect(absent).not.toContain("match=exact-name");
		}
	});

	it("validates cursor arguments and rejects malformed, mismatched and stale continuation", async () => {
		const fixture = await indexedFixture({
			"a.md": `# Page\ncursorbeacon ${"a ".repeat(3_000)}\n`,
			"b.md": `# Page\ncursorbeacon ${"b ".repeat(3_000)}\n`,
		});
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		for (const cursor of [null, 1, "", "   ", {}]) {
			await expect(run(tool, { query: "cursorbeacon", cursor })).rejects.toThrow("cursor");
		}
		await expect(run(tool, { query: "cursorbeacon", cursor: "not-a-cursor" })).rejects.toThrow();
		const next = continuation(text(await run(tool, { query: "cursorbeacon" })));
		expect(next).toBeDefined();
		await expect(run(tool, { ...next, query: "different" })).rejects.toThrow();
		const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
		try {
			await fs.writeFile(path.join(fixture.root, "c.md"), "# Page\ncursorbeacon changed corpus\n");
			await service.init(".", "replacement");
		} finally {
			await service.close();
		}
		await expect(run(tool, next)).rejects.toThrow();
	});

	it("propagates a corrupt database as an error rather than zero-match success", async () => {
		const root = await tempDir("docs-tool-corrupt-root-");
		const agent = await tempDir("docs-tool-corrupt-agent-");
		await fs.writeFile(path.join(agent, "docs.db"), "not a SQLite database");
		await expect(run(new WikiTool(session(agent, root)), { query: "anything" })).rejects.toThrow();
	});

	it("reports user-run FTS initialization without creating an index", async () => {
		const root = await tempDir("docs-tool-empty-root-");
		const agent = await tempDir("docs-tool-empty-agent-");
		const tool = new WikiTool(session(agent, root));
		await expect(run(tool, { query: "anything" })).rejects.toThrow("No document indexes");

		const service = new DocsService({ agentDir: agent, cwd: root });
		try {
			expect(await service.list()).toEqual([]);
		} finally {
			await service.close();
		}
	});
});
