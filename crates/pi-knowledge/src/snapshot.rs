//! Serialize bounded row batches in parallel, then hash in the original SQL
//! order. SQLite and the incremental SHA state remain on the snapshot-owning
//! thread.
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
use rusqlite::{Connection, Row, types::ValueRef};
use sha2::{Digest, Sha256};

use super::{
	Check, CoreResult, INDEX_ROWS, KnowledgeError, SECTION_ROWS, push_number, push_string,
};

const BATCH_BYTES: usize = 256 * 1024;
const BATCH_ROWS: usize = 256;

enum Cell {
	Null,
	Integer(i64),
	Real(f64),
	Text(std::ops::Range<usize>),
	Blob(std::ops::Range<usize>),
}

#[derive(Default)]
struct Batch {
	cells: Vec<Cell>,
	bytes: Vec<u8>,
	rows:  usize,
}

impl Batch {
	fn push(&mut self, row: &Row<'_>) -> CoreResult<()> {
		for column in 0..row.as_ref().column_count() {
			self.cells.push(match row.get_ref(column)? {
				ValueRef::Null => Cell::Null,
				ValueRef::Integer(value) => Cell::Integer(value),
				ValueRef::Real(value) => Cell::Real(value),
				ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
					let start = self.bytes.len();
					self.bytes.extend_from_slice(bytes);
					let range = start..self.bytes.len();
					if matches!(row.get_ref(column)?, ValueRef::Text(_)) {
						Cell::Text(range)
					} else {
						Cell::Blob(range)
					}
				},
			});
		}
		self.rows += 1;
		Ok(())
	}

	fn encode(&self, prefixes: &[String], check: Check<'_>) -> CoreResult<String> {
		let mut output = String::with_capacity(self.bytes.len());
		for row in self.cells.chunks_exact(prefixes.len()) {
			check()?;
			output.push('{');
			for (prefix, cell) in prefixes.iter().zip(row) {
				output.push_str(prefix);
				append_value(&mut output, match cell {
					Cell::Null => ValueRef::Null,
					Cell::Integer(value) => ValueRef::Integer(*value),
					Cell::Real(value) => ValueRef::Real(*value),
					Cell::Text(range) => ValueRef::Text(&self.bytes[range.clone()]),
					Cell::Blob(range) => ValueRef::Blob(&self.bytes[range.clone()]),
				});
			}
			output.push('}');
		}
		Ok(output)
	}
}

fn append_value(output: &mut String, value: ValueRef<'_>) {
	match value {
		ValueRef::Null => output.push_str("null"),
		ValueRef::Integer(value) => push_number(output, value as f64),
		ValueRef::Real(value) => push_number(output, value),
		ValueRef::Text(value) => push_string(output, &String::from_utf8_lossy(value)),
		ValueRef::Blob(value) => {
			output.push('{');
			for (position, byte) in value.iter().enumerate() {
				if position != 0 {
					output.push(',');
				}
				push_string(output, &position.to_string());
				output.push(':');
				output.push_str(&byte.to_string());
			}
			output.push('}');
		},
	}
}

pub(super) fn hash_row(
	snapshot: &mut Sha256,
	row: &Row<'_>,
	output: &mut String,
) -> CoreResult<()> {
	output.clear();
	output.push('{');
	for position in 0..row.as_ref().column_count() {
		if position != 0 {
			output.push(',');
		}
		push_string(output, row.as_ref().column_name(position)?);
		output.push(':');
		append_value(output, row.get_ref(position)?);
	}
	output.push('}');
	snapshot.update(output.as_bytes());
	Ok(())
}

struct Pipeline<'a, 'scope, F> {
	scope:    &'a Scope<'scope>,
	workers:  usize,
	check:    F,
	stopped:  Arc<AtomicBool>,
	pending:  VecDeque<Receiver<CoreResult<String>>>,
	snapshot: Sha256,
}

