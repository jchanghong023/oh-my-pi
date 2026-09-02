import * as path from "node:path";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { resolveConfiguredDocsExtractor } from "./extractor";
import { enumerateMarkdownFiles, readMarkdownDocument } from "./markdown";
import { resolveDocumentSchema, validateDocumentSchema } from "./schema";
import { DocsStorage, type StoredIndex } from "./storage";
import type {
	DocsBuildResult,
	DocsConflict,
	DocsEntityResult,
	DocsEvidenceResult,
	DocsExtractor,
	DocsIndexMode,
	DocsIndexSummary,
	DocsProgress,
	DocsRelationResult,
	DocsSearchResult,
	DocumentExtraction,
	DocumentSchemaV1,
	ExtractionEvidence,
	MarkdownDocument,
	MarkdownSection,
} from "./types";

export interface DocsServiceOptions {
	agentDir: string;
	cwd?: string;
	settings?: Settings;
	modelRegistry?: ModelRegistry;
	extractor?: DocsExtractor | null;
	maxConcurrency?: number;
}

export interface DocsBuildOptions {
	schema?: string;
	mode?: DocsIndexMode;
	signal?: AbortSignal;
	onProgress?: (progress: DocsProgress) => void;
}

interface SectionExtraction {
	section: MarkdownSection;
	payload?: DocumentExtraction;
	error?: string;
}

function normalizeIdentity(value: unknown): string {
	const text = typeof value === "string" ? value : stableJson(value);
	return text
		.normalize("NFKC")
		.trim()
		.replace(/\s+/g, " ")
		.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

function stableJson(value: unknown): string {
	const normalize = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(normalize);
		if (!item || typeof item !== "object") return item;
		return Object.fromEntries(
			Object.entries(item as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, normalize(child)]),
		);
	};
	return JSON.stringify(normalize(value));
}

function normalizeFts(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\u3400-\u4dbf\u4e00-\u9fff]/gu, character => ` ${character} `)
		.replace(/\s+/g, " ")
		.trim();
}

function ftsQuery(query: string): string {
	const tokens = normalizeFts(query).match(/[\u3400-\u4dbf\u4e00-\u9fff]|[\p{L}\p{N}_]+/gu) ?? [];
	return tokens.map(token => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}

function searchExcerpt(rawMarkdown: string, query: string): string {
	const text = rawMarkdown.replace(/\s+/gu, " ").trim();
	const matchAt = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
	const start = Math.max(0, (matchAt < 0 ? 0 : matchAt) - 100);
	const end = Math.min(text.length, start + 320);
	return `${start > 0 ? "… " : ""}${text.slice(start, end)}${end < text.length ? " …" : ""}`;
}

const BUILDING_INDEX_PREFIX = "__building__";

function validateName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Document index name must not be empty");
	if ([...trimmed].length > 64) throw new Error("Document index name must contain at most 64 Unicode scalar values");
	if (/\p{Cc}/u.test(trimmed)) throw new Error("Document index name must not contain control characters");
	if (trimmed.startsWith(BUILDING_INDEX_PREFIX))
		throw new Error(`Document index name uses reserved prefix: ${BUILDING_INDEX_PREFIX}`);
	return trimmed;
}

function abortError(): Error {
	const error = new Error("Document indexing cancelled");
	error.name = "AbortError";
	return error;
}

function evidenceLocation(
	section: MarkdownSection,
	evidence: ExtractionEvidence,
): { byteStart: number; byteEnd: number } | undefined {
	if (evidence.lineStart < section.lineStart || evidence.lineEnd > section.lineEnd) return undefined;
	const lines = section.rawMarkdown.match(/.*(?:\n|$)/g)?.filter(value => value !== "") ?? [];
	const localStart = evidence.lineStart - section.lineStart;
	const localEnd = evidence.lineEnd - section.lineStart;
	const selected = lines.slice(localStart, localEnd + 1).join("");
	if (!selected.includes(evidence.quote)) return undefined;
	const before = lines.slice(0, localStart).join("");
	const quoteOffset = selected.indexOf(evidence.quote);
	const byteStart = section.byteStart + Buffer.byteLength(before) + Buffer.byteLength(selected.slice(0, quoteOffset));
	return { byteStart, byteEnd: byteStart + Buffer.byteLength(evidence.quote) };
}

