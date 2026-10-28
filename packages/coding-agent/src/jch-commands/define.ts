import { prompt } from "@oh-my-pi/pi-utils";
import commandHintPrompt from "../prompts/jch-command-hint.md" with { type: "text" };
import type { SlashCommandSpec } from "../slash-commands/types";

export interface JchPromptCommandDefinition {
	name: string;
	description: string;
	prompt: string;
	inlineHint?: string;
}

function expandPrompt(content: string, args: string): string {
	return prompt.compile(commandHintPrompt)({ base: content.trim(), extra: args.trim() });
}

/** Define a fork-personal slash command that expands into a normal user prompt. */
export function defineJchPromptCommand(definition: JchPromptCommandDefinition): SlashCommandSpec {
	const spec: SlashCommandSpec = {
		name: definition.name,
		description: definition.description,
		allowArgs: true,
		inlineHint: definition.inlineHint,
	};
	spec.handle = command => ({ prompt: expandPrompt(definition.prompt, command.args) });
	return spec;
}
