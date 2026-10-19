//! Wiki persistence, including source-only legacy migrations.

use std::{fs, path::Path, sync::Arc, time::Instant};

use napi_derive::napi;
use rusqlite::{Connection, OptionalExtension, Row, params};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::{
	database::{WikiError, check_file_identity, open_identified_connection},
	import::WikiMarkdownDocument,
	markdown::{self, ContextSectionRef, SectionContextScanner},
	projection::{ProjectionSection, prepare_document},
	query::is_ecmascript_whitespace,
};

pub(super) type CoreResult<T> = Result<T, WikiError>;
type Check<'a> = &'a dyn Fn() -> CoreResult<()>;
pub(super) const SCHEMA_VERSION: i64 = 12;
pub(super) const BUILDING_INDEX_PREFIX: &str = "__building__";
const BUILDING_GLOB: &str = "__building__*";
const CONTENTLESS_FTS_SQL: &str = "CREATE VIRTUAL TABLE sections_fts USING fts5(section_id \
                                   UNINDEXED, index_id UNINDEXED, relative_path, heading_path, \
                                   body, content='', contentless_delete=1)";
const FTS_INSERT: &str = "INSERT INTO \
                          sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) \
                          VALUES(?,?,?,?,?,?)";
macro_rules! summary_sql {
	($suffix:literal) => {
		concat!(
			"SELECT i.id,i.name,i.root_path, (SELECT count(*) FROM documents d WHERE \
			 d.index_id=i.id) document_count, (SELECT count(*) FROM sections s WHERE \
			 s.index_id=i.id) section_count FROM doc_indexes i",
			$suffix
		)
	};
}
const SCHEMA_SQL: &str = "
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
 heading_path TEXT NOT NULL, heading_level INTEGER NOT NULL, line_start INTEGER NOT NULL, line_end \
                          INTEGER NOT NULL,
 byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, raw_markdown TEXT NOT NULL,
 UNIQUE(document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS sections_index_document ON sections(index_id, document_id);
CREATE TABLE IF NOT EXISTS wiki_document_projections (
 document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 payload BLOB NOT NULL
);
CREATE TRIGGER IF NOT EXISTS wiki_projection_section_insert BEFORE INSERT ON sections BEGIN
 DELETE FROM wiki_document_projections WHERE document_id=NEW.document_id
 OR document_id IN (SELECT document_id FROM sections WHERE id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_projection_section_delete AFTER DELETE ON sections BEGIN
 DELETE FROM wiki_document_projections WHERE document_id=OLD.document_id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_projection_section_update BEFORE UPDATE ON sections BEGIN
 DELETE FROM wiki_document_projections WHERE document_id IN (OLD.document_id,NEW.document_id)
 OR document_id IN (SELECT document_id FROM sections WHERE id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_projection_document_insert AFTER INSERT ON documents BEGIN
 DELETE FROM wiki_document_projections WHERE document_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_projection_document_replace BEFORE INSERT ON documents BEGIN
 DELETE FROM wiki_document_projections WHERE document_id IN (
  SELECT id FROM documents WHERE index_id=NEW.index_id AND relative_path=NEW.relative_path
 );
END;
CREATE TRIGGER IF NOT EXISTS wiki_projection_document_delete AFTER DELETE ON documents BEGIN
 DELETE FROM wiki_document_projections WHERE document_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_projection_document_update BEFORE UPDATE OF id ON documents BEGIN
 DELETE FROM wiki_document_projections WHERE document_id IN (OLD.id,NEW.id);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(section_id UNINDEXED, index_id \
                          UNINDEXED, relative_path, heading_path, body, content='', \
                          contentless_delete=1);
";

#[napi(object)]
#[derive(Clone, Debug)]
pub struct WikiIndexSummary {
	pub id:             i64,
	pub name:           String,
	pub root_path:      String,
	pub document_count: i64,
	pub section_count:  i64,
}

/// Only identifiers, stage and counts cross the logging boundary. The borrowed
/// error lets the adapter extract its type/code, never its message or source.
#[derive(Clone, Debug)]
pub(super) struct StorageDiagnostic {
	pub message:               &'static str,
	pub level:                 &'static str,
	pub component:             &'static str,
	pub event:                 &'static str,
	pub stage:                 &'static str,
	pub result:                &'static str,
	pub elapsed_ms:            Option<f64>,
	pub schema_version:        Option<i64>,
	pub supported_version:     Option<i64>,
	pub from_version:          Option<i64>,
	pub to_version:            Option<i64>,
	pub section_count:         Option<i64>,
	pub document_count:        Option<i64>,
	pub abandoned_index_count: Option<i64>,
	pub index_id:              Option<i64>,
	pub index_hash:            Option<String>,
	pub cleanup:               Option<&'static str>,
	pub rollback:              Option<&'static str>,
}

impl StorageDiagnostic {
	fn new(
		message: &'static str,
		event: &'static str,
		stage: &'static str,
		result: &'static str,
	) -> Self {
		Self {
			message,
			level: if result == "failed" { "error" } else { "info" },
			component: "docs.storage",
			event,
			stage,
			result,
			elapsed_ms: None,
			schema_version: None,
			supported_version: None,
			from_version: None,
			to_version: None,
			section_count: None,
			document_count: None,
			abandoned_index_count: None,
			index_id: None,
			index_hash: None,
			cleanup: None,
			rollback: None,
		}
	}

	fn elapsed(mut self, started: Instant) -> Self {
		self.elapsed_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
		self
	}
}

/// Integration queues events here and flushes them outside the storage owner
/// mutex. It must not invoke JavaScript synchronously while that mutex is held.
pub(super) type StorageDiagnosticHook =
	Arc<dyn Fn(StorageDiagnostic, Option<&WikiError>) + Send + Sync>;

pub(super) struct Storage {
	connection:  Connection,
	diagnostics: Option<StorageDiagnosticHook>,
	path:        String,
	identity:    String,
}

/// A row id alone is not an import identity: replacement databases and deleted
/// rows can reuse it. Keep the database and unguessable hidden name together.
pub(super) struct BuildIdentity {
	database: String,
	id:       i64,
	hidden:   String,
}

/// Bun binds non-8-bit strings as UTF-16, whose initial BOM SQLite consumes:
/// <https://www.sqlite.org/c3ref/bind_blob.html>. Project only the bound value;
/// parser source bytes, hashes and byte ranges retain their original BOM.
pub(super) fn sqlite_text(text: &str) -> &str {
	text.strip_prefix('\u{feff}').unwrap_or(text)
}

pub(super) fn normalize_fts(text: &str) -> String {
	let mut output = String::with_capacity(text.len());
	let mut space = false;
	for character in text.nfkc() {
		if is_ecmascript_whitespace(character) {
			space = true;
			continue;
		}
		let han = matches!(character, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}');
		if (space || han) && !output.is_empty() {
			output.push(' ');
		}
		output.push(character);
		space = han;
	}
	output
}

#[napi]
pub fn wiki_normalize_fts(text: String) -> String {
	normalize_fts(&text)
}

impl Storage {
	pub(super) fn open_with_diagnostics(
		database_path: &str,
		hook: StorageDiagnosticHook,
	) -> CoreResult<Self> {
		Self::open_impl(database_path, Some(hook))
	}

	fn open_impl(
		database_path: &str,
		diagnostics: Option<StorageDiagnosticHook>,
	) -> CoreResult<Self> {
		let started = Instant::now();
		emit(
			diagnostics.as_ref(),
			StorageDiagnostic::new(
				"docs.storage.open.started",
				"docs.storage.open",
				"open",
				"started",
			),
			None,
		);
		let (connection, identity) = match (|| -> CoreResult<(Connection, String)> {
			let parent = Path::new(database_path)
				.parent()
				.filter(|parent| !parent.as_os_str().is_empty())
				.unwrap_or_else(|| Path::new("."));
			fs::create_dir_all(parent)?;
			// Establish an identity even on the first open, before SQLite can
			// race a path replacement. Never truncate an existing database.
			match fs::OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(database_path)
			{
				Ok(_) => {},
				Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
				Err(error) => return Err(error.into()),
			}
			open_identified_connection(Path::new(database_path), || {
				Ok(Connection::open(database_path)?)
			})
		})() {
			Ok(opened) => opened,
			Err(error) => {
				emit(
					diagnostics.as_ref(),
					StorageDiagnostic::new(
						"docs.storage.open.failed",
						"docs.storage.open",
						"open",
						"failed",
					)
					.elapsed(started),
					Some(&error),
				);
				return Err(error);
			},
		};
		let version = match (|| -> CoreResult<i64> {
			#[cfg(unix)]
			{
				use std::os::unix::fs::PermissionsExt;
				fs::set_permissions(database_path, fs::Permissions::from_mode(0o600))?;
			}
			connection.execute_batch("PRAGMA busy_timeout=5000")?;
			Ok(connection.query_row("PRAGMA user_version", [], |row| row.get(0))?)
		})() {
			Ok(version) => version,
			Err(error) => {
				let mut event = StorageDiagnostic::new(
					"docs.storage.open.failed",
					"docs.storage.open",
					"version",
					"failed",
				)
				.elapsed(started);
				event.cleanup = Some("close_started");
				emit(diagnostics.as_ref(), event, Some(&error));
				drop(connection);
				emit(
					diagnostics.as_ref(),
					StorageDiagnostic::new(
						"docs.storage.open.cleanup",
						"docs.storage.open",
						"close",
						"completed",
					),
					None,
				);
				return Err(error);
			},
		};
		if version > SCHEMA_VERSION {
			let mut event = StorageDiagnostic::new(
				"docs.storage.open.rejected",
				"docs.storage.open",
				"version",
				"unsupported_version",
			)
			.elapsed(started);
			event.schema_version = Some(version);
			event.supported_version = Some(SCHEMA_VERSION);
			event.cleanup = Some("close_started");
			emit(diagnostics.as_ref(), event, None);
			drop(connection);
			emit(
				diagnostics.as_ref(),
				StorageDiagnostic::new(
					"docs.storage.open.cleanup",
					"docs.storage.open",
					"close",
					"completed",
				),
				None,
			);
			return Err(WikiError::message(format!(
				"Document index database version {version} is newer than supported version \
				 {SCHEMA_VERSION}"
			)));
		}
		let storage = Self { connection, diagnostics, path: database_path.into(), identity };
		let mut stage = "schema";
		let schema = (|| -> CoreResult<()> {
			storage.connection.execute_batch(SCHEMA_SQL)?;
			if version > 0 && version < SCHEMA_VERSION {
				stage = "migration";
				storage.migrate(version, &mut stage)?;
			} else if version == 0 {
				storage.connection.execute_batch("PRAGMA user_version=12")?;
			}
			check_file_identity(Path::new(&storage.path), &storage.identity)?;
			Ok(())
		})();
		if let Err(error) = schema {
			let mut event = StorageDiagnostic::new(
				"docs.storage.open.failed",
				"docs.storage.open",
				stage,
				"failed",
			)
			.elapsed(started);
			event.cleanup = Some("close_started");
			storage.emit(event, Some(&error));
			let diagnostics = storage.diagnostics.clone();
			drop(storage);
			emit(
				diagnostics.as_ref(),
				StorageDiagnostic::new(
					"docs.storage.open.cleanup",
					"docs.storage.open",
					"close",
					"completed",
				),
				None,
			);
			if error.error_message().to_ascii_lowercase().contains("fts5") {
				return Err(WikiError::message(format!(
					"Document indexing requires SQLite FTS5: {}",
					error.error_message()
				)));
			}
			return Err(error);
		}
		let mut event = StorageDiagnostic::new(
			"docs.storage.open.completed",
			"docs.storage.open",
			"schema",
			"completed",
		)
		.elapsed(started);
		event.from_version = Some(version);
		event.schema_version = Some(SCHEMA_VERSION);
		storage.emit(event, None);
		Ok(storage)
	}

	fn emit(&self, event: StorageDiagnostic, error: Option<&WikiError>) {
		emit(self.diagnostics.as_ref(), event, error);
	}

	pub(super) fn identity(&self) -> &str {
		&self.identity
	}

	fn check_build(&self, build: &BuildIdentity) -> CoreResult<()> {
		if self.identity != build.database {
			return Err(WikiError::message("Documentation database changed during document indexing"));
		}
		check_file_identity(Path::new(&self.path), &build.database)?;
		let exists: bool = self.connection.query_row(
			"SELECT EXISTS(SELECT 1 FROM doc_indexes WHERE id=? AND name=?)",
			params![build.id, build.hidden],
			|row| row.get(0),
		)?;
		if !exists {
			return Err(WikiError::message("Document index build was removed or replaced"));
		}
		Ok(())
	}

	/// Cleanup is allowed after cancellation/close, but never against a
	/// replacement database or a row no longer owned by this hidden build.
	pub(super) fn rollback_build(&self, build: &BuildIdentity) -> CoreResult<()> {
		if self.identity != build.database
			|| super::database::file_identity(Path::new(&self.path))? != build.database
		{
			return Ok(());
		}
		self.transaction(|storage| {
			let exists: bool = storage.connection.query_row(
				"SELECT EXISTS(SELECT 1 FROM doc_indexes WHERE id=? AND name=?)",
				params![build.id, build.hidden],
				|row| row.get(0),
			)?;
			if exists {
				storage.remove_by_id(build.id)?;
			}
			Ok(())
		})
	}

	fn migrate(&self, version: i64, stage: &mut &'static str) -> CoreResult<()> {
		let started = Instant::now();
		let mut count = 0;
		let mut event = StorageDiagnostic::new(
			"docs.storage.migration.started",
			"docs.storage.migration",
			"migration",
			"started",
		);
		event.from_version = Some(version);
		event.to_version = Some(SCHEMA_VERSION);
		self.emit(event, None);
		let result = (|| -> CoreResult<()> {
			// Reserve the writer before projection preparation reads its source.
			// A deferred read snapshot cannot safely upgrade after another opener
			// commits the same migration.
			let guard = TransactionGuard::begin_immediate(&self.connection)?;
			let version: i64 = self
				.connection
				.query_row("PRAGMA user_version", [], |row| row.get(0))?;
			if version > SCHEMA_VERSION {
				return Err(WikiError::message(format!(
					"Document index database version {version} is newer than supported version \
					 {SCHEMA_VERSION}"
				)));
			}
			if version == SCHEMA_VERSION {
				check_file_identity(Path::new(&self.path), &self.identity)?;
				return guard.commit();
			}
			self.transaction(|storage| {
				if version < 11 {
					*stage = "migration_fts";
					storage
						.connection
						.execute_batch("DROP TABLE sections_fts")?;
					storage.connection.execute_batch(CONTENTLESS_FTS_SQL)?;
					storage.rebuild_fts(&mut count)?;
					*stage = "migration_schema";
					for table in ["evidence", "entity_aliases", "assertions", "relations", "entities"] {
						storage
							.connection
							.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))?;
					}
					storage.drop_columns("doc_indexes", &[
						"schema_id",
						"schema_version",
						"schema_json",
						"schema_hash",
						"mode",
					])?;
					storage.drop_columns("sections", &["plain_text"])?;
					if version < 5 {
						storage
							.connection
							.execute_batch("DROP INDEX IF EXISTS documents_index_status")?;
						storage.drop_columns("doc_indexes", &[
							"state",
							"last_error",
							"created_at",
							"updated_at",
							"indexed_at",
						])?;
						storage.drop_columns("documents", &["status", "last_error"])?;
					}
				}
				*stage = "migration_projections";
				storage.rebuild_projections(if version == 11 {
					Some(&mut count)
				} else {
					None
				})?;
				check_file_identity(Path::new(&storage.path), &storage.identity)?;
				storage.connection.execute_batch("PRAGMA user_version=12")?;
				Ok(())
			})?;
			guard.commit()
		})();
		let mut event = StorageDiagnostic::new(
			if result.is_ok() {
				"docs.storage.migration.completed"
			} else {
				"docs.storage.migration.failed"
			},
			"docs.storage.migration",
			if result.is_ok() { "migration" } else { stage },
			if result.is_ok() {
				"completed"
			} else {
				"failed"
			},
		)
		.elapsed(started);
		event.from_version = Some(version);
		event.to_version = Some(SCHEMA_VERSION);
		event.section_count = Some(count);
		if result.is_err() {
			event.rollback = Some("sqlite_managed");
		}
		self.emit(event, result.as_ref().err());
		result
	}

	fn drop_columns(&self, table: &str, columns: &[&str]) -> CoreResult<()> {
		let existing = {
			let mut statement = self
				.connection
				.prepare(&format!("PRAGMA table_info({table})"))?;
			statement
				.query_map([], |row| row.get::<_, String>(1))?
				.collect::<Result<Vec<_>, _>>()?
		};
		for column in columns {
			if existing.iter().any(|name| name.as_str() == *column) {
				self
					.connection
					.execute_batch(&format!("ALTER TABLE {table} DROP COLUMN {column}"))?;
			}
		}
		Ok(())
	}

	fn rebuild_fts(&self, count: &mut i64) -> CoreResult<()> {
		let mut statement = self.connection.prepare(
			"SELECT s.id,s.index_id,s.document_id,d.relative_path,s.ordinal,s.heading_path,s.\
			 byte_start,s.byte_end,s.raw_markdown FROM sections s JOIN documents d ON \
			 d.id=s.document_id ORDER BY s.document_id,s.ordinal",
		)?;
		let mut rows = statement.query([])?;
		let mut insert = self.connection.prepare(FTS_INSERT)?;
		let mut previous: Option<MigrationRow> = None;
		let mut scanner = SectionContextScanner::default();
		while let Some(row) = next_migration_row(&mut rows)? {
			let context =
				scanner.lex_context(previous.as_ref().map(MigrationRow::context), row.context());
			let body = normalize_fts(&markdown::plain_text(&markdown::lex_section(
				&row.raw_markdown,
				&context,
			)));
			let path = if row.ordinal == 0 {
				normalize_fts(&row.relative_path)
			} else {
				String::new()
			};
			insert.execute(params![
				row.id,
				row.id,
				row.index_id,
				path,
				normalize_fts(&row.heading_path),
				body
			])?;
			*count += 1;
			previous = Some(row);
		}
		Ok(())
	}

	fn persist_projection(
		&self,
		document_id: i64,
		sections: &[ProjectionSection<'_>],
		check: Check<'_>,
	) -> CoreResult<()> {
		let projection = prepare_document(sections, check)?;
		check()?;
		let payload =
			serde_json::to_vec(&projection).map_err(|error| WikiError::message(error.to_string()))?;
		check()?;
		self.connection.execute(
			"INSERT OR REPLACE INTO wiki_document_projections(document_id,payload) VALUES(?,?)",
			params![document_id, payload],
		)?;
		Ok(())
	}

	fn rebuild_projections(&self, mut count: Option<&mut i64>) -> CoreResult<()> {
		let mut documents = self
			.connection
			.prepare("SELECT id FROM documents ORDER BY id")?;
		let mut documents = documents.query([])?;
		let mut statement = self.connection.prepare(
			"SELECT id,byte_start,byte_end,raw_markdown FROM sections WHERE document_id=? ORDER BY \
			 ordinal,id",
		)?;
		let check = || check_file_identity(Path::new(&self.path), &self.identity);
		while let Some(document) = documents.next()? {
			check()?;
			let document_id: i64 = document.get(0)?;
			let rows = statement
				.query_map([document_id], |row| {
					Ok((
						row.get::<_, i64>(0)?,
						row.get::<_, i64>(1)?,
						row.get::<_, i64>(2)?,
						row.get::<_, String>(3)?,
					))
				})?
				.collect::<Result<Vec<_>, _>>()?;
			let sections: Vec<_> = rows
				.iter()
				.map(|(section_id, byte_start, byte_end, raw)| ProjectionSection {
					section_id: *section_id,
					document_id,
					byte_start: *byte_start,
					byte_end: *byte_end,
					raw_markdown: raw,
				})
				.collect();
			self.persist_projection(document_id, &sections, &check)?;
			if let Some(count) = count.as_deref_mut() {
				*count += sections.len() as i64;
			}
		}
		Ok(())
	}

	pub(super) fn list(&self) -> CoreResult<Vec<WikiIndexSummary>> {
		let mut statement = self
			.connection
			.prepare_cached(summary_sql!(" WHERE i.name NOT GLOB ? ORDER BY i.name"))?;
		Ok(statement
			.query_map([BUILDING_GLOB], map_summary)?
			.collect::<Result<Vec<_>, _>>()?)
	}

	pub(super) fn get(&self, name: &str) -> CoreResult<Option<WikiIndexSummary>> {
		Ok(self
			.connection
			.query_row(
				summary_sql!(" WHERE i.name=? AND i.name NOT GLOB ?"),
				params![sqlite_text(name), BUILDING_GLOB],
				map_summary,
			)
			.optional()?)
	}

	pub(super) fn get_by_id(&self, id: i64) -> CoreResult<Option<WikiIndexSummary>> {
		Ok(self
			.connection
			.query_row(summary_sql!(" WHERE i.id=?"), [id], map_summary)
			.optional()?)
	}

	pub(super) fn create(&self, name: &str, root: &str) -> CoreResult<BuildIdentity> {
		self.transaction(|storage| {
			check_file_identity(Path::new(&storage.path), &storage.identity)?;
			let id = storage.connection.query_row(
				"INSERT INTO doc_indexes(name,root_path) VALUES(?,?) RETURNING id",
				params![sqlite_text(name), sqlite_text(root)],
				|row| row.get(0),
			)?;
			Ok(BuildIdentity { database: storage.identity.clone(), id, hidden: name.into() })
		})
	}

	pub(super) fn remove_abandoned(&self) -> CoreResult<()> {
		let started = Instant::now();
		self.emit(
			StorageDiagnostic::new(
				"docs.storage.recovery.started",
				"docs.storage.recovery",
				"delete",
				"started",
			),
			None,
		);
		let result = (|| -> CoreResult<i64> {
			let ids = {
				let mut statement = self
					.connection
					.prepare_cached("SELECT id FROM doc_indexes WHERE name GLOB ?")?;
				statement
					.query_map([BUILDING_GLOB], |row| row.get::<_, i64>(0))?
					.collect::<Result<Vec<_>, _>>()?
			};
			for id in &ids {
				self.remove_by_id(*id)?;
			}
			Ok(ids.len() as i64)
		})();
		let mut event = StorageDiagnostic::new(
			if result.is_ok() {
				"docs.storage.recovery.completed"
			} else {
				"docs.storage.recovery.failed"
			},
			"docs.storage.recovery",
			"delete",
			if result.is_ok() {
				"completed"
			} else {
				"failed"
			},
		)
		.elapsed(started);
		if let Ok(count) = &result {
			event.abandoned_index_count = Some(*count);
		}
		self.emit(event, result.as_ref().err());
		result.map(|_| ())
	}

	pub(super) fn remove(&self, name: &str) -> CoreResult<bool> {
		self.transaction(|storage| {
			let id = storage
				.connection
				.query_row(
					"SELECT id FROM doc_indexes WHERE name=? AND name NOT GLOB ?",
					params![sqlite_text(name), BUILDING_GLOB],
					|row| row.get::<_, i64>(0),
				)
				.optional()?;
			let Some(id) = id else {
				return Ok(false);
			};
			storage.remove_by_id(id)?;
			Ok(true)
		})
	}

	pub(super) fn remove_by_id(&self, id: i64) -> CoreResult<()> {
		let started = Instant::now();
		let mut stage = "delete_fts";
		let mut event = StorageDiagnostic::new(
			"docs.storage.delete.started",
			"docs.storage.delete",
			stage,
			"started",
		);
		event.index_id = Some(id);
		self.emit(event, None);
		let result = self.transaction(|storage| {
			storage.connection.execute(
				"DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE index_id=?)",
				[id],
			)?;
			stage = "delete_index";
			storage
				.connection
				.execute("DELETE FROM doc_indexes WHERE id=?", [id])?;
			Ok(())
		});
		let mut event = StorageDiagnostic::new(
			if result.is_ok() {
				"docs.storage.delete.completed"
			} else {
				"docs.storage.delete.failed"
			},
			"docs.storage.delete",
			if result.is_ok() { "delete" } else { stage },
			if result.is_ok() {
				"completed"
			} else {
				"failed"
			},
		)
		.elapsed(started);
		event.index_id = Some(id);
		self.emit(event, result.as_ref().err());
		result
	}

	pub(super) fn commit_document(
		&self,
		build: &BuildIdentity,
		document: &WikiMarkdownDocument,
		check: Check<'_>,
	) -> CoreResult<()> {
		let started = Instant::now();
		let mut stage = "document_insert";
		let result = self.transaction(|storage| {
			storage.check_build(build)?;
			check()?;
			let index_id = build.id;
			let document_id: i64 = storage.connection.query_row(
				"INSERT INTO \
				 documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms) \
				 VALUES(?,?,?,?,?,?,?) RETURNING id",
				params![
					index_id,
					sqlite_text(&document.relative_path),
					sqlite_text(&document.title),
					sqlite_text(&document.source_kind),
					sqlite_text(&document.sha256),
					document.size_bytes,
					document.mtime_ms
				],
				|row| row.get(0),
			)?;
			let mut section_insert: Option<rusqlite::CachedStatement<'_>> = None;
			let mut fts_insert: Option<rusqlite::CachedStatement<'_>> = None;
			let mut scanner = SectionContextScanner::default();
			let mut previous = None;
			let mut projection_sections = Vec::with_capacity(document.sections.len());
			for section in &document.sections {
				check()?;
				let current = ContextSectionRef {
					document_id,
					byte_start: section.byte_start,
					byte_end: section.byte_end,
					raw_markdown: &section.raw_markdown,
				};
				let context = scanner.lex_context(previous, current);
				previous = Some(current);
				stage = "section_insert";
				if section_insert.is_none() {
					section_insert = Some(storage.connection.prepare_cached(
						"INSERT INTO \
						 sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,\
						 line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,?,?,?,?,?,?,?) \
						 RETURNING id",
					)?);
				}
				let heading = section.heading_path.join(" > ");
				check()?;
				let section_id: i64 = section_insert
					.as_mut()
					.expect("prepared section insert")
					.query_row(
						params![
							index_id,
							document_id,
							section.ordinal,
							sqlite_text(&heading),
							section.heading_level,
							section.line_start,
							section.line_end,
							section.byte_start,
							section.byte_end,
							&section.raw_markdown
						],
						|row| row.get(0),
					)?;
				projection_sections.push(ProjectionSection {
					section_id,
					document_id,
					byte_start: section.byte_start,
					byte_end: section.byte_end,
					raw_markdown: &section.raw_markdown,
				});
				stage = "fts_insert";
				if fts_insert.is_none() {
					fts_insert = Some(storage.connection.prepare_cached(FTS_INSERT)?);
				}
				let path = if section.ordinal == 0 {
					normalize_fts(&document.relative_path)
				} else {
					String::new()
				};
				// The document parser already projects ordinary/root-fenced
				// sections. Only continued container fences need their
				// stored-source context.
				let quoted_body = context
					.fence_prefix
					.as_ref()
					.filter(|prefix| prefix.starts_with('>'))
					.map(|_| {
						markdown::plain_text(&markdown::lex_section(&section.raw_markdown, &context))
					});
				let heading = normalize_fts(&heading);
				let body = normalize_fts(quoted_body.as_deref().unwrap_or(&section.plain_text));
				check()?;
				fts_insert
					.as_mut()
					.expect("prepared FTS insert")
					.execute(params![section_id, section_id, index_id, path, heading, body])?;
			}
			stage = "document_projection";
			storage.persist_projection(document_id, &projection_sections, check)?;
			storage.check_build(build)?;
			check()?;
			Ok(())
		});
		if let Err(error) = &result {
			let mut event = StorageDiagnostic::new(
				"docs.init.document.failed",
				"docs.init.document",
				stage,
				"failed",
			)
			.elapsed(started);
			event.component = "docs";
			event.section_count = Some(document.sections.len() as i64);
			self.emit(event, Some(error));
		}
		result
	}

	pub(super) fn promote(&self, build: &BuildIdentity, name: &str) -> CoreResult<WikiIndexSummary> {
		let started = Instant::now();
		let id = build.id;
		let index_hash = format!("{:x}", Sha256::digest(name.as_bytes()));
		let mut event = StorageDiagnostic::new(
			"docs.storage.publish.started",
			"docs.storage.publish",
			"publish",
			"started",
		);
		event.index_id = Some(id);
		event.index_hash = Some(index_hash.clone());
		self.emit(event, None);
		let result = self.transaction(|storage| {
			storage.check_build(build)?;
			let changes = storage.connection.execute(
				"UPDATE doc_indexes SET name=? WHERE id=? AND name=?",
				params![sqlite_text(name), id, build.hidden],
			)?;
			let published = if changes > 0 {
				storage.get_by_id(id)?
			} else {
				None
			};
			published.ok_or_else(|| {
				WikiError::message(format!(
					"Document index build was removed before it could be published: {name}"
				))
			})
		});
		let mut event = StorageDiagnostic::new(
			if result.is_ok() {
				"docs.storage.publish.completed"
			} else {
				"docs.storage.publish.failed"
			},
			"docs.storage.publish",
			"publish",
			if result.is_ok() {
				"completed"
			} else {
				"failed"
			},
		)
		.elapsed(started);
		event.index_id = Some(id);
		event.index_hash = Some(index_hash);
		if let Ok(summary) = &result {
			event.document_count = Some(summary.document_count);
			event.section_count = Some(summary.section_count);
		}
		self.emit(event, result.as_ref().err());
		result
	}

	pub(super) fn transaction<T>(
		&self,
		callback: impl FnOnce(&Self) -> CoreResult<T>,
	) -> CoreResult<T> {
		let started = Instant::now();
		let result = (|| -> CoreResult<T> {
			let guard = TransactionGuard::begin(&self.connection)?;
			let value = callback(self)?;
			guard.commit()?;
			Ok(value)
		})();
		if let Err(error) = &result {
			let mut event = StorageDiagnostic::new(
				"docs.storage.transaction.failed",
				"docs.storage.transaction",
				"transaction",
				"failed",
			)
			.elapsed(started);
			event.rollback = Some("sqlite_managed");
			self.emit(event, Some(error));
		}
		result
	}
}

fn emit(hook: Option<&StorageDiagnosticHook>, event: StorageDiagnostic, error: Option<&WikiError>) {
	if let Some(hook) = hook {
		hook(event, error);
	}
}

fn map_summary(row: &Row<'_>) -> rusqlite::Result<WikiIndexSummary> {
	Ok(WikiIndexSummary {
		id:             row.get(0)?,
		name:           row.get(1)?,
		root_path:      row.get(2)?,
		document_count: row.get(3)?,
		section_count:  row.get(4)?,
	})
}

struct MigrationRow {
	id:            i64,
	index_id:      i64,
	document_id:   i64,
	relative_path: String,
	ordinal:       i64,
	heading_path:  String,
	byte_start:    i64,
	byte_end:      i64,
	raw_markdown:  String,
}
impl MigrationRow {
	fn context(&self) -> ContextSectionRef<'_> {
		ContextSectionRef {
			document_id:  self.document_id,
			byte_start:   self.byte_start,
			byte_end:     self.byte_end,
			raw_markdown: &self.raw_markdown,
		}
	}
}
fn next_migration_row(rows: &mut rusqlite::Rows<'_>) -> CoreResult<Option<MigrationRow>> {
	let Some(row) = rows.next()? else {
		return Ok(None);
	};
	Ok(Some(MigrationRow {
		id:            row.get(0)?,
		index_id:      row.get(1)?,
		document_id:   row.get(2)?,
		relative_path: row.get(3)?,
		ordinal:       row.get(4)?,
		heading_path:  row.get(5)?,
		byte_start:    row.get(6)?,
		byte_end:      row.get(7)?,
		raw_markdown:  row.get(8)?,
	}))
}

/// Deferred outer snapshots and nested savepoints match bun:sqlite
/// transactions. Drop also rolls back unwinding callbacks without replacing
/// their error.
struct TransactionGuard<'a> {
	connection: &'a Connection,
	nested:     bool,
	active:     bool,
}
impl<'a> TransactionGuard<'a> {
	fn begin(connection: &'a Connection) -> CoreResult<Self> {
		Self::begin_with_statement(connection, "BEGIN DEFERRED")
	}

