//! The deliberately small git-CLI escape hatch.
//!
//! Three categories are allowed to spawn `git`, per the hybrid policy:
//! - **Credential-bound network transfers** — clone/fetch/push must reuse the
//!   user's ssh config and credential helpers, which are subprocess-based by
//!   design; no library reaches auth parity (and gitoxide has no send-pack).
//! - **Reftable ref access** — no in-process reftable implementation exists.
//! - **Whole-worktree status/untracked walks** — a subprocess contains gitoxide
//!   worker-thread spawn failures under host resource exhaustion.
//!
//! The runner ports the hardened subprocess contract of the TS wrapper:
//! non-interactive env (`GIT_TERMINAL_PROMPT=0`, askpass rejection, `LC_ALL`
//! handling), `--no-optional-locks` for reads, fsmonitor/untracked-cache
//! disabled for writes, ambient `GIT_DIR`-family vars stripped, bounded output
//! capture, bounded post-exit pipe draining, and deadline + SIGTERM→SIGKILL
//! termination via tokio.

#[cfg(unix)]
use std::os::fd::AsRawFd as AsRawPipe;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle as AsRawPipe;
use std::{
	ffi::OsStr,
	path::Path,
	process::Stdio,
	sync::{Arc, Mutex},
	time::Duration,
};

use gix::bstr::ByteSlice;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
#[cfg(windows)]
use windows_process::ProcessTree;

use super::GitRepo;
use crate::{
	error::{Error, Result},
	types::{CloneOptions, PushOptions, RemoteDefaultBranch},
};
#[cfg(not(windows))]
type ProcessTree = ();

/// Default deadline for local git plumbing via the fallback runner.
pub const COMMAND_TIMEOUT: Duration = Duration::from_mins(5);
/// Default deadline for network transfers (`clone`/`fetch`/`push`); large-repo
/// transfers legitimately outlive [`COMMAND_TIMEOUT`].
pub const NETWORK_TIMEOUT: Duration = Duration::from_mins(30);
/// Deadline for synchronous plumbing on render paths (reftable HEAD reads):
/// a stalled invocation degrades instead of freezing the UI.
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum captured bytes per stream before truncation.
pub const OUTPUT_LIMIT_BYTES: usize = 8 * 1024 * 1024;

const TERMINATE_GRACE: Duration = Duration::from_secs(5);
/// Descendants can retain the pipes after git exits; do not wait for their EOF.
const DRAIN_GRACE: Duration = Duration::from_secs(1);
/// Idle synchronous readers must notice output collection without waiting for
/// EOF.
const READER_POLL_INTERVAL: Duration = Duration::from_millis(50);
const TRUNCATION_MARKER: &str = "\n[git subprocess output truncated at the capture limit]\n";

/// Publish each chunk so a bounded drain can return the bytes already captured.
#[derive(Default)]
struct OutputCapture {
	output: CapturedBytes,
	closed: bool,
}

impl OutputCapture {
	/// Stop a reader once its caller has collected the output.
	fn append(&mut self, bytes: &[u8], limit: usize) -> bool {
		if self.closed {
			return false;
		}
		self.output.append(bytes, limit);
		true
	}

	fn take_bytes(&mut self) -> CapturedBytes {
		self.closed = true;
		std::mem::take(&mut self.output)
	}
}

#[derive(Default)]
struct CapturedBytes {
	bytes:     Vec<u8>,
	truncated: bool,
}

impl CapturedBytes {
	fn append(&mut self, bytes: &[u8], limit: usize) {
		if !self.truncated {
			let keep = bytes.len().min(limit - self.bytes.len());
			self.bytes.extend_from_slice(&bytes[..keep]);
			self.truncated = keep < bytes.len();
		}
	}

	fn into_text(self) -> String {
		let mut text = String::from_utf8_lossy_owned(self.bytes);
		if self.truncated {
			text.push_str(TRUNCATION_MARKER);
		}
		text
	}
}

/// Captured result of a completed git invocation.
#[derive(Debug, Clone)]
pub(crate) struct CliOutput {
	/// Process exit code (`124` designates a deadline kill).
	pub exit_code: i32,
	/// Captured stdout, possibly truncated.
	pub stdout:    String,
	/// Captured stderr, possibly truncated.
	pub stderr:    String,
}

impl CliOutput {
	/// Convert a non-zero exit into [`Error::Cli`].
	pub fn into_checked(self, args: &[String]) -> Result<Self> {
		if self.exit_code == 0 {
			return Ok(self);
		}
		Err(Error::Cli {
			command:   format!("git {}", args.join(" ")),
			exit_code: self.exit_code,
			stdout:    self.stdout,
			stderr:    self.stderr,
		})
	}
}

/// Options for one fallback invocation.
#[derive(Debug, Default)]
pub(crate) struct RunOptions {
	/// Prefix `--no-optional-locks` instead of pinning fsmonitor/untracked-cache
	/// off.
	pub read_only: bool,
	/// Deadline; [`COMMAND_TIMEOUT`] when unset.
	pub timeout:   Option<Duration>,
	/// Bytes piped to stdin (commit messages, `update-ref --stdin` scripts).
	pub stdin:     Option<Vec<u8>>,
	/// Cooperative cancellation: the child is terminated when triggered.
	pub cancel:    Option<CancellationToken>,
}

/// Build the hardened argv prefix.
///
/// Reads get `--no-optional-locks`, which already keeps them from rewriting
/// the index, so they keep the repository's fsmonitor and untracked cache: a
/// whole-worktree status on a large repo polled by every open session is far
/// cheaper with both. Writes pin both off so a transient subprocess never
/// mutates fsmonitor/untracked-cache state in the index.
fn hardened_args(args: &[String], read_only: bool) -> Vec<String> {
	let mut out = Vec::with_capacity(args.len() + 4);
	if read_only {
		if !args.iter().any(|arg| arg == "--no-optional-locks") {
			out.push("--no-optional-locks".to_owned());
		}
	} else {
		for pin in ["core.fsmonitor=false", "core.untrackedCache=false"] {
			out.push("-c".to_owned());
			out.push(pin.to_owned());
		}
	}
	out.extend(args.iter().cloned());
	out
}

