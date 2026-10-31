import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { loadOpenWikiVendor } from "./vendor-loader";

/** Resolve OpenWiki's private state under the effective OMP profile. */
export function getOpenWikiConfigDirectory(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "openwiki");
}

/** Select the OMP-managed home for an embedded OpenWiki operation. */
export async function configureOpenWikiHome(agentDir?: string): Promise<void> {
	const { setEmbeddedOpenWikiHomeDir } = await loadOpenWikiVendor();
	setEmbeddedOpenWikiHomeDir(getOpenWikiConfigDirectory(agentDir));
}
