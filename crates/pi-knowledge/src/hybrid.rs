//! Internal snapshot-bound ranking exchange with the host model clients.
use std::{
	cell::RefCell,
	collections::{HashSet, VecDeque},
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
	},
};

use rusqlite::{Connection, params};

use super::{
	Check, CoreResult, DatabaseEngine, DocumentContexts, HYDRATE, HybridCandidate, HybridCompleted,
	HybridContext, HybridPreparation, HybridPrepared, HybridRank, KnowledgeCursorBase,
	KnowledgeError, KnowledgeSearchHit, KnowledgeSearchOptions, KnowledgeSearchOutput,
	KnowledgeSearchWindow, LiteralMatcher, MatchKind, PathScope, RankedSection, Ranking, digest,
	load_contexts, query, retrieval_status, search_key,
};

const SNAPSHOT_STALE: &str = "KNOWLEDGE_SNAPSHOT_STALE";

// Retained cache data share one process-wide budget. Active contexts can
// additionally retain their validation data until their operation completes.
const MAX_HYBRID_DATA_BUDGET: usize = 1024 * 1024 * 1024;
static HYBRID_DATA_BYTES: AtomicUsize = AtomicUsize::new(0);
static HYBRID_DATA_BUDGET: AtomicUsize = AtomicUsize::new(0);

struct CachedHit {
	guard: String,
	hit:   KnowledgeSearchHit,
	bytes: usize,
}

struct CachedCandidate {
	guard: String,
	query: String,
	entry: RankedSection,
	bytes: usize,
}

struct HybridData {
	hits:       VecDeque<CachedHit>,
	candidates: VecDeque<CachedCandidate>,
	bytes:      usize,
}

pub(super) struct HybridDataCache(RefCell<HybridData>, usize);

impl HybridDataCache {
	pub(super) fn new() -> Self {
		let cache = Self(
			RefCell::new(HybridData {
				hits:       VecDeque::new(),
				candidates: VecDeque::new(),
				bytes:      0,
			}),
			MAX_HYBRID_DATA_BUDGET,
		);
		cache.refresh_budget();
		cache
	}

	pub(super) fn refresh_budget(&self) {
		HYBRID_DATA_BUDGET.store(crate::parallel::memory_budget(32, usize::MAX), Ordering::Relaxed);
		// Trim even on cache hits; sampling is per operation, not per row.
		self.reserve(&mut self.0.borrow_mut(), 0);
	}

	pub(super) fn clear(&self) {
		let mut data = self.0.borrow_mut();
		data.hits.clear();
		data.candidates.clear();
		HYBRID_DATA_BYTES.fetch_sub(data.bytes, Ordering::Relaxed);
		data.bytes = 0;
	}

	fn reserve(&self, data: &mut HybridData, bytes: usize) -> bool {
		let shared_budget = HYBRID_DATA_BUDGET.load(Ordering::Relaxed);
		let budget = self.1.min(shared_budget);
		if bytes > budget {
			return false;
		}
		loop {
			if data.bytes <= budget - bytes
				&& HYBRID_DATA_BYTES
					.try_update(Ordering::Relaxed, Ordering::Relaxed, |total| {
						total
							.checked_add(bytes)
							.filter(|&next| next <= shared_budget)
					})
					.is_ok()
			{
				return true;
			}
			let before = data.bytes;
			if let Some(old) = data.hits.pop_front() {
				data.bytes -= old.bytes;
			} else if let Some(old) = data.candidates.pop_front() {
				data.bytes -= old.bytes;
			} else {
				return false;
			}
			HYBRID_DATA_BYTES.fetch_sub(before - data.bytes, Ordering::Relaxed);
		}
	}

	fn candidate(&self, guard: &str, query: &str, id: i64) -> Option<RankedSection> {
		let mut data = self.0.borrow_mut();
		let position = data.candidates.iter().position(|item| {
			item.guard == guard && item.query == query && item.entry.section_id == id
		})?;
		let item = data
			.candidates
			.remove(position)
			.expect("candidate cache entry");
		let result = item.entry.clone();
		data.candidates.push_back(item);
		Some(result)
	}

	fn insert_candidate(&self, guard: &str, query: &str, entry: &RankedSection) {
		let bytes = guard.len().saturating_add(query.len()).saturating_add(256);
		let mut data = self.0.borrow_mut();
		if data.candidates.iter().any(|item| {
			item.guard == guard && item.query == query && item.entry.section_id == entry.section_id
		}) || !self.reserve(&mut data, bytes)
		{
			return;
		}
		data.bytes += bytes;
		data.candidates.push_back(CachedCandidate {
			guard: guard.to_owned(),
			query: query.to_owned(),
			entry: entry.clone(),
			bytes,
		});
	}

	fn hit(&self, guard: &str, entry: &RankedSection) -> Option<KnowledgeSearchHit> {
		let mut data = self.0.borrow_mut();
		let position = data
			.hits
			.iter()
			.position(|hit| hit.guard == guard && hit.hit.section_id == entry.section_id)?;
		let cached = data.hits.remove(position).expect("hit cache entry");
		let hit = copy_hit(&cached.hit, entry);
		data.hits.push_back(cached);
		Some(hit)
	}

	fn insert_hit(&self, guard: &str, hit: &KnowledgeSearchHit) {
		let bytes = hit
			.index
			.len()
			.saturating_add(hit.document_hash.len())
			.saturating_add(hit.path.len())
			.saturating_add(hit.heading_path.len())
			.saturating_add(hit.text.len())
			.saturating_add(guard.len())
			.saturating_add(256);
		let mut data = self.0.borrow_mut();
		if data
			.hits
			.iter()
			.any(|cached| cached.guard == guard && cached.hit.section_id == hit.section_id)
			|| !self.reserve(&mut data, bytes)
		{
			return;
		}
		let entry = RankedSection {
			section_id: hit.section_id,
			shape:      hit.shape,
			match_kind: hit.match_kind,
			rank:       hit.rank,
		};
		data.bytes += bytes;
		data
			.hits
			.push_back(CachedHit { guard: guard.to_owned(), hit: copy_hit(hit, &entry), bytes });
	}
}

