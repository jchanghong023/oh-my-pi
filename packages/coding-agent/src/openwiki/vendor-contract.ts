import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

type LinkCommand = { kind: "link"; exitCode: 0; directory: string };
type WorkspaceCommand =
	| { kind: "workspace"; exitCode: 0; action: "use"; workspace: string }
	| { kind: "workspace"; exitCode: 0; action: "current" | "clear" };
type Command =
	| LinkCommand
	| WorkspaceCommand
	| { kind: "help"; exitCode: 0 }
	| { kind: "error"; exitCode: 1; message: string }
	| { kind: "visualize"; exitCode: 0; wikiDir: string; port: number; open: boolean; exportDir: string | null }
	| {
			kind: "run";
			exitCode: 0;
			mode: string;
			command: "chat" | "init" | "update";
			language: string | null;
			userMessage: string | null;
			telemetryFile: string | null;
			print: boolean;
	  }
	| { kind: "auth" | "ngrok" | "ingest" | "cron" | "integrations" | "mcp" };
type Event =
	| { type: "text"; text: string }
	| { type: "repository_progress"; stage: string; resumed?: boolean; page?: string }
	| { type: "debug"; message: string }
	| { type: "tool_start"; name: string; page?: string }
	| { type: "tool_end"; name: string; page?: string; status: string };
type Assets = {
	clientJs: string;
	clientLibJs: string;
	stylesCss: string;
	browserAssets?: Record<string, string>;
	licenseAssets?: Record<string, string>;
};
type StorageOptions = { configDirectory?: string };
type Search = { root: string; query: string; paths?: string[]; limit?: number; workspace?: string };
type Read = { root: string; page: string; sections: string[]; wiki?: string };
type WorkspaceList = { root: string; wiki?: string };
type WikiList = { root: string; workspace: string };
type Schema<T> = { parse(value: unknown): T };

/** The host-facing subset of the fork; no published types depend on the checkout. */
export interface OpenWikiVendor {
	setEmbeddedOpenWikiHomeDir(directory: string): void;
	resolveRepositoryRoot(candidate: string): Promise<string>;
	resolvePageConcurrency(): number;
	parseCommand(argv: string[]): Command;
	previewRepositoryFiles(
		root: string,
		mode: "init" | "update",
	): Promise<{
		sourcePaths: string[];
		existingWikiPages: string[];
		update?: {
			baselineGitHead?: string;
			changedPaths?: string[];
			pageBaselines: { page: string; gitHead?: string; changedPaths?: string[] }[];
		};
	}>;
	runLinkCommand(command: LinkCommand, options?: StorageOptions): Promise<void>;
	runWorkspaceCommand(command: WorkspaceCommand, options?: StorageOptions): Promise<void>;
	SearchInput: Schema<Search>;
	ReadInput: Schema<Read>;
	ListWorkspacesInput: Schema<WorkspaceList>;
	ListWikisInput: Schema<WikiList>;
	searchWiki(root: string, request: Search, options?: StorageOptions): Promise<unknown>;
	readWikiSections(root: string, request: Read, options?: StorageOptions): Promise<unknown>;
	listWikiWorkspaces(root: string, wiki?: string, options?: StorageOptions): Promise<unknown>;
	listWorkspaceWikis(root: string, workspace: string, options?: StorageOptions): Promise<unknown>;
	startEmbeddedVisualizeServer(options: {
		wikiRoot: string;
		port: number;
		open: boolean;
		assets: Assets;
	}): Promise<{ url: string; close(): Promise<void> }>;
	exportStaticVisualizer(options: {
		wikiRoot: string;
		outputDir: string;
		assets: Assets;
	}): Promise<{ outputDir: string; graph: { nodes: unknown[]; edges: unknown[] } }>;
	runNativeRepositoryGeneration(options: {
		root: string;
		mode: "init" | "update";
		language: string | null;
		force: boolean;
		planningContext: string | null;
		modelId: string;
		model: BaseChatModel;
		plannerModel?: BaseChatModel;
		pageConcurrency: number;
		embedded: boolean;
		skillsDir: string;
		signal: AbortSignal;
		onEvent(event: Event): void;
	}): Promise<{ partialFailure?: boolean; sourceChanged?: boolean; skipped: boolean }>;
}
