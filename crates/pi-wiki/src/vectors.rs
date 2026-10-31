//! Optional vectors derived from published wiki sections.
//!
//! Import ownership and generation state are deliberately kept in the same
//! database as the source. No transaction is held while a model is called.
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::{
	database::{CoreResult, WikiError, check_file_identity},
	storage::Storage,
};

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

/// Complete compatible generations, in stable source order.
pub struct VectorMatrix {
	pub section_ids: Vec<i64>,
	pub matrix:      Vec<f32>,
	pub dimensions:  usize,
}

fn invalid() -> WikiError {
	WikiError::message("Documentation vector generation is no longer current")
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
				"SELECT id,raw_markdown FROM sections WHERE index_id=? AND id>? ORDER BY id LIMIT ?",
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
				if bytes.len() != (dimensions as usize).checked_mul(4).ok_or_else(invalid)? {
					return Err(invalid());
				}
				let mut norm = 0.0f64;
				for chunk in bytes.as_chunks::<4>().0 {
					let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
					if !value.is_finite() {
						return Err(invalid());
					}
					norm += f64::from(value).powi(2);
				}
				if !norm.is_finite() || norm == 0.0 {
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
			storage.connection.execute(
				"DELETE FROM wiki_section_vectors WHERE index_id=? AND EXISTS(SELECT 1 FROM \
				 wiki_vector_generations WHERE index_id=? AND complete=0)",
				params![id, id],
			)?;
			storage
				.connection
				.execute("DELETE FROM wiki_vector_generations WHERE index_id=? AND complete=0", [id])?;
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
	read_vector_data(connection, model, dimensions, index, check, true)
}

/// Validate generations and collect section IDs without materializing vectors.
pub(crate) fn read_vector_ids(
	connection: &Connection,
	model: &str,
	dimensions: usize,
	index: Option<&str>,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<Vec<i64>> {
	Ok(read_vector_data(connection, model, dimensions, index, check, false)?.section_ids)
}

fn read_vector_data(
	connection: &Connection,
	model: &str,
	dimensions: usize,
	index: Option<&str>,
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
		let mut statement = connection.prepare(
			"SELECT s.id,v.vector FROM sections s LEFT JOIN wiki_section_vectors v ON \
			 v.index_id=s.index_id AND v.section_id=s.id WHERE s.index_id=? ORDER BY \
			 s.document_id,s.ordinal,s.id",
		)?;
		let mut rows = statement.query([id])?;
		let start = result.section_ids.len();
		let mut valid = true;
		while let Some(row) = rows.next()? {
			check()?;
			let section_id: i64 = row.get(0)?;
			let rusqlite::types::ValueRef::Blob(bytes) = row.get_ref(1)? else {
				valid = false;
				break;
			};
			if Some(bytes.len()) != dimensions.checked_mul(4) {
				valid = false;
				break;
			}
			let mut norm = 0.0f64;
			for chunk in bytes.as_chunks::<4>().0 {
				let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
				if !value.is_finite() {
					valid = false;
					break;
				}
				norm += f64::from(value).powi(2);
				if include_matrix {
					result.matrix.push(value);
				}
			}
			if !valid || !norm.is_finite() || norm == 0.0 {
				valid = false;
				break;
			}
			if include_matrix {
				let scale = norm.sqrt();
				let begin = result.matrix.len() - dimensions;
				for value in &mut result.matrix[begin..] {
					*value = (f64::from(*value) / scale) as f32;
				}
			}
			result.section_ids.push(section_id);
		}
		let vector_count: i64 = connection.query_row(
			"SELECT count(*) FROM wiki_section_vectors WHERE index_id=?",
			[id],
			|row| row.get(0),
		)?;
		if !valid || vector_count as usize != result.section_ids.len() - start {
			result.section_ids.truncate(start);
			result.matrix.truncate(start * dimensions);
		}
	}
	Ok(result)
}
