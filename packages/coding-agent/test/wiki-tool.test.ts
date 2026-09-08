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

async function indexedFixture(): Promise<{ root: string; agent: string; sectionId: number }> {
	const root = await tempDir("docs-tool-root-");
	const agent = await tempDir("docs-tool-agent-");
	await fs.writeFile(path.join(root, "guide.md"), "# Guide\nCommand: scan\n");
	const service = new DocsService({ agentDir: agent, cwd: root });
	try {
		await service.init(".", "manual");
		const section = service.search("scan", { index: "manual" }).sections[0];
		if (!section) throw new Error("fixture indexing failed");
		return { root, agent, sectionId: section.sectionId };
	} finally {
		service.close();
	}
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(item => item.text ?? "").join("\n");
}

describe("WikiTool", () => {
	it("searches and reads stored sections after the source directory is removed", async () => {
		const fixture = await indexedFixture();
		await fs.rm(fixture.root, { recursive: true });
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const search = await tool.execute("1", { op: "search", query: "scan", index: "manual" });
		expect(text(search)).toContain("guide.md:1-2");
		expect(text(await tool.execute("4", { op: "read", sectionId: fixture.sectionId, index: "manual" }))).toContain(
			"Command: scan",
		);
		expect(text(await tool.execute("6", { op: "status", index: "manual" }))).toContain("[manual] ready");

		await expect(tool.execute("7", { op: "search", index: "manual" })).rejects.toThrow("requires query");
		await expect(tool.execute("10", { op: "read", index: "manual" })).rejects.toThrow("requires sectionId");
	});

	it("requires an index with multiple corpora and prevents cross-index section reads", async () => {
		const fixture = await indexedFixture();
		const tool = new WikiTool(session(fixture.agent, fixture.root));
		const service = new DocsService({ agentDir: fixture.agent, cwd: fixture.root });
		try {
			await service.init(".", "secondary");
		} finally {
			service.close();
		}
		await expect(
			tool.execute("wrong-corpus", {
				op: "read",
				sectionId: fixture.sectionId,
				index: "secondary",
			}),
		).rejects.toThrow("Unknown section");
		await expect(tool.execute("12", { op: "search", query: "scan" })).rejects.toThrow(
			"specify index to keep research corpus-scoped",
		);
	});

	it("reports user-run FTS initialization without creating an index", async () => {
		const root = await tempDir("docs-tool-empty-root-");
		const agent = await tempDir("docs-tool-empty-agent-");
		const tool = new WikiTool(session(agent, root));
		await expect(tool.execute("empty", { op: "status" })).rejects.toThrow("No document indexes");

		const service = new DocsService({ agentDir: agent, cwd: root });
		try {
			expect(service.list()).toEqual([]);
		} finally {
			service.close();
		}
	});
});