	fn begin_immediate(connection: &'a Connection) -> CoreResult<Self> {
		Self::begin_with_statement(connection, "BEGIN IMMEDIATE")
	}

	fn begin_with_statement(connection: &'a Connection, statement: &str) -> CoreResult<Self> {
		let nested = !connection.is_autocommit();
		connection.execute_batch(if nested {
			"SAVEPOINT _wiki_storage_transaction"
		} else {
			statement
		})?;
		Ok(Self { connection, nested, active: true })
	}

	fn commit(mut self) -> CoreResult<()> {
		self.connection.execute_batch(if self.nested {
			"RELEASE _wiki_storage_transaction"
		} else {
			"COMMIT"
		})?;
		self.active = false;
		Ok(())
	}
}
impl Drop for TransactionGuard<'_> {
	fn drop(&mut self) {
		if self.active && !self.connection.is_autocommit() {
			let _ = self.connection.execute_batch(if self.nested {
				"ROLLBACK TO _wiki_storage_transaction; RELEASE _wiki_storage_transaction"
			} else {
				"ROLLBACK"
			});
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	struct Fixture {
		directory: std::path::PathBuf,
		path:      String,
	}
	impl Fixture {
		fn new() -> Self {
			let directory = std::env::temp_dir().join(format!(
				"omp-wiki-build-{}-{}",
				std::process::id(),
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap()
					.as_nanos()
			));
			fs::create_dir_all(&directory).unwrap();
			let path = directory.join("docs.db").to_string_lossy().into_owned();
			Self { directory, path }
		}

		fn open(&self) -> Storage {
			Storage::open_impl(&self.path, None).unwrap()
		}
	}
	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.directory);
		}
	}

	pub(super) fn document() -> WikiMarkdownDocument {
		let source = b"# Lifetime\nneedle evidence\n";
		let parsed = super::super::import::parse_markdown(source).unwrap();
		WikiMarkdownDocument {
			relative_path: "lifetime.md".into(),
			title:         parsed.title.unwrap(),
			source_kind:   "markdown".into(),
			sha256:        "lifetime-hash".into(),
			size_bytes:    source.len() as i64,
			mtime_ms:      0.0,
			sections:      parsed.sections,
		}
	}

	#[test]
	fn cancellation_after_persisting_projection_rolls_back_entire_document() {
		let fixture = Fixture::new();
		let storage = fixture.open();
		let build = storage
			.create("__building__projection-cancel", "/missing-source")
			.unwrap();
		let reached_projection = std::cell::Cell::new(false);
		let error = storage
			.commit_document(&build, &document(), &|| {
				let count: i64 = storage.connection.query_row(
					"SELECT count(*) FROM wiki_document_projections",
					[],
					|row| row.get(0),
				)?;
				if count > 0 {
					reached_projection.set(true);
					return Err(WikiError::named("Document indexing cancelled", "AbortError", None));
				}
				Ok(())
			})
			.unwrap_err();
		assert!(reached_projection.get());
		assert_eq!(error.diagnostic_error_type(), "AbortError");
		for table in ["documents", "sections", "sections_fts", "wiki_document_projections"] {
			let remaining: i64 = storage
				.connection
				.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
				.unwrap();
			assert_eq!(remaining, 0, "cancelled document left rows in {table}");
		}
	}

	#[test]
	fn replacing_section_id_invalidates_replaced_document_without_recursive_triggers() {
		let fixture = Fixture::new();
		let storage = fixture.open();
		let build = storage
			.create("__building__replace", "/missing-source")
			.unwrap();
		storage
			.commit_document(&build, &document(), &|| Ok(()))
			.unwrap();
		storage
			.commit_document(
				&build,
				&WikiMarkdownDocument { relative_path: "second.md".into(), ..document() },
				&|| Ok(()),
			)
			.unwrap();
		storage
			.connection
			.execute_batch(
				"PRAGMA foreign_keys=OFF; PRAGMA recursive_triggers=OFF;
			 INSERT OR REPLACE INTO \
				 sections(id,index_id,document_id,ordinal,heading_path,heading_level,line_start,\
				 line_end,byte_start,byte_end,raw_markdown)
			 SELECT (SELECT min(id) FROM sections),index_id,document_id,999,'',0,1,1,0,1,'x'
			 FROM sections WHERE id=(SELECT max(id) FROM sections)",
			)
			.unwrap();
		let count: i64 = storage
			.connection
			.query_row("SELECT count(*) FROM wiki_document_projections", [], |row| row.get(0))
			.unwrap();
		assert_eq!(count, 0, "replacement must invalidate both affected documents");
	}

	#[test]
	fn document_projection_is_persisted_and_removed_with_hidden_build() {
		let fixture = Fixture::new();
		let storage = fixture.open();
		let build = storage
			.create("__building__projection", "/missing-source")
			.unwrap();
		let document = document();
		storage
			.commit_document(&build, &document, &|| Ok(()))
			.unwrap();
		let payload: Vec<u8> = storage
			.connection
			.query_row("SELECT payload FROM wiki_document_projections", [], |row| row.get(0))
			.unwrap();
		let projection: super::super::projection::DocumentProjection =
			serde_json::from_slice(&payload).unwrap();
		assert_eq!(projection.sections.len(), document.sections.len());
		let section_id: i64 = storage
			.connection
			.query_row("SELECT id FROM sections", [], |row| row.get(0))
			.unwrap();
		assert_eq!(projection.sections[0].section_id, section_id);
		assert!(projection.sections[0].plain.contains("needle evidence"));
		storage.rollback_build(&build).unwrap();
		let count: i64 = storage
			.connection
			.query_row("SELECT count(*) FROM wiki_document_projections", [], |row| row.get(0))
			.unwrap();
		assert_eq!(count, 0);
	}

	#[test]
	fn version_eleven_projection_migration_reads_only_database_and_preserves_fts() {
		let fixture = Fixture::new();
		let expected_section;
		{
			let storage = fixture.open();
			let build = storage
				.create("__building__migration", "/never-existed")
				.unwrap();
			storage
				.commit_document(&build, &document(), &|| Ok(()))
				.unwrap();
			storage.promote(&build, "migration").unwrap();
			expected_section = storage
				.connection
				.query_row("SELECT id FROM sections", [], |row| row.get::<_, i64>(0))
				.unwrap();
			storage
				.connection
				.execute(FTS_INSERT, params![999_999, 999_999, build.id, "", "", "fts sentinel"])
				.unwrap();
			storage
				.connection
				.execute_batch("DELETE FROM wiki_document_projections; PRAGMA user_version=11")
				.unwrap();
		}
		let storage = fixture.open();
		let version: i64 = storage
			.connection
			.query_row("PRAGMA user_version", [], |row| row.get(0))
			.unwrap();
		assert_eq!(version, 12);
		let payload: Vec<u8> = storage
			.connection
			.query_row("SELECT payload FROM wiki_document_projections", [], |row| row.get(0))
			.unwrap();
		let projection: super::super::projection::DocumentProjection =
			serde_json::from_slice(&payload).unwrap();
		assert_eq!(projection.sections[0].section_id, expected_section);
		let sentinel: i64 = storage
			.connection
			.query_row(
				"SELECT count(*) FROM sections_fts WHERE sections_fts MATCH 'sentinel'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(sentinel, 1, "version eleven must not rebuild FTS");
	}

	#[test]
	fn projection_migration_failure_rolls_back_all_documents_and_schema_version() {
		let fixture = Fixture::new();
		{
			let storage = fixture.open();
			let build = storage
				.create("__building__migration", "/never-existed")
				.unwrap();
			storage
				.commit_document(&build, &document(), &|| Ok(()))
				.unwrap();
			storage
				.commit_document(
					&build,
					&WikiMarkdownDocument { relative_path: "second.md".into(), ..document() },
					&|| Ok(()),
				)
				.unwrap();
			storage
				.connection
				.execute_batch(
					"DELETE FROM wiki_document_projections;
				 CREATE TRIGGER fail_second_projection BEFORE INSERT ON wiki_document_projections
				 WHEN (SELECT count(*) FROM wiki_document_projections)>0 BEGIN
				  SELECT RAISE(ABORT,'projection migration failure');
				 END;
				 PRAGMA user_version=11",
				)
				.unwrap();
		}
		assert!(Storage::open_impl(&fixture.path, None).is_err());
		let connection = Connection::open(&fixture.path).unwrap();
		let version: i64 = connection
			.query_row("PRAGMA user_version", [], |row| row.get(0))
			.unwrap();
		assert_eq!(version, 11);
		let count: i64 = connection
			.query_row("SELECT count(*) FROM wiki_document_projections", [], |row| row.get(0))
			.unwrap();
		assert_eq!(count, 0);
		connection
			.execute_batch("DROP TRIGGER fail_second_projection")
			.unwrap();
		drop(connection);
		let storage = fixture.open();
		let count: i64 = storage
			.connection
			.query_row("SELECT count(*) FROM wiki_document_projections", [], |row| row.get(0))
			.unwrap();
		assert_eq!(count, 2);
	}

	#[test]
	fn raw_sql_changes_invalidate_projections_even_without_foreign_keys() {
		let fixture = Fixture::new();
		let storage = fixture.open();
		let build = storage
			.create("__building__raw-sql", "/missing-source")
			.unwrap();
		storage
			.commit_document(&build, &document(), &|| Ok(()))
			.unwrap();
		storage
			.commit_document(
				&build,
				&WikiMarkdownDocument { relative_path: "second.md".into(), ..document() },
				&|| Ok(()),
			)
			.unwrap();
		let documents: Vec<i64> = storage
			.connection
			.prepare("SELECT id FROM documents ORDER BY id")
			.unwrap()
			.query_map([], |row| row.get(0))
			.unwrap()
			.collect::<Result<_, _>>()
			.unwrap();
		let first = documents[0];
		let second = documents[1];
		let first_section: i64 = storage
			.connection
			.query_row("SELECT id FROM sections WHERE document_id=?", [first], |row| row.get(0))
			.unwrap();
		let seed = || {
			for document in &documents {
				storage
					.connection
					.execute("INSERT OR REPLACE INTO wiki_document_projections VALUES(?,?)", params![
						document,
						b"test-only-payload".as_slice()
					])
					.unwrap();
			}
		};
		let count = || {
			storage
				.connection
				.query_row("SELECT count(*) FROM wiki_document_projections", [], |row| {
					row.get::<_, i64>(0)
				})
				.unwrap()
		};
		storage
			.connection
			.execute_batch("PRAGMA foreign_keys=OFF")
			.unwrap();
		storage
			.connection
			.execute("UPDATE sections SET raw_markdown=raw_markdown || 'changed' WHERE id=?", [
				first_section,
			])
			.unwrap();
		assert_eq!(count(), 1);
		seed();
		storage
			.connection
			.execute("UPDATE sections SET document_id=?,ordinal=999 WHERE id=?", params![
				second,
				first_section
			])
			.unwrap();
		assert_eq!(count(), 0, "both old and new documents must be invalidated");
		seed();
		storage
			.connection
			.execute("DELETE FROM sections WHERE id=?", [first_section])
			.unwrap();
		assert_eq!(count(), 1);
		seed();
		storage
			.connection
			.execute(
				"INSERT INTO \
				 sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,\
				 byte_start,byte_end,raw_markdown) VALUES(?,?,999,'',0,1,1,0,1,'x')",
				params![build.id, first],
			)
			.unwrap();
		assert_eq!(count(), 1);
		seed();
		storage
			.connection
			.execute("DELETE FROM documents WHERE id=?", [first])
			.unwrap();
		assert_eq!(count(), 1, "document deletion cannot rely on foreign-key cascades");
		seed();
		storage
			.connection
			.execute(
				"INSERT INTO \
				 documents(id,index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms) \
				 VALUES(?,?,'reused.md','','markdown','',0,0)",
				params![first, build.id],
			)
			.unwrap();
		assert_eq!(count(), 1, "reused document IDs must not inherit a projection");
		seed();
		storage
			.connection
			.execute("UPDATE documents SET id=999999 WHERE id=?", [first])
			.unwrap();
		assert_eq!(count(), 1);
	}

	#[test]
	fn normalized_expanding_name_recalls_intersecting_slices_without_false_boundaries() {
		use super::super::{
			database::{DatabaseEngine, WikiSearchOptions},
			query::{self, MatchKind},
		};

		let fixture = Fixture::new();
		let storage = fixture.open();
		let build = storage
			.create("__building__expanded-name", "/missing-source")
			.unwrap();
		let query = "\u{fb03}".repeat(200);
		let name = "ffi".repeat(200);
		assert_eq!(query.encode_utf16().count(), 200);
		assert_eq!(query::normalize_search_text(&query), name);
		let prefix = format!("{} ", "x".repeat(17_498));
		let exact = format!("{prefix}{name}\n");
		let prefixed = format!("{prefix}x{name}\n");
		let suffixed = format!("{prefix}{name}x\n");
		let left_only = format!("{} \n", &name[..300]);
		let right_only = format!("{} \n", &name[300..]);
		let mut expected = Vec::new();
		for (path, source) in [
			("exact.md", exact.as_str()),
			("prefixed.md", prefixed.as_str()),
			("suffixed.md", suffixed.as_str()),
			("left-only.md", left_only.as_str()),
			("right-only.md", right_only.as_str()),
		] {
			let parsed = super::super::import::parse_markdown(source.as_bytes()).unwrap();
			if path == "exact.md" {
				// The legal 200-unit query expands to a 600-character name
				// straddling [0,18000) and [17500,18100). Neither stored body
				// contains the whole name, so per-slice contains is insufficient.
				assert_eq!(parsed.sections.len(), 2);
				assert_eq!(parsed.sections[0].byte_end, 18_000);
				assert_eq!(parsed.sections[1].byte_start, 17_500);
				assert!(
					parsed
						.sections
						.iter()
						.all(|section| !section.raw_markdown.contains(&name))
				);
				expected = parsed
					.sections
					.iter()
					.map(|section| section.raw_markdown.clone())
					.collect();
			}
			let document = WikiMarkdownDocument {
				relative_path: path.into(),
				title:         "Expanded name".into(),
				source_kind:   "markdown".into(),
				sha256:        format!("{:x}", Sha256::digest(source.as_bytes())),
				size_bytes:    source.len() as i64,
				mtime_ms:      0.0,
				sections:      parsed.sections,
			};
			storage
				.commit_document(&build, &document, &|| Ok(()))
				.unwrap();
		}
		storage.promote(&build, "expanded-name").unwrap();
		let mut engine = DatabaseEngine::new(fixture.path.clone(), fixture.path.clone());
		let found = engine
			.search(&query, &WikiSearchOptions::default(), &|| Ok(()))
			.unwrap();
		assert_eq!(found.result.exact_name_matches, 2);
		let exact_hits: Vec<_> = found
			.result
			.sections
			.iter()
			.filter(|hit| hit.match_kind == MatchKind::ExactName)
			.collect();
		assert_eq!(exact_hits.len(), 2);
		let mut actual = Vec::new();
		for hit in &exact_hits {
			assert_eq!(hit.path, "exact.md");
			assert_eq!(hit.index, "expanded-name");
			assert_eq!(hit.match_kind, MatchKind::ExactName);
			assert_eq!((hit.line_start, hit.line_end), (1, 1));
			assert_eq!(hit.document_hash, format!("{:x}", Sha256::digest(exact.as_bytes())));
			actual.push(hit.text.clone());
		}
		// A cross-slice occurrence makes every intersecting stored source
		// reachable, once each, without synthesizing a new merged section.
		actual.sort();
		expected.sort();
		assert_eq!(actual, expected);
		assert_ne!(exact_hits[0].section_id, exact_hits[1].section_id);
		// prefixed/suffixed names are not exact matches, and separate
		// documents containing only halves must never be joined into evidence.
		// FTS may still report a partial slice as related; only upgrading it
		// to exact-name would invent a complete-name boundary.
		assert!(exact_hits.iter().all(|hit| hit.path == "exact.md"));
	}

	#[test]
	fn bom_source_bytes_match_stored_ranges_and_remain_greppable() {
		let source = "\u{feff}# Lifetime\nneedle evidence\n\n# Next\nmore needle evidence\n";
		let parsed = super::super::import::parse_markdown(source.as_bytes()).unwrap();
		let document = WikiMarkdownDocument {
			size_bytes: source.len() as i64,
			sections: parsed.sections,
			..document()
		};
		let fixture = Fixture::new();
		let storage = fixture.open();
		let build = storage.create("__building__bom", "/source").unwrap();
		storage
			.commit_document(&build, &document, &|| Ok(()))
			.unwrap();
		storage.promote(&build, "bom").unwrap();
		let mut statement = storage
			.connection
			.prepare("SELECT byte_start,byte_end,raw_markdown FROM sections ORDER BY ordinal")
			.unwrap();
		let stored: Vec<(i64, i64, String)> = statement
			.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
			.unwrap()
			.collect::<Result<_, _>>()
			.unwrap();
		assert_eq!(stored.len(), document.sections.len());
		assert!(stored[0].2.starts_with('\u{feff}'));
		for (start, end, raw) in stored {
			assert_eq!(raw.len() as i64, end - start);
			assert_eq!(raw, source[start as usize..end as usize]);
		}
		let matcher = crate::grep::build_strict_matcher("needle", false).unwrap();
		let matches =
			super::super::grep::scan(&storage.connection, &matcher, None, &|| Ok(())).unwrap();
		assert_eq!(matches.len(), 2);
	}

	#[test]
	fn legacy_bom_shortened_section_remains_greppable_without_reimport() {
		let source = "\u{feff}# Lifetime\nneedle evidence\n\n# Next\nmore needle evidence\n";
		let parsed = super::super::import::parse_markdown(source.as_bytes()).unwrap();
		let document = WikiMarkdownDocument {
			size_bytes: source.len() as i64,
			sections: parsed.sections,
			..document()
		};
		let fixture = Fixture::new();
		let storage = fixture.open();
		let build = storage.create("__building__legacy_bom", "/source").unwrap();
		storage
			.commit_document(&build, &document, &|| Ok(()))
			.unwrap();
		storage.promote(&build, "legacy-bom").unwrap();
		assert!(document.sections[0].raw_markdown.starts_with('\u{feff}'));
		// Reproduce the old persisted row, including its original byte range.
		storage
			.connection
			.execute("UPDATE sections SET raw_markdown=? WHERE byte_start=0", [sqlite_text(
				&document.sections[0].raw_markdown,
			)])
			.unwrap();
		let matcher = crate::grep::build_strict_matcher("needle", false).unwrap();
		let matches =
			super::super::grep::scan(&storage.connection, &matcher, None, &|| Ok(())).unwrap();
		assert_eq!(matches.len(), 2);
		// Restoring the BOM also preserves original-line regex semantics,
		// rather than just ignoring the declared/stored length mismatch.
		let matcher = crate::grep::build_strict_matcher("^\u{feff}# Lifetime$", false).unwrap();
		let matches =
			super::super::grep::scan(&storage.connection, &matcher, None, &|| Ok(())).unwrap();
		assert_eq!(matches.len(), 1);
	}

	#[test]
	fn grep_rejects_non_bom_length_mismatches() {
		let fixture = Fixture::new();
		let storage = fixture.open();
		let build = storage.create("__building__corrupt", "/source").unwrap();
		storage
			.commit_document(&build, &document(), &|| Ok(()))
			.unwrap();
		storage.promote(&build, "corrupt").unwrap();
		let matcher = crate::grep::build_strict_matcher("needle", false).unwrap();
		for (start, deficit) in [(0, 1), (0, 2), (0, 4), (1, 3)] {
			storage
				.connection
				.execute(
					"UPDATE sections SET byte_start=?,byte_end=?+length(CAST(raw_markdown AS BLOB))+?",
					params![start, start, deficit],
				)
				.unwrap();
			let error =
				super::super::grep::scan(&storage.connection, &matcher, None, &|| Ok(())).unwrap_err();
			assert_eq!(error.error_message(), "Documentation search snapshot is inconsistent");
		}
	}

	#[test]
	fn cancelled_document_stops_section_writes_and_rolls_back_all_projections() {
		let source: String = (0..64)
			.map(|ordinal| format!("# Section {ordinal}\nneedle evidence {ordinal}\n\n"))
			.collect();
		let parsed = super::super::import::parse_markdown(source.as_bytes()).unwrap();
		let document = WikiMarkdownDocument {
			size_bytes: source.len() as i64,
			sections: parsed.sections,
			..document()
		};
		assert_eq!(document.sections.len(), 64);
		// Cover an interrupted section and cancellation after the final FTS
		// write, before the transaction can become an accepted document.
		for (stop_at, after_fts) in [(3_i64, false), (64, true)] {
			let fixture = Fixture::new();
			let storage = fixture.open();
			let build = storage.create("__building__cancelled", "/source").unwrap();
			let interrupted = std::cell::Cell::new(None);
			let error = storage
				.commit_document(&build, &document, &|| {
					let sections: i64 = storage.connection.query_row(
						"SELECT count(*) FROM sections WHERE index_id=?",
						[build.id],
						|row| row.get(0),
					)?;
					let fts: i64 =
						storage
							.connection
							.query_row("SELECT count(*) FROM sections_fts", [], |row| row.get(0))?;
					if sections >= stop_at && (!after_fts || fts >= stop_at) {
						interrupted.set(Some((sections, fts)));
						return Err(WikiError::named("Document indexing cancelled", "AbortError", None));
					}
					Ok(())
				})
				.unwrap_err();
			assert_eq!(error.diagnostic_error_type(), "AbortError");
			assert_eq!(
				interrupted.get(),
				Some((stop_at, if after_fts { stop_at } else { stop_at - 1 }))
			);
			assert!(storage.connection.is_autocommit());
			for table in ["documents", "sections", "sections_fts", "wiki_document_projections"] {
				let remaining: i64 = storage
					.connection
					.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
					.unwrap();
				assert_eq!(remaining, 0, "cancelled document left rows in {table}");
			}
			assert!(storage.list().unwrap().is_empty());
			// The rolled-back document must not leave a unique-key conflict
			// or FTS residue when the still-hidden build accepts it later.
			storage
				.commit_document(&build, &document, &|| Ok(()))
				.unwrap();
			let published = storage.promote(&build, "completed").unwrap();
			assert_eq!(published.document_count, 1);
			assert_eq!(published.section_count, 64);
			let matches: i64 = storage
				.connection
				.query_row(
					"SELECT count(*) FROM sections_fts WHERE sections_fts MATCH 'needle'",
					[],
					|row| row.get(0),
				)
				.unwrap();
			assert_eq!(matches, 64);
		}
	}

	#[test]
	fn build_guard_preserves_colliding_ids_in_another_database() {
		let original = Fixture::new();
		let replacement = Fixture::new();
		let old = original.open();
		let new = replacement.open();
		let build = old.create("__building__original", "/source").unwrap();
		let other = new
			.create("__building__replacement", "/replacement")
			.unwrap();
		assert_eq!(build.id, 1);
		assert_eq!(build.id, other.id);
		new.commit_document(&other, &document(), &|| Ok(()))
			.unwrap();
		assert!(
			new.commit_document(&build, &document(), &|| Ok(()))
				.is_err()
		);
		assert!(new.promote(&build, "hijacked").is_err());
		new.rollback_build(&build).unwrap();
		assert!(new.list().unwrap().is_empty());
		let published = new.promote(&other, "replacement").unwrap();
		assert_eq!(published.id, build.id);
		assert_eq!(published.document_count, 1);
		assert!(
			new.commit_document(&build, &document(), &|| Ok(()))
				.is_err()
		);
		assert!(new.promote(&build, "hijacked").is_err());
		new.rollback_build(&build).unwrap();
		assert_eq!(new.list().unwrap()[0].name, "replacement");
		assert_eq!(new.list().unwrap()[0].document_count, 1);
	}

	#[test]
	fn build_guard_rejects_reused_rowid_and_does_not_remove_a_published_build() {
		let fixture = Fixture::new();
		let storage = fixture.open();
		let removed = storage.create("__building__removed", "/source").unwrap();
		storage.remove_by_id(removed.id).unwrap();
		let current = storage.create("__building__current", "/source").unwrap();
		assert_eq!(removed.id, current.id);
		assert!(
			storage
				.commit_document(&removed, &document(), &|| Ok(()))
				.is_err()
		);
		assert!(storage.promote(&removed, "hijacked").is_err());
		storage.rollback_build(&removed).unwrap();
		storage
			.commit_document(&current, &document(), &|| Ok(()))
			.unwrap();
		let published = storage.promote(&current, "current").unwrap();
		assert_eq!(published.document_count, 1);
		storage.rollback_build(&current).unwrap();
		assert_eq!(storage.list().unwrap()[0].name, "current");
	}

	#[test]
	fn rollback_removes_only_its_hidden_documents_and_fts_rows() {
		let fixture = Fixture::new();
		let storage = fixture.open();
		let published = storage.create("__building__published", "/source").unwrap();
		storage
			.commit_document(&published, &document(), &|| Ok(()))
			.unwrap();
		let retained = storage.promote(&published, "retained").unwrap();
		let cancelled = storage.create("__building__cancelled", "/source").unwrap();
		storage
			.commit_document(&cancelled, &document(), &|| Ok(()))
			.unwrap();
		storage.rollback_build(&cancelled).unwrap();
		assert!(storage.get_by_id(cancelled.id).unwrap().is_none());
		assert_eq!(storage.list().unwrap().len(), 1);
		assert_eq!(storage.list().unwrap()[0].document_count, 1);
		let remaining_fts: i64 = storage
			.connection
			.query_row("SELECT count(*) FROM sections_fts", [], |row| row.get(0))
			.unwrap();
		assert_eq!(remaining_fts, retained.section_count);
	}

	#[cfg(unix)]
	#[test]
	fn replaced_path_rejects_old_build_before_owner_reopen_and_cleanup_cannot_delete_new_index() {
		let original = Fixture::new();
		let replacement = Fixture::new();
		let old = original.open();
		let build = old.create("__building__original", "/source").unwrap();
		old.connection
			.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
			.unwrap();
		{
			let new = replacement.open();
			let other = new
				.create("__building__replacement", "/replacement")
				.unwrap();
			assert_eq!(build.id, other.id);
			new.commit_document(&other, &document(), &|| Ok(()))
				.unwrap();
			new.promote(&other, "replacement").unwrap();
			new.connection
				.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
				.unwrap();
		}
		fs::rename(&original.path, original.directory.join("old.db")).unwrap();
		for suffix in ["-wal", "-shm"] {
			let path = format!("{}{suffix}", original.path);
			if Path::new(&path).exists() {
				fs::rename(path, original.directory.join(format!("old.db{suffix}"))).unwrap();
			}
		}
		fs::rename(&replacement.path, &original.path).unwrap();
		assert!(
			old.commit_document(&build, &document(), &|| Ok(()))
				.is_err()
		);
		assert!(old.promote(&build, "hijacked").is_err());
		old.rollback_build(&build).unwrap();
		let reopened = original.open();
		assert!(
			reopened
				.commit_document(&build, &document(), &|| Ok(()))
				.is_err()
		);
		assert!(reopened.promote(&build, "hijacked").is_err());
		reopened.rollback_build(&build).unwrap();
		let indexes = reopened.list().unwrap();
		assert_eq!(indexes.len(), 1);
		assert_eq!(indexes[0].name, "replacement");
		assert_eq!(indexes[0].document_count, 1);
	}
}

