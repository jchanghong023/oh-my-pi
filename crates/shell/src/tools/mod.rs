//! pi's commands that need more than argv and stdio: host callouts
//! ([`Resolved::Tool`](crate::bash::Resolved::Tool)) that run their operands in
//! subshells of the caller through the engine.
//!
//! - `timeout`: runs its command in a labeled subshell
//!   ([`ShellApi::run_subshell_in`]), signals that tree at the deadline
//!   ([`SigTarget::Label`](crate::bash::SigTarget::Label)), waits for it and
//!   the externals it started, and escalates to `KILL` after `-k`.
//! - `time` with options (`-l`, `-v`, `-p`): runs its command in a subshell and
//!   reports the times and resource usage of the externals it waited for
//!   ([`crate::bash::ProcUsage`]), as macOS and GNU `/usr/bin/time` do.
//! - `nohup`: runs its command in a detached tree ([`Lineage::detached`]): the
//!   shell's cancel spares it and the spawner leaves its externals running when
//!   the shell is torn down.
//! - `git` (with `PI_SMART_GIT` or `PI_GIT_GUARD`): the [`crate::git`] layers
//!   on a worker thread, then the git binary found on `PATH`, by absolute path
//!   so it never resolves back to the tool.
//! - `urlmap`: the session's URL mounts ([`crate::mounts`]), which live with
//!   its filesystem rather than in any utility.
//! - pi's extras that run command lines (`env`, `ifne`, `xargs`, `find`): the
//!   utility runs on the session's runtime, and each command it runs is a
//!   subshell of the caller ([`crate::extras`] for the other extras).
//!
//! The engine reports a callout as [`Step::Call`](crate::bash::Step::Call);
//! the session driver owns a [`ToolCalls`] and hands it every call, every
//! [`Step::Done`](crate::bash::Step::Done) of a run that is not its own, and a
//! [`ToolCalls::poll`] on each turn, parking no longer than
//! [`ToolCalls::next_deadline`]. A tool's subshells are ordinary runs of the
//! engine: functions, builtins and externals run as anywhere else, and the
//! tool only watches their `Done`.
//!
//! The `kill` builtin is the engine's intrinsic (`%job` operands stay on the
//! virtual signal bus); the host's policy for OS pids is
//! [`crate::host::check_signal_target`].

mod extra;
mod git;
mod nohup;
mod time;
mod timeout;
mod urlmap;

use std::{
	collections::{HashSet, VecDeque},
	sync::Arc,
	task::Waker,
	time::Duration,
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;

use crate::{
	bash::{
		CallId, CallOutcome, ControlHandle, Cx, IoPoll, Lineage, NativeRef, ProcUsage, RunId, Script,
		Shell, ShellApi, ToolCall, ToolRef,
	},
	commands::CommandSlot,
	extras::{ExtrasGate, ReportedError, Speech},
	git::{GitLayers, flag_on},
	vfs::VfsFs,
};

const TIMEOUT: ToolRef = ToolRef(1);
const NOHUP: ToolRef = ToolRef(2);
const GIT: ToolRef = ToolRef(3);
/// Every extra that runs command lines; `argv[0]` names it.
const EXTRA: ToolRef = ToolRef(4);
const URLMAP: ToolRef = ToolRef(5);
const TIME: ToolRef = ToolRef(6);

/// pi's tools other than the extras, by name; [`ToolConfig::lookup`] offers
/// `nohup` and `git` only when the session's switches turn them on.
const TOOLS: [(&str, ToolRef); 5] =
	[("time", TIME), ("timeout", TIMEOUT), ("urlmap", URLMAP), ("nohup", NOHUP), ("git", GIT)];

/// The switch that hands `nohup` to the system binary.
const NOHUP_OFF: &str = "PI_DISABLE_NOHUP_BUILTIN";

/// The commands pi adds to bash's own builtins, sorted.
///
/// `time`, `timeout`, `urlmap`, `nohup` and the extras [`ExtrasGate`]
/// offers, in a shell whose starting environment turns on the switches `on`
/// names ([`flag_on`] of their values). Not `git`, whose layers wrap the
/// binary.
/// omp's bash tool lists them to the model.
pub fn builtins(on: impl Fn(&str) -> bool) -> Vec<&'static str> {
	let extras = ExtrasGate::from_switches(&on);
	let mut names: Vec<&'static str> = omp_builtins::extras::extras()
		.filter(|&(name, kind)| extras.allows(name, kind))
		.map(|(name, _)| name)
		.chain(["time", "timeout", "urlmap"])
		.chain((!on(NOHUP_OFF)).then_some("nohup"))
		.collect();
	names.sort_unstable();
	names
}

