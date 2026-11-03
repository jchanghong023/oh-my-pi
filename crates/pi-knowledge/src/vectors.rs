//! Optional vectors derived from published knowledge sections.
//!
//! Import ownership and generation state are deliberately kept in the same
//! database as the source. No transaction is held while a model is called.
use std::{cmp::Ordering, collections::BinaryHeap, path::Path};

use rusqlite::{Connection, OptionalExtension, params};

use crate::{
	database::{CoreResult, KnowledgeError, check_file_identity},
	storage::Storage,
};

// Defer BLOB reads until the source keys have been sorted. OFFSET 0 prevents
// flattening this ordered coroutine; LIMIT -1 retains every section.
const SCOPED_VECTOR_ROWS: &str =
	"SELECT ordered.id,(SELECT v.vector FROM wiki_section_vectors v WHERE \
	 v.index_id=ordered.index_id AND v.section_id=ordered.id),ordered.relative_path FROM (SELECT \
	 s.id,s.index_id,d.relative_path FROM sections s LEFT JOIN documents d ON d.id=s.document_id \
	 WHERE s.index_id=? ORDER BY s.document_id,s.ordinal,s.id LIMIT -1 OFFSET 0) ordered";

/// A stored section for a bounded embedding request.
pub struct VectorSource {
	pub section_id: i64,
	pub text:       String,
}

/// One vector to commit to an incomplete generation.
pub struct VectorRow {
	pub section_id: i64,
	pub vector:     Vec<f32>,
}

/// A published index's durable vector checkpoint, with a fresh writer token.
pub struct VectorRetry {
	pub token:      Option<String>,
	pub total:      i64,
	pub completed:  i64,
	pub dimensions: i64,
	pub complete:   bool,
}

/// Complete compatible generations, in stable source order.
pub struct VectorMatrix {
	pub section_ids: Vec<i64>,
	pub matrix:      Vec<f32>,
	pub dimensions:  usize,
}

fn invalid() -> KnowledgeError {
	KnowledgeError::message("Documentation vector generation is no longer current")
}

fn valid_vector(bytes: &[u8], dimensions: usize) -> bool {
	if dimensions == 0 || Some(bytes.len()) != dimensions.checked_mul(4) {
		return false;
	}
	let mut norm = 0.0f64;
	for chunk in bytes.as_chunks::<4>().0 {
		let value = f32::from_le_bytes(*chunk);
		if !value.is_finite() {
			return false;
		}
		norm += f64::from(value).powi(2);
	}
	norm.is_finite() && norm != 0.0
}

impl Storage {
	fn vector_owner(&self, token: &str) -> CoreResult<i64> {
		let (database, owner): (String, String) =
			serde_json::from_str(token).map_err(|_| invalid())?;
		if database != self.identity {
			return Err(invalid());
		}
		check_file_identity(Path::new(&self.path), &database)?;
		self
			.connection
			.query_row(
				"SELECT o.index_id FROM wiki_import_owners o JOIN doc_indexes i ON i.id=o.index_id \
				 WHERE o.token=?",
				[owner],
				|row| row.get(0),
			)
			.optional()?
			.ok_or_else(invalid)
	}

	/// Begin an incomplete generation for a particular successful import.
	pub fn begin_vector_import(&self, token: &str, model: &str) -> CoreResult<i64> {
		if model.is_empty() {
			return Err(invalid());
		}
		self.transaction(|storage| {
			let id = storage.vector_owner(token)?;
			storage
				.connection
				.execute("DELETE FROM wiki_section_vectors WHERE index_id=?", [id])?;
			storage
				.connection
				.execute("DELETE FROM wiki_vector_generations WHERE index_id=?", [id])?;
			storage.connection.execute(
				"INSERT INTO wiki_vector_generations(index_id,token,model) VALUES(?,?,?)",
				params![id, token, model],
			)?;
			let count = storage.connection.query_row(
				"SELECT count(*) FROM sections WHERE index_id=?",
				[id],
				|row| row.get(0),
			)?;
			check_file_identity(Path::new(&storage.path), &storage.identity)?;
			Ok(count)
		})
	}

