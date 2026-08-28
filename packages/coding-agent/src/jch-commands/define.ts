import type { SlashCommandSpec } from "../slash-commands/types";

export interface JchPromptCommandDefinition {
	name: string;
	description: string;
	prompt: string;
	aliases?: string[];
	inlineHint?: string;
}

function expandPrompt(prompt: string, args: string): string {
	const base = prompt.trim();
	const extra = args.trim();
	if (!extra) return base;
	return `${base}\n\n用户在 slash 命令后提供的参数/补充条件如下。把它们作为本次任务的具体范围和偏好；如与基础任务存在冲突，以这些补充条件为准，但不要扩大到未授权对象：\n${extra}`;
}

/** Define a fork-personal slash command that expands into a normal user prompt. */
export function defineJchPromptCommand(definition: JchPromptCommandDefinition): SlashCommandSpec {
	return {
		name: definition.name,
		aliases: definition.aliases,
		description: definition.description,
		allowArgs: true,
		inlineHint: definition.inlineHint,
		handle: command => ({ prompt: expandPrompt(definition.prompt, command.args) }),
	};
}
