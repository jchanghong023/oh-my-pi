import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enumerateMarkdownFiles, parseMarkdown, readMarkdownDocument } from "../src/docs/markdown";
import { resolveDocumentSchema } from "../src/docs/schema";
import { DocsService } from "../src/docs/service";
import type { DocumentExtraction, DocumentSchemaV1 } from "../src/docs/types";

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

const schema: DocumentSchemaV1 = {
	id: "test-docs",
	version: 1,
	title: "Test documents",
	description: "Minimal schema for indexing behavior",
	instructions: [],
	entityKinds: [
		{
			name: "item",
			description: "A documented item",
			identity: { scope: "global", fields: ["name"] },
			fields: [
				{ name: "name", type: "string", description: "Name", required: true },
				{ name: "value", type: "string", description: "Value" },
			],
		},
		{
			name: "tool",
			description: "A tool",
			identity: { scope: "global", fields: ["name"] },
			fields: [{ name: "name", type: "string", description: "Name", required: true }],
		},
	],
	predicates: [
		{ name: "uses", description: "Uses", sourceKinds: ["item"], targetKinds: ["tool"], cardinality: "many" },
	],
};

async function schemaFile(cwd: string): Promise<string> {
	const file = path.join(cwd, "schema.json");
	await fs.writeFile(file, JSON.stringify(schema));
	return file;
}

