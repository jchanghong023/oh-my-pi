import { prompt } from "@oh-my-pi/pi-utils";
import dftExplainPrompt from "../prompts/jch-dft.md" with { type: "text" };
import type { SlashCommandSpec } from "../slash-commands/types";

export const JCH_DFT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "jchdftexplain",
		description: "JCH DFT：结合 wiki，面向 DFT 新手解释文件、目录、代码和业务概念",
		allowArgs: true,
		remoteTask: true,
		inlineHint: "<文件、目录、代码或概念>",
		handle(command) {
			return { prompt: prompt.compile(dftExplainPrompt)({ TARGET: command.args.trim() }) };
		},
	},
];
