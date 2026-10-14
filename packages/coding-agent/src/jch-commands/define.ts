import { prompt } from "@oh-my-pi/pi-utils";
import commandHintPrompt from "../prompts/jch-command-hint.md" with { type: "text" };
import { usage } from "../slash-commands/helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
} from "../slash-commands/types";

export interface JchPromptCommandDefinition {
	name: string;
	description: string;
	prompt: string;
	requiredArgsUsage?: string;
	aliases?: string[];
	inlineHint?: string;
}

function expandPrompt(content: string, args: string): string {
	return prompt.compile(commandHintPrompt)({ base: content.trim(), extra: args.trim() });
}

/** Define a fork-personal slash command that expands into a normal user prompt. */
export function defineJchPromptCommand(definition: JchPromptCommandDefinition): SlashCommandSpec {
	const spec: SlashCommandSpec = {
		name: definition.name,
		aliases: definition.aliases,
		description: definition.description,
		allowArgs: true,
		remoteTask: true,
		inlineHint: definition.inlineHint,
	};
	spec.handle = (
		command: ParsedSlashCommand,
		runtime: SlashCommandRuntime,
	): SlashCommandResult | Promise<SlashCommandResult> => {
		if (definition.requiredArgsUsage && !command.args.trim()) {
			return usage(definition.requiredArgsUsage, runtime);
		}
		return { prompt: expandPrompt(definition.prompt, command.args) };
	};
	return spec;
}
