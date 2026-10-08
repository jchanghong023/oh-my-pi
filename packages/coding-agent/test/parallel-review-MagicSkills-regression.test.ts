import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEnabledProviders, setEnabledProviders } from "@oh-my-pi/pi-coding-agent/capability";
import type { ContextFile } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { SlashCommand } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getCapability } from "@oh-my-pi/pi-coding-agent/discovery";
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
		await Bun.write(path.join(home, ".codex", "AGENTS.md"), "Opt-in instructions\n");
		await Bun.write(path.join(home, ".codex", "config.toml"), '[mcp_servers.private]\ncommand = "private-mcp"\n');
		await Bun.write(path.join(home, ".codex", "commands", "private.md"), "Private command\n");

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

		const ctx = { cwd, home, repoRoot: null };
		const contextProvider = getCapability<ContextFile>(contextFileCapability.id)!.providers.find(
			provider => provider.id === "codex",
		)!;
		const mcpProvider = getCapability<MCPServer>(mcpCapability.id)!.providers.find(
			provider => provider.id === "codex",
		)!;
		const commandProvider = getCapability<SlashCommand>(slashCommandCapability.id)!.providers.find(
			provider => provider.id === "codex",
		)!;
		expect((await contextProvider.load(ctx)).items).toEqual([]);
		expect((await mcpProvider.load(ctx)).items).toEqual([]);
		expect((await commandProvider.load(ctx)).items).toEqual([]);
	} finally {
		homedirSpy.mockRestore();
		setEnabledProviders(enabledProviders);
		resetSettingsForTest();
		await removeWithRetries(root);
	}
});
