import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type Hook, hookCapability } from "../capability/hook";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import type { LoadContext, LoadResult } from "../capability/types";
import { getDeveloperTestAgentRoot } from "../extensibility/plugins/developer-test-agent-resources";
import { createSourceMeta, loadFilesFromDir, scanSkillsFromDir } from "./helpers";

const PROVIDER_ID = "developer-test-agent";
const provider = {
	id: PROVIDER_ID,
	displayName: "Developer Test Agent",
	description: "Bundled unit-test agent skills, commands and routing hint",
	priority: 1,
};

export async function loadDeveloperTestSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const root = await getDeveloperTestAgentRoot(ctx.agentDir);
	const result = await scanSkillsFromDir(ctx, {
		dir: path.join(root, "skills"),
		providerId: PROVIDER_ID,
		level: "project",
		origin: "bundled-developer-test-agent",
		pluginName: PROVIDER_ID,
	});
	return { ...result, items: result.items.map(skill => ({ ...skill, containRoot: root })) };
}

export async function loadDeveloperTestCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const root = await getDeveloperTestAgentRoot(ctx.agentDir);
	return loadFilesFromDir<SlashCommand>(ctx, path.join(root, "commands"), PROVIDER_ID, "project", {
		extensions: ["md"],
		origin: "bundled-developer-test-agent",
		transform: (name, content, filePath, source) => ({
			name: name.replace(/\.md$/, ""),
			path: filePath,
			// Defer raw user input until the native file-command invocation render.
			content: prompt.render(content, {
				pluginRoot: root.replaceAll("\\", "/"),
				rawArguments: "{{{rawArguments}}}",
			}),
			level: "project",
			_source: source,
		}),
	});
}

async function loadDeveloperTestHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const root = await getDeveloperTestAgentRoot(ctx.agentDir);
	const filePath = path.join(root, "scripts", "user-prompt-hint.ts");
	return {
		items: [
			{
				name: "developer-test-agent-hint",
				path: filePath,
				type: "pre",
				tool: "*",
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, filePath, "project", "bundled-developer-test-agent"),
			},
		],
	};
}

registerProvider<Skill>(skillCapability.id, { ...provider, load: loadDeveloperTestSkills });
registerProvider<SlashCommand>(slashCommandCapability.id, { ...provider, load: loadDeveloperTestCommands });
registerProvider<Hook>(hookCapability.id, { ...provider, load: loadDeveloperTestHooks });
