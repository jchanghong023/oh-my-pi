import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { wikiToolPage } from "@oh-my-pi/pi-natives";
import { Settings } from "../src/config/settings";
import { DocsService } from "../src/docs/service";
import { SessionManager } from "../src/session/session-manager";
import { postProcessToolResult, wrapToolWithMetaNotice } from "../src/tools/output-meta";
import { WikiTool } from "../src/tools/wiki";

const tempDirs: string[] = [];
const sessionCleanups: Array<() => void | Promise<void>> = [];
const tools = new Set<WikiTool>();
async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function agentDir(prefix: string): Promise<string> {
	const dir = await tempDir(prefix);
	await Bun.write(path.join(dir, "config.yml"), "mnemopi:\n  noEmbeddings: true\n");
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
function run(tool: WikiTool, params: unknown, context?: AgentToolContext): Promise<ToolResult> {
	tools.add(tool);
	return tool.execute("t", params as never, undefined, undefined, context) as Promise<ToolResult>;
}

interface WikiQuery {
	query: string;
	mode?: "search" | "grep";
	case?: boolean;
	path?: string;
	cursor?: string;
}

function continuation(page: string): (WikiQuery & { cursor: string }) | undefined {
	const json = page.match(/^More results remain\. Continue with the same query: (.+)$/m)?.[1];
	return json ? (JSON.parse(json) as WikiQuery & { cursor: string }) : undefined;
}

async function pages(
	tool: WikiTool,
	query: string,
	options: Pick<WikiQuery, "mode" | "case" | "path"> = {},
): Promise<string[]> {
	const result: string[] = [];
	let params: WikiQuery = { query, ...options };
	for (let count = 0; count < 100; count += 1) {
		const page = text(await run(tool, params));
		result.push(page);
		const next = continuation(page);
		if (!next) {
			expect(page).toMatch(/exhaust|no (?:more|further) results/i);
			if (options.mode === "grep") expect(page).toMatch(/corpus|indexes|documents/i);
			return result;
		}
		expect(next.query).toBe(query);
		expect(next.cursor).toBeTruthy();
		expect(next.path).toBe(options.path);
		if (options.mode === "grep") {
			expect(next.mode).toBe("grep");
			expect(next.case).toBe(options.case ?? true);
		} else {
			expect(next.mode).toBeUndefined();
			expect(next.case).toBeUndefined();
		}
		params = next;
	}
	throw new Error("Wiki continuation did not exhaust within 100 pages");
}

/** Indexes `files` (name → Markdown) into a throwaway agent directory. */
async function indexedFixture(files: Record<string, string>): Promise<{ root: string; agent: string }> {
	const root = await tempDir("docs-tool-root-");
	const agent = await agentDir("docs-tool-agent-");
	for (const [name, body] of Object.entries(files)) await Bun.write(path.join(root, name), body);
	const service = new DocsService({ agentDir: agent, cwd: root });
	try {
		await service.init(".", "manual");
	} finally {
		await service.close();
	}
	return { root, agent };
}

it("restricts file and directory searches to stored paths across indexes and binds continuation", async () => {
	const files: Record<string, string> = Object.fromEntries(
		Array.from({ length: 12 }, (_, i) => [
			`scope/doc-${i}.md`,
			`# Evidence ${i}\nscopebeacon ${"complete ".repeat(50)}${i}\n`,
		]),
	);
	files["scope/a%_.md"] = "# Special\nscopebeacon literal punctuation\n";
	files["scope-other/no.md"] = "# Outside\nscopebeacon outside\n";
	const fixture = await indexedFixture(files);
	const other = await tempDir("wiki-scope-second-");
	await Bun.write(path.join(other, "scope/a%_.md"), "# Other index\nscopebeacon second source\n");
	const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
	try {
		await service.init(other, "second");
	} finally {
		await service.close();
	}
	await fs.rm(fixture.root, { recursive: true });
	await fs.rm(other, { recursive: true });
	const tool = new WikiTool(session(fixture.agent, fixture.root));
	for (const mode of ["search", "grep"] as const) {
		const exact = text(await run(tool, { query: "scopebeacon", mode, path: "scope/a%_.md" }));
		expect(exact).toContain("literal punctuation");
		expect(exact).toContain("second source");
		expect(exact).not.toContain("outside");
		expect(exact).not.toContain("doc-");
		const first = text(await run(tool, { query: "scopebeacon", mode, path: "scope/" }));
		const next = continuation(first);
		expect(next?.path).toBe("scope/");
		await expect(run(tool, { ...next, path: "scope-other/" })).rejects.toThrow();
		await expect(run(tool, { ...next, path: undefined })).rejects.toThrow();
		const all = await pages(tool, "scopebeacon", { mode, path: "scope/" });
		const hits = all.flatMap(page => [...page.matchAll(/^\[\d+\] (\S+\.md):/gm)].map(match => match[1]));
		expect(hits).toHaveLength(14);
		expect(hits.every(name => name!.startsWith("scope/"))).toBe(true);
		expect(all.every(page => page.length <= 4_000)).toBe(true);
		const zero = text(await run(tool, { query: "scopebeacon", mode, path: "missing.md" }));
		expect(zero).toMatch(/0 matching section/i);
		expect(zero).toMatch(mode === "grep" ? /retrieval:\s*grep/i : /retrieval:\s*fulltext/i);
		expect(zero).toMatch(/reranked:\s*no/i);
	}
	for (const path of ["", "../outside.md", "/absolute.md", "C:/absolute.md"])
		await expect(run(tool, { query: "scopebeacon", path })).rejects.toThrow();
}, 30_000);

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
		const locators = result.flatMap(page => [...page.matchAll(/^\[\d+\] (\S+\.md):/gm)].map(match => match[1]));
		expect(locators.slice(0, 2)).toContain("unique.md");
		const uniquePage = result.find(page => /^\[\d+\] unique\.md:/m.test(page));
		expect(uniquePage).toBeDefined();
		expect(uniquePage).toContain(files["unique.md"]!);
		expect(locators).toHaveLength(41);
		expect(new Set(locators).size).toBe(41);
		expect(result.join("\n")).toContain("collapsed to a page-local pointer");
	}, 20_000);
	it("returns the stored section text after the source directory is removed", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nCommand: scan\n" });
		await fs.rm(fixture.root, { recursive: true });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const result = text(await run(tool, { query: "scan" }));
		expect(result).toContain("guide.md:1-2");
		expect(result).toContain("Command: scan");
	});

	it("renders DB-only explicit regex evidence without reinterpreting default C++ and path queries", async () => {
		const fixture = await indexedFixture({
			"exact.md": "# Output\nUse C++ and docs/src/main.rs.\nCaseBeacon\nPAIR=echo echo\n`counter*factor`\n",
			"continued.md": "# Output\nC++17 docs/src/main.rs.bak\ncasebeacon\n",
			"plain.md": "# Output\nCCCC docs/src/mainXrs\n",
		});
		await fs.rm(fixture.root, { recursive: true });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		for (const query of ["C++", "docs/src/main.rs"]) {
			const search = text(await run(tool, { query }));
			expect(search).toMatch(/exact\.md:[^\n]+match=exact-name/);
			expect(search).toMatch(/continued\.md:[^\n]+match=related/);
			expect(text(await run(tool, { query, mode: "search", case: false }))).toBe(search);
		}
		const unescaped = text(await run(tool, { query: "C++", mode: "grep" }));
		expect(unescaped).toMatch(/plain\.md:[^\n]+match=regex/);
		expect(unescaped).toContain("CCCC docs/src/mainXrs");
		const page = text(await run(tool, { query: "C\\+\\+", mode: "grep" }));
		expect(page).toMatch(/exact\.md:[^\n]+match=regex/);
		expect(page).toMatch(/continued\.md:[^\n]+match=regex/);
		expect(page).not.toContain("plain.md:");
		expect(page).not.toContain("match=exact-name");
		expect(page).not.toContain("match=related");
		expect(page).not.toContain("未找到完整名称命中");
		expect(page).toContain("Use C++ and docs/src/main.rs.");
		const paths = text(await run(tool, { query: "docs/src/main\\.rs(?!\\.bak)", mode: "grep" }));
		expect(paths).toContain("exact.md:1-5");
		expect(paths).not.toContain("continued.md:");
		expect(paths).not.toContain("plain.md:");
		for (const query of ["(?<=PAIR=)(echo) \\1", "`counter\\*factor`"]) {
			const evidence = text(await run(tool, { query, mode: "grep" }));
			expect(evidence).toMatch(/exact\.md:[^\n]+match=regex/);
			expect(evidence).not.toContain("continued.md:");
		}
		const sensitive = text(await run(tool, { query: "CaseBeacon", mode: "grep" }));
		expect(sensitive).toContain("exact.md:");
		expect(sensitive).not.toContain("continued.md:");
		expect(text(await run(tool, { query: "CaseBeacon", mode: "grep", case: true }))).toBe(sensitive);
		const insensitive = text(await run(tool, { query: "CaseBeacon", mode: "grep", case: false }));
		expect(insensitive).toContain("exact.md:");
		expect(insensitive).toContain("continued.md:");
	}, 20_000);

	it("preserves regex spaces, reports legal zero matches and rejects malformed expressions and options", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\n padded \nfirst\nsecond\n" });
		await fs.rm(fixture.root, { recursive: true });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		expect(text(await run(tool, { query: " padded ", mode: "grep" }))).toContain("guide.md:1-4");
		for (const query of ["  padded ", " padded  ", "absent", "first\\nsecond", "(?s)first.*second"]) {
			const page = text(await run(tool, { query, mode: "grep" }));
			expect(page).toMatch(/(?:0\s+match|no matches)/i);
			expect(page).toMatch(/exhaust|no (?:more|further) results/i);
			expect(page).toMatch(/corpus|indexes|documents/i);
			expect(page).not.toContain("guide.md:");
			expect(page).not.toContain("未找到完整名称命中");
		}
		for (const query of ["[", "(", "\\", "foo.*(bar", "", " \t "])
			await expect(run(tool, { query, mode: "grep" })).rejects.toThrow();
		for (const query of ["x".repeat(501), "𐐀".repeat(251)])
			await expect(run(tool, { query, mode: "grep" })).rejects.toThrow("500");
		for (const mode of ["regex", null, false, 1, {}])
			await expect(run(tool, { query: "padded", mode })).rejects.toThrow("mode");
		for (const caseValue of ["false", null, 1, {}])
			await expect(run(tool, { query: "padded", mode: "grep", case: caseValue })).rejects.toThrow("case");
		const zero = text(await run(tool, { query: "𐐀".repeat(250), mode: "grep", unrelated: "ignored" }));
		expect(zero).toMatch(/(?:0\s+match|no matches)/i);
		expect(zero).toMatch(/exhaust|no (?:more|further) results/i);
		expect(zero).toMatch(/corpus|indexes|documents/i);
	}, 15_000);

	it("returns stable complete grep pages and option-bearing continuations with cursor isolation", async () => {
		const files = Object.fromEntries(
			Array.from({ length: 8 }, (_, index) => [
				`sec-${index}.md`,
				`# Source ${index}\n ${index % 2 ? "PAGEBEACON" : "pagebeacon"} ${"evidence ".repeat(280)}\nFINAL_${index}\n`,
			]),
		);
		const fixture = await indexedFixture(files);
		await fs.rm(fixture.root, { recursive: true });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const query = " pagebeacon ";
		const first = text(await run(tool, { query, mode: "grep", case: false }));
		const next = continuation(first);
		expect(next).toBeDefined();
		expect(next).toMatchObject({ query, mode: "grep", case: false });
		for (const params of [
			{ ...next, query: query.trim() },
			{ ...next, mode: "search" },
			{ ...next, case: true },
			{ query, cursor: next!.cursor },
		])
			await expect(run(tool, params)).rejects.toThrow();
		const defaultNext = continuation(text(await run(tool, { query, mode: "grep" })));
		expect(defaultNext).toMatchObject({ query, mode: "grep", case: true });
		expect(text(await run(tool, defaultNext))).toContain("match=regex");
		const searchNext = continuation(text(await run(tool, { query: "pagebeacon" })));
		expect(searchNext).toBeDefined();
		await expect(run(tool, { ...searchNext, mode: "grep" })).rejects.toThrow();
		const result = await pages(tool, query, { mode: "grep", case: false });
		expect(result.length).toBeGreaterThan(1);
		const shown = result.flatMap(page => [...page.matchAll(/^\[\d+\] (sec-\d+\.md):/gm)].map(hit => hit[1]!));
		expect(shown).toEqual(Object.keys(files));
		expect(new Set(shown).size).toBe(8);
		for (const page of result) {
			expect(page.length).toBeLessThanOrEqual(4_000);
			expect(page).toContain("8 matching section(s)");
			for (const hit of page.matchAll(/^\[\d+\] (sec-\d+\.md):/gm)) expect(page).toContain(files[hit[1]!]!);
		}
	}, 20_000);

	it("ignores stray keys but names what arrived when the query is missing", async () => {
		const fixture = await indexedFixture({ "guide.md": "# Guide\nCommand: scan\n" });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		expect(text(await run(tool, { query: "scan", limit: 5 }))).toContain("Command: scan");
		await expect(run(tool, { q: "scan" })).rejects.toThrow("Received: q");
		await expect(run(tool, {})).rejects.toThrow("Received: nothing");
	});

	it("reports the missing query when lenient argument validation passes a null payload", async () => {
		const root = await tempDir("docs-tool-null-root-");
		const agent = await agentDir("docs-tool-null-agent-");
		const tool = new WikiTool(session(agent, root));
		await expect(run(tool, null)).rejects.toThrow(
			'wiki requires a query. Received: nothing. Example: {"query":"MBIST"}',
		);
	});

	it.each(["search", "grep"] as const)("caps compact %s pages without losing remaining evidence", async mode => {
		const files = Object.fromEntries(
			Array.from({ length: 17 }, (_, index) => {
				const id = String(index).padStart(2, "0");
				return [`part-${id}.md`, `# Part ${id}\ncompactbeacon evidence record${id}\n`];
			}),
		);
		const fixture = await indexedFixture(files);
		const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
		let ranked: string[];
		try {
			ranked = (await service.search("compactbeacon", { mode, limit: 50 })).sections.map(section => section.path);
		} finally {
			await service.close();
		}
		const result = await pages(new WikiTool(session(fixture.agent, fixture.root)), "compactbeacon", { mode });
		const shown = result.map(page => [...page.matchAll(/^\[\d+\] (part-\d+\.md):/gm)].map(hit => hit[1]!));
		expect(shown.every(hits => hits.length <= 10)).toBe(true);
		expect(shown.flat()).toEqual(ranked);
		expect(new Set(shown.flat()).size).toBe(17);
		for (const page of result) expect(page.length).toBeLessThanOrEqual(4_000);
		const next = continuation(result[0]!);
		expect(next).toBeDefined();
		expect(continuation(result[0]!.trimEnd().split("\n").at(-1)!)).toEqual(next);
		expect(continuation(result.at(-1)!)).toBeUndefined();
	});

	it.each(["search", "grep"] as const)(
		"previews unexpanded %s results without advancing their cursor",
		async mode => {
			const files = Object.fromEntries(
				Array.from({ length: 25 }, (_, index) => {
					const id = String(index).padStart(2, "0");
					return [`hint-${id}.md`, `# Topic ${id}\nhintbeacon full evidence ${id}\n`];
				}),
			);
			const fixture = await indexedFixture(files);
			const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
			try {
				const baseline = await service.search("hintbeacon", { mode, limit: 50 });
				const first = await service.searchWiki("hintbeacon", { mode });
				const next = continuation(first.text);
				expect(next).toBeDefined();
				const hints = [...first.text.matchAll(/^- \[hint\] manual · (hint-\d+\.md):(\d+)-(\d+) · ([^\n]+)$/gm)];
				expect(hints.length).toBeGreaterThan(0);
				expect(hints.map(hit => hit[1])).toEqual(
					baseline.sections
						.slice(first.result.sections.length, first.result.sections.length + hints.length)
						.map(hit => hit.path),
				);
				for (const hint of hints) {
					const original = baseline.sections.find(hit => hit.path === hint[1])!;
					expect([Number(hint[2]), Number(hint[3]), hint[4]]).toEqual([
						original.lineStart,
						original.lineEnd,
						original.headingPath,
					]);
				}
				const counts = first.text.match(/(\d+) unexpanded section\(s\): (\d+) previewed; (\d+) not listed/);
				expect(counts?.slice(1).map(Number)).toEqual([
					baseline.total - first.result.sections.length,
					hints.length,
					baseline.total - first.result.sections.length - hints.length,
				]);
				expect(first.text.length).toBeLessThanOrEqual(4_000);
				const second = await service.searchWiki("hintbeacon", { mode, cursor: next!.cursor });
				expect(second.result.sections[0]?.path).toBe(hints[0]![1]);
				expect(second.result.sections[0]?.text).toBe(files[hints[0]![1]!]);
			} finally {
				await service.close();
			}
		},
		20_000,
	);

	it("reserves an encoded snapshot cursor and escaped grep continuation before rendering hints", async () => {
		const files = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [
				`cursor-${String(index).padStart(2, "0")}.md`,
				`# Cursor ${index}\ncursorbudget ${"evidence ".repeat(36)}${index}\n`,
			]),
		);
		const fixture = await indexedFixture(files);
		const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
		try {
			const baseline = await service.search("cursorbudget", { mode: "grep", limit: 50 });
			const actual = await service.searchWiki("cursorbudget", { mode: "grep" });
			const actualNext = continuation(actual.text);
			expect(actualNext).toBeDefined();
			const snapshot = JSON.parse(Buffer.from(actualNext!.cursor, "base64url").toString()) as {
				v: 1;
				q: string;
				s: string;
				p: number;
			};
			// Enlarge the real snapshot identity to exercise the renderer's cursor
			// bound independently of the current fixed-size snapshot hashes.
			const cursorBase = { ...snapshot, s: snapshot.s + "s".repeat(1_100), p: 9 };
			const query = `cursorbudget${"\\".repeat(100)}"quoted`;
			const window = { ...baseline, total: cursorBase.p + baseline.sections.length, cursorBase };
			const first = wikiToolPage(query, window, "grep", false);
			expect(first.text.length).toBeLessThanOrEqual(4_000);
			expect(first.result.sections.length).toBeGreaterThan(0);
			expect(first.text).toContain(first.result.sections[0]!.text);
			expect(first.text).toMatch(/^- \[hint\]/m);
			const next = continuation(first.text);
			expect(next?.query).toBe(query);
			expect(next?.mode).toBe("grep");
			expect(next?.case).toBe(false);
			expect(typeof next?.cursor).toBe("string");
			const decoded = JSON.parse(Buffer.from(next!.cursor, "base64url").toString()) as typeof cursorBase;
			expect(decoded).toEqual({ ...cursorBase, p: cursorBase.p + first.result.sections.length });
			const second = wikiToolPage(
				query,
				{
					...window,
					sections: baseline.sections.slice(first.result.sections.length),
					cursorBase: decoded,
				},
				"grep",
				false,
			);
			expect(second.result.sections[0]?.sectionId).toBe(baseline.sections[first.result.sections.length]?.sectionId);
			expect(second.text).toContain(second.result.sections[0]!.text);
			expect(second.text.length).toBeLessThanOrEqual(4_000);

			const oversizedBody = `${baseline.sections[0]!.text}${"whole evidence ".repeat(400)}`;
			const oversized = wikiToolPage(
				query,
				{
					...window,
					sections: [{ ...baseline.sections[0]!, text: oversizedBody }, ...baseline.sections.slice(1)],
				},
				"grep",
				false,
			);
			expect(oversized.text).toContain(oversizedBody);
			expect(oversized.text.length).toBeGreaterThan(4_000);
			expect(oversized.result.sections).toHaveLength(1);
			expect(continuation(oversized.text)).toMatchObject({ query, mode: "grep", case: false });
		} finally {
			await service.close();
		}
	}, 20_000);

	it("truncates long Unicode hint headings without truncating the continued evidence", async () => {
		const heading = `${"主题😀".repeat(100)}尾部`;
		const files = {
			"a.md": `# First\nhintunicode ${"evidence ".repeat(190)}\n`,
			"b.md": `# ${heading}\nhintunicode ${"details ".repeat(360)}\n`,
		};
		const fixture = await indexedFixture(files);
		const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
		try {
			const first = await service.searchWiki("hintunicode", { mode: "grep" });
			const hint = first.text.match(/^- \[hint\] manual · b\.md:\d+-\d+ · ([^\n]+)$/m)?.[1];
			expect(hint?.endsWith("…")).toBe(true);
			expect(hint?.isWellFormed()).toBe(true);
			expect(first.text.length).toBeLessThanOrEqual(4_000);
			const next = continuation(first.text);
			expect(next).toBeDefined();
			const second = await service.searchWiki("hintunicode", { mode: "grep", cursor: next!.cursor });
			expect(second.result.sections[0]?.text).toBe(files["b.md"]);
		} finally {
			await service.close();
		}
	});

	it("keeps oversized evidence whole and leaves unlisted hits for continuation", async () => {
		const body = `# Long\nhintoversize ${"evidence ".repeat(800)}\n`;
		const fixture = await indexedFixture({ "a.md": body, "b.md": "# Next\nhintoversize tail\n" });
		const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
		try {
			const first = await service.searchWiki("hintoversize", { mode: "grep" });
			expect(first.result.sections.map(hit => hit.path)).toEqual(["a.md"]);
			expect(first.text).toContain(body);
			expect(first.text.length).toBeGreaterThan(4_000);
			const counts = first.text.match(/(\d+) unexpanded section\(s\): (\d+) previewed; (\d+) not listed/);
			expect(counts?.slice(1).map(Number)).toEqual([1, 0, 1]);
			const next = continuation(first.text);
			expect(next).toBeDefined();
			const second = await service.searchWiki("hintoversize", { mode: "grep", cursor: next!.cursor });
			expect(second.result.sections.map(hit => hit.path)).toEqual(["b.md"]);
			expect(second.result.sections[0]?.text).toBe("# Next\nhintoversize tail\n");
		} finally {
			await service.close();
		}
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
			expect(page.length).toBeLessThanOrEqual(4_000);
			expect(page).toContain("12 matching section(s)");
			for (const hit of page.matchAll(/^\[\d+\] (sec-\d+\.md):/gm)) {
				shown.push(hit[1]!);
				expect(page).toContain(files[hit[1]!]!);
			}
		}
		expect(shown).toEqual(ranked);
		expect(new Set(shown).size).toBe(12);
	}, 20_000);

	it("carries a fresh best hit whole when its locator exceeds the page budget", async () => {
		const root = await tempDir("docs-tool-long-locator-");
		const agent = await agentDir("docs-tool-agent-");
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
		expect(page).toMatch(/(?:0\s+match|no matches)/i);
		expect(page).toMatch(/exhaust|no (?:more|further) results/i);
		expect(page).toMatch(/corpus|indexes|documents/i);
		expect(page).toMatch(/(?:not|doesn't|cannot|can't).*(?:elsewhere|exist|absence)/i);
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

	it("preserves complete multibyte pages through the session output wrapper while advancing their cursor", async () => {
		const body = `# WIKIPAGEBEACON\n${"汉".repeat(8_800)}\nMIDDLE_EVIDENCE_MUST_SURVIVE\n${"字".repeat(8_800)}\nFINAL_EVIDENCE\n`;
		expect(body.length).toBeLessThan(18_000);
		expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(50 * 1024);
		const other = "# Next\nWIKIPAGEBEACON remaining independent evidence\n";
		const fixture = await indexedFixture({ "long.md": body, "other.md": other });
		const manager = SessionManager.create(fixture.root, path.join(fixture.agent, "sessions"));
		await manager.ensureOnDisk();
		sessionCleanups.push(() => manager.close());
		const context = { sessionManager: manager, settings: Settings.isolated() } as unknown as AgentToolContext;
		const tool = wrapToolWithMetaNotice(new WikiTool(session(fixture.agent, fixture.root)));

		// The best hit exceeds the usual page budget but must be carried whole;
		// its continuation belongs after all of that evidence, not after a spill preview.
		const first = text(await run(tool, { query: "WIKIPAGEBEACON" }, context));
		expect(first).toContain(body);
		expect(first).toContain("MIDDLE_EVIDENCE_MUST_SURVIVE");
		expect(first).toContain("FINAL_EVIDENCE");
		expect(first).toContain("carried whole");
		expect(first).not.toContain("artifact://");
		const next = continuation(first);
		expect(next).toBeDefined();
		const last = text(await run(tool, next!, context));
		expect(last).toContain(other);
		expect(last).not.toContain(body);
		expect(continuation(last)).toBeUndefined();

		// A final page must retain the same complete body and its exhaustion footer.
		const only = text(await run(tool, { query: "^# WIKIPAGEBEACON$", mode: "grep" }, context));
		expect(only).toContain(body);
		expect(only).not.toContain("artifact://");
		expect(continuation(only)).toBeUndefined();
		expect(only).toMatch(/exhaust|no (?:more|further) results/i);
		expect(only).toMatch(/corpus|indexes|documents/i);

		// The guarantee is explicit metadata, not a relaxed byte limit for ordinary output.
		const ordinary = await postProcessToolResult(
			{ content: [{ type: "text", text: body }] },
			"plain-output",
			context,
		);
		const artifactId = ordinary.details?.meta?.truncation?.artifactId;
		expect(artifactId).toBeDefined();
		expect(text(ordinary)).not.toContain(body);
		expect(text(ordinary)).toContain(`artifact://${artifactId}`);
		const artifactPath = await manager.getArtifactPath(artifactId!);
		expect(artifactPath).not.toBeNull();
		expect(await Bun.file(artifactPath!).text()).toBe(body);
	}, 20_000);

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
		const agent = await agentDir("docs-tool-corrupt-agent-");
		await fs.writeFile(path.join(agent, "docs.db"), "not a SQLite database");
		await expect(run(new WikiTool(session(agent, root)), { query: "anything" })).rejects.toThrow();
	});

	it("reports user-run FTS initialization without creating an index", async () => {
		const root = await tempDir("docs-tool-empty-root-");
		const agent = await agentDir("docs-tool-empty-agent-");
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
