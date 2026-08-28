import type { SlashCommandSpec } from "./types";

export const BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "ultrathink",
		description: "Send the ultrathink magic keyword",
		handle: () => ({ prompt: "ultrathink" }),
	},
	{
		name: "orchestrate",
		description: "Send the orchestrate magic keyword",
		handle: () => ({ prompt: "orchestrate" }),
	},
	{
		name: "workflowz",
		description: "Send the workflowz magic keyword",
		handle: () => ({ prompt: "workflowz" }),
	},
];
