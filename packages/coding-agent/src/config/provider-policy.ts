import type { Settings } from "./settings";

export const DEFAULT_ENABLED_PROVIDER_IDS: readonly string[] = [
	"opencode-go",
	"opencode-zen",
	"openai-codex",
	"deepseek",
];

/** Providers are closed unless their exact id is in the configured allow-list. */
export function getEnabledProviderIds(settingsInstance?: Settings): ReadonlySet<string> {
	try {
		return new Set(settingsInstance?.get("enabledProviders") ?? DEFAULT_ENABLED_PROVIDER_IDS);
	} catch {
		return new Set(DEFAULT_ENABLED_PROVIDER_IDS);
	}
}

export function isProviderEnabled(providerId: string, settingsInstance?: Settings): boolean {
	return getEnabledProviderIds(settingsInstance).has(providerId);
}