/// Environment sink for the two command builders. `std::process::Command` and
/// `tokio::process::Command` share no trait, and duplicating the contract per
/// builder is how the synchronous path silently lost the `LC_ALL` removal that
/// [`is_dubious_ownership`] depends on.
trait EnvSink {
	fn set(&mut self, key: &str, value: &str);
	fn unset(&mut self, key: &str);
}

impl EnvSink for std::process::Command {
	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

impl EnvSink for tokio::process::Command {
	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

/// Apply the non-interactive environment contract to a command builder:
/// prompts rejected, editors disabled, ambient repo-location and pathspec
/// overrides stripped, `LC_MESSAGES=C` for parseable errors while preserving a
/// UTF-8 character locale. `LC_ALL` must go: it outranks `LC_MESSAGES`, so
/// leaving it inherited would hand back localized diagnostics.
///
/// The `*_PATHSPECS` variables are global pathspec modes, so an inherited
/// `GIT_LITERAL_PATHSPECS=1` would make the `:(literal)` magic this crate
/// builds match a filename containing that prefix (i.e. nothing), and
/// `GIT_ICASE_PATHSPECS=1` would match case variants the caller did not ask
/// for. Explicit magic is only explicit once they are gone.
fn apply_env(cmd: &mut impl EnvSink) {
	for stripped in [
		"GIT_DIR",
		"GIT_COMMON_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_LITERAL_PATHSPECS",
		"GIT_GLOB_PATHSPECS",
		"GIT_NOGLOB_PATHSPECS",
		"GIT_ICASE_PATHSPECS",
	] {
		cmd.unset(stripped);
	}
	if let Some(lc_all) = std::env::var_os("LC_ALL") {
		let lc_all = lc_all.to_string_lossy().into_owned();
		if is_utf8_locale(&lc_all) {
			cmd.set("LC_CTYPE", &lc_all);
		}
	}
	cmd.unset("LC_ALL");
	cmd.set("LC_MESSAGES", "C");
	cmd.set("GIT_OPTIONAL_LOCKS", "0");
	cmd.set("GIT_ASKPASS", "true");
	cmd.set("GIT_EDITOR", "true");
	cmd.set("GIT_TERMINAL_PROMPT", "0");
	cmd.set("SSH_ASKPASS", "false");
}

/// Loose match for a UTF-8 character locale (`en_US.UTF-8`, `C.utf8`, …).
fn is_utf8_locale(value: &str) -> bool {
	let lower = value.to_ascii_lowercase();
	["utf-8", "utf8"].iter().any(|needle| {
		lower
			.split(['.', '_', '-', '@'])
			.any(|part| part == *needle)
			|| lower.ends_with(needle)
			|| lower.contains(&format!(".{needle}"))
	})
}

/// Start `cmd` in a new session with no controlling terminal, the embedded
/// shell's policy for externals. Without it git and everything it starts (ssh,
/// credential helpers, signers, hooks) share the host's terminal: any of them
/// can read the user's keystrokes and the terminal's protocol replies out from
/// under the TUI, or prompt on it. Detached, a `/dev/tty` open fails
/// (`ENXIO`), so a prompt errors out instead.
#[cfg(unix)]
pub(crate) fn detach_from_terminal(cmd: &mut std::process::Command) {
	std::os::unix::process::CommandExt::setsid(cmd, true);
}

/// Run `git` asynchronously with bounded capture and a deadline.
/// Non-zero exits are returned in [`CliOutput`], not raised.
pub(crate) async fn run(cwd: &Path, args: &[String], options: &RunOptions) -> Result<CliOutput> {
	Ok(run_raw(cwd, args, options).await?.into_text())
}

async fn run_raw(cwd: &Path, args: &[String], options: &RunOptions) -> Result<CapturedOutput> {
	let argv = hardened_args(args, options.read_only);
	let mut cmd = tokio::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(if options.stdin.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		})
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	apply_env(&mut cmd);
	#[cfg(unix)]
	detach_from_terminal(cmd.as_std_mut());
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;
	#[cfg(windows)]
	let process_tree = match ProcessTree::new(child.id().expect("newly spawned git has a pid")) {
		Ok(tree) => tree,
		Err(err) => {
			let _ = child.kill().await;
			let _ = child.wait().await;
			return Err(Error::Io(err));
		},
	};
	#[cfg(not(windows))]
	let process_tree = ();

	if let Some(stdin) = &options.stdin
		&& let Some(mut pipe) = child.stdin.take()
	{
		use tokio::io::AsyncWriteExt;
		// A child that exits early (e.g. usage error) closes the pipe;
		// that is its answer, not ours to fail on.
		let _ = pipe.write_all(stdin).await;
		let _ = pipe.shutdown().await;
	}

	let stdout = child.stdout.take().expect("stdout piped");
	let stderr = child.stderr.take().expect("stderr piped");
	let stdout_capture = Arc::new(Mutex::new(OutputCapture::default()));
	let stderr_capture = Arc::new(Mutex::new(OutputCapture::default()));
	let mut stdout_task = tokio::spawn(read_capped(stdout, Arc::clone(&stdout_capture)));
	let mut stderr_task = tokio::spawn(read_capped(stderr, Arc::clone(&stderr_capture)));

	let timeout = options.timeout.unwrap_or(COMMAND_TIMEOUT);
	let cancel = options.cancel.clone().unwrap_or_default();
	let status = tokio::select! {
		// Prefer Git's actual result when exit and cancellation are both ready.
		biased;
		status = tokio::time::timeout(timeout, child.wait()) => {
			status.map_err(|_| Error::CliTimeout { command: format!("git {}", argv.join(" ")) })
		},
		() = cancel.cancelled() => Err(Error::Canceled),
	};
	let exit = match status {
		Ok(status) => status?,
		Err(reason) => {
			terminate(&mut child, &process_tree).await;
			stdout_task.abort();
			stderr_task.abort();
			let _ = tokio::join!(stdout_task, stderr_task);
			return Err(reason);
		},
	};

