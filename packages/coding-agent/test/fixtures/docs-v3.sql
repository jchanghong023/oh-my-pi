
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

PRAGMA user_version=3;
