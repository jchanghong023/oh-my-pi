import type { SlashCommandSpec } from "../slash-commands/types";
import { TEAM_SLASH_COMMANDS } from "./team";
import { JCH_WORKFLOW_SLASH_COMMANDS } from "./workflow";

/** Fork-personal slash commands. Keep all fork commands isolated in this directory. */
export const JCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	...JCH_WORKFLOW_SLASH_COMMANDS,
	...TEAM_SLASH_COMMANDS,
];