	// Both readers run concurrently and share one post-exit deadline, even if
	// descendants retain both pipes. A drain timeout keeps the captured bytes.
	let drained = tokio::time::timeout(DRAIN_GRACE, async {
		(&mut stdout_task)
			.await
			.map_err(|err| Error::backend("git run", err))??;
		(&mut stderr_task)
			.await
			.map_err(|err| Error::backend("git run", err))??;
		Ok::<_, Error>(())
	})
	.await;
	stdout_task.abort();
	stderr_task.abort();
	let stdout_eof = drained.is_ok();
	if let Ok(result) = drained {
		result?;
	}
	let stdout = stdout_capture.lock().unwrap().take_bytes();
	let stderr = stderr_capture.lock().unwrap().take_bytes();
	Ok(CapturedOutput { exit_code: exit.code().unwrap_or(-1), stdout, stderr, stdout_eof })
}

/// Run `git` asynchronously and map a non-zero exit to [`Error::Cli`].
pub(crate) async fn run_checked(
	cwd: &Path,
	args: &[String],
	options: &RunOptions,
) -> Result<CliOutput> {
	run(cwd, args, options).await?.into_checked(args)
}

/// Whether `err` means the git binary could not be launched at all (missing
/// binary or deleted cwd), as opposed to git running and failing. Callers with
/// an in-process fallback (e.g. porcelain status) branch on this.
pub(crate) fn is_spawn_failure(err: &Error) -> bool {
	matches!(err, Error::Backend { context: "git spawn", .. })
}

/// Whether captured output hit [`OUTPUT_LIMIT_BYTES`] and therefore lost
/// bytes. Callers whose output is a value rather than a diagnostic (path
/// lists) must retry in-process or fail, never return the short result.
pub(crate) fn is_truncated(text: &str) -> bool {
	text.ends_with(TRUNCATION_MARKER)
}

/// Whether git refused the checkout under its `safe.directory` ownership
/// check (`fatal: detected dubious ownership`, exit 128), which happens
/// whenever the process user differs from the checkout owner — a
/// host-mounted repository inside a container is the common case.
///
/// `open::open_options` opens user-chosen checkouts with `Trust::Full` on
/// purpose, so the in-process walk has no such objection: a caller with a
/// gitoxide fallback must take it rather than surface an error the
/// library-backed path would never have produced.
///
/// [`apply_env`] pins `LC_MESSAGES=C` and drops the `LC_ALL` that would
/// outrank it, so the English wording is what git emits. `safe.directory` is
/// matched as well: it is a config key, so it survives translation even if a
/// host manages to localize the diagnostic anyway.
pub(crate) fn is_dubious_ownership(err: &Error) -> bool {
	matches!(
		err,
		Error::Cli { exit_code: 128, stderr, .. }
			if stderr.contains("dubious ownership") || stderr.contains("safe.directory")
	)
}

/// Whether `err` describes a CLI that could not do the work at all while the
/// in-process gitoxide path still can.
pub(crate) fn prefers_in_process(err: &Error) -> bool {
	is_spawn_failure(err) || is_dubious_ownership(err)
}

/// Synchronous bounded runner with a caller-chosen deadline; render paths pass
/// [`SYNC_TIMEOUT`] so a stalled git cannot freeze the UI. Stdout/stderr are
/// drained concurrently with capped retention, so output larger than the OS
/// pipe buffer can never stall the child into a spurious timeout.
pub(crate) fn run_sync(cwd: &Path, args: &[String], timeout: Duration) -> Result<CliOutput> {
	run_sync_capped(cwd, args, timeout, OUTPUT_LIMIT_BYTES)
}

/// Stdin and environment for a [`run_sync_write`] invocation.
pub(crate) struct SyncWrite<'a> {
	/// Bytes piped to the child's stdin, then closed.
	pub stdin: &'a [u8],
	/// Variables set after [`apply_env`], so they win over its contract.
	pub env:   &'a [(&'a str, &'a OsStr)],
}

/// Synchronous runner for local write plumbing (fsmonitor/untracked-cache
/// pinned off) that feeds `input.stdin` and sets `input.env` on the child.
pub(crate) fn run_sync_write(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	input: &SyncWrite<'_>,
) -> Result<CliOutput> {
	Ok(run_sync_impl(cwd, args, timeout, OUTPUT_LIMIT_BYTES, Some(input), CapturedBytes::append)?
		.into_text())
}

/// [`run_sync`] with an explicit retention cap. The cap is a parameter rather
/// than a constant read inside the reader threads so a test can exercise the
/// truncation contract on one call without lowering the limit for every other
/// invocation in the process.
pub(crate) fn run_sync_capped(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	limit: usize,
) -> Result<CliOutput> {
	Ok(run_sync_impl(cwd, args, timeout, limit, None, CapturedBytes::append)?.into_text())
}

/// Fold stdout chunks without retaining the stream. Only return the accumulator
/// if Git succeeds and the reader observes EOF.
pub(crate) fn run_sync_fold_stdout<T: Default + Send + 'static>(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	mut append: impl FnMut(&mut T, &[u8]) + Send + 'static,
) -> Result<T> {
	let out =
		run_sync_impl(cwd, args, timeout, OUTPUT_LIMIT_BYTES, None, move |state, bytes, _| {
			append(state, bytes);
		})?;
	if out.exit_code != 0 {
		return Err(Error::Cli {
			command:   format!("git {}", args.join(" ")),
			exit_code: out.exit_code,
			stdout:    String::new(),
			stderr:    out.stderr.into_text(),
		});
	}
	if !out.stdout_eof {
		return Err(Error::backend("git status", "incomplete stdout stream"));
	}
	Ok(out.stdout)
}

struct CapturedOutput<T = CapturedBytes> {
	exit_code:  i32,
	stdout:     T,
	stderr:     CapturedBytes,
	stdout_eof: bool,
}

impl CapturedOutput {
	fn into_text(self) -> CliOutput {
		CliOutput {
			exit_code: self.exit_code,
			stdout:    self.stdout.into_text(),
			stderr:    self.stderr.into_text(),
		}
	}
}

