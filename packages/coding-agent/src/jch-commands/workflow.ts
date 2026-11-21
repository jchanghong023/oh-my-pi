import { prompt } from "@oh-my-pi/pi-utils";
import imePrompt from "../prompts/jch-ime.md" with { type: "text" };
import workflowzBatchPrompt from "../prompts/jch-workflowzbatch.md" with { type: "text" };
import { usage } from "../slash-commands/helpers/parse";
import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

const JCH_WORKFLOWZ_BATCH_USAGE = "用法：/jch-workflowzbatch <任务块软目标：正整数> <并发上限：正整数> <任务正文>";

export const JCH_WORKFLOW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "jch-workflowzbatch",
		description: "JCH：展开独立任务工作流批处理要求，禁止测试和全仓检查",
		allowArgs: true,
		inlineHint: "<任务块软目标> <并发上限> <任务正文>",
		handle(command, runtime) {
			// The shared parser trims args; use the original suffix to retain task whitespace.
			const args = command.text.slice(command.name.length + 2).trimStart();
			const match = /^([1-9]\d*)\s+([1-9]\d*)(?:\r\n|\s)([\s\S]*)$/.exec(args);
			if (!match) return usage(JCH_WORKFLOWZ_BATCH_USAGE, runtime);
			const targetItems = Number(match[1]);
			const maxConcurrency = Number(match[2]);
			const task = match[3]!;
			if (!Number.isSafeInteger(targetItems) || !Number.isSafeInteger(maxConcurrency) || !task.trim()) {
				return usage(JCH_WORKFLOWZ_BATCH_USAGE, runtime);
			}
			return { prompt: prompt.compile(workflowzBatchPrompt.trimEnd())({ targetItems, maxConcurrency, task }) };
		},
	},
	defineJchPromptCommand({
		name: "jchime",
		description: "JCH：按内网 IBus 详细步骤恢复当前显示会话的中文输入法",
		inlineHint: "[故障现象]",
		prompt: imePrompt,
	}),
];
