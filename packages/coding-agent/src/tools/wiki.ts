import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { DocsService } from "../docs/service";
import wikiDescription from "../prompts/tools/wiki.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const wikiSchema = type({
	op: type("'search' | 'lookup' | 'relations' | 'read' | 'conflicts' | 'status'").describe(
		"document research operation",
	),
	"index?": type("string").describe("index name selector"),
	"limit?": type("number").describe("maximum results (default 10, maximum 50)"),
	"query?": type("string").describe("search query"),
	"key?": type("string").describe("canonical key, alias, display name, or entity id"),
	"entityId?": type("number").describe("entity id for relation traversal"),
	"evidenceId?": type("number").describe("evidence id to read"),
	"sectionId?": type("number").describe("section id to read"),
	"predicate?": type("string").describe("relation predicate filter"),
	"direction?": type("'in' | 'out' | 'both'").describe("relation direction"),
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

function render(value: unknown): string {
	return JSON.stringify(value);
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
			if (indexes.length === 0)
				throw new ToolError("No document indexes. Run: omp docs init <dir> --name <name> --mode fts");
			if (params.index && !indexes.some(index => index.name === params.index))
				throw new ToolError(`Unknown document index: ${params.index}`);
			if (params.op !== "status" && !params.index && indexes.length > 1)
				throw new ToolError(
					"Multiple document indexes are available; specify index to keep research corpus-scoped",
				);
			const selectedIndex =
				params.index !== undefined ? indexes.find(index => index.name === params.index) : indexes[0];
			if (
				selectedIndex?.mode === "fts" &&
				params.op !== "status" &&
				params.op !== "search" &&
				params.op !== "read"
			) {
				throw new ToolError(`wiki ${params.op} requires a structured index; ${selectedIndex.name} is mode=fts`);
			}
			const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 10)));
			let text: string;
			switch (params.op) {
				case "search": {
					const result = service.search(requireString(params.query, "query", params.op), {
						index: params.index,
						limit,
					});
					const lines = ["Entities:"];
					for (const entity of result.entities)
						lines.push(
							`[${entity.index}] entity ${entity.entityId} ${entity.kind} ${entity.displayName} key=${entity.key}${entity.alias ? ` alias=${entity.alias}` : ""}`,
						);
					lines.push("Sections:");
					for (const section of result.sections)
						lines.push(
							`[${section.index}] section ${section.sectionId} ${lineRange(section.path, section.lineStart, section.lineEnd)} ${section.headingPath}\n${section.excerpt}`,
						);
					text = lines.join("\n");
					break;
				}
				case "lookup": {
					const entities = service.lookup(requireString(params.key, "key", params.op), { index: params.index });
					if (entities.length === 0) throw new ToolError(`No entity matches key: ${params.key}`);
					text = entities
						.map(entity => {
							const lines = [
								`[${entity.index}] entity ${entity.entityId} ${entity.kind} ${entity.displayName}`,
								`key=${entity.key}`,
								`aliases=${entity.aliases.join(", ") || "none"}`,
							];
							for (const assertion of entity.assertions) {
								lines.push(
									`${assertion.field}=${render(assertion.value)}${assertion.condition ? ` when ${assertion.condition}` : ""}`,
								);
								for (const evidence of assertion.evidence)
									lines.push(
										`  evidence ${evidence.id} ${lineRange(evidence.path, evidence.lineStart, evidence.lineEnd)} ${render(evidence.quote)}`,
									);
							}
							return lines.join("\n");
						})
						.join("\n\n");
					break;
				}
				case "relations": {
					if (!Number.isInteger(params.entityId)) throw new ToolError("wiki relations requires entityId");
					const relations = service.relations(params.entityId as number, {
						index: params.index,
						limit,
						predicate: params.predicate,
						direction: params.direction,
					});
					text = relations.length
						? relations
								.map(relation => {
									const lines = [
										`[${relation.index}] relation ${relation.id}: ${relation.sourceEntityId} ${relation.sourceName} --${relation.predicate}--> ${relation.targetEntityId} ${relation.targetName}${relation.condition ? ` when ${relation.condition}` : ""}`,
									];
									for (const evidence of relation.evidence)
										lines.push(
											`  evidence ${evidence.id} ${lineRange(evidence.path, evidence.lineStart, evidence.lineEnd)} ${render(evidence.quote)}`,
										);
									return lines.join("\n");
								})
								.join("\n")
						: "No matching relations.";
					break;
				}
				case "read": {
					if (params.evidenceId === undefined && params.sectionId === undefined)
						throw new ToolError("wiki read requires evidenceId or sectionId");
					if (params.evidenceId !== undefined && params.sectionId !== undefined)
						throw new ToolError("wiki read accepts only one of evidenceId or sectionId");
					const result = service.read({
						evidenceId: params.evidenceId,
						sectionId: params.sectionId,
						index: params.index,
					});
					text =
						"id" in result
							? `[${result.index}] evidence ${result.id} ${lineRange(result.path, result.lineStart, result.lineEnd)} ${result.headingPath}\n${result.quote}\n\nStored section:\n${result.rawMarkdown}`
							: `[${result.index}] section ${result.sectionId} ${lineRange(result.path, result.lineStart, result.lineEnd)} ${result.headingPath}\n${result.rawMarkdown}`;
					break;
				}
				case "conflicts": {
					const conflicts = service.conflicts({ index: params.index, limit });
					text = conflicts.length
						? conflicts
								.map(conflict => {
									const lines = [
										`[CONFLICT][${conflict.index}] entity ${conflict.subjectEntityId} ${conflict.subjectName} ${conflict.predicate}${conflict.condition ? ` when ${conflict.condition}` : ""}`,
									];
									for (const value of conflict.values) {
										lines.push(
											`  value=${render(value.value)}${value.targetEntityId ? ` target=${value.targetEntityId}` : ""}`,
										);
										for (const evidence of value.evidence)
											lines.push(
												`    evidence ${evidence.id} ${lineRange(evidence.path, evidence.lineStart, evidence.lineEnd)} ${render(evidence.quote)}`,
											);
									}
									return lines.join("\n");
								})
								.join("\n")
						: "No conflicts.";
					break;
				}
				case "status": {
					const selected = params.index ? indexes.filter(index => index.name === params.index) : indexes;
					text = selected
						.map(
							index =>
								`[${index.name}] ${index.state} mode=${index.mode} schema=${index.schemaId}@${index.schemaVersion} documents=${index.documentCount} partial=${index.partialCount} sections=${index.sectionCount} entities=${index.entityCount}${index.lastError ? ` error=${index.lastError}` : ""}`,
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