#[cfg(test)]
mod owner_cleanup_tests {
	use std::sync::atomic::{AtomicBool, AtomicUsize};

	use super::{
		super::{ImportGuard, Owner, StorageState, WikiSearchEngine, database::DatabaseEngine},
		*,
	};
	use crate::task::{AbortReason, CancelToken};

	#[test]
	fn owner_rolls_back_accepted_build_after_cancellation_and_close() {
		for close in [false, true] {
			let directory = std::env::temp_dir().join(format!(
				"omp-wiki-owner-{}-{}",
				std::process::id(),
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap()
					.as_nanos()
			));
			let path = directory.join("docs.db").to_string_lossy().into_owned();
			let storage = Storage::open_impl(&path, None).unwrap();
			let identity = storage.identity().to_owned();
			let owner = Arc::new(Owner {
				closed:        Arc::new(AtomicBool::new(false)),
				imports:       AtomicUsize::new(1),
				engine:        parking_lot::Mutex::new(DatabaseEngine::new(path.clone(), path.clone())),
				storage:       parking_lot::Mutex::new(StorageState {
					storage: Some(storage),
					identity,
				}),
				database_path: path,
				diagnostics:   Arc::new(parking_lot::Mutex::new(Vec::new())),
			});
			let guard = ImportGuard(Arc::clone(&owner));
			let mut cancel = CancelToken::default();
			let build = owner
				.with_storage(&cancel, |storage| storage.create("__building__cancelled", "/source"))
				.unwrap();
			let document = super::tests::document();
			owner
				.with_storage(&cancel, |storage| {
					storage.commit_document(&build, &document, &|| owner.check_import(&cancel))
				})
				.unwrap();
			cancel.emplace_abort_token().abort(AbortReason::Signal);
			let engine = WikiSearchEngine { owner: Arc::clone(&owner) };
			if close {
				engine.close();
			}
			assert!(owner.check_import(&cancel).is_err());
			owner.rollback(&build).unwrap();
			{
				let state = owner.storage.lock();
				let storage = state.storage.as_ref().unwrap();
				assert!(storage.get_by_id(build.id).unwrap().is_none());
				let rows: i64 = storage
					.connection
					.query_row("SELECT count(*) FROM sections_fts", [], |row| row.get(0))
					.unwrap();
				assert_eq!(rows, 0);
			}
			drop(engine);
			drop(guard);
			assert!(owner.storage.lock().storage.is_none());
			drop(owner);
			fs::remove_dir_all(directory).unwrap();
		}
	}
}
