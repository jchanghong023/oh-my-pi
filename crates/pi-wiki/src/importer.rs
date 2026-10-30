//! Owner-independent wiki import orchestration and exclusive leases.
use std::{
	path::{Path, PathBuf},
	time::{Duration, Instant},
};

use pi_vfs::file_lock::FileLock;
use sha2::{Digest, Sha256};

use crate::{
	database::WikiError,
	import,
	storage::{BUILDING_INDEX_PREFIX, BuildIdentity, Storage, WikiIndexSummary},
};

/// A synchronous callback failure, preserving an adapter-owned exception.
pub struct CallbackFailure<E> {
	/// Original adapter-specific error.
	pub error:      E,
	/// Sanitized diagnostic error type.
	pub error_type: String,
}
/// An import failure from core processing or a callback.
pub enum ImportError<E> {
	/// A core processing failure.
	Core(WikiError),
	/// A callback failure with its original adapter-specific error.
	Callback(CallbackFailure<E>),
}
impl<E> From<WikiError> for ImportError<E> {
	fn from(error: WikiError) -> Self {
		Self::Core(error)
	}
}
impl<E> From<CallbackFailure<E>> for ImportError<E> {
	fn from(error: CallbackFailure<E>) -> Self {
		Self::Callback(error)
	}
}
impl<E> ImportError<E> {
	fn cancelled(&self) -> bool {
		match self {
			Self::Core(e) => e.diagnostic_error_type() == "AbortError",
			Self::Callback(e) => e.error_type == "AbortError",
		}
	}

	fn annotate(&self, event: &mut WikiDiagnosticEvent) {
		match self {
			Self::Core(e) => event.error(e),
			Self::Callback(e) => event.error_type = Some(e.error_type.clone()),
		}
	}
}
/// Import progress checkpoint.
pub struct WikiBuildProgress {
	/// Current phase.
	pub phase:        String,
	/// Number of files.
	pub total:        i64,
	/// Number of completed documents.
	pub completed:    i64,
	/// Number of failed documents.
	pub failed:       i64,
	/// Current file path, if any.
	pub current_path: Option<String>,
}
/// Published import result.
pub struct WikiBuildResult {
	/// Number of processed documents.
	pub processed: i64,
	/// Number of failed documents.
	pub failed:    i64,
	/// Published index.
	pub index:     WikiIndexSummary,
}
/// Runs one operation while holding access to identity-bound storage.
pub type StorageAccess<'a> =
	dyn Fn(&str, &mut dyn FnMut(&Storage) -> Result<(), WikiError>) -> Result<(), WikiError> + 'a;

/// Owner-specific access and synchronous callback delivery for an import.
pub struct ImportHooks<'a, E> {
	/// Database path used for lease identity and diagnostics.
	pub database_path: &'a str,
	/// Checks owner closure and cancellation.
	pub check:         &'a dyn Fn() -> Result<(), WikiError>,
	/// Opens storage if needed and captures its physical identity.
	pub identity:      &'a dyn Fn() -> Result<String, WikiError>,
	/// Executes exactly one operation with the identity-bound storage lock.
	pub with_storage:  &'a StorageAccess<'a>,
	/// Rolls back accepted changes even after cancellation.
	pub rollback:      &'a dyn Fn(&BuildIdentity) -> Result<(), WikiError>,
	/// Flushes storage diagnostics outside the storage mutex.
	pub flush:         &'a dyn Fn() -> Result<(), CallbackFailure<E>>,
	/// Delivers an import diagnostic synchronously.
	pub event:         &'a dyn Fn(WikiDiagnosticEvent) -> Result<(), CallbackFailure<E>>,
	/// Delivers progress synchronously.
	pub progress:      &'a dyn Fn(WikiBuildProgress) -> Result<(), CallbackFailure<E>>,
}
#[derive(Default)]
/// Content-free import diagnostic event.
pub struct WikiDiagnosticEvent {
	/// Diagnostic message.
	pub message:               String,
	/// Diagnostic level.
	pub level:                 String,
	/// Diagnostic component.
	pub component:             String,
	/// Diagnostic event.
	pub event:                 String,
	/// Diagnostic stage.
	pub stage:                 String,
	/// Diagnostic result.
	pub result:                String,
	/// Diagnostic elapsed ms.
	pub elapsed_ms:            Option<f64>,
	/// Diagnostic file count.
	pub file_count:            Option<i64>,
	/// Diagnostic document count.
	pub document_count:        Option<i64>,
	/// Diagnostic section count.
	pub section_count:         Option<i64>,
	/// Diagnostic index count.
	pub index_count:           Option<i64>,
	/// Diagnostic abandoned index count.
	pub abandoned_index_count: Option<i64>,
	/// Diagnostic retry limit.
	pub retry_limit:           Option<i64>,
	/// Diagnostic schema version.
	pub schema_version:        Option<i64>,
	/// Diagnostic supported version.
	pub supported_version:     Option<i64>,
	/// Diagnostic from version.
	pub from_version:          Option<i64>,
	/// Diagnostic to version.
	pub to_version:            Option<i64>,
	/// Diagnostic index id.
	pub index_id:              Option<i64>,
	/// Diagnostic index hash.
	pub index_hash:            Option<String>,
	/// Diagnostic cleanup.
	pub cleanup:               Option<String>,
	/// Diagnostic rollback.
	pub rollback:              Option<String>,
	/// Diagnostic failed stage.
	pub failed_stage:          Option<String>,
	/// Diagnostic reason.
	pub reason:                Option<String>,
	/// Diagnostic error type.
	pub error_type:            Option<String>,
	/// Diagnostic error code.
	pub error_code:            Option<String>,
	/// Diagnostic error errno.
	pub error_errno:           Option<i32>,
}
impl WikiDiagnosticEvent {
	fn operation(message: &str, event: &str, stage: &str, result: &str, started: Instant) -> Self {
		Self {
			message: message.into(),
			level: "info".into(),
			component: "docs".into(),
			event: event.into(),
			stage: stage.into(),
			result: result.into(),
			elapsed_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
			..Self::default()
		}
	}

