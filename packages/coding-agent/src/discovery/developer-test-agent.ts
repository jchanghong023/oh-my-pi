import * as path from "node:path";
import { registerProvider } from "../capability";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import type { LoadContext, LoadResult } from "../capability/types";
import { getDeveloperTestAgentRoot } from "../extensibility/plugins/developer-test-agent-resources";
import { loadFilesFromDir, scanSkillsFromDir } from "./helpers";

const PROVIDER_ID = "developer-test-agent";
const provider = {
	id: PROVIDER_ID,
	displayName: "Developer Test Agent",
	description: "Manual-only bundled unit-test skills and commands",
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
	// Leave the resource path literal through both invocation argument passes.
	const pluginRoot = root.replaceAll("\\", "/").replace(/[${]/g, char => `{{{default false "${char}"}}}`);
	return loadFilesFromDir<SlashCommand>(ctx, path.join(root, "commands"), PROVIDER_ID, "project", {
		extensions: ["md"],
		origin: "bundled-developer-test-agent",
		transform: (name, content, filePath, source) => ({
			name: name.replace(/\.md$/, ""),
			path: filePath,
			content: content.replaceAll("{{pluginRoot}}", () => pluginRoot),
			level: "project",
			_source: source,
		}),
	});
}

registerProvider<Skill>(skillCapability.id, { ...provider, load: loadDeveloperTestSkills });
registerProvider<SlashCommand>(slashCommandCapability.id, { ...provider, load: loadDeveloperTestCommands });
