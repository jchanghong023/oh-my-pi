/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Fork: /team multi-model discussion participants (full model IDs, e.g.
// "company/GLM-5.2-public"). Unset or empty means "not configured": /team
// then falls back to the company lane snapshot under --offline and errors
// with a configuration example otherwise.
export const cfgTeamMembers = register({
	id: "team.members",
	type: "array",
	default: [] as string[],
});
