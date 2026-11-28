import * as path from "node:path";
import developerTestAgentMd from "../../../../../vendor/developer-test-agent/agents/developer-test-agent.md" with { type: "text" };

export { developerTestAgentMd };

export function developerTestAgentSourceRoot(): string {
	return path.resolve(import.meta.dir, "../../../../../vendor/developer-test-agent");
}