function extraction(sectionText: string, value: string, invalidEvidence = false): DocumentExtraction {
	const line = sectionText.split("\n").findIndex(item => item.includes("Item:")) + 1;
	const quote = sectionText.split("\n").find(item => item.includes("Item:")) ?? sectionText.trim();
	const evidence = {
		quote: invalidEvidence ? "not source text" : quote,
		lineStart: line,
		lineEnd: line,
		confidence: 0.9,
	};
	return {
		entities: [
			{ localId: "item", kind: "item", identity: { name: "Alpha" }, displayName: "Alpha", aliases: ["A"], evidence },
			{
				localId: "tool",
				kind: "tool",
				identity: { name: sectionText.includes("two") ? "Runner Two" : "Runner One" },
				displayName: sectionText.includes("two") ? "Runner Two" : "Runner One",
				aliases: [],
				evidence,
			},
		],
		assertions: [{ subjectLocalId: "item", field: "value", value, evidence }],
		relations: [{ sourceLocalId: "item", predicate: "uses", targetLocalId: "tool", evidence }],
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("document schema and Markdown parsing", () => {
	it("uses the embedded DFT schema by default and hashes canonical JSON", async () => {
		const first = await resolveDocumentSchema(undefined, process.cwd());
		const second = await resolveDocumentSchema("dft", process.cwd());
		expect(first.source).toBe("embedded");
		expect(first.schema.id).toBe("dft");
		expect(first.json).toBe(second.json);
		expect(first.hash).toBe(second.hash);
	});

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
		expect(parsed.sections.length).toBeGreaterThan(3);
		expect(
			parsed.sections.every(section => section.byteEnd > section.byteStart && section.lineEnd >= section.lineStart),
		).toBe(true);
		expect(parsed.sections.find(section => section.headingPath.at(-1) === "Child")?.plainText).toContain(
			"child text",
		);
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
	it("merges entities and aliases, preserves conflicts, rejects unverifiable evidence, and serves stored evidence", async () => {
		const root = await tempDir("docs-root-");
		const agent = await tempDir("docs-agent-");
		await fs.writeFile(path.join(root, "one.md"), "# One\nItem: Alpha one\n");
		await fs.writeFile(path.join(root, "two.md"), "# Two\nItem: Alpha two\n");
		const service = new DocsService({
			agentDir: agent,
			cwd: root,
			extractor: async ({ section }) =>
				extraction(section.rawMarkdown, section.rawMarkdown.includes("two") ? "fast" : "FAST"),
		});
		try {
			const created = await service.init(".", "manual", path.relative(root, await schemaFile(root)), {
				mode: "structured",
			});
			expect(created.index.state).toBe("ready");
			expect(created.index.entityCount).toBe(3);
			expect((await fs.stat(service.storage.path)).mode & 0o777).toBe(0o600);
			expect(service.lookup("A", { index: "manual" })[0]?.aliases).toEqual(["A"]);
			const conflict = service.conflicts({ index: "manual" });
			expect(conflict).toHaveLength(1);
			expect(conflict[0]?.values.map(item => item.value).toSorted()).toEqual(["FAST", "fast"]);
			const evidence = service
				.lookup("Alpha", { index: "manual" })[0]
				?.assertions.flatMap(assertion => assertion.evidence)
				.find(item => item.path === "one.md");
			expect(evidence?.quote).toMatch(/^Item: Alpha/);
			if (!evidence) throw new Error("expected evidence");
			await fs.rm(path.join(root, "one.md"));
			expect(service.read({ evidenceId: evidence.id }).rawMarkdown).toContain("Item: Alpha one");
		} finally {
			service.close();
		}

		const invalidAgent = await tempDir("docs-agent-invalid-");
		const invalid = new DocsService({
			agentDir: invalidAgent,
			cwd: root,
			extractor: async ({ section }) => extraction(section.rawMarkdown, "bad", true),
		});
		try {
			await expect(
				invalid.init(".", "invalid", path.relative(root, await schemaFile(root)), { mode: "structured" }),
			).rejects.toThrow("Unverifiable evidence");
			expect(() => invalid.status("invalid")).toThrow("Unknown document index");
		} finally {
			invalid.close();
		}
	});

	it("reinitializes an immutable generation for added, changed, and deleted Markdown files", async () => {
		const root = await tempDir("docs-reinit-root-");
		const agent = await tempDir("docs-reinit-agent-");
		await fs.writeFile(path.join(root, "a.md"), "# A\nItem: Alpha\n");
		const service = new DocsService({
			agentDir: agent,
			cwd: root,
			extractor: async ({ section }) => extraction(section.rawMarkdown, "v"),
		});
		try {
			const schema = path.relative(root, await schemaFile(root));
			const initial = await service.init(".", "idx", schema, { mode: "structured" });
			expect(initial.processed).toBe(1);
			await fs.writeFile(path.join(root, "b.md"), "# B\nItem: Beta\n");
			await fs.writeFile(path.join(root, "a.md"), "# A\nItem: Alpha changed\n");
			const rebuilt = await service.reinit("idx");
			expect(rebuilt.processed).toBe(2);
			expect(rebuilt.index.id).not.toBe(initial.index.id);
			await fs.rm(path.join(root, "b.md"));
			expect((await service.reinit("idx")).processed).toBe(1);
			const indexStatus = service.status("idx");
			if (Array.isArray(indexStatus)) throw new Error("expected one index");
			expect(indexStatus.documentCount).toBe(1);
		} finally {
			service.close();
		}
	});

	it("keeps the active generation on cancellation and defaults to ready FTS-only indexing", async () => {
		const root = await tempDir("docs-cancel-root-");
		const agent = await tempDir("docs-cancel-agent-");
		await fs.writeFile(path.join(root, "a.md"), "# A\nItem: Alpha\n");
		const service = new DocsService({ agentDir: agent, cwd: root, extractor: null });
		try {
			const initial = await service.init(".", "fts", path.relative(root, await schemaFile(root)));
			expect(initial.index.state).toBe("ready");
			expect(initial.index.mode).toBe("fts");
			await fs.writeFile(path.join(root, "a.md"), "# A\nItem: Beta\n");
			const controller = new AbortController();
			controller.abort();
			await expect(service.reinit("fts", { signal: controller.signal })).rejects.toMatchObject({
				name: "AbortError",
			});
			const unchanged = service.status("fts");
			if (Array.isArray(unchanged)) throw new Error("expected one index");
			expect(unchanged.id).toBe(initial.index.id);
			expect(service.search("Alpha", { index: "fts" }).sections).not.toHaveLength(0);
			expect(service.search("Beta", { index: "fts" }).sections).toHaveLength(0);
			const rebuilt = await service.reinit("fts");
			expect(rebuilt.index.id).not.toBe(initial.index.id);
			expect(service.search("Beta", { index: "fts" }).sections).not.toHaveLength(0);
		} finally {
			service.close();
		}
	});

	it("supports ASCII and Han character full-text search", async () => {
		const root = await tempDir("docs-search-root-");
		const agent = await tempDir("docs-search-agent-");
		await fs.writeFile(path.join(root, "mixed.md"), "# Mixed\nItem: Alpha\n中文接口说明\n");
		const service = new DocsService({ agentDir: agent, cwd: root, extractor: null });
		try {
			await service.init(".", "mixed", path.relative(root, await schemaFile(root)));
			expect(service.search("Alpha", { index: "mixed" }).sections.length).toBe(1);
			expect(service.search("中文", { index: "mixed" }).sections.length).toBe(1);
		} finally {
			service.close();
		}
	});

	it("keeps ordinary names containing the building pattern visible", async () => {
		const root = await tempDir("docs-visible-root-");
		const agent = await tempDir("docs-visible-agent-");
		await fs.writeFile(path.join(root, "guide.md"), "# Guide\nbuilding visibility\n");
		const service = new DocsService({ agentDir: agent, cwd: root, extractor: null });
		const name = "abbuildingcd";
		try {
			await service.init(".", name, "dft");
			expect(service.list().map(index => index.name)).toEqual([name]);
			const status = service.status(name);
			if (Array.isArray(status)) throw new Error("expected one index");
			expect(status.name).toBe(name);
			expect(service.search("visibility", { index: name }).sections).toHaveLength(1);
			await expect(service.init(".", "__building__user", "dft")).rejects.toThrow("reserved prefix");
			service.remove(name);
			expect(service.list()).toEqual([]);
		} finally {
			service.close();
		}
	});

	it("migrates legacy duplicated FTS storage without losing searchability", async () => {
		const root = await tempDir("docs-migrate-root-");
		const agent = await tempDir("docs-migrate-agent-");
		await fs.writeFile(path.join(root, "guide.md"), "# Guide\nAlpha migration contract\n");
		const initial = new DocsService({ agentDir: agent, cwd: root, extractor: null });
		await initial.init(".", "legacy", "dft");
		const databasePath = initial.storage.path;
		initial.close();

		const legacy = new Database(databasePath, { strict: true });
		legacy.run("DROP TABLE sections_fts");
		legacy.run(
			"CREATE VIRTUAL TABLE sections_fts USING fts5(section_id UNINDEXED,index_id UNINDEXED,relative_path,heading_path,body)",
		);
		legacy.run("ALTER TABLE sections ADD COLUMN plain_text TEXT NOT NULL DEFAULT ''");
		legacy.run("PRAGMA user_version=2");
		legacy.close();

		const migrated = new DocsService({ agentDir: agent, cwd: root, extractor: null });
		try {
			expect(migrated.search("Alpha", { index: "legacy" }).sections).toHaveLength(1);
			const columns = migrated.storage.db.query("PRAGMA table_info(sections)").all() as Array<{ name: string }>;
			expect(columns.some(column => column.name === "plain_text")).toBe(false);
			expect(migrated.storage.db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
		} finally {
			migrated.close();
		}
	});
});
