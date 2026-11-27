import { prompt } from "@oh-my-pi/pi-utils";
import minimalPrompt from "../prompts/minimal.md" with { type: "text" };
import type { SlashCommandSpec } from "../slash-commands/types";
import { JCH_WORKFLOW_SLASH_COMMANDS } from "./workflow";

/** Fork-personal slash commands. Keep all fork commands isolated in this directory. */
export const JCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "minimal",
		description: "Complete a specific task with the smallest sufficient change and verification",
		allowArgs: true,
		inlineHint: "[task]",
		handle: command => ({ prompt: prompt.compile(minimalPrompt.trim())({ task: command.args }) }),
	},
	...JCH_WORKFLOW_SLASH_COMMANDS,
];
