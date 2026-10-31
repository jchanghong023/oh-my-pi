import type { OpenWikiVendor } from "../src/openwiki/vendor-contract";

export declare const runNativeRepositoryGeneration: OpenWikiVendor["runNativeRepositoryGeneration"];
export declare const parseCommand: OpenWikiVendor["parseCommand"];
export declare const runLinkCommand: OpenWikiVendor["runLinkCommand"];
export declare const runWorkspaceCommand: OpenWikiVendor["runWorkspaceCommand"];
export declare const resolvePageConcurrency: OpenWikiVendor["resolvePageConcurrency"];
export declare function getActiveOpenWikiHomeDir(): string;
export declare const setEmbeddedOpenWikiHomeDir: OpenWikiVendor["setEmbeddedOpenWikiHomeDir"];
export declare const resolveRepositoryRoot: OpenWikiVendor["resolveRepositoryRoot"];
export declare const SearchInput: OpenWikiVendor["SearchInput"];
export declare const ReadInput: OpenWikiVendor["ReadInput"];
export declare const ListWorkspacesInput: OpenWikiVendor["ListWorkspacesInput"];
export declare const ListWikisInput: OpenWikiVendor["ListWikisInput"];
export declare const searchWiki: OpenWikiVendor["searchWiki"];
export declare const readWikiSections: OpenWikiVendor["readWikiSections"];
export declare const listWikiWorkspaces: OpenWikiVendor["listWikiWorkspaces"];
export declare const listWorkspaceWikis: OpenWikiVendor["listWorkspaceWikis"];
export declare function saveWikiWorkspaces(
	drafts: readonly { id?: string; name: string; roots: string[] }[],
	options?: { configDirectory?: string },
): Promise<unknown>;
export declare const startEmbeddedVisualizeServer: OpenWikiVendor["startEmbeddedVisualizeServer"];
export declare const exportStaticVisualizer: OpenWikiVendor["exportStaticVisualizer"];