function indexFilter(index: string | undefined, alias = "i"): { sql: string; args: string[] } {
	const visible = ` AND ${alias}.state!='building'`;
	return index ? { sql: `${visible} AND ${alias}.name=?`, args: [index] } : { sql: visible, args: [] };
}

function publicIndex(index: StoredIndex): DocsIndexSummary {
	const { schemaJson: _schemaJson, ...summary } = index;
	return summary;
}

export class DocsService {
	readonly storage: DocsStorage;
	readonly cwd: string;
	readonly #settings?: Settings;
	readonly #modelRegistry?: ModelRegistry;
	readonly #configuredExtractor?: DocsExtractor | null;
	readonly #maxConcurrency: number;

	constructor(options: DocsServiceOptions) {
		this.storage = DocsStorage.open(options.agentDir);
		this.cwd = path.resolve(options.cwd ?? process.cwd());
		this.#settings = options.settings;
		this.#modelRegistry = options.modelRegistry;
		this.#configuredExtractor = options.extractor;
		this.#maxConcurrency = Math.max(1, Math.min(8, Math.floor(options.maxConcurrency ?? 8)));
	}

	close(): void {
		this.storage.close();
	}
	list(): DocsIndexSummary[] {
		return this.storage.list().map(publicIndex);
	}

	status(name?: string): DocsIndexSummary | DocsIndexSummary[] {
		if (!name) return this.list();
		const index = this.storage.get(name);
		if (!index) throw new Error(`Unknown document index: ${name}`);
		return publicIndex(index);
	}

