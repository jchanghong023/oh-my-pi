import imePrompt from "../prompts/jch-ime.md" with { type: "text" };
import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

export const JCH_WORKFLOW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchime",
		description:
			"JCH: Restore the current display session's Chinese input method using the internal IBus recovery steps",
		inlineHint: "[symptoms]",
		prompt: imePrompt,
	}),
];