/// Whether tool `name` was given an option it does not implement, so
/// `PATH`'s program of that name runs instead
/// ([`crate::bash::Host::defers_to_path`]): `time -o file`.
pub fn lacks_option(name: &BStr, argv: &[BString]) -> bool {
	name == "time" && time::lacks_option(argv)
}

/// Every name [`ToolConfig::lookup`] or [`ToolConfig::native_extra`] can
/// resolve, whatever the session's switches: the tools and all of pi's
/// extras.
pub fn names() -> impl Iterator<Item = &'static str> {
	TOOLS
		.iter()
		.map(|&(name, _)| name)
		.chain(omp_builtins::extras::extras().map(|(name, _)| name))
}

/// Which tools a session offers; fixed when the session starts, as pi
/// registers its builtins once per shell.
#[derive(Clone, Default)]
pub struct ToolConfig {
	/// `nohup` is the tool (off with `PI_DISABLE_NOHUP_BUILTIN`: the system
	/// binary runs).
	pub nohup:          bool,
	/// The `git` layers on at the start; `git` is the binary when none is.
	/// Each call reads the layers again from its own environment, so a
	/// command can turn one off (`PI_GIT_GUARD=0 git …`).
	pub git:            GitLayers,
	/// The session's filesystem slot ([`VfsFs::filesystem`], read per call):
	/// what pi's extras run on, and whose native paths in-process `git
	/// worktree add` may touch. `None` when every path is native (`StdFs`).
	pub vfs:            Option<VfsFs>,
	/// pi's extras the shell offers (`PI_DISABLE_UUTILS_*`).
	pub extras:         ExtrasGate,
	/// Where the extras that run command lines run; without one they fail.
	pub runtime:        Option<tokio::runtime::Handle>,
	/// The reported-error flag of the command in flight, for the extras.
	pub reported_error: ReportedError,
	/// The application's speech synthesizer, for `say`.
	pub speech:         Speech,
	/// The session commands of the run in flight ([`crate::commands`]).
	pub commands:       CommandSlot,
}

impl ToolConfig {
	/// The tools and extras a shell started with environment `env` offers,
	/// on the filesystem slot `vfs`, running extras on `runtime`.
	pub fn from_env(
		env: &[(BString, BString)],
		vfs: Option<VfsFs>,
		runtime: tokio::runtime::Handle,
	) -> Self {
		let var = |name: &str| {
			env.iter()
				.rev()
				.find(|(k, _)| k == name.as_bytes())
				.and_then(|(_, v)| v.to_str().ok())
		};
		let on = |name: &str| flag_on(var(name));
		Self {
			nohup: !on(NOHUP_OFF),
			git: GitLayers::from_env(var),
			vfs,
			extras: ExtrasGate::from_switches(on),
			runtime: Some(runtime),
			reported_error: ReportedError::default(),
			speech: Speech::default(),
			commands: CommandSlot::default(),
		}
	}

	/// The tool `name` resolves to, if it is one of these.
	pub fn lookup(&self, name: &BStr) -> Option<ToolRef> {
		let tool = TOOLS
			.iter()
			.find(|&&(tool, _)| tool.as_bytes() == name.as_bytes())
			.map(|&(_, tool)| tool);
		match tool {
			Some(NOHUP) => self.nohup.then_some(NOHUP),
			Some(GIT) => self.git.any().then_some(GIT),
			Some(tool) => Some(tool),
			None => self.extras.runs_commands(name).then_some(EXTRA),
		}
	}

	/// The extra `name` resolves to when it is an offered extra that runs
	/// as a task ([`crate::extras::ExtraTask`]).
	pub fn native_extra(&self, name: &BStr) -> Option<NativeRef> {
		self.extras.native(name)
	}

	/// The filesystem extras started now run on.
	pub fn filesystem(&self) -> omp_vfs::Fs {
		self
			.vfs
			.as_ref()
			.map_or_else(omp_vfs::Fs::native, VfsFs::filesystem)
	}

