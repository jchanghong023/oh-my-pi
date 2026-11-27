import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEnabledProviders, loadCapability, setEnabledProviders } from "@oh-my-pi/pi-coding-agent/capability";
import { contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

it("discovers default Codex skills before Settings.init without admitting other Codex user capabilities", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-default-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const enabledProviders = getEnabledProviders();
	const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
	resetSettingsForTest();
	setEnabledProviders([]);
	try {
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(
			path.join(home, ".codex", "skills", "visible", "SKILL.md"),
			"---\ndescription: Default Codex skill\n---\n\nVisible skill body\n",
		);
		await Bun.write(
			path.join(home, ".codex", "skills", "manual-only", "SKILL.md"),
			"---\ndescription: Explicit invocation only\ndisable-model-invocation: true\n---\n\nManual skill body\n",
		);
		await Bun.write(
			path.join(home, ".codex", "skills", "hidden", "SKILL.md"),
			"---\ndescription: Hidden Codex skill\nhide: true\n---\n\nHidden skill body\n",
		);
		const options = {
			cwd,
			enableClaudeUser: false,
			enableClaudeProject: false,
			enablePiUser: false,
			enablePiProject: false,
			enableAgentsUser: false,
			enableAgentsProject: false,
		};
		const { skills } = await loadSkills(options);
		expect(skills.find(skill => skill.name === "visible")?.source).toBe("codex:user");
		expect(skills.find(skill => skill.name === "manual-only")).toMatchObject({ source: "codex:user", hide: true });
		expect(skills.find(skill => skill.name === "hidden")).toMatchObject({ source: "codex:user", hide: true });
		const disabled = await loadSkills({ ...options, enableCodexUser: false });
		expect(disabled.skills.some(skill => skill.source === "codex:user")).toBe(false);

		await Bun.write(path.join(home, ".codex", "AGENTS.md"), "User Codex context\n");
		await Bun.write(path.join(home, ".codex", "commands", "user-command.md"), "User Codex command\n");
		await Bun.write(
			path.join(home, ".codex", "config.toml"),
			'[mcp_servers.user-only]\nurl = "https://user.example.test/mcp"\n',
		);
		await Bun.write(
			path.join(cwd, ".codex", "config.toml"),
			'[mcp_servers.project-only]\nurl = "https://project.example.test/mcp"\n',
		);
		const discovery = { cwd, providers: ["codex"] };
		const [context, mcp, commands] = await Promise.all([
			loadCapability(contextFileCapability.id, discovery),
			loadCapability<MCPServer>(mcpCapability.id, discovery),
			loadCapability(slashCommandCapability.id, discovery),
		]);
		expect(context.items).toEqual([]);
		expect(commands.items).toEqual([]);
		expect(mcp.items).toMatchObject([{ name: "project-only", _source: { level: "project" } }]);
	} finally {
		homedirSpy.mockRestore();
		setEnabledProviders(enabledProviders);
		resetSettingsForTest();
		await removeWithRetries(root);
	}
});
