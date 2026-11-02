import { prompt } from "@oh-my-pi/pi-utils";
import minimalPrompt from "../prompts/minimal.md" with { type: "text" };
import type { SlashCommandSpec } from "../slash-commands/types";
import { TEAM_SLASH_COMMANDS } from "./team";
import { JCH_WORKFLOW_SLASH_COMMANDS } from "./workflow";

/** Fork-personal slash commands. Keep all fork commands isolated in this directory. */
export const JCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "minimal",
		description: "以最小充分变更和验证完成明确需求",
		allowArgs: true,
		inlineHint: "[任务]",
		handle: command => ({ prompt: prompt.compile(minimalPrompt.trim())({ task: command.args }) }),
	},
	...JCH_WORKFLOW_SLASH_COMMANDS,
	...TEAM_SLASH_COMMANDS,
];
