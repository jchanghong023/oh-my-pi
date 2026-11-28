/**
 * Builtin Defaults Provider
 *
 * Ships a curated set of default rules (mostly TTSR conventions) embedded into
 * the binary. Registered at the lowest priority so any user/project/tool rule
 * with the same `name` overrides the bundled copy (first-wins dedup by name).
 *
 * Users disable bundled rules three ways:
 *   - flip `ttsr.builtinRules` off (drops the whole set),
 *   - list a name in `ttsr.disabledRules` (drops one rule),
 *   - define a same-named rule in any higher-priority source (overrides it).
 * The first two are enforced in `bucketRules` (see capability/rule-buckets.ts).
 * In intranet mode, this module also supplies the default knowledge MCP server.
 */
import { offlineFromEnv } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import { BUILTIN_RULE_SOURCES } from "./builtin-rules";
import { buildRuleFromMarkdown, createSourceMeta } from "./helpers";

const DISPLAY_NAME = "Builtin Defaults";
// Lowest priority: every other rule provider wins a name conflict.
const PRIORITY = 1;

async function loadRules(_ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items = BUILTIN_RULE_SOURCES.map(({ name, content }) => {
		const virtualPath = `${BUILTIN_DEFAULTS_PROVIDER_ID}:${name}.md`;
		const source = createSourceMeta(BUILTIN_DEFAULTS_PROVIDER_ID, virtualPath, "user");
		return buildRuleFromMarkdown(name, content, virtualPath, source, { ruleName: name });
	});
	return { items };
}

registerProvider<Rule>(ruleCapability.id, {
	id: BUILTIN_DEFAULTS_PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Default rules shipped with the agent (disable via ttsr.builtinRules / ttsr.disabledRules)",
	priority: PRIORITY,
	load: loadRules,
});

const INTRANET_MCP_PROVIDER_ID = "intranet-mcp";

registerProvider<MCPServer>(mcpCapability.id, {
	id: INTRANET_MCP_PROVIDER_ID,
	displayName: "Built-in MCP",
	description: "Company intranet MCP servers (OMP_OFFLINE only)",
	priority: PRIORITY,
	async load() {
		if (!offlineFromEnv()) return { items: [] };
		return {
			items: [
				{
					name: "knowledge",
					transport: "http",
					url: "http://10.239.93.104:9333/mcp",
					_source: {
						provider: INTRANET_MCP_PROVIDER_ID,
						providerName: "",
						path: "builtin:knowledge",
						level: "native",
					},
				},
			],
		};
	},
});
