import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { DocsService } from "../src/docs/service";
import type { DocumentExtraction } from "../src/docs/types";
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

function extraction(sectionText: string): DocumentExtraction {
	const quote = sectionText.split("\n").find(line => line.startsWith("Command:")) ?? sectionText.trim();
	const lineStart = sectionText.split("\n").indexOf(quote) + 1;
	const evidence = { quote, lineStart, lineEnd: lineStart, confidence: 1 };
	return {
		entities: [
			{
				localId: "command",
				kind: "command",
				identity: { name: "scan" },
				displayName: "scan",
				aliases: ["s"],
				evidence,
			},
			{ localId: "tool", kind: "tool", identity: { name: "tester" }, displayName: "tester", aliases: [], evidence },
		],
		assertions: [{ subjectLocalId: "command", field: "summary", value: "runs scan", evidence }],
		relations: [{ sourceLocalId: "command", predicate: "uses_tool", targetLocalId: "tool", evidence }],
	};
}

async function indexedFixture(): Promise<{ root: string; agent: string; commandId: number; sectionId: number }> {
	const root = await tempDir("docs-tool-root-");
	const agent = await tempDir("docs-tool-agent-");
	await fs.writeFile(path.join(root, "guide.md"), "# Guide\nCommand: scan\n");
	const service = new DocsService({
		agentDir: agent,
		cwd: root,
		extractor: async ({ section }) => extraction(section.rawMarkdown),
	});
	try {
		await service.init(".", "manual", "dft", { mode: "structured" });
		const command = service.lookup("scan", { index: "manual" })[0];
		const section = service.search("scan", { index: "manual" }).sections[0];
		if (!command || !section) throw new Error("fixture indexing failed");
		return { root, agent, commandId: command.entityId, sectionId: section.sectionId };
	} finally {
		service.close();
	}
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(item => item.text ?? "").join("\n");
}

describe("WikiTool", () => {
	it("serves all six operations and enforces operation-specific required fields", async () => {
		const fixture = await indexedFixture();
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const search = await tool.execute("1", { op: "search", query: "scan", index: "manual" });
		expect(text(search)).toContain("Sections:");
		expect(text(await tool.execute("2", { op: "lookup", key: "s", index: "manual" }))).toContain("aliases=s");
		expect(
			text(await tool.execute("3", { op: "relations", entityId: fixture.commandId, index: "manual" })),
		).toContain("uses_tool");
		expect(text(await tool.execute("4", { op: "read", sectionId: fixture.sectionId, index: "manual" }))).toContain(
			"Command: scan",
		);
		expect(text(await tool.execute("5", { op: "conflicts", index: "manual" }))).toBe("No conflicts.");
		expect(text(await tool.execute("6", { op: "status", index: "manual" }))).toContain("[manual] ready");

		await expect(tool.execute("7", { op: "search", index: "manual" })).rejects.toThrow("requires query");
		await expect(tool.execute("8", { op: "lookup", index: "manual" })).rejects.toThrow("requires key");
		await expect(tool.execute("9", { op: "relations", index: "manual" })).rejects.toThrow("requires entityId");
		await expect(tool.execute("10", { op: "read", index: "manual" })).rejects.toThrow(
			"requires evidenceId or sectionId",
		);
		await expect(
			tool.execute("11", { op: "read", evidenceId: 1, sectionId: fixture.sectionId, index: "manual" }),
		).rejects.toThrow("accepts only one");

		const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root, extractor: null });
		try {
			await service.init(".", "secondary", "dft");
		} finally {
			service.close();
		}
		await expect(tool.execute("12", { op: "search", query: "scan" })).rejects.toThrow(
			"specify index to keep research corpus-scoped",
		);
	});

	it("reports user-run FTS initialization without creating an index", async () => {
		const root = await tempDir("docs-tool-empty-root-");
		const agent = await tempDir("docs-tool-empty-agent-");
		const tool = new WikiTool(session(agent, root));
		await expect(tool.execute("empty", { op: "status" })).rejects.toThrow(
			"No document indexes. Run: omp docs init <dir> --name <name> --mode fts",
		);

		const service = new DocsService({ agentDir: agent, cwd: root });
		try {
			expect(service.list()).toEqual([]);
		} finally {
			service.close();
		}
	});
});
