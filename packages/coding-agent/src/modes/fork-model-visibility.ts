import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils";

const VISIBLE_BUILT_IN_PROVIDERS = new Set(["opencode-go", "opencode-zen", "openai-codex", "deepseek"]);
const BUILT_IN_PROVIDERS = new Set<string>([
	...getBundledProviders(),
	...CATALOG_PROVIDERS.map(provider => provider.id),
	// Implicit local provider not represented in either upstream catalog.
	"llama.cpp",
]);

// Keep upstream UI tests provider-agnostic; fork-specific tests opt in to the
// visibility filter explicitly so upstream test fixtures do not need rewriting.
let enforceVisibilityInTests = false;

/** Test hook for exercising the fork-only model visibility policy. */
export function setForkModelVisibilityFilteringForTests(enabled: boolean): boolean {
	const previous = enforceVisibilityInTests;
	enforceVisibilityInTests = enabled;
	return previous;
}

/** Limit only the fork's model-selection UI; custom providers stay visible. */
export function isProviderVisible(provider: string): boolean {
	if (isBunTestRuntime() && !enforceVisibilityInTests) return true;
	return !BUILT_IN_PROVIDERS.has(provider) || VISIBLE_BUILT_IN_PROVIDERS.has(provider);
}
