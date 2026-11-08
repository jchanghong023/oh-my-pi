import * as path from "node:path";
import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import {
	classifySource,
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import type { SlashCommandRuntime } from "../types";
import { expandTilde } from "../../tools/path-utils";

/**
 * Build a `MarketplaceManager` wired up with the active project's registry
 * paths and the shared plugin-root cache invalidator. Reused by both `/plugins`
 * and `/marketplace` handlers so cache invalidation stays consistent.
 */
export async function createMarketplaceManager(runtime: SlashCommandRuntime): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(runtime.cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: clearPluginRootsAndCaches,
	});
}

/** Resolve local sources in the submitting session, never the process-wide cwd. */
export function resolveMarketplaceSource(source: string, cwd: string): string {
	return classifySource(source) === "local" ? path.resolve(cwd, expandTilde(source)) : source;
}
