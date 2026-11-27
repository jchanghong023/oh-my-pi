import { clearSubmittedText } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";
import { MAGIC_KEYWORDS } from "../modes/magic-keywords";
import { cfgMagicKeyword, cfgMagicKeywordsEnabled } from "../modes/settings";

export const BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = MAGIC_KEYWORDS.filter(
	keyword => "slashCommand" in keyword,
).map(keyword => ({
	name: keyword.word,
	description: `Send the ${keyword.word} magic keyword`,
	allowArgs: true,
	inlineHint: "[task]",
	handleTui: (command, runtime) => {
		clearSubmittedText(runtime);
		const { session, settings } = runtime.ctx;
		if (!cfgMagicKeywordsEnabled.get(settings) || !cfgMagicKeyword[keyword.id].get(settings)) {
			runtime.ctx.showWarning(`/${keyword.word} is disabled in Magic Keywords settings.`);
			return;
		}
		if (keyword.requires.length) {
			const enabled = session.getEnabledToolNames();
			const missing = keyword.requires.filter(tool => !enabled.includes(tool));
			if (missing.length) {
				runtime.ctx.showWarning(`/${keyword.word} requires enabled tools: ${missing.join(", ")}.`);
				return;
			}
		}
		const args = command.args.trim();
		return { prompt: args ? `${keyword.word} ${args}` : keyword.word };
	},
}));
