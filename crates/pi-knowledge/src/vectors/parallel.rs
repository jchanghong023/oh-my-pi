//! Bounded CPU work over payloads read from one SQLite snapshot.
use std::{
	collections::{BinaryHeap, VecDeque},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
		mpsc::{self, Receiver, RecvTimeoutError},
	},
	time::Duration,
};

#[cfg(test)]
use rayon::ThreadPoolBuilder;
use rayon::{Scope, ThreadPool};

use super::{CoreResult, ExactTopK, KnowledgeError, ScoredRow, StreamScorer, insert_top_k};

const BATCH_BYTES: usize = 512 * 1024;
const BATCH_ROWS: usize = 256;
const MIN_PARALLEL_BYTES: usize = 4 * 1024 * 1024;

pub(super) fn pool_for(
	rows: usize,
	dimensions: usize,
	limit: usize,
) -> Option<&'static ThreadPool> {
	let row_bytes = dimensions.checked_mul(4)?;
	if row_bytes == 0
		|| row_bytes > BATCH_BYTES
		|| limit == 0
		|| rows.saturating_mul(row_bytes) < MIN_PARALLEL_BYTES
	{
		return None;
	}
	crate::parallel::pool()
}

struct Row {
	id:    i64,
	order: usize,
	scale: f64,
}

#[derive(Default)]
struct Batch {
	bytes: Vec<u8>,
	rows:  Vec<Row>,
}

pub(super) struct Scorer<'a, 'scope, F> {
	scope:      &'a Scope<'scope>,
	workers:    usize,
	prototype:  Arc<ExactTopK>,
	dimensions: usize,
	check:      F,
	stopped:    Arc<AtomicBool>,
	batch:      Batch,
	pending:    VecDeque<Receiver<CoreResult<Vec<ScoredRow>>>>,
	best:       BinaryHeap<ScoredRow>,
}

impl<'a, 'scope, F> Scorer<'a, 'scope, F>
where
	F: Fn() -> CoreResult<()> + Clone + Send + 'static,
{
	pub(super) fn new(
		scope: &'a Scope<'scope>,
		workers: usize,
		query: &[f64],
		dimensions: usize,
		limit: usize,
		check: F,
	) -> Self {
		Self {
			scope,
			workers,
			prototype: Arc::new(ExactTopK::new(query, dimensions, limit)),
			dimensions,
			check,
			stopped: Arc::new(AtomicBool::new(false)),
			batch: Batch::default(),
			pending: VecDeque::new(),
			best: BinaryHeap::new(),
		}
	}

	fn merge(&mut self, rows: Vec<ScoredRow>) {
		for row in rows {
			insert_top_k(&mut self.best, self.prototype.limit, row);
		}
	}

	fn receive(&mut self, check: &dyn Fn() -> CoreResult<()>) -> CoreResult<()> {
		let receiver = self.pending.front().expect("pending vector batch");
		let rows = loop {
			check()?;
			match receiver.recv_timeout(Duration::from_millis(10)) {
				Ok(rows) => break rows?,
				Err(RecvTimeoutError::Timeout) => {},
				Err(RecvTimeoutError::Disconnected) => {
					return Err(KnowledgeError::message("Documentation vector scoring worker stopped"));
				},
			}
		};
		self.pending.pop_front();
		self.merge(rows);
		Ok(())
	}

	fn submit(&mut self, check: &dyn Fn() -> CoreResult<()>) -> CoreResult<()> {
		if self.batch.rows.is_empty() {
			return Ok(());
		}
		// Backpressure bounds queued AND executing payloads, not just the
		// channel. Together with the producer there are at most workers+1
		// batches.
		if self.pending.len() >= self.workers {
			self.receive(check)?;
		}
		check()?;
		let batch = std::mem::take(&mut self.batch);
		let prototype = Arc::clone(&self.prototype);
		let stopped = Arc::clone(&self.stopped);
		let worker_check = self.check.clone();
		let dimensions = self.dimensions;
		let (sender, receiver) = mpsc::sync_channel(1);
		self.scope.spawn(move |_| {
			let check = || {
				if stopped.load(Ordering::Relaxed) {
					return Err(KnowledgeError::message("Documentation vector scoring cancelled"));
				}
				worker_check()
			};
			let result = score_batch(&batch, dimensions, &prototype, &check);
			let _ = sender.send(result);
		});
		self.pending.push_back(receiver);
		Ok(())
	}
}

impl<F> StreamScorer for Scorer<'_, '_, F>
where
	F: Fn() -> CoreResult<()> + Clone + Send + 'static,
{
	fn push(
		&mut self,
		id: i64,
		order: usize,
		bytes: &[u8],
		scale: f64,
		check: &dyn Fn() -> CoreResult<()>,
	) -> CoreResult<()> {
		if self.batch.bytes.len() + bytes.len() > BATCH_BYTES || self.batch.rows.len() == BATCH_ROWS {
			self.submit(check)?;
		}
		self.batch.bytes.extend_from_slice(bytes);
		self.batch.rows.push(Row { id, order, scale });
		Ok(())
	}

	fn finish(&mut self, check: &dyn Fn() -> CoreResult<()>) -> CoreResult<Vec<ScoredRow>> {
		if self.pending.is_empty() {
			// A small path restriction need not dispatch even one CPU job.
			let batch = std::mem::take(&mut self.batch);
			let rows = score_batch(&batch, self.dimensions, &self.prototype, check)?;
			self.merge(rows);
		} else {
			self.submit(check)?;
			while !self.pending.is_empty() {
				self.receive(check)?;
			}
		}
		Ok(std::mem::take(&mut self.best).into_sorted_vec())
	}
}