	/// Whether `path` is a plain host filesystem object.
	fn native(&self, path: &std::path::Path) -> bool {
		self
			.vfs
			.as_ref()
			.is_none_or(|fs| fs.filesystem().is_native_local(path))
	}
}

type SpawnRecord = (u32, crate::proctree::Process);

#[derive(Default)]
struct SpawnState {
	spawned:       Vec<SpawnRecord>,
	external:      HashSet<u32>,
	next_sweep_at: usize,
}

/// External identities spawned in labeled subshell trees.
///
/// Pin each live identity at spawn, before a PID can be recycled. Keep the
/// labels' external-spawn history separately so exited handles can be released.
#[derive(Clone, Default)]
pub struct SpawnLog(Arc<Mutex<SpawnState>>);

impl SpawnLog {
	/// Bound historical handles without scanning a large live set on every
	/// spawn.
	const PRUNE_THRESHOLD: usize = 32;

	/// Capture the identity of an external spawned with `lineage`.
	pub fn record(
		&self,
		lineage: Lineage,
		process: impl FnOnce() -> Option<crate::proctree::Process>,
	) {
		if lineage.label != 0 && !lineage.detached {
			let process = process();
			let mut state = self.0.lock();
			state.external.insert(lineage.label);
			if let Some(process) = process {
				state.spawned.push((lineage.label, process));
				if state.spawned.len() >= state.next_sweep_at.max(Self::PRUNE_THRESHOLD) {
					state.spawned.retain(|(_, process)| {
						process.status() == crate::proctree::ProcessStatus::Running
					});
					// Geometric growth amortizes sweeps when most children stay
					// alive.
					state.next_sweep_at = state
						.spawned
						.len()
						.saturating_mul(2)
						.max(Self::PRUNE_THRESHOLD);
				}
			}
		}
	}

	/// Pinned, still-live external members of the labeled trees.
	fn live(&self, labels: &[u32]) -> Vec<crate::proctree::Process> {
		self
			.0
			.lock()
			.spawned
			.iter()
			.filter(|(label, _)| labels.contains(label))
			.map(|(_, process)| process)
			.filter(|process| process.status() == crate::proctree::ProcessStatus::Running)
			.cloned()
			.collect()
	}

	/// Whether any pinned member remains alive, without allocating a snapshot.
	fn has_live(&self, labels: &[u32]) -> bool {
		self.0.lock().spawned.iter().any(|(label, process)| {
			labels.contains(label) && process.status() == crate::proctree::ProcessStatus::Running
		})
	}

	/// Whether the labeled command started any external process.
	fn has_external(&self, labels: &[u32]) -> bool {
		let state = self.0.lock();
		labels.iter().any(|label| state.external.contains(label))
	}

	fn forget(&self, labels: &[u32]) {
		let mut state = self.0.lock();
		state.spawned.retain(|(label, _)| !labels.contains(label));
		for label in labels {
			state.external.remove(label);
		}
		state.next_sweep_at = state
			.spawned
			.len()
			.saturating_mul(2)
			.max(Self::PRUNE_THRESHOLD);
	}
}

/// Lineage labels handed out to tool subshells, and which label each was
/// started under (a `timeout` inside another one's command).
#[derive(Default)]
struct Labels {
	last:    u32,
	parents: Vec<(u32, u32)>,
}

impl Labels {
	/// A fresh label for a subshell of a caller labeled `parent`.
	fn fresh(&mut self, parent: u32) -> u32 {
		self.last = self.last.wrapping_add(1).max(1);
		if parent != 0 {
			self.parents.push((self.last, parent));
		}
		self.last
	}

	/// `label` and every label started below it.
	fn group(&self, label: u32) -> Vec<u32> {
		let mut group = vec![label];
		let mut at = 0;
		while let Some(&parent) = group.get(at) {
			group.extend(
				self
					.parents
					.iter()
					.filter(|&&(_, p)| p == parent)
					.map(|&(child, _)| child),
			);
			at += 1;
		}
		group
	}

	/// Whether `label` belongs to a tree rooted at `ancestor`.
	fn is_descendant(&self, mut label: u32, ancestor: u32) -> bool {
		while let Some(&(_, parent)) = self.parents.iter().find(|&&(child, _)| child == label) {
			if parent == ancestor {
				return true;
			}
			label = parent;
		}
		false
	}

	fn release(&mut self, group: &[u32]) {
		self.parents.retain(|(child, _)| !group.contains(child));
	}
}