impl<F> Pipeline<'_, '_, F>
where
	F: Fn() -> CoreResult<()> + Clone + Send + 'static,
{
	fn receive(&mut self) -> CoreResult<()> {
		let receiver = self.pending.front().expect("pending snapshot batch");
		let encoded = loop {
			(self.check)()?;
			match receiver.recv_timeout(Duration::from_millis(10)) {
				Ok(result) => break result?,
				Err(RecvTimeoutError::Timeout) => {},
				Err(RecvTimeoutError::Disconnected) => {
					return Err(KnowledgeError::message("Documentation snapshot worker stopped"));
				},
			}
		};
		self.pending.pop_front();
		self.snapshot.update(encoded.as_bytes());
		Ok(())
	}

	fn drain(&mut self) -> CoreResult<()> {
		while !self.pending.is_empty() {
			self.receive()?;
		}
		Ok(())
	}

	fn submit(&mut self, batch: Batch, prefixes: Arc<Vec<String>>) -> CoreResult<()> {
		if self.pending.len() >= self.workers {
			self.receive()?;
		}
		let check = self.check.clone();
		let stopped = Arc::clone(&self.stopped);
		let (sender, receiver) = mpsc::sync_channel(1);
		self.scope.spawn(move |_| {
			let result = batch.encode(&prefixes, &|| {
				if stopped.load(Ordering::Relaxed) {
					return Err(KnowledgeError::message("Documentation snapshot cancelled"));
				}
				check()
			});
			let _ = sender.send(result);
		});
		self.pending.push_back(receiver);
		Ok(())
	}

	fn read(&mut self, connection: &Connection) -> CoreResult<()> {
		let mut buffer = String::new();
		for sql in [INDEX_ROWS, SECTION_ROWS] {
			let mut statement = connection.prepare_cached(sql)?;
			let prefixes: Arc<Vec<String>> = Arc::new(
				statement
					.column_names()
					.iter()
					.enumerate()
					.map(|(position, name)| {
						let mut prefix = String::new();
						if position != 0 {
							prefix.push(',');
						}
						push_string(&mut prefix, name);
						prefix.push(':');
						prefix
					})
					.collect(),
			);
			let mut rows = statement.query([])?;
			let mut batch = Batch::default();
			while let Some(row) = rows.next()? {
				(self.check)()?;
				let mut bytes = 0usize;
				for column in 0..row.as_ref().column_count() {
					if let ValueRef::Text(value) | ValueRef::Blob(value) = row.get_ref(column)? {
						bytes = bytes.saturating_add(value.len());
					}
				}
				if batch.rows != 0
					&& (batch.bytes.len().saturating_add(bytes) > BATCH_BYTES
						|| batch.rows == BATCH_ROWS)
				{
					self.submit(std::mem::take(&mut batch), Arc::clone(&prefixes))?;
				}
				if bytes > BATCH_BYTES {
					// An exceptional legacy row must not multiply the bounded worker
					// working set.
					self.drain()?;
					hash_row(&mut self.snapshot, row, &mut buffer)?;
				} else {
					batch.push(row)?;
				}
			}
			if batch.rows != 0 {
				if self.pending.is_empty() {
					self
						.snapshot
						.update(batch.encode(&prefixes, &self.check)?.as_bytes());
				} else {
					self.submit(batch, prefixes)?;
				}
			}
			self.drain()?;
		}
		Ok(())
	}
}

impl<F> Drop for Pipeline<'_, '_, F> {
	fn drop(&mut self) {
		self.stopped.store(true, Ordering::Relaxed);
	}
}

pub(super) fn compute<F>(connection: &Connection, check: &F) -> CoreResult<Sha256>
where
	F: Fn() -> CoreResult<()> + Clone + Send + 'static,
{
	let Some(pool) = crate::parallel::pool() else {
		let mut snapshot = Sha256::new();
		let mut output = String::new();
		for sql in [INDEX_ROWS, SECTION_ROWS] {
			let mut statement = connection.prepare_cached(sql)?;
			let mut rows = statement.query([])?;
			while let Some(row) = rows.next()? {
				check()?;
				hash_row(&mut snapshot, row, &mut output)?;
			}
		}
		return Ok(snapshot);
	};
	// Include the input arena, cells and escaped output, not just queued bytes.
	let workers = (crate::parallel::memory_budget(128, 64 * 1024 * 1024) / (BATCH_BYTES * 8))
		.max(1)
		.min(pool.current_num_threads());
	pool.in_place_scope(|scope| {
		let mut pipeline = Pipeline {
			scope,
			workers,
			check: check.clone(),
			stopped: Arc::new(AtomicBool::new(false)),
			pending: VecDeque::new(),
			snapshot: Sha256::new(),
		};
		pipeline.read(connection)?;
		Ok(std::mem::take(&mut pipeline.snapshot))
	})
}

#[cfg(test)]
#[path = "snapshot/tests.rs"]
mod tests;
