import type { BunPlugin } from "bun";
import {
	buildDeveloperTestAgentResources,
	createDeveloperTestAgentArchivePlugin,
} from "./developer-test-agent-resources";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";
import { createOpenWikiVendorLoaderPlugin } from "./openwiki-vendor-loader-plugin";
import { buildSpecDrivenArchives, createSpecDrivenArchivePlugin, writeSpecDrivenArchives } from "./spec-driven-resources";

/** Assemble the CLI's common plugins and write the same resource bytes for the npm SDK sidecars. */
export async function createBundlePlugins(sdkOutputDir?: string): Promise<BunPlugin[]> {
	const plugins = [
		createJsonParsePlugin(),
		createDeveloperTestAgentArchivePlugin(await buildDeveloperTestAgentResources()),
		createOpenWikiVendorLoaderPlugin(),
		await createLegacyPiVirtualModulePlugin(),
	];
	const archives = await buildSpecDrivenArchives();
	if (sdkOutputDir) await writeSpecDrivenArchives(sdkOutputDir, archives);
	plugins.push(createSpecDrivenArchivePlugin(archives));
	return plugins;
}
