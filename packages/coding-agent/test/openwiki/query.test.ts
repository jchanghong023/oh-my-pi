import { describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	OpenWikiListWikisTool,
	OpenWikiListWorkspacesTool,
	OpenWikiReadTool,
	OpenWikiSearchTool,
} from "@oh-my-pi/pi-coding-agent/tools/openwiki";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { TempDir } from "@oh-my-pi/pi-utils";
import { saveWikiWorkspaces } from "#openwiki-vendor";

// Only the fields asserted by these consumer tests are needed here.
type WikiWorkspaceRequired = { status: "workspace_required"; workspaces: Array<{ id: string }> };
type WikiWorkspaceList = { workspaces: Array<{ id: string }> };
type WorkspaceWikiList = { wikis: Array<{ id: string }> };
type WikiSearchResults = { results: Array<{ kind: "section"; wiki?: string; ref: string[]; content: string }> };
type WikiReadResponse = { sections: Array<{ content: string }> };

async function repository(root: string, token: string) {
	await mkdir(root, { recursive: true });
	const git = Bun.spawn(["git", "init", "--quiet"], {
		cwd: root,
		stdout: "ignore",
		stderr: "pipe",
		env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
	});
	const [code, error] = await Promise.all([git.exited, new Response(git.stderr).text()]);
	if (code !== 0) throw new Error(`git init: ${error}`);
	await mkdir(path.join(root, "openwiki", "architecture"), { recursive: true });
	await writeFile(path.join(root, "openwiki", ".last-update.json"), "{}\n");
	await writeFile(path.join(root, "openwiki", "quickstart.md"), "# Quickstart\n");
	await writeFile(
		path.join(root, "openwiki", "architecture", "service.md"),
		`---\ntype: guide\ntitle: Service\ndescription: Service operation guide\nsources:\n  - id: source\n    resource: repo://src/service.ts\n---\n\n# Service\n\n## Operation\n\n${token} is required for service operation.\n`,
	);
}