/// What a tool sees on each turn ([`Tool::advance`]).
struct Turn<'a> {
	/// [`crate::bash::Host::now_ns`].
	now:    u64,
	ctl:    &'a ControlHandle,
	log:    &'a SpawnLog,
	/// The tool's label and those below it ([`Labels::group`]).
	group:  &'a [u32],
	/// A vproc of `group` still exists.
	live:   bool,
	labels: &'a mut Labels,
	/// Wakes the driver (worker threads).
	waker:  &'a Waker,
	config: &'a ToolConfig,
}

/// One running tool call.
enum Tool {
	Time(time::Time),
	Timeout(timeout::Timeout),
	Nohup(nohup::Nohup),
	Git(git::Git),
	Extra(extra::Extra),
	Urlmap(urlmap::Urlmap),
}

impl Tool {
	fn start(call: ToolCall, config: &ToolConfig) -> Option<Self> {
		Some(match call.tool {
			TIME => Self::Time(time::Time::new(call)),
			TIMEOUT => Self::Timeout(timeout::Timeout::new(call)),
			NOHUP => Self::Nohup(nohup::Nohup::new(call)),
			GIT => Self::Git(git::Git::new(call)),
			EXTRA => Self::Extra(extra::Extra::new(call)),
			URLMAP => Self::Urlmap(urlmap::Urlmap::new(&call, config)),
			_ => return None,
		})
	}

	/// Make progress; the outcome once the call is answered.
	fn advance(&mut self, api: &mut ShellApi<'_, '_>, turn: &mut Turn<'_>) -> Option<CallOutcome> {
		match self {
			Self::Time(t) => t.advance(api, turn),
			Self::Timeout(t) => t.advance(api, turn),
			Self::Nohup(t) => t.advance(api, turn),
			Self::Git(t) => t.advance(api, turn),
			Self::Extra(t) => t.advance(api, turn),
			Self::Urlmap(t) => t.advance(api),
		}
	}

	/// `run` (one of the tool's subshells) ended, having used `usage`;
	/// `false` when it is not the tool's.
	fn on_done(
		&mut self,
		run: RunId,
		status: i32,
		signal: Option<i32>,
		virtual_signal: bool,
		usage: Option<ProcUsage>,
	) -> bool {
		let child = match self {
			Self::Time(t) => return t.on_done(run, status, signal, usage),
			Self::Timeout(t) => return t.on_done(run, status, virtual_signal),
			Self::Nohup(t) => &mut t.child,
			Self::Git(t) => &mut t.child,
			Self::Urlmap(t) => &mut t.child,
			Self::Extra(t) => return t.on_done(run, status, signal),
		};
		child.on_done(run, status)
	}

	const fn child(&self) -> &Child {
		match self {
			Self::Time(t) => &t.child,
			Self::Timeout(t) => &t.child,
			Self::Nohup(t) => &t.child,
			Self::Git(t) => &t.child,
			Self::Extra(t) => &t.child,
			Self::Urlmap(t) => &t.child,
		}
	}

	/// The tool's subshells whose `Done` is still to come.
	fn pending(&self) -> Vec<RunId> {
		match self {
			Self::Extra(t) => t.pending(),
			_ => self.child().pending().into_iter().collect(),
		}
	}

	/// When the tool must be advanced even if nothing wakes the driver.
	fn deadline(&self) -> Option<u64> {
		match self {
			Self::Timeout(t) => t.deadline(),
			Self::Time(_) | Self::Nohup(_) | Self::Git(_) | Self::Extra(_) | Self::Urlmap(_) => None,
		}
	}
}

/// A tool's subshell: its run and label, and its status once it ended.
#[derive(Default)]
struct Child {
	run:    Option<RunId>,
	label:  u32,
	status: Option<i32>,
}

impl Child {
	/// Run `argv` (`"$@"`, so functions, builtins and externals run as
	/// anywhere) in a subshell of the caller under a fresh label;
	/// `redirect` is appended to the command (`>&2`).
	fn start(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &mut Turn<'_>,
		call: &ToolCall,
		argv: Vec<BString>,
		detached: bool,
		redirect: &str,
	) {
		self.label = turn.labels.fresh(api.lineage().label);
		let mut script = Script::command(format!("\"$@\"{redirect}").into_bytes());
		script.args = Some(argv);
		// The command's environment, per-command assignments included.
		script.env = call
			.env
			.iter()
			.map(|(name, value)| (BString::from(name), BString::from(value)))
			.collect();
		self.status = None;
		let lineage = Lineage { label: self.label, detached };
		// `nohup` (the detached tool) execs its operand: its subshell stands
		// for the command, so `$!` of `nohup cmd &` is the program's pid.
		self.run = Some(if detached {
			api.exec_subshell_in(script, lineage)
		} else {
			api.run_subshell_in(script, lineage)
		});
	}

