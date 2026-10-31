//! Internal snapshot-bound ranking exchange with the host model clients.
use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use rusqlite::{Connection, params};

use super::{
	Check, CoreResult, DatabaseEngine, DocumentContexts, HYDRATE, HybridCandidate, HybridCompleted,
	HybridContext, HybridPreparation, HybridPrepared, HybridRank, LiteralMatcher, MatchKind,
	RankedSection, Ranking, WikiCursorBase, WikiError, WikiSearchHit, WikiSearchOptions,
	WikiSearchOutput, WikiSearchWindow, digest, load_contexts, query,
};

const SNAPSHOT_STALE: &str = "WIKI_SNAPSHOT_STALE";

fn stale() -> WikiError {
	let mut error =
		WikiError::message("Stale documentation search cursor: indexed snapshot has changed");
	error.code = Some(SNAPSHOT_STALE.to_owned());
	error
}

fn is_stale(error: &WikiError) -> bool {
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

	fn hybrid_key(&self, text: &str, options: &WikiSearchOptions) -> CoreResult<String> {
		if options.cursor.is_some() || options.mode.as_deref().unwrap_or("search") != "search" {
			return Err(WikiError::message("Invalid documentation hybrid search options"));
		}
		Ok(digest(
			serde_json::to_string(&(
				query::normalize_search_text(text),
				&options.index,
				&self.cursor_path,
			))
			.expect("query serialization")
			.as_bytes(),
		))
	}

	/// Inspect whether a reusable nonempty ranking exists, without resolving
	/// models.
	pub fn has_cached_hybrid_candidates(
		&mut self,
		text: &str,
		options: &WikiSearchOptions,
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
		options: &WikiSearchOptions,
		configuration: &str,
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<Option<WikiSearchOutput>> {
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
			return Err(WikiError::message("Invalid documentation search page size"));
		}
		let limit = limit.clamp(1.0, 500.0) as usize;
		let sections = match self.hybrid_snapshot(&guard, |connection| {
			let mut sections = Vec::with_capacity(limit.min(ranking.ranked.len()));
			for entry in ranking.ranked.iter().take(limit) {
				check()?;
				sections.push(hydrate(connection, entry)?);
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
		Ok(Some(WikiSearchOutput {
			result:     WikiSearchWindow {
				sections,
				total: ranking.ranked.len() as i64,
				exact_name_matches: ranking.exact_name_matches as i64,
				technical_name: plan.technical_name,
				cursor_base: WikiCursorBase { v: 1, q: key, s: ranking.version.clone(), p: 0 },
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
		options: &WikiSearchOptions,
		model: Option<&str>,
		check: F,
	) -> CoreResult<HybridPreparation>
	where
		F: Fn() -> CoreResult<()> + Clone + Send + 'static,
	{
		if options.cursor.is_some() || options.mode.as_deref().unwrap_or("search") != "search" {
			return Err(WikiError::message("Invalid documentation hybrid search options"));
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
		options: &WikiSearchOptions,
		model: Option<&str>,
		check: F,
	) -> CoreResult<HybridPrepared>
	where
		F: Fn() -> CoreResult<()> + Clone + Send + 'static,
	{
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
		let (source_order, vectors, vector_failure) = self.hybrid_snapshot(&guard, |connection| {
			let mut wanted: HashSet<i64> = baseline
				.ranked
				.iter()
				.map(|entry| entry.section_id)
				.collect();
			let mut vector_dimensions = Vec::new();
			{
				let has_generations: bool = if model.is_some() {
					connection.query_row(
						"SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND \
						 name='wiki_vector_generations')",
						[],
						|row| row.get(0),
					)?
				} else {
					false
				};
				if let Some(model) = model.filter(|_| has_generations) {
					let mut dimensions = connection.prepare(
						"SELECT DISTINCT g.dimensions FROM wiki_vector_generations g JOIN doc_indexes i \
						 ON i.id=g.index_id WHERE g.complete=1 AND g.model=? AND \
						 typeof(g.dimensions)='integer' AND g.dimensions>0 AND g.dimensions<=4294967295 \
						 AND i.name NOT GLOB '__building__*' AND (? IS NULL OR i.name=?) ORDER BY \
						 g.dimensions",
					)?;
					let dims = dimensions
						.query_map(params![model, options.index, options.index], |row| {
							row.get::<_, i64>(0)
						})?;
					for dimension in dims {
						check()?;
						let dimension = usize::try_from(dimension?).map_err(|_| stale())?;
						let section_ids = crate::vectors::read_vector_ids(
							connection,
							model,
							dimension,
							options.index.as_deref(),
							&check,
						)?;
						if !section_ids.is_empty() {
							wanted.extend(section_ids);
							vector_dimensions.push(dimension);
						}
					}
				}
			}
			let mut source_order = HashMap::with_capacity(wanted.len());
			let mut statement = connection.prepare(
				"SELECT s.id FROM sections s JOIN documents d ON d.id=s.document_id JOIN doc_indexes \
				 i ON i.id=s.index_id WHERE i.name NOT GLOB '__building__*' AND (? IS NULL OR \
				 i.name=?) ORDER BY i.id,d.id,s.ordinal,s.id",
			)?;
			let ids = statement
				.query_map(params![options.index, options.index], |row| row.get::<_, i64>(0))?;
			for (position, id) in ids.enumerate() {
				check()?;
				let id = id?;
				if wanted.contains(&id) {
					source_order.insert(id, position as i64);
				}
			}
			Ok((source_order, vector_dimensions, false))
		})?;
		let fulltext = baseline
			.ranked
			.iter()
			.map(|entry| {
				Ok(HybridRank {
					section_id:   entry.section_id,
					match_kind:   entry.match_kind,
					rank:         entry.rank,
					source_order: *source_order.get(&entry.section_id).ok_or_else(stale)?,
				})
			})
			.collect::<CoreResult<Vec<_>>>()?;
		let baseline_positions = baseline
			.ranked
			.iter()
			.enumerate()
			.map(|(position, entry)| (entry.section_id, position))
			.collect();
		let mut allowed: HashSet<i64> = baseline
			.ranked
			.iter()
			.map(|entry| entry.section_id)
			.collect();
		// All valid vector IDs were included in source_order above.
		allowed.extend(source_order.keys().copied());
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
			model: model.map(str::to_owned),
			vector_dimensions: vectors.clone(),
			limit: options.limit,
			baseline,
			baseline_positions,
			source_order,
			allowed,
		}));
		while self.hybrid.len() > 8 {
			self.hybrid.pop_front();
		}
		Ok(HybridPrepared {
			token,
			effective_query: text.to_owned(),
			fulltext,
			vector_dimensions: vectors,
			vector_failure,
		})
	}

	/// Score a compatible generation inside the prepared snapshot, after model
	/// I/O.
	pub fn score_hybrid(
		&self,
		token: &str,
		dimensions: usize,
		check: &dyn Fn() -> CoreResult<()>,
		score: impl FnOnce(&[f32], usize) -> Vec<u32>,
	) -> CoreResult<Option<Vec<i64>>> {
		let context = self.hybrid_context(token)?;
		if !context.vector_dimensions.contains(&dimensions) {
			return Ok(None);
		}
		let model = context.model.as_deref().ok_or_else(stale)?;
		self.hybrid_snapshot(&context.guard, |connection| {
			let matrix = crate::vectors::read_vector_matrix(
				connection,
				model,
				dimensions,
				context.index.as_deref(),
				check,
			)?;
			check()?;
			let rows = score(&matrix.matrix, dimensions);
			check()?;
			rows
				.into_iter()
				.map(|row| {
					matrix
						.section_ids
						.get(row as usize)
						.copied()
						.ok_or_else(stale)
				})
				.collect::<CoreResult<Vec<_>>>()
				.map(Some)
		})
	}

	/// Hydrate only explicitly selected candidates from the prepared snapshot.
	pub fn read_hybrid_candidates(
		&self,
		token: &str,
		ids: &[i64],
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<Vec<HybridCandidate>> {
		let context = self.hybrid_context(token)?;
		self.hybrid_snapshot(&context.guard, |connection| {
			let mut unique = HashSet::new();
			let mut hits = Vec::with_capacity(ids.len());
			let mut resolver = CandidateResolver::new(&context.query);
			for &id in ids {
				check()?;
				if !context.allowed.contains(&id) || !unique.insert(id) {
					return Err(stale());
				}
				let entry = resolver.candidate(connection, &context, id, check)?;
				let hit = hydrate(connection, &entry)?;
				hits.push(HybridCandidate {
					hit,
					source_order: *context.source_order.get(&id).ok_or_else(stale)?,
				});
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
	) -> CoreResult<WikiSearchOutput> {
		let context = self.hybrid_context(token)?;
		let baseline_ids: HashSet<i64> = context
			.baseline
			.ranked
			.iter()
			.map(|entry| entry.section_id)
			.collect();
		let mut unique = HashSet::new();
		if ids
			.iter()
			.any(|id| !context.allowed.contains(id) || !unique.insert(*id))
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
			let mut resolver = CandidateResolver::new(&context.query);
			for &id in ids {
				check()?;
				let entry = resolver.candidate(connection, &context, id, check)?;
				if entry.match_kind == MatchKind::ExactName {
					if saw_related {
						return Err(WikiError::message(
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
				sections.push(hydrate(connection, entry)?);
			}
			Ok((Arc::new(Ranking { ranked, version, exact_name_matches }), sections))
		})?;
		let plan = query::analyze_query(&context.query);
		let cursor_base =
			WikiCursorBase { v: 1, q: context.key.clone(), s: ranking.version.clone(), p: 0 };
		let result = WikiSearchWindow {
			sections,
			total: ranking.ranked.len() as i64,
			exact_name_matches: ranking.exact_name_matches as i64,
			technical_name: plan.technical_name,
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
		Ok(WikiSearchOutput { result, cache_hit: false, term_count: plan.terms.len() as i64 })
	}
}

struct CandidateResolver {
	name:      Option<LiteralMatcher>,
	documents: HashMap<i64, DocumentContexts>,
}

impl CandidateResolver {
	fn new(text: &str) -> Self {
		let plan = query::analyze_query(text);
		let name = plan.technical_name.as_deref().map(|name| {
			LiteralMatcher::new(
				&query::normalize_search_text(name),
				!name.contains(['/', '\\']) && !name.contains("::"),
			)
		});
		Self { name, documents: HashMap::new() }
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
		let (document_id, text): (i64, String) = connection.query_row(
			"SELECT s.document_id,s.raw_markdown FROM sections s JOIN doc_indexes i ON \
			 i.id=s.index_id WHERE s.id=? AND i.name NOT GLOB '__building__*' AND (? IS NULL OR \
			 i.name=?)",
			params![id, context.index, context.index],
			|row| Ok((row.get(0)?, row.get(1)?)),
		)?;
		if let std::collections::hash_map::Entry::Vacant(entry) = self.documents.entry(document_id) {
			entry.insert(load_contexts(connection, document_id, self.name.as_ref(), check)?);
		}
		let contexts = self
			.documents
			.get(&document_id)
			.expect("loaded document contexts");
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
		Ok(RankedSection {
			section_id: id,
			shape,
			match_kind: if exact {
				MatchKind::ExactName
			} else {
				MatchKind::Related
			},
			rank: 0.0,
		})
	}
}

fn hydrate(connection: &Connection, entry: &RankedSection) -> CoreResult<WikiSearchHit> {
	Ok(connection.query_row(HYDRATE, [entry.section_id], |row| {
		Ok(WikiSearchHit {
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