impl Drop for HybridDataCache {
	fn drop(&mut self) {
		self.clear();
	}
}

fn copy_hit(hit: &KnowledgeSearchHit, entry: &RankedSection) -> KnowledgeSearchHit {
	KnowledgeSearchHit {
		section_id:    hit.section_id,
		index:         hit.index.clone(),
		document_hash: hit.document_hash.clone(),
		path:          hit.path.clone(),
		heading_path:  hit.heading_path.clone(),
		line_start:    hit.line_start,
		line_end:      hit.line_end,
		text:          hit.text.clone(),
		shape:         entry.shape,
		match_kind:    entry.match_kind,
		rank:          entry.rank,
	}
}

fn stale() -> KnowledgeError {
	let mut error =
		KnowledgeError::message("Stale documentation search cursor: indexed snapshot has changed");
	error.code = Some(SNAPSHOT_STALE.to_owned());
	error
}

fn is_stale(error: &KnowledgeError) -> bool {
	error.code.as_deref() == Some(SNAPSHOT_STALE)
}

impl DatabaseEngine {
	fn hybrid_context(&self, token: &str) -> CoreResult<Arc<HybridContext>> {
		let context = self
			.hybrid
			.iter()
			.find(|context| context.token == token)
			.cloned()
			.ok_or_else(stale)?;
		if self.guard()? != context.guard {
			return Err(stale());
		}
		Ok(context)
	}

	fn hybrid_snapshot<T>(
		&self,
		guard: &str,
		work: impl FnOnce(&Connection) -> CoreResult<T>,
	) -> CoreResult<T> {
		if self.guard()? != guard {
			return Err(stale());
		}
		let connection = self.connection.as_ref().expect("opened search connection");
		connection.execute_batch("BEGIN DEFERRED")?;
		let result = work(connection);
		let finish = connection.execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" });
		finish?;
		let value = result?;
		if self.guard()? != guard {
			return Err(stale());
		}
		Ok(value)
	}

	fn hybrid_snapshot_checked<T, F>(
		&self,
		guard: &str,
		check: F,
		work: impl FnOnce(&Connection) -> CoreResult<T>,
	) -> CoreResult<T>
	where
		F: Fn() -> CoreResult<()> + Clone + Send + 'static,
	{
		check()?;
		if self.guard()? != guard {
			return Err(stale());
		}
		let connection = self.connection.as_ref().expect("opened search connection");
		let progress = check.clone();
		connection.progress_handler(1000, Some(move || progress().is_err()))?;
		let result = (|| {
			connection.execute_batch("BEGIN DEFERRED")?;
			work(connection)
		})();
		// Remove the interrupt callback before COMMIT or ROLLBACK, even when
		// SQLite aborted the statement or BEGIN itself failed.
		let clear = connection.progress_handler(0, None::<fn() -> bool>);
		let finish = if connection.is_autocommit() {
			Ok(())
		} else {
			connection.execute_batch(if result.is_ok() && clear.is_ok() {
				"COMMIT"
			} else {
				"ROLLBACK"
			})
		};
		clear?;
		finish?;
		if result.is_err() {
			check()?;
		}
		let value = result?;
		check()?;
		if self.guard()? != guard {
			return Err(stale());
		}
		Ok(value)
	}

	fn hybrid_key(&self, text: &str, options: &KnowledgeSearchOptions) -> CoreResult<String> {
		if options.cursor.is_some() || options.mode.as_deref().unwrap_or("search") != "search" {
			return Err(KnowledgeError::message("Invalid documentation hybrid search options"));
		}
		PathScope::validate(options.path.as_deref())?;
		Ok(search_key(text, options, &self.cursor_path, false))
	}

	/// Inspect whether a reusable nonempty ranking exists, without resolving
	/// models.
	pub fn has_cached_hybrid_candidates(
		&mut self,
		text: &str,
		options: &KnowledgeSearchOptions,
	) -> CoreResult<bool> {
		self.ensure_database()?;
		let key = self.hybrid_key(text, options)?;
		let guard = self.guard()?;
		if self.cache_guard.as_ref() != Some(&guard) {
			self.clear_cache();
			return Ok(false);
		}
		Ok(self
			.hybrid_completed
			.iter()
			.filter(|item| item.key == key)
			.any(|item| {
				self
					.cache
					.iter()
					.any(|(stored, ranking)| stored == &item.cache_key && !ranking.ranked.is_empty())
			}))
	}

