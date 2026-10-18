import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function text(result: AgentToolResult): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Real registered tools and real filesystem bytes; no module mocks or policy-only assertions. */
describe("Team filesystem read isolation", () => {
	let temp: TempDir;
	let cwd: string;
	let own: string;
	let peer: string;
	let roots: string[];
	let session: ToolSession;
	let tools: Tool[];

	beforeEach(async () => {
		temp = TempDir.createSync("@omp-team-read-isolation-");
		expect(path.isAbsolute(temp.path())).toBe(true);
		cwd = path.join(temp.path(), "project");
		const artifacts = path.join(temp.path(), "discussion");
		own = path.join(artifacts, "team-proposal-A");
		peer = path.join(artifacts, "team-proposal-B");
		roots = [artifacts];
		await Promise.all([
			fs.mkdir(path.join(cwd, "src"), { recursive: true }),
			fs.mkdir(path.join(own, "local"), { recursive: true }),
			fs.mkdir(path.join(peer, "local"), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(path.join(cwd, "src", "module.ts"), "export const marker = 'PROJECT_SOURCE';\n"),
			fs.writeFile(`${own}.md`, "OWN_DRAFT\n"),
			fs.writeFile(`${own}.json`, JSON.stringify({ marker: "OWN_JSON" })),
			fs.writeFile(`${own}.jsonl`, JSON.stringify({ marker: "OWN_TRANSCRIPT" })),
			fs.writeFile(path.join(own, "local", "notes.md"), "OWN_NOTES\n"),
			fs.writeFile(`${peer}.md`, "PEER_SECRET_DRAFT\n"),
			fs.writeFile(`${peer}.json`, JSON.stringify({ marker: "PEER_SECRET_JSON" })),
			fs.writeFile(`${peer}.jsonl`, JSON.stringify({ marker: "PEER_SECRET_TRANSCRIPT" })),
			fs.writeFile(path.join(peer, "local", "notes.md"), "PEER_SECRET_NOTES\n"),
			fs.writeFile(path.join(peer, "local", "peer-only.ts"), "export const marker = 'PEER_SECRET_SOURCE';\n"),
		]);
		session = {
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "astGrep.enabled": true }),
			skipPythonPreflight: true,
			restrictToolNames: true,
			getSessionFile: () => `${own}.jsonl`,
			getSessionSpawns: () => "*",
			localProtocolOptions: {
				getArtifactsDir: () => own,
				getSessionId: () => path.basename(own),
				allowCrossAgentReads: false,
				getReadIsolationRoots: () => roots,
			},
		};
		tools = await createTools(session, ["read", "grep", "glob", "ast_grep"]);
	});

	afterEach(() => temp.removeSync());

	async function invoke(name: string, params: Record<string, unknown>): Promise<AgentToolResult> {
		const tool = tools.find(entry => entry.name === name);
		if (!tool) throw new Error(`Missing real tool ${name}`);
		return tool.execute(`isolation-${name}`, params);
	}

	it("discovers its local root but cannot climb to sibling drafts, JSON, or transcripts", async () => {
		const listing = text(await invoke("read", { path: "local://" }));
		expect(listing).toContain("notes.md");
		const localRoot = await InternalUrlRouter.instance().locate("local://", sessionResolveContext(session));
		expect(localRoot).toBeTruthy();
		for (const extension of ["md", "json", "jsonl"]) {
			const traversal = path.join(localRoot!, "..", "..", `${path.basename(peer)}.${extension}`);
			await expect(invoke("read", { path: traversal })).rejects.toThrow("Team read isolation");
			await expect(invoke("read", { path: `${peer}.${extension}:1-2` })).rejects.toThrow("Team read isolation");
			await expect(invoke("read", { path: pathToFileURL(`${peer}.${extension}`).href })).rejects.toThrow(
				"Team read isolation",
			);
			await expect(invoke("grep", { pattern: "PEER_SECRET", path: `${peer}.${extension}` })).rejects.toThrow(
				"Team read isolation",
			);
			await expect(invoke("glob", { path: `${peer}.${extension}` })).rejects.toThrow("Team read isolation");
			await expect(invoke("ast_grep", { pat: "$VALUE", path: `${peer}.${extension}` })).rejects.toThrow(
				"Team read isolation",
			);
		}
		await expect(invoke("read", { path: `${peer}.json?q=.marker` })).rejects.toThrow("Team read isolation");
		const mixed = text(await invoke("read", { path: `${own}.md;${peer}.md` }));
		expect(mixed).toContain("OWN_DRAFT");
		expect(mixed).toContain("Team read isolation");
		expect(mixed).not.toContain("PEER_SECRET");
	});

	it("refuses ancestor recursive searches rather than returning any peer bytes or filenames", async () => {
		for (const ancestor of [path.dirname(own), temp.path()]) {
			await expect(invoke("read", { path: ancestor })).rejects.toThrow("Team read isolation");
			await expect(invoke("grep", { pattern: "PEER_SECRET", path: ancestor, gitignore: false })).rejects.toThrow(
				"Team read isolation",
			);
			await expect(invoke("glob", { path: `${ancestor}/**/*`, hidden: true, gitignore: false })).rejects.toThrow(
				"Team read isolation",
			);
			await expect(invoke("ast_grep", { pat: "$VALUE", path: ancestor })).rejects.toThrow("Team read isolation");
		}
	});

	it("keeps own materials and ordinary project source readable and searchable", async () => {
		expect(text(await invoke("read", { path: `${own}.md` }))).toContain("OWN_DRAFT");
		expect(text(await invoke("read", { path: `${own}.json?q=.marker` }))).toContain("OWN_JSON");
		expect(text(await invoke("read", { path: `${own}.jsonl:1` }))).toContain("OWN_TRANSCRIPT");
		expect(text(await invoke("read", { path: "local://notes.md" }))).toContain("OWN_NOTES");
		expect(text(await invoke("read", { path: "src/module.ts" }))).toContain("PROJECT_SOURCE");
		expect(text(await invoke("grep", { pattern: "PROJECT_SOURCE", path: "src" }))).toContain("PROJECT_SOURCE");
		expect(text(await invoke("glob", { path: "src/**/*.ts" }))).toContain("module.ts");
		expect(text(await invoke("grep", { pattern: "OWN_NOTES", path: "local://" }))).toContain("OWN_NOTES");
		expect(text(await invoke("glob", { path: "local://*.md" }))).toContain("notes.md");
		expect(text(await invoke("ast_grep", { pat: "marker", path: "src/module.ts" }))).toContain("marker");
	});

	it("canonicalizes explicit symlink roots and located URIs without following nested search links", async () => {
		// Junctions are available on Windows without Developer Mode; directory
		// symlinks exercise the same canonical-path escape on POSIX.
		const link = path.join(cwd, "src", "peer-link");
		await fs.symlink(path.dirname(peer), link, process.platform === "win32" ? "junction" : "dir");
		await expect(invoke("read", { path: path.join(link, `${path.basename(peer)}.md`) })).rejects.toThrow(
			"Team read isolation",
		);
		await expect(invoke("grep", { pattern: "PEER_SECRET", path: link })).rejects.toThrow("Team read isolation");
		await expect(invoke("glob", { path: `${link}/**/*` })).rejects.toThrow("Team read isolation");
		await expect(invoke("ast_grep", { pat: "$VALUE", path: link })).rejects.toThrow("Team read isolation");
		await fs.symlink(
			path.dirname(peer),
			path.join(own, "local", "peer-link"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(invoke("read", { path: `local://peer-link/${path.basename(peer)}.md` })).rejects.toThrow();
		await expect(invoke("grep", { pattern: "PEER_SECRET", path: "local://peer-link" })).rejects.toThrow();
		await expect(invoke("glob", { path: "local://peer-link/**/*" })).rejects.toThrow();
		const search = text(
			await invoke("grep", { pattern: "PROJECT_SOURCE|PEER_SECRET", path: "src", gitignore: false }),
		);
		expect(search).toContain("PROJECT_SOURCE");
		expect(search).not.toContain("PEER_SECRET");
		const listing = text(await invoke("glob", { path: "src/**/*", gitignore: false }));
		expect(listing).toContain("module.ts");
		expect(listing).not.toContain(path.basename(peer));
		const ast = text(await invoke("ast_grep", { pat: "marker", path: "src" }));
		expect(ast).toContain("module.ts");
		expect(ast).not.toContain(path.basename(peer));
	});

	it("checks the actual suffix-resolved text, JSON, and SQLite target", async () => {
		const projectArtifacts = path.join(cwd, "session");
		await fs.mkdir(projectArtifacts, { recursive: true });
		roots.push(projectArtifacts);
		await fs.writeFile(path.join(projectArtifacts, "hidden-draft.md"), "PEER_SECRET_SUFFIX\n");
		await fs.writeFile(
			path.join(projectArtifacts, "hidden-json.json"),
			JSON.stringify({ marker: "PEER_SECRET_JSON" }),
		);
		const database = new Database(path.join(projectArtifacts, "hidden-data.db"));
		try {
			database.exec("CREATE TABLE secrets (value TEXT); INSERT INTO secrets VALUES ('PEER_SECRET_SQLITE')");
		} finally {
			database.close();
		}
		await expect(invoke("read", { path: "hidden-draft.md" })).rejects.toThrow("Team read isolation");
		await expect(invoke("read", { path: "hidden-json.json?q=.marker" })).rejects.toThrow("Team read isolation");
		await expect(invoke("read", { path: "hidden-data.db:secrets" })).rejects.toThrow("Team read isolation");
	});

	it("uses the live root list for peer calls in separate temporary leases", async () => {
		const otherLease = path.join(temp.path(), "another-temporary-lease");
		await fs.mkdir(otherLease, { recursive: true });
		roots.push(otherLease);
		await fs.writeFile(path.join(otherLease, "temporary-peer.md"), "PEER_SECRET_TEMP\n");
		await fs.writeFile(path.join(otherLease, "temporary-peer.json"), JSON.stringify({ secret: "PEER_SECRET_TEMP" }));
		await fs.writeFile(path.join(otherLease, "temporary-peer.jsonl"), JSON.stringify({ secret: "PEER_SECRET_TEMP" }));
		for (const extension of ["md", "json", "jsonl"]) {
			await expect(invoke("read", { path: path.join(otherLease, `temporary-peer.${extension}`) })).rejects.toThrow(
				"Team read isolation",
			);
		}
		await expect(invoke("grep", { pattern: "PEER_SECRET_TEMP", path: otherLease })).rejects.toThrow(
			"Team read isolation",
		);
		await expect(invoke("glob", { path: `${otherLease}/**/*` })).rejects.toThrow("Team read isolation");
	});
});
