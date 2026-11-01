import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { saveWikiWorkspaces } from "#openwiki-vendor";
import { KnowledgeService } from "../../src/knowledge/service";
import { RepoService } from "../../src/repo/service";

export interface MixedWorkspace {
	readonly configuration: Record<string, unknown>;
	readonly searchQueries: string[];
	setup(cwd: string, agentDir: string): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

/** Start the external search fixture; all repository and knowledge operations remain real. */
export function createMixedWorkspace(): MixedWorkspace {
	const searchQueries: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== "/search" || url.searchParams.get("format") !== "json") {
				return new Response("Not found", { status: 404 });
			}
			const query = url.searchParams.get("q") ?? "";
			searchQueries.push(query);
			return Response.json({
				query,
				number_of_results: 1,
				results: [
					{
						title: "Mixed session search evidence",
						url: "https://example.test/mixed-session-evidence",
						content: "MIXED_WEB_EVIDENCE is the local search fixture result.",
						engine: "mixed-fixture",
					},
				],
			});
		},
	});

	return {
		configuration: {
			searxng: { endpoint: `http://127.0.0.1:${server.port}` },
			modelRoles: { web: "web/searxng" },
			retry: { fallbackChains: { web: [] } },
			mnemopi: { noEmbeddings: true },
		},
		searchQueries,
		async setup(cwd, agentDir) {
			// An empty Git fixture lets the real OpenWiki resolver find the cwd root.
			// The second wiki is a native clone for the workspace registry.
			await Promise.all([
				fs.mkdir(path.join(cwd, ".git", "objects"), { recursive: true }),
				fs.mkdir(path.join(cwd, ".git", "refs", "heads"), { recursive: true }),
			]);
			await Promise.all([
				Bun.write(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n"),
				Bun.write(path.join(cwd, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"),
			]);
			const peer = path.join(cwd, ".mixed-wiki-peer");
			await vcs.clone(cwd, peer);
			await Promise.all([
				fs.mkdir(path.join(cwd, "src"), { recursive: true }),
				fs.mkdir(path.join(cwd, "docs"), { recursive: true }),
				fs.mkdir(path.join(cwd, "openwiki", "architecture"), { recursive: true }),
				fs.mkdir(path.join(peer, "openwiki", "architecture"), { recursive: true }),
			]);
			await Promise.all([
				fs.writeFile(
					path.join(cwd, "src", "engine.py"),
					"def mixed_repo_evidence():\n    return 'MIXED_REPO_EVIDENCE'\n",
				),
				fs.writeFile(path.join(cwd, "src", "alpha.ts"), "export const alpha = 1;\n"),
				fs.writeFile(path.join(cwd, "src", "beta.ts"), "export const beta = 2;\n"),
				fs.writeFile(path.join(cwd, "src", "ast.ts"), "export const total = 1 + 2;\n"),
				fs.writeFile(
					path.join(cwd, "docs", "evidence.md"),
					"# Mixed knowledge evidence\n\nMIXED_KNOWLEDGE_EVIDENCE identifies the indexed documentation.\n",
				),
				fs.writeFile(path.join(cwd, "openwiki", ".last-update.json"), "{}\n"),
				fs.writeFile(path.join(cwd, "openwiki", "quickstart.md"), "# Quickstart\n"),
				fs.writeFile(
					path.join(cwd, "openwiki", "architecture", "service.md"),
					"---\ntype: guide\ntitle: Service\ndescription: Service operation guide\nsources:\n  - id: source\n    resource: repo://src/engine.py\n---\n\n# Service\n\n## Operation\n\nMIXED_WIKI_EVIDENCE is required for service operation.\n",
				),
				fs.writeFile(path.join(peer, "openwiki", ".last-update.json"), "{}\n"),
				fs.writeFile(path.join(peer, "openwiki", "quickstart.md"), "# Peer quickstart\n"),
				fs.writeFile(
					path.join(peer, "openwiki", "architecture", "service.md"),
					"---\ntype: guide\ntitle: Peer Service\ndescription: Peer service operation guide\n---\n\n# Peer Service\n\n## Operation\n\nMIXED_WIKI_EVIDENCE is shared with the peer service.\n",
				),
				fs.writeFile(
					path.join(cwd, "long-context.txt"),
					Array.from(
						{ length: 1000 },
						(_, index) =>
							`MIXED_LONG_LINE_${String(index + 1).padStart(4, "0")} records durable session evidence for context and compaction.\n`,
					).join(""),
				),
			]);
			await saveWikiWorkspaces([{ id: "mixed", name: "Mixed", roots: [cwd, peer] }], {
				configDirectory: path.join(agentDir, "openwiki"),
			});
			const repo = new RepoService({ cwd, agentDir });
			try {
				await repo.build();
			} finally {
				repo.close();
			}
			const knowledge = new KnowledgeService({ cwd, agentDir });
			try {
				await knowledge.init("docs", "mixed");
			} finally {
				await knowledge.close();
			}
		},
		async [Symbol.asyncDispose]() {
			await server.stop(true);
		},
	};
}
