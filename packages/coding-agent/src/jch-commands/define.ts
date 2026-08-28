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
	return `${base}\n\n用户在 slash 命令后提供的参数/补充条件如下。补充条件仅用于细化对象、范围、输出格式和偏好；不得改变命令的核心动作、读写性质或安全边界。与基础任务冲突时遵循基础任务，并指出冲突：\n${extra}`;
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