	fn on_done(&mut self, run: RunId, status: i32) -> bool {
		if self.run != Some(run) || self.status.is_some() {
			return false;
		}
		self.status = Some(status);
		true
	}

	/// The run, while its `Done` is still to come.
	fn pending(&self) -> Option<RunId> {
		self.run.filter(|_| self.status.is_none())
	}
}

/// Output a tool writes to the caller's fds, in order, without blocking.
#[derive(Default)]
struct Out(VecDeque<(i32, Vec<u8>)>);

impl Out {
	fn push(&mut self, fd: i32, bytes: impl Into<Vec<u8>>) {
		let bytes = bytes.into();
		if !bytes.is_empty() {
			self.0.push_back((fd, bytes));
		}
	}

	/// Write what fits; `true` once everything is written (or failed: a
	/// closed stderr loses the message, as it would for any command).
	fn flush(&mut self, api: &mut ShellApi<'_, '_>) -> bool {
		while let Some((fd, bytes)) = self.0.front_mut() {
			match api.write(*fd, bytes) {
				IoPoll::Ready(Ok(n)) if n > 0 && n < bytes.len() => {
					bytes.drain(..n);
				},
				IoPoll::Ready(_) => {
					self.0.pop_front();
				},
				IoPoll::WouldBlock(_) => return false,
			}
		}
		true
	}
}

/// The host callouts in flight; owned by the session driver.
pub struct ToolCalls {
	active:  Vec<(CallId, Tool)>,
	/// Runs of tools that ended before them (an abandoned call): their
	/// `Done` is swallowed.
	orphans: Vec<RunId>,
	labels:  Labels,
	log:     SpawnLog,
	waker:   Waker,
	config:  ToolConfig,
}

impl ToolCalls {
	/// Tools of a shell with `config`, whose host records labeled spawns in
	/// `log`; worker threads wake the driver with `waker`.
	pub fn new(config: ToolConfig, log: SpawnLog, waker: Waker) -> Self {
		Self {
			active: Vec::new(),
			orphans: Vec::new(),
			labels: Labels::default(),
			log,
			waker,
			config,
		}
	}

	/// Start the callout `id` the engine returned.
	pub fn on_call(&mut self, shell: &mut Shell, cx: &mut Cx<'_>, id: CallId, call: ToolCall) {
		if matches!(call.tool, GIT | EXTRA)
			&& call
				.argv
				.iter()
				.any(|arg| std::str::from_utf8(arg).is_err())
		{
			shell.complete(id, CallOutcome::Error("builtin cannot accept non-UTF-8 argument".into()));
			return;
		}
		let name = call.argv.first().cloned().unwrap_or_default();
		if let Some(tool) = Tool::start(call, &self.config) {
			self.active.push((id, tool));
			self.poll(shell, cx);
		} else {
			let mut msg = BString::from("not a pi tool: ");
			msg.extend_from_slice(&name);
			shell.complete(id, CallOutcome::Error(msg));
		}
	}

	/// A run that is not the session's own ended; `true` when it belonged
	/// to a tool (the driver ignores it then). `signal` is the actual
	/// signal death of a command replacing the run, not an exit code.
	/// `virtual_signal` identifies a synthetic, uncaught VM signal death.
	/// `usage` is what its externals used ([`Shell::run_usage`]).
	pub fn on_done(
		&mut self,
		run: RunId,
		status: i32,
		signal: Option<i32>,
		virtual_signal: bool,
		usage: Option<ProcUsage>,
	) -> bool {
		if self
			.active
			.iter_mut()
			.any(|(_, tool)| tool.on_done(run, status, signal, virtual_signal, usage))
		{
			return true;
		}
		match self.orphans.iter().position(|&r| r == run) {
			Some(at) => {
				self.orphans.swap_remove(at);
				true
			},
			None => false,
		}
	}

