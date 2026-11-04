//! One bounded CPU pool shared by Knowledge query stages.
use std::sync::OnceLock;

use rayon::{ThreadPool, ThreadPoolBuilder};

pub(crate) fn pool() -> Option<&'static ThreadPool> {
	let workers = std::thread::available_parallelism()
		.map_or(1, |count| count.get())
		.min(4);
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
