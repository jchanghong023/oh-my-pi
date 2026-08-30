import * as path from "node:path";
import { DFT_DOCUMENT_SCHEMA } from "./schemas/dft";
import type {
	DocumentEntityKind,
	DocumentFieldType,
	DocumentPredicate,
	DocumentSchemaV1,
	ResolvedDocumentSchema,
} from "./types";

const TOP_LEVEL_KEYS = ["id", "version", "title", "description", "instructions", "entityKinds", "predicates"] as const;
const FIELD_TYPES: Record<DocumentFieldType, true> = {
	string: true,
	number: true,
	boolean: true,
	"string[]": true,
	json: true,
};
const IDENTITY_SCOPES: Record<DocumentEntityKind["identity"]["scope"], true> = {
	global: true,
	document: true,
	section: true,
	parent: true,
};

function fail(source: string, message: string): never {
	throw new Error(`Invalid document schema ${source}: ${message}`);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], source: string): void {
	const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
	if (unexpected.length > 0) fail(source, `unexpected key(s): ${unexpected.join(", ")}`);
}

function nonEmptyString(value: unknown, source: string): string {
	if (typeof value !== "string" || value.trim() === "") fail(source, "must be a non-empty string");
	return value;
}

function uniqueNames(values: readonly { name: string }[], source: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value.name)) fail(source, `duplicate name ${JSON.stringify(value.name)}`);
		seen.add(value.name);
	}
}

function parseKind(value: unknown, source: string): DocumentEntityKind {
	const input = record(value) ?? fail(source, "entity kind must be an object");
	exactKeys(input, ["name", "description", "identity", "fields"], source);
	const name = nonEmptyString(input.name, `${source}.name`);
	const description = nonEmptyString(input.description, `${source}.description`);
	const identity = record(input.identity) ?? fail(`${source}.identity`, "must be an object");
	exactKeys(identity, ["scope", "fields", "parentKind", "parentPredicate"], `${source}.identity`);
	if (
		typeof identity.scope !== "string" ||
		!IDENTITY_SCOPES[identity.scope as DocumentEntityKind["identity"]["scope"]]
	) {
		fail(`${source}.identity.scope`, "must be global, document, section, or parent");
	}
	if (!Array.isArray(identity.fields) || identity.fields.length === 0) {
		fail(`${source}.identity.fields`, "must be a non-empty string array");
	}
	const identityFields = identity.fields.map((field, index) =>
		nonEmptyString(field, `${source}.identity.fields[${index}]`),
	);
	if (!Array.isArray(input.fields)) fail(`${source}.fields`, "must be an array");
	const fields = input.fields.map((fieldValue, index) => {
		const fieldSource = `${source}.fields[${index}]`;
		const field = record(fieldValue) ?? fail(fieldSource, "must be an object");
		exactKeys(field, ["name", "type", "description", "required"], fieldSource);
		const fieldName = nonEmptyString(field.name, `${fieldSource}.name`);
		if (typeof field.type !== "string" || !FIELD_TYPES[field.type as DocumentFieldType]) {
			fail(`${fieldSource}.type`, "unsupported field type");
		}
		if (field.required !== undefined && typeof field.required !== "boolean") {
			fail(`${fieldSource}.required`, "must be boolean");
		}
		return {
			name: fieldName,
			type: field.type as DocumentFieldType,
			description: nonEmptyString(field.description, `${fieldSource}.description`),
			...(field.required === undefined ? {} : { required: field.required }),
		};
	});
	uniqueNames(fields, `${source}.fields`);
	const fieldNames = new Set(fields.map(field => field.name));
	for (const field of identityFields) {
		if (!fieldNames.has(field)) fail(`${source}.identity.fields`, `unknown field ${JSON.stringify(field)}`);
	}
	const scope = identity.scope as DocumentEntityKind["identity"]["scope"];
	if (scope === "parent") {
		nonEmptyString(identity.parentKind, `${source}.identity.parentKind`);
		nonEmptyString(identity.parentPredicate, `${source}.identity.parentPredicate`);
	} else if (identity.parentKind !== undefined || identity.parentPredicate !== undefined) {
		fail(`${source}.identity`, "parentKind/parentPredicate are valid only for parent scope");
	}
	return {
		name,
		description,
		identity: {
			scope,
			fields: identityFields,
			...(identity.parentKind === undefined ? {} : { parentKind: identity.parentKind as string }),
			...(identity.parentPredicate === undefined ? {} : { parentPredicate: identity.parentPredicate as string }),
		},
		fields,
	};
}

