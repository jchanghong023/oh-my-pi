//! Cancelling a run reaches the in-process background jobs it started, so a
//! run cancelled while it `wait`s on one ends at once and reports why (its
//! result says it timed out; like bash killed by a signal, the shell prints
//! nothing).
#![cfg(unix)]

use std::time::{Duration, Instant};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

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

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_pipeline_waits_for_term_cleanup() {
	let dir = tempfile::tempdir().unwrap();
	let cwd = dir.path().to_str().unwrap().to_owned();
	let command = "sh -c 'trap \"sleep 0.15; echo done > first.done; exit 0\" TERM; echo ready > \
	               first.ready; while :; do sleep 1; done' | sh -c 'trap \"sleep 0.15; echo done > \
	               second.done; exit 0\" TERM; echo ready > second.ready; while :; do sleep 1; \
	               done'";
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
	tokio::time::timeout(Duration::from_secs(10), async {
		while !dir.path().join("first.ready").exists() || !dir.path().join("second.ready").exists() {
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("pipeline stages did not start");
	abort.abort(pi_shell::cancel::AbortReason::User);
	run.await.unwrap().expect("cancelled run");
	assert!(dir.path().join("first.done").exists(), "first stage cleanup must finish before return");
	assert!(
		dir.path().join("second.done").exists(),
		"second stage cleanup must finish before return"
	);
}