	fn error(&mut self, error: &WikiError) {
		self.error_type = Some(error.diagnostic_error_type().into());
		self.error_code = error.diagnostic_code().map(str::to_owned);
		self.error_errno = error.diagnostic_sqlite_code();
	}
}
/// State of an import session.
pub struct Build<'a, E> {
	hooks:              &'a ImportHooks<'a, E>,
	started:            Instant,
	stage:              &'static str,
	documents:          i64,
	sections:           i64,
	files:              i64,
	cleanup:            &'static str,
	reason:             Option<&'static str>,
	/// Whether publication completed.
	pub published:      bool,
	/// Whether lease acquisition encountered contention.
	pub lock_contended: bool,
}
impl<'a, E> Build<'a, E> {
	/// Creates an import session.
	pub fn new(hooks: &'a ImportHooks<'a, E>) -> Self {
		Self {
			hooks,
			started: Instant::now(),
			stage: "validate",
			documents: 0,
			sections: 0,
			files: 0,
			cleanup: "not_needed",
			reason: None,
			published: false,
			lock_contended: false,
		}
	}

	fn event(&self, message: &str, stage: &str, result: &str) -> WikiDiagnosticEvent {
		let mut event =
			WikiDiagnosticEvent::operation(message, "docs.init", stage, result, self.started);
		event.file_count = Some(self.files);
		event.document_count = Some(self.documents);
		event.section_count = Some(self.sections);
		event
	}

	fn emit(&self, event: WikiDiagnosticEvent) -> Result<(), ImportError<E>> {
		(self.hooks.flush)()?;
		(self.hooks.event)(event)?;
		Ok(())
	}

	fn log(&self, message: &str, stage: &str, result: &str) -> Result<(), ImportError<E>> {
		self.emit(self.event(message, stage, result))
	}

	fn progress(&self, phase: &str, path: Option<String>) -> Result<(), ImportError<E>> {
		(self.hooks.flush)()?;
		(self.hooks.progress)(WikiBuildProgress {
			phase:        phase.into(),
			total:        self.files,
			completed:    self.documents,
			failed:       0,
			current_path: path,
		})?;
		Ok(())
	}

	fn check(&self) -> Result<(), ImportError<E>> {
		(self.hooks.check)().map_err(Into::into)
	}

	fn with_import_storage<T>(
		&self,
		database: &str,
		work: impl FnOnce(&Storage) -> Result<T, WikiError>,
	) -> Result<T, WikiError> {
		let mut work = Some(work);
		let mut output = None;
		(self.hooks.with_storage)(database, &mut |storage| {
			output = Some(work.take().expect("storage callback invoked once")(storage)?);
			Ok(())
		})?;
		Ok(output.expect("storage callback invoked"))
	}