	/// Resume only compatible checkpoints belonging to unchanged published
	/// sections. The caller holds the physical database's import lease
	/// throughout the retry.
	pub fn begin_vector_retry(
		&self,
		id: i64,
		model: Option<&str>,
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<VectorRetry> {
		self.transaction(|storage| {
			let visible: bool = storage.connection.query_row(
				"SELECT EXISTS(SELECT 1 FROM doc_indexes WHERE id=? AND name NOT GLOB '__building__*')",
				[id],
				|row| row.get(0),
			)?;
			if !visible || model.is_some_and(str::is_empty) {
				return Err(invalid());
			}
			let total: i64 = storage.connection.query_row(
				"SELECT count(*) FROM sections WHERE index_id=?",
				[id],
				|row| row.get(0),
			)?;
			let generation: Option<(String, i64, bool)> = storage
				.connection
				.query_row(
					"SELECT model,dimensions,complete FROM wiki_vector_generations WHERE index_id=?",
					[id],
					|row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
				)
				.optional()?;
			let mut completed: i64 = storage.connection.query_row(
				"SELECT count(*) FROM wiki_section_vectors WHERE index_id=?",
				[id],
				|row| row.get(0),
			)?;
			let compatible = generation
				.as_ref()
				.is_some_and(|(stored, ..)| model.is_none_or(|model| stored == model));
			let mut dimensions = generation
				.as_ref()
				.map_or(0, |(_, dimensions, _)| *dimensions);
			// A stored row may have been damaged independently of the source
			// triggers. Keep valid checkpoint rows, but never skip a damaged
			// complete generation or repeatedly attempt to publish a bad row.
			let mut invalid_rows = Vec::new();
			if compatible && dimensions > 0 {
				let mut statement = storage.connection.prepare(
					"SELECT v.section_id,v.vector,s.id FROM wiki_section_vectors v LEFT JOIN sections \
					 s ON s.id=v.section_id AND s.index_id=v.index_id WHERE v.index_id=?",
				)?;
				let mut rows = statement.query([id])?;
				while let Some(row) = rows.next()? {
					check()?;
					let section_id: i64 = row.get(0)?;
					let belongs = !matches!(row.get_ref(2)?, rusqlite::types::ValueRef::Null);
					let valid = match row.get_ref(1)? {
						rusqlite::types::ValueRef::Blob(bytes) => usize::try_from(dimensions)
							.is_ok_and(|dimensions| valid_vector(bytes, dimensions)),
						_ => false,
					};
					if !belongs || !valid {
						invalid_rows.push(section_id);
					}
				}
			}
			if compatible
				&& generation
					.as_ref()
					.is_some_and(|(_, _, complete)| *complete)
				&& completed == total
				&& invalid_rows.is_empty()
				&& (total == 0 || dimensions > 0)
			{
				check()?;
				check_file_identity(Path::new(&storage.path), &storage.identity)?;
				return Ok(VectorRetry { token: None, total, completed, dimensions, complete: true });
			}
			let model = model.ok_or_else(|| {
				KnowledgeError::message(
					"No embedding model configured; cannot continue building knowledge vectors",
				)
			})?;
			// Source mutations already invalidate generations via the storage
			// triggers. Never mix incompatible model spaces.
			if !compatible
				|| (completed > total && invalid_rows.is_empty())
				|| dimensions < 0
				|| (completed > 0 && dimensions == 0)
			{
				storage
					.connection
					.execute("DELETE FROM wiki_section_vectors WHERE index_id=?", [id])?;
				storage
					.connection
					.execute("DELETE FROM wiki_vector_generations WHERE index_id=?", [id])?;
				completed = 0;
				dimensions = 0;
			} else {
				for section_id in invalid_rows {
					check()?;
					storage.connection.execute(
						"DELETE FROM wiki_section_vectors WHERE index_id=? AND section_id=?",
						params![id, section_id],
					)?;
					completed -= 1;
				}
			}
			if completed == 0 {
				dimensions = 0;
			}
			let owner: String =
				storage
					.connection
					.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
			let token = serde_json::to_string(&(&storage.identity, &owner)).map_err(|_| invalid())?;
			storage.connection.execute(
				"INSERT INTO wiki_import_owners(index_id,token) VALUES(?,?) ON CONFLICT(index_id) DO \
				 UPDATE SET token=excluded.token",
				params![id, owner],
			)?;
			storage.connection.execute(
				"INSERT INTO wiki_vector_generations(index_id,token,model,dimensions) VALUES(?,?,?,?) \
				 ON CONFLICT(index_id) DO UPDATE SET \
				 token=excluded.token,dimensions=excluded.dimensions,complete=0",
				params![id, token, model, dimensions],
			)?;
			check()?;
			check_file_identity(Path::new(&storage.path), &storage.identity)?;
			Ok(VectorRetry { token: Some(token), total, completed, dimensions, complete: false })
		})
	}

	/// Retire the writer, preserving saved batches even after failure or
	/// cancellation.
	pub fn finish_vector_retry(&self, token: &str) -> CoreResult<()> {
		self.transaction(|storage| {
			if let Ok(id) = storage.vector_owner(token) {
				storage
					.connection
					.execute("DELETE FROM wiki_import_owners WHERE index_id=?", [id])?;
				check_file_identity(Path::new(&storage.path), &storage.identity)?;
			}
			Ok(())
		})
	}

	fn active_vector_import(&self, token: &str) -> CoreResult<i64> {
		let id = self.vector_owner(token)?;
		let active: bool = self.connection.query_row(
			"SELECT EXISTS(SELECT 1 FROM wiki_vector_generations WHERE index_id=? AND token=? AND \
			 complete=0)",
			params![id, token],
			|row| row.get(0),
		)?;
		if !active {
			return Err(invalid());
		}
		Ok(id)
	}

	/// Read a bounded source batch without keeping a transaction across calls.
	pub fn read_vector_import_batch(
		&self,
		token: &str,
		after: i64,
		limit: usize,
	) -> CoreResult<Vec<VectorSource>> {
		self.transaction(|storage| {
			let id = storage.active_vector_import(token)?;
			let mut stmt = storage.connection.prepare(
				"SELECT s.id,s.raw_markdown FROM sections s WHERE s.index_id=? AND s.id>? AND NOT \
				 EXISTS(SELECT 1 FROM wiki_section_vectors v WHERE v.index_id=s.index_id AND \
				 v.section_id=s.id) ORDER BY s.id LIMIT ?",
			)?;
			let rows = stmt.query_map(params![id, after, limit.clamp(1, 1000) as i64], |row| {
				Ok(VectorSource { section_id: row.get(0)?, text: row.get(1)? })
			})?;
			let result = rows.collect::<Result<Vec<_>, _>>()?;
			check_file_identity(Path::new(&storage.path), &storage.identity)?;
			Ok(result)
		})
	}

	/// Commit a batch atomically. Every vector is normalized and finite.
	pub fn write_vector_import_batch(&self, token: &str, rows: &[VectorRow]) -> CoreResult<()> {
		self.transaction(|storage| {
			let id = storage.active_vector_import(token)?;
			let stored_dimensions: i64 = storage.connection.query_row(
				"SELECT dimensions FROM wiki_vector_generations WHERE index_id=?",
				[id],
				|row| row.get(0),
			)?;
			let mut dimensions = usize::try_from(stored_dimensions).map_err(|_| invalid())?;
			for row in rows {
				if dimensions == 0 {
					dimensions = row.vector.len();
				}
				if dimensions == 0
					|| row.vector.len() != dimensions
					|| row.vector.iter().any(|x| !x.is_finite())
				{
					return Err(invalid());
				}
				let norm = row
					.vector
					.iter()
					.map(|x| f64::from(*x).powi(2))
					.sum::<f64>()
					.sqrt();
				if !norm.is_finite() || norm == 0.0 {
					return Err(invalid());
				}
				let mut bytes = Vec::with_capacity(dimensions * 4);
				for value in &row.vector {
					bytes.extend_from_slice(&((*value as f64 / norm) as f32).to_le_bytes());
				}
				let written = storage.connection.execute(
					"INSERT INTO wiki_section_vectors(index_id,section_id,vector) SELECT ?,id,? FROM \
					 sections WHERE id=? AND index_id=?",
					params![id, bytes, row.section_id, id],
				)?;
				if written != 1 {
					return Err(invalid());
				}
			}
			storage.connection.execute(
				"UPDATE wiki_vector_generations SET dimensions=? WHERE index_id=?",
				params![dimensions as i64, id],
			)?;
			check_file_identity(Path::new(&storage.path), &storage.identity)?;
			Ok(())
		})
	}

	/// Publish only an exhaustive generation belonging to the unchanged import.
	pub fn publish_vector_import(
		&self,
		token: &str,
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<()> {
		self.transaction(|storage| {
			let id = storage.active_vector_import(token)?;
			let (sections, vectors, dimensions): (i64, i64, i64) = storage.connection.query_row(
				"SELECT (SELECT count(*) FROM sections WHERE index_id=?), (SELECT count(*) FROM \
				 wiki_section_vectors WHERE index_id=?), dimensions FROM wiki_vector_generations \
				 WHERE index_id=?",
				params![id, id, id],
				|row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
			)?;
			if sections != vectors || (sections > 0 && dimensions <= 0) {
				return Err(invalid());
			}
			let mut statement = storage.connection.prepare(
				"SELECT s.id,v.vector FROM sections s LEFT JOIN wiki_section_vectors v ON \
				 v.index_id=s.index_id AND v.section_id=s.id WHERE s.index_id=?",
			)?;
			let mut rows = statement.query([id])?;
			while let Some(row) = rows.next()? {
				check()?;
				let bytes: Option<Vec<u8>> = row.get(1).map_err(|_| invalid())?;
				let bytes = bytes.ok_or_else(invalid)?;
				if !usize::try_from(dimensions).is_ok_and(|dimensions| valid_vector(&bytes, dimensions))
				{
					return Err(invalid());
				}
			}
			check()?;
			storage
				.connection
				.execute("UPDATE wiki_vector_generations SET complete=1 WHERE index_id=?", [id])?;
			check_file_identity(Path::new(&storage.path), &storage.identity)?;
			Ok(())
		})
	}

	/// Atomically expose the hidden fulltext index after optional preparation.
	pub fn publish_deferred_import(&self, token: &str, name: &str) -> CoreResult<()> {
		self.transaction(|storage| {
			let id = storage.vector_owner(token)?;
			// Incomplete vectors remain durable checkpoints, excluded from all
			// searches.
			let (_, hidden): (String, String) = serde_json::from_str(token).map_err(|_| invalid())?;
			storage
				.connection
				.execute("INSERT INTO wiki_vector_publications(index_id) VALUES(?)", [id])?;
			let changed = storage.connection.execute(
				"UPDATE doc_indexes SET name=? WHERE id=? AND name=? AND name GLOB '__building__*'",
				params![crate::storage::sqlite_text(name), id, hidden],
			)?;
			if changed != 1 {
				return Err(invalid());
			}
			storage
				.connection
				.execute("DELETE FROM wiki_vector_publications WHERE index_id=?", [id])?;
			check_file_identity(Path::new(&storage.path), &storage.identity)?;
			Ok(())
		})
	}

	/// Undo this import only if it still owns its original, unmodified index.
	pub fn rollback_published_import(&self, token: &str) -> CoreResult<()> {
		self.transaction(|storage| {
			// A removed/replaced/modified index is not ours to delete.
			if let Ok(id) = storage.vector_owner(token) {
				storage.remove_by_id(id)?;
			}
			Ok(())
		})
	}
}

/// Read valid complete generations from the caller's existing read snapshot.
/// Bad rows invalidate their entire index, not other indexes.
pub fn read_vector_matrix(
	connection: &Connection,
	model: &str,
	dimensions: usize,
	index: Option<&str>,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<VectorMatrix> {
	read_vector_data(connection, model, dimensions, index, None, check, true)
}

pub(crate) fn read_scoped_vector_matrix(
	connection: &Connection,
	model: &str,
	dimensions: usize,
	index: Option<&str>,
	path: Option<crate::database::PathScope<'_>>,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<VectorMatrix> {
	read_vector_data(connection, model, dimensions, index, path, check, true)
}

// Bound the temporary matrix as well as its retained allocation. Count all
// sections, including out-of-scope and corrupt generations, so no path filter
// can underestimate what the validator may examine.
pub(crate) fn matrix_fits(
	connection: &Connection,
	model: &str,
	dimensions: usize,
	index: Option<&str>,
	budget: usize,
) -> CoreResult<bool> {
	let count: i64 = connection.query_row(
		"SELECT count(*) FROM sections s JOIN wiki_vector_generations g ON g.index_id=s.index_id \
		 JOIN doc_indexes i ON i.id=s.index_id WHERE g.complete=1 AND g.model=? AND g.dimensions=? \
		 AND i.name NOT GLOB '__building__*' AND (? IS NULL OR i.name=?)",
		params![model, dimensions as i64, index, index],
		|row| row.get(0),
	)?;
	// Vec growth can reserve nearly twice its length.
	Ok(usize::try_from(count)
		.ok()
		.and_then(|count| {
			dimensions
				.checked_mul(4)?
				.checked_add(8)?
				.checked_mul(count)?
				.checked_mul(2)
		})
		.is_some_and(|bytes| bytes <= budget))
}

/// Validate complete generations and collect scoped IDs without retaining
/// their vector matrices.
pub(crate) fn read_vector_ids(
	connection: &Connection,
	model: &str,
	dimensions: usize,
	index: Option<&str>,
	path: Option<crate::database::PathScope<'_>>,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<Vec<i64>> {
	Ok(read_vector_data(connection, model, dimensions, index, path, check, false)?.section_ids)
}

#[derive(Clone, Copy, Debug)]
struct ScoredRow {
	score: f64,
	order: usize,
	id:    i64,
}

impl PartialEq for ScoredRow {
	fn eq(&self, other: &Self) -> bool {
		self.score == other.score && self.order == other.order
	}
}
impl Eq for ScoredRow {}
impl PartialOrd for ScoredRow {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}
impl Ord for ScoredRow {
	fn cmp(&self, other: &Self) -> Ordering {
		// The heap root is the worst retained row.
		other
			.score
			.partial_cmp(&self.score)
			.unwrap_or(Ordering::Equal)
			.then_with(|| self.order.cmp(&other.order))
	}
}

struct ExactTopK {
	query: Vec<f64>,
	limit: usize,
	rows:  BinaryHeap<ScoredRow>,
}

impl ExactTopK {
	#[expect(
		clippy::suboptimal_flops,
		reason = "Separate multiplication and addition preserve the public score's rounding."
	)]
	fn new(query: &[f64], dimensions: usize, limit: usize) -> Self {
		let mut norm = 0.0f64;
		for &value in query {
			norm += value * value;
		}
		let norm = norm.sqrt();
		Self {
			query: query[..query.len().min(dimensions)]
				.iter()
				.map(|value| value / norm)
				.collect(),
			limit,
			rows: BinaryHeap::new(),
		}
	}

	#[expect(
		clippy::suboptimal_flops,
		reason = "Separate multiplication and addition preserve the public score's rounding."
	)]
	fn score(&self, row: &[f32], check: &dyn Fn() -> CoreResult<()>) -> CoreResult<f64> {
		let mut score = 0.0f64;
		for (column, (&value, &query)) in row.iter().zip(&self.query).enumerate() {
			if column != 0 && column % 1024 == 0 {
				check()?;
			}
			score += f64::from(value) * query;
		}
		Ok(score)
	}

	fn add(
		&mut self,
		id: i64,
		order: usize,
		row: &[f32],
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<()> {
		let score = self.score(row, check)?;
		insert_top_k(&mut self.rows, self.limit, ScoredRow { score, order, id });
		Ok(())
	}

	fn finish(self) -> Vec<ScoredRow> {
		self.rows.into_sorted_vec()
	}
}

