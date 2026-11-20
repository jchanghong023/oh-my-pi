//! Persistent, disposable HNSW generations over authoritative SQLite vectors.
use std::{
	cell::RefCell,
	collections::VecDeque,
	fmt::Display,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
		mpsc::{self, Receiver, RecvTimeoutError},
	},
	time::Duration,
};

use rayon::prelude::*;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

use crate::{
	database::{CoreResult, KnowledgeError, PATH_SCOPE_FILTER, PathScope},
	parallel,
};

const FORMAT: i64 = 1;
const CONNECTIVITY: usize = 32;
const EXPANSION_ADD: usize = 256;
const EXPANSION_SEARCH: usize = 128;
const SHARD_BYTES: usize = 128 * 1024 * 1024;
const MAX_SHARD_ROWS: usize = 2048;
const EXACT_SCOPE_ROWS: usize = 256;
static INDEX_BYTES: AtomicUsize = AtomicUsize::new(0);

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS wiki_ann_generations (
 index_id INTEGER PRIMARY KEY, token TEXT NOT NULL, database_identity TEXT NOT NULL,
 dimensions INTEGER NOT NULL, vector_count INTEGER NOT NULL,
 shard_count INTEGER NOT NULL, format INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wiki_ann_shards (
 index_id INTEGER NOT NULL, shard INTEGER NOT NULL, first_id INTEGER NOT NULL,
 last_id INTEGER NOT NULL, vector_count INTEGER NOT NULL, digest BLOB NOT NULL,
 data BLOB NOT NULL, PRIMARY KEY(index_id,shard)
);
CREATE TRIGGER IF NOT EXISTS wiki_ann_vector_insert BEFORE INSERT ON wiki_section_vectors BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id=NEW.index_id;
 DELETE FROM wiki_ann_shards WHERE index_id=NEW.index_id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_vector_delete BEFORE DELETE ON wiki_section_vectors BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id=OLD.index_id;
 DELETE FROM wiki_ann_shards WHERE index_id=OLD.index_id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_vector_update BEFORE UPDATE ON wiki_section_vectors BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id IN (OLD.index_id,NEW.index_id);
 DELETE FROM wiki_ann_shards WHERE index_id IN (OLD.index_id,NEW.index_id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_generation_insert BEFORE INSERT ON wiki_vector_generations \
                                 BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id=NEW.index_id;
 DELETE FROM wiki_ann_shards WHERE index_id=NEW.index_id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_generation_delete BEFORE DELETE ON wiki_vector_generations \
                                 BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id=OLD.index_id;
 DELETE FROM wiki_ann_shards WHERE index_id=OLD.index_id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_generation_update BEFORE UPDATE ON wiki_vector_generations \
                                 BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id IN (OLD.index_id,NEW.index_id);
 DELETE FROM wiki_ann_shards WHERE index_id IN (OLD.index_id,NEW.index_id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_shard_insert BEFORE INSERT ON wiki_ann_shards BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id=NEW.index_id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_shard_delete BEFORE DELETE ON wiki_ann_shards BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id=OLD.index_id;
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_shard_update BEFORE UPDATE ON wiki_ann_shards BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id IN (OLD.index_id,NEW.index_id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_ann_manifest_update BEFORE UPDATE ON wiki_ann_generations BEGIN
 DELETE FROM wiki_ann_generations WHERE index_id IN (OLD.index_id,NEW.index_id);
 DELETE FROM wiki_ann_shards WHERE index_id IN (OLD.index_id,NEW.index_id);
END;
";

fn unavailable(message: impl Display) -> KnowledgeError {
	KnowledgeError::message(format!("Knowledge vector index unavailable: {message}"))
}

/// Reservations include transient buffers and native scratch space, not just
/// cache entries. Arc owners keep their reservation until the last user drops.
struct MemoryLease(usize);
impl MemoryLease {
	fn acquire(bytes: usize) -> CoreResult<Self> {
		let budget = parallel::memory_budget(4, 64 * 1024 * 1024 * 1024);
		INDEX_BYTES
			.try_update(Ordering::AcqRel, Ordering::Relaxed, |used| {
				used.checked_add(bytes).filter(|next| *next <= budget)
			})
			.map_err(|_| unavailable("insufficient memory budget; fulltext remains available"))?;
		Ok(Self(bytes))
	}

	fn grow(&mut self, bytes: usize) -> CoreResult<()> {
		let mut extra = Self::acquire(bytes)?;
		self.0 += extra.0;
		extra.0 = 0;
		Ok(())
	}

	fn take(&mut self, bytes: usize) -> CoreResult<Self> {
		self.0 = self
			.0
			.checked_sub(bytes)
			.ok_or_else(|| unavailable("native index exceeded its memory reservation"))?;
		Ok(Self(bytes))
	}
}
impl Drop for MemoryLease {
	fn drop(&mut self) {
		INDEX_BYTES.fetch_sub(self.0, Ordering::AcqRel);
	}
}

const fn options(dimensions: usize) -> IndexOptions {
	IndexOptions {
		dimensions,
		// Stored vectors are unit-normalized; dot product avoids recalculating
		// both norms at every graph edge. Final ranking uses original f32 cosine.
		metric: MetricKind::IP,
		quantization: ScalarKind::F32,
		connectivity: CONNECTIVITY,
		expansion_add: EXPANSION_ADD,
		expansion_search: EXPANSION_SEARCH,
		multi: false,
	}
}

fn native_scratch_bytes(rows: usize, dimensions: usize) -> CoreResult<usize> {
	dimensions
		.checked_mul(4)
		.and_then(|bytes| bytes.checked_add(rows.div_ceil(8)))
		.and_then(|bytes| bytes.checked_add(EXPANSION_ADD.max(EXPANSION_SEARCH) * 64 + 1024))
		.and_then(|bytes| bytes.checked_mul(parallel::hardware_threads()))
		.ok_or_else(|| unavailable("index scratch size overflow"))
}

fn working_bytes(rows: usize, dimensions: usize) -> CoreResult<usize> {
	// USearch 2.26.6 uses geometrically growing arenas, initially 8 MiB each
	// for graph and vectors. Include queued input, arena slack, serialization
	// and SQLite's BLOB copy before allocating anything.
	let per_row = dimensions
		.checked_mul(20)
		.and_then(|bytes| bytes.checked_add(2048))
		.ok_or_else(|| unavailable("index size overflow"))?;
	rows
		.checked_mul(per_row)
		.and_then(|bytes| bytes.checked_add(16 * 1024 * 1024))
		.and_then(|bytes| bytes.checked_add(native_scratch_bytes(rows, dimensions).ok()?))
		.ok_or_else(|| unavailable("index size overflow"))
}

fn append_vector(bytes: &[u8], dimensions: usize, values: &mut Vec<f32>) -> CoreResult<()> {
	if dimensions.checked_mul(4) != Some(bytes.len()) {
		return Err(unavailable("invalid stored vector dimensions"));
	}
	let mut norm = 0.0f64;
	for chunk in bytes.as_chunks::<4>().0 {
		let value = f32::from_le_bytes(*chunk);
		if !value.is_finite() {
			return Err(unavailable("nonfinite stored vector"));
		}
		norm += f64::from(value).powi(2);
		values.push(value);
	}
	if !crate::vectors::unit_norm(norm) {
		return Err(unavailable("stored vector is not normalized"));
	}
	Ok(())
}

struct ShardInput {
	shard:   i64,
	ids:     Vec<i64>,
	vectors: Vec<f32>,
	memory:  MemoryLease,
}

struct BuiltShard {
	shard:    i64,
	first_id: i64,
	last_id:  i64,
	count:    usize,
	data:     Vec<u8>,
	_memory:  MemoryLease,
}

impl ShardInput {
	fn build(self, dimensions: usize, check: &dyn Fn() -> CoreResult<()>) -> CoreResult<BuiltShard> {
		let index = Index::new(&options(dimensions)).map_err(unavailable)?;
		index
			.reserve_capacity_and_threads(self.ids.len(), 1)
			.map_err(unavailable)?;
		// Concurrent insertion into one graph lost recall on the frozen corpus.
		// Parallelize independent shards, never mutations of the same graph.
		for (id, values) in self.ids.iter().zip(self.vectors.chunks_exact(dimensions)) {
			check()?;
			index.add(*id as u64, values).map_err(unavailable)?;
		}
		drop(self.vectors);
		check()?;
		let mut data = Vec::new();
		data
			.try_reserve_exact(index.serialized_length())
			.map_err(unavailable)?;
		data.resize(index.serialized_length(), 0);
		index.save_to_buffer(&mut data).map_err(unavailable)?;
		Ok(BuiltShard {
			shard: self.shard,
			first_id: self.ids[0],
			last_id: self.ids[self.ids.len() - 1],
			count: self.ids.len(),
			data,
			_memory: self.memory,
		})
	}
}

struct BuildPipeline<'a, 'scope> {
	scope:      Option<&'a rayon::Scope<'scope>>,
	connection: &'a Connection,
	check:      &'a dyn Fn() -> CoreResult<()>,
	workers:    usize,
	stopped:    Arc<AtomicBool>,
	pending:    VecDeque<Receiver<CoreResult<BuiltShard>>>,
}

impl Drop for BuildPipeline<'_, '_> {
	fn drop(&mut self) {
		self.stopped.store(true, Ordering::Relaxed);
	}
}

impl<'a, 'scope> BuildPipeline<'a, 'scope> {
	fn new(
		scope: Option<&'a rayon::Scope<'scope>>,
		connection: &'a Connection,
		check: &'a dyn Fn() -> CoreResult<()>,
		workers: usize,
	) -> Self {
		Self {
			scope,
			connection,
			check,
			workers,
			stopped: Arc::new(AtomicBool::new(false)),
			pending: VecDeque::new(),
		}
	}

	fn write(&self, index_id: i64, built: BuiltShard) -> CoreResult<()> {
		(self.check)()?;
		let digest = Sha256::digest(&built.data);
		self.connection.execute(
			"INSERT INTO wiki_ann_shards(index_id,shard,first_id,last_id,vector_count,digest,data) \
			 VALUES(?,?,?,?,?,?,?)",
			params![
				index_id,
				built.shard,
				built.first_id,
				built.last_id,
				built.count as i64,
				digest.as_slice(),
				built.data
			],
		)?;
		Ok(())
	}

	fn receive(&mut self, index_id: i64) -> CoreResult<()> {
		let receiver = self.pending.pop_front().expect("pending index shard");
		let built = loop {
			(self.check)()?;
			match receiver.recv_timeout(Duration::from_millis(10)) {
				Ok(result) => break result?,
				Err(RecvTimeoutError::Timeout) => {},
				Err(RecvTimeoutError::Disconnected) => {
					return Err(unavailable("index build worker stopped"));
				},
			}
		};
		self.write(index_id, built)
	}

	fn read(
		&mut self,
		index_id: i64,
		dimensions: usize,
		total: usize,
		shard_rows: usize,
	) -> CoreResult<i64> {
		let mut statement = self.connection.prepare(
			"SELECT v.section_id,v.vector,s.id FROM wiki_section_vectors v LEFT JOIN sections s ON \
			 s.id=v.section_id AND s.index_id=v.index_id WHERE v.index_id=? ORDER BY v.section_id",
		)?;
		let mut rows = statement.query([index_id])?;
		let mut completed = 0usize;
		let mut shard = 0i64;
		while completed < total {
			(self.check)()?;
			if self.pending.len() >= self.workers {
				self.receive(index_id)?;
			}
			let count = shard_rows.min(total - completed);
			let memory = loop {
				match MemoryLease::acquire(working_bytes(count, dimensions)?) {
					Ok(memory) => break memory,
					Err(error) if self.pending.is_empty() => return Err(error),
					Err(_) => self.receive(index_id)?,
				}
			};
			let mut ids = Vec::new();
			ids.try_reserve_exact(count).map_err(unavailable)?;
			let mut vectors = Vec::new();
			vectors
				.try_reserve_exact(
					count
						.checked_mul(dimensions)
						.ok_or_else(|| unavailable("index size overflow"))?,
				)
				.map_err(unavailable)?;
			for _ in 0..count {
				(self.check)()?;
				let row = rows
					.next()?
					.ok_or_else(|| unavailable("incomplete vector generation"))?;
				let id: i64 = row.get(0)?;
				if row.get::<_, Option<i64>>(2)? != Some(id) {
					return Err(unavailable("orphaned section vector"));
				}
				append_vector(
					row.get_ref(1)?.as_blob().map_err(unavailable)?,
					dimensions,
					&mut vectors,
				)?;
				ids.push(id);
			}
			let input = ShardInput { shard, ids, vectors, memory };
			if let Some(scope) = self.scope {
				let stopped = Arc::clone(&self.stopped);
				let (sender, receiver) = mpsc::sync_channel(1);
				scope.spawn(move |_| {
					let result = input.build(dimensions, &|| {
						if stopped.load(Ordering::Relaxed) {
							Err(unavailable("index build cancelled"))
						} else {
							Ok(())
						}
					});
					let _ = sender.send(result);
				});
				self.pending.push_back(receiver);
			} else {
				self.write(index_id, input.build(dimensions, self.check)?)?;
			}
			completed += count;
			shard += 1;
		}
		if rows.next()?.is_some() {
			return Err(unavailable("vector generation count changed"));
		}
		while !self.pending.is_empty() {
			self.receive(index_id)?;
		}
		Ok(shard)
	}
}

/// The caller holds the publication transaction. No partially built shard set
/// is visible; committed raw embeddings survive a failed publication attempt.
pub(crate) fn build(
	connection: &Connection,
	identity: &str,
	index_id: i64,
	token: &str,
	dimensions: usize,
	total: usize,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<()> {
	check()?;
	connection.execute("DELETE FROM wiki_ann_generations WHERE index_id=?", [index_id])?;
	connection.execute("DELETE FROM wiki_ann_shards WHERE index_id=?", [index_id])?;
	if total > 0 && dimensions == 0 {
		return Err(unavailable("missing vector dimensions"));
	}
	let row_bytes = dimensions
		.checked_mul(4)
		.and_then(|bytes| bytes.checked_add(512))
		.ok_or_else(|| unavailable("index size overflow"))?;
	let mut shard_rows = (SHARD_BYTES / row_bytes).clamp(1, MAX_SHARD_ROWS);
	while shard_rows > 1
		&& working_bytes(shard_rows, dimensions)?
			> parallel::memory_budget(4, 64 * 1024 * 1024 * 1024)
	{
		shard_rows = shard_rows.div_ceil(2);
	}
	let pool = if total > shard_rows {
		parallel::pool()
	} else {
		None
	};
	let shard = if let Some(pool) = pool {
		pool.in_place_scope(|scope| {
			BuildPipeline::new(Some(scope), connection, check, pool.current_num_threads())
				.read(index_id, dimensions, total, shard_rows)
		})
	} else {
		BuildPipeline::new(None, connection, check, 1).read(index_id, dimensions, total, shard_rows)
	}?;
	check()?;
	connection.execute(
		"INSERT INTO \
		 wiki_ann_generations(index_id,token,database_identity,dimensions,vector_count,shard_count,\
		 format) VALUES(?,?,?,?,?,?,?)",
		params![index_id, token, identity, dimensions as i64, total as i64, shard, FORMAT],
	)?;
	Ok(())
}

#[derive(Clone)]
struct ShardSpec {
	index_id: i64,
	shard:    i64,
	first_id: i64,
	last_id:  i64,
	count:    usize,
	digest:   Vec<u8>,
	bytes:    usize,
}

struct LoadedShard {
	index:   Index,
	// Field order is deliberate: the native view is destroyed before its
	// immutable backing allocation. Neither field escapes this owner.
	_data:   Vec<u8>,
	spec:    ShardSpec,
	guard:   String,
	_memory: MemoryLease,
}

impl LoadedShard {
	fn matches(&self, guard: &str, spec: &ShardSpec) -> bool {
		self.guard == guard
			&& self.spec.index_id == spec.index_id
			&& self.spec.shard == spec.shard
			&& self.spec.digest == spec.digest
	}
}

/// Ownership is per database engine; closing it releases native indexes.
/// Memory admission is process-wide, including concurrent engines/builds.
#[derive(Default)]
pub(crate) struct IndexCache(RefCell<VecDeque<Arc<LoadedShard>>>);
impl IndexCache {
	pub(crate) fn clear(&self) {
		self.0.borrow_mut().clear();
	}

	pub(crate) fn refresh_budget(&self) {
		let budget = parallel::memory_budget(4, 64 * 1024 * 1024 * 1024);
		let mut cache = self.0.borrow_mut();
		while INDEX_BYTES.load(Ordering::Relaxed) > budget {
			let Some(position) = cache.iter().position(|item| Arc::strong_count(item) == 1) else {
				break;
			};
			cache.remove(position);
		}
	}

	/// Admit all missing shards before reading their payloads. Otherwise a
	/// generation larger than the budget would repeatedly load and discard
	/// the same prefix on every query.
	fn reserve_load(
		&self,
		specs: &[ShardSpec],
		guard: &str,
		dimensions: usize,
	) -> CoreResult<MemoryLease> {
		let mut required = 0usize;
		let mut transient = 0usize;
		{
			let cache = self.0.borrow();
			for spec in specs {
				if cache.iter().any(|entry| entry.matches(guard, spec)) {
					continue;
				}
				let resident = spec
					.bytes
					.checked_add(spec.count.saturating_mul(128))
					.and_then(|bytes| {
						bytes.checked_add(native_scratch_bytes(spec.count, dimensions).ok()?)
					})
					.and_then(|bytes| bytes.checked_add(65536))
					.ok_or_else(|| unavailable("index size overflow"))?;
				required = required
					.checked_add(resident)
					.ok_or_else(|| unavailable("index size overflow"))?;
				transient = transient.max(spec.bytes);
			}
		}
		required = required
			.checked_add(transient)
			.ok_or_else(|| unavailable("index size overflow"))?;
		loop {
			match MemoryLease::acquire(required) {
				Ok(memory) => return Ok(memory),
				Err(error) => {
					let mut cache = self.0.borrow_mut();
					let Some(position) = cache.iter().position(|entry| {
						Arc::strong_count(entry) == 1
							&& !specs.iter().any(|spec| entry.matches(guard, spec))
					}) else {
						return Err(error);
					};
					cache.remove(position);
				},
			}
		}
	}

	fn load(
		&self,
		connection: &Connection,
		guard: &str,
		dimensions: usize,
		spec: &ShardSpec,
		memory: &mut MemoryLease,
	) -> CoreResult<Arc<LoadedShard>> {
		{
			let mut cache = self.0.borrow_mut();
			if let Some(position) = cache.iter().position(|item| item.matches(guard, spec)) {
				let item = cache.remove(position).expect("cached index");
				cache.push_back(Arc::clone(&item));
				return Ok(item);
			}
		}
		let mut statement = connection
			.prepare_cached("SELECT data FROM wiki_ann_shards WHERE index_id=? AND shard=?")?;
		let mut rows = statement.query(params![spec.index_id, spec.shard])?;
		let row = rows
			.next()?
			.ok_or_else(|| unavailable("missing index shard"))?;
		let stored = row.get_ref(0)?.as_blob().map_err(unavailable)?;
		let mut data = Vec::new();
		data.try_reserve_exact(stored.len()).map_err(unavailable)?;
		data.extend_from_slice(stored);
		drop(rows);
		drop(statement);
		if data.len() != spec.bytes || Sha256::digest(&data).as_slice() != spec.digest {
			return Err(unavailable("corrupt index shard; run /knowledge r retry"));
		}
		let metadata = Index::metadata_from_buffer(&data).map_err(unavailable)?;
		if metadata.dimensions != dimensions as u64
			|| metadata.count_present != spec.count as u64
			|| metadata.count_deleted != 0
			|| metadata.multi
			|| metadata.metric != MetricKind::IP
			|| metadata.quantization != ScalarKind::F32
			|| metadata.version_major != 2
			|| metadata.version_minor != 26
			|| metadata.version_patch != 6
		{
			return Err(unavailable("invalid index metadata; run /knowledge r retry"));
		}
		let index = Index::new(&options(dimensions)).map_err(unavailable)?;
		// SAFETY: data is immutable and moves into LoadedShard without moving
		// its heap allocation. LoadedShard drops index before _data; on errors,
		// the later-declared local index likewise drops before local data.
		unsafe { index.view_from_buffer(&data) }.map_err(unavailable)?;
		index.change_expansion_search(EXPANSION_SEARCH);
		if index.size() != spec.count || index.dimensions() != dimensions {
			return Err(unavailable("incomplete index shard"));
		}
		let resident = data.len()
			+ index.memory_usage().saturating_mul(5) / 4
			+ spec.count.saturating_mul(32)
			+ native_scratch_bytes(spec.count, dimensions)?;
		let memory = memory.take(resident)?;
		let loaded = Arc::new(LoadedShard {
			index,
			_data: data,
			spec: spec.clone(),
			guard: guard.to_owned(),
			_memory: memory,
		});
		self.0.borrow_mut().push_back(Arc::clone(&loaded));
		Ok(loaded)
	}
}

fn manifest(
	connection: &Connection,
	identity: &str,
	index_id: i64,
	token: &str,
	dimensions: usize,
	total: Option<usize>,
) -> CoreResult<Vec<ShardSpec>> {
	let header: Option<(i64, i64)> = connection
		.query_row(
			"SELECT vector_count,shard_count FROM wiki_ann_generations WHERE index_id=? AND token=? \
			 AND database_identity=? AND dimensions=? AND format=?",
			params![index_id, token, identity, dimensions as i64, FORMAT],
			|row| Ok((row.get(0)?, row.get(1)?)),
		)
		.optional()?;
	let (count, shards) =
		header.ok_or_else(|| unavailable("index needs rebuilding; run /knowledge r retry"))?;
	let count = usize::try_from(count).map_err(unavailable)?;
	let shards = usize::try_from(shards).map_err(unavailable)?;
	if total.is_some_and(|total| total != count) || (count > 0 && (dimensions == 0 || shards == 0)) {
		return Err(unavailable("incomplete index manifest"));
	}
	let mut statement = connection.prepare(
		"SELECT shard,first_id,last_id,vector_count,digest,length(data) FROM wiki_ann_shards WHERE \
		 index_id=? ORDER BY shard",
	)?;
	let mut rows = statement.query([index_id])?;
	let mut specs: Vec<ShardSpec> = Vec::new();
	let mut sum = 0usize;
	while let Some(row) = rows.next()? {
		let spec = ShardSpec {
			index_id,
			shard: row.get(0)?,
			first_id: row.get(1)?,
			last_id: row.get(2)?,
			count: usize::try_from(row.get::<_, i64>(3)?).map_err(unavailable)?,
			digest: row.get(4)?,
			bytes: usize::try_from(row.get::<_, i64>(5)?).map_err(unavailable)?,
		};
		if spec.shard != specs.len() as i64
			|| spec.count == 0
			|| spec.count > MAX_SHARD_ROWS
			|| spec.first_id > spec.last_id
			|| spec.digest.len() != 32
			|| specs
				.last()
				.is_some_and(|previous| previous.last_id >= spec.first_id)
		{
			return Err(unavailable("invalid index shard manifest"));
		}
		sum = sum
			.checked_add(spec.count)
			.ok_or_else(|| unavailable("index size overflow"))?;
		specs.push(spec);
		if specs.len() > shards || sum > count {
			return Err(unavailable("invalid index shard count"));
		}
	}
	if sum != count || specs.len() != shards {
		return Err(unavailable("incomplete index shards"));
	}
	Ok(specs)
}

pub(crate) fn published(
	connection: &Connection,
	identity: &str,
	index_id: i64,
	token: &str,
	dimensions: usize,
	total: usize,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<bool> {
	let Ok(specs) = manifest(connection, identity, index_id, token, dimensions, Some(total)) else {
		check()?;
		return Ok(false);
	};
	let cache = IndexCache::default();
	for spec in specs {
		check()?;
		let mut memory = cache.reserve_load(std::slice::from_ref(&spec), token, dimensions)?;
		if cache
			.load(connection, token, dimensions, &spec, &mut memory)
			.is_err()
		{
			check()?;
			return Ok(false);
		}
		cache.clear();
	}
	check()?;
	Ok(true)
}

pub(crate) struct Generation {
	pub(crate) dimensions: usize,
	shards:                Vec<Arc<LoadedShard>>,
	selected:              Option<Vec<i64>>,
	_scope_memory:         Option<MemoryLease>,
}

/// Filters are compiled before ANN search, never applied to a fixed global
/// top-k. Only selected shards are loaded; small eligible sets use exact score.
pub(crate) fn prepare(
	connection: &Connection,
	identity: &str,
	guard: &str,
	cache: &IndexCache,
	model: &str,
	index_name: Option<&str>,
	path: Option<PathScope<'_>>,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<(Vec<Generation>, Option<String>)> {
	let mut statement = connection.prepare(
		"SELECT g.index_id,g.token,g.dimensions FROM wiki_vector_generations g JOIN doc_indexes i \
		 ON i.id=g.index_id WHERE g.complete=1 AND g.model=? AND i.name NOT GLOB '__building__*' \
		 AND (? IS NULL OR i.name=?) ORDER BY i.id",
	)?;
	let mut rows = statement.query(params![model, index_name, index_name])?;
	let mut generations = Vec::new();
	let mut failure = None;
	while let Some(row) = rows.next()? {
		check()?;
		let id: i64 = row.get(0)?;
		let token = row.get::<_, String>(1);
		let dimensions = row.get::<_, i64>(2);
		let loaded = (|| -> CoreResult<Generation> {
			let token = token?;
			let dimensions = usize::try_from(dimensions?).map_err(unavailable)?;
			let specs = manifest(connection, identity, id, &token, dimensions, None)?;
			let mut scope_memory = None;
			let selected = if let Some(path) = path {
				let scope = path.as_str().as_bytes();
				let count = specs.iter().map(|spec| spec.count).sum::<usize>();
				let mut memory = MemoryLease::acquire(0)?;
				let mut ids = Vec::new();
				let mut scoped = connection.prepare(&format!(
					"SELECT s.id FROM documents d CROSS JOIN sections s ON s.document_id=d.id AND \
					 s.index_id=d.index_id WHERE d.index_id=?1 AND {PATH_SCOPE_FILTER}"
				))?;
				let mut scoped_rows =
					scoped.query(params![id, scope, scope.len() as i64, scope.ends_with(b"/")])?;
				while let Some(row) = scoped_rows.next()? {
					check()?;
					if ids.len() == count {
						return Err(unavailable("scope exceeds published vector count"));
					}
					if ids.len() == ids.capacity() {
						let additional = ids.capacity().max(64).min(count - ids.len());
						memory.grow(additional.saturating_mul(8))?;
						ids.try_reserve_exact(additional).map_err(unavailable)?;
					}
					ids.push(row.get(0)?);
				}
				ids.sort_unstable();
				scope_memory = Some(memory);
				Some(ids)
			} else {
				None
			};
			let specs: Vec<ShardSpec> = specs
				.into_iter()
				.filter(|spec| {
					selected.as_ref().is_none_or(|ids| {
						let start = ids.partition_point(|id| *id < spec.first_id);
						ids.get(start).is_some_and(|id| *id <= spec.last_id)
					})
				})
				.collect();
			let mut memory = cache.reserve_load(&specs, guard, dimensions)?;
			let mut shards = Vec::with_capacity(specs.len());
			for spec in specs {
				check()?;
				shards.push(cache.load(connection, guard, dimensions, &spec, &mut memory)?);
			}
			Ok(Generation { dimensions, shards, selected, _scope_memory: scope_memory })
		})();
		match loaded {
			Ok(generation) if !generation.shards.is_empty() => generations.push(generation),
			Ok(_) => {},
			Err(error) => {
				cache
					.0
					.borrow_mut()
					.retain(|entry| entry.spec.index_id != id);
				check()?;
				failure.get_or_insert_with(|| format!("Index {id}: {}", error.error_message()));
			},
		}
	}
	check()?;
	Ok((generations, failure))
}

fn exact_score(query: &[f64], vector: &[f32]) -> f64 {
	let mut dot = 0.0f64;
	let mut norm = 0.0f64;
	for (&query, &value) in query.iter().zip(vector) {
		let value = f64::from(value);
		dot = query.mul_add(value, dot);
		norm = value.mul_add(value, norm);
	}
	dot / norm.sqrt()
}

pub(crate) fn search(
	generations: &[Generation],
	dimensions: usize,
	query: &[f64],
	limit: usize,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<Vec<i64>> {
	check()?;
	let norm = query.iter().map(|value| value * value).sum::<f64>().sqrt();
	if query.len() != dimensions
		|| !norm.is_finite()
		|| norm == 0.0
		|| query.iter().any(|value| !value.is_finite())
	{
		return Err(unavailable("invalid query vector"));
	}
	if limit == 0 {
		return Ok(Vec::new());
	}
	let pool = parallel::pool();
	let workers = pool.map_or(1, rayon::ThreadPool::current_num_threads);
	let eligible = generations
		.iter()
		.filter(|generation| generation.dimensions == dimensions)
		.map(|generation| {
			generation.selected.as_ref().map_or_else(
				|| {
					generation
						.shards
						.iter()
						.map(|shard| shard.spec.count)
						.sum::<usize>()
				},
				Vec::len,
			)
		})
		.sum::<usize>();
	if eligible == 0 {
		return Ok(Vec::new());
	}
	let bounded_exact = eligible <= EXACT_SCOPE_ROWS;
	let window = if bounded_exact {
		eligible
	} else {
		limit.saturating_mul(2).min(eligible)
	};
	let workspace = dimensions
		.saturating_mul(12 + workers * 4)
		.saturating_add(window.saturating_mul(64).saturating_mul(workers + 1));
	let _memory = MemoryLease::acquire(workspace)?;
	let query: Vec<f64> = query.iter().map(|value| value / norm).collect();
	let approximate_query: Vec<f32> = query.iter().map(|value| *value as f32).collect();
	let mut best: Vec<(i64, f64, &Index)> = Vec::new();
	let rank = |left: &(i64, f64, &Index), right: &(i64, f64, &Index)| {
		right
			.1
			.total_cmp(&left.1)
			.then_with(|| left.0.cmp(&right.0))
	};
	let mut shards = generations
		.iter()
		.filter(|generation| generation.dimensions == dimensions)
		.flat_map(|generation| {
			generation
				.shards
				.iter()
				.map(move |shard| (generation, shard))
		});
	let mut batch = Vec::with_capacity(workers);
	loop {
		batch.clear();
		batch.extend(shards.by_ref().take(workers));
		if batch.is_empty() {
			break;
		}
		check()?;
		let score_shard =
			|&(generation, shard): &(&Generation, &Arc<LoadedShard>)| -> CoreResult<Vec<(i64, f64)>> {
				let selected = generation.selected.as_ref().map(|ids| {
					let start = ids.partition_point(|id| *id < shard.spec.first_id);
					let end = ids.partition_point(|id| *id <= shard.spec.last_id);
					&ids[start..end]
				});
				let count = selected.map_or(shard.spec.count, <[i64]>::len);
				if bounded_exact {
					return Ok(if let Some(ids) = selected {
						ids.iter().map(|id| (*id, 0.0)).collect()
					} else {
						shard
							.index
							.exact_search(&approximate_query, count)
							.map_err(unavailable)?
							.keys
							.into_iter()
							.map(|key| (key as i64, 0.0))
							.collect()
					});
				}
				let candidates = window.min(count);
				let matches = match selected {
					Some(ids) if ids.len() != shard.spec.count => {
						let contiguous = ids.last().and_then(|last| last.checked_sub(ids[0]))
							== Some(ids.len() as i64 - 1);
						shard
							.index
							.filtered_search(&approximate_query, candidates, |key| {
								let key = key as i64;
								if contiguous {
									key >= ids[0] && key <= ids[ids.len() - 1]
								} else {
									ids.binary_search(&key).is_ok()
								}
							})
							.map_err(unavailable)?
					},
					_ => shard
						.index
						.search(&approximate_query, candidates)
						.map_err(unavailable)?,
				};
				Ok(matches
					.keys
					.into_iter()
					.zip(matches.distances)
					.map(|(key, distance)| (key as i64, 1.0 - f64::from(distance)))
					.collect())
			};
		let results = if let Some(pool) = pool.filter(|_| batch.len() > 1) {
			pool.install(|| {
				batch
					.par_iter()
					.map(score_shard)
					.collect::<CoreResult<Vec<_>>>()
			})?
		} else {
			batch
				.iter()
				.map(score_shard)
				.collect::<CoreResult<Vec<_>>>()?
		};
		check()?;
		for ((_, shard), scores) in batch.iter().copied().zip(results) {
			best.extend(
				scores
					.into_iter()
					.map(|(key, score)| (key, score, &shard.index)),
			);
		}
		if !bounded_exact && best.len() > window {
			best.select_nth_unstable_by(window, rank);
			best.truncate(window);
		}
	}
	// Rerank the global candidate budget, not that budget again for every shard.
	// The small-scope route retains every eligible original f32 vector.
	let rerank = |chunk: &mut [(i64, f64, &Index)]| -> CoreResult<()> {
		let mut vector = vec![0.0f32; dimensions];
		for (key, score, index) in chunk {
			if index.get(*key as u64, &mut vector).map_err(unavailable)? != 1 {
				return Err(unavailable("missing indexed vector"));
			}
			*score = exact_score(&query, &vector);
		}
		Ok(())
	};
	if let Some(pool) = pool.filter(|_| dimensions.saturating_mul(best.len()) >= 64 * 1024) {
		let chunk = best.len().div_ceil(workers).max(1);
		pool.install(|| best.par_chunks_mut(chunk).try_for_each(rerank))?;
	} else {
		rerank(&mut best)?;
	}
	best.sort_unstable_by(rank);
	best.truncate(limit);
	check()?;
	Ok(best.into_iter().map(|(id, ..)| id).collect())
}

#[cfg(test)]
mod tests {
	use super::*;

	// Frozen deterministic vectors exercise ANN (>256 eligible rows), not the
	// small-scope fallback.
	#[test]
	fn persisted_ann_meets_recall_in_each_scope_after_reopen_and_rejects_wrong_identity() {
		const DIMS: usize = 8;
		const ROWS_PER_INDEX: usize = 2048;
		const K: usize = 64;
		let directory = std::env::temp_dir().join(format!(
			"knowledge-ann-quality-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		std::fs::create_dir_all(&directory).unwrap();
		struct Cleanup(std::path::PathBuf);
		impl Drop for Cleanup {
			fn drop(&mut self) {
				let _ = std::fs::remove_dir_all(&self.0);
			}
		}
		let _cleanup = Cleanup(directory.clone());
		let path = directory.join("knowledge.db");
		let connection = Connection::open(&path).unwrap();
		connection
			.execute_batch(
				"CREATE TABLE doc_indexes(id INTEGER PRIMARY KEY,name TEXT);
			CREATE TABLE documents(id INTEGER PRIMARY KEY,index_id INTEGER,relative_path TEXT);
			CREATE TABLE sections(id INTEGER PRIMARY KEY,index_id INTEGER,document_id INTEGER);
			CREATE TABLE wiki_vector_generations(index_id INTEGER,token TEXT,model TEXT,dimensions \
				 INTEGER,complete INTEGER);
			CREATE TABLE wiki_section_vectors(index_id INTEGER,section_id INTEGER,vector BLOB);
			INSERT INTO doc_indexes VALUES(1,'one'),(2,'two');
			INSERT INTO documents VALUES(1,1,'scope/evidence.md'),(2,1,'scope-other/decoy.md'),
				(3,2,'scope/evidence.md'),(4,2,'scope-other/decoy.md');",
			)
			.unwrap();
		connection.execute_batch(SCHEMA).unwrap();
		let mut originals = Vec::new();
		let mut state = 0x1234_5678_u64;
		connection.execute_batch("BEGIN").unwrap();
		for index in 1..=2i64 {
			for ordinal in 0..ROWS_PER_INDEX {
				let id = (index - 1) * ROWS_PER_INDEX as i64 + ordinal as i64 + 1;
				let document = (index - 1) * 2 + if ordinal % 8 == 0 { 1 } else { 2 };
				let mut values = [0.0f32; DIMS];
				for value in &mut values {
					state ^= state << 13;
					state ^= state >> 7;
					state ^= state << 17;
					*value = (state as u32 as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32;
				}
				let norm = values
					.iter()
					.map(|value| f64::from(*value).powi(2))
					.sum::<f64>()
					.sqrt();
				for value in &mut values {
					*value = (f64::from(*value) / norm) as f32;
				}
				let bytes: Vec<u8> = values
					.iter()
					.flat_map(|value| value.to_le_bytes())
					.collect();
				connection
					.execute("INSERT INTO sections VALUES(?,?,?)", params![id, index, document])
					.unwrap();
				connection
					.execute("INSERT INTO wiki_section_vectors VALUES(?,?,?)", params![index, id, bytes])
					.unwrap();
				originals.push((id, index, ordinal % 8 == 0, values));
			}
			let token = format!("generation-{index}");
			connection
				.execute("INSERT INTO wiki_vector_generations VALUES(?,?,'model',?,1)", params![
					index,
					token,
					DIMS as i64
				])
				.unwrap();
			build(&connection, "database-identity", index, &token, DIMS, ROWS_PER_INDEX, &|| Ok(()))
				.unwrap();
		}
		connection.execute_batch("COMMIT").unwrap();
		drop(connection);
		let connection = Connection::open(&path).unwrap();
		let cache = IndexCache::default();
		for (group, index, path) in [
			("unfiltered", None, None),
			("index", Some("one"), None),
			("directory", None, Some("scope/")),
			("file", None, Some("scope/evidence.md")),
			("index-and-file", Some("one"), Some("scope/evidence.md")),
		] {
			let (generations, failure) = prepare(
				&connection,
				"database-identity",
				"guard",
				&cache,
				"model",
				index,
				PathScope::validate(path).unwrap(),
				&|| Ok(()),
			)
			.unwrap();
			assert!(failure.is_none(), "{group}: {failure:?}");
			let eligible: Vec<_> = originals
				.iter()
				.filter(|(_, owner, scoped, _)| {
					(index.is_none() || *owner == 1) && (path.is_none() || *scoped)
				})
				.collect();
			// The file+index group has 256 rows and explicitly covers the exact
			// boundary too.
			let mut sum = 0.0;
			for query_index in [0, 17, 319, 1023] {
				let query: Vec<f64> = originals[query_index]
					.3
					.iter()
					.map(|value| f64::from(*value))
					.collect();
				let qnorm = query.iter().map(|value| value * value).sum::<f64>().sqrt();
				let mut exact: Vec<_> = eligible
					.iter()
					.map(|(id, _, _, values)| {
						let vnorm = values
							.iter()
							.map(|value| f64::from(*value).powi(2))
							.sum::<f64>()
							.sqrt();
						let dot = query
							.iter()
							.zip(values)
							.map(|(q, v)| q * f64::from(*v))
							.sum::<f64>();
						(*id, dot / (qnorm * vnorm))
					})
					.collect();
				exact.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
				let actual = search(&generations, DIMS, &query, K, &|| Ok(())).unwrap();
				assert_eq!(actual.len(), K.min(eligible.len()), "{group}");
				assert_eq!(
					actual
						.iter()
						.collect::<std::collections::HashSet<_>>()
						.len(),
					actual.len()
				);
				let threshold = exact[K.min(exact.len()) - 1].1;
				// Predeclared tie rule: an equally distant boundary neighbor
				// receives full credit.
				let credit = actual
					.iter()
					.filter(|id| {
						exact
							.iter()
							.any(|(expected, score)| expected == *id && *score >= threshold - 1e-12)
					})
					.count();
				let recall = credit as f64 / K.min(eligible.len()) as f64;
				sum += recall;
				eprintln!("knowledge ANN group={group} query={query_index} recall_at_{K}={recall}");
			}
			assert!(sum / 4.0 >= 0.99, "{group}: mean Recall@{K}={}", sum / 4.0);
		}
		let (wrong, failure) =
			prepare(&connection, "different-database", "guard", &cache, "model", None, None, &|| {
				Ok(())
			})
			.unwrap();
		assert!(wrong.is_empty());
		assert!(failure.is_some());
		let (empty, failure) = prepare(
			&connection,
			"database-identity",
			"guard",
			&cache,
			"model",
			None,
			PathScope::validate(Some("absent/")).unwrap(),
			&|| Ok(()),
		)
		.unwrap();
		assert!(empty.is_empty());
		assert!(failure.is_none());
		cache.clear();
	}
}
