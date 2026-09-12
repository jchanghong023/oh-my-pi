import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { DocsIndexSummary } from "./types";

const SCHEMA_VERSION = 5;

/** Indexes being built are named with this prefix and renamed once complete. */
export const BUILDING_INDEX_PREFIX = "__building__";

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS doc_indexes (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 relative_path TEXT NOT NULL, title TEXT NOT NULL, source_kind TEXT NOT NULL, sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, mtime_ms REAL NOT NULL,
 UNIQUE(index_id, relative_path)
);
CREATE TABLE IF NOT EXISTS sections (
 id INTEGER PRIMARY KEY, index_id INTEGER NOT NULL REFERENCES doc_indexes(id) ON DELETE CASCADE,
 document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
 heading_path TEXT NOT NULL, heading_level INTEGER NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
 byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, raw_markdown TEXT NOT NULL,
 UNIQUE(document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS sections_index_document ON sections(index_id, document_id);
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
}

interface SummaryCountRow extends IndexRow {
	document_count: number;
	section_count: number;
}

const SUMMARY_SQL = `SELECT i.id,i.name,i.root_path,
 (SELECT count(*) FROM documents d WHERE d.index_id=i.id) document_count,
 (SELECT count(*) FROM sections s WHERE s.index_id=i.id) section_count
 FROM doc_indexes i`;

function mapIndex(row: SummaryCountRow): DocsIndexSummary {
	return {
		id: row.id,
		name: row.name,
		rootPath: row.root_path,
		documentCount: row.document_count,
		sectionCount: row.section_count,
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
			if (version > 0 && version < SCHEMA_VERSION) {
				this.transaction(() => {
					if (version < 3) {
						this.db.run("DROP TABLE sections_fts");
						this.db.run(CONTENTLESS_FTS_SQL);
						const insert = this.db.query(
							"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
						);
						const rows = this.db
							.query(`SELECT s.id,s.index_id,d.relative_path,s.ordinal,s.heading_path,s.raw_markdown
							FROM sections s JOIN documents d ON d.id=s.document_id ORDER BY s.id`)
							.iterate() as Iterable<{
							id: number;
							index_id: number;
							relative_path: string;
							ordinal: number;
							heading_path: string;
							raw_markdown: string;
						}>;
						for (const row of rows)
							insert.run(
								row.id,
								row.id,
								row.index_id,
								row.ordinal === 0 ? normalizeFtsContent(row.relative_path) : "",
								normalizeFtsContent(row.heading_path),
								normalizeFtsContent(row.raw_markdown),
							);
					}
					for (const table of ["evidence", "entity_aliases", "assertions", "relations", "entities"])
						this.db.run(`DROP TABLE IF EXISTS ${table}`);
					const columns = this.db.query("PRAGMA table_info(doc_indexes)").all() as Array<{ name: string }>;
					for (const column of ["schema_id", "schema_version", "schema_json", "schema_hash", "mode"])
						if (columns.some(item => item.name === column))
							this.db.run(`ALTER TABLE doc_indexes DROP COLUMN ${column}`);
					const sectionColumns = this.db.query("PRAGMA table_info(sections)").all() as Array<{ name: string }>;
					if (sectionColumns.some(column => column.name === "plain_text"))
						this.db.run("ALTER TABLE sections DROP COLUMN plain_text");
					if (version < 5) {
						// Indexes carry no state or timestamps: a half-built index is hidden
						// by its `__building__` name alone.
						this.db.run("DROP INDEX IF EXISTS documents_index_status");
						const indexColumns = this.db.query("PRAGMA table_info(doc_indexes)").all() as Array<{ name: string }>;
						for (const column of ["state", "last_error", "created_at", "updated_at", "indexed_at"])
							if (indexColumns.some(item => item.name === column))
								this.db.run(`ALTER TABLE doc_indexes DROP COLUMN ${column}`);
						const documentColumns = this.db.query("PRAGMA table_info(documents)").all() as Array<{
							name: string;
						}>;
						for (const column of ["status", "last_error"])
							if (documentColumns.some(item => item.name === column))
								this.db.run(`ALTER TABLE documents DROP COLUMN ${column}`);
					}
					this.db.run(`PRAGMA user_version=${SCHEMA_VERSION}`);
				});
			} else if (version === 0) this.db.run(`PRAGMA user_version=${SCHEMA_VERSION}`);
		} catch (error) {
			this.db.close();
			const message = error instanceof Error ? error.message : String(error);
			if (/fts5/i.test(message)) throw new Error(`Document indexing requires SQLite FTS5: ${message}`);
			throw error;
		}
	}

	/**
	 * Visible indexes only: an import builds under a `__building__` name and is
	 * renamed once it is complete, so the prefix is the whole visibility rule.
	 */
	list(): DocsIndexSummary[] {
		return (
			this.db
				.query(`${SUMMARY_SQL} WHERE i.name NOT GLOB ? ORDER BY i.name`)
				.all(`${BUILDING_INDEX_PREFIX}*`) as SummaryCountRow[]
		).map(mapIndex);
	}

	get(name: string): DocsIndexSummary | undefined {
		const row = this.db
			.query(`${SUMMARY_SQL} WHERE i.name=? AND i.name NOT GLOB ?`)
			.get(name, `${BUILDING_INDEX_PREFIX}*`) as SummaryCountRow | null;
		return row ? mapIndex(row) : undefined;
	}

	getById(id: number): DocsIndexSummary | undefined {
		const row = this.db.query(`${SUMMARY_SQL} WHERE i.id=?`).get(id) as SummaryCountRow | null;
		return row ? mapIndex(row) : undefined;
	}

	create(input: { name: string; rootPath: string }): DocsIndexSummary {
		this.db.query("INSERT INTO doc_indexes(name,root_path) VALUES(?,?)").run(input.name, input.rootPath);
		const created = this.db.query("SELECT id FROM doc_indexes WHERE name=?").get(input.name) as { id: number };
		return this.getById(created.id) as DocsIndexSummary;
	}

	/** Drop every half-built index: `init` calls this before starting a new one. */
	removeAbandoned(): void {
		const rows = this.db
			.query("SELECT id FROM doc_indexes WHERE name GLOB ?")
			.all(`${BUILDING_INDEX_PREFIX}*`) as Array<{ id: number }>;
		for (const row of rows) this.removeById(row.id);
	}

	remove(name: string): boolean {
		const row = this.db
			.query("SELECT id FROM doc_indexes WHERE name=? AND name NOT GLOB ?")
			.get(name, `${BUILDING_INDEX_PREFIX}*`) as {
			id: number;
		} | null;
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

	static open(agentDir: string): DocsStorage {
		return new DocsStorage(path.join(agentDir, "docs.db"));
	}

	close(): void {
		this.db.close();
	}

	/** Name a finished build so it becomes visible. */
	promote(tempId: number, name: string): DocsIndexSummary {
		const updated = this.db.query("UPDATE doc_indexes SET name=? WHERE id=?").run(name, tempId);
		const published = updated.changes > 0 ? this.getById(tempId) : undefined;
		if (!published) {
			// Another import swept this build as abandoned (`removeAbandoned`); report
			// it instead of publishing a success that leaves no visible index.
			throw new Error(`Document index build was removed before it could be published: ${name}`);
		}
		return published;
	}

	transaction<T>(callback: () => T): T {
		return this.db.transaction(callback)();
	}
}