fn insert_top_k(rows: &mut BinaryHeap<ScoredRow>, limit: usize, row: ScoredRow) {
	if limit == 0 {
		return;
	}
	if rows.len() < limit {
		rows.push(row);
	} else if rows.peek().is_some_and(|worst| row < *worst) {
		rows.pop();
		rows.push(row);
	}
}

/// Score cached normalized vectors in stable source order.
pub(crate) fn score_matrix(
	matrix: &VectorMatrix,
	query: &[f64],
	limit: usize,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<Vec<i64>> {
	let mut best = ExactTopK::new(query, matrix.dimensions, limit);
	for (order, (&id, row)) in matrix
		.section_ids
		.iter()
		.zip(matrix.matrix.chunks_exact(matrix.dimensions))
		.enumerate()
	{
		check()?;
		best.add(id, order, row, check)?;
	}
	Ok(best.finish().into_iter().map(|row| row.id).collect())
}

/// Read and score one row at a time. A generation has its own bounded top-k,
/// which is committed only after every row (including out-of-scope rows) and
/// its vector count have been validated.
pub(crate) fn score_stream(
	connection: &Connection,
	model: &str,
	dimensions: usize,
	index: Option<&str>,
	path: Option<crate::database::PathScope<'_>>,
	query: &[f64],
	limit: usize,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<Vec<i64>> {
	if dimensions == 0 {
		return Ok(Vec::new());
	}
	let mut best = ExactTopK::new(query, dimensions, limit);
	let mut generation_best = BinaryHeap::new();
	let mut order = 0usize;
	let mut normalized = Vec::new();
	let mut generations = connection.prepare(
		"SELECT g.index_id FROM wiki_vector_generations g JOIN doc_indexes i ON i.id=g.index_id \
		 WHERE g.complete=1 AND g.model=? AND g.dimensions=? AND i.name NOT GLOB '__building__*' \
		 AND (? IS NULL OR i.name=?) ORDER BY i.id",
	)?;
	let ids = generations
		.query_map(params![model, dimensions as i64, index, index], |row| row.get::<_, i64>(0))?;
	for id in ids {
		check()?;
		let id = id?;
		generation_best.clear();
		let mut statement = connection.prepare(SCOPED_VECTOR_ROWS)?;
		let mut rows = statement.query([id])?;
		let mut valid = true;
		let mut count = 0usize;
		while let Some(row) = rows.next()? {
			check()?;
			count += 1;
			let selected = match path {
				None => true,
				Some(path) => {
					matches!(row.get_ref(2)?, rusqlite::types::ValueRef::Text(value) if path.matches(value))
				},
			};
			let rusqlite::types::ValueRef::Blob(bytes) = row.get_ref(1)? else {
				valid = false;
				break;
			};
			if Some(bytes.len()) != dimensions.checked_mul(4) {
				valid = false;
				break;
			}
			normalized.clear();
			if selected {
				normalized.reserve(dimensions);
			}
			let mut norm = 0.0f64;
			for (column, chunk) in bytes.as_chunks::<4>().0.iter().enumerate() {
				if column != 0 && column % 1024 == 0 {
					check()?;
				}
				let value = f32::from_le_bytes(*chunk);
				if !value.is_finite() {
					valid = false;
					break;
				}
				norm += f64::from(value).powi(2);
				if selected {
					normalized.push(value);
				}
			}
			if !valid || !norm.is_finite() || norm == 0.0 {
				valid = false;
				break;
			}
			if selected {
				let scale = norm.sqrt();
				for (column, value) in normalized.iter_mut().enumerate() {
					if column != 0 && column % 1024 == 0 {
						check()?;
					}
					*value = (f64::from(*value) / scale) as f32;
				}
				let score = best.score(&normalized, check)?;
				insert_top_k(&mut generation_best, limit, ScoredRow { score, order, id: row.get(0)? });
				order += 1;
			}
		}
		let vector_count: i64 = connection.query_row(
			"SELECT count(*) FROM wiki_section_vectors WHERE index_id=?",
			[id],
			|row| row.get(0),
		)?;
		if valid && usize::try_from(vector_count).ok() == Some(count) {
			for row in generation_best.drain() {
				insert_top_k(&mut best.rows, limit, row);
			}
		}
	}
	Ok(best.finish().into_iter().map(|row| row.id).collect())
}

fn read_vector_data(
	connection: &Connection,
	model: &str,
	dimensions: usize,
	index: Option<&str>,
	path: Option<crate::database::PathScope<'_>>,
	check: &dyn Fn() -> CoreResult<()>,
	include_matrix: bool,
) -> CoreResult<VectorMatrix> {
	let mut result = VectorMatrix { section_ids: Vec::new(), matrix: Vec::new(), dimensions };
	if dimensions == 0 {
		return Ok(result);
	}
	let mut generations = connection.prepare(
		"SELECT g.index_id FROM wiki_vector_generations g JOIN doc_indexes i ON i.id=g.index_id \
		 WHERE g.complete=1 AND g.model=? AND g.dimensions=? AND i.name NOT GLOB '__building__*' \
		 AND (? IS NULL OR i.name=?) ORDER BY i.id",
	)?;
	let ids = generations
		.query_map(params![model, dimensions as i64, index, index], |row| row.get::<_, i64>(0))?;
	for id in ids {
		check()?;
		let id = id?;
		let mut statement = connection.prepare(SCOPED_VECTOR_ROWS)?;
		let mut rows = statement.query([id])?;
		let start = result.section_ids.len();
		let mut valid = true;
		let mut section_count = 0usize;
		while let Some(row) = rows.next()? {
			check()?;
			let section_id: i64 = row.get(0)?;
			section_count += 1;
			let selected = match path {
				None => true,
				Some(path) => {
					matches!(row.get_ref(2)?, rusqlite::types::ValueRef::Text(value) if path.matches(value))
				},
			};
			let rusqlite::types::ValueRef::Blob(bytes) = row.get_ref(1)? else {
				valid = false;
				break;
			};
			if Some(bytes.len()) != dimensions.checked_mul(4) {
				valid = false;
				break;
			}
			let mut norm = 0.0f64;
			for (column, chunk) in bytes.as_chunks::<4>().0.iter().enumerate() {
				if column != 0 && column % 1024 == 0 {
					check()?;
				}
				let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
				if !value.is_finite() {
					valid = false;
					break;
				}
				norm += f64::from(value).powi(2);
				if include_matrix && selected {
					result.matrix.push(value);
				}
			}
			if !valid || !norm.is_finite() || norm == 0.0 {
				valid = false;
				break;
			}
			if include_matrix && selected {
				let scale = norm.sqrt();
				let begin = result.matrix.len() - dimensions;
				for (column, value) in result.matrix[begin..].iter_mut().enumerate() {
					if column != 0 && column % 1024 == 0 {
						check()?;
					}
					*value = (f64::from(*value) / scale) as f32;
				}
			}
			if selected {
				result.section_ids.push(section_id);
			}
		}
		let vector_count: i64 = connection.query_row(
			"SELECT count(*) FROM wiki_section_vectors WHERE index_id=?",
			[id],
			|row| row.get(0),
		)?;
		if !valid || vector_count as usize != section_count {
			result.section_ids.truncate(start);
			result.matrix.truncate(start * dimensions);
		}
	}
	Ok(result)
}

#[cfg(test)]
mod scoped_tests {
	use super::*;
	use crate::database::PathScope;

	#[test]
	fn scoped_vectors_validate_whole_generation_before_selecting() {
		let connection = Connection::open_in_memory().unwrap();
		connection
			.execute_batch(
				"CREATE TABLE doc_indexes(id INTEGER PRIMARY KEY,name TEXT);
			 CREATE TABLE documents(id INTEGER PRIMARY KEY,relative_path TEXT);
			 CREATE TABLE sections(id INTEGER PRIMARY KEY,index_id INTEGER,document_id INTEGER,ordinal \
				 INTEGER);
			 CREATE TABLE wiki_vector_generations(index_id INTEGER,model TEXT,dimensions INTEGER,complete \
				 INTEGER);
			 CREATE TABLE wiki_section_vectors(index_id INTEGER,section_id INTEGER,vector BLOB);
			 INSERT INTO doc_indexes VALUES(1,'one'),(2,'two');
			 INSERT INTO documents VALUES(1,'scope/a.md'),(2,'outside.md'),(3,'scope/b.md');
			 INSERT INTO sections VALUES(1,1,1,0),(2,1,2,0),(3,2,3,0);
			 INSERT INTO wiki_vector_generations VALUES(1,'model',2,1),(2,'model',2,1);
			 INSERT INTO wiki_section_vectors VALUES
			 (1,1,x'0000404000008040'),(1,2,x'0000803f00000000'),(2,3,x'000000000000803f');",
			)
			.unwrap();
		let scope = PathScope::validate(Some("scope/")).unwrap();
		assert!(!matrix_fits(&connection, "model", 2, None, 95).unwrap());
		assert!(matrix_fits(&connection, "model", 2, None, 96).unwrap());
		let matrix =
			read_scoped_vector_matrix(&connection, "model", 2, None, scope, &|| Ok(())).unwrap();
		assert_eq!(matrix.section_ids, vec![1, 3]);
		assert_eq!(matrix.matrix.len(), 4);
		assert_eq!(read_vector_ids(&connection, "model", 2, None, scope, &|| Ok(())).unwrap(), vec![
			1, 3
		]);
		assert_eq!(
			score_stream(&connection, "model", 2, None, scope, &[1.0, 0.0], 10, &|| Ok(())).unwrap(),
			vec![1, 3]
		);
		connection
			.execute("UPDATE wiki_section_vectors SET vector=x'00' WHERE section_id=2", [])
			.unwrap();
		let matrix =
			read_scoped_vector_matrix(&connection, "model", 2, None, scope, &|| Ok(())).unwrap();
		assert_eq!(matrix.section_ids, vec![3]);
		assert_eq!(matrix.matrix.len(), 2);
		assert_eq!(
			score_stream(&connection, "model", 2, None, scope, &[1.0, 0.0], 10, &|| Ok(())).unwrap(),
			vec![3]
		);
		assert_eq!(read_vector_ids(&connection, "model", 2, None, scope, &|| Ok(())).unwrap(), vec![
			3
		]);
	}

	#[test]
	fn streamed_scores_match_matrix_bits_and_source_order() {
		let connection = Connection::open_in_memory().unwrap();
		connection.execute_batch(
			"CREATE TABLE doc_indexes(id INTEGER PRIMARY KEY,name TEXT);
			 CREATE TABLE documents(id INTEGER PRIMARY KEY,relative_path TEXT);
			 CREATE TABLE sections(id INTEGER PRIMARY KEY,index_id INTEGER,document_id INTEGER,ordinal INTEGER);
			 CREATE TABLE wiki_vector_generations(index_id INTEGER,model TEXT,dimensions INTEGER,complete INTEGER);
			 CREATE TABLE wiki_section_vectors(index_id INTEGER,section_id INTEGER,vector BLOB);
			 INSERT INTO doc_indexes VALUES(1,'one'),(2,'bad'),(3,'three');
			 INSERT INTO documents VALUES(1,'scope/a'),(2,'scope2/not-a-child'),(3,'scope/b'),(4,'scope/c');
			 INSERT INTO wiki_vector_generations VALUES(1,'model',3,1),(2,'model',3,1),(3,'model',3,1);"
		).unwrap();
		for i in 0..1500i64 {
			let generation = if i < 500 {
				1
			} else if i < 1000 {
				2
			} else {
				3
			};
			let document = if i == 999 {
				2
			} else if generation == 1 {
				1
			} else if generation == 2 {
				3
			} else {
				4
			};
			let values = if i % 7 == 0 {
				[3.0f32, 4.0, -2.0]
			} else {
				[1.0f32, 2.0, 3.0]
			};
			let bytes: Vec<u8> = values.into_iter().flat_map(f32::to_le_bytes).collect();
			connection
				.execute("INSERT INTO sections VALUES(?,?,?,?)", params![
					i + 1,
					generation,
					document,
					499 - (i % 500)
				])
				.unwrap();
			connection
				.execute("INSERT INTO wiki_section_vectors VALUES(?,?,?)", params![
					generation,
					i + 1,
					bytes
				])
				.unwrap();
		}
		connection
			.execute("UPDATE wiki_section_vectors SET vector=x'00' WHERE section_id=1000", [])
			.unwrap();
		let scope = PathScope::validate(Some("scope/")).unwrap();
		let matrix =
			read_scoped_vector_matrix(&connection, "model", 3, None, scope, &|| Ok(())).unwrap();
		assert_eq!(
			matrix.section_ids,
			(1..=500i64)
				.rev()
				.chain((1001..=1500).rev())
				.collect::<Vec<_>>(),
		);
		let query = [0.123456789012345, -0.75, 1.25];
		for (&id, row) in matrix.section_ids.iter().zip(matrix.matrix.chunks_exact(3)) {
			let raw = if (id - 1) % 7 == 0 {
				[3.0f32, 4.0, -2.0]
			} else {
				[1.0f32, 2.0, 3.0]
			};
			let mut squared = 0.0f64;
			for value in raw {
				squared += f64::from(value).powi(2);
			}
			let norm = squared.sqrt();
			for (value, raw) in row.iter().zip(raw) {
				assert_eq!(value.to_bits(), ((f64::from(raw) / norm) as f32).to_bits());
			}
		}
		for limit in [0, 1, 37, 999, 1200] {
			let stream =
				score_stream(&connection, "model", 3, None, scope, &query, limit, &|| Ok(())).unwrap();
			assert_eq!(stream, score_matrix(&matrix, &query, limit, &|| Ok(())).unwrap());
			let mut actual = ExactTopK::new(&query, 3, limit);
			for (order, (&id, row)) in matrix
				.section_ids
				.iter()
				.zip(matrix.matrix.chunks_exact(3))
				.enumerate()
			{
				actual.add(id, order, row, &|| Ok(())).unwrap();
			}
			let mut expected = Vec::new();
			let norm = query.iter().map(|v| v * v).sum::<f64>().sqrt();
			for (order, (&id, row)) in matrix
				.section_ids
				.iter()
				.zip(matrix.matrix.chunks_exact(3))
				.enumerate()
			{
				let mut score = 0.0;
				for (value, query) in row.iter().zip(query) {
					score += f64::from(*value) * (query / norm);
				}
				expected.push((score, order, id));
			}
			expected.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then_with(|| a.1.cmp(&b.1)));
			expected.truncate(limit);
			let actual = actual.finish();
			assert_eq!(actual.len(), expected.len());
			for (actual, expected) in actual.iter().zip(expected) {
				assert_eq!(actual.id, expected.2);
				assert_eq!(actual.score.to_bits(), expected.0.to_bits());
			}
		}
		let checks = std::cell::Cell::new(0);
		let cancelled = || {
			checks.set(checks.get() + 1);
			if checks.get() > 80 {
				Err(KnowledgeError::message("cancelled"))
			} else {
				Ok(())
			}
		};
		assert!(score_stream(&connection, "model", 3, None, scope, &query, 10, &cancelled).is_err());
		assert!(checks.get() > 80);
	}
}
