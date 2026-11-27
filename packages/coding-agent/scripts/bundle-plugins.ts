import type { BunPlugin } from "bun";
import {
	buildDeveloperTestAgentResources,
	createDeveloperTestAgentArchivePlugin,
} from "./developer-test-agent-resources";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";
import { createOpenWikiVendorLoaderPlugin } from "./openwiki-vendor-loader-plugin";
import { buildSpecDrivenArchive, createSpecDrivenArchivePlugin } from "./spec-driven-resources";

/** Assemble the CLI's common plugins and expose the same archive bytes for the npm SDK sidecar. */
export async function createBundlePlugins(): Promise<{ plugins: BunPlugin[]; specDrivenArchive: Uint8Array }> {
	const plugins = [
		createJsonParsePlugin(),
		createDeveloperTestAgentArchivePlugin(await buildDeveloperTestAgentResources()),
		createOpenWikiVendorLoaderPlugin(),
		await createLegacyPiVirtualModulePlugin(),
	];
	const archive = await buildSpecDrivenArchive();
	plugins.push(createSpecDrivenArchivePlugin(archive));
	return { plugins, specDrivenArchive: archive.bytes };
}
