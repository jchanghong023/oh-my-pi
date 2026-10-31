// The fork remains the sole source of these APIs. The npm build bundles this entry
// for source-based SDK consumers that do not have a vendor checkout.
export { runNativeRepositoryGeneration } from "../../../vendor/openwiki/src/agent/repository-runner";
export { parseCommand } from "../../../vendor/openwiki/src/cli/commands";
export { runLinkCommand, runWorkspaceCommand } from "../../../vendor/openwiki/src/cli/link";
export { resolvePageConcurrency } from "../../../vendor/openwiki/src/config/constants";
export {
	getActiveOpenWikiHomeDir,
	setEmbeddedOpenWikiHomeDir,
} from "../../../vendor/openwiki/src/config/openwiki-home";
export { resolveRepositoryRoot } from "../../../vendor/openwiki/src/integrations/core/repository-root";
export {
	SearchInput,
	ReadInput,
	ListWorkspacesInput,
	ListWikisInput,
} from "../../../vendor/openwiki/src/integrations/core/retrieval-tools";
export { searchWiki, readWikiSections } from "../../../vendor/openwiki/src/retrieval/wiki";
export {
	listWikiWorkspaces,
	listWorkspaceWikis,
	saveWikiWorkspaces,
} from "../../../vendor/openwiki/src/linking/wiki-workspaces";
export { startEmbeddedVisualizeServer } from "../../../vendor/openwiki/src/visualize/server";
export { exportStaticVisualizer } from "../../../vendor/openwiki/src/visualize/static-export";
