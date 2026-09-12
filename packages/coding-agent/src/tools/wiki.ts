import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { sectionShape } from "../docs/markdown";
import { DocsService } from "../docs/service";
import wikiDescription from "../prompts/tools/wiki.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const wikiSchema = type({
	query: type("string").describe("keywords, or a whole question; results are ranked by relevance"),
	"+": "reject",
});

export type WikiToolParams = typeof wikiSchema.infer;

/**
 * Characters of stored Markdown one call returns. The search result is the
 * content, so the page is bounded by text: ~20000 characters is 10-12k tokens
 * on this corpus (measured 1.7-2.1 chars/token), enough for a dozen or more
 * sections while several searches still fit comfortably in one conversation.
 */
const TEXT_BUDGET_CHARS = 20_000;

/** Sections one call may return; the character budget normally binds first. */
const PAGE_SECTIONS = 200;

function lineRange(path: string, start: number, end: number): string {
	return `${path}:${start}-${end}`;
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
		// Argument validation is lenient so a stray extra key cannot fail a call;
		// `query` itself is still required, and the error names what arrived.
		const raw = params as Record<string, unknown>;
		const received = Object.keys(raw).filter(key => key !== "__parseError");
		const query = typeof raw.query === "string" && raw.query.trim() ? raw.query.trim() : undefined;
		if (!query)
			throw new ToolError(
				`wiki requires a query. Received: ${received.length > 0 ? received.join(", ") : "nothing"}. Example: {"query":"MBIST"}`,
			);

		const service = new DocsService({ agentDir: this.session.settings.getAgentDir(), cwd: this.session.cwd });
		try {
			if (service.list().length === 0)
				throw new ToolError('No document indexes. Run: omp docs init "<dir>" --name <name>');
			const result = service.search(query, { limit: PAGE_SECTIONS });
			if (result.sections.length === 0)
				throw new ToolError(`No section matches "${query}". Use one distinctive term rather than a sentence.`);

			const bodies: string[] = [];
			const seen = new Set<string>();
			let used = 0;
			let skippedForSize = 0;
			let duplicates = 0;
			for (const section of result.sections) {
				// Structural labels (`#### Cell`) hold nothing the header line does not
				// already carry. Indexes built before this rule keep them, so skip here;
				// a heading that reads as a real phrase is content and stays.
				const shape = sectionShape(section.text);
				if (shape === "stub") continue;
				const header = `[${bodies.length + 1}] ${lineRange(section.path, section.lineStart, section.lineEnd)} · ${section.headingPath} · sectionId=${section.sectionId}`;
				// The same text often ships in several documents (attachment copies,
				// re-exports). Repeating it spends the page on nothing new, so a later
				// copy is reduced to a pointer at the first one.
				const alreadyShown = section.text.length > 200 && seen.has(section.text);
				const body =
					shape === "heading-only"
						? "(heading only — the title above is the content)"
						: alreadyShown
							? "(identical text to an earlier hit on this page)"
							: section.text;
				// Headers are context too, so the whole rendered page counts.
				const cost = header.length + 1 + body.length + (bodies.length > 0 ? 2 : 0);
				if (used + cost > TEXT_BUDGET_CHARS) {
					// The best hit must never be lost to the budget: it is carried in
					// full even when it alone exceeds the page.
					if (bodies.length > 0) {
						skippedForSize += 1;
						continue;
					}
				}
				bodies.push(`${header}\n${body}`);
				used += cost;
				// Only text this page actually carries counts as shown: a section dropped
				// for size was never delivered, and a pointer to it would be a lie.
				seen.add(section.text);
				duplicates += alreadyShown ? 1 : 0;
			}
			// Every match is a stub: the document's first section is indexed on purpose
			// (its row is the only one carrying the relative path), and a name search
			// lands on it. Its header still locates the document — the text it would
			// have carried says no more — so the call answers instead of failing.
			if (bodies.length === 0) {
				for (const section of result.sections) {
					const header = `[${bodies.length + 1}] ${lineRange(section.path, section.lineStart, section.lineEnd)} · ${section.headingPath} · sectionId=${section.sectionId}`;
					if (used + header.length > TEXT_BUDGET_CHARS) break;
					bodies.push(header);
					used += header.length + 2;
				}
				// On this path the header is all a hit delivers, so one that did not fit
				// is withheld like any other section; the stub rule skipped these before
				// the budget was consulted, so nothing is counted twice.
				skippedForSize += result.sections.length - bodies.length;
			}
			if (bodies.length === 0) throw new ToolError(`Sections matching "${query}" carry no body text.`);

			// `total` counts every FTS row, the structural labels included, and those
			// never reach `bodies` by design: measured against `bodies` it reported a cut
			// page whenever a document title matched, and it swallowed the collapse note
			// whenever duplicates were the only reduction. What this page withholds is
			// what it dropped for size here, plus the hits the ranked page never reached
			// — hits the page did reach count as served even when they render no text.
			const beyondPage = result.total !== undefined ? Math.max(0, result.total - result.sections.length) : 0;
			const hidden = skippedForSize > 0 || beyondPage > 0;
			const scope =
				result.total !== undefined
					? `${result.total} matching section(s)`
					: `${result.sections.length}+ matching section(s)`;
			const skipped = skippedForSize > 0 ? ` (${skippedForSize} too long for what was left)` : "";
			const collapsed = duplicates > 0 ? ` (${duplicates} repeated hit(s) collapsed to a pointer)` : "";
			const footer = hidden
				? `\n… this page carries ${bodies.length} of ${result.total ?? result.sections.length} sections within ${TEXT_BUDGET_CHARS} characters${skipped}${collapsed}; search again with narrower terms for the rest.`
				: collapsed
					? `\n… this page carries ${bodies.length} matching section(s)${collapsed}.`
					: "";
			const text = [`"${query}" · ${scope} · ${used}/${TEXT_BUDGET_CHARS} characters`, ...bodies].join("\n\n");
			return toolResult()
				.text(text + footer)
				.done();
		} finally {
			service.close();
		}
	}
}