	#[allow(
		clippy::suboptimal_flops,
		reason = "Preserve original ECMAScript IEEE-754 multiplication/addition order for timing \
		          accumulation."
	)]
	fn ingest(
		&mut self,
		build: &BuildIdentity,
		database: &str,
		root: &Path,
		files: Vec<String>,
		name: &str,
	) -> std::result::Result<WikiBuildResult, ImportError<E>> {
		self.progress("scan", None)?;
		self.stage = "read_parse";
		self.log("docs.init.ingest.started", self.stage, "started")?;
		let mut read_ms = 0.0;
		let mut fts_ms = 0.0;
		for relative in files {
			self.check()?;
			self.stage = "read_parse";
			let started = Instant::now();
			let document =
				match import::read_markdown_document(root, &relative, &|| (self.hooks.check)()) {
					Ok(document) => document,
					Err(error) => {
						self.stage = if error
							.error_message()
							.starts_with("Unable to parse Markdown ")
						{
							"parse"
						} else {
							"read"
						};
						return Err(error.into());
					},
				};
			read_ms += started.elapsed().as_secs_f64() * 1000.0;
			self.check()?;
			self.stage = "fts";
			if self.documents == 0 {
				self.log("docs.init.fts.started", self.stage, "started")?;
			}
			let started = Instant::now();
			self.with_import_storage(database, |storage| {
				storage.commit_document(build, &document, &|| (self.hooks.check)())
			})?;
			fts_ms += started.elapsed().as_secs_f64() * 1000.0;
			self.documents += 1;
			self.sections += document.sections.len() as i64;
			// The reader cannot advance until synchronous JS side effects
			// complete. Returned Promises are ignored, just as the old
			// optional callback call.
			self.progress("fts", Some(relative))?;
		}
		let mut event = self.event("docs.init.read_parse.completed", "read_parse", "completed");
		event.elapsed_ms = Some(read_ms);
		self.emit(event)?;
		self.log("docs.init.parse.completed", "parse", "completed")?;
		let mut event = self.event("docs.init.fts.completed", "fts", "completed");
		event.elapsed_ms = Some(fts_ms);
		self.emit(event)?;
		self.check()?;
		self.stage = "publish";
		let index = self.with_import_storage(database, |storage| storage.promote(build, name))?;
		self.published = true;
		Ok(WikiBuildResult { processed: self.documents, failed: 0, index })
	}

	fn rollback(
		&mut self,
		build: &BuildIdentity,
		error: ImportError<E>,
	) -> std::result::Result<WikiBuildResult, ImportError<E>> {
		let failed_stage = self.stage;
		let mut event = self.event(
			"docs.init.ingest.finished",
			self.stage,
			if error.cancelled() {
				"cancelled"
			} else {
				"failed"
			},
		);
		event.level = if error.cancelled() { "info" } else { "error" }.into();
		error.annotate(&mut event);
		// Diagnostic failures must not prevent cleanup of accepted commits.
		let logging = self.emit(event);
		self.cleanup = "started";
		let mut event = self.event("docs.init.rollback.started", "rollback", "started");
		event.failed_stage = Some(failed_stage.into());
		let rollback_logging = self.emit(event);
		match (self.hooks.rollback)(build) {
			Ok(()) => {
				self.cleanup = "completed";
				let mut event = self.event("docs.init.rollback.completed", "rollback", "completed");
				event.failed_stage = Some(failed_stage.into());
				self.emit(event)?;
				logging?;
				rollback_logging?;
				Err(error)
			},
			Err(cleanup_error) => {
				self.cleanup = "failed";
				self.stage = "rollback";
				let mut event = self.event("docs.init.rollback.failed", self.stage, "failed");
				event.level = "error".into();
				event.failed_stage = Some(failed_stage.into());
				event.error(&cleanup_error);
				let _ = self.emit(event);
				Err(cleanup_error.into())
			},
		}
	}

	fn locked(
		&mut self,
		root: &Path,
		files: Vec<String>,
		name: &str,
		database: &str,
	) -> std::result::Result<WikiBuildResult, ImportError<E>> {
		self.check()?;
		self.stage = "validate";
		if self
			.with_import_storage(database, |storage| storage.get(name))?
			.is_some()
		{
			self.reason = Some("duplicate_name");
			return Err(WikiError::message(format!("Document index already exists: {name}")).into());
		}
		self.stage = "recovery";
		self.with_import_storage(database, |storage| storage.remove_abandoned())?;
		self.stage = "create";
		let hidden = format!("{BUILDING_INDEX_PREFIX}{}", build_uuid()?);
		let root = root.to_string_lossy();
		let temp = self.with_import_storage(database, |storage| storage.create(&hidden, &root))?;
		match self.ingest(&temp, database, Path::new(root.as_ref()), files, name) {
			Ok(result) => Ok(result),
			Err(error) => self.rollback(&temp, error),
		}
	}

	/// Acquires an exclusive lease with diagnostic reporting.
	pub fn acquire_lease(
		&mut self,
		started: Instant,
		database: &str,
	) -> std::result::Result<FileLock, ImportError<E>> {
		let mut event = self.event("docs.init.lock.started", self.stage, "started");
		event.retry_limit = Some(3);
		self.emit(event)?;
		let (error, result, level) =
			match acquire(self.hooks.database_path, self.hooks.check, database) {
				Ok(Some(lease)) => return Ok(lease),
				Ok(None) => {
					self.lock_contended = true;
					(
						WikiError::message(format!(
							"Another document index build is already running for this profile: {}",
							self.hooks.database_path
						)),
						"contended",
						"warn",
					)
				},
				Err(error) => {
					let cancelled = error.diagnostic_error_type() == "AbortError";
					(
						error,
						if cancelled { "cancelled" } else { "failed" },
						if cancelled { "info" } else { "error" },
					)
				},
			};
		let mut event = self.event("docs.init.lock.failed", self.stage, result);
		event.level = level.into();
		event.elapsed_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
		event.error(&error);
		self.emit(event)?;
		self.check()?;
		Err(error.into())
	}

	/// Performs the import, including rollback and lease release.
	pub fn build(
		&mut self,
		root: &str,
		name: &str,
	) -> std::result::Result<WikiBuildResult, ImportError<E>> {
		// Reopen a legitimately replaced profile before this operation starts,
		// then bind every import access before any external callback can retarget
		// it.
		let database = (self.hooks.identity)()?;
		self.log("docs.init.started", self.stage, "started")?;
		self.check()?;
		self.stage = "name_validation";
		let name = validate_name(name)?;
		self.stage = "validate";
		if self
			.with_import_storage(&database, |storage| storage.get(name))?
			.is_some()
		{
			self.reason = Some("duplicate_name");
			return Err(WikiError::message(format!("Document index already exists: {name}")).into());
		}
		let root = import::resolve_root(Path::new(root))?;
		self.stage = "scan";
		let started = Instant::now();
		self.log("docs.init.scan.started", self.stage, "started")?;
		let files = import::enumerate_markdown_files(&root, &|| (self.hooks.check)())?;
		self.files = files.len() as i64;
		let mut event = self.event("docs.init.scan.completed", self.stage, "completed");
		event.elapsed_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
		self.emit(event)?;
		self.check()?;
		if files.is_empty() {
			self.reason = Some("no_documents");
			return Err(
				WikiError::message(format!("No Markdown files found in: {}", root.display())).into(),
			);
		}
		self.stage = "lock";
		let started = Instant::now();
		let mut lease = self.acquire_lease(started, &database)?;
		let result = (|| {
			let mut event = self.event("docs.init.lock.completed", self.stage, "completed");
			event.elapsed_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
			self.emit(event)?;
			self.locked(&root, files, name, &database)
		})();
		let operation_stage = self.stage;
		let release_log = self.log("docs.init.lock.release.started", "lock_release", "started");
		self.stage = "lock_release";
		// Explicit release failure supersedes publication, callback, and rollback
		// failure. FileLock::drop is only an emergency fallback.
		if let Err(error) = lease.release_native() {
			return Err(
				WikiError::message(format!("Failed to release native file lock: {error}")).into(),
			);
		}
		self.stage = operation_stage;
		self.log("docs.init.lock.release.completed", "lock_release", "completed")?;
		release_log?;
		if self.published {
			let mut event = self.event("docs.init.completed", self.stage, "completed");
			event.cleanup = Some(self.cleanup.into());
			self.emit(event)?;
		}
		result
	}
}
/// Runs a complete import with owner-provided storage and callback hooks.
pub fn run<E>(
	hooks: &ImportHooks<'_, E>,
	root: &str,
	name: &str,
) -> std::result::Result<WikiBuildResult, ImportError<E>> {
	let mut build = Build {
		hooks,
		started: Instant::now(),
		stage: "validate",
		documents: 0,
		sections: 0,
		files: 0,
		cleanup: "not_needed",
		reason: None,
		published: false,
		lock_contended: false,
	};
	let result = build.build(root, name);
	if let Err(error) = &result {
		if build.stage == "scan"
			&& matches!(error,ImportError::Core(error) if error.error_message().starts_with("Markdown root is not a directory: "))
		{
			build.reason = Some("source_not_directory");
		}
		let cancelled = error.cancelled();
		let rejected = build.reason.is_some() || build.stage == "name_validation";
		let mut event = build.event(
			"docs.init.finished",
			build.stage,
			if cancelled {
				"cancelled"
			} else if rejected {
				"rejected"
			} else {
				"failed"
			},
		);
		event.level = if cancelled || rejected {
			"info"
		} else if build.lock_contended {
			"warn"
		} else {
			"error"
		}
		.into();
		event.reason = build.reason.map(str::to_owned);
		event.cleanup = Some(build.cleanup.into());
		error.annotate(&mut event);
		// Never replace a callback Error or explicit cleanup/release failure
		// merely because logging that failure also throws.
		let _ = build.emit(event);
	}
	let flushed = (hooks.flush)();
	if result.is_ok() {
		flushed?;
	}
	result
}
fn validate_name(name: &str) -> std::result::Result<&str, WikiError> {
	let name=name.trim_matches(|character:char|matches!(character,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'));
	if name.is_empty() {
		return Err(WikiError::message("Document index name must not be empty"));
	}
	if name.chars().count() > 64 {
		return Err(WikiError::message(
			"Document index name must contain at most 64 Unicode scalar values",
		));
	}
	if name.chars().any(char::is_control) {
		return Err(WikiError::message("Document index name must not contain control characters"));
	}
	if name.starts_with(BUILDING_INDEX_PREFIX) {
		return Err(WikiError::message(format!(
			"Document index name uses reserved prefix: {BUILDING_INDEX_PREFIX}"
		)));
	}
	Ok(name)
}
/// Computes the shared lock path for a physical database identity.
pub fn lease_path(identity: &str) -> PathBuf {
	// Linux and Windows hash this key without opening a file: keep it
	// independent of process-local temp directories and database path
	// aliases.
	let name = format!("omp-wiki-import-{:x}.lock", Sha256::digest(identity.as_bytes()));
	#[cfg(any(target_os = "linux", windows))]
	{
		PathBuf::from(name)
	}
	// Other Unix platforms open a persistent flock sidecar. Use the shared,
	// fixed namespace rather than TMPDIR, and never unlink a released sidecar.
	#[cfg(all(unix, not(target_os = "linux")))]
	{
		Path::new("/tmp").join(name)
	}
}
/// Resolve the exclusive import lease for `database_path`: the lock-file path
/// and the physical identity its name is derived from. All path aliases of one
/// physical database map to the same lease.
pub fn import_lease(database_path: &str) -> std::result::Result<(PathBuf, String), WikiError> {
	let path = import::resolve_root(Path::new(database_path))?;
	let identity = super::database::file_identity(&path)?;
	Ok((lease_path(&identity), identity))
}
/// Acquires an import lease, checking cancellation and database identity
/// between retries.
pub fn acquire(
	database_path: &str,
	check: &dyn Fn() -> Result<(), WikiError>,
	database: &str,
) -> std::result::Result<Option<FileLock>, WikiError> {
	check()?;
	let lock_path = lease_path(database);
	for attempt in 0..3 {
		check()?;
		if super::database::file_identity(Path::new(database_path))? != database {
			return Err(WikiError::message("Documentation database changed during document indexing"));
		}
		let lease = FileLock::try_acquire_path(&lock_path)?;
		if lease.is_acquired() {
			return Ok(Some(lease));
		}
		if attempt < 2 {
			for _ in 0..10 {
				check()?;
				std::thread::sleep(Duration::from_millis(10));
			}
		}
	}
	Ok(None)
}
fn build_uuid() -> std::result::Result<String, WikiError> {
	let mut bytes = [0_u8; 16];
	#[cfg(unix)]
	{
		use std::io::Read;
		std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
	}
	#[cfg(windows)]
	{
		let mut guid = windows_sys::core::GUID::default();
		// SAFETY: CoCreateGuid writes the live GUID; the existing crate enables
		// COM.
		let status = unsafe { windows_sys::Win32::System::Com::CoCreateGuid(&raw mut guid) };
		if status < 0 {
			return Err(WikiError::message(format!(
				"Unable to generate document index UUID: {status}"
			)));
		}
		bytes[..4].copy_from_slice(&guid.data1.to_be_bytes());
		bytes[4..6].copy_from_slice(&guid.data2.to_be_bytes());
		bytes[6..8].copy_from_slice(&guid.data3.to_be_bytes());
		bytes[8..].copy_from_slice(&guid.data4);
	}
	#[cfg(not(any(unix, windows)))]
	{
		return Err(WikiError::message(
			"Document import UUID generation is unsupported on this platform",
		));
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	Ok(format!(
		"{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:\
		 02x}{:02x}",
		bytes[0],
		bytes[1],
		bytes[2],
		bytes[3],
		bytes[4],
		bytes[5],
		bytes[6],
		bytes[7],
		bytes[8],
		bytes[9],
		bytes[10],
		bytes[11],
		bytes[12],
		bytes[13],
		bytes[14],
		bytes[15]
	))
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	struct Fixture {
		directory:     PathBuf,
		database_path: String,
	}
	impl Fixture {
		fn new() -> Self {
			let directory = std::env::temp_dir().join(format!(
				"omp-wiki-import-lock-{}-{}",
				std::process::id(),
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap()
					.as_nanos()
			));
			fs::create_dir_all(&directory).unwrap();
			let database_path = directory.join("docs.db").to_string_lossy().into_owned();
			fs::write(&database_path, []).unwrap();
			Self { directory, database_path }
		}
	}
	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.directory);
		}
	}

	#[test]
	fn physical_database_aliases_share_the_exclusive_lease() {
		let mut fixture = Fixture::new();
		let original = fixture.database_path.clone();
		let alias = fixture.directory.join("alias.db");
		fs::hard_link(&original, &alias).unwrap();
		let original_identity = crate::database::file_identity(Path::new(&original)).unwrap();
		let alias_identity = crate::database::file_identity(&alias).unwrap();
		assert_eq!(lease_path(&original_identity), lease_path(&alias_identity));
		let mut holder = acquire(&fixture.database_path, &|| Ok(()), &original_identity)
			.unwrap()
			.unwrap();
		fixture.database_path = alias.to_string_lossy().into_owned();
		assert!(
			acquire(&fixture.database_path, &|| Ok(()), &alias_identity)
				.unwrap()
				.is_none()
		);
		holder.release_native().unwrap();
		let mut successor = acquire(&fixture.database_path, &|| Ok(()), &alias_identity)
			.unwrap()
			.unwrap();
		successor.release_native().unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_directory_alias_shares_the_exclusive_lease() {
		let mut fixture = Fixture::new();
		let alias_directory = fixture.directory.join("alias");
		std::os::unix::fs::symlink(&fixture.directory, &alias_directory).unwrap();
		let (_, identity) = import_lease(&fixture.database_path).unwrap();
		let mut holder = acquire(&fixture.database_path, &|| Ok(()), &identity)
			.unwrap()
			.unwrap();
		fixture.database_path = alias_directory
			.join("docs.db")
			.to_string_lossy()
			.into_owned();
		let alias_identity =
			crate::database::file_identity(Path::new(&fixture.database_path)).unwrap();
		assert_eq!(lease_path(&identity), lease_path(&alias_identity));
		assert!(
			acquire(&fixture.database_path, &|| Ok(()), &alias_identity)
				.unwrap()
				.is_none()
		);
		holder.release_native().unwrap();
	}

	#[cfg(windows)]
	#[test]
	fn differently_cased_database_alias_shares_the_exclusive_lease() {
		let mut fixture = Fixture::new();
		let (_, identity) = import_lease(&fixture.database_path).unwrap();
		let mut holder = acquire(&fixture.database_path, &|| Ok(()), &identity)
			.unwrap()
			.unwrap();
		fixture.database_path = fixture
			.directory
			.join("DOCS.DB")
			.to_string_lossy()
			.into_owned();
		let alias_identity =
			crate::database::file_identity(Path::new(&fixture.database_path)).unwrap();
		assert_eq!(lease_path(&identity), lease_path(&alias_identity));
		assert!(
			acquire(&fixture.database_path, &|| Ok(()), &alias_identity)
				.unwrap()
				.is_none()
		);
		holder.release_native().unwrap();
	}
}
