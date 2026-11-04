//! Bounded document lookahead: SQLite stays in the caller's read snapshot.
use std::{
	collections::VecDeque,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
		mpsc::{self, Receiver, RecvTimeoutError},
	},
	time::Duration,
};

use rayon::Scope;
use rusqlite::Connection;

use super::{
	Check, ContextLoader, CoreResult, DocumentContexts, KnowledgeError, LiteralMatcher,
	PATH_SCOPE_FILTER, decode_contexts, load_contexts, query,
};

const MIN_BYTES: usize = 256 * 1024;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const LOOKAHEAD: usize = 2;

pub(super) struct Loader<'a, 'scope, F> {
	scope:     &'a Scope<'scope>,
	check:     F,
	name:      Option<&'scope LiteralMatcher>,
	stopped:   Arc<AtomicBool>,
	documents: VecDeque<i64>,
	pending:   VecDeque<(i64, Receiver<CoreResult<DocumentContexts>>)>,
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
		}
	}

	fn advance(&mut self, connection: &Connection, check: Check<'_>) -> CoreResult<()> {
		while self.pending.len() < LOOKAHEAD {
			let Some(id) = self.documents.pop_front() else {
				return Ok(());
			};
			check()?;
			let payload: Vec<u8> = connection.query_row(
				"SELECT payload FROM wiki_document_projections WHERE document_id=?",
				[id],
				|row| row.get(0),
			)?;
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
				drop(payload);
				let _ = sender.send(result);
			});
			self.pending.push_back((id, receiver));
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
		plan: &query::QueryPlan,
		parameters: &[&dyn rusqlite::ToSql],
		check: Check<'_>,
	) -> CoreResult<()> {
		if self.name.is_none() && plan.terms.is_empty() {
			return Ok(());
		}
		// Only metadata is scanned here. Select precisely the documents the
		// candidate loop will visit, in their first-section order.
		let mut sql = format!(
			"SELECT s.document_id FROM sections s JOIN documents d ON d.id=s.document_id JOIN \
			 doc_indexes i ON i.id=s.index_id JOIN wiki_document_projections p ON p.document_id=d.id \
			 WHERE i.name NOT GLOB '__building__*' AND (?1 IS NULL OR (typeof(i.name)='text' AND \
			 i.name=?1)) AND {PATH_SCOPE_FILTER} AND typeof(p.payload)='blob' AND length(p.payload) \
			 BETWEEN {MIN_BYTES} AND {MAX_BYTES}"
		);
		if self.name.is_none() {
			sql.push_str(" AND s.id IN (SELECT rowid FROM sections_fts WHERE sections_fts MATCH ?5)");
		}
		sql.push_str(" GROUP BY s.document_id ORDER BY min(s.id)");
		let mut statement = connection.prepare_cached(&sql)?;
		let mut rows = statement.query(parameters)?;
		while let Some(row) = rows.next()? {
			check()?;
			self.documents.push_back(row.get(0)?);
		}
		self.advance(connection, check)
	}

	fn load(
		&mut self,
		connection: &Connection,
		document_id: i64,
		name: Option<&LiteralMatcher>,
		check: Check<'_>,
	) -> CoreResult<DocumentContexts> {
		let Some(position) = self.pending.iter().position(|(id, _)| *id == document_id) else {
			return load_contexts(connection, document_id, name, check);
		};
		let (_, receiver) = self.pending.remove(position).expect("prefetched document");
		let contexts = loop {
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
		};
		self.advance(connection, check)?;
		Ok(contexts)
	}
}

impl<F> Drop for Loader<'_, '_, F> {
	fn drop(&mut self) {
		// The enclosing scope joins both lookahead jobs before COMMIT or
		// ROLLBACK and before its matcher or cancellation owner can be dropped.
		self.stopped.store(true, Ordering::Relaxed);
	}
}