	/// Advance every tool; answer the calls that finished and drop those
	/// the engine abandoned (their caller was cancelled or killed).
	pub fn poll(&mut self, shell: &mut Shell, cx: &mut Cx<'_>) {
		if self.active.is_empty() {
			return;
		}
		let now = cx.host.now_ns();
		let ctl = shell.control();
		let mut at = 0;
		while at < self.active.len() {
			let (id, tool) = &mut self.active[at];
			let id = *id;
			let group = self.labels.group(tool.child().label);
			let live = tool.child().label != 0 && group.iter().any(|&l| shell.label_live(l));
			let outcome = match shell.api(cx, id) {
				Some(mut api) => {
					let mut turn = Turn {
						now,
						ctl: &ctl,
						log: &self.log,
						group: &group,
						live,
						labels: &mut self.labels,
						waker: &self.waker,
						config: &self.config,
					};
					tool.advance(&mut api, &mut turn).map(Some)
				},
				// Abandoned: nothing awaits the answer any more.
				None => Some(None),
			};
			let Some(answer) = outcome else {
				at += 1;
				continue;
			};
			let (_, tool) = self.active.swap_remove(at);
			self.orphans.extend(tool.pending());
			// A signalled nested callout can disappear while its external's
			// TERM handler still runs. Keep that subtree in the enclosing
			// tool's signal/wait set; that tool releases it when it finishes.
			let retained = self.active.iter().any(|(_, parent)| {
				self
					.labels
					.is_descendant(tool.child().label, parent.child().label)
			}) && (live || self.log.has_live(&group));
			if !retained {
				self.log.forget(&group);
				self.labels.release(&group);
			}
			if let Some(outcome) = answer {
				shell.complete(id, outcome);
			}
		}
	}

	/// The earliest host time ([`crate::bash::Host::now_ns`]) a tool must be
	/// polled at even if nothing wakes the driver.
	pub fn next_deadline(&self) -> Option<u64> {
		self
			.active
			.iter()
			.filter_map(|(_, tool)| tool.deadline())
			.min()
	}
}

