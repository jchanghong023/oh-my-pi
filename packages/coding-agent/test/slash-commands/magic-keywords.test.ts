import { describe, expect, it } from "bun:test";
import { BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-magic-keywords";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const MAGIC_KEYWORDS = ["ultrathink", "orchestrate", "workflowz"] as const;

describe("magic keyword slash commands", () => {
	it.each(MAGIC_KEYWORDS)("advertises and sends /%s as its magic keyword", async keyword => {
		const command = BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS.find(candidate => candidate.name === keyword);

		expect(command).toMatchObject({
			name: keyword,
			description: `Send the ${keyword} magic keyword`,
		});
		expect(command?.handle).toBeDefined();

		const result = await command?.handle?.(
			{ name: keyword, args: "", text: `/${keyword}` },
			{} as SlashCommandRuntime,
		);

		expect(result).toEqual({ prompt: keyword });
	});
});
