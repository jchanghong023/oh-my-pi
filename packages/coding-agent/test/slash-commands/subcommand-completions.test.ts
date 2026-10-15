import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("declarative subcommand completion", () => {
	it("gives the selected dropdown item the same ghost text as the closed-dropdown hint", async () => {
		const changelog = BUILTIN_SLASH_COMMANDS.find(command => command.name === "changelog");
		const items = await changelog?.getArgumentCompletions?.("la");
		const inlineHint = changelog?.getInlineHint?.("la") ?? undefined;

		expect(inlineHint).toBeTruthy();
		expect(items?.map(item => item.hint)).toEqual([inlineHint]);
	});

	it("keeps catchup's local summary callable without completing a deep recovery", async () => {
		const catchup = BUILTIN_SLASH_COMMANDS.find(command => command.name === "jchcatchup");
		expect(await catchup?.getArgumentCompletions?.("")).toBeNull();
		const items = await catchup?.getArgumentCompletions?.("f");
		expect(items?.map(item => item.value)).toEqual(["full "]);
	});
});
