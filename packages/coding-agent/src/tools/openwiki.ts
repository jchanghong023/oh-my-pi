import { stat } from "node:fs/promises";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getOpenWikiConfigDirectory } from "../openwiki/home";
import { loadOpenWikiVendor } from "../openwiki/vendor-loader";
import searchDescription from "../prompts/tools/openwiki-search.md" with { type: "text" };
import readDescription from "../prompts/tools/openwiki-read.md" with { type: "text" };
import workspacesDescription from "../prompts/tools/openwiki-list-workspaces.md" with { type: "text" };
import wikisDescription from "../prompts/tools/openwiki-list-wikis.md" with { type: "text" };
import type { ToolSession } from ".";

const searchSchema = type({
	query: type("string").describe("Repository question or concept to find"),
	"paths?": type("string[]").describe("Repository-relative source paths used as ranking hints"),
	"limit?": type("number").describe("Maximum ranked results, from 1 to 20; default 5"),
	"workspace?": type("string").describe("Workspace ID or unique name overriding automatic selection"),
	"+": "reject",
});
const readSchema = type({
	page: type("string").describe("Wiki page path from a search ref"),
	sections: type("string[]").describe("Exact heading anchors from search refs"),
	"wiki?": type("string").describe("Linked wiki ID from the search result"),
	"+": "reject",
});
const workspacesSchema = type({
	"wiki?": type("string").describe("Known reachable wiki ID; omit for the current repository"),
	"+": "reject",
});
const wikisSchema = type({
	workspace: type("string").describe("Workspace ID or unique name returned by openwiki_list_workspaces"),
	"+": "reject",
});

type Query =
	| { kind: "search"; params: typeof searchSchema.infer }
	| { kind: "read"; params: typeof readSchema.infer }
	| { kind: "workspaces"; params: typeof workspacesSchema.infer }
	| { kind: "wikis"; params: typeof wikisSchema.infer };

async function runQuery(session: ToolSession, query: Query, signal?: AbortSignal) {
	signal?.throwIfAborted();
	// Capture the profile per call: concurrent sessions must not share mutable home state.
	const options = { configDirectory: getOpenWikiConfigDirectory(session.settings.getAgentDir()) };
	const vendor = await loadOpenWikiVendor();
	const { resolveRepositoryRoot } = vendor;
	const root = await resolveRepositoryRoot(path.resolve(session.cwd));
	signal?.throwIfAborted();
	if (query.kind === "search" || query.kind === "read") {
		try {
			if (!(await stat(path.join(root, "openwiki"))).isDirectory()) {
				throw new ToolError(
					"invalid_state: This repository has no OpenWiki directory. Run `omp openwiki --init` to generate one.",
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ToolError(
					"invalid_state: This repository has no OpenWiki directory. Run `omp openwiki --init` to generate one.",
				);
			}
			throw error;
		}
	}
	let result: unknown;
	switch (query.kind) {
		case "search": {
			const request = vendor.SearchInput.parse({ root, ...query.params });
			result = await vendor.searchWiki(root, request, options);
			break;
		}
		case "read": {
			const request = vendor.ReadInput.parse({ root, ...query.params });
			result = await vendor.readWikiSections(root, request, options);
			break;
		}
		case "workspaces": {
			const request = vendor.ListWorkspacesInput.parse({ root, ...query.params });
			result = await vendor.listWikiWorkspaces(root, request.wiki, options);
			break;
		}
		case "wikis": {
			const request = vendor.ListWikisInput.parse({ root, ...query.params });
			result = await vendor.listWorkspaceWikis(root, request.workspace, options);
			break;
		}
	}
	signal?.throwIfAborted();
	return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
}

async function executeQuery(session: ToolSession, query: Query, signal?: AbortSignal) {
	try {
		return await runQuery(session, query, signal);
	} catch (error) {
		if (signal?.aborted || !(error instanceof Error) || error instanceof ToolError) throw error;
		if (error.name === "ZodError" || error.name === "WikiRetrievalError") {
			throw new ToolError(`invalid_input: ${error.message}`);
		}
		if (error.name === "ClaimsPageMissingError") {
			throw new ToolError("invalid_input: The requested OpenWiki page does not exist.");
		}
		if (error.name === "WikiWorkspaceError" || error.name.startsWith("Claims")) {
			throw new ToolError(`invalid_state: ${error.message}`);
		}
		if (error.name === "HostIntegrationError" && "code" in error) {
			throw new ToolError(`${String(error.code)}: ${error.message}`);
		}
		throw error;
	}
}

export class OpenWikiSearchTool implements AgentTool<typeof searchSchema> {
	readonly name = "openwiki_search";
	readonly label = "OpenWiki Search";
	readonly approval = "read" as const;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Search existing repository OpenWiki sections";
	readonly description = prompt.render(searchDescription);
	readonly parameters = searchSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {}
	async execute(
		_id: string,
		params: typeof searchSchema.infer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		return executeQuery(this.session, { kind: "search", params }, signal);
	}
}

export class OpenWikiReadTool implements AgentTool<typeof readSchema> {
	readonly name = "openwiki_read";
	readonly label = "OpenWiki Read";
	readonly approval = "read" as const;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Read complete sections from a repository OpenWiki";
	readonly description = prompt.render(readDescription);
	readonly parameters = readSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {}
	async execute(
		_id: string,
		params: typeof readSchema.infer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		return executeQuery(this.session, { kind: "read", params }, signal);
	}
}

export class OpenWikiListWorkspacesTool implements AgentTool<typeof workspacesSchema> {
	readonly name = "openwiki_list_workspaces";
	readonly label = "OpenWiki Workspaces";
	readonly approval = "read" as const;
	readonly loadMode = "discoverable" as const;
	readonly summary = "List workspaces containing a repository OpenWiki";
	readonly description = prompt.render(workspacesDescription);
	readonly parameters = workspacesSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {}
	async execute(
		_id: string,
		params: typeof workspacesSchema.infer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		return executeQuery(this.session, { kind: "workspaces", params }, signal);
	}
}

export class OpenWikiListWikisTool implements AgentTool<typeof wikisSchema> {
	readonly name = "openwiki_list_wikis";
	readonly label = "OpenWiki Wikis";
	readonly approval = "read" as const;
	readonly loadMode = "discoverable" as const;
	readonly summary = "List repository wikis in an OpenWiki workspace";
	readonly description = prompt.render(wikisDescription);
	readonly parameters = wikisSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {}
	async execute(
		_id: string,
		params: typeof wikisSchema.infer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		return executeQuery(this.session, { kind: "wikis", params }, signal);
	}
}
