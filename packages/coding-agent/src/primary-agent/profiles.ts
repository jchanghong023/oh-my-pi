import discussPrompt from "../prompts/primary-agents/discuss.md" with { type: "text" };
import type { PrimaryAgentId, PrimaryAgentProfile } from "./types";

const DISCUSS_ALLOWED_TOOL_NAMES: Readonly<Record<string, true>> = {
	read: true,
	grep: true,
	glob: true,
	web_search: true,
	ast_grep: true,
	inspect_image: true,
	ask: true,
	recall: true,
	reflect: true,
};

export const PRIMARY_AGENT_PROFILES: Readonly<Record<PrimaryAgentId, PrimaryAgentProfile>> = {
	main: {
		id: "main",
		label: "Main",
		restrictTools: false,
	},
	discuss: {
		id: "discuss",
		label: "Discuss",
		systemPrompt: discussPrompt,
		restrictTools: true,
		allowedToolNames: DISCUSS_ALLOWED_TOOL_NAMES,
	},
};

export function getPrimaryAgentProfile(id: PrimaryAgentId): PrimaryAgentProfile {
	return PRIMARY_AGENT_PROFILES[id];
}

/** Projects a base tool slate through a profile without changing its order. */
export function projectPrimaryAgentToolNames(
	toolNames: readonly string[],
	profile: PrimaryAgentProfile,
	isBuiltIn: (name: string) => boolean = () => false,
): string[] {
	if (!profile.restrictTools) return [...toolNames];
	const allowed = profile.allowedToolNames;
	return allowed ? toolNames.filter(name => allowed[name] === true && isBuiltIn(name)) : [];
}

export function isPrimaryAgentToolAllowed(name: string, profile: PrimaryAgentProfile, isBuiltIn = false): boolean {
	return !profile.restrictTools || (isBuiltIn && profile.allowedToolNames?.[name] === true);
}
