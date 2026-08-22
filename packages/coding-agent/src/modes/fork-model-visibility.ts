import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models";

const VISIBLE_BUILT_IN_PROVIDERS = new Set(["opencode-go", "opencode-zen", "openai-codex", "deepseek"]);
const BUILT_IN_PROVIDERS = new Set<string>([
	...getBundledProviders(),
	...CATALOG_PROVIDERS.map(provider => provider.id),
	// Implicit local provider not represented in either upstream catalog.
	"llama.cpp",
]);

/** Limit only the fork's model-selection UI; custom providers stay visible. */
export function isProviderVisible(provider: string): boolean {
	return !BUILT_IN_PROVIDERS.has(provider) || VISIBLE_BUILT_IN_PROVIDERS.has(provider);
}
