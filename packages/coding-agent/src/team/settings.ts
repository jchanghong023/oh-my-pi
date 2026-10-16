/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Fork: ordered /team model slots (full provider/model IDs). Unset or empty
// uses the session model; cycle the list until at least three agents exist.
export const cfgTeamMembers = register({
	id: "team.members",
	type: "array",
	default: [] as string[],
});
