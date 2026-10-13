import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { truncateHeading } from "../docs/markdown";
import { DocsService } from "../docs/service";
import type { DocsSectionHit } from "../docs/types";
import wikiDescription from "../prompts/tools/wiki.md" with { type: "text" };
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const wikiSchema = type({
	query: type("string").describe("keywords, or a whole question; results are ranked by relevance"),
	"cursor?": type("string").describe("continuation from the previous page; keep query unchanged"),
	"+": "reject",
});

export type WikiToolParams = typeof wikiSchema.infer;

/**
 * Target for rendered Markdown per call, including locators and continuation.
 * The service carries the first section whole even when it exceeds this target.
 */
const TEXT_BUDGET_CHARS = 8_000;

/** Sections one call may return; the character budget normally binds first. */
const PAGE_SECTIONS = 200;

/**
 * Longest query served verbatim. The cut query is searched and echoed, so an
 * oversized input cannot spend the whole page on its header and continuation.
 */
const MAX_QUERY_CHARS = 500;

function lineRange(path: string, start: number, end: number): string {
	return `${path}:${start}-${end}`;
}

/**
 * Header line for one hit. The heading is bounded because an index built before
 * headings were capped can still carry a whole document as its heading, and the
 * header must not spend the page budget it exists to describe.
 */
function sectionHeader(index: number, section: DocsSectionHit): string {
	const heading = truncateHeading(section.headingPath);
	return sanitizeText(
		`[${index}] ${lineRange(section.path, section.lineStart, section.lineEnd)} · ${heading} · index=${section.index} · sha256=${section.documentHash} · sectionId=${section.sectionId} · match=${section.matchKind}`,
	).replace(/[\r\n\t]+/g, " ");
}