/// Shared synchronous runner: read-only when `write` is `None`.
fn run_sync_impl<T: Default + Send + 'static>(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	limit: usize,
	write: Option<&SyncWrite<'_>>,
	mut append: impl FnMut(&mut T, &[u8], usize) + Send + 'static,
) -> Result<CapturedOutput<T>> {
	let argv = hardened_args(args, write.is_none());
	let mut cmd = std::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(if write.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		})
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	apply_env(&mut cmd);
	#[cfg(unix)]
	detach_from_terminal(&mut cmd);
	if let Some(write) = write {
		for (key, value) in write.env {
			cmd.env(key, value);
		}
	}
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;
	let stdout = spawn_sync_reader_with("git-cli-stdout", child.stdout.take(), move |out, bytes| {
		append(out, bytes, limit);
	});
	let stderr = spawn_sync_reader("git-cli-stderr", child.stderr.take(), limit);
	std::thread::scope(|scope| {
		// The writer runs beside the deadline loop: a child that stops reading
		// must still be killed on time, and the kill closes the pipe, which
		// unblocks the writer before the scope joins it.
		if let Some(write) = write
			&& let Some(mut pipe) = child.stdin.take()
		{
			let writer = std::thread::Builder::new()
				.name("git-cli-stdin".into())
				.spawn_scoped(scope, move || {
					use std::io::Write;
					// A child that exits early closes the pipe; its exit status
					// is the answer, not this write error.
					let _ = pipe.write_all(write.stdin);
				});
			if let Err(err) = writer {
				// The dropped pipe reads as an empty input; the child must not
				// act on it.
				let _ = child.kill();
				let _ = child.wait();
				return Err(Error::backend("git spawn stdin writer", err));
			}
		}
		wait_sync(&argv, child, stdout, stderr, timeout)
	})
}

/// Deadline loop and output collection for [`run_sync_impl`].
fn wait_sync<T: Default>(
	argv: &[String],
	mut child: std::process::Child,
	stdout: Option<SyncReader<T>>,
	stderr: Option<SyncReader<CapturedBytes>>,
	timeout: Duration,
) -> Result<CapturedOutput<T>> {
	let deadline = std::time::Instant::now() + timeout;
	let status = loop {
		match child.try_wait()? {
			Some(status) => break Some(status),
			None if std::time::Instant::now() >= deadline => {
				let _ = child.kill();
				let _ = child.wait();
				break None;
			},
			None => std::thread::sleep(Duration::from_millis(10)),
		}
	};
	// Git exiting does not imply EOF: descendants can retain either pipe. Give
	// both readers one bounded grace period, then collect their current buffers.
	// Collection closes each capture; polling readers notice it even without
	// EOF.
	let reading = |thread: &std::thread::JoinHandle<bool>| !thread.is_finished();
	let drain_deadline = std::time::Instant::now() + DRAIN_GRACE;
	while (stdout
		.as_ref()
		.is_some_and(|reader| reading(&reader.thread))
		|| stderr
			.as_ref()
			.is_some_and(|reader| reading(&reader.thread)))
		&& std::time::Instant::now() < drain_deadline
	{
		std::thread::sleep(Duration::from_millis(10));
	}
	let (stdout, stdout_eof) = stdout.map_or_default(SyncReader::collect);
	let (stderr, _) = stderr.map_or_default(SyncReader::collect);
	let Some(status) = status else {
		return Err(Error::CliTimeout { command: format!("git {}", argv.join(" ")) });
	};
	Ok(CapturedOutput { exit_code: status.code().unwrap_or(-1), stdout, stderr, stdout_eof })
}

struct SyncReader<T> {
	thread: std::thread::JoinHandle<bool>,
	output: Arc<Mutex<Option<T>>>,
}

impl<T: Default> SyncReader<T> {
	fn collect(self) -> (T, bool) {
		let eof = self.thread.is_finished() && self.thread.join().unwrap_or(false);
		let output = self.output.lock().unwrap().take().unwrap_or_default();
		(output, eof)
	}
}

/// Drain a child stream on a helper thread, mirroring [`read_capped`].
///
/// `None` when the stream is absent or the thread cannot be spawned (e.g.
/// under the same memory pressure that motivates the CLI path); dropping the
/// stream then closes the pipe, so a chatty child fails with EPIPE and
/// surfaces as a non-zero exit instead of a hang.
fn spawn_sync_reader(
	name: &'static str,
	stream: Option<impl std::io::Read + AsRawPipe + Send + 'static>,
	limit: usize,
) -> Option<SyncReader<CapturedBytes>> {
	spawn_sync_reader_with(name, stream, move |out: &mut CapturedBytes, bytes| {
		out.append(bytes, limit);
	})
}

fn spawn_sync_reader_with<T: Default + Send + 'static>(
	name: &'static str,
	stream: Option<impl std::io::Read + AsRawPipe + Send + 'static>,
	append: impl FnMut(&mut T, &[u8]) + Send + 'static,
) -> Option<SyncReader<T>> {
	let stream = stream?;
	let output = Arc::new(Mutex::new(Some(T::default())));
	let capture = Arc::clone(&output);
	let thread = std::thread::Builder::new()
		.name(name.into())
		.spawn(move || read_sync(stream, &capture, append))
		.ok()?;
	Some(SyncReader { thread, output })
}

/// Drain without blocking the child, checking for collection between bounded
/// waits even when the pipe stays open.
fn read_sync<T>(
	mut stream: impl std::io::Read + AsRawPipe,
	output: &Mutex<Option<T>>,
	mut append: impl FnMut(&mut T, &[u8]),
) -> bool {
	let mut buf = [0u8; 8 * 1024];
	while output.lock().unwrap().is_some() {
		match sync_pipe_ready(&stream) {
			Ok(true) => {},
			Ok(false) => continue,
			Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
			#[cfg(windows)]
			Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => return true,
			Err(_) => break,
		}
		let n = match stream.read(&mut buf) {
			Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
			Ok(0) => return true,
			Err(_) => break,
			Ok(n) => n,
		};
		let mut output = output.lock().unwrap();
		let Some(state) = output.as_mut() else { break };
		append(state, &buf[..n]);
	}
	false
}

