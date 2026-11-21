import imePrompt from "../prompts/jch-ime.md" with { type: "text" };
import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

export const JCH_WORKFLOW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchime",
		description: "JCH：按内网 IBus 详细步骤恢复当前显示会话的中文输入法",
		inlineHint: "[故障现象]",
		prompt: imePrompt,
	}),
];
