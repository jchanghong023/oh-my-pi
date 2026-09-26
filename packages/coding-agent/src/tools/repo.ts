import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { RepoService } from "../repo/service";
import type { RepoQueryResult, RepoStatus, RepoSymbolHit, RepoTextHit } from "../repo/types";
import repoDescription from "../prompts/tools/repo.md" with { type: "text" };
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const repoSchema = type({
	action: type("'status' | 'search' | 'symbol'").describe(
		"inspect coverage, search indexed text, or find Python symbols",
	),
	"query?": type("string").describe("literal search text or symbol name; required for search and symbol"),
	"path?": type("string").describe("relative file path or directory prefix"),
	"category?": type("'source' | 'test' | 'config' | 'other'").describe("indexed file category"),
	"limit?": type("number").describe("hits per page, clamped to 1–50; default 20"),
	"cursor?": type("string").describe("continuation token from a previous page with the same query and filters"),
	"+": "reject",
});

export type RepoToolParams = typeof repoSchema.infer;
export type RepoToolDetails =
	| { action: "status"; status: RepoStatus; fieldTruncations: Record<string, number>; meta?: OutputMeta }
	| {
			action: "search";
			meta?: OutputMeta;
			status: RepoStatus;
			queryStatus: "ok" | "missing";
			hits: RepoTextHit[];
			cursor?: string;
			truncated: boolean;
			warnings: string[];
			fieldTruncations: Record<string, number>;
	  }
	| {
			action: "symbol";
			meta?: OutputMeta;
			status: RepoStatus;
			queryStatus: "ok" | "missing";
			hits: RepoSymbolHit[];
			cursor?: string;
			truncated: boolean;
			warnings: string[];
			fieldTruncations: Record<string, number>;
	  };

// Keep every hit on the service page: dropping one would silently skip it on
// the next cursor. Bound individual fields and report when their value is partial.
type FieldTruncations = Record<string, number>;

function field(value: string, max = 120, key?: string, clipped?: FieldTruncations): string {
	const clippedInput = value.length > max;
	const normalized = sanitizeText(clippedInput ? value.slice(0, max) : value).replaceAll(/\s*\n\s*/g, " ");
	if ((clippedInput || normalized.length > max) && key && clipped) clipped[key] = (clipped[key] ?? 0) + 1;
	return clippedInput && normalized.length <= max ? `${normalized.slice(0, max - 1)}…` : truncate(normalized, max);
}

function boundedStatus(status: RepoStatus, clipped: FieldTruncations): RepoStatus {
	const failures = status.failures.slice(0, 20).map(failure => ({
		path: field(failure.path, 160, "status.failures.path", clipped),
		kind: failure.kind,
		message: field(failure.message, 160, "status.failures.message", clipped),
	}));
	const pendingPaths = status.pendingPaths.slice(0, 20).map(path => field(path, 160, "status.pendingPaths", clipped));
	const uncertainReasons = status.uncertainReasons
		.slice(0, 10)
		.map(reason => field(reason, 160, "status.uncertainReasons", clipped));
	const exclusions = status.exclusions.slice(0, 20).map(path => field(path, 160, "status.exclusions", clipped));
	return {
		...status,
		root: field(status.root, 256, "status.root", clipped),
		generation: status.generation && field(status.generation, 100, "status.generation", clipped),
		failures,
		failuresTruncated: status.failuresTruncated || status.failures.length > failures.length,
		pendingPaths,
		pendingTruncated: status.pendingTruncated || status.pendingPaths.length > pendingPaths.length,
		uncertainReasons,
		uncertaintyTruncated: status.uncertaintyTruncated || status.uncertainReasons.length > uncertainReasons.length,
		exclusions,
	};
}

function boundedHit(hit: RepoTextHit, clipped: FieldTruncations): RepoTextHit;
function boundedHit(hit: RepoSymbolHit, clipped: FieldTruncations): RepoSymbolHit;
function boundedHit(hit: RepoTextHit | RepoSymbolHit, clipped: FieldTruncations): RepoTextHit | RepoSymbolHit {
	const path = field(hit.path, 160, "hits.path", clipped);
	if ("snippet" in hit) return { ...hit, path, snippet: field(hit.snippet, 180, "hits.snippet", clipped) };
	return {
		...hit,
		path,
		name: field(hit.name, 100, "hits.name", clipped),
		qualname: field(hit.qualname, 120, "hits.qualname", clipped),
		signature: hit.signature && field(hit.signature, 160, "hits.signature", clipped),
	};
}

function fieldTruncationLine(clipped: FieldTruncations): string | undefined {
	const entries = Object.entries(clipped);
	if (!entries.length) return;
	return `Fields truncated (partial values; paths may not be usable as locators): ${entries.map(([key, count]) => `${key} (${count})`).join(", ")}`;
}