/// Only this thread reads the pipe, so readable bytes cannot be consumed
/// between the readiness check and `read`.
#[cfg(unix)]
fn sync_pipe_ready(stream: &impl AsRawPipe) -> std::io::Result<bool> {
	let mut fd = libc::pollfd { fd: stream.as_raw_fd(), events: libc::POLLIN, revents: 0 };
	// SAFETY: fd points to one initialized pollfd; the stream owns its
	// descriptor throughout this bounded wait.
	let ready =
		unsafe { libc::poll(&raw mut fd, 1, READER_POLL_INTERVAL.as_millis() as libc::c_int) };
	if ready < 0 {
		Err(std::io::Error::last_os_error())
	} else {
		Ok(ready > 0)
	}
}

#[cfg(windows)]
fn sync_pipe_ready(stream: &impl AsRawPipe) -> std::io::Result<bool> {
	let mut available = 0;
	// SAFETY: the stream owns this pipe handle. A zero-size peek writes only
	// the byte count, without consuming data or waiting for a writer.
	let ok = unsafe {
		windows_sys::Win32::System::Pipes::PeekNamedPipe(
			stream.as_raw_handle(),
			std::ptr::null_mut(),
			0,
			std::ptr::null_mut(),
			&raw mut available,
			std::ptr::null_mut(),
		)
	};
	if ok == 0 {
		return Err(std::io::Error::last_os_error());
	}
	if available == 0 {
		std::thread::sleep(READER_POLL_INTERVAL);
	}
	Ok(available > 0)
}

fn spawn_error(cwd: &Path, err: std::io::Error) -> Error {
	if err.kind() == std::io::ErrorKind::NotFound {
		// A deleted cwd also surfaces as spawn ENOENT; only blame the binary
		// when the working directory actually exists.
		let message = if cwd.exists() {
			"git is not installed.".to_owned()
		} else {
			format!("working directory does not exist: {}", cwd.display())
		};
		return Error::backend("git spawn", message);
	}
	Error::Io(err)
}

/// Read a stream to completion, capping retention at [`OUTPUT_LIMIT_BYTES`]
/// while continuing to drain so the child never blocks on a full pipe.
async fn read_capped(
	mut stream: impl tokio::io::AsyncRead + Unpin,
	output: Arc<Mutex<OutputCapture>>,
) -> Result<()> {
	let mut buf = [0u8; 8 * 1024];
	loop {
		let n = stream.read(&mut buf).await.map_err(Error::Io)?;
		if n == 0 {
			break;
		}
		if !output.lock().unwrap().append(&buf[..n], OUTPUT_LIMIT_BYTES) {
			break;
		}
	}
	Ok(())
}

/// Settle this invocation's process tree before returning cancellation or
/// timeout. Windows pins every discovered descendant: killing Git alone
/// leaves upload-pack/SSH handles alive. The caller also joins the readers.
async fn terminate(child: &mut tokio::process::Child, process_tree: &ProcessTree) {
	#[cfg(windows)]
	process_tree.terminate().await;
	#[cfg(not(windows))]
	let () = *process_tree;
	#[cfg(unix)]
	if let Some(pid) = child.id() {
		// SAFETY: plain kill(2) on a pid we own; no memory is touched.
		unsafe {
			libc::kill(pid as i32, libc::SIGTERM);
		}
		if tokio::time::timeout(TERMINATE_GRACE, child.wait())
			.await
			.is_ok()
		{
			return;
		}
	}
	let _ = child.kill().await;
	let _ = tokio::time::timeout(TERMINATE_GRACE, child.wait()).await;
}

/// Windows process ownership built on the same primitives as
/// `omp_shell::proctree`. Depending on omp-shell here would create a Cargo
/// cycle.
#[cfg(windows)]
mod windows_process {
	use std::{
		collections::{HashMap, HashSet},
		io,
		os::windows::io::OwnedHandle,
		sync::Arc,
		time::Duration,
	};

	use omp_builtins::proc_sys as sys;

	struct Process {
		pid:     u32,
		created: u64,
		handle:  Arc<OwnedHandle>,
	}

	impl Process {
		fn open(pid: u32) -> io::Result<Self> {
			let handle = sys::open_process(
				pid,
				sys::PROCESS_TERMINATE | sys::PROCESS_QUERY_LIMITED_INFORMATION | sys::SYNCHRONIZE,
			)
			.ok_or_else(io::Error::last_os_error)?;
			let created = sys::process_times(&handle)
				.ok_or_else(io::Error::last_os_error)?
				.0;
			Ok(Self { pid, created, handle: Arc::new(handle) })
		}

		async fn exited(&self) {
			if sys::exited(Arc::clone(&self.handle)).await.is_err() {
				// A failed wait registration must not release the operation while
				// an owned process still holds the working directory or its pipes.
				while !sys::has_exited(&self.handle) {
					tokio::time::sleep(Duration::from_millis(10)).await;
				}
			}
		}
	}

	pub(super) struct ProcessTree {
		root: Process,
	}

	impl ProcessTree {
		pub(super) fn new(pid: u32) -> io::Result<Self> {
			Ok(Self { root: Process::open(pid)? })
		}

