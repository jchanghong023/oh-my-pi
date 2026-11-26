//! Windows path contracts through the public shell API, with builtin dispatch
//! forced so no installed executable can hide a regression.
#![cfg(windows)]

use std::{fs, path::Path};

use omp_shell::{Shell, ShellRunOptions, cancel::CancelToken};

fn quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

async fn run(command: String, cwd: &Path) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded();
	let result = Shell::new(None)
		.run(
			ShellRunOptions {
				command: format!("PATH=/no-external-fallback {command}"),
				cwd: Some(cwd.to_str().expect("UTF-8 test directory").to_owned()),
				..Default::default()
			},
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("execute builtin");
	assert!(!result.cancelled, "builtin must finish normally");
	(result.exit_code, rx.drain().collect())
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_foreground_preserves_previous_background_external() {
	use std::time::Duration;

	use omp_shell::{
		proctree::{Process, ProcessStatus},
		session::{RunOptions, RunStdio, Session, SessionConfig},
		sys::StdFs,
	};
	use tokio_util::sync::CancellationToken;
	// Re-enter this test binary as the real external, without an extra fixture
	// test that would otherwise be counted as a successful no-op.
	if let Ok(path) = std::env::var("PI_SHELL_CANCEL_FIXTURE") {
		fs::write(path, std::process::id().to_string()).unwrap();
		std::future::pending::<()>().await;
	}

	async fn ready(path: &Path) -> Process {
		tokio::time::timeout(Duration::from_secs(10), async {
			loop {
				if let Ok(text) = fs::read_to_string(path)
					&& let Ok(pid) = text.parse::<i32>()
					&& let Some(process) = Process::from_pid(pid)
				{
					return process;
				}
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("external test child must start")
	}

	let dir = tempfile::tempdir().unwrap();
	let mut session = Session::new(SessionConfig {
		env:             std::env::vars()
			.map(|(key, value)| (key.into(), value.into()))
			.collect(),
		cwd:             dir.path().to_str().unwrap().into(),
		fs:              Box::new(StdFs::default()),
		vfs:             None,
		runtime:         tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap();
	let executable = std::env::current_exe().unwrap();
	let child = format!(
		"{} --exact cancelling_foreground_preserves_previous_background_external --nocapture",
		quote(executable.to_str().unwrap())
	);
	let background = session
		.run_with(
			RunOptions {
				env: vec![("PI_SHELL_CANCEL_FIXTURE".into(), "prior.pid".into())],
				..RunOptions::new(format!("{child} > prior.log 2>&1 &"))
			},
			RunStdio::default(),
			CancellationToken::new(),
		)
		.await
		.unwrap();
	assert_eq!(background.status, 0);
	let prior = ready(&dir.path().join("prior.pid")).await;
	assert_eq!(session.live_external_jobs().await.unwrap(), 1);
	let cancel = CancellationToken::new();
	let probe = async {
		let foreground = ready(&dir.path().join("foreground.pid")).await;
		cancel.cancel();
		foreground
	};
	let (outcome, foreground) = tokio::time::timeout(Duration::from_secs(15), async {
		tokio::join!(
			session.run_with(
				RunOptions {
					env: vec![("PI_SHELL_CANCEL_FIXTURE".into(), "foreground.pid".into())],
					..RunOptions::new(child)
				},
				RunStdio::default(),
				cancel.clone(),
			),
			probe,
		)
	})
	.await
	.expect("foreground cancellation must finish");
	assert!(outcome.unwrap().cancelled);
	assert_eq!(prior.status(), ProcessStatus::Running, "the previous job must survive");
	assert_ne!(foreground.status(), ProcessStatus::Running, "the foreground child must exit");
	assert_eq!(session.live_external_jobs().await.unwrap(), 1);
	assert_eq!(
		session
			.run(":", RunStdio::default(), CancellationToken::new())
			.await
			.unwrap()
			.status,
		0,
		"the session remains usable"
	);
	drop(session);
	tokio::time::timeout(Duration::from_secs(10), async {
		while prior.status() == ProcessStatus::Running {
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("closing the session must terminate its previous background job");
}

/// A normal drive path and its explicit verbatim equivalent must both scan
/// files and load inherited filters; confinement must not relocate the dest.
#[tokio::test(flavor = "multi_thread")]
async fn rsync_drive_and_verbatim_roots_read_filters_and_copy_contents() {
	let dir = tempfile::tempdir().expect("transfer directory");
	let source = dir.path().join("source");
	fs::create_dir_all(source.join("sub")).unwrap();
	fs::write(source.join(".rules"), b"secret\n").unwrap();
	fs::write(source.join("keep"), b"top-level payload").unwrap();
	fs::write(source.join("secret"), b"excluded").unwrap();
	fs::write(source.join("sub/keep"), b"nested payload").unwrap();
	fs::write(source.join("sub/secret"), b"excluded nested").unwrap();
	let verbatim = fs::canonicalize(&source).unwrap();
	for (index, root) in [source.as_path(), verbatim.as_path()]
		.into_iter()
		.enumerate()
	{
		let destination = dir.path().join(format!("destination-{index}"));
		fs::create_dir(&destination).unwrap();
		let source_arg = format!("{}\\", root.display());
		let command = format!(
			"rsync -r --confine-root={} --filter=':- .rules' {} {}",
			quote(root.to_str().unwrap()),
			quote(&source_arg),
			quote(destination.to_str().unwrap()),
		);
		let (status, output) = run(command, dir.path()).await;
		assert_eq!(status, Some(0), "root={root:?}: {output}");
		assert_eq!(fs::read(destination.join("keep")).unwrap(), b"top-level payload");
		assert_eq!(fs::read(destination.join("sub/keep")).unwrap(), b"nested payload");
		assert!(!destination.join("secret").exists(), "root filter must exclude secret");
		assert!(!destination.join("sub/secret").exists(), "filter must be inherited");
		assert!(source.join("secret").is_file(), "source must not be mutated");
	}
}

/// Final dot components check their parent before refusing deletion, so a file
/// parent must report ENOTDIR rather than EINVAL or ENOTEMPTY.
#[tokio::test(flavor = "multi_thread")]
async fn rmdir_final_dot_components_under_a_file_report_not_a_directory() {
	let dir = tempfile::tempdir().unwrap();
	fs::write(dir.path().join("file"), b"preserve me").unwrap();
	for operand in ["file/.", "file/../", "file\\.\\", "file\\..\\"] {
		let (status, output) = run(format!("rmdir {}", quote(operand)), dir.path()).await;
		assert_eq!(status, Some(1), "{operand}: {output}");
		assert!(output.contains("Not a directory"), "{operand}: {output}");
		assert_eq!(fs::read(dir.path().join("file")).unwrap(), b"preserve me");
	}
}

/// A verbatim cwd preserves literal trailing dots, so a normal relative
/// operand can remove its child without Win32 component normalization.
#[tokio::test(flavor = "multi_thread")]
async fn rmdir_preserves_verbatim_cwd_components() {
	let dir = tempfile::tempdir().unwrap();
	let cwd = fs::canonicalize(dir.path()).unwrap().join("literal.");
	fs::create_dir_all(cwd.join("victim")).unwrap();
	let (status, output) = run("rmdir victim".into(), &cwd).await;
	assert_eq!(status, Some(0), "{output}");
	assert!(output.is_empty(), "{output}");
	assert!(!cwd.join("victim").exists(), "the literal directory's child must be removed");
	assert!(cwd.is_dir(), "the literal cwd must be preserved");
}

/// Observe actual native removals without translating NT names into Win32
/// verbatim names: an exemption must reach the OS, not manufacture success.
#[derive(Debug, Default)]
struct NativeRemovalObserver {
	attempts: std::sync::Mutex<Vec<(std::path::PathBuf, Option<i32>)>>,
}

#[async_trait::async_trait]
impl omp_vfs::FileSystem for NativeRemovalObserver {
	async fn open(
		&self,
		path: &Path,
		options: &omp_vfs::OpenOptions,
	) -> std::io::Result<omp_vfs::File> {
		omp_vfs::Fs::native().open_with(path, options).await
	}

	async fn metadata(&self, path: &Path) -> std::io::Result<omp_vfs::Metadata> {
		omp_vfs::Fs::native().metadata(path).await
	}

	async fn read_dir(&self, path: &Path) -> std::io::Result<omp_vfs::ReadDir> {
		omp_vfs::Fs::native().read_dir(path).await
	}

	async fn remove_dir(&self, path: &Path) -> std::io::Result<()> {
		let result = omp_vfs::Fs::native().remove_dir(path).await;
		self
			.attempts
			.lock()
			.unwrap()
			.push((path.to_path_buf(), result.as_ref().err().and_then(std::io::Error::raw_os_error)));
		result
	}
}

/// `\??\` is an NT spelling, not Rust's Win32 `\\?\` absolute prefix.
/// It bypasses rmdir's trimming guard but must preserve the native failure
/// instead of deleting the similarly named ordinary Win32 directory.
#[tokio::test(flavor = "multi_thread")]
async fn rmdir_nt_prefix_reaches_native_removal_without_deleting_win32_alias() {
	let dir = tempfile::tempdir().unwrap();
	let root = fs::canonicalize(dir.path()).unwrap();
	for name in ["literal.", "literal "] {
		let literal = root.join(name);
		let ordinary = root.join("literal");
		fs::create_dir(&literal).unwrap();
		fs::create_dir(&ordinary).unwrap();
		fs::write(ordinary.join("keep"), b"ordinary alias survives").unwrap();
		let tail = literal.to_str().unwrap().strip_prefix(r"\\?\").unwrap();
		let operand = format!(r"\??\{tail}");
		let resolved = omp_vfs::absolute_path(&root, Path::new(&operand));
		let native_error = fs::remove_dir(&resolved).expect_err("NT spelling is not a Win32 path");
		let native_code = native_error.raw_os_error().expect("native OS failure");
		assert!(literal.is_dir(), "native failure must not delete the literal directory");
		let observer = std::sync::Arc::new(NativeRemovalObserver::default());
		let (tx, rx) = flume::unbounded();
		let result = Shell::new(None)
			.run(
				ShellRunOptions {
					command: format!("PATH=/no-external-fallback rmdir {}", quote(&operand)),
					cwd: Some(root.to_str().unwrap().to_owned()),
					filesystem: Some(omp_vfs::Fs::new(observer.clone())),
					..Default::default()
				},
				Some(tx),
				CancelToken::default(),
			)
			.await
			.expect("run native rmdir");
		let output: String = rx.drain().collect();
		assert_eq!(result.exit_code, Some(1), "{operand}: {output}");
		assert!(!result.cancelled);
		assert_eq!(
			*observer.attempts.lock().unwrap(),
			vec![(resolved, Some(native_code))],
			"NT-prefixed trailing component must bypass the guard and retain the OS result"
		);
		assert!(literal.is_dir(), "literal directory must survive native rejection");
		assert_eq!(fs::read(ordinary.join("keep")).unwrap(), b"ordinary alias survives");
		fs::remove_dir(&literal).unwrap();
		fs::remove_file(ordinary.join("keep")).unwrap();
		fs::remove_dir(&ordinary).unwrap();
	}
}

/// A provider-backed UNC namespace exercises the scanner/filter boundary
/// without requiring an administrator-created SMB share on the test machine.
#[derive(Debug)]
struct UncFilesystem {
	root: std::path::PathBuf,
}

impl UncFilesystem {
	fn mapped(&self, path: &Path) -> std::io::Result<std::path::PathBuf> {
		let normalized = path.to_string_lossy().replace('\\', "/");
		let relative = normalized
			.strip_prefix("//omp-fixture/share")
			.filter(|tail| tail.is_empty() || tail.starts_with('/'))
			.ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?;
		Ok(self.root.join(relative.trim_start_matches('/')))
	}
}

#[async_trait::async_trait]
impl omp_vfs::FileSystem for UncFilesystem {
	fn is_native_local(&self, path: &Path) -> bool {
		!path
			.to_string_lossy()
			.replace('\\', "/")
			.starts_with("//omp-fixture/")
	}

	async fn open(
		&self,
		path: &Path,
		options: &omp_vfs::OpenOptions,
	) -> std::io::Result<omp_vfs::File> {
		omp_vfs::Fs::native()
			.open_with(self.mapped(path)?, options)
			.await
	}

	async fn metadata(&self, path: &Path) -> std::io::Result<omp_vfs::Metadata> {
		omp_vfs::Fs::native().metadata(self.mapped(path)?).await
	}

	async fn canonicalize(
		&self,
		path: &Path,
		_options: &omp_vfs::CanonicalizeOptions,
	) -> std::io::Result<std::path::PathBuf> {
		self.metadata(path).await?;
		Ok(path.to_path_buf())
	}

	async fn read_dir(&self, path: &Path) -> std::io::Result<omp_vfs::ReadDir> {
		let mut entries = Vec::new();
		for entry in omp_vfs::Fs::native().read_dir(self.mapped(path)?).await? {
			let entry = entry?;
			let name = entry.file_name();
			let metadata = entry.metadata()?;
			entries.push(Ok(omp_vfs::DirEntry::new(
				omp_vfs::join_path(path, Path::new(&name)),
				name,
				Some(metadata.file_type()),
			)
			.with_metadata(metadata)));
		}
		Ok(omp_vfs::ReadDir::from_entries(entries))
	}
}

/// UNC local scanning must reach its per-directory merge file, not treat the
/// server as a remote operand or lose the doubled UNC prefix before opening.
#[tokio::test(flavor = "multi_thread")]
async fn rsync_unc_scan_reads_the_unc_filter_file() {
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir(dir.path().join("source")).unwrap();
	fs::write(dir.path().join("source/.rules"), b"secret\n").unwrap();
	fs::write(dir.path().join("source/keep"), b"visible").unwrap();
	fs::write(dir.path().join("source/secret"), b"hidden").unwrap();
	let (tx, rx) = flume::unbounded();
	let result = Shell::new(None)
		.run(
			ShellRunOptions {
				command: format!(
					"PATH=/no-external-fallback rsync -r --list-only --filter=':- .rules' {}",
					quote(r"\\omp-fixture\share\source\"),
				),
				cwd: Some(dir.path().to_str().unwrap().to_owned()),
				filesystem: Some(omp_vfs::Fs::new(std::sync::Arc::new(UncFilesystem {
					root: dir.path().to_path_buf(),
				}))),
				..Default::default()
			},
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("UNC builtin scan");
	let output: String = rx.drain().collect();
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert!(output.lines().any(|line| line.ends_with(" keep")), "{output}");
	assert!(!output.lines().any(|line| line.ends_with(" secret")), "{output}");
}
