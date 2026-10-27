import type { CreateAgentSessionOptions } from "../sdk";

export const SEANCE_AGENT_NAME = "seance";

// The native execution hook must distinguish a seance's intentionally empty
// catalog from an ordinary empty catalog without trusting user-supplied metadata.
const isolatedSkillCatalogs = new WeakSet<object>();

export function isSeanceIsolationSkills(skills: CreateAgentSessionOptions["skills"]): boolean {
	return skills !== undefined && isolatedSkillCatalogs.has(skills);
}

/** Session capabilities shared by fresh startup and cold restoration. */
export function seanceIsolationOptions(cwd: string) {
	const skills: NonNullable<CreateAgentSessionOptions["skills"]> = [];
	isolatedSkillCatalogs.add(skills);
	return {
		disableExtensionDiscovery: true,
		restrictToolNames: true,
		enableMCP: false,
		mcpManager: undefined,
		mcpTools: [],
		enableIrc: false,
		enableLsp: false,
		spawns: "",
		additionalDirectories: [],
		inheritedSessionAgents: undefined,
		contextFiles: [],
		skills,
		workspaceTree: {
			rootPath: cwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		promptTemplates: [],
		rules: [],
		extensionRoots: undefined,
		preloadedExtensionPaths: [],
		preloadedPreparedExtensions: [],
		preloadedCustomToolPaths: [],
		customTools: undefined,
		localProtocolOptions: undefined,
		parentHindsightSessionState: undefined,
		parentMnemopiSessionState: undefined,
	} satisfies Partial<CreateAgentSessionOptions>;
}
