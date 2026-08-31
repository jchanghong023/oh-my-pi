import { usage } from "../slash-commands/helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "../slash-commands/types";

export interface JchPromptCommandDefinition {
	name: string;
	description: string;
	prompt: string;
	requiredArgsUsage?: string;
	aliases?: string[];
	inlineHint?: string;
	tuiOnly?: boolean;
}

function expandPrompt(prompt: string, args: string): string {
	const base = prompt.trim();
	const extra = args.trim();
	if (!extra) return base;
	return `${base}\n\nSlash 参数如下，只用于细化目标、范围、输出格式和偏好；NEVER 改变基础任务的核心动作、读写性质或安全边界。与基础任务冲突时 MUST 遵循基础任务并指出冲突：\n${extra}`;
}

/** Define a fork-personal slash command that expands into a normal user prompt. */
export function defineJchPromptCommand(definition: JchPromptCommandDefinition): SlashCommandSpec {
	const spec: SlashCommandSpec = {
		name: definition.name,
		aliases: definition.aliases,
		description: definition.description,
		allowArgs: true,
		inlineHint: definition.inlineHint,
	};
	if (definition.tuiOnly) {
		spec.handleTui = (command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
			if (definition.requiredArgsUsage && !command.args.trim()) {
				runtime.ctx.showStatus(definition.requiredArgsUsage);
				runtime.ctx.editor.setText("");
				return { consumed: true };
			}
			return { prompt: expandPrompt(definition.prompt, command.args) };
		};
	} else {
		spec.handle = (
			command: ParsedSlashCommand,
			runtime: SlashCommandRuntime,
		): SlashCommandResult | Promise<SlashCommandResult> => {
			if (definition.requiredArgsUsage && !command.args.trim()) {
				return usage(definition.requiredArgsUsage, runtime);
			}
			return { prompt: expandPrompt(definition.prompt, command.args) };
		};
	}
	return spec;
}
