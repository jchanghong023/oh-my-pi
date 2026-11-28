import {
	cfgMarketplaceAutoUpdate,
	cfgStartupSetupWizard,
	cfgTuiAutoGraph,
	cfgTuiTitleState,
} from "../modes/settings";
import { cfgTitleRefreshOnReplan } from "../utils/title-settings";
import type { Settings } from "./settings";

const OFFLINE_SCAN_CACHE_TTL_MS = "30000";

/** Set before the CLI constructs file autocomplete providers; an explicit value (including 0) wins. */
export function applyOfflineCliEnvironment(): void {
	if (!process.env.FS_SCAN_CACHE_TTL_MS) process.env.FS_SCAN_CACHE_TTL_MS = OFFLINE_SCAN_CACHE_TTL_MS;
}

/** Intranet CLI launch policy, not SDK defaults. The overrides are never persisted. */
export function applyOfflineCliSettings(settings: Settings): void {
	cfgMarketplaceAutoUpdate.override(settings, "off");
	cfgStartupSetupWizard.override(settings, false);
	cfgTuiAutoGraph.override(settings, "off");
	cfgTuiTitleState.override(settings, false);
	cfgTitleRefreshOnReplan.override(settings, false);
}
