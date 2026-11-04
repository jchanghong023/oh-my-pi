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
	let result = run.await.unwrap().expect("cancelled run");
	assert!(result.cancelled, "pipeline run must report the requested cancellation");
	assert_eq!(
		std::fs::read(dir.path().join("first.done")).expect("first stage TERM cleanup"),
		b"done\n",
		"first stage cleanup must finish before return"
	);
	assert_eq!(
		std::fs::read(dir.path().join("second.done")).expect("second stage TERM cleanup"),
		b"done\n",
		"second stage cleanup must finish before return"
	);
}

/// A stopped external and a running external share a cancellation wait:
/// the stopped member must be reaped while the running member finishes TERM
/// cleanup, including waiting for its own child.
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_mixed_stopped_pipeline_reaps_members_and_cleanup_descendant() {
	struct Cleanup<'a>(&'a std::path::Path, bool);
	impl Drop for Cleanup<'_> {
		fn drop(&mut self) {
			if !self.1 {
				return;
			}
			for name in ["stopped.pid", "running.pid", "child.pid"] {
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
	let command = "sh -c 'echo $$ > stopped.pid; kill -STOP $$; exit 0' | sh -c 'echo $$ > \
	               running.pid; sleep 30 & child=$!; echo $child > child.pid; trap \"kill $child \
	               2>/dev/null; wait $child; sleep 0.15; echo reaped > running.done; exit 0\" \
	               TERM; echo ready > running.ready; wait $child'";
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
			let pids: Option<Vec<i32>> = ["stopped.pid", "running.pid", "child.pid"]
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
				&& pi_builtins::ProcInfo::all()
					.into_iter()
					.any(|process| process.pid() == pids[0] && process.state() == 'T')
			{
				break pids;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("one stage must actually stop while the other installs its TERM handler");
	assert!(
		pids
			.iter()
			.all(|&pid| pid > 1 && pid != std::process::id() as i32)
	);
	abort.abort(pi_shell::cancel::AbortReason::User);
	let result = tokio::time::timeout(Duration::from_secs(10), run)
		.await
		.expect("cancelled mixed pipeline must finish")
		.unwrap()
		.expect("cancelled shell run");
	assert!(result.cancelled, "run must observe the explicit cancellation");
	assert_eq!(
		std::fs::read(dir.path().join("running.done")).expect("running stage TERM cleanup"),
		b"reaped\n",
		"running member must finish cleanup before cancellation returns"
	);
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
