import { type Api, type ApiKey, type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { DocsExtractor, DocsExtractorContext, DocumentExtraction, ExtractionEvidence } from "./types";

function completionText(content: AssistantMessage["content"]): string {
	return content
		.flatMap(block => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

function parsePayload(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	return JSON.parse((fenced ?? text).trim());
}

function evidence(value: unknown, source: string): ExtractionEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${source}.evidence must be an object`);
	const item = value as Record<string, unknown>;
	if (typeof item.quote !== "string" || item.quote.length === 0)
		throw new Error(`${source}.evidence.quote must be non-empty`);
	if (
		!Number.isInteger(item.lineStart) ||
		!Number.isInteger(item.lineEnd) ||
		(item.lineStart as number) < 1 ||
		(item.lineEnd as number) < (item.lineStart as number)
	) {
		throw new Error(`${source}.evidence line range is invalid`);
	}
	if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1)
		throw new Error(`${source}.evidence.confidence must be in [0,1]`);
	return {
		quote: item.quote,
		lineStart: item.lineStart as number,
		lineEnd: item.lineEnd as number,
		confidence: item.confidence,
	};
}

function objectArray(value: unknown, key: string): Record<string, unknown>[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("extraction must be an object");
	const array = (value as Record<string, unknown>)[key];
	if (!Array.isArray(array)) throw new Error(`extraction.${key} must be an array`);
	return array.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new Error(`extraction.${key}[${index}] must be an object`);
		return item as Record<string, unknown>;
	});
}

function stringField(item: Record<string, unknown>, key: string, source: string): string {
	if (typeof item[key] !== "string" || (item[key] as string).trim() === "")
		throw new Error(`${source}.${key} must be non-empty`);
	return item[key] as string;
}

function valueMatchesType(value: unknown, type: "string" | "number" | "boolean" | "string[]" | "json"): boolean {
	if (type === "string") return typeof value === "string";
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	if (type === "boolean") return typeof value === "boolean";
	if (type === "string[]") return Array.isArray(value) && value.every(item => typeof item === "string");
	return value !== undefined;
}

export function validateDocumentExtraction(value: unknown, context: DocsExtractorContext): DocumentExtraction {
	const kinds = new Map(context.schema.entityKinds.map(kind => [kind.name, kind]));
	const predicates = new Map(context.schema.predicates.map(predicate => [predicate.name, predicate]));
	const localKinds = new Map<string, string>();
	const entities = objectArray(value, "entities").map((item, index) => {
		const source = `entities[${index}]`;
		const localId = stringField(item, "localId", source);
		if (localKinds.has(localId)) throw new Error(`${source}.localId is duplicated`);
		const kind = stringField(item, "kind", source);
		const schemaKind = kinds.get(kind);
		if (!schemaKind) throw new Error(`${source}.kind is unknown`);
		const identity = item.identity;
		if (!identity || typeof identity !== "object" || Array.isArray(identity))
			throw new Error(`${source}.identity must be an object`);
		const identityRecord = identity as Record<string, unknown>;
		for (const field of schemaKind.identity.fields) {
			if (!Object.hasOwn(identityRecord, field) || identityRecord[field] === "" || identityRecord[field] === null)
				throw new Error(`${source}.identity is missing ${field}`);
			const schemaField = schemaKind.fields.find(candidate => candidate.name === field);
			if (!schemaField || !valueMatchesType(identityRecord[field], schemaField.type))
				throw new Error(`${source}.identity.${field} must have its declared field type`);
		}
		if (!Array.isArray(item.aliases) || !item.aliases.every(alias => typeof alias === "string"))
			throw new Error(`${source}.aliases must be strings`);
		localKinds.set(localId, kind);
		return {
			localId,
			kind,
			identity: identityRecord,
			displayName: stringField(item, "displayName", source),
			aliases: item.aliases as string[],
			evidence: evidence(item.evidence, source),
		};
	});
	const assertions = objectArray(value, "assertions").map((item, index) => {
		const source = `assertions[${index}]`;
		const subjectLocalId = stringField(item, "subjectLocalId", source);
		const kindName = localKinds.get(subjectLocalId);
		if (!kindName) throw new Error(`${source}.subjectLocalId is unknown`);
		const field = stringField(item, "field", source);
		const schemaField = kinds.get(kindName)?.fields.find(candidate => candidate.name === field);
		if (!schemaField) throw new Error(`${source}.field is invalid for ${kindName}`);
		if (!Object.hasOwn(item, "value")) throw new Error(`${source}.value is missing`);
		if (!valueMatchesType(item.value, schemaField.type))
			throw new Error(`${source}.value must have type ${schemaField.type}`);
		if (item.condition !== undefined && typeof item.condition !== "string")
			throw new Error(`${source}.condition must be a string`);
		return {
			subjectLocalId,
			field,
			value: item.value,
			...(item.condition === undefined ? {} : { condition: item.condition }),
			evidence: evidence(item.evidence, source),
		};
	});
	const relations = objectArray(value, "relations").map((item, index) => {
		const source = `relations[${index}]`;
		const sourceLocalId = stringField(item, "sourceLocalId", source);
		const targetLocalId = stringField(item, "targetLocalId", source);
		const predicate = stringField(item, "predicate", source);
		const schemaPredicate = predicates.get(predicate);
		const sourceKind = localKinds.get(sourceLocalId);
		const targetKind = localKinds.get(targetLocalId);
		if (!sourceKind || !targetKind) throw new Error(`${source} references an unknown local entity`);
		if (!schemaPredicate?.sourceKinds.includes(sourceKind) || !schemaPredicate.targetKinds.includes(targetKind))
			throw new Error(`${source}.predicate is invalid for ${sourceKind} -> ${targetKind}`);
		if (item.condition !== undefined && typeof item.condition !== "string")
			throw new Error(`${source}.condition must be a string`);
		return {
			sourceLocalId,
			predicate,
			targetLocalId,
			...(item.condition === undefined ? {} : { condition: item.condition }),
			evidence: evidence(item.evidence, source),
		};
	});
	for (const entity of entities) {
		const kind = kinds.get(entity.kind);
		if (!kind) continue;
		for (const field of kind.fields) {
			if (!field.required || Object.hasOwn(entity.identity, field.name)) continue;
			if (
				!assertions.some(assertion => assertion.subjectLocalId === entity.localId && assertion.field === field.name)
			)
				throw new Error(`entity ${entity.localId} is missing required field ${field.name}`);
		}
	}
	return { entities, assertions, relations };
}

function numberedSection(context: DocsExtractorContext): string {
	return context.section.rawMarkdown
		.split(/\r?\n/)
		.map((line, index) => `${context.section.lineStart + index}: ${line}`)
		.join("\n");
}

function extractionPrompt(context: DocsExtractorContext, correction?: string): string {
	return [
		"Extract structured claims from this Markdown section. Return one JSON object only with arrays entities, assertions, relations. Never use markdown fences.",
		`Schema: ${JSON.stringify(context.schema)}`,
		"Payload shapes: entity={localId,kind,identity:{schemaIdentityField:value},displayName,aliases:string[],evidence}; assertion={subjectLocalId,field,value,condition?,evidence}; relation={sourceLocalId,predicate,targetLocalId,condition?,evidence}. identity MUST be a JSON object, never a string or array.",
		`Evidence shape={quote,lineStart,lineEnd,confidence}. Quote source verbatim; lineStart/lineEnd MUST be integers in the absolute range ${context.section.lineStart}..${context.section.lineEnd} shown below. Local ids exist only inside this payload.`,
		correction ? `Previous response was invalid: ${correction}. Correct it completely.` : "",
		`Document: ${context.document.relativePath}`,
		`Heading: ${context.section.headingPath.join(" > ")}`,
		"Numbered Markdown:",
		numberedSection(context),
	]
		.filter(Boolean)
		.join("\n\n");
}

export function createDocsExtractor(model: Model<Api>, apiKey: ApiKey): DocsExtractor {
	return async context => {
		let correction: string | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await completeSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: extractionPrompt(context, correction) }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey, maxTokens: 8192, temperature: 0, disableReasoning: true, signal: context.signal },
			);
			if (response.stopReason === "error") correction = response.errorMessage || "model error";
			else {
				try {
					return validateDocumentExtraction(parsePayload(completionText(response.content)), context);
				} catch (error) {
					correction = error instanceof Error ? error.message : String(error);
				}
			}
		}
		throw new Error(`Structured extraction failed after correction: ${correction}`);
	};
}

export async function resolveConfiguredDocsExtractor(
	settings: Settings,
	registry: ModelRegistry,
): Promise<DocsExtractor | undefined> {
	await registry.refresh();
	const selection = resolveRoleSelection(["task"], settings, registry.getAvailable());
	if (!selection?.model) return undefined;
	const apiKey = await registry.getApiKey(selection.model);
	return apiKey ? createDocsExtractor(selection.model, apiKey) : undefined;
}