impl<F> Drop for Scorer<'_, '_, F> {
	fn drop(&mut self) {
		// The enclosing in_place_scope joins every job before the caller
		// releases its transaction, even after SQL failure or cancellation.
		self.stopped.store(true, Ordering::Relaxed);
	}
}

fn score_batch(
	batch: &Batch,
	dimensions: usize,
	prototype: &ExactTopK,
	check: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<Vec<ScoredRow>> {
	let mut best = BinaryHeap::new();
	let mut normalized = Vec::new();
	for (row, bytes) in batch
		.rows
		.iter()
		.zip(batch.bytes.chunks_exact(dimensions * 4))
	{
		check()?;
		normalized.clear();
		for (column, chunk) in bytes.as_chunks::<4>().0.iter().enumerate() {
			if column != 0 && column % 1024 == 0 {
				check()?;
			}
			// Same f64 division followed by f32 rounding as the scalar path;
			// keep the dot product's per-row accumulation order unchanged.
			normalized.push((f64::from(f32::from_le_bytes(*chunk)) / row.scale) as f32);
		}
		let score = prototype.score(&normalized, check)?;
		insert_top_k(&mut best, prototype.limit, ScoredRow { id: row.id, order: row.order, score });
	}
	Ok(best.into_sorted_vec())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parallel_top_k_preserves_float_bits_and_source_ties_across_batches() {
		let pool = ThreadPoolBuilder::new().num_threads(2).build().unwrap();
		let limit = 37;
		let worker_used = Arc::new(AtomicBool::new(false));
		let caller = std::thread::current().id();
		// Exercise the row bound and the byte bound, each with a partial
		// final batch. The real embedding width needs only 67 rows here.
		for (dimensions, count) in [(3, BATCH_ROWS * 7 + 17), (4096, 67)] {
			let mut query = vec![0.0; dimensions];
			query[..3].copy_from_slice(&[0.123456789012345, -0.75, 1.25]);
			let mut expected = ExactTopK::new(&query, dimensions, limit);
			let actual = pool.in_place_scope(|scope| {
				let seen = Arc::clone(&worker_used);
				let mut scorer = Scorer::new(scope, 2, &query, dimensions, limit, move || {
					if std::thread::current().id() != caller {
						seen.store(true, Ordering::Relaxed);
					}
					Ok(())
				});
				for order in 0..count {
					let mut raw = vec![0.0f32; dimensions];
					raw[..3].copy_from_slice(&if order % 7 == 0 {
						[3.0, 4.0, -2.0]
					} else {
						[1.0, 2.0, 3.0]
					});
					let mut norm = 0.0;
					for &value in &raw {
						norm += f64::from(value).powi(2);
					}
					let scale = norm.sqrt();
					let normalized: Vec<f32> = raw
						.iter()
						.map(|&value| (f64::from(value) / scale) as f32)
						.collect();
					// IDs deliberately disagree with the stable source order.
					let id = 10_000 - order as i64;
					expected.add(id, order, &normalized, &|| Ok(())).unwrap();
					let bytes: Vec<u8> = raw.into_iter().flat_map(f32::to_le_bytes).collect();
					scorer.push(id, order, &bytes, scale, &|| Ok(())).unwrap();
				}
				scorer.finish(&|| Ok(())).unwrap()
			});
			assert!(worker_used.load(Ordering::Relaxed));
			let expected = expected.finish();
			assert_eq!(actual.len(), expected.len());
			for (actual, expected) in actual.iter().zip(expected) {
				assert_eq!((actual.id, actual.order), (expected.id, expected.order));
				assert_eq!(actual.score.to_bits(), expected.score.to_bits());
			}
		}
	}

	#[test]
	fn worker_failure_keeps_error_metadata_joins_jobs_and_allows_pool_reuse() {
		let pool = ThreadPoolBuilder::new().num_threads(2).build().unwrap();
		let leases = Arc::new(AtomicBool::new(false));
		let caller = std::thread::current().id();
		let error = pool
			.in_place_scope(|scope| {
				let lease = Arc::clone(&leases);
				let mut scorer = Scorer::new(scope, 2, &[1.0], 1, 1, move || {
					lease.store(true, Ordering::Relaxed);
					if std::thread::current().id() != caller {
						return Err(KnowledgeError::named(
							"cancelled in worker",
							"AbortError",
							Some("ABORT"),
						));
					}
					Ok(())
				});
				for order in 0..=(BATCH_ROWS * 2) {
					scorer.push(order as i64, order, &1.0f32.to_le_bytes(), 1.0, &|| Ok(()))?;
				}
				scorer.finish(&|| Ok(()))
			})
			.unwrap_err();
		assert_eq!(error.error_message(), "cancelled in worker");
		assert_eq!(error.diagnostic_error_type(), "AbortError");
		assert_eq!(error.diagnostic_code(), Some("ABORT"));
		assert_eq!(Arc::strong_count(&leases), 1, "no worker may outlive its query");
		let rows = pool.in_place_scope(|scope| {
			let mut scorer = Scorer::new(scope, 2, &[1.0], 1, 1, || Ok(()));
			for order in 0..=BATCH_ROWS {
				scorer
					.push(order as i64, order, &1.0f32.to_le_bytes(), 1.0, &|| Ok(()))
					.unwrap();
			}
			scorer.finish(&|| Ok(())).unwrap()
		});
		assert_eq!(rows.iter().map(|row| row.id).collect::<Vec<_>>(), vec![0]);
	}
}