		pub(super) async fn terminate(&self) {
			let mut descendants: Vec<Process> = Vec::new();
			let mut seen = HashSet::from([self.root.pid, std::process::id()]);
			let mut terminated = false;
			loop {
				// Retain all pinned parents across waves, even after they exit:
				// Windows preserves a descendant's original parent id. This catches
				// children spawned during the preceding termination wave without
				// ever following a recycled pid or scanning by executable name.
				let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
				for entry in sys::processes() {
					children.entry(entry.ppid).or_default().push(entry.pid);
				}
				let mut fresh = Vec::new();
				let mut parents: Vec<_> = std::iter::once(&self.root)
					.chain(&descendants)
					.map(|process| (process.pid, process.created))
					.collect();
				while let Some((parent_pid, parent_created)) = parents.pop() {
					for &pid in children.get(&parent_pid).into_iter().flatten() {
						if seen.contains(&pid) {
							continue;
						}
						let Ok(process) = Process::open(pid) else {
							continue;
						};
						if process.created < parent_created
							|| sys::parent_pid(&process.handle) != i32::try_from(parent_pid).ok()
						{
							continue;
						}
						seen.insert(pid);
						parents.push((pid, process.created));
						fresh.push(process);
					}
				}
				if fresh.is_empty() && terminated {
					break;
				}
				// Stop parents before children can fork again; all handles remain
				// pinned until a final snapshot finds no surviving new descendants.
				let owned = std::iter::once(&self.root)
					.chain(&descendants)
					.chain(&fresh);
				for process in owned.clone() {
					let _ = sys::terminate(&process.handle);
				}
				for process in owned {
					process.exited().await;
				}
				descendants.extend(fresh);
				terminated = true;
			}
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Network operations (public API)
// ═══════════════════════════════════════════════════════════════════════════

impl GitRepo {
	/// Resolve the live remote HEAD, never cached remote-tracking refs.
	///
	/// Detached, unborn, missing, or invalid advertisements are errors: there
	/// is no fallback branch name and no successfully observed "absence".
	pub async fn remote_default_branch(
		&self,
		remote: &str,
		cancel: Option<CancellationToken>,
	) -> Result<RemoteDefaultBranch> {
		const OP: &str = "git ls-remote default branch";
		if remote.is_empty() {
			return Err(Error::backend(OP, "an explicit remote is required"));
		}
		let args = vec![
			"ls-remote".to_owned(),
			"--symref".to_owned(),
			"--".to_owned(),
			remote.to_owned(),
			"HEAD".to_owned(),
		];
		let output = run_raw(self.root(), &args, &RunOptions {
			read_only: true,
			timeout: Some(NETWORK_TIMEOUT),
			cancel,
			..RunOptions::default()
		})
		.await?;
		if output.stdout.truncated || output.stderr.truncated || !output.stdout_eof {
			return Err(Error::backend(OP, "incomplete remote HEAD advertisement"));
		}
		if output.exit_code != 0 {
			return Err(Error::Cli {
				command:   format!("git {}", args.join(" ")),
				exit_code: output.exit_code,
				stdout:    output.stdout.into_text(),
				stderr:    output.stderr.into_text(),
			});
		}
		let mut branch = None;
		let mut sha = None;
		for line in output.stdout.bytes.as_bstr().lines() {
			let Some(tab) = line.find_byte(b'\t') else {
				return Err(Error::backend(OP, "malformed remote HEAD advertisement"));
			};
			let (value, name) = (&line[..tab], &line[tab + 1..]);
			if name != b"HEAD" {
				continue;
			}
			if let Some(target) = value.strip_prefix(b"ref: ") {
				let target = std::str::from_utf8(target)
					.map_err(|_| Error::backend(OP, "remote HEAD branch name is not valid UTF-8"))?;
				let _: gix::refs::FullName =
					target.try_into().map_err(|err| Error::backend(OP, err))?;
				let Some(path) = target
					.strip_prefix("refs/heads/")
					.filter(|path| !path.is_empty())
				else {
					return Err(Error::backend(
						OP,
						"remote HEAD target must be a full refs/heads/ branch",
					));
				};
				if branch.replace(path.to_owned()).is_some() {
					return Err(Error::backend(OP, "ambiguous remote HEAD symbolic advertisement"));
				}
			} else {
				let id = gix::hash::ObjectId::from_hex(value).map_err(|err| Error::backend(OP, err))?;
				if id.is_null() || sha.replace(id.to_hex().to_string()).is_some() {
					return Err(Error::backend(
						OP,
						"ambiguous or null remote HEAD object advertisement",
					));
				}
			}
		}
		match (branch, sha) {
			(Some(branch), Some(sha)) => Ok(RemoteDefaultBranch { branch, sha }),
			_ => Err(Error::backend(
				OP,
				"remote HEAD must advertise a symbolic branch and object id; detached, unborn, or \
				 missing default",
			)),
		}
	}

	/// Push the current branch (branch-scoped: never follows tags).
	///
	/// `--no-follow-tags` overrides a user's `push.followTags = true`, which
	/// would otherwise ride every reachable annotated tag along with the
	/// branch — rejected refs on remotes the user cannot tag (e.g. PR-head
	/// forks) would fail the call after the branch itself already updated.
	pub async fn push(
		&self,
		options: &PushOptions,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		let mut args = vec!["push".to_owned(), "--no-follow-tags".to_owned()];
		if options.force_with_lease {
			args.push("--force-with-lease".to_owned());
		}
		if let Some(remote) = &options.remote {
			args.push(remote.clone());
		}
		if let Some(refspec) = &options.refspec {
			args.push(refspec.clone());
		}
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(NETWORK_TIMEOUT),
			cancel,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}

	/// Fetch `+source:target` from a remote.
	pub async fn fetch(
		&self,
		remote: &str,
		source: &str,
		target: &str,
		timeout: Option<Duration>,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		let args = vec!["fetch".to_owned(), remote.to_owned(), format!("+{source}:{target}")];
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(timeout.unwrap_or(NETWORK_TIMEOUT)),
			cancel,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}
}

/// Clone `url` into `target_dir`, removing the partial clone on any failure.
///
/// Shallow (`--depth 1 --single-branch`) unless a specific SHA is pinned:
/// a shallow clone only fetches the tip, so checking out a non-tip commit
/// would fail with "reference is not a tree".
pub async fn clone(
	url: &str,
	target_dir: &Path,
	options: &CloneOptions,
	cancel: Option<CancellationToken>,
) -> Result<()> {
	let absolute = std::path::absolute(target_dir)?;
	let parent = absolute
		.parent()
		.map_or_else(|| absolute.clone(), Path::to_owned);
	tokio::fs::create_dir_all(&parent).await?;

	let shallow = options.sha.is_none();
	let mut args = vec!["clone".to_owned()];
	if shallow {
		args.push("--depth".to_owned());
		args.push("1".to_owned());
	}
	if let Some(ref_name) = &options.ref_name {
		args.push("--branch".to_owned());
		args.push(ref_name.clone());
		args.push("--single-branch".to_owned());
	} else if shallow {
		args.push("--single-branch".to_owned());
	}
	args.push(url.to_owned());
	args.push(absolute.to_string_lossy().into_owned());

	let run_options = RunOptions {
		timeout: Some(options.timeout.unwrap_or(NETWORK_TIMEOUT)),
		cancel: cancel.clone(),
		..RunOptions::default()
	};
	let outcome = run_checked(&parent, &args, &run_options).await;
	if let Err(err) = outcome {
		let _ = tokio::fs::remove_dir_all(&absolute).await;
		return Err(err);
	}

	if let Some(sha) = &options.sha {
		let checkout = run_checked(&absolute, &["checkout".to_owned(), sha.clone()], &RunOptions {
			cancel,
			..RunOptions::default()
		})
		.await;
		if let Err(err) = checkout {
			let _ = tokio::fs::remove_dir_all(&absolute).await;
			return Err(Error::backend(
				"git clone",
				format!("failed to checkout SHA {sha} in cloned repository {url}: {err}"),
			));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[cfg(unix)]
	#[test]
	fn sync_stdout_fold_can_read_past_the_capture_limit() {
		let dir = tempfile::tempdir().expect("tempdir");
		let args =
			["-c", "alias.bulk=!dd if=/dev/zero bs=65536 count=129", "bulk"].map(str::to_owned);
		let size = run_sync_fold_stdout(dir.path(), &args, SYNC_TIMEOUT, |n: &mut usize, chunk| {
			*n += chunk.len();
		})
		.expect("fold bulk stdout");
		assert_eq!(size, OUTPUT_LIMIT_BYTES + 65_536);
	}

	#[cfg(unix)]
	struct PipeHolder(tempfile::TempDir);

	#[cfg(unix)]
	impl PipeHolder {
		fn new() -> Self {
			Self(tempfile::tempdir().expect("tempdir"))
		}

		fn args() -> [String; 3] {
			[
				"-c".to_owned(),
				r#"alias.leak=!sh -c 'printf "out\n"; printf "err\n" >&2; sleep 20 & echo $! > sleep.pid'"#
					.to_owned(),
				"leak".to_owned(),
			]
		}
	}

	#[cfg(unix)]
	impl Drop for PipeHolder {
		fn drop(&mut self) {
			if let Ok(pid) = std::fs::read_to_string(self.0.path().join("sleep.pid"))
				&& let Ok(pid) = pid.trim().parse::<libc::pid_t>()
				&& pid > 0
			{
				// SAFETY: the pid belongs to the fixture's background sleep.
				unsafe {
					libc::kill(pid, libc::SIGKILL);
				}
			}
		}
	}

	#[cfg(unix)]
	#[test]
	fn sync_runner_bounds_drain_when_a_descendant_holds_pipes() {
		let fixture = PipeHolder::new();
		let started = std::time::Instant::now();
		let out = run_sync(fixture.0.path(), &PipeHolder::args(), SYNC_TIMEOUT).expect("run alias");
		assert!(started.elapsed() < Duration::from_secs(10), "drain outlived git");
		assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
		assert_eq!(out.stdout, "out\n");
		assert_eq!(out.stderr, "err\n");
	}

	#[cfg(unix)]
	#[test]
	fn sync_readers_exit_after_repeated_calls_while_descendant_holds_pipes() {
		let fixtures = [PipeHolder::new(), PipeHolder::new(), PipeHolder::new()];
		let mut captures = Vec::new();
		for fixture in &fixtures {
			let args = PipeHolder::args();
			let mut cmd = std::process::Command::new("git");
			cmd.args(&args)
				.current_dir(fixture.0.path())
				.stdin(Stdio::null())
				.stdout(Stdio::piped())
				.stderr(Stdio::piped());
			apply_env(&mut cmd);
			detach_from_terminal(&mut cmd);
			let mut child = cmd.spawn().expect("spawn alias");
			let stdout = spawn_sync_reader("git-cli-stdout", child.stdout.take(), OUTPUT_LIMIT_BYTES)
				.expect("stdout reader");
			let stderr = spawn_sync_reader("git-cli-stderr", child.stderr.take(), OUTPUT_LIMIT_BYTES)
				.expect("stderr reader");
			captures.extend([Arc::clone(&stdout.output), Arc::clone(&stderr.output)]);
			let out = wait_sync(&args, child, Some(stdout), Some(stderr), SYNC_TIMEOUT)
				.expect("wait for alias")
				.into_text();
			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			assert_eq!(out.stdout, "out\n");
			assert_eq!(out.stderr, "err\n");
		}
		let deadline = std::time::Instant::now() + Duration::from_secs(1);
		// After wait_sync drops its readers, only this test and any still-live
		// reader threads own the captures. No global counter races other tests.
		while captures
			.iter()
			.any(|capture| Arc::strong_count(capture) > 1)
			&& std::time::Instant::now() < deadline
		{
			std::thread::sleep(Duration::from_millis(10));
		}
		let live_readers = captures
			.iter()
			.filter(|capture| Arc::strong_count(capture) > 1)
			.count();
		assert_eq!(live_readers, 0, "reader threads survived output collection");
		for fixture in &fixtures {
			let pid: libc::pid_t = std::fs::read_to_string(fixture.0.path().join("sleep.pid"))
				.expect("sleep pid")
				.trim()
				.parse()
				.expect("numeric pid");
			// SAFETY: signal 0 only probes the fixture process, without killing
			// it.
			assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "pipe holder exited before readers");
		}
	}

	#[test]
	fn sync_reader_exits_after_collection_while_pipe_stays_open() {
		use std::io::Write;

		let (read, mut write) = std::io::pipe().expect("pipe");
		let reader =
			spawn_sync_reader("git-cli-test", Some(read), OUTPUT_LIMIT_BYTES).expect("reader");
		write.write_all(b"out\n").expect("write output");
		let deadline = std::time::Instant::now() + Duration::from_secs(1);
		while reader.output.lock().unwrap().as_ref().unwrap().bytes.len() < 4
			&& std::time::Instant::now() < deadline
		{
			std::thread::sleep(Duration::from_millis(10));
		}
		assert_eq!(reader.output.lock().unwrap().take().unwrap().into_text(), "out\n");
		let deadline = std::time::Instant::now() + Duration::from_secs(1);
		while !reader.thread.is_finished() && std::time::Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(10));
		}
		assert!(reader.thread.is_finished(), "reader thread survived output collection");
		reader.thread.join().expect("reader finished");
		drop(write);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn async_runner_bounds_drain_when_a_descendant_holds_pipes() {
		let fixture = PipeHolder::new();
		let started = std::time::Instant::now();
		let out = run(fixture.0.path(), &PipeHolder::args(), &RunOptions {
			read_only: true,
			timeout: Some(SYNC_TIMEOUT),
			..RunOptions::default()
		})
		.await
		.expect("run alias");
		assert!(started.elapsed() < Duration::from_secs(10), "drain outlived git");
		assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
		assert_eq!(out.stdout, "out\n");
		assert_eq!(out.stderr, "err\n");
	}

	/// Set on the re-executed child; carries the fixture repository it should
	/// probe. Its presence is what tells the test body which side it is on.
	const ENV_PROBE_REPO: &str = "PI_VCS_TEST_ENV_PROBE_REPO";

	/// Asks git to report the ambient variables it was started with. A `!`-alias
	/// is the only way to make git print its own environment.
	const ENV_PROBE_ALIAS: &str = r#"!printf 'LC_ALL=[%s] LC_CTYPE=[%s] LC_MESSAGES=[%s] LITERAL=[%s] ICASE=[%s]' "$LC_ALL" "$LC_CTYPE" "$LC_MESSAGES" "$GIT_LITERAL_PATHSPECS" "$GIT_ICASE_PATHSPECS""#;

	/// A git left in the host's process group shares its terminal and can read
	/// the TUI's keystrokes and terminal replies (Tern TSP events leaked into
	/// the composer with their leading bytes missing). Both runners must start
	/// it in its own session.
	#[cfg(unix)]
	#[tokio::test]
	async fn runners_start_git_outside_the_host_process_group() {
		let dir = tempfile::tempdir().expect("tempdir");
		let args = ["-c".to_owned(), "alias.pgid=!ps -o pgid= -p $$".to_owned(), "pgid".to_owned()];
		// SAFETY: getpgrp has no preconditions.
		let host = unsafe { libc::getpgrp() };
		let sync = run_sync(dir.path(), &args, SYNC_TIMEOUT).expect("sync runner");
		let spawned = run(dir.path(), &args, &RunOptions::default())
			.await
			.expect("async runner");
		for out in [sync, spawned] {
			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			let pgid: i32 = out.stdout.trim().parse().expect("pgid");
			assert_ne!(pgid, host, "git shares the host's process group: {out:?}");
		}
	}

	/// Two guarantees this crate builds on top of, both of which depend on what
	/// the child process actually receives:
	///
	/// - The ownership fallback reads git's diagnostic, and `LC_ALL` outranks
	///   `LC_MESSAGES`, so an inherited one hands back a translated message that
	///   [`is_dubious_ownership`] cannot match.
	/// - The `:(literal)` magic this crate builds is only explicit once the
	///   global pathspec modes are gone; `GIT_LITERAL_PATHSPECS=1` would turn
	///   the prefix into filename text and match nothing.
	///
	/// Asserted through [`run_sync`] rather than [`apply_env`] directly, because
	/// the regression this covers was the synchronous builder not calling the
	/// helper. The variables have to be present before the process starts, and
	/// `set_var` in a running test binary is observable by every other thread,
	/// so the probe runs in a re-executed copy of this test binary spawned with
	/// them already in its environment.
	#[test]
	fn sync_runner_pins_message_locale_and_scrubs_pathspec_modes() {
		if let Some(repo) = std::env::var_os(ENV_PROBE_REPO) {
			let out = run_sync(
				Path::new(&repo),
				&["-c".to_owned(), format!("alias.envprobe={ENV_PROBE_ALIAS}"), "envprobe".to_owned()],
				SYNC_TIMEOUT,
			)
			.expect("run alias");

			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			assert!(out.stdout.contains("LC_ALL=[]"), "LC_ALL leaked: {out:?}");
			assert!(out.stdout.contains("LC_MESSAGES=[C]"), "messages not pinned: {out:?}");
			// The character locale is preserved so paths keep round-tripping as
			// UTF-8; only the message locale is forced.
			assert!(
				out.stdout.contains("LC_CTYPE=[fr_FR.UTF-8]"),
				"UTF-8 character locale dropped: {out:?}"
			);
			assert!(out.stdout.contains("LITERAL=[]"), "literal pathspec mode leaked: {out:?}");
			assert!(out.stdout.contains("ICASE=[]"), "icase pathspec mode leaked: {out:?}");
			return;
		}

		let dir = tempfile::tempdir().expect("tempdir");
		let init = std::process::Command::new("git")
			.args(["init", "-q", "-b", "main"])
			.current_dir(dir.path())
			.status()
			.expect("spawn git init");
		assert!(init.success(), "git init failed");

		let name = format!(
			"{}::sync_runner_pins_message_locale_and_scrubs_pathspec_modes",
			module_path!()
				.split_once("::")
				.expect("crate-qualified module path")
				.1
		);
		let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
			.args(["--exact", &name, "--nocapture", "--test-threads=1"])
			.env(ENV_PROBE_REPO, dir.path())
			.env("LC_ALL", "fr_FR.UTF-8")
			.env("GIT_LITERAL_PATHSPECS", "1")
			.env("GIT_ICASE_PATHSPECS", "1")
			.output()
			.expect("re-exec test binary");
		assert!(
			child.status.success(),
			"environment probe failed:\n{}{}",
			String::from_utf8_lossy(&child.stdout),
			String::from_utf8_lossy(&child.stderr)
		);
	}
}
