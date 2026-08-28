import type { SlashCommandSpec } from "../slash-commands/types";
import { JCH_GIT_SLASH_COMMANDS } from "./git";
import { JCH_GITHUB_SLASH_COMMANDS } from "./github";
import { JCH_SEARCH_SLASH_COMMANDS } from "./search";
import { JCH_SYSTEM_SLASH_COMMANDS } from "./system";

/** Fork-personal prompt-expanding slash commands. Keep all JCH commands isolated in this directory. */
export const JCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	...JCH_GIT_SLASH_COMMANDS,
	...JCH_GITHUB_SLASH_COMMANDS,
	...JCH_SEARCH_SLASH_COMMANDS,
	...JCH_SYSTEM_SLASH_COMMANDS,
];
