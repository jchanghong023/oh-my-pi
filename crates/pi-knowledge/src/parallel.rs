//! One bounded CPU pool shared by Knowledge query stages.
use std::sync::OnceLock;

use rayon::{ThreadPool, ThreadPoolBuilder};

/// A conservative, on-demand share of currently available memory, capped per
/// owner. Separate database owners may each claim their own share.
pub(crate) fn memory_budget(divisor: usize, cap: usize) -> usize {
	let available = pi_vfs::memory::available_bytes().unwrap_or(256 * 1024 * 1024);
	usize::try_from(available / divisor.max(1) as u128)
		.unwrap_or(usize::MAX)
		.min(cap)
}

pub(crate) fn pool() -> Option<&'static ThreadPool> {
	let workers = std::thread::available_parallelism()
		.map_or(1, |count| count.get())
		.saturating_sub(1);
	if workers < 2 {
		return None;
	}
	static POOL: OnceLock<Option<ThreadPool>> = OnceLock::new();
	POOL
		.get_or_init(|| {
			ThreadPoolBuilder::new()
				.num_threads(workers)
				.thread_name(|id| format!("knowledge-cpu-{id}"))
				.build()
				.ok()
		})
		.as_ref()
}
