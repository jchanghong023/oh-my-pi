import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { DocsService } from "../docs/service";
import wikiDescription from "../prompts/tools/wiki.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const wikiSchema = type({
	op: type("'search' | 'read' | 'status'").describe("document research operation"),
	"index?": type("string").describe("index name selector"),
	"limit?": type("number").describe("maximum results (default 10, maximum 50)"),
	"query?": type("string").describe("search query"),
	"sectionId?": type("number").describe("section id to read"),
	"+": "reject",
});

export type WikiToolParams = typeof wikiSchema.infer;

function requireString(value: string | undefined, field: string, op: string): string {
	if (!value?.trim()) throw new ToolError(`wiki ${op} requires ${field}`);
	return value;
}

function lineRange(path: string, start: number, end: number): string {
	return `${path}:${start}-${end}`;
}

export class WikiTool implements AgentTool<typeof wikiSchema> {
	readonly name = "wiki";
	readonly approval = "read" as const;
	readonly label = "Wiki";
	readonly loadMode = "essential" as const;
	readonly summary = "Search and read indexed Markdown knowledge";
	readonly description = prompt.render(wikiDescription);
	readonly parameters = wikiSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: WikiToolParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		const service = new DocsService({ agentDir: this.session.settings.getAgentDir(), cwd: this.session.cwd });
		try {
			const indexes = service.list();
			if (indexes.length === 0) throw new ToolError("No document indexes. Run: omp docs init <dir> --name <name>");
			if (params.index && !indexes.some(index => index.name === params.index))
				throw new ToolError(`Unknown document index: ${params.index}`);
			if (params.op !== "status" && !params.index && indexes.length > 1)
				throw new ToolError(
					"Multiple document indexes are available; specify index to keep research corpus-scoped",
				);
			const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 10)));
			let text: string;
			switch (params.op) {
				case "search": {
					const result = service.search(requireString(params.query, "query", params.op), {
						index: params.index,
						limit,
					});
					const lines = ["Sections:"];
					for (const section of result.sections)
						lines.push(
							`[${section.index}] section ${section.sectionId} ${lineRange(section.path, section.lineStart, section.lineEnd)} ${section.headingPath}\n${section.excerpt}`,
						);
					text = lines.join("\n");
					break;
				}
				case "read": {
					if (params.sectionId === undefined) throw new ToolError("wiki read requires sectionId");
					const result = service.read({
						sectionId: params.sectionId,
						index: params.index,
					});
					text = `[${result.index}] section ${result.sectionId} ${lineRange(result.path, result.lineStart, result.lineEnd)} ${result.headingPath}\n${result.rawMarkdown}`;
					break;
				}
				case "status": {
					const selected = params.index ? indexes.filter(index => index.name === params.index) : indexes;
					text = selected
						.map(
							index =>
								`[${index.name}] ${index.state} documents=${index.documentCount} partial=${index.partialCount} sections=${index.sectionCount}${index.lastError ? ` error=${index.lastError}` : ""}`,
						)
						.join("\n");
					break;
				}
			}
			return toolResult().text(text).done();
		} finally {
			service.close();
		}
	}
}
