import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { markdownSectionContexts, normalizePlainText } from "./markdown";
import type { DocsIndexSummary } from "./types";

const SCHEMA_VERSION = 9;

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

/**
 * Text normalization for the FTS index. Every indexing path — fresh imports
 * (`service.ts`) and schema migrations below — must tokenize through this one
 * function: a query-side mismatch would silently zero out matches.
 */
export function normalizeFts(text: string): string {
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
		const started = performance.now();
		const fields = {
			component: "docs.storage",
			event: "docs.storage.open",
			operation_id: logger.getLogContext().operation_id ?? `docs-storage-${crypto.randomUUID()}`,
		};
		let stage = "open";
		logger.info("docs.storage.open.started", { ...fields, stage, result: "started" });
		this.path = dbPath;
		try {
			mkdirSync(path.dirname(dbPath), { recursive: true });
			this.db = new Database(dbPath, { create: true, strict: true });
		} catch (error) {
			logger.error("docs.storage.open.failed", {
				...fields,
				stage,
				result: "failed",
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
			throw error;
		}
		let version: number;
		try {
			stage = "version";
			chmodSync(dbPath, 0o600);
			this.db.run("PRAGMA busy_timeout=5000");
			version = (this.db.query("PRAGMA user_version").get() as { user_version: number } | null)?.user_version ?? 0;
		} catch (error) {
			logger.error("docs.storage.open.failed", {
				...fields,
				stage,
				result: "failed",
				elapsed_ms: performance.now() - started,
				cleanup: "close_started",
				...logger.diagnosticError(error),
			});
			// A truncated, foreign, or permission-hostile `docs.db` fails on the first
			// pragma read, before the schema guard below. The caller never receives a
			// storage instance in that case, so nothing else can close this handle.
			this.db.close();
			logger.info("docs.storage.open.cleanup", { ...fields, stage: "close", result: "completed" });
			throw error;
		}
		if (version > SCHEMA_VERSION) {
			logger.info("docs.storage.open.rejected", {
				...fields,
				stage,
				result: "unsupported_version",
				schema_version: version,
				supported_version: SCHEMA_VERSION,
				elapsed_ms: performance.now() - started,
				cleanup: "close_started",
			});
			this.db.close();
			logger.info("docs.storage.open.cleanup", { ...fields, stage: "close", result: "completed" });
			throw new Error(
				`Document index database version ${version} is newer than supported version ${SCHEMA_VERSION}`,
			);
		}
		try {
			stage = "schema";
			this.db.exec(SCHEMA_SQL);
			if (version > 0 && version < SCHEMA_VERSION) {
				const migrationStarted = performance.now();
				let migratedSections = 0;
				stage = "migration";
				logger.info("docs.storage.migration.started", {
					...fields,
					event: "docs.storage.migration",
					stage,
					result: "started",
					from_version: version,
					to_version: SCHEMA_VERSION,
				});
				try {
					logger.withLogContext({ operation_id: fields.operation_id }, () =>
						this.transaction(() => {
							// Rebuild searchable text from the stored source, including code
							// punctuation lost by older normalization. No source files are read.
							{
								stage = "migration_fts";
								this.db.run("DROP TABLE sections_fts");
								this.db.run(CONTENTLESS_FTS_SQL);
								const insert = this.db.query(
									"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
								);
								const rows = this.db
									.query(`SELECT s.id,s.index_id,s.document_id documentId,d.relative_path,s.ordinal,s.heading_path,
								s.byte_start byteStart,s.byte_end byteEnd,s.raw_markdown rawMarkdown
						FROM sections s JOIN documents d ON d.id=s.document_id ORDER BY s.document_id,s.ordinal`)
									.iterate() as Iterable<{
									id: number;
									index_id: number;
									documentId: number;
									relative_path: string;
									ordinal: number;
									heading_path: string;
									byteStart: number;
									byteEnd: number;
									rawMarkdown: string;
								}>;
								for (const { section: row, fencePrefix, continuesLine } of markdownSectionContexts(rows)) {
									insert.run(
										row.id,
										row.id,
										row.index_id,
										row.ordinal === 0 ? normalizeFts(row.relative_path) : "",
										normalizeFts(row.heading_path),
										normalizeFts(normalizePlainText(row.rawMarkdown, fencePrefix, continuesLine)),
									);
									migratedSections++;
								}
							}
							stage = "migration_schema";
							for (const table of ["evidence", "entity_aliases", "assertions", "relations", "entities"])
								this.db.run(`DROP TABLE IF EXISTS ${table}`);
							const columns = this.db.query("PRAGMA table_info(doc_indexes)").all() as Array<{ name: string }>;
							for (const column of ["schema_id", "schema_version", "schema_json", "schema_hash", "mode"])
								if (columns.some(item => item.name === column))
									this.db.run(`ALTER TABLE doc_indexes DROP COLUMN ${column}`);
							const sectionColumns = this.db.query("PRAGMA table_info(sections)").all() as Array<{
								name: string;
							}>;
							if (sectionColumns.some(column => column.name === "plain_text"))
								this.db.run("ALTER TABLE sections DROP COLUMN plain_text");
							if (version < 5) {
								// Indexes carry no state or timestamps: a half-built index is hidden
								// by its `__building__` name alone.
								this.db.run("DROP INDEX IF EXISTS documents_index_status");
								const indexColumns = this.db.query("PRAGMA table_info(doc_indexes)").all() as Array<{
									name: string;
								}>;
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
						}),
					);
					logger.info("docs.storage.migration.completed", {
						...fields,
						event: "docs.storage.migration",
						stage: "migration",
						result: "completed",
						from_version: version,
						to_version: SCHEMA_VERSION,
						section_count: migratedSections,
						elapsed_ms: performance.now() - migrationStarted,
					});
				} catch (error) {
					logger.error("docs.storage.migration.failed", {
						...fields,
						event: "docs.storage.migration",
						stage,
						result: "failed",
						from_version: version,
						to_version: SCHEMA_VERSION,
						section_count: migratedSections,
						elapsed_ms: performance.now() - migrationStarted,
						rollback: "sqlite_managed",
						...logger.diagnosticError(error),
					});
					throw error;
				}
			} else if (version === 0) this.db.run(`PRAGMA user_version=${SCHEMA_VERSION}`);
		} catch (error) {
			logger.error("docs.storage.open.failed", {
				...fields,
				stage,
				result: "failed",
				elapsed_ms: performance.now() - started,
				cleanup: "close_started",
				...logger.diagnosticError(error),
			});
			this.db.close();
			logger.info("docs.storage.open.cleanup", { ...fields, stage: "close", result: "completed" });
			const message = error instanceof Error ? error.message : String(error);
			if (/fts5/i.test(message)) throw new Error(`Document indexing requires SQLite FTS5: ${message}`);
			throw error;
		}
		logger.info("docs.storage.open.completed", {
			...fields,
			stage: "schema",
			result: "completed",
			from_version: version,
			schema_version: SCHEMA_VERSION,
			elapsed_ms: performance.now() - started,
		});
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
		const started = performance.now();
		const fields = { component: "docs.storage", event: "docs.storage.recovery", stage: "delete" };
		logger.info("docs.storage.recovery.started", { ...fields, result: "started" });
		try {
			const rows = this.db
				.query("SELECT id FROM doc_indexes WHERE name GLOB ?")
				.all(`${BUILDING_INDEX_PREFIX}*`) as Array<{ id: number }>;
			for (const row of rows) this.removeById(row.id);
			logger.info("docs.storage.recovery.completed", {
				...fields,
				result: "completed",
				abandoned_index_count: rows.length,
				elapsed_ms: performance.now() - started,
			});
		} catch (error) {
			logger.error("docs.storage.recovery.failed", {
				...fields,
				result: "failed",
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}

	remove(name: string): boolean {
		return this.transaction(() => {
			// Keep the name lookup and deletion on one snapshot: another process
			// may remove this index and reuse its rowid while importing a different one.
			const row = this.db
				.query("SELECT id FROM doc_indexes WHERE name=? AND name NOT GLOB ?")
				.get(name, `${BUILDING_INDEX_PREFIX}*`) as {
				id: number;
			} | null;
			if (!row) return false;
			this.removeById(row.id);
			return true;
		});
	}

	removeById(id: number): void {
		const started = performance.now();
		let stage = "delete_fts";
		const fields = { component: "docs.storage", event: "docs.storage.delete", index_id: id };
		logger.info("docs.storage.delete.started", { ...fields, stage, result: "started" });
		try {
			this.transaction(() => {
				this.db.query("DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE index_id=?)").run(id);
				stage = "delete_index";
				this.db.query("DELETE FROM doc_indexes WHERE id=?").run(id);
			});
			logger.info("docs.storage.delete.completed", {
				...fields,
				stage: "delete",
				result: "completed",
				elapsed_ms: performance.now() - started,
			});
		} catch (error) {
			logger.error("docs.storage.delete.failed", {
				...fields,
				stage,
				result: "failed",
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}

	static open(agentDir: string): DocsStorage {
		return new DocsStorage(path.join(agentDir, "docs.db"));
	}

	close(): void {
		this.db.close();
	}

	/** Name a finished build so it becomes visible. */
	promote(tempId: number, name: string): DocsIndexSummary {
		const started = performance.now();
		const fields = {
			component: "docs.storage",
			event: "docs.storage.publish",
			stage: "publish",
			index_id: tempId,
			index_hash: new Bun.CryptoHasher("sha256").update(name).digest("hex"),
		};
		logger.info("docs.storage.publish.started", { ...fields, result: "started" });
		try {
			const updated = this.db.query("UPDATE doc_indexes SET name=? WHERE id=?").run(name, tempId);
			const published = updated.changes > 0 ? this.getById(tempId) : undefined;
			if (!published) {
				// Another import swept this build as abandoned; preserve the failure.
				throw new Error(`Document index build was removed before it could be published: ${name}`);
			}
			logger.info("docs.storage.publish.completed", {
				...fields,
				result: "completed",
				document_count: published.documentCount,
				section_count: published.sectionCount,
				elapsed_ms: performance.now() - started,
			});
			return published;
		} catch (error) {
			logger.error("docs.storage.publish.failed", {
				...fields,
				result: "failed",
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}

	transaction<T>(callback: () => T): T {
		const started = performance.now();
		try {
			return this.db.transaction(callback)();
		} catch (error) {
			logger.error("docs.storage.transaction.failed", {
				component: "docs.storage",
				event: "docs.storage.transaction",
				stage: "transaction",
				result: "failed",
				elapsed_ms: performance.now() - started,
				rollback: "sqlite_managed",
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}

	/**
	 * Run reads on one deferred-transaction snapshot. Under WAL a writer
	 * (import/remove in another process) may commit meanwhile, but this
	 * transaction keeps seeing its own consistent snapshot — queries that
	 * assemble a page from several reads must not straddle a swap.
	 */
	read<T>(callback: () => T): T {
		const started = performance.now();
		try {
			return this.db.transaction(callback).deferred();
		} catch (error) {
			logger.error("docs.storage.snapshot.failed", {
				component: "docs.storage",
				event: "docs.storage.snapshot",
				stage: "query",
				result: "failed",
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}
}
