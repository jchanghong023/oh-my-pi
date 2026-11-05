import { describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { KnowledgeService } from "../../src/knowledge/service";
import type { ToolSession } from "../../src/tools";
import { KnowledgeSearchTool } from "../../src/tools/knowledge-search";
import { OpenWikiReadTool, OpenWikiSearchTool } from "../../src/tools/openwiki";
import { GrepTool } from "../../src/tools/grep";
import { createMixedWorkspace } from "../helpers/mixed-session-workspace";

function text(result: { content: Array<{ type: string; text?: string }> }) {
	return result.content.map(item => item.text ?? "").join("\n");
}

describe("OpenWiki independent index consumer boundary", () => {
	// Unlike merely seeding a mixed session, invoke every real query consumer.
	it("keeps document indexes and code search unchanged while searching linked Wiki pages", async () => {
		using dir = TempDir.createSync("@omp-openwiki-index-isolation-");
		const root = dir.join("repo");
		const agent = dir.join("agent");
		await Promise.all([mkdir(root), mkdir(agent)]);
		await writeFile(path.join(agent, "config.yml"), "mnemopi:\n  noEmbeddings: true\n");
		await using workspace = createMixedWorkspace();
		await workspace.setup(root, agent);
		const settings = Settings.isolated({ "mnemopi.noEmbeddings": true });
		settings.getAgentDir = () => agent;
		const session: ToolSession = {
			cwd: root,
			settings,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		const knowledge = new KnowledgeSearchTool(session);
		const service = new KnowledgeService({ cwd: root, agentDir: agent });
		try {
			const grep = new GrepTool(session);
			const wiki = new OpenWikiSearchTool(session);
			const registry = path.join(agent, "openwiki", "wiki-workspaces.json");
			const beforeRegistry = await readFile(registry, "utf8");
			const beforeIndexes = await service.list();
			const beforeCode = await grep.execute("code-before", { pattern: "MIXED_REPO_EVIDENCE", path: "src" });
			expect(text(beforeCode)).toContain("MIXED_REPO_EVIDENCE");
			const beforeDocuments = await knowledge.execute("docs-before", { query: "MIXED_KNOWLEDGE_EVIDENCE" });
			expect(text(beforeDocuments)).toContain("MIXED_KNOWLEDGE_EVIDENCE");
			const wikiResult = JSON.parse(text(await wiki.execute("wiki", { query: "MIXED_WIKI_EVIDENCE" }))) as {
				results: Array<{ wiki?: string; ref: string[]; content: string }>;
			};
			expect(wikiResult.results).toHaveLength(2);
			for (const hit of wikiResult.results) {
				expect(hit.ref).toContain("openwiki/architecture/service.md#operation");
				const exact = JSON.parse(
					text(
						await new OpenWikiReadTool(session).execute("wiki-read", {
							wiki: hit.wiki,
							page: "openwiki/architecture/service.md",
							sections: ["operation"],
						}),
					),
				) as { sections: Array<{ content: string }> };
				expect(exact.sections[0].content).toContain("MIXED_WIKI_EVIDENCE");
			}
			expect(new Set(wikiResult.results.map(result => result.wiki)).size).toBe(2);
			const afterCode = await grep.execute("code-after", { pattern: "MIXED_REPO_EVIDENCE", path: "src" });
			expect(text(afterCode)).toBe(text(beforeCode));
			expect(text(await knowledge.execute("docs-after", { query: "MIXED_KNOWLEDGE_EVIDENCE" }))).toBe(
				text(beforeDocuments),
			);
			expect(await service.list()).toEqual(beforeIndexes);
			expect(await readFile(registry, "utf8")).toBe(beforeRegistry);
			const documentsDoNotBecomeWiki = JSON.parse(text(await wiki.execute("not-docs", { query: "indexed" })));
			expect(documentsDoNotBecomeWiki.results).toEqual([]);
		} finally {
			await knowledge.dispose();
			await service.close();
		}
	}, 30_000);
});
