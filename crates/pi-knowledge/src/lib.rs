//! Documentation indexing, Markdown processing, and ranked search.

/// SQLite search engine and cursor handling.
pub mod database;
/// Original-line regular expression matching.
pub mod grep;
/// Markdown document import and parsing.
pub mod import;
/// Import transaction orchestration.
pub mod importer;
/// Markdown tokenization and section context.
pub mod markdown;
mod parallel;
/// Search projections.
pub mod projection;
/// Query parsing and ranking.
pub mod query;
/// SQLite index storage.
pub mod storage;
/// Optional, identity-bound derived section vectors.
pub mod vectors;
