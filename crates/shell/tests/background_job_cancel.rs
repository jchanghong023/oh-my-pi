//! Cancelling a run reaches the in-process background jobs it started, so a
//! run cancelled while it `wait`s on one ends at once and reports why (its
//! result says it timed out; like bash killed by a signal, the shell prints
//! nothing).
#![cfg(unix)]

use std::time::{Duration, Instant};

use omp_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Each `&` job had a token of its own that the run's token did not reach, so
/// the cancelled run sat in `wait` until the host's 2 s grace aborted it.
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_run_stops_waiting_on_its_background_job() {
	for script in ["sleep 20 & wait; echo after", "{ sleep 20; } & wait %1; echo after"] {
		let (tx, rx) = flume::unbounded::<String>();
		let started = Instant::now();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: script.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(300)),
			)
			.await
			.expect("run");
		let elapsed = started.elapsed();
		let output: String = rx.drain().collect();

		assert!(elapsed < Duration::from_millis(1500), "`{script}` took {elapsed:?}");
		assert!(!output.contains("after"), "`{script}` kept running: {output:?}");
		assert_eq!((result.exit_code, result.timed_out), (None, true), "`{script}`");
	}
}

/// Cancellation reaps a stopped member and lets both running members finish
/// TERM cleanup, including one that must wait for its own child.
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_mixed_stopped_pipeline_reaps_members_and_cleanup_descendant() {
	const PID_FILES: [&str; 4] = ["stopped.pid", "running.pid", "peer.pid", "child.pid"];
	struct Cleanup<'a>(&'a std::path::Path, bool);
	impl Drop for Cleanup<'_> {
		fn drop(&mut self) {
			if !self.1 {
				return;
			}
			for name in PID_FILES {
				if let Ok(text) = std::fs::read_to_string(self.0.join(name))
					&& let Ok(pid) = text.trim().parse::<i32>()
					&& pid > 1
				{
					// SAFETY: pidfiles belong to the external processes this
					// fixture starts, never the test host or its process group.
					unsafe { libc::kill(pid, libc::SIGKILL) };
				}
			}
		}
	}

	let dir = tempfile::tempdir().unwrap();
	let mut cleanup = Cleanup(dir.path(), true);
	let cwd = dir.path().to_str().unwrap().to_owned();
	let command = "sh -c 'trap \"sleep 0.15; echo done > peer.done; exit 0\" TERM; echo $$ > \
	               peer.pid; echo ready > peer.ready; while :; do :; done' | sh -c 'echo $$ > \
	               stopped.pid; kill -STOP $$; exit 0' | sh -c 'echo $$ > running.pid; sleep 30 & \
	               child=$!; echo $child > child.pid; trap \"kill $child 2>/dev/null; wait $child; \
	               sleep 0.15; echo done > running.done; exit 0\" TERM; echo ready > \
	               running.ready; wait $child'";
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let run = tokio::spawn(async move {
		Shell::new(None)
			.run(
				ShellRunOptions { command: command.to_owned(), cwd: Some(cwd), ..Default::default() },
				None,
				cancel,
			)
			.await
	});
	let pids = tokio::time::timeout(Duration::from_secs(10), async {
		loop {
			let pids: Option<Vec<i32>> = PID_FILES
				.into_iter()
				.map(|name| {
					std::fs::read_to_string(dir.path().join(name))
						.ok()?
						.trim()
						.parse()
						.ok()
				})
				.collect();
			if let Some(pids) = pids
				&& dir.path().join("running.ready").exists()
				&& dir.path().join("peer.ready").exists()
				&& omp_builtins::ProcInfo::all()
					.into_iter()
					.any(|process| process.pid() == pids[0] && process.state() == 'T')
			{
				break pids;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("one stage must stop and both running stages must install their TERM handlers");
	assert!(
		pids
			.iter()
			.all(|&pid| pid > 1 && pid != std::process::id() as i32)
	);
	abort.abort(omp_shell::cancel::AbortReason::User);
	let result = tokio::time::timeout(Duration::from_secs(10), run)
		.await
		.expect("cancelled mixed pipeline must finish")
		.unwrap()
		.expect("cancelled shell run");
	assert!(result.cancelled, "run must observe the explicit cancellation");
	for marker in ["peer.done", "running.done"] {
		assert_eq!(
			std::fs::read(dir.path().join(marker)).expect("stage TERM cleanup"),
			b"done\n",
			"{marker} cleanup must finish before cancellation returns"
		);
	}
	for pid in pids {
		// SAFETY: signal zero only probes the fixture's positive PID; even a
		// zombie still exists and must fail this fully-reaped assertion.
		let exists = unsafe { libc::kill(pid, 0) };
		let error = std::io::Error::last_os_error();
		assert_eq!(exists, -1, "owned process {pid} survived cancellation");
		assert_eq!(error.raw_os_error(), Some(libc::ESRCH), "process {pid}: {error}");
	}
	cleanup.1 = false;
}
