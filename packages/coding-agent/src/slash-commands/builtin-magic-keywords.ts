import type { SlashCommandSpec } from "./types";

const MAGIC_KEYWORDS = ["ultrathink", "orchestrate", "workflowz", "fullsend"] as const;

export const BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = MAGIC_KEYWORDS.map(keyword => ({
	name: keyword,
	description: `Send the ${keyword} magic keyword`,
	allowArgs: true,
	inlineHint: "[task]",
	acpInputHint: "[task]",
	handle: command => {
		const args = command.args.trim();
		return { prompt: args ? `${keyword} ${args}` : keyword };
	},
}));
