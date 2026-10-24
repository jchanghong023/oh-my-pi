import { prompt } from "@oh-my-pi/pi-utils";
import openSpecCommandPrompt from "../prompts/openspec-command.md" with { type: "text" };
import { loadOpenSpecCommand } from "../spec-driven/resources";
import { checkSkillInvocation } from "../spec-driven/skill-policy";
import type { SlashCommandSpec } from "./types";

const renderOpenSpecCommand = prompt.compile(openSpecCommandPrompt);
const openSpecCommands = [
	["opsx-explore", "探索问题与需求，不实施代码", "[问题]"],
	["opsx-update", "修订或补齐需求材料并检查一致性", "[变更名及修改要求]"],
	["opsx-propose", "生成需求提案与规格，不实施代码", "[需求]"],
	["opsx-sync", "将规格增量合入正式需求书，不代表已实现", "[变更名]"],
	["opsx-archive", "归档需求变更，不代替实现验收", "[变更名]"],
	["opsx-verify", "对照需求核对实现及证据，不实施代码", "[变更名]"],
] as const;

export const BUILTIN_OPENSPEC_SLASH_COMMANDS: SlashCommandSpec[] = openSpecCommands.map(
	([name, description, inlineHint]): SlashCommandSpec => ({
		name,
		description,
		inlineHint,
		allowArgs: true,
		async handle(parsed, host) {
			try {
				checkSkillInvocation({ name }, { scope: host.sessionManager });
				const instructions = await loadOpenSpecCommand(name);
				const input = parsed.text.slice(parsed.name.length + 2).trimStart();
				return { prompt: renderOpenSpecCommand({ instructions, input }) };
			} catch (error) {
				await host.output(`/${name} 无法执行：${error instanceof Error ? error.message : String(error)}`);
				return { consumed: true, failed: true };
			}
		},
	}),
);