function coverage(status: RepoStatus): string[] {
	const lines = [
		`Root: ${field(status.root, 256)}`,
		`Index: ${status.exists ? `generation ${status.generation ?? ""}` : "missing (open /repo to build it)"}; ${status.fileCount} files; ${status.symbolCount} symbols`,
		`Coverage: ${status.incomplete ? "incomplete" : "complete"}; ${status.unchecked ? "full scope unchecked" : "full scope checked"}; last full check ${status.lastFullCheck === null ? "never" : new Date(status.lastFullCheck).toISOString()}`,
		`Pending known paths: ${status.pendingCount}; failures/exclusions: ${status.failureCount}; uncertain changes: ${status.uncertainCount}`,
	];
	if (status.pendingPaths.length) {
		lines.push(
			`Pending: ${status.pendingPaths
				.slice(0, 5)
				.map(path => field(path, 160))
				.join(", ")}${status.pendingCount > 5 ? " …" : ""}`,
		);
	}
	if (status.failures.length) {
		for (const failure of status.failures.slice(0, 5)) {
			lines.push(`Failure: ${field(failure.path, 160)} (${failure.kind}): ${field(failure.message, 160)}`);
		}
		if (status.failureCount > 5) lines.push(`… ${status.failureCount - 5} more failures`);
	}
	if (status.uncertainReasons.length) {
		lines.push(
			`Uncertain: ${status.uncertainReasons
				.slice(0, 3)
				.map(reason => field(reason, 160))
				.join("; ")}${status.uncertainCount > 3 ? " …" : ""}`,
		);
	}
	if (status.exclusions.length)
		lines.push(
			`Excluded paths: ${status.exclusions
				.slice(0, 12)
				.map(path => field(path, 160))
				.join(", ")}${status.exclusions.length > 12 ? " …" : ""}`,
		);
	return lines;
}

function renderQuery(
	action: "search" | "symbol",
	query: string,
	result: RepoQueryResult<RepoTextHit | RepoSymbolHit>,
	clipped: FieldTruncations,
): string {
	const lines = coverage(result.coverage);
	if (result.status === "missing") {
		lines.push("No repository index exists. Open /repo to build one; use read/grep for current files meanwhile.");
		const summary = fieldTruncationLine(clipped);
		if (summary) lines.push(summary);
		return lines.join("\n");
	}
	lines.push(
		`${action === "search" ? "Text" : "Python symbols"} for "${field(query, 180, "query", clipped)}": ${result.hits.length} hit(s) on this page`,
	);
	for (const [index, hit] of result.hits.entries()) {
		const location = `${hit.path}:${hit.startLine}-${hit.endLine} [${hit.category}]`;
		if ("snippet" in hit) lines.push(`[${index + 1}] ${location} ${hit.snippet}`);
		else {
			lines.push(
				`[${index + 1}] ${location} ${hit.kind} ${hit.qualname}${hit.signature ? ` — ${hit.signature}` : ""}`,
			);
		}
	}
	if (!result.hits.length)
		lines.push("No indexed matches. Try another query or use grep for exhaustive/current file coverage.");
	for (const warning of result.warnings) lines.push(`Coverage warning: ${warning}`);
	if (result.cursor) lines.push(`Next cursor: ${result.cursor} (same action, query and filters)`);
	const summary = fieldTruncationLine(clipped);
	if (summary) lines.push(summary);
	return lines.join("\n");
}

export class RepoTool implements AgentTool<typeof repoSchema, RepoToolDetails> {
	readonly name = "repo";
	readonly approval = "read" as const;
	readonly label = "Repo";
	readonly loadMode = "essential" as const;
	readonly summary = "Inspect repository index coverage or search indexed text and Python symbols";
	readonly description = prompt.render(repoDescription);
	readonly parameters = repoSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: RepoToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		if (params.action !== "status" && (!params.query || !params.query.trim()))
			throw new ToolError(
				`repo ${params.action} requires query (e.g. {"action":"${params.action}","query":"Widget"}).`,
			);
		if (params.query && params.query.length > 500)
			throw new ToolError("Repository query exceeds 500 characters; narrow it.");
		const service = new RepoService({ agentDir: this.session.settings.getAgentDir(), cwd: this.session.cwd });
		try {
			if (params.action === "status") {
				const clipped: FieldTruncations = {};
				const status = boundedStatus(await service.status(), clipped);
				const lines = coverage(status);
				const summary = fieldTruncationLine(clipped);
				if (summary) lines.push(summary);
				return toolResult<RepoToolDetails>({ action: "status", status, fieldTruncations: clipped })
					.text(lines.join("\n"))
					.done();
			}
			const query = params.query!.trim();
			const options = {
				path: params.path,
				category: params.category,
				limit: params.limit,
				cursor: params.cursor,
				signal,
			};
			if (params.action === "search") {
				const result = await service.search(query, options);
				const clipped: FieldTruncations = {};
				const coverage = boundedStatus(result.coverage, clipped);
				const hits = result.hits.map(hit => boundedHit(hit, clipped));
				const warnings = result.warnings.slice(0, 10).map(warning => field(warning, 180, "warnings", clipped));
				return toolResult<RepoToolDetails>({
					action: "search",
					status: coverage,
					queryStatus: result.status,
					hits,
					cursor: result.cursor,
					truncated: result.truncated,
					warnings,
					fieldTruncations: clipped,
				})
					.text(renderQuery("search", query, { ...result, coverage, hits, warnings }, clipped))
					.done();
			}
			const result = await service.symbol(query, options);
			const clipped: FieldTruncations = {};
			const symbolCoverage = boundedStatus(result.coverage, clipped);
			const hits = result.hits.map(hit => boundedHit(hit, clipped));
			const warnings = result.warnings.slice(0, 10).map(warning => field(warning, 180, "warnings", clipped));
			return toolResult<RepoToolDetails>({
				action: "symbol",
				status: symbolCoverage,
				queryStatus: result.status,
				hits,
				cursor: result.cursor,
				truncated: result.truncated,
				warnings,
				fieldTruncations: clipped,
			})
				.text(renderQuery("symbol", query, { ...result, coverage: symbolCoverage, hits, warnings }, clipped))
				.done();
		} finally {
			service.close();
		}
	}
}
