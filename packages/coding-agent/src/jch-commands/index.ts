import type { SlashCommandSpec } from "../slash-commands/types";
import { JCH_GIT_SLASH_COMMANDS } from "./git";
import { JCH_WORKFLOW_SLASH_COMMANDS } from "./workflow";

/** Fork-personal slash commands. Keep all JCH commands isolated in this directory. */
export const JCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	...JCH_WORKFLOW_SLASH_COMMANDS,
	...JCH_GIT_SLASH_COMMANDS,
];