	async init(
		directory: string,
		name: string,
		schemaRef?: string,
		options: DocsBuildOptions = {},
	): Promise<DocsBuildResult> {
		const storedName = validateName(name);
		if (this.storage.get(storedName)) throw new Error(`Document index already exists: ${storedName}`);
		const rootPath = path.resolve(this.cwd, directory);
		const files = await enumerateMarkdownFiles(rootPath);
		if (files.length === 0) throw new Error(`No Markdown files found in: ${rootPath}`);
		const resolved = await resolveDocumentSchema(schemaRef, this.cwd);
		return this.#buildAndPromote({
			publicName: storedName,
			rootPath,
			files,
			schema: resolved.schema,
			schemaJson: resolved.json,
			schemaHash: resolved.hash,
			mode: options.mode ?? "fts",
			options,
		});
	}

	async reinit(name: string, options: DocsBuildOptions = {}): Promise<DocsBuildResult> {
		const current = this.storage.get(name);
		if (!current) throw new Error(`Unknown document index: ${name}`);
		const files = await enumerateMarkdownFiles(current.rootPath);
		if (files.length === 0) throw new Error(`No Markdown files found in: ${current.rootPath}`);
		const resolved = options.schema
			? await resolveDocumentSchema(options.schema, this.cwd)
			: {
					schema: validateDocumentSchema(JSON.parse(current.schemaJson), `stored schema for ${name}`),
					json: current.schemaJson,
					hash: current.schemaHash,
				};
		return this.#buildAndPromote({
			publicName: current.name,
			rootPath: current.rootPath,
			files,
			schema: resolved.schema,
			schemaJson: resolved.json,
			schemaHash: resolved.hash,
			mode: options.mode ?? current.mode,
			options,
			replacedId: current.id,
		});
	}

	remove(name: string): void {
		if (!this.storage.remove(name)) throw new Error(`Unknown document index: ${name}`);
	}

	async #extractor(): Promise<DocsExtractor | undefined> {
		if (this.#configuredExtractor !== undefined) return this.#configuredExtractor ?? undefined;
		if (!this.#settings || !this.#modelRegistry) return undefined;
		return resolveConfiguredDocsExtractor(this.#settings, this.#modelRegistry);
	}

	async #buildAndPromote(input: {
		publicName: string;
		rootPath: string;
		files: string[];
		schema: DocumentSchemaV1;
		schemaJson: string;
		schemaHash: string;
		mode: DocsIndexMode;
		options: DocsBuildOptions;
		replacedId?: number;
	}): Promise<DocsBuildResult> {
		const temp = this.storage.create({
			name: `${BUILDING_INDEX_PREFIX}${crypto.randomUUID()}`,
			rootPath: input.rootPath,
			schemaId: input.schema.id,
			schemaVersion: input.schema.version,
			schemaJson: input.schemaJson,
			schemaHash: input.schemaHash,
			mode: input.mode,
		});
		try {
			const result = await this.#buildIndex(temp, input.schema, input.options, input.files);
			if (result.failed > 0)
				throw new Error(result.index.lastError ?? `${result.failed} document(s) failed structured extraction`);
			const promoted = this.storage.promote(temp.id, input.publicName, input.replacedId);
			return { ...result, index: publicIndex(promoted) };
		} catch (error) {
			if (this.storage.getById(temp.id)) this.storage.removeById(temp.id);
			throw error;
		}
	}

	async #buildIndex(
		index: StoredIndex,
		schema: DocumentSchemaV1,
		options: DocsBuildOptions,
		files: string[],
	): Promise<DocsBuildResult> {
		if (options.signal?.aborted) throw abortError();
		options.onProgress?.({ phase: "scan", total: files.length, completed: 0, failed: 0 });
		const extractor = index.mode === "structured" ? await this.#extractor() : undefined;
		if (index.mode === "structured" && !extractor)
			throw new Error("Structured indexing requires a configured task model and credential");
		const controller = new AbortController();
		const cancelWorkers = () => controller.abort();
		options.signal?.addEventListener("abort", cancelWorkers, { once: true });
		if (options.signal?.aborted) controller.abort();
		const signal = controller.signal;
		let cursor = 0;
		let completed = 0;
		let failed = 0;
		let firstError: unknown;
		let hasError = false;
		const runWorker = async () => {
			try {
				while (cursor < files.length) {
					if (signal.aborted) throw abortError();
					const relativePath = files[cursor++];
					const document = await readMarkdownDocument(index.rootPath, relativePath);
					options.onProgress?.({
						phase: index.mode === "structured" ? "extract" : "fts",
						total: files.length,
						completed,
						failed,
						currentPath: document.relativePath,
					});
					const extracted: SectionExtraction[] = [];
					for (const section of document.sections) {
						if (signal.aborted) throw abortError();
						if (!extractor) {
							extracted.push({ section });
							continue;
						}
						try {
							extracted.push({
								section,
								payload: await extractor({ schema, document, section, signal }),
							});
						} catch (error) {
							if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
								throw abortError();
							}
							extracted.push({ section, error: error instanceof Error ? error.message : String(error) });
						}
					}
					if (signal.aborted) throw abortError();
					const errors = this.#commitDocument(index.id, schema, document, extracted);
					if (errors.length > 0) failed++;
					completed++;
					options.onProgress?.({
						phase: "fts",
						total: files.length,
						completed,
						failed,
						currentPath: document.relativePath,
						...(errors.at(-1) ? { message: errors.at(-1) } : {}),
					});
				}
			} catch (error) {
				if (!hasError) {
					firstError = error;
					hasError = true;
				}
				controller.abort();
				throw error;
			}
		};
		try {
			const workers = Array.from({ length: Math.min(this.#maxConcurrency, Math.max(1, files.length)) }, runWorker);
			await Promise.allSettled(workers);
			if (hasError) throw firstError;
			if (signal.aborted) throw abortError();
		} finally {
			options.signal?.removeEventListener("abort", cancelWorkers);
		}
		options.onProgress?.({ phase: "cleanup", total: files.length, completed, failed });
		this.storage.transaction(() => this.storage.garbageCollect(index.id));
		const refreshed = this.storage.getById(index.id) as StoredIndex;
		const state = refreshed.partialCount > 0 ? "partial" : "ready";
		const partialError = this.storage.db
			.query("SELECT last_error FROM documents WHERE index_id=? AND status='partial' ORDER BY relative_path LIMIT 1")
			.get(index.id) as { last_error: string | null } | null;
		this.storage.setState(index.id, state, partialError?.last_error ?? undefined, true);
		return {
			index: publicIndex(this.storage.getById(index.id) as StoredIndex),
			processed: completed,
			failed,
		};
	}

	#commitDocument(
		indexId: number,
		schema: DocumentSchemaV1,
		document: MarkdownDocument,
		extractions: SectionExtraction[],
	): string[] {
		const errors = extractions.flatMap(item => (item.error ? [item.error] : []));
		this.storage.transaction(() => {
			const status = errors.length > 0 ? "partial" : "ready";
			const inserted = this.storage.db
				.query(
					"INSERT INTO documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms,status,last_error) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
				)
				.get(
					indexId,
					document.relativePath,
					document.title,
					document.sourceKind,
					document.sha256,
					document.sizeBytes,
					document.mtimeMs,
					status,
					errors.at(-1) ?? null,
				) as { id: number };
			for (const extraction of extractions) {
				const section = extraction.section;
				const sectionRow = this.storage.db
					.query(
						"INSERT INTO sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
					)
					.get(
						indexId,
						inserted.id,
						section.ordinal,
						section.headingPath.join(" > "),
						section.headingLevel,
						section.lineStart,
						section.lineEnd,
						section.byteStart,
						section.byteEnd,
						section.rawMarkdown,
					) as { id: number };
				this.storage.db
					.query("INSERT INTO sections_fts(section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?)")
					.run(
						sectionRow.id,
						indexId,
						section.ordinal === 0 ? normalizeFts(document.relativePath) : "",
						normalizeFts(section.headingPath.join(" > ")),
						normalizeFts(section.plainText),
					);
				if (extraction.payload)
					errors.push(
						...this.#commitExtraction(indexId, schema, document, section, sectionRow.id, extraction.payload),
					);
			}
		});
		if (errors.length > 0)
			this.storage.db
				.query("UPDATE documents SET status='partial',last_error=? WHERE index_id=? AND relative_path=?")
				.run(errors[errors.length - 1] as string, indexId, document.relativePath);
		return errors;
	}

	#commitExtraction(
		indexId: number,
		schema: DocumentSchemaV1,
		document: MarkdownDocument,
		section: MarkdownSection,
		sectionId: number,
		payload: DocumentExtraction,
	): string[] {
		const errors: string[] = [];
		const kindByName = new Map(schema.entityKinds.map(kind => [kind.name, kind]));
		const localById = new Map(payload.entities.map(entity => [entity.localId, entity]));
		const keyById = new Map<string, string>();
		const resolving = new Set<string>();
		const keyFor = (localId: string): string | undefined => {
			const cached = keyById.get(localId);
			if (cached) return cached;
			if (resolving.has(localId)) {
				errors.push(`Parent identity cycle at ${localId}`);
				return undefined;
			}
			const entity = localById.get(localId);
			const kind = entity && kindByName.get(entity.kind);
			if (!entity || !kind) return undefined;
			resolving.add(localId);
			const parts = kind.identity.fields.map(field => normalizeIdentity(entity.identity[field]));
			if (parts.some(part => !part)) {
				errors.push(`Missing identity for ${localId}`);
				resolving.delete(localId);
				return undefined;
			}
			let prefix = "";
			if (kind.identity.scope === "document") prefix = `${normalizeIdentity(document.relativePath)}\u001f`;
			else if (kind.identity.scope === "section")
				prefix = `${normalizeIdentity(document.relativePath)}\u001f${section.ordinal}\u001f${normalizeIdentity(section.headingPath)}\u001f`;
			else if (kind.identity.scope === "parent") {
				const parent = payload.relations.find(
					relation =>
						relation.predicate === kind.identity.parentPredicate &&
						relation.targetLocalId === localId &&
						localById.get(relation.sourceLocalId)?.kind === kind.identity.parentKind,
				);
				const parentKey = parent && keyFor(parent.sourceLocalId);
				if (!parentKey) {
					errors.push(`Missing parent identity for ${localId}`);
					resolving.delete(localId);
					return undefined;
				}
				prefix = `${parentKey}\u001f`;
			}
			const key = `${prefix}${parts.join("\u001f")}`;
			keyById.set(localId, key);
			resolving.delete(localId);
			return key;
		};
		const entityIds = new Map<string, number>();
		const insertEvidence = (
			target: "entity_id" | "alias_id" | "assertion_id" | "relation_id",
			targetId: number,
			evidence: ExtractionEvidence,
		) => {
			const location = evidenceLocation(section, evidence);
			if (!location) {
				errors.push(`Unverifiable evidence at ${document.relativePath}:${evidence.lineStart}-${evidence.lineEnd}`);
				return;
			}
			this.storage.db
				.query(
					`INSERT INTO evidence(index_id,section_id,${target},quote,line_start,line_end,byte_start,byte_end,confidence) VALUES(?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					indexId,
					sectionId,
					targetId,
					evidence.quote,
					evidence.lineStart,
					evidence.lineEnd,
					location.byteStart,
					location.byteEnd,
					evidence.confidence,
				);
		};
		for (const entity of payload.entities) {
			const key = keyFor(entity.localId);
			if (!key) continue;
			this.storage.db
				.query(
					"INSERT INTO entities(index_id,kind,canonical_key,display_name) VALUES(?,?,?,?) ON CONFLICT(index_id,kind,canonical_key) DO UPDATE SET display_name=excluded.display_name",
				)
				.run(indexId, entity.kind, key, entity.displayName);
			const stored = this.storage.db
				.query("SELECT id FROM entities WHERE index_id=? AND kind=? AND canonical_key=?")
				.get(indexId, entity.kind, key) as { id: number };
			entityIds.set(entity.localId, stored.id);
			insertEvidence("entity_id", stored.id, entity.evidence);
			for (const alias of entity.aliases) {
				const normalized = normalizeIdentity(alias);
				if (!normalized) continue;
				this.storage.db
					.query(
						"INSERT INTO entity_aliases(index_id,entity_id,alias,normalized_alias) VALUES(?,?,?,?) ON CONFLICT(entity_id,normalized_alias) DO UPDATE SET alias=excluded.alias",
					)
					.run(indexId, stored.id, alias, normalized);
				const aliasRow = this.storage.db
					.query("SELECT id FROM entity_aliases WHERE entity_id=? AND normalized_alias=?")
					.get(stored.id, normalized) as { id: number };
				insertEvidence("alias_id", aliasRow.id, entity.evidence);
			}
		}
		for (const assertion of payload.assertions) {
			const entityId = entityIds.get(assertion.subjectLocalId);
			if (!entityId) continue;
			const valueJson = stableJson(assertion.value);
			const normalizedValue = valueJson;
			const condition = assertion.condition?.trim() || "";
			this.storage.db
				.query(
					"INSERT OR IGNORE INTO assertions(index_id,entity_id,field,value_json,normalized_value,condition_text,normalized_condition) VALUES(?,?,?,?,?,?,?)",
				)
				.run(
					indexId,
					entityId,
					assertion.field,
					valueJson,
					normalizedValue,
					condition || null,
					normalizeIdentity(condition),
				);
			const row = this.storage.db
				.query(
					"SELECT id FROM assertions WHERE index_id=? AND entity_id=? AND field=? AND normalized_value=? AND normalized_condition=?",
				)
				.get(indexId, entityId, assertion.field, normalizedValue, normalizeIdentity(condition)) as { id: number };
			insertEvidence("assertion_id", row.id, assertion.evidence);
		}
		for (const relation of payload.relations) {
			const sourceId = entityIds.get(relation.sourceLocalId);
			const targetId = entityIds.get(relation.targetLocalId);
			if (!sourceId || !targetId) continue;
			const condition = relation.condition?.trim() || "";
			const normalizedCondition = normalizeIdentity(condition);
			this.storage.db
				.query(
					"INSERT OR IGNORE INTO relations(index_id,source_entity_id,predicate,target_entity_id,condition_text,normalized_condition) VALUES(?,?,?,?,?,?)",
				)
				.run(indexId, sourceId, relation.predicate, targetId, condition || null, normalizedCondition);
			const row = this.storage.db
				.query(
					"SELECT id FROM relations WHERE index_id=? AND source_entity_id=? AND predicate=? AND target_entity_id=? AND normalized_condition=?",
				)
				.get(indexId, sourceId, relation.predicate, targetId, normalizedCondition) as { id: number };
			insertEvidence("relation_id", row.id, relation.evidence);
		}
		return errors;
	}

	search(query: string, options: { index?: string; limit?: number } = {}): DocsSearchResult {
		const limit = Math.max(1, Math.min(50, options.limit ?? 10));
		const filter = indexFilter(options.index);
		const normalized = normalizeIdentity(query);
		const match = ftsQuery(query);
		const entitySql = `SELECT DISTINCT e.id entity_id,i.name index_name,e.kind,e.canonical_key,e.display_name,a.alias,a.normalized_alias
		 FROM entities e JOIN doc_indexes i ON i.id=e.index_id LEFT JOIN entity_aliases a ON a.entity_id=e.id
		 WHERE (e.canonical_key=? OR e.canonical_key LIKE ? OR a.normalized_alias=? OR a.normalized_alias LIKE ? OR e.display_name LIKE ?)${filter.sql}
		 ORDER BY CASE WHEN e.canonical_key=? OR a.normalized_alias=? THEN 0 ELSE 1 END,e.display_name LIMIT ?`;
		const entities = this.storage.db
			.query(entitySql)
			.all(
				normalized,
				`${normalized}%`,
				normalized,
				`${normalized}%`,
				`${query}%`,
				...filter.args,
				normalized,
				normalized,
				limit,
			) as Array<Record<string, unknown>>;
		let sections: Array<Record<string, unknown>> = [];
		if (match)
			sections = this.storage.db
				.query(`SELECT f.rowid section_id,i.name index_name,d.relative_path,s.heading_path,s.line_start,s.line_end,
				 s.raw_markdown excerpt,
				 bm25(sections_fts,0.0,0.0,0.5,2.0,1.0) rank
		 FROM sections_fts f JOIN sections s ON s.id=f.rowid JOIN documents d ON d.id=s.document_id JOIN doc_indexes i ON i.id=s.index_id
		 WHERE sections_fts MATCH ?${filter.sql} ORDER BY rank LIMIT ?`)
				.all(match, ...filter.args, limit) as Array<Record<string, unknown>>;
		return {
			entities: entities.map(row => ({
				entityId: row.entity_id as number,
				index: row.index_name as string,
				kind: row.kind as string,
				key: row.canonical_key as string,
				displayName: row.display_name as string,
				...(row.alias ? { alias: row.alias as string } : {}),
			})),
			sections: sections.map(row => ({
				sectionId: row.section_id as number,
				index: row.index_name as string,
				path: row.relative_path as string,
				headingPath: row.heading_path as string,
				lineStart: row.line_start as number,
				lineEnd: row.line_end as number,
				excerpt: searchExcerpt(row.excerpt as string, query),
				rank: row.rank as number,
			})),
		};
	}

	lookup(key: string, options: { index?: string } = {}): DocsEntityResult[] {
		const filter = indexFilter(options.index);
		const normalized = normalizeIdentity(key);
		const id = /^\d+$/.test(key) ? Number(key) : -1;
		const rows = this.storage.db
			.query(`SELECT DISTINCT e.id,i.name index_name,e.kind,e.canonical_key,e.display_name FROM entities e JOIN doc_indexes i ON i.id=e.index_id LEFT JOIN entity_aliases a ON a.entity_id=e.id
		 WHERE (e.id=? OR e.canonical_key=? OR a.normalized_alias=? OR e.display_name=?)${filter.sql} ORDER BY i.name,e.kind,e.display_name`)
			.all(id, normalized, normalized, key, ...filter.args) as Array<Record<string, unknown>>;
		return rows.map(row => {
			const entityId = row.id as number;
			const aliases = (
				this.storage.db
					.query("SELECT alias FROM entity_aliases WHERE entity_id=? ORDER BY alias")
					.all(entityId) as Array<{ alias: string }>
			).map(item => item.alias);
			const assertionRows = this.storage.db
				.query("SELECT id,field,value_json,condition_text FROM assertions WHERE entity_id=? ORDER BY field,id")
				.all(entityId) as Array<{ id: number; field: string; value_json: string; condition_text: string | null }>;
			return {
				entityId,
				index: row.index_name as string,
				kind: row.kind as string,
				key: row.canonical_key as string,
				displayName: row.display_name as string,
				aliases,
				assertions: assertionRows.map(assertion => ({
					field: assertion.field,
					value: JSON.parse(assertion.value_json),
					...(assertion.condition_text ? { condition: assertion.condition_text } : {}),
					evidence: this.#evidenceFor("assertion_id", assertion.id),
				})),
			};
		});
	}

	relations(
		entityId: number,
		options: { index?: string; predicate?: string; direction?: "in" | "out" | "both"; limit?: number } = {},
	): DocsRelationResult[] {
		const direction = options.direction ?? "both";
		const limit = Math.max(1, Math.min(50, options.limit ?? 10));
		const filter = indexFilter(options.index);
		const sides =
			direction === "in"
				? "r.target_entity_id=?"
				: direction === "out"
					? "r.source_entity_id=?"
					: "(r.source_entity_id=? OR r.target_entity_id=?)";
		const sideArgs = direction === "both" ? [entityId, entityId] : [entityId];
		const predicateSql = options.predicate ? " AND r.predicate=?" : "";
		const rows = this.storage.db
			.query(`SELECT r.id,i.name index_name,r.source_entity_id,se.display_name source_name,r.predicate,r.target_entity_id,te.display_name target_name,r.condition_text
		 FROM relations r JOIN doc_indexes i ON i.id=r.index_id JOIN entities se ON se.id=r.source_entity_id JOIN entities te ON te.id=r.target_entity_id
		 WHERE ${sides}${predicateSql}${filter.sql} ORDER BY r.predicate,se.display_name,te.display_name LIMIT ?`)
			.all(...sideArgs, ...(options.predicate ? [options.predicate] : []), ...filter.args, limit) as Array<
			Record<string, unknown>
		>;
		return rows.map(row => ({
			id: row.id as number,
			index: row.index_name as string,
			sourceEntityId: row.source_entity_id as number,
			sourceName: row.source_name as string,
			predicate: row.predicate as string,
			targetEntityId: row.target_entity_id as number,
			targetName: row.target_name as string,
			...(row.condition_text ? { condition: row.condition_text as string } : {}),
			evidence: this.#evidenceFor("relation_id", row.id as number),
		}));
	}

	read(options: { evidenceId?: number; sectionId?: number; index?: string }):
		| DocsEvidenceResult
		| {
				sectionId: number;
				index: string;
				path: string;
				headingPath: string;
				lineStart: number;
				lineEnd: number;
				rawMarkdown: string;
		  } {
		if (options.evidenceId !== undefined) {
			const result = this.storage.evidence(options.evidenceId);
			if (!result || (options.index && result.index !== options.index))
				throw new Error(`Unknown evidence: ${options.evidenceId}`);
			return result;
		}
		if (options.sectionId === undefined) throw new Error("read requires evidenceId or sectionId");
		const filter = indexFilter(options.index);
		const row = this.storage.db
			.query(
				`SELECT s.id,i.name index_name,d.relative_path,s.heading_path,s.line_start,s.line_end,s.raw_markdown
				 FROM sections s JOIN documents d ON d.id=s.document_id JOIN doc_indexes i ON i.id=s.index_id
				 WHERE s.id=?${filter.sql}`,
			)
			.get(options.sectionId, ...filter.args) as Record<string, unknown> | null;
		if (!row) throw new Error(`Unknown section: ${options.sectionId}`);
		return {
			sectionId: row.id as number,
			index: row.index_name as string,
			path: row.relative_path as string,
			headingPath: row.heading_path as string,
			lineStart: row.line_start as number,
			lineEnd: row.line_end as number,
			rawMarkdown: row.raw_markdown as string,
		};
	}

	conflicts(options: { index?: string; limit?: number } = {}): DocsConflict[] {
		const limit = Math.max(1, Math.min(50, options.limit ?? 10));
		const filter = indexFilter(options.index);
		const conflicts: DocsConflict[] = [];
		const assertionGroups = this.storage.db
			.query(`SELECT a.entity_id,e.display_name,i.name index_name,a.field,a.normalized_condition,count(DISTINCT a.normalized_value) variants
		 FROM assertions a JOIN entities e ON e.id=a.entity_id JOIN doc_indexes i ON i.id=a.index_id WHERE 1=1${filter.sql}
		 GROUP BY a.entity_id,a.field,a.normalized_condition HAVING variants>1 LIMIT ?`)
			.all(...filter.args, limit) as Array<{
			entity_id: number;
			display_name: string;
			index_name: string;
			field: string;
			normalized_condition: string;
		}>;
		for (const group of assertionGroups) {
			const rows = this.storage.db
				.query(
					"SELECT id,value_json,condition_text FROM assertions WHERE entity_id=? AND field=? AND normalized_condition=? ORDER BY id",
				)
				.all(group.entity_id, group.field, group.normalized_condition) as Array<{
				id: number;
				value_json: string;
				condition_text: string | null;
			}>;
			conflicts.push({
				index: group.index_name as string,
				subjectEntityId: group.entity_id as number,
				subjectName: group.display_name as string,
				predicate: group.field as string,
				...(rows[0]?.condition_text ? { condition: rows[0].condition_text } : {}),
				values: rows.map(row => ({
					value: JSON.parse(row.value_json),
					evidence: this.#evidenceFor("assertion_id", row.id),
				})),
			});
		}
		if (conflicts.length < limit) {
			const relationGroups = this.storage.db
				.query(`SELECT r.source_entity_id,e.display_name,i.name index_name,i.schema_json,r.predicate,r.normalized_condition,count(DISTINCT r.target_entity_id) variants
				 FROM relations r JOIN entities e ON e.id=r.source_entity_id JOIN doc_indexes i ON i.id=r.index_id WHERE 1=1${filter.sql}
				 GROUP BY r.source_entity_id,r.predicate,r.normalized_condition HAVING variants>1 LIMIT 200`)
				.all(...filter.args) as Array<{
				source_entity_id: number;
				display_name: string;
				index_name: string;
				schema_json: string;
				predicate: string;
				normalized_condition: string;
			}>;
			for (const group of relationGroups) {
				const schema = validateDocumentSchema(
					JSON.parse(group.schema_json),
					`stored schema for ${group.index_name}`,
				);
				if (schema.predicates.find(predicate => predicate.name === group.predicate)?.cardinality !== "one")
					continue;
				if (conflicts.length >= limit) break;
				const rows = this.storage.db
					.query(
						"SELECT id,target_entity_id,condition_text FROM relations WHERE source_entity_id=? AND predicate=? AND normalized_condition=? ORDER BY id",
					)
					.all(group.source_entity_id, group.predicate, group.normalized_condition) as Array<{
					id: number;
					target_entity_id: number;
					condition_text: string | null;
				}>;
				conflicts.push({
					index: group.index_name,
					subjectEntityId: group.source_entity_id,
					subjectName: group.display_name,
					predicate: group.predicate,
					...(rows[0]?.condition_text ? { condition: rows[0].condition_text } : {}),
					values: rows.map(row => ({
						value: row.target_entity_id,
						targetEntityId: row.target_entity_id,
						evidence: this.#evidenceFor("relation_id", row.id),
					})),
				});
			}
		}
		return conflicts;
	}

	#evidenceFor(column: "assertion_id" | "relation_id", id: number): DocsEvidenceResult[] {
		const rows = this.storage.db.query(`SELECT id FROM evidence WHERE ${column}=? ORDER BY id`).all(id) as Array<{
			id: number;
		}>;
		return rows.flatMap(row => {
			const evidence = this.storage.evidence(row.id);
			return evidence ? [evidence] : [];
		});
	}
}
