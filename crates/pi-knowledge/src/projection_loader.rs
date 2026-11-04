//! Bounded document preparation driven by the actual candidate rows.
//! SQLite remains on the caller thread and in its existing read snapshot.
use std::{
	collections::VecDeque,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
		mpsc::{self, Receiver, RecvTimeoutError},
	},
	time::Duration,
};

use rayon::{Scope, prelude::*};
use rusqlite::{Connection, OptionalExtension};

use super::{
	CandidateInput, Check, ContextLoader, CoreResult, DocumentContexts, KnowledgeError,
	LiteralMatcher, decode_contexts, load_contexts, load_legacy_contexts, query, score_candidate,
};

const MIN_BYTES: usize = 256 * 1024;

enum Prepared {
	Ready(CoreResult<DocumentContexts>),
	Running(Receiver<CoreResult<DocumentContexts>>),
}

struct PendingDocument {
	id:     i64,
	bytes:  usize,
	result: Prepared,
}

pub(super) struct Loader<'a, 'scope, F> {
	scope:         &'a Scope<'scope>,
	check:         F,
	name:          Option<&'scope LiteralMatcher>,
	stopped:       Arc<AtomicBool>,
	documents:     VecDeque<i64>,
	pending:       VecDeque<PendingDocument>,
	pending_bytes: usize,
	budget:        usize,
	workers:       usize,
}

impl<'a, 'scope, F> Loader<'a, 'scope, F>
where
	F: Fn() -> CoreResult<()> + Clone + Send + 'static,
{
	pub(super) fn new(
		scope: &'a Scope<'scope>,
		check: F,
		name: Option<&'scope LiteralMatcher>,
	) -> Self {
		Self {
			scope,
			check,
			name,
			stopped: Arc::new(AtomicBool::new(false)),
			documents: VecDeque::new(),
			pending: VecDeque::new(),
			pending_bytes: 0,
			budget: crate::parallel::memory_budget(64, 256 * 1024 * 1024),
			workers: crate::parallel::pool().map_or(1, rayon::ThreadPool::current_num_threads),
		}
	}

	fn advance(&mut self, connection: &Connection, check: Check<'_>) -> CoreResult<()> {
		while self.pending.len() < self.workers
			&& (self.pending.is_empty() || self.pending_bytes < self.budget)
		{
			let Some(id) = self.documents.pop_front() else {
				break;
			};
			check()?;
			// Read once, including small and missing projections. No metadata
			// pre-scan or second payload lookup on the synchronous path.
			let payload: Option<Vec<u8>> = connection
				.prepare_cached("SELECT payload FROM wiki_document_projections WHERE document_id=?")?
				.query_row([id], |row| row.get(0))
				.optional()?;
			let (bytes, result) = match payload {
				Some(payload) if payload.len() >= MIN_BYTES && payload.len() <= self.budget / 4 => {
					let bytes = payload.len().saturating_mul(4);
					let (sender, receiver) = mpsc::sync_channel(1);
					let worker_check = self.check.clone();
					let stopped = Arc::clone(&self.stopped);
					let name = self.name;
					self.scope.spawn(move |_| {
						let check = || {
							if stopped.load(Ordering::Relaxed) {
								return Err(KnowledgeError::message(
									"Documentation projection preparation cancelled",
								));
							}
							worker_check()
						};
						let result = decode_contexts(&payload, name, &check);
						let _ = sender.send(result);
					});
					(bytes, Prepared::Running(receiver))
				},
				payload => {
					let result = match payload {
						Some(payload) => decode_contexts(&payload, self.name, check),
						None => load_legacy_contexts(connection, id, self.name, check),
					};
					let bytes = result.as_ref().map_or(0, DocumentContexts::estimated_bytes);
					(bytes, Prepared::Ready(result))
				},
			};
			self.pending_bytes = self.pending_bytes.saturating_add(bytes);
			self
				.pending
				.push_back(PendingDocument { id, bytes, result });
		}
		Ok(())
	}
}

impl<F> ContextLoader for Loader<'_, '_, F>
where
	F: Fn() -> CoreResult<()> + Clone + Send + 'static,
{
	fn prepare(
		&mut self,
		connection: &Connection,
		documents: &[i64],
		check: Check<'_>,
	) -> CoreResult<()> {
		self.documents.extend(documents.iter().copied());
		self.advance(connection, check)
	}

	fn load(
		&mut self,
		connection: &Connection,
		document_id: i64,
		name: Option<&LiteralMatcher>,
		check: Check<'_>,
	) -> CoreResult<DocumentContexts> {
		let Some(position) = self
			.pending
			.iter()
			.position(|document| document.id == document_id)
		else {
			return load_contexts(connection, document_id, name, check);
		};
		let pending = self.pending.remove(position).expect("prefetched document");
		self.pending_bytes = self.pending_bytes.saturating_sub(pending.bytes);
		let contexts = match pending.result {
			Prepared::Ready(result) => result?,
			Prepared::Running(receiver) => loop {
				check()?;
				match receiver.recv_timeout(Duration::from_millis(10)) {
					Ok(result) => break result?,
					Err(RecvTimeoutError::Timeout) => {},
					Err(RecvTimeoutError::Disconnected) => {
						return Err(KnowledgeError::message(
							"Documentation projection preparation worker stopped",
						));
					},
				}
			},
		};
		self.advance(connection, check)?;
		Ok(contexts)
	}

	fn score(
		&self,
		inputs: Vec<CandidateInput>,
		ranker: &query::CandidateRanker<'_>,
		name: Option<&LiteralMatcher>,
	) -> Vec<CoreResult<Option<query::CandidateScore>>> {
		if inputs.len() < 2
			|| (inputs.len() < 16
				&& inputs
					.iter()
					.map(|input| input.markdown.len())
					.sum::<usize>()
					< 256 * 1024)
		{
			return inputs
				.into_iter()
				.map(|input| score_candidate(input, ranker, name, &self.check))
				.collect();
		}
		let checks = std::sync::Mutex::new(self.check.clone());
		match crate::parallel::pool() {
			Some(pool) => pool.install(|| {
				inputs
					.into_par_iter()
					.map_init(
						|| checks.lock().expect("check mutex").clone(),
						|check, input| score_candidate(input, ranker, name, check),
					)
					.collect()
			}),
			None => inputs
				.into_iter()
				.map(|input| score_candidate(input, ranker, name, &self.check))
				.collect(),
		}
	}
}

impl<F> Drop for Loader<'_, '_, F> {
	fn drop(&mut self) {
		// The enclosing scope joins every job before the transaction ends.
		self.stopped.store(true, Ordering::Relaxed);
	}
}