function session(cwd: string, agentDir: string): ToolSession {
	const settings = Settings.isolated({});
	settings.getAgentDir = () => agentDir;
	return { cwd, settings, hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*" };
}

function json<T>(result: { content: Array<{ type: string; text?: string }> }): T {
	const text = result.content.find(item => item.type === "text")?.text;
	if (!text) throw new Error("Missing tool result text");
	return JSON.parse(text) as T;
}

describe("OMP OpenWiki read-only tools", () => {
	it("searches linked wikis, reads exact sections and isolates profiles without writing registry or pages", async () => {
		using dir = TempDir.createSync("@omp-openwiki-query-");
		const shared = dir.join("shared"),
			payments = dir.join("payments"),
			platform = dir.join("platform");
		await Promise.all([
			repository(shared, "SHARED_ONLY"),
			repository(payments, "PAYMENTS_BEACON"),
			repository(platform, "PLATFORM_BEACON"),
		]);
		const agentA = dir.join("profile-a", "agent"),
			agentB = dir.join("profile-b", "agent");
		const configA = path.join(agentA, "openwiki");
		await saveWikiWorkspaces(
			[
				{ name: "Payments", roots: [shared, payments] },
				{ name: "Platform", roots: [shared, platform] },
			],
			{ configDirectory: configA },
		);
		const registry = path.join(configA, "wiki-workspaces.json");
		const page = path.join(payments, "openwiki", "architecture", "service.md");
		const [beforeRegistry, beforePage] = await Promise.all([readFile(registry), readFile(page)]);
		const a = session(shared, agentA),
			b = session(shared, agentB);
		const search = new OpenWikiSearchTool(a),
			read = new OpenWikiReadTool(a);
		const ambiguous = json<WikiWorkspaceRequired>(await search.execute("ambiguous", { query: "PAYMENTS_BEACON" }));
		expect(ambiguous.status).toBe("workspace_required");
		expect(ambiguous.workspaces.map(w => w.id).sort()).toEqual(["payments", "platform"]);
		const workspaces = json<WikiWorkspaceList>(await new OpenWikiListWorkspacesTool(a).execute("workspaces", {}));
		expect(workspaces.workspaces).toHaveLength(2);
		const wikis = json<WorkspaceWikiList>(
			await new OpenWikiListWikisTool(a).execute("wikis", { workspace: "payments" }),
		);
		expect(wikis.wikis.map(wiki => wiki.id).sort()).toEqual(["payments", "shared"]);
		const found = json<WikiSearchResults>(
			await search.execute("search", { query: "PAYMENTS_BEACON", workspace: "payments" }),
		);
		const hit = found.results.find(result => result.wiki === "payments");
		expect(hit).toBeDefined();
		const [pagePath, section] = hit!.ref[0].split("#");
		const exact = json<WikiReadResponse>(
			await read.execute("read", { wiki: "payments", page: pagePath, sections: [section] }),
		);
		expect(exact.sections[0].content).toContain("PAYMENTS_BEACON is required");
		const noHits = json<WikiSearchResults>(
			await search.execute("no-hits", { query: "neverfoundtoken987654", workspace: "payments" }),
		);
		expect(noHits.results).toEqual([]);
		const otherProfile = json<WikiWorkspaceList>(
			await new OpenWikiListWorkspacesTool(b).execute("other-profile", {}),
		);
		expect(otherProfile.workspaces).toEqual([]);
		const otherSearch = json<WikiSearchResults>(
			await new OpenWikiSearchTool(b).execute("other-search", { query: "PAYMENTS_BEACON" }),
		);
		expect(otherSearch.results).toEqual([]);
		expect(await readFile(registry)).toEqual(beforeRegistry);
		expect(await readFile(page)).toEqual(beforePage);
		await rm(payments, { recursive: true });
		await expect(
			read.execute("missing", { wiki: "payments", page: pagePath, sections: [section] }),
		).rejects.toThrow();
		expect(await readFile(registry)).toEqual(beforeRegistry);
	}, 30_000);

	it("finds adjacent Chinese words, ranks exact spelling and preserves path precedence", async () => {
		using dir = TempDir.createSync("@omp-openwiki-chinese-");
		const root = dir.join("repo");
		await repository(root, "UNRELATED_BEACON");
		const wiki = path.join(root, "openwiki", "architecture");
		const page = (source: string, text: string) =>
			`---\ntype: guide\ntitle: Guide\nsources:\n  - id: source\n    resource: repo://src/${source}.ts\n---\n\n# Guide\n\n## Details\n\n${text}\n`;
		await Promise.all([
			writeFile(path.join(wiki, "exact.md"), page("exact", "这里介绍背景信息。\n\n系统支持配置加载流程。")),
			writeFile(path.join(wiki, "punctuated.md"), page("punctuated", "启用配，置流程。")),
			writeFile(path.join(wiki, "separated.md"), page("separated", "处理配方后放置器件。")),
			writeFile(
				path.join(wiki, "reversed.md"),
				page("reversed", "示例内容。").replace("title: Guide", "title: 置配"),
			),
		]);
		const search = new OpenWikiSearchTool(session(root, dir.join("agent")));
		const exact = "openwiki/architecture/exact.md#details";
		const punctuated = "openwiki/architecture/punctuated.md#details";
		const unrelated = "openwiki/architecture/separated.md#details";
		const found = json<WikiSearchResults>(await search.execute("chinese", { query: "配置" }));
		expect(found.results.map(result => result.ref[0])).toEqual([exact, punctuated]);
		expect(found.results[0].content).toContain("系统支持配置加载流程");
		const sentence = json<WikiSearchResults>(await search.execute("sentence", { query: "如何配置加载流程" }));
		expect(sentence.results[0].ref).toContain(exact);
		const hinted = json<WikiSearchResults>(
			await search.execute("hinted", { query: "配置", paths: ["src/punctuated.ts"] }),
		);
		expect(hinted.results[0].ref).toContain(punctuated);
		const single = json<WikiSearchResults>(await search.execute("single", { query: "配" }));
		expect(single.results.some(result => result.ref.includes(exact))).toBe(true);
		expect(single.results.some(result => result.ref.includes(unrelated))).toBe(true);
		const missing = json<WikiSearchResults>(await search.execute("missing", { query: "龘靐齉" }));
		expect(missing.results).toEqual([]);
	}, 30_000);

	it("searches and reads mixed Chinese and identifiers across linked wikis", async () => {
		using dir = TempDir.createSync("@omp-openwiki-chinese-workspace-");
		const current = dir.join("current"),
			service = dir.join("service"),
			agent = dir.join("agent");
		await Promise.all([repository(current, "UNRELATED"), repository(service, "UNRELATED")]);
		await writeFile(
			path.join(current, "openwiki", "architecture", "service.md"),
			"---\ntype: guide\ntitle: CachePolicy\n---\n\n# CachePolicy\n\n## Operation\n\nCachePolicy CachePolicy CachePolicy.\n",
		);
		await writeFile(
			path.join(service, "openwiki", "architecture", "service.md"),
			"---\ntype: guide\ntitle: Service\n---\n\n# Service\n\n## Operation\n\nCachePolicy 的配置加载流程。\n",
		);
		await saveWikiWorkspaces([{ name: "Shared", roots: [current, service] }], {
			configDirectory: path.join(agent, "openwiki"),
		});
		const search = new OpenWikiSearchTool(session(current, agent));
		const found = json<WikiSearchResults>(await search.execute("mixed", { query: "CachePolicy 配置" }));
		expect(found.results[0].wiki).toBe("service");
		expect(found.results[0].ref).toContain("openwiki/architecture/service.md#operation");
		const read = new OpenWikiReadTool(session(current, agent));
		const result = json<WikiReadResponse>(
			await read.execute("read", {
				wiki: "service",
				page: "openwiki/architecture/service.md",
				sections: ["operation"],
			}),
		);
		expect(result.sections[0].content).toContain("CachePolicy 的配置加载流程。");
	}, 30_000);

	it("reports corrupt workspace state rather than replacing it during a read", async () => {
		using dir = TempDir.createSync("@omp-openwiki-corrupt-");
		const root = dir.join("repo"),
			agent = dir.join("agent");
		await repository(root, "CORRUPT_BEACON");
		await mkdir(path.join(agent, "openwiki"), { recursive: true });
		const registry = path.join(agent, "openwiki", "wiki-workspaces.json");
		const invalid = "{ invalid registry";
		await writeFile(registry, invalid);
		await expect(new OpenWikiListWorkspacesTool(session(root, agent)).execute("list", {})).rejects.toThrow();
		expect(await readFile(registry, "utf8")).toBe(invalid);
	}, 30_000);

	it("explains how to generate a missing local wiki", async () => {
		using dir = TempDir.createSync("@omp-openwiki-missing-");
		await repository(dir.join("repo"), "MISSING_BEACON");
		await rm(dir.join("repo", "openwiki"), { recursive: true });
		const context = session(dir.join("repo"), dir.join("agent"));
		await expect(new OpenWikiSearchTool(context).execute("search", { query: "test" })).rejects.toThrow(
			/invalid_state:.*omp openwiki --init/,
		);
		await expect(
			new OpenWikiReadTool(context).execute("read", { page: "example.md", sections: ["intro"] }),
		).rejects.toThrow(/invalid_state:.*omp openwiki --init/);
	}, 30_000);

	it("dispatches a mounted query under read approval, not file-write approval", async () => {
		using dir = TempDir.createSync("@omp-openwiki-xdev-");
		await repository(dir.join("repo"), "XDEV_BEACON");
		const context = session(dir.join("repo"), dir.join("agent"));
		const devices = [
			new OpenWikiSearchTool(context),
			new OpenWikiReadTool(context),
			new OpenWikiListWorkspacesTool(context),
			new OpenWikiListWikisTool(context),
		] as unknown as Tool[];
		const names = devices.map(device => device.name);
		const xdev: XdevState = {
			tools: new Map(devices.map(device => [device.name, device])),
			mountedNames: new Set(names),
			builtInNames: new Set(names),
			isActive: () => false,
			resolve: name => resolveXdevTool(xdev, name),
		};
		const write = new WriteTool({ ...context, xdev });
		for (const name of names) {
			const request = { path: `xd://${name}`, content: "{}" };
			expect(write.approval(request)).toEqual({ tier: "read", policyKey: name, fallbackToToolPolicy: false });
			expect(write.concurrency(request)).toBe("shared");
		}
		const args = { path: "xd://openwiki_search", content: JSON.stringify({ query: "XDEV_BEACON" }) };
		expect(write.approval(args)).toEqual({ tier: "read", policyKey: "openwiki_search", fallbackToToolPolicy: false });
		expect(write.concurrency(args)).toBe("shared");
		const result = await write.execute("mounted-search", args);
		expect(result.isError).not.toBe(true);
		expect(result.details?.xdev).toMatchObject({ tool: "openwiki_search", mode: "execute", tier: "read" });
		const found = json<WikiSearchResults>(result);
		const expectedRef = "openwiki/architecture/service.md#operation";
		const hit = found.results.find(entry => entry.ref.includes(expectedRef));
		expect(hit).toBeDefined();
		expect(hit!.kind).toBe("section");
		const [page, section] = hit!.ref.find(ref => ref === expectedRef)!.split("#");
		const readResult = await write.execute("mounted-read", {
			path: "xd://openwiki_read",
			content: JSON.stringify({ page, sections: [section] }),
		});
		expect(readResult.isError).not.toBe(true);
		expect(json<WikiReadResponse>(readResult).sections[0].content).toContain("XDEV_BEACON is required");
		const noHits = await write.execute("mounted-no-hits", {
			path: "xd://openwiki_search",
			content: JSON.stringify({ query: "neverfoundtoken987654" }),
		});
		expect(noHits.isError).not.toBe(true);
		expect(json<WikiSearchResults>(noHits).results).toEqual([]);
		const restricted = new WriteTool({ ...context, xdev: { ...xdev, isAllowed: () => false } });
		expect(restricted.approval(args)).toBe("exec");
	}, 30_000);
});
