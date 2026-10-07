import type { SlashCommandSpec } from "./types";
import { MAGIC_KEYWORDS } from "../modes/magic-keywords";

export const BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = MAGIC_KEYWORDS.filter(
	keyword => "slashCommand" in keyword,
).map(keyword => ({
	name: keyword.word,
	description: `Send the ${keyword.word} magic keyword`,
	allowArgs: true,
	inlineHint: "[task]",
	acpInputHint: "[task]",
	handle: command => {
		const args = command.args.trim();
		return { prompt: args ? `${keyword.word} ${args}` : keyword.word };
	},
}));