/// `d` in host nanoseconds (saturating: "never").
fn nanos(d: Duration) -> u64 {
	u64::try_from(d.as_nanos()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[cfg(unix)]
	#[test]
	fn spawn_log_pins_labeled_external_identities() {
		let mut child = std::process::Command::new("/bin/sleep")
			.arg("30")
			.spawn()
			.unwrap();
		let pid = child.id();
		let log = SpawnLog::default();
		let process = || crate::proctree::Process::from_pid(i32::try_from(pid).unwrap());
		log.record(Lineage { label: 7, detached: false }, process);
		log.record(Lineage { label: 8, detached: true }, process);
		let recorded = log.has_external(&[7]);
		let detached_recorded = log.has_external(&[8]);
		let snapshot = log.live(&[7]);
		let live = log.has_live(&[7]);
		child.kill().unwrap();
		child.wait().unwrap();
		assert!(recorded);
		assert!(!detached_recorded, "detached members are excluded");
		assert_eq!(snapshot.len(), 1, "the live member must be pinned at spawn");
		assert_eq!(snapshot[0].pid(), i32::try_from(pid).unwrap());
		assert!(live);
		assert!(!log.has_live(&[7]));
		assert!(log.has_external(&[7]), "an exited external remains recorded");
		log.forget(&[7]);
		assert!(!log.has_external(&[7]));
		assert_eq!(snapshot[0].status(), crate::proctree::ProcessStatus::Exited);
	}

	#[cfg(unix)]
	#[test]
	fn spawn_log_prunes_exited_handles_without_losing_history_or_live_members() {
		let mut live = std::process::Command::new("/bin/sleep")
			.arg("30")
			.spawn()
			.unwrap();
		let log = SpawnLog::default();
		log.record(Lineage { label: 9, detached: false }, || {
			crate::proctree::Process::from_pid(i32::try_from(live.id()).unwrap())
		});
		for _ in 0..SpawnLog::PRUNE_THRESHOLD * 3 {
			let mut child = std::process::Command::new("/bin/sleep")
				.arg("30")
				.spawn()
				.unwrap();
			log.record(Lineage { label: 7, detached: false }, || {
				crate::proctree::Process::from_pid(i32::try_from(child.id()).unwrap())
			});
			child.kill().unwrap();
			child.wait().unwrap();
		}
		let retained = log.0.lock().spawned.len();
		let history = log.has_external(&[7]);
		let exited_live = log.has_live(&[7]);
		let snapshot = log.live(&[9]);
		let signalled = snapshot
			.first()
			.is_some_and(|process| process.signal(libc::SIGTERM));
		if !signalled {
			live.kill().unwrap();
		}
		live.wait().unwrap();
		assert!(retained <= SpawnLog::PRUNE_THRESHOLD, "retained {retained} handles");
		assert!(history, "pruning must preserve the external-spawn history");
		assert!(!exited_live);
		assert_eq!(snapshot.len(), 1, "the live member must survive pruning");
		assert_eq!(snapshot[0].pid(), i32::try_from(live.id()).unwrap());
		assert!(signalled, "the retained live identity must still accept cancellation");
		log.forget(&[7, 9]);
		assert!(!log.has_external(&[7, 9]));
	}

	#[test]
	fn labels_group_their_nested_trees() {
		let mut labels = Labels::default();
		let outer = labels.fresh(0);
		let inner = labels.fresh(outer);
		let innermost = labels.fresh(inner);
		let other = labels.fresh(0);
		assert_eq!(labels.group(outer), [outer, inner, innermost]);
		assert_eq!(labels.group(other), [other]);
		labels.release(&labels.group(inner));
		assert_eq!(labels.group(outer), [outer]);
	}

	#[test]
	fn tools_follow_the_session_environment() {
		let env = |pairs: &[(&str, &str)]| -> Vec<(BString, BString)> {
			pairs.iter().map(|&(k, v)| (k.into(), v.into())).collect()
		};
		let runtime = tokio::runtime::Builder::new_current_thread()
			.build()
			.expect("runtime");
		let config =
			|pairs: &[(&str, &str)]| ToolConfig::from_env(&env(pairs), None, runtime.handle().clone());
		let plain = config(&[]);
		assert_eq!(plain.lookup("timeout".into()), Some(TIMEOUT));
		assert_eq!(plain.lookup("nohup".into()), Some(NOHUP));
		assert_eq!(plain.lookup("git".into()), None);
		assert_eq!(plain.lookup("xargs".into()), Some(EXTRA));
		assert_eq!(plain.lookup("sort".into()), None);
		assert!(plain.native_extra("sort".into()).is_some());
		let layered = config(&[("PI_GIT_GUARD", "1"), ("PI_DISABLE_NOHUP_BUILTIN", "true")]);
		assert_eq!(layered.lookup("git".into()), Some(GIT));
		assert_eq!(layered.lookup("nohup".into()), None);
		let off = config(&[("PI_SMART_GIT", "false"), ("PI_GIT_GUARD", "0")]);
		assert_eq!(off.lookup("git".into()), None);
		let no_utils = config(&[("PI_DISABLE_UUTILS_BUILTINS", "1")]);
		assert_eq!(no_utils.lookup("xargs".into()), None);
		assert!(no_utils.native_extra("sort".into()).is_none());
		assert_eq!(no_utils.lookup("timeout".into()), Some(TIMEOUT));
	}

	/// `builtins` lists exactly the names a session started with the same
	/// switches resolves to pi (a tool or an extra), so the model is never
	/// told a system binary is pi's, or the reverse.
	#[test]
	fn builtins_are_what_the_session_resolves() {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.build()
			.expect("runtime");
		let candidates: Vec<&str> = omp_builtins::extras::extras()
			.map(|(name, _)| name)
			.chain(["time", "timeout", "nohup", "urlmap"])
			.collect();
		for pairs in [&[][..], &[("PI_DISABLE_UUTILS_BUILTINS", "1"), (NOHUP_OFF, "true")], &[
			("PI_DISABLE_UUTILS_DESTRUCTIVE", "1"),
			("PI_DISABLE_MV_BUILTIN", "0"),
		]] {
			let env: Vec<(BString, BString)> =
				pairs.iter().map(|&(k, v)| (k.into(), v.into())).collect();
			let config = ToolConfig::from_env(&env, None, runtime.handle().clone());
			let mut resolved: Vec<&str> = candidates
				.iter()
				.copied()
				.filter(|&name| {
					config.lookup(name.into()).is_some() || config.native_extra(name.into()).is_some()
				})
				.collect();
			resolved.sort_unstable();
			let on = |name: &str| flag_on(pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| *v));
			assert_eq!(builtins(on), resolved, "{pairs:?}");
		}
	}
}