export class WikiTool implements AgentTool<typeof wikiSchema> {
	readonly name = "wiki";
	readonly approval = "read" as const;
	readonly label = "Wiki";
	readonly loadMode = "essential" as const;
	readonly summary = "Search the indexed Markdown corpus and return the matching text";
	readonly description = prompt.render(wikiDescription);
	readonly parameters = wikiSchema;
	readonly strict = true;
	/** Near-miss arguments are normalized in `execute`, not rejected up front. */
	readonly lenientArgValidation = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: WikiToolParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `wiki-${crypto.randomUUID()}`,
				tool_call_id: _toolCallId,
			},
			async () => {
				const started = performance.now();
				let stage = "validate";
				let expectedResult: string | undefined;
				let completion: Record<string, number | undefined> | undefined;
				const fields = { component: "wiki", event: "wiki.query" };
				logger.info("wiki.query.started", { ...fields, stage, result: "started" });
				try {
					// Argument validation is lenient so a stray extra key cannot fail a call;
					// `query` itself is still required, and the error names what arrived.
					const raw = params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
					const received = Object.keys(raw).filter(key => key !== "__parseError");
					const receivedQuery = typeof raw.query === "string" && raw.query.trim() ? raw.query.trim() : undefined;
					if (!receivedQuery) {
						expectedResult = "invalid_query";
						throw new ToolError(
							`wiki requires a query. Received: ${received.length > 0 ? received.join(", ") : "nothing"}. Example: {"query":"MBIST"}`,
						);
					}
					if ("cursor" in raw && (typeof raw.cursor !== "string" || !raw.cursor.trim())) {
						expectedResult = "invalid_cursor";
						throw new ToolError("wiki cursor must be a nonempty string returned by the previous page.");
					}
					const cursor = raw.cursor as string | undefined;
					const query =
						receivedQuery.length > MAX_QUERY_CHARS
							? truncateHeading(receivedQuery, MAX_QUERY_CHARS)
							: receivedQuery;
					logger.info("wiki.query.validated", {
						...fields,
						stage,
						result: "completed",
						query_length: query.length,
						query_truncated: receivedQuery.length > MAX_QUERY_CHARS,
						ignored_argument_count: received.filter(key => key !== "query" && key !== "cursor").length,
					});
					stage = "open";

					const service = new DocsService({
						agentDir: this.session.settings.getAgentDir(),
						cwd: this.session.cwd,
					});
					try {
						stage = "indexes";
						const indexCount = service.list().length;
						if (indexCount === 0) {
							expectedResult = "no_index";
							throw new ToolError('No document indexes. Run: omp docs init "<dir>" --name <name>');
						}
						logger.info("wiki.query.indexes", { ...fields, stage, result: "completed", index_count: indexCount });
						stage = "query";
						const header = `"${query}" · searched imported Markdown corpus`;
						// Reserve the query repeated in continuation JSON and bounded service
						// cursor/summary overhead; charge every rendered locator/body exactly.
						const footerAllowance = 512 + JSON.stringify({ query, cursor: "" }).length;
						const rendered: string[] = [];
						const shown = new Map<string, number>();
						let duplicates = 0;
						const result = service.search(query, {
							cursor,
							limit: PAGE_SECTIONS,
							characterBudget: Math.max(0, TEXT_BUDGET_CHARS - header.length - 2 - footerAllowance),
							sectionCost: (section, position) => {
								if (position === 0) {
									shown.clear();
									rendered.length = 0;
								}
								const earlier = section.text.length > 200 ? shown.get(section.text) : undefined;
								const body =
									earlier !== undefined
										? `(identical text to hit [${earlier + 1}] on this page)`
										: section.shape === "heading-only"
											? `(heading only)\n${section.text}`
											: section.shape === "stub"
												? `(structural label)\n${section.text}`
												: section.text;
								rendered[position] = `${sectionHeader(position + 1, section)}\n${body}`;
								if (earlier === undefined) shown.set(section.text, position);
								return rendered[position]!.length + (position > 0 ? 2 : 0);
							},
						});
						stage = "render";
						const bodies = rendered.slice(0, result.sections.length);
						duplicates = bodies.filter(body => body.includes("\n(identical text to hit [")).length;
						const evidence = [header, ...bodies].join("\n\n");
						const oversized = bodies.length > 0 && evidence.length + footerAllowance > TEXT_BUDGET_CHARS;
						const summary = [
							`${result.total} matching section(s) in the searched imported corpus; this page carries ${bodies.length}.`,
							result.technicalName
								? result.exactNameMatches > 0
									? `${result.exactNameMatches} exact-name section(s); other hits are related, not complete-name evidence.`
									: "未找到完整名称命中; any returned hits are related, not complete-name evidence."
								: undefined,
							result.total === 0
								? "0 matches does not establish that the information does not exist elsewhere."
								: undefined,
							duplicates > 0
								? `${duplicates} repeated hit(s) collapsed to a page-local pointer; all source locators retained.`
								: undefined,
							oversized
								? "The first section exceeds the ~8000-character target and is carried whole."
								: undefined,
							result.hasMore
								? `More results remain. Continue with the same query: ${JSON.stringify({ query, cursor: result.cursor })}`
								: "All matching results exhausted in the searched imported corpus.",
						].filter((line): line is string => line !== undefined);
						const text = `${evidence}\n\n${summary.join("\n")}`;
						completion = {
							match_count: result.total,
							section_count: result.sections.length,
							rendered_section_count: bodies.length,
							rendered_characters: text.length,
							duplicate_count: duplicates,
							oversize_count: oversized ? 1 : 0,
						};
						return toolResult().text(text).done();
					} finally {
						const operationStage = stage;
						const operationExpectedResult = expectedResult;
						stage = "close";
						expectedResult = undefined;
						service.close();
						stage = operationStage;
						expectedResult = operationExpectedResult;
						if (completion)
							logger.info("wiki.query.completed", {
								...fields,
								stage: "render",
								result: "completed",
								elapsed_ms: performance.now() - started,
								...completion,
							});
					}
				} catch (error) {
					const cancelled = error instanceof Error && error.name === "AbortError";
					const log = expectedResult || cancelled ? logger.info : logger.error;
					log("wiki.query.finished", {
						...fields,
						stage,
						result: cancelled ? "cancelled" : (expectedResult ?? "failed"),
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
	}
}
