import { describe, expect, it } from "bun:test";
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
