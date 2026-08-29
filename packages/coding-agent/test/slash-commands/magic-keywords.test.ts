import { describe, expect, it } from "bun:test";
import { JCH_WORKFLOW_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/workflow";
import { BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-magic-keywords";
import {
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const MAGIC_KEYWORDS = ["ultrathink", "orchestrate", "workflowz", "fullsend"];

describe("magic keyword slash commands", () => {
	it.each(MAGIC_KEYWORDS)("advertises and sends /%s with optional task text", async keyword => {
		const command = BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS.find(candidate => candidate.name === keyword);

		expect(command).toMatchObject({
			name: keyword,
			description: `Send the ${keyword} magic keyword`,
			allowArgs: true,
			inlineHint: "[task]",
			acpInputHint: "[task]",
		});
		expect(command?.handle).toBeDefined();

		const bareResult = await command?.handle?.(
			{ name: keyword, args: "", text: `/${keyword}` },
			{} as SlashCommandRuntime,
		);
		const whitespaceResult = await command?.handle?.(
			{ name: keyword, args: "   ", text: `/${keyword}   ` },
			{} as SlashCommandRuntime,
		);
		const taskResult = await command?.handle?.(
			{ name: keyword, args: "  完成这个任务  ", text: `/${keyword}  完成这个任务  ` },
			{} as SlashCommandRuntime,
		);

		expect(bareResult).toEqual({ prompt: keyword });
		expect(whitespaceResult).toEqual({ prompt: keyword });
		expect(taskResult).toEqual({ prompt: `${keyword} 完成这个任务` });
	});
	it.each(MAGIC_KEYWORDS)("registers /%s in the builtin registry without shadowing", keyword => {
		// The keyword must be reachable through the builtin registry lookup and
		// resolve to its own magic keyword spec — a collision with another
		// command's name or alias would silently overwrite the lookup entry.
		const resolved = lookupBuiltinSlashCommand(keyword);
		expect(resolved).toMatchObject({
			name: keyword,
			allowArgs: true,
			inlineHint: "[task]",
		});
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(keyword)).toBe(true);
	});
});

describe("JCH workflow slash commands", () => {
	it("keeps workflow and branch arguments as joint failed-run constraints", async () => {
		const command = JCH_WORKFLOW_SLASH_COMMANDS.find(candidate => candidate.name === "jchfixactions");
		if (!command?.handle) throw new Error("Expected /jchfixactions to be registered");
		const args = "workflow=CI branch=release";
		const result = await command.handle(
			{ name: command.name, args, text: `${command.name} ${args}` },
			{} as SlashCommandRuntime,
		);
		if (!result || !("prompt" in result)) throw new Error("Expected /jchfixactions to expand to a prompt");
		expect(result.prompt).toContain("参数指定 workflow 或 branch 时，仅在同时满足这些条件的范围内选择目标失败 run");
		expect(result.prompt).toContain(args);
	});
});
