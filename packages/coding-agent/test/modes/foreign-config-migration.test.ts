import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	findInheritedConfig,
	keepInheritedConfig,
	pendingForeignConfigMigration,
} from "@oh-my-pi/pi-coding-agent/modes/foreign-config-migration";

let root: string;
let home: string;
let agentDir: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-foreign-config-"));
	home = path.join(root, "home");
	agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function put(relativePath: string, content: string): Promise<void> {
	await Bun.write(path.join(home, relativePath), content);
}

async function find(layers: Record<string, unknown>[], env: Record<string, string> = {}) {
	const tools = await pendingForeignConfigMigration(layers, { home, env, agentDir });
	return findInheritedConfig(tools, agentDir);
}

describe("pendingForeignConfigMigration", () => {
	it("offers nothing to users who never opted in, whatever their home holds", async () => {
		await put(".claude/skills/review/SKILL.md", "---\ndescription: review\n---\n");
		await put(".claude/CLAUDE.md", "be terse");

		expect(await pendingForeignConfigMigration([{}], { home, env: {}, agentDir })).toEqual([]);
	});

	it("does not migrate retained Claude sources when CLAUDE_CONFIG_DIR is explicit", async () => {
		await put("claude-config/commands/review.md", "review");
		await put("claude-config/plugins/installed_plugins.json", '{"plugins":{"retained@market":[]}}');

		const tools = await pendingForeignConfigMigration([{ commands: { enableClaudeUser: true } }], {
			home,
			env: { CLAUDE_CONFIG_DIR: path.join(home, "claude-config") },
			agentDir,
		});
		expect(tools).toEqual([]);
	});

	it("offers once: the marker left by a finished offer silences it", async () => {
		await Bun.write(path.join(agentDir, "foreign-config-reviewed"), "done\n");

		expect(await pendingForeignConfigMigration([{ enabledProviders: ["*"] }], { home, env: {}, agentDir })).toEqual(
			[],
		);
	});
});

describe("findInheritedConfig", () => {
	it("limits a legacy toggle to the capability it admitted", async () => {
		await put(".claude/skills/review/SKILL.md", "---\ndescription: review\n---\n");
		await put(".claude/CLAUDE.md", "be terse");
		await put(".claude/commands/commit.md", "commit");

		const [claude] = await find([{ commands: { enableClaudeUser: true } }]);

		expect(claude.items.map(item => `${item.kind}:${item.name}`)).toEqual(["command:commit"]);
	});

	it("offers only retired formats of opted-in tools and names MCP it cannot copy", async () => {
		await put(".claude/CLAUDE.md", "be terse");
		await put(".claude/skills/review/SKILL.md", "---\ndescription: review\n---\n");
		await put(".claude/commands/git/commit.md", "commit");
		await put(".claude/plugins/installed_plugins.json", '{"plugins":{"retained@market":[]}}');
		await put(".claude.json", '{"mcpServers":{"notion":{"type":"http","url":"https://mcp.example"}}}');
		await put(".codex/skills/lint/SKILL.md", "---\ndescription: lint\n---\n");
		await put(".codex/AGENTS.md", "legacy instructions");
		await put(".codex/config.toml", '[mcp_servers.docs]\ncommand = "docs-mcp"\n');

		const found = await find([{ enabledProviders: ["claude", { path: "/work", providers: ["codex"] }] }]);
		expect(found).toHaveLength(1);
		const [codex] = found;
		expect(codex.items.map(item => `${item.kind}:${item.name}`)).toEqual(["context:AGENTS.md"]);
		expect(codex.notes).toHaveLength(1);
		expect(codex.notes[0]).toContain("docs");
	});
});

describe("keepInheritedConfig", () => {
	it("links files, copies MCP servers, and leaves taken targets alone", async () => {
		await put(".copilot/copilot-instructions.md", "inherited");
		await put(".config/opencode/skills/review/SKILL.md", "---\ndescription: review\n---\n");
		await put(
			".cursor/mcp.json",
			JSON.stringify({ mcpServers: { notion: { type: "http", url: "https://mcp.example" } } }),
		);
		await Bun.write(path.join(agentDir, "AGENTS.md"), "mine");
		const mcpConfigPath = path.join(agentDir, "mcp.json");
		const items = (await find([{ enabledProviders: ["github", "opencode", "cursor"] }])).flatMap(tool => tool.items);

		const result = await keepInheritedConfig(items, "symlink", mcpConfigPath);

		expect(result.kept).toBe(2);
		expect(result.skipped).toHaveLength(1);
		expect(await Bun.file(path.join(agentDir, "AGENTS.md")).text()).toBe("mine");
		const skill = path.join(agentDir, "skills", "review");
		expect((await fs.lstat(skill)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(skill)).toBe(await fs.realpath(path.join(home, ".config", "opencode", "skills", "review")));
		expect((await Bun.file(mcpConfigPath).json()).mcpServers.notion.url).toBe("https://mcp.example");

		const again = await keepInheritedConfig(items, "symlink", mcpConfigPath);
		expect(again.kept).toBe(0);
		expect(again.skipped).toHaveLength(3);
	});

	it("copies files so they survive the source going away", async () => {
		await put(".codex/prompts/fix.md", "fix it");
		const [codex] = await find([{ enabledProviders: ["codex"] }]);

		await keepInheritedConfig(codex.items, "copy", path.join(agentDir, "mcp.json"));
		await fs.rm(path.join(home, ".codex"), { recursive: true });

		const kept = path.join(agentDir, "prompts", "fix.md");
		expect((await fs.lstat(kept)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(kept).text()).toBe("fix it");
	});
});