function parsePredicate(value: unknown, source: string): DocumentPredicate {
	const input = record(value) ?? fail(source, "predicate must be an object");
	exactKeys(input, ["name", "description", "sourceKinds", "targetKinds", "cardinality"], source);
	const kinds = (key: "sourceKinds" | "targetKinds") => {
		if (!Array.isArray(input[key]) || input[key].length === 0) fail(`${source}.${key}`, "must be a non-empty array");
		return input[key].map((kind, index) => nonEmptyString(kind, `${source}.${key}[${index}]`));
	};
	if (input.cardinality !== undefined && input.cardinality !== "one" && input.cardinality !== "many")
		fail(`${source}.cardinality`, "must be one or many");
	return {
		name: nonEmptyString(input.name, `${source}.name`),
		description: nonEmptyString(input.description, `${source}.description`),
		sourceKinds: kinds("sourceKinds"),
		targetKinds: kinds("targetKinds"),
		...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
	};
}

export function validateDocumentSchema(value: unknown, source = "<value>"): DocumentSchemaV1 {
	const input = record(value) ?? fail(source, "top level must be an object");
	exactKeys(input, TOP_LEVEL_KEYS, source);
	if (input.version !== 1) fail(source, `unsupported version ${JSON.stringify(input.version)}; expected 1`);
	if (!Array.isArray(input.instructions) || !input.instructions.every(item => typeof item === "string")) {
		fail(source, "instructions must be a string array");
	}
	if (!Array.isArray(input.entityKinds) || input.entityKinds.length === 0)
		fail(source, "entityKinds must be non-empty");
	if (!Array.isArray(input.predicates)) fail(source, "predicates must be an array");
	const entityKinds = input.entityKinds.map((kind, index) => parseKind(kind, `${source}.entityKinds[${index}]`));
	const predicates = input.predicates.map((predicate, index) =>
		parsePredicate(predicate, `${source}.predicates[${index}]`),
	);
	uniqueNames(entityKinds, `${source}.entityKinds`);
	uniqueNames(predicates, `${source}.predicates`);
	const kindNames = new Set(entityKinds.map(kind => kind.name));
	const predicateByName = new Map(predicates.map(predicate => [predicate.name, predicate]));
	for (const predicate of predicates) {
		for (const kind of [...predicate.sourceKinds, ...predicate.targetKinds]) {
			if (!kindNames.has(kind)) fail(source, `predicate ${predicate.name} references unknown kind ${kind}`);
		}
	}
	for (const kind of entityKinds) {
		if (kind.identity.scope !== "parent") continue;
		const parentKind = kind.identity.parentKind as string;
		const parentPredicate = kind.identity.parentPredicate as string;
		if (!kindNames.has(parentKind)) fail(source, `${kind.name} references unknown parent kind ${parentKind}`);
		const predicate = predicateByName.get(parentPredicate);
		if (!predicate) fail(source, `${kind.name} references unknown parent predicate ${parentPredicate}`);
		if (!predicate.sourceKinds.includes(parentKind) || !predicate.targetKinds.includes(kind.name)) {
			fail(
				source,
				`${kind.name} parent predicate ${parentPredicate} does not connect ${parentKind} to ${kind.name}`,
			);
		}
	}
	return {
		id: nonEmptyString(input.id, `${source}.id`),
		version: 1,
		title: nonEmptyString(input.title, `${source}.title`),
		description: nonEmptyString(input.description, `${source}.description`),
		instructions: [...(input.instructions as string[])],
		entityKinds,
		predicates,
	};
}

function stableJson(value: unknown): string {
	const normalize = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(normalize);
		if (!item || typeof item !== "object") return item;
		return Object.fromEntries(
			Object.entries(item as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, normalize(child)]),
		);
	};
	return JSON.stringify(normalize(value));
}

async function hashJson(json: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
	return Buffer.from(digest).toString("hex");
}

export async function resolveDocumentSchema(ref: string | undefined, cwd: string): Promise<ResolvedDocumentSchema> {
	const source = !ref || ref === "dft" ? "embedded" : path.resolve(cwd, ref);
	let value: unknown = DFT_DOCUMENT_SCHEMA;
	if (source !== "embedded") {
		try {
			value = JSON.parse(await Bun.file(source).text());
		} catch (error) {
			throw new Error(
				`Cannot load document schema ${source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const schema = validateDocumentSchema(value, source === "embedded" ? "embedded dft" : source);
	const json = stableJson(schema);
	return { schema, json, hash: await hashJson(json), source };
}
