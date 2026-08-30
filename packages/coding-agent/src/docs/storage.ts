import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { DocsEvidenceResult, DocsIndexMode, DocsIndexState, DocsIndexSummary } from "./types";

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS doc_indexes (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL,
 schema_id TEXT NOT NULL, schema_version INTEGER NOT NULL, schema_json TEXT NOT NULL, schema_hash TEXT NOT NULL,
 mode TEXT NOT NULL DEFAULT 'structured', state TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, indexed_at TEXT
);
CREATE TABLE IF NOT EXISTS documents (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 relative_path TEXT NOT NULL, title TEXT NOT NULL, source_kind TEXT NOT NULL, sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, mtime_ms REAL NOT NULL, status TEXT NOT NULL, last_error TEXT,
 UNIQUE(index_id, relative_path)
);
CREATE TABLE IF NOT EXISTS sections (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
 heading_path TEXT NOT NULL, heading_level INTEGER NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
 byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, raw_markdown TEXT NOT NULL,
 UNIQUE(document_id, ordinal)
);
CREATE TABLE IF NOT EXISTS entities (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, canonical_key TEXT NOT NULL, display_name TEXT NOT NULL,
 UNIQUE(index_id, kind, canonical_key)
);
CREATE TABLE IF NOT EXISTS entity_aliases (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE, alias TEXT NOT NULL, normalized_alias TEXT NOT NULL,
 UNIQUE(entity_id, normalized_alias)
);
CREATE TABLE IF NOT EXISTS assertions (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE, field TEXT NOT NULL,
 value_json TEXT NOT NULL, normalized_value TEXT NOT NULL, condition_text TEXT, normalized_condition TEXT NOT NULL DEFAULT '',
 UNIQUE(index_id, entity_id, field, normalized_value, normalized_condition)
);
CREATE TABLE IF NOT EXISTS relations (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE, predicate TEXT NOT NULL,
 target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE, condition_text TEXT,
 normalized_condition TEXT NOT NULL DEFAULT '',
 UNIQUE(index_id, source_entity_id, predicate, target_entity_id, normalized_condition)
);
CREATE TABLE IF NOT EXISTS evidence (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
 entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE, alias_id INTEGER REFERENCES entity_aliases(id) ON DELETE CASCADE,
 assertion_id INTEGER REFERENCES assertions(id) ON DELETE CASCADE, relation_id INTEGER REFERENCES relations(id) ON DELETE CASCADE,
 quote TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
 byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
 CHECK ((entity_id IS NOT NULL) + (alias_id IS NOT NULL) + (assertion_id IS NOT NULL) + (relation_id IS NOT NULL) = 1)
);
CREATE INDEX IF NOT EXISTS documents_index_status ON documents(index_id, status);
CREATE INDEX IF NOT EXISTS sections_index_document ON sections(index_id, document_id);
CREATE INDEX IF NOT EXISTS evidence_index_section ON evidence(index_id, section_id);
CREATE INDEX IF NOT EXISTS evidence_index_entity ON evidence(index_id, entity_id);
CREATE INDEX IF NOT EXISTS evidence_index_alias ON evidence(index_id, alias_id);
CREATE INDEX IF NOT EXISTS evidence_index_assertion ON evidence(index_id, assertion_id);
CREATE INDEX IF NOT EXISTS evidence_index_relation ON evidence(index_id, relation_id);
CREATE INDEX IF NOT EXISTS assertions_entity_field ON assertions(index_id, entity_id, field);
CREATE INDEX IF NOT EXISTS relations_source_predicate ON relations(index_id, source_entity_id, predicate);
CREATE INDEX IF NOT EXISTS relations_target_predicate ON relations(index_id, target_entity_id, predicate);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(section_id UNINDEXED, index_id UNINDEXED, relative_path, heading_path, body, content='', contentless_delete=1);
`;

const CONTENTLESS_FTS_SQL =
	"CREATE VIRTUAL TABLE sections_fts USING fts5(section_id UNINDEXED, index_id UNINDEXED, relative_path, heading_path, body, content='', contentless_delete=1)";

function normalizeFtsContent(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\u3400-\u4dbf\u4e00-\u9fff]/gu, character => ` ${character} `)
		.replace(/\s+/g, " ")
		.trim();
}

interface IndexRow {
	id: number;
	name: string;
	root_path: string;
	schema_id: string;
	schema_version: number;
	mode: DocsIndexMode;
	schema_json: string;
	schema_hash: string;
	state: DocsIndexState;
	last_error: string | null;
	created_at: string;
	updated_at: string;
	indexed_at: string | null;
}

interface SummaryCountRow extends IndexRow {
	document_count: number;
	partial_count: number;
	section_count: number;
	entity_count: number;
	assertion_count: number;
	relation_count: number;
}

export interface StoredIndex extends DocsIndexSummary {
	schemaJson: string;
}

const SUMMARY_SQL = `SELECT i.*,
 (SELECT count(*) FROM documents d WHERE d.index_id=i.id) document_count,
 (SELECT count(*) FROM documents d WHERE d.index_id=i.id AND d.status!='ready') partial_count,
 (SELECT count(*) FROM sections s WHERE s.index_id=i.id) section_count,
 (SELECT count(*) FROM entities e WHERE e.index_id=i.id) entity_count,
 (SELECT count(*) FROM assertions a WHERE a.index_id=i.id) assertion_count,
 (SELECT count(*) FROM relations r WHERE r.index_id=i.id) relation_count
 FROM doc_indexes i`;

function mapIndex(row: SummaryCountRow): StoredIndex {
	return {
		id: row.id,
		name: row.name,
		rootPath: row.root_path,
		schemaId: row.schema_id,
		schemaVersion: row.schema_version,
		schemaHash: row.schema_hash,
		schemaJson: row.schema_json,
		state: row.state,
		mode: row.mode,
		...(row.last_error ? { lastError: row.last_error } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.indexed_at ? { indexedAt: row.indexed_at } : {}),
		documentCount: row.document_count,
		partialCount: row.partial_count,
		sectionCount: row.section_count,
		entityCount: row.entity_count,
		assertionCount: row.assertion_count,
		relationCount: row.relation_count,
	};
}

export class DocsStorage {
	readonly db: Database;
	readonly path: string;

	constructor(dbPath: string) {
		this.path = dbPath;
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath, { create: true, strict: true });
		chmodSync(dbPath, 0o600);
		this.db.run("PRAGMA busy_timeout=5000");
		const version =
			(this.db.query("PRAGMA user_version").get() as { user_version: number } | null)?.user_version ?? 0;
		if (version > SCHEMA_VERSION) {
			this.db.close();
			throw new Error(
				`Document index database version ${version} is newer than supported version ${SCHEMA_VERSION}`,
			);
		}
		try {
			this.db.exec(SCHEMA_SQL);
		} catch (error) {
			this.db.close();
			const message = error instanceof Error ? error.message : String(error);
			if (/fts5/i.test(message)) throw new Error(`Document indexing requires SQLite FTS5: ${message}`);
			throw error;
		}
		if (version === 1) this.db.run("ALTER TABLE doc_indexes ADD COLUMN mode TEXT NOT NULL DEFAULT 'structured'");
		if (version > 0 && version < 3) {
			const rows = this.db
				.query(`SELECT s.id section_id,s.index_id,d.relative_path,s.ordinal,s.heading_path,s.raw_markdown
				 FROM sections s JOIN documents d ON d.id=s.document_id ORDER BY s.id`)
				.all() as Array<{
				section_id: number;
				index_id: number;
				relative_path: string;
				ordinal: number;
				heading_path: string;
				raw_markdown: string;
			}>;
			const hasPlainText = (this.db.query("PRAGMA table_info(sections)").all() as Array<{ name: string }>).some(
				column => column.name === "plain_text",
			);
			this.transaction(() => {
				this.db.run("DROP TABLE sections_fts");
				this.db.run(CONTENTLESS_FTS_SQL);
				const insert = this.db.query(
					"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
				);
				for (const row of rows)
					insert.run(
						row.section_id,
						row.section_id,
						row.index_id,
						row.ordinal === 0 ? normalizeFtsContent(row.relative_path) : "",
						normalizeFtsContent(row.heading_path),
						normalizeFtsContent(row.raw_markdown),
					);
				if (hasPlainText) this.db.run("ALTER TABLE sections DROP COLUMN plain_text");
			});
			this.db.run("VACUUM");
		}
		if (version < SCHEMA_VERSION) this.db.run(`PRAGMA user_version=${SCHEMA_VERSION}`);
	}

	static open(agentDir: string): DocsStorage {
		return new DocsStorage(path.join(agentDir, "docs.db"));
	}

	close(): void {
		this.db.close();
	}

	list(): StoredIndex[] {
		return (
			this.db
				.query(`${SUMMARY_SQL} WHERE i.name NOT LIKE '__building__%' ORDER BY i.name`)
				.all() as SummaryCountRow[]
		).map(mapIndex);
	}

	get(name: string): StoredIndex | undefined {
		const row = this.db
			.query(`${SUMMARY_SQL} WHERE i.name=? AND i.name NOT LIKE '__building__%'`)
			.get(name) as SummaryCountRow | null;
		return row ? mapIndex(row) : undefined;
	}

	getById(id: number): StoredIndex | undefined {
		const row = this.db.query(`${SUMMARY_SQL} WHERE i.id=?`).get(id) as SummaryCountRow | null;
		return row ? mapIndex(row) : undefined;
	}

	create(input: {
		name: string;
		rootPath: string;
		schemaId: string;
		schemaVersion: number;
		schemaJson: string;
		schemaHash: string;
		mode: DocsIndexMode;
	}): StoredIndex {
		const now = new Date().toISOString();
		this.db
			.query(
				"INSERT INTO doc_indexes(name,root_path,schema_id,schema_version,schema_json,schema_hash,mode,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'building',?,?)",
			)
			.run(
				input.name,
				input.rootPath,
				input.schemaId,
				input.schemaVersion,
				input.schemaJson,
				input.schemaHash,
				input.mode,
				now,
				now,
			);
		const created = this.db.query("SELECT id FROM doc_indexes WHERE name=?").get(input.name) as { id: number };
		return this.getById(created.id) as StoredIndex;
	}

	setState(id: number, state: DocsIndexState, lastError?: string, indexed = false): void {
		const now = new Date().toISOString();
		this.db
			.query(
				"UPDATE doc_indexes SET state=?,last_error=?,updated_at=?,indexed_at=CASE WHEN ? THEN ? ELSE indexed_at END WHERE id=?",
			)
			.run(state, lastError ?? null, now, indexed ? 1 : 0, now, id);
	}

	remove(name: string): boolean {
		const row = this.db
			.query("SELECT id FROM doc_indexes WHERE name=? AND name NOT LIKE '__building__%'")
			.get(name) as { id: number } | null;
		if (!row) return false;
		this.removeById(row.id);
		return true;
	}

	removeById(id: number): void {
		this.transaction(() => {
			this.db.query("DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE index_id=?)").run(id);
			this.db.query("DELETE FROM doc_indexes WHERE id=?").run(id);
		});
	}

	promote(tempId: number, name: string, replacedId?: number): StoredIndex {
		return this.transaction(() => {
			if (replacedId !== undefined) {
				this.db
					.query("DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE index_id=?)")
					.run(replacedId);
				this.db.query("DELETE FROM doc_indexes WHERE id=?").run(replacedId);
			}
			this.db
				.query("UPDATE doc_indexes SET name=?,updated_at=? WHERE id=?")
				.run(name, new Date().toISOString(), tempId);
			return this.getById(tempId) as StoredIndex;
		});
	}

	transaction<T>(callback: () => T): T {
		return this.db.transaction(callback)();
	}

	garbageCollect(indexId: number): void {
		this.db
			.query(
				"DELETE FROM entity_aliases WHERE index_id=? AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.alias_id=entity_aliases.id)",
			)
			.run(indexId);
		this.db
			.query(
				"DELETE FROM assertions WHERE index_id=? AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.assertion_id=assertions.id)",
			)
			.run(indexId);
		this.db
			.query(
				"DELETE FROM relations WHERE index_id=? AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.relation_id=relations.id)",
			)
			.run(indexId);
		this.db
			.query(`DELETE FROM entities WHERE index_id=?
		 AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.entity_id=entities.id)
		 AND NOT EXISTS(SELECT 1 FROM entity_aliases a JOIN evidence e ON e.alias_id=a.id WHERE a.entity_id=entities.id)
		 AND NOT EXISTS(SELECT 1 FROM assertions a JOIN evidence e ON e.assertion_id=a.id WHERE a.entity_id=entities.id)
		 AND NOT EXISTS(SELECT 1 FROM relations r JOIN evidence e ON e.relation_id=r.id WHERE r.source_entity_id=entities.id OR r.target_entity_id=entities.id)`)
			.run(indexId);
	}

	evidence(id: number): DocsEvidenceResult | undefined {
		const row = this.db
			.query(`SELECT e.id,i.name index_name,d.relative_path,s.heading_path,e.line_start,e.line_end,e.byte_start,e.byte_end,e.quote,e.confidence,s.raw_markdown
		 FROM evidence e JOIN doc_indexes i ON i.id=e.index_id JOIN sections s ON s.id=e.section_id JOIN documents d ON d.id=s.document_id WHERE e.id=? AND i.name NOT LIKE '__building__%'`)
			.get(id) as Record<string, unknown> | null;
		if (!row) return undefined;
		return {
			id: row.id as number,
			index: row.index_name as string,
			path: row.relative_path as string,
			headingPath: row.heading_path as string,
			lineStart: row.line_start as number,
			lineEnd: row.line_end as number,
			byteStart: row.byte_start as number,
			byteEnd: row.byte_end as number,
			quote: row.quote as string,
			confidence: row.confidence as number,
			rawMarkdown: row.raw_markdown as string,
		};
	}
}