	/// Reuse a complete ranking for the same query, snapshot and model
	/// configuration.
	pub fn lookup_hybrid(
		&mut self,
		text: &str,
		options: &KnowledgeSearchOptions,
		configuration: &str,
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<Option<KnowledgeSearchOutput>> {
		self.ensure_database()?;
		let key = self.hybrid_key(text, options)?;
		let guard = self.guard()?;
		if self.cache_guard.as_ref() != Some(&guard) {
			self.clear_cache();
			return Ok(None);
		}
		let Some(position) = self
			.hybrid_completed
			.iter()
			.rposition(|item| item.key == key && item.configuration == configuration)
		else {
			return Ok(None);
		};
		let cache_key = self.hybrid_completed[position].cache_key.clone();
		let Some(cache_position) = self
			.cache
			.iter()
			.position(|(stored, _)| stored == &cache_key)
		else {
			return Ok(None);
		};
		let ranking = Arc::clone(&self.cache[cache_position].1);
		let limit = options.limit.unwrap_or(10.0).floor();
		if limit.is_nan() {
			return Err(KnowledgeError::message("Invalid documentation search page size"));
		}
		let limit = limit.clamp(1.0, 500.0) as usize;
		let sections = match self.hybrid_snapshot(&guard, |connection| {
			let mut sections = Vec::with_capacity(limit.min(ranking.ranked.len()));
			for entry in ranking.ranked.iter().take(limit) {
				check()?;
				sections.push(self.hydrate_cached(connection, &guard, entry)?);
			}
			Ok(sections)
		}) {
			Ok(sections) => sections,
			Err(error) => {
				check()?;
				if is_stale(&error) {
					self.clear_cache();
					return Ok(None);
				}
				return Err(error);
			},
		};
		let entry = self.cache.remove(cache_position).expect("cache hit");
		self.cache.push_back(entry);
		let completed = self
			.hybrid_completed
			.remove(position)
			.expect("completed hit");
		self.hybrid_completed.push_back(completed);
		let plan = query::analyze_query(text);
		Ok(Some(KnowledgeSearchOutput {
			result:     KnowledgeSearchWindow {
				sections,
				total: ranking.ranked.len() as i64,
				exact_name_matches: ranking.exact_name_matches as i64,
				technical_name: plan.technical_name,
				retrieval: ranking.retrieval.to_owned(),
				reranked: ranking.reranked,
				cursor_base: KnowledgeCursorBase { v: 1, q: key, s: ranking.version.clone(), p: 0 },
			},
			cache_hit:  true,
			term_count: plan.terms.len() as i64,
		}))
	}

	/// Prepare a stable hybrid snapshot, or return a plain search after bounded
	/// retries.
	pub fn prepare_hybrid<F>(
		&mut self,
		text: &str,
		options: &KnowledgeSearchOptions,
		model: Option<&str>,
		check: F,
	) -> CoreResult<HybridPreparation>
	where
		F: Fn() -> CoreResult<()> + Clone + Send + 'static,
	{
		if options.cursor.is_some() || options.mode.as_deref().unwrap_or("search") != "search" {
			return Err(KnowledgeError::message("Invalid documentation hybrid search options"));
		}
		for _ in 0..2 {
			match self.prepare_hybrid_once(text, options, model, check.clone()) {
				Ok(prepared) => return Ok(HybridPreparation::Ready(prepared)),
				Err(error) if is_stale(&error) => check()?,
				Err(error) => return Err(error),
			}
		}
		check()?;
		self
			.search(text, options, check)
			.map(HybridPreparation::Fulltext)
	}

	fn prepare_hybrid_once<F>(
		&mut self,
		text: &str,
		options: &KnowledgeSearchOptions,
		model: Option<&str>,
		check: F,
	) -> CoreResult<HybridPrepared>
	where
		F: Fn() -> CoreResult<()> + Clone + Send + 'static,
	{
		// Only the latest operation pins native indexes across model I/O.
		for context in &self.hybrid {
			context
				.vector_indexes
				.lock()
				.expect("vector indexes")
				.clear();
		}
		let output = self.search(text, options, check.clone())?;
		let key = output.result.cursor_base.q;
		let guard = self.guard()?;
		let baseline = self
			.cache
			.iter()
			.find(|(stored, _)| stored == &key)
			.map(|(_, ranking)| Arc::clone(ranking))
			.ok_or_else(stale)?;
		if baseline.version != output.result.cursor_base.s
			|| self.cache_guard.as_ref() != Some(&guard)
		{
			return Err(stale());
		}
		for hit in &output.result.sections {
			self.hybrid_data.insert_hit(&guard, hit);
		}
		let (indexes, vector_failure_reason) =
			self.hybrid_snapshot_checked(&guard, check.clone(), |connection| match model {
				Some(model) => crate::vector_index::prepare(
					connection,
					&self.identity,
					&guard,
					&self.vector_indexes,
					model,
					options.index.as_deref(),
					options.path.as_deref().map(PathScope),
					&check,
				),
				None => Ok((Vec::new(), None)),
			})?;
		let mut dimensions: Vec<usize> = indexes.iter().map(|index| index.dimensions).collect();
		dimensions.sort_unstable();
		dimensions.dedup();
		// Stable storage identities provide deterministic ties without scanning
		// every section merely to assign transient source-order positions.
		let fulltext = baseline
			.ranked
			.iter()
			.map(|entry| HybridRank {
				section_id:   entry.section_id,
				match_kind:   entry.match_kind,
				rank:         entry.rank,
				source_order: entry.section_id,
			})
			.collect();
		let baseline_positions = baseline
			.ranked
			.iter()
			.enumerate()
			.map(|(position, entry)| (entry.section_id, position))
			.collect();
		let allowed = baseline
			.ranked
			.iter()
			.map(|entry| entry.section_id)
			.collect();
		self.hybrid_sequence = self.hybrid_sequence.wrapping_add(1);
		let token = digest(
			format!("{}:{}:{}:{}", key, guard, baseline.version, self.hybrid_sequence).as_bytes(),
		);
		self.hybrid.push_back(Arc::new(HybridContext {
			token: token.clone(),
			key,
			guard,
			query: text.to_owned(),
			index: options.index.clone(),
			path: options.path.clone(),
			model: model.map(str::to_owned),
			vector_dimensions: dimensions.clone(),
			vector_indexes: Mutex::new(indexes),
			limit: options.limit,
			baseline,
			baseline_positions,
			allowed: Mutex::new(allowed),
		}));
		while self.hybrid.len() > 8 {
			self.hybrid.pop_front();
		}
		Ok(HybridPrepared {
			token,
			effective_query: text.to_owned(),
			fulltext,
			vector_dimensions: dimensions,
			vector_failure: vector_failure_reason.is_some(),
			vector_failure_reason,
		})
	}

	/// Score a compatible generation inside the prepared snapshot, after model
	/// I/O. Finite nonzero queries are required.
	pub fn score_hybrid<F>(
		&self,
		token: &str,
		dimensions: usize,
		check: F,
		query: &[f64],
		limit: usize,
	) -> CoreResult<Option<Vec<i64>>>
	where
		F: Fn() -> CoreResult<()> + Clone + Send + 'static,
	{
		let context = self.hybrid_context(token)?;
		if !context.vector_dimensions.contains(&dimensions) {
			return Ok(None);
		}
		let model = context.model.as_deref().ok_or_else(stale)?;
		let result = self.hybrid_snapshot_checked(&context.guard, check.clone(), |connection| {
			check()?;
			let mut indexes = context.vector_indexes.lock().expect("vector indexes");
			if indexes.is_empty() {
				let (loaded, failed) = crate::vector_index::prepare(
					connection,
					&self.identity,
					&context.guard,
					&self.vector_indexes,
					model,
					context.index.as_deref(),
					context.path.as_deref().map(PathScope),
					&check,
				)?;
				if let Some(reason) = failed
					&& !loaded.iter().any(|index| index.dimensions == dimensions)
				{
					return Err(KnowledgeError::message(reason));
				}
				*indexes = loaded;
			}
			let ids = crate::vector_index::search(&indexes, dimensions, query, limit, &check)?;
			check()?;
			context
				.allowed
				.lock()
				.expect("hybrid candidates")
				.extend(ids.iter().copied());
			Ok(Some(ids))
		});
		context
			.vector_indexes
			.lock()
			.expect("vector indexes")
			.clear();
		if result.is_err() {
			self.vector_indexes.clear();
		}
		result
	}

	/// Hydrate only explicitly selected candidates from the prepared snapshot.
	pub fn read_hybrid_candidates(
		&self,
		token: &str,
		ids: &[i64],
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<Vec<HybridCandidate>> {
		let context = self.hybrid_context(token)?;
		let allowed = context.allowed.lock().expect("hybrid candidates");
		self.hybrid_snapshot(&context.guard, |connection| {
			let mut unique = HashSet::new();
			let mut hits = Vec::with_capacity(ids.len());
			let mut resolver = CandidateResolver::new(&context.query, &self.hybrid_data);
			for &id in ids {
				check()?;
				if !allowed.contains(&id) || !unique.insert(id) {
					return Err(stale());
				}
				let entry = resolver.candidate(connection, &context, id, check)?;
				let hit = self.hydrate_cached(connection, &context.guard, &entry)?;
				hits.push(HybridCandidate { hit, source_order: id });
			}
			Ok(hits)
		})
	}

	/// Commit a complete final ordering. Empty identity preserves the legacy
	/// fulltext cursor.
	pub fn finish_hybrid(
		&mut self,
		token: &str,
		ids: &[i64],
		identity: &str,
		configuration: &str,
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<KnowledgeSearchOutput> {
		let context = self.hybrid_context(token)?;
		context
			.vector_indexes
			.lock()
			.expect("vector indexes")
			.clear();
		let allowed = context.allowed.lock().expect("hybrid candidates");
		let baseline_ids: HashSet<i64> = context
			.baseline
			.ranked
			.iter()
			.map(|entry| entry.section_id)
			.collect();
		let mut unique = HashSet::new();
		if ids
			.iter()
			.any(|id| !allowed.contains(id) || !unique.insert(*id))
			|| !baseline_ids.is_subset(&unique)
		{
			return Err(stale());
		}
		if identity.is_empty()
			&& !ids
				.iter()
				.copied()
				.eq(context.baseline.ranked.iter().map(|entry| entry.section_id))
		{
			return Err(stale());
		}
		let (ranking, sections) = self.hybrid_snapshot(&context.guard, |connection| {
			let mut ranked = Vec::with_capacity(ids.len());
			let mut saw_related = false;
			let mut resolver = CandidateResolver::new(&context.query, &self.hybrid_data);
			for &id in ids {
				check()?;
				let entry = resolver.candidate(connection, &context, id, check)?;
				if entry.match_kind == MatchKind::ExactName {
					if saw_related {
						return Err(KnowledgeError::message(
							"Invalid documentation ranking: exact names must precede related results",
						));
					}
				} else {
					saw_related = true;
				}
				ranked.push(entry);
			}
			let version = if identity.is_empty() {
				context.baseline.version.clone()
			} else {
				digest(
					serde_json::to_string(&(&context.token, identity, ids))
						.expect("ranking serialization")
						.as_bytes(),
				)
			};
			let exact_name_matches = ranked
				.iter()
				.filter(|entry| entry.match_kind == MatchKind::ExactName)
				.count();
			let limit = context.limit.unwrap_or(10.0).floor().clamp(1.0, 500.0) as usize;
			let mut sections = Vec::with_capacity(limit.min(ranked.len()));
			for entry in ranked.iter().take(limit) {
				check()?;
				sections.push(self.hydrate_cached(connection, &context.guard, entry)?);
			}
			let (retrieval, reranked) = retrieval_status(identity);
			Ok((
				Arc::new(Ranking { ranked, version, exact_name_matches, retrieval, reranked }),
				sections,
			))
		})?;
		let plan = query::analyze_query(&context.query);
		let cursor_base =
			KnowledgeCursorBase { v: 1, q: context.key.clone(), s: ranking.version.clone(), p: 0 };
		let result = KnowledgeSearchWindow {
			sections,
			total: ranking.ranked.len() as i64,
			exact_name_matches: ranking.exact_name_matches as i64,
			technical_name: plan.technical_name,
			retrieval: ranking.retrieval.to_owned(),
			reranked: ranking.reranked,
			cursor_base,
		};
		let cache_key = if identity.is_empty() {
			context.key.clone()
		} else {
			format!("{}:{}", context.key, ranking.version)
		};
		self.publish(cache_key.clone(), ranking, context.guard.clone());
		if !configuration.is_empty() {
			self
				.hybrid_completed
				.retain(|item| item.key != context.key || item.configuration != configuration);
			self.hybrid_completed.push_back(HybridCompleted {
				key: context.key.clone(),
				configuration: configuration.to_owned(),
				cache_key,
			});
			while self.hybrid_completed.len() > 8 {
				self.hybrid_completed.pop_front();
			}
		}
		Ok(KnowledgeSearchOutput { result, cache_hit: false, term_count: plan.terms.len() as i64 })
	}
}

impl DatabaseEngine {
	fn hydrate_cached(
		&self,
		connection: &Connection,
		guard: &str,
		entry: &RankedSection,
	) -> CoreResult<KnowledgeSearchHit> {
		if let Some(hit) = self.hybrid_data.hit(guard, entry) {
			return Ok(hit);
		}
		let hit = hydrate(connection, entry)?;
		self.hybrid_data.insert_hit(guard, &hit);
		Ok(hit)
	}
}

struct CandidateResolver<'a> {
	name:     Option<LiteralMatcher>,
	document: Option<(i64, DocumentContexts)>,
	cache:    &'a HybridDataCache,
}

impl<'a> CandidateResolver<'a> {
	fn new(text: &str, cache: &'a HybridDataCache) -> Self {
		let plan = query::analyze_query(text);
		let name = plan.technical_name.as_deref().map(|name| {
			LiteralMatcher::new(
				&query::normalize_search_text(name),
				!name.contains(['/', '\\']) && !name.contains("::"),
			)
		});
		Self { name, document: None, cache }
	}

	fn candidate(
		&mut self,
		connection: &Connection,
		context: &HybridContext,
		id: i64,
		check: Check<'_>,
	) -> CoreResult<RankedSection> {
		if let Some(&position) = context.baseline_positions.get(&id) {
			return Ok(context.baseline.ranked[position].clone());
		}
		if let Some(entry) = self.cache.candidate(&context.guard, &context.query, id) {
			return Ok(entry);
		}
		let (document_id, text): (i64, String) = connection.query_row(
			"SELECT s.document_id,s.raw_markdown FROM sections s JOIN doc_indexes i ON \
			 i.id=s.index_id WHERE s.id=? AND i.name NOT GLOB '__building__*' AND (? IS NULL OR \
			 i.name=?)",
			params![id, context.index, context.index],
			|row| Ok((row.get(0)?, row.get(1)?)),
		)?;
		if self
			.document
			.as_ref()
			.is_none_or(|(id, _)| *id != document_id)
		{
			self.document =
				Some((document_id, load_contexts(connection, document_id, self.name.as_ref(), check)?));
		}
		let contexts = &self.document.as_ref().expect("loaded document contexts").1;
		let projection = contexts.projections.get(&id);
		let section = contexts.sections.get(&id);
		let exact = if let Some(exact) = contexts.exact_names.get(&id) {
			*exact
		} else if let Some(name) = self.name.as_ref() {
			name.matches_name_section(
				&query::normalize_search_text(&text),
				&text,
				section.ok_or_else(stale)?,
			)
		} else {
			false
		};
		let shape = projection
			.map(|projection| projection.shape)
			.or_else(|| section.map(|section| section.shape))
			.ok_or_else(stale)?;
		let entry = RankedSection {
			section_id: id,
			shape,
			match_kind: if exact {
				MatchKind::ExactName
			} else {
				MatchKind::Related
			},
			rank: 0.0,
		};
		self
			.cache
			.insert_candidate(&context.guard, &context.query, &entry);
		Ok(entry)
	}
}

fn hydrate(connection: &Connection, entry: &RankedSection) -> CoreResult<KnowledgeSearchHit> {
	Ok(connection.query_row(HYDRATE, [entry.section_id], |row| {
		Ok(KnowledgeSearchHit {
			section_id:    entry.section_id,
			index:         row.get(1)?,
			document_hash: row.get(2)?,
			path:          row.get(3)?,
			heading_path:  row.get(4)?,
			line_start:    row.get(5)?,
			line_end:      row.get(6)?,
			text:          row.get(7)?,
			shape:         entry.shape,
			match_kind:    entry.match_kind,
			rank:          entry.rank,
		})
	})?)
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicU64, Ordering};

	use super::*;

	static NEXT: AtomicU64 = AtomicU64::new(0);

	struct Fixture {
		dir:  std::path::PathBuf,
		path: String,
	}

	impl Fixture {
		fn new() -> Self {
			let dir = std::env::temp_dir().join(format!(
				"omp-hybrid-data-{}-{}-{}",
				std::process::id(),
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap()
					.as_nanos(),
				NEXT.fetch_add(1, Ordering::Relaxed)
			));
			std::fs::create_dir_all(&dir).unwrap();
			let path = dir.join("knowledge.db").to_string_lossy().into_owned();
			let connection = Connection::open(&path).unwrap();
			connection
				.execute_batch(
					"PRAGMA journal_mode=WAL;
				CREATE TABLE doc_indexes(id INTEGER PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL);
				CREATE TABLE documents(id INTEGER PRIMARY KEY,index_id INTEGER NOT NULL,relative_path TEXT NOT \
					 NULL,title TEXT NOT NULL,source_kind TEXT NOT NULL,sha256 TEXT NOT \
					 NULL,size_bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL);
				CREATE TABLE sections(id INTEGER PRIMARY KEY,index_id INTEGER NOT NULL,document_id INTEGER NOT \
					 NULL,ordinal INTEGER NOT NULL,heading_path TEXT NOT NULL,heading_level INTEGER \
					 NOT NULL,line_start INTEGER NOT NULL,line_end INTEGER NOT NULL,byte_start INTEGER \
					 NOT NULL,byte_end INTEGER NOT NULL,raw_markdown TEXT NOT NULL);
				CREATE TABLE wiki_document_projections(document_id INTEGER PRIMARY KEY,payload BLOB NOT NULL);
				CREATE VIRTUAL TABLE sections_fts USING fts5(section_id UNINDEXED,index_id \
					 UNINDEXED,relative_path,heading_path,body,content='',contentless_delete=1);
				CREATE TABLE wiki_vector_generations(index_id INTEGER,model TEXT,dimensions INTEGER,complete \
					 INTEGER,token TEXT);
				CREATE TABLE wiki_section_vectors(index_id INTEGER,section_id INTEGER,vector BLOB);
				INSERT INTO doc_indexes VALUES(1,'one','/unused'),(2,'two','/unused');
				INSERT INTO documents \
					 VALUES(1,1,'scope/a.md','A','markdown','a',100,1.0),(2,1,'outside.md','B','\
					 markdown','b',100,1.0),(3,2,'scope/c.md','C','markdown','c',100,1.0);
				INSERT INTO sections VALUES(1,1,1,0,'A',1,1,2,0,22,'# A\nneedle evidence \
					 one'),(2,1,2,0,'B',1,1,2,0,22,'# B\noutside evidence'),(3,2,3,0,'C',1,1,2,0,22,'# \
					 C\nneedle evidence two');
				INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) \
					 VALUES(1,1,1,'scope/a.md','A','# A needle evidence \
					 one'),(2,2,1,'outside.md','B','# B outside evidence'),(3,3,2,'scope/c.md','C','# \
					 C needle evidence two');
				INSERT INTO wiki_vector_generations VALUES(1,'model',2,1,'one'),(2,'model',2,1,'two');
				INSERT INTO wiki_section_vectors \
					 VALUES(1,1,x'9a99193fcdcc4c3f'),(1,2,x'0000803f00000000'),(2,3,x'000000000000803f'\
					 );",
				)
				.unwrap();
			connection
				.execute_batch(crate::vector_index::SCHEMA)
				.unwrap();
			let fixture = Self { dir, path };
			fixture.publish_vectors();
			fixture
		}

		fn engine(&self) -> DatabaseEngine {
			DatabaseEngine::new(self.path.clone(), self.path.clone())
		}

		fn publish_vectors(&self) {
			let mut engine = self.engine();
			engine.ensure_database().unwrap();
			let connection = engine.connection.as_ref().unwrap();
			for (id, token) in [(1, "one"), (2, "two")] {
				let (dimensions, total): (i64, i64) = connection
					.query_row(
						"SELECT g.dimensions,(SELECT count(*) FROM wiki_section_vectors v WHERE \
						 v.index_id=g.index_id) FROM wiki_vector_generations g WHERE g.index_id=?",
						[id],
						|row| Ok((row.get(0)?, row.get(1)?)),
					)
					.unwrap();
				crate::vector_index::build(
					connection,
					&engine.identity,
					id,
					token,
					usize::try_from(dimensions).unwrap(),
					usize::try_from(total).unwrap(),
					&|| Ok(()),
				)
				.unwrap();
			}
		}
	}

	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.dir);
		}
	}

	#[test]
	fn hybrid_reuses_snapshot_data_and_invalidates_external_changes() {
		let fixture = Fixture::new();
		let mut engine = fixture.engine();
		let options = KnowledgeSearchOptions { path: Some("scope/".into()), ..Default::default() };
		let prepared = engine
			.prepare_hybrid("needle", &options, Some("model"), &|| Ok(()))
			.unwrap()
			.expect_ready();
		let ids = engine
			.score_hybrid(&prepared.token, 2, || Ok(()), &[1.0, 0.0], 2)
			.unwrap()
			.unwrap();
		let candidates = engine
			.read_hybrid_candidates(&prepared.token, &ids, &|| Ok(()))
			.unwrap();
		assert!(candidates[0].hit.text.contains("needle evidence one"));
		let second = engine
			.prepare_hybrid("evidence", &options, Some("model"), &|| Ok(()))
			.unwrap()
			.expect_ready();
		assert_eq!(
			engine
				.score_hybrid(&second.token, 2, || Ok(()), &[1.0, 0.0], 2)
				.unwrap()
				.unwrap(),
			ids
		);
		let cancelled = || Err(KnowledgeError::message("cancelled"));
		assert!(
			engine
				.score_hybrid(&second.token, 2, cancelled, &[1.0, 0.0], 2)
				.is_err()
		);
		assert!(
			engine
				.read_hybrid_candidates(&second.token, &ids, &cancelled)
				.is_err()
		);
		let scoped = KnowledgeSearchOptions {
			index: Some("two".into()),
			path: Some("scope/".into()),
			..Default::default()
		};
		let other = engine
			.prepare_hybrid("needle", &scoped, Some("model"), &|| Ok(()))
			.unwrap()
			.expect_ready();
		assert_eq!(
			engine
				.score_hybrid(&other.token, 2, || Ok(()), &[1.0, 0.0], 1)
				.unwrap()
				.unwrap(),
			vec![3]
		);
		let writer = Connection::open(&fixture.path).unwrap();
		writer
			.execute_batch(
				"UPDATE sections SET raw_markdown='# A\nnew body' WHERE id=1; UPDATE \
				 wiki_section_vectors SET vector=x'00' WHERE section_id=2;",
			)
			.unwrap();
		assert!(
			engine
				.read_hybrid_candidates(&second.token, &ids, &|| Ok(()))
				.is_err()
		);
		let third = engine
			.prepare_hybrid("evidence", &options, Some("model"), &|| Ok(()))
			.unwrap()
			.expect_ready();
		assert_eq!(
			engine
				.score_hybrid(&third.token, 2, || Ok(()), &[1.0, 0.0], 1)
				.unwrap()
				.unwrap(),
			vec![3]
		);
		// This raw SQL mutation leaves the FTS row unchanged, so section 1
		// remains a fulltext candidate even though its vectors are invalid.
		let refreshed = engine
			.read_hybrid_candidates(&third.token, &[1], &|| Ok(()))
			.unwrap();
		assert_eq!(refreshed[0].hit.text, "# A\nnew body");
		engine.close();
		let reopened = engine
			.prepare_hybrid("evidence", &options, Some("model"), &|| Ok(()))
			.unwrap()
			.expect_ready();
		assert_eq!(
			engine
				.score_hybrid(&reopened.token, 2, || Ok(()), &[1.0, 0.0], 1)
				.unwrap()
				.unwrap(),
			vec![3]
		);
		engine
			.connection
			.as_ref()
			.unwrap()
			.execute_batch(
				"UPDATE wiki_section_vectors SET vector=x'0000803f00000000' WHERE section_id=2;
			 UPDATE sections SET raw_markdown='# A\nlocal body' WHERE id=1;",
			)
			.unwrap();
		assert!(
			engine
				.read_hybrid_candidates(&reopened.token, &[1], &|| Ok(()))
				.is_err()
		);
		fixture.publish_vectors();
		let local = engine
			.prepare_hybrid("evidence", &options, Some("model"), &|| Ok(()))
			.unwrap()
			.expect_ready();
		assert_eq!(
			engine
				.score_hybrid(&local.token, 2, || Ok(()), &[1.0, 0.0], 2)
				.unwrap()
				.unwrap(),
			vec![1, 3]
		);
		assert_eq!(
			engine
				.read_hybrid_candidates(&local.token, &[1], &|| Ok(()))
				.unwrap()[0]
				.hit
				.text,
			"# A\nlocal body"
		);
	}

	#[test]
	fn budget_fallback_and_eviction_preserve_hybrid_results() {
		let fixture = Fixture::new();
		let options = KnowledgeSearchOptions { path: Some("scope/".into()), ..Default::default() };
		let mut cached = fixture.engine();
		cached.hybrid_data.1 = 900;
		let mut uncached = fixture.engine();
		uncached.hybrid_data.1 = 0;
		let left = cached
			.prepare_hybrid("needle", &options, Some("model"), &|| Ok(()))
			.unwrap()
			.expect_ready();
		let right = uncached
			.prepare_hybrid("needle", &options, Some("model"), &|| Ok(()))
			.unwrap()
			.expect_ready();
		assert_eq!(left.vector_dimensions, right.vector_dimensions);
		let left_ids = cached
			.score_hybrid(&left.token, 2, || Ok(()), &[0.0, 1.0], 2)
			.unwrap()
			.unwrap();
		let right_ids = uncached
			.score_hybrid(&right.token, 2, || Ok(()), &[0.0, 1.0], 2)
			.unwrap()
			.unwrap();
		assert_eq!(left_ids, right_ids);
		let left_hits = cached
			.read_hybrid_candidates(&left.token, &left_ids, &|| Ok(()))
			.unwrap();
		let right_hits = uncached
			.read_hybrid_candidates(&right.token, &right_ids, &|| Ok(()))
			.unwrap();
		for (left, right) in left_hits.iter().zip(&right_hits) {
			assert_eq!(
				serde_json::to_value(&left.hit).unwrap(),
				serde_json::to_value(&right.hit).unwrap()
			);
			assert_eq!(left.source_order, right.source_order);
		}
		let ids: Vec<_> = left.fulltext.iter().map(|item| item.section_id).collect();
		assert_eq!(
			ids,
			right
				.fulltext
				.iter()
				.map(|item| item.section_id)
				.collect::<Vec<_>>()
		);
		let left_output = cached
			.finish_hybrid(&left.token, &ids, "", "", &|| Ok(()))
			.unwrap();
		let right_output = uncached
			.finish_hybrid(&right.token, &ids, "", "", &|| Ok(()))
			.unwrap();
		assert_eq!(
			serde_json::to_value(left_output).unwrap(),
			serde_json::to_value(right_output).unwrap()
		);
		let cache = cached.hybrid_data.0.borrow();
		assert!(cache.bytes <= 900);
		let empty = uncached.hybrid_data.0.borrow();
		assert_eq!(empty.bytes, 0);
		assert!(empty.hits.is_empty());
	}

	#[test]
	fn repeated_preparation_preserves_scoped_candidates_within_guard() {
		let fixture = Fixture::new();
		let writer = Connection::open(&fixture.path).unwrap();
		writer.execute_batch(
			"WITH RECURSIVE n(x) AS (VALUES(4) UNION ALL SELECT x+1 FROM n WHERE x<203)
			 INSERT INTO sections SELECT x,1,1,x,'A',1,1,2,0,1,'extra' FROM n;
			 INSERT INTO wiki_section_vectors SELECT 1,id,x'0000803f00000000' FROM sections WHERE id>=4;"
		).unwrap();
		fixture.publish_vectors();
		let mut engine = fixture.engine();
		engine.hybrid_data.1 = 4096;
		let options = KnowledgeSearchOptions::default();
		let first = engine
			.prepare_hybrid("needle", &options, Some("model"), || Ok(()))
			.unwrap()
			.expect_ready();
		let second = engine
			.prepare_hybrid("evidence", &options, Some("model"), || Ok(()))
			.unwrap()
			.expect_ready();
		assert_eq!(second.vector_dimensions, first.vector_dimensions);
		assert!(engine.hybrid_data.0.borrow().bytes <= engine.hybrid_data.1);
		let first_scores = engine
			.score_hybrid(&first.token, 2, || Ok(()), &[0.0, 1.0], 203)
			.unwrap()
			.unwrap();
		let second_scores = engine
			.score_hybrid(&second.token, 2, || Ok(()), &[0.0, 1.0], 203)
			.unwrap()
			.unwrap();
		assert_eq!(first_scores, second_scores);
		assert_eq!(&second_scores[..2], &[3, 1]);
		let mut all_ids = second_scores;
		all_ids.sort_unstable();
		assert_eq!(all_ids, (1..=203).collect::<Vec<i64>>());
	}

	#[test]
	fn streamed_validation_is_reused_across_paths_and_invalidated_by_external_writes() {
		use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

		let fixture = Fixture::new();
		let writer = Connection::open(&fixture.path).unwrap();
		let mut vector = vec![0.0f32; 256];
		vector[0] = 0.6;
		vector[1] = 0.8;
		let bytes: Vec<u8> = vector
			.iter()
			.flat_map(|value| value.to_le_bytes())
			.collect();
		writer
			.execute("UPDATE wiki_vector_generations SET dimensions=256", [])
			.unwrap();
		writer
			.execute("UPDATE wiki_section_vectors SET vector=?", [bytes])
			.unwrap();
		fixture.publish_vectors();
		let mut engine = fixture.engine();
		engine.hybrid_data.1 = 2048;
		engine
			.prepare_hybrid("needle", &KnowledgeSearchOptions::default(), Some("model"), || Ok(()))
			.unwrap();
		engine
			.connection
			.as_ref()
			.unwrap()
			.authorizer(Some(|context: AuthContext<'_>| {
				if matches!(context.action, AuthAction::Read {
					table_name:  "wiki_section_vectors",
					column_name: "vector",
				}) {
					Authorization::Deny
				} else {
					Authorization::Allow
				}
			}))
			.unwrap();
		let options =
			KnowledgeSearchOptions { path: Some("scope/c.md".into()), ..Default::default() };
		// A different query and path reuse the published ANN index without
		// rereading authoritative vector payloads during a read-only query.
		let prepared = engine
			.prepare_hybrid("evidence", &options, Some("model"), || Ok(()))
			.unwrap()
			.expect_ready();
		engine
			.connection
			.as_ref()
			.unwrap()
			.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
			.unwrap();
		let query: Vec<f64> = vector.iter().map(|value| f64::from(*value)).collect();
		let actual = engine
			.score_hybrid(&prepared.token, 256, || Ok(()), &query, 3)
			.unwrap()
			.unwrap();
		assert_eq!(actual, vec![3]);
		let mut uncached = fixture.engine();
		uncached.hybrid_data.1 = 0;
		let reference = uncached
			.prepare_hybrid("evidence", &options, Some("model"), || Ok(()))
			.unwrap()
			.expect_ready();
		let expected = uncached
			.score_hybrid(&reference.token, 256, || Ok(()), &query, 3)
			.unwrap()
			.unwrap();
		assert_eq!(actual, expected);
		assert_eq!(
			serde_json::to_value(
				engine
					.finish_hybrid(&prepared.token, &actual, "", "", &|| Ok(()))
					.unwrap()
			)
			.unwrap(),
			serde_json::to_value(
				uncached
					.finish_hybrid(&reference.token, &expected, "", "", &|| Ok(()))
					.unwrap()
			)
			.unwrap(),
		);
		assert!(
			engine
				.score_hybrid(
					&prepared.token,
					256,
					|| Err(KnowledgeError::message("cancelled")),
					&query,
					3
				)
				.is_err()
		);
		writer
			.execute("UPDATE wiki_section_vectors SET vector=x'00' WHERE section_id=2", [])
			.unwrap();
		let options =
			KnowledgeSearchOptions { path: Some("scope/a.md".into()), ..Default::default() };
		let changed = engine
			.prepare_hybrid("needle", &options, Some("model"), || Ok(()))
			.unwrap()
			.expect_ready();
		assert!(
			changed.vector_dimensions.is_empty(),
			"an out-of-scope corrupt row invalidates its whole generation"
		);
		assert!(
			engine
				.read_hybrid_candidates(&prepared.token, &actual, &|| Ok(()))
				.is_err()
		);
	}

	#[test]
	fn semantic_candidate_classification_is_reused_for_finish() {
		let fixture = Fixture::new();
		let mut engine = fixture.engine();
		let options = KnowledgeSearchOptions::default();
		let prepared = engine
			.prepare_hybrid("needle", &options, Some("model"), || Ok(()))
			.unwrap()
			.expect_ready();
		assert!(
			engine
				.read_hybrid_candidates(&prepared.token, &[2], &|| Ok(()))
				.is_err(),
			"semantic-only evidence must be authorized by scoring first"
		);
		let semantic = engine
			.score_hybrid(&prepared.token, 2, || Ok(()), &[1.0, 0.0], 3)
			.unwrap()
			.unwrap();
		assert!(semantic.contains(&2));
		let candidate = engine
			.read_hybrid_candidates(&prepared.token, &[2], &|| Ok(()))
			.unwrap()
			.remove(0);
		let context = engine.hybrid_context(&prepared.token).unwrap();
		let cached = engine
			.hybrid_data
			.candidate(&context.guard, &context.query, 2)
			.unwrap();
		assert_eq!(cached.match_kind, candidate.hit.match_kind);
		assert_eq!(cached.shape, candidate.hit.shape);
		let mut ids: Vec<_> = prepared
			.fulltext
			.iter()
			.map(|rank| rank.section_id)
			.collect();
		ids.push(2);
		let result = engine
			.finish_hybrid(&prepared.token, &ids, "semantic", "", &|| Ok(()))
			.unwrap();
		let hit = result
			.result
			.sections
			.iter()
			.find(|hit| hit.section_id == 2)
			.unwrap();
		assert_eq!(hit.match_kind, candidate.hit.match_kind);
		assert_eq!(hit.text, candidate.hit.text);
	}

	#[test]
	fn sqlite_progress_cancellation_is_cleared_before_rollback() {
		use std::sync::atomic::AtomicUsize;
		let fixture = Fixture::new();
		let mut engine = fixture.engine();
		engine.ensure_database().unwrap();
		let guard = engine.guard().unwrap();
		let calls = Arc::new(AtomicUsize::new(0));
		let count = Arc::clone(&calls);
		let check = move || {
			if count.fetch_add(1, Ordering::Relaxed) >= 4 {
				Err(KnowledgeError::message("cancelled"))
			} else {
				Ok(())
			}
		};
		let result = engine.hybrid_snapshot_checked(&guard, check, |connection| {
			connection
				.query_row(
					"WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000) \
					 SELECT sum(x) FROM n",
					[],
					|row| row.get::<_, i64>(0),
				)
				.map_err(Into::into)
		});
		assert!(result.is_err());
		assert!(calls.load(Ordering::Relaxed) >= 5);
		let connection = engine.connection.as_ref().unwrap();
		assert!(connection.is_autocommit());
		let value: i64 = connection
			.query_row(
				"WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT \
				 max(x) FROM n",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(value, 10000);
	}
}
