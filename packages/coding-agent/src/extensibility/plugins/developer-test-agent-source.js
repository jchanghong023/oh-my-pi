import * as path from "node:path";
import developerTestAgentMd from "../../../dist/developer-test-agent/agents/developer-test-agent.md" with { type: "text" };

export { developerTestAgentMd };

export function developerTestAgentSourceRoot() {
	return path.resolve(import.meta.dir, "../../../dist/developer-test-agent");
}
