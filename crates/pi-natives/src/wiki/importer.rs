//! The exclusive import lease owns hidden rows until full publication or
//! rollback.
use std::{
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant},
};

use napi::{
	Env, Error, Result, Status,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use sha2::{Digest, Sha256};

use super::{
	Owner,
	database::WikiError,
	diagnostics::{self, DiagnosticCallback, WikiDiagnosticEvent},
	import,
	storage::{BUILDING_INDEX_PREFIX, BuildIdentity, WikiIndexSummary},
};
use crate::{file_lock::FileLock, task::CancelToken};

#[napi(object, object_from_js = false)]
pub struct WikiBuildProgress {
	pub phase:        String,
	pub total:        i64,
	pub completed:    i64,
	pub failed:       i64,
	pub current_path: Option<String>,
}
#[napi(object, object_from_js = false)]
pub struct WikiBuildResult {
	pub processed: i64,
	pub failed:    i64,
	pub index:     WikiIndexSummary,
}
pub(super) type ProgressFunction<'a> = Function<'a, WikiBuildProgress, UnknownReturnValue>;
pub(super) type ProgressCallback = ThreadsafeFunction<
	WikiBuildProgress,
	UnknownReturnValue,
	WikiBuildProgress,
	Status,
	false,
	false,
>;

pub enum ImportError {
	Core(WikiError),
	Callback(Error, String),
}
impl From<WikiError> for ImportError {
	fn from(value: WikiError) -> Self {
		Self::Core(value)
	}
}
impl From<Error> for ImportError {
	fn from(value: Error) -> Self {
		Self::Callback(value, "Error".into())
	}
}
impl From<diagnostics::CallbackFailure> for ImportError {
	fn from(value: diagnostics::CallbackFailure) -> Self {
		Self::Callback(value.error, value.error_type)
	}
}
impl ImportError {
	pub(super) fn into_napi(env: Env, error: Self) -> Error {
		match error {
			Self::Core(error) => error.into_napi(env),
			Self::Callback(error, _) => error,
		}
	}

	fn cancelled(&self) -> bool {
		match self {
			Self::Core(error) => error.diagnostic_error_type() == "AbortError",
			Self::Callback(_, name) => name == "AbortError",
		}
	}

	fn annotate(&self, event: &mut WikiDiagnosticEvent) {
		match self {
			Self::Core(error) => event.error(error),
			Self::Callback(_, name) => event.error_type = Some(name.clone()),
		}
	}
}
pub(super) fn cancel_error(env: Env, _reason: crate::task::AbortReason) -> Error {
	WikiError::named("Document indexing cancelled", "AbortError", None).into_napi(env)
}
pub struct WikiImportOutput {
	pub(super) owner:  Arc<Owner>,
	pub(super) cancel: CancelToken,
	pub(super) result: WikiBuildResult,
}
impl TypeName for WikiImportOutput {
	fn type_name() -> &'static str {
		WikiBuildResult::type_name()
	}

	fn value_type() -> napi::ValueType {
		WikiBuildResult::value_type()
	}
}
impl ToNapiValue for WikiImportOutput {
	unsafe fn to_napi_value(env: napi::sys::napi_env, value: Self) -> Result<napi::sys::napi_value> {
		let wrapper = Env::from_raw(env);
		value
			.owner
			.check_import(&value.cancel)
			.map_err(|error| error.into_napi(wrapper))?;
		// SAFETY: N-API supplies the live env for this conversion; the owned
		// result is converted only after the retained owner's
		// import/cancellation check.
		unsafe { WikiBuildResult::to_napi_value(env, value.result) }
	}
}
struct Build<'a> {
	owner:          &'a Owner,
	cancel:         &'a CancelToken,
	diagnostic:     Option<&'a DiagnosticCallback>,
	progress:       Option<&'a ProgressCallback>,
	started:        Instant,
	stage:          &'static str,
	documents:      i64,
	sections:       i64,
	files:          i64,
	cleanup:        &'static str,
	reason:         Option<&'static str>,
	published:      bool,
	lock_contended: bool,
	#[cfg(test)]
	at_callback:    Option<&'a dyn Fn(&str)>,
}
impl Build<'_> {
	fn event(&self, message: &str, stage: &str, result: &str) -> WikiDiagnosticEvent {
		let mut event =
			WikiDiagnosticEvent::operation(message, "docs.init", stage, result, self.started);
		event.file_count = Some(self.files);
		event.document_count = Some(self.documents);
		event.section_count = Some(self.sections);
		event
	}

	fn emit(&self, event: WikiDiagnosticEvent) -> std::result::Result<(), ImportError> {
		// Storage SQL diagnostics are enqueued under the owner mutex and
		// delivered only after it has been released. This also covers
		// failed statements.
		diagnostics::flush_async(&self.owner.diagnostics, self.diagnostic)?;
		#[cfg(test)]
		if let Some(hook) = self.at_callback {
			hook(&event.message);
		}
		if let Some(callback) = self.diagnostic {
			diagnostics::acknowledge(callback, event)?;
		}
		Ok(())
	}

	fn log(&self, message: &str, stage: &str, result: &str) -> std::result::Result<(), ImportError> {
		self.emit(self.event(message, stage, result))
	}

	fn progress(&self, phase: &str, path: Option<String>) -> std::result::Result<(), ImportError> {
		diagnostics::flush_async(&self.owner.diagnostics, self.diagnostic)?;
		if let Some(callback) = self.progress {
			diagnostics::acknowledge_named(callback, WikiBuildProgress {
				phase:        phase.into(),
				total:        self.files,
				completed:    self.documents,
				failed:       0,
				current_path: path,
			})?;
		}
		#[cfg(test)]
		if let Some(hook) = self.at_callback {
			hook(phase);
		}
		Ok(())
	}

	fn check(&self) -> std::result::Result<(), ImportError> {
		self.owner.check_import(self.cancel).map_err(Into::into)
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
	) -> std::result::Result<WikiBuildResult, ImportError> {
		self.progress("scan", None)?;
		self.stage = "read_parse";
		self.log("docs.init.ingest.started", self.stage, "started")?;
		let mut read_ms = 0.0;
		let mut fts_ms = 0.0;
		for relative in files {
			self.check()?;
			self.stage = "read_parse";
			let started = Instant::now();
			let document = match import::read_markdown_document(root, &relative, &|| {
				self.owner.check_import(self.cancel)
			}) {
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
			self
				.owner
				.with_import_storage(self.cancel, database, |storage| {
					storage.commit_document(build, &document, &|| self.owner.check_import(self.cancel))
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
		let index = self
			.owner
			.with_import_storage(self.cancel, database, |storage| storage.promote(build, name))?;
		self.published = true;
		Ok(WikiBuildResult { processed: self.documents, failed: 0, index })
	}

	fn rollback(
		&mut self,
		build: &BuildIdentity,
		error: ImportError,
	) -> std::result::Result<WikiBuildResult, ImportError> {
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
		match self.owner.rollback(build) {
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
	) -> std::result::Result<WikiBuildResult, ImportError> {
		self.check()?;
		self.stage = "validate";
		if self
			.owner
			.with_import_storage(self.cancel, database, |storage| storage.get(name))?
			.is_some()
		{
			self.reason = Some("duplicate_name");
			return Err(WikiError::message(format!("Document index already exists: {name}")).into());
		}
		self.stage = "recovery";
		self
			.owner
			.with_import_storage(self.cancel, database, |storage| storage.remove_abandoned())?;
		self.stage = "create";
		let hidden = format!("{BUILDING_INDEX_PREFIX}{}", build_uuid()?);
		let root = root.to_string_lossy();
		let temp = self
			.owner
			.with_import_storage(self.cancel, database, |storage| storage.create(&hidden, &root))?;
		match self.ingest(&temp, database, Path::new(root.as_ref()), files, name) {
			Ok(result) => Ok(result),
			Err(error) => self.rollback(&temp, error),
		}
	}

	fn acquire_lease(
		&mut self,
		started: Instant,
	) -> std::result::Result<(FileLock, String), ImportError> {
		let mut event = self.event("docs.init.lock.started", self.stage, "started");
		event.retry_limit = Some(3);
		self.emit(event)?;
		let (error, result, level) = match acquire(self.owner, self.cancel) {
			Ok(Some(lease)) => return Ok(lease),
			Ok(None) => {
				self.lock_contended = true;
				(
					WikiError::message(format!(
						"Another document index build is already running for this profile: {}",
						self.owner.database_path
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

	fn build(
		&mut self,
		root: &str,
		name: &str,
	) -> std::result::Result<WikiBuildResult, ImportError> {
		self.log("docs.init.started", self.stage, "started")?;
		self.check()?;
		self.stage = "name_validation";
		let name = validate_name(name)?;
		self.stage = "validate";
		if self
			.owner
			.with_storage(self.cancel, |storage| storage.get(name))?
			.is_some()
		{
			self.reason = Some("duplicate_name");
			return Err(WikiError::message(format!("Document index already exists: {name}")).into());
		}
		let root = import::resolve_root(Path::new(root))?;
		self.stage = "scan";
		let started = Instant::now();
		self.log("docs.init.scan.started", self.stage, "started")?;
		let files =
			import::enumerate_markdown_files(&root, &|| self.owner.check_import(self.cancel))?;
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
		let (mut lease, database) = self.acquire_lease(started)?;
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
pub(super) fn run(
	owner: &Owner,
	root: &str,
	name: &str,
	cancel: &CancelToken,
	progress: Option<&ProgressCallback>,
	diagnostic: Option<&DiagnosticCallback>,
) -> std::result::Result<WikiBuildResult, ImportError> {
	let mut build = Build {
		owner,
		cancel,
		diagnostic,
		progress,
		started: Instant::now(),
		stage: "validate",
		documents: 0,
		sections: 0,
		files: 0,
		cleanup: "not_needed",
		reason: None,
		published: false,
		lock_contended: false,
		#[cfg(test)]
		at_callback: None,
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
	let flushed = diagnostics::flush_async(&owner.diagnostics, diagnostic);
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
fn lease_path(identity: &str) -> PathBuf {
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
pub(super) fn import_lease(
	database_path: &str,
) -> std::result::Result<(PathBuf, String), WikiError> {
	let path = import::resolve_root(Path::new(database_path))?;
	let identity = super::database::file_identity(&path)?;
	Ok((lease_path(&identity), identity))
}
fn acquire(
	owner: &Owner,
	cancel: &CancelToken,
) -> std::result::Result<Option<(FileLock, String)>, WikiError> {
	owner.check_import(cancel)?;
	let (lock_path, identity) = import_lease(&owner.database_path)?;
	for attempt in 0..3 {
		owner.check_import(cancel)?;
		let lease = FileLock::try_acquire_path(&lock_path)?;
		if lease.is_acquired() {
			return Ok(Some((lease, identity)));
		}
		if attempt < 2 {
			for _ in 0..10 {
				owner.check_import(cancel)?;
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
	use std::{
		fs,
		path::PathBuf,
		sync::atomic::{AtomicBool, AtomicUsize},
	};

	use parking_lot::Mutex;

	use super::*;
	use crate::{
		task::AbortReason,
		wiki::{StorageState, database::DatabaseEngine},
	};

	struct Fixture {
		directory: PathBuf,
		owner:     Owner,
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
			let path = directory.join("docs.db").to_string_lossy().into_owned();
			fs::write(&path, []).unwrap();
			Self {
				directory,
				owner: Owner {
					closed:        Arc::new(AtomicBool::new(false)),
					imports:       AtomicUsize::new(1),
					engine:        Mutex::new(DatabaseEngine::new(path.clone(), path.clone())),
					storage:       Mutex::new(StorageState { storage: None, identity: String::new() }),
					database_path: path,
					diagnostics:   Arc::new(Mutex::new(Vec::new())),
				},
			}
		}

		fn build<'a>(&'a self, cancel: &'a CancelToken) -> Build<'a> {
			Build {
				owner: &self.owner,
				cancel,
				diagnostic: None,
				progress: None,
				started: Instant::now(),
				stage: "lock",
				documents: 0,
				sections: 0,
				files: 1,
				cleanup: "not_needed",
				reason: None,
				published: false,
				lock_contended: false,
				at_callback: None,
			}
		}
	}

	impl Drop for Fixture {
		fn drop(&mut self) {
			self.owner.storage.lock().storage = None;
			self.owner.engine.lock().close();
			let _ = fs::remove_dir_all(&self.directory);
		}
	}

	fn core_error(result: std::result::Result<(FileLock, String), ImportError>) -> WikiError {
		match result {
			Err(ImportError::Core(error)) => error,
			Err(ImportError::Callback(..)) => panic!("unexpected callback failure"),
			Ok(_) => panic!("lock acquisition unexpectedly succeeded"),
		}
	}

	#[cfg(any(unix, windows))]
	struct ProfileAlias(PathBuf);

	#[cfg(any(unix, windows))]
	impl ProfileAlias {
		fn point_to(&self, target: &Path) {
			if fs::symlink_metadata(&self.0).is_ok() {
				self.remove();
			}
			#[cfg(unix)]
			std::os::unix::fs::symlink(target, &self.0).unwrap();
			#[cfg(windows)]
			{
				let output = std::process::Command::new("cmd.exe")
					.args(["/D", "/C", "mklink", "/J"])
					.arg(&self.0)
					.arg(target)
					.output()
					.unwrap();
				assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
			}
		}

		fn remove(&self) {
			#[cfg(unix)]
			fs::remove_file(&self.0).unwrap();
			#[cfg(windows)]
			fs::remove_dir(&self.0).unwrap();
		}
	}

	#[cfg(any(unix, windows))]
	impl Drop for ProfileAlias {
		fn drop(&mut self) {
			if fs::symlink_metadata(&self.0).is_ok() {
				self.remove();
			}
		}
	}

	#[cfg(any(unix, windows))]
	fn callback_replacement_preserves_legacy_evidence(boundary: &str) {
		use rusqlite::{Connection, types::Value};

		let mut fixture = Fixture::new();
		let original = fixture.directory.join("original");
		let replacement = fixture.directory.join("replacement");
		let source = fixture.directory.join("source");
		for directory in [&original, &replacement, &source] {
			fs::create_dir(directory).unwrap();
		}
		fs::rename(&fixture.owner.database_path, original.join("docs.db")).unwrap();
		// Two documents ensure fts progress is followed by another commit;
		// the final diagnostic boundary instead precedes publication.
		fs::write(source.join("first.md"), "# First\noriginal first evidence\n").unwrap();
		fs::write(source.join("second.md"), "# Second\noriginal second evidence\n").unwrap();
		let replacement_path = replacement.join("docs.db");
		{
			let db = Connection::open(&replacement_path).unwrap();
			db.execute_batch(include_str!(
				"../../../../packages/coding-agent/test/fixtures/docs-v3.sql"
			))
			.unwrap();
			db.execute_batch(
				"INSERT INTO \
				 doc_indexes(id,name,root_path,schema_id,schema_version,schema_json,schema_hash,mode,\
				 state,created_at,updated_at) \
				 VALUES(1,'retained','/missing-source','dft',1,'{}','old','structured','ready','a','b'\
				 ); INSERT INTO \
				 documents(id,index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms,\
				 status) VALUES(1,1,'retained.md','Retained','markdown','retained-hash',27,0,'ready'); \
				 INSERT INTO sections VALUES(1,1,1,0,'Retained',1,1,2,0,27,'# Retained\nlegacy \
				 evidence\n'); INSERT INTO entities VALUES(1,1,'item','legacy','Legacy'); INSERT INTO \
				 evidence(index_id,section_id,entity_id,quote,line_start,line_end,byte_start,byte_end,\
				 confidence) VALUES(1,1,1,'legacy evidence',2,2,11,26,1); INSERT INTO \
				 sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) \
				 VALUES(1,1,1,'retained.md','Retained','legacy stale projection'); PRAGMA \
				 wal_checkpoint(TRUNCATE);",
			)
			.unwrap();
		}
		// Read with raw SQLite only: opening through Owner/Storage would itself
		// migrate the old database and destroy the evidence under test.
		let snapshot = || {
			let db = Connection::open_with_flags(
				&replacement_path,
				rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
			)
			.unwrap();
			let version: i64 = db
				.query_row("PRAGMA user_version", [], |row| row.get(0))
				.unwrap();
			let tables = [
				"doc_indexes",
				"documents",
				"sections",
				"entities",
				"entity_aliases",
				"assertions",
				"relations",
				"evidence",
				"sections_fts",
				"sections_fts_data",
				"sections_fts_idx",
				"sections_fts_docsize",
				"sections_fts_config",
			]
			.map(|table| -> std::result::Result<Vec<Vec<Value>>, String> {
				let sql = if matches!(table, "sections_fts_idx" | "sections_fts_config") {
					format!("SELECT * FROM {table} ORDER BY 1,2")
				} else {
					format!("SELECT rowid,* FROM {table} ORDER BY rowid")
				};
				let mut statement = db.prepare(&sql).map_err(|error| error.to_string())?;
				let columns = statement.column_count();
				let rows = statement
					.query_map([], |row| {
						(0..columns)
							.map(|column| row.get(column))
							.collect::<rusqlite::Result<Vec<Value>>>()
					})
					.map_err(|error| error.to_string())?;
				rows
					.collect::<rusqlite::Result<Vec<_>>>()
					.map_err(|error| error.to_string())
			});
			(version, tables)
		};
		let retained = snapshot();
		assert_eq!(retained.0, 3);
		assert!(retained.1.iter().all(std::result::Result::is_ok));
		let alias = ProfileAlias(fixture.directory.join("profile"));
		alias.point_to(&original);
		fixture.owner.database_path = alias.0.join("docs.db").to_string_lossy().into_owned();
		let swapped = AtomicBool::new(false);
		let hook = |event: &str| {
			if event == boundary && !swapped.swap(true, std::sync::atomic::Ordering::SeqCst) {
				// No list/search reentry: only the stale importer may touch the
				// replacement, and it has no lease for that physical database.
				alias.point_to(&replacement);
			}
		};
		let cancel = CancelToken::default();
		let mut build = fixture.build(&cancel);
		build.at_callback = Some(&hook);
		let result = build.build(source.to_str().unwrap(), "old-import");
		assert!(swapped.load(std::sync::atomic::Ordering::SeqCst));
		match result {
			Err(ImportError::Core(error)) => assert_eq!(
				error.error_message(),
				"Documentation database changed during document indexing"
			),
			Err(ImportError::Callback(..)) => panic!("unexpected callback failure"),
			Ok(_) => panic!("stale import unexpectedly published"),
		}
		assert!(!build.published);
		assert_eq!(
			snapshot(),
			retained,
			"rejecting the stale import must not migrate schema/FTS or delete structured evidence"
		);
	}

	#[cfg(any(unix, windows))]
	#[test]
	fn scan_callback_replacement_preserves_legacy_database_evidence() {
		callback_replacement_preserves_legacy_evidence("scan");
	}

	#[cfg(any(unix, windows))]
	#[test]
	fn fts_callback_replacement_preserves_legacy_database_evidence() {
		callback_replacement_preserves_legacy_evidence("fts");
	}

	#[cfg(any(unix, windows))]
	#[test]
	fn prepublish_callback_replacement_preserves_legacy_database_evidence() {
		callback_replacement_preserves_legacy_evidence("docs.init.fts.completed");
	}

	#[test]
	fn missing_database_identity_preserves_original_lock_failure() {
		let fixture = Fixture::new();
		fs::remove_file(&fixture.owner.database_path).unwrap();
		let original = super::super::database::file_identity(Path::new(&fixture.owner.database_path))
			.unwrap_err();
		let cancel = CancelToken::default();
		let mut build = fixture.build(&cancel);
		let error = core_error(build.acquire_lease(Instant::now()));
		assert_eq!(error.error_message(), original.error_message());
		assert_eq!(error.diagnostic_error_type(), original.diagnostic_error_type());
		assert_eq!(error.diagnostic_code(), original.diagnostic_code());
		assert!(!build.lock_contended);
	}

	#[test]
	fn held_import_lease_reports_contention_and_allows_successor_after_release() {
		let fixture = Fixture::new();
		let path = import::resolve_root(Path::new(&fixture.owner.database_path)).unwrap();
		let identity = super::super::database::file_identity(&path).unwrap();
		let mut holder = FileLock::try_acquire_path(&lease_path(&identity)).unwrap();
		assert!(holder.is_acquired());
		let cancel = CancelToken::default();
		let mut build = fixture.build(&cancel);
		let error = core_error(build.acquire_lease(Instant::now()));
		assert_eq!(
			error.error_message(),
			format!(
				"Another document index build is already running for this profile: {}",
				fixture.owner.database_path
			)
		);
		assert!(build.lock_contended);
		holder.release_native().unwrap();
		let (mut successor, database) = acquire(&fixture.owner, &cancel).unwrap().unwrap();
		assert!(successor.is_acquired());
		assert_eq!(database, identity);
		successor.release_native().unwrap();
	}

	#[test]
	fn physical_database_aliases_share_the_exclusive_lease() {
		let mut fixture = Fixture::new();
		let original = fixture.owner.database_path.clone();
		let alias = fixture.directory.join("alias.db");
		fs::hard_link(&original, &alias).unwrap();
		let original_identity = super::super::database::file_identity(Path::new(&original)).unwrap();
		let alias_identity = super::super::database::file_identity(&alias).unwrap();
		assert_eq!(lease_path(&original_identity), lease_path(&alias_identity));
		let cancel = CancelToken::default();
		let (mut holder, _) = acquire(&fixture.owner, &cancel).unwrap().unwrap();
		fixture.owner.database_path = alias.to_string_lossy().into_owned();
		assert!(acquire(&fixture.owner, &cancel).unwrap().is_none());
		holder.release_native().unwrap();
		let (mut successor, identity) = acquire(&fixture.owner, &cancel).unwrap().unwrap();
		assert_eq!(identity, original_identity);
		successor.release_native().unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_directory_alias_shares_the_exclusive_lease() {
		let mut fixture = Fixture::new();
		let alias_directory = fixture.directory.join("alias");
		std::os::unix::fs::symlink(&fixture.directory, &alias_directory).unwrap();
		let cancel = CancelToken::default();
		let (mut holder, identity) = acquire(&fixture.owner, &cancel).unwrap().unwrap();
		fixture.owner.database_path = alias_directory
			.join("docs.db")
			.to_string_lossy()
			.into_owned();
		let alias_identity =
			super::super::database::file_identity(Path::new(&fixture.owner.database_path)).unwrap();
		assert_eq!(lease_path(&identity), lease_path(&alias_identity));
		assert!(acquire(&fixture.owner, &cancel).unwrap().is_none());
		holder.release_native().unwrap();
	}

	#[cfg(windows)]
	#[test]
	fn differently_cased_database_alias_shares_the_exclusive_lease() {
		let mut fixture = Fixture::new();
		let cancel = CancelToken::default();
		let (mut holder, identity) = acquire(&fixture.owner, &cancel).unwrap().unwrap();
		fixture.owner.database_path = fixture
			.directory
			.join("DOCS.DB")
			.to_string_lossy()
			.into_owned();
		let alias_identity =
			super::super::database::file_identity(Path::new(&fixture.owner.database_path)).unwrap();
		assert_eq!(lease_path(&identity), lease_path(&alias_identity));
		assert!(acquire(&fixture.owner, &cancel).unwrap().is_none());
		holder.release_native().unwrap();
	}

	#[test]
	fn cancellation_takes_priority_over_database_identity_failure() {
		let fixture = Fixture::new();
		fs::remove_file(&fixture.owner.database_path).unwrap();
		let mut cancel = CancelToken::default();
		cancel.emplace_abort_token().abort(AbortReason::Signal);
		let mut build = fixture.build(&cancel);
		let error = core_error(build.acquire_lease(Instant::now()));
		assert_eq!(error.diagnostic_error_type(), "AbortError");
		assert!(!build.lock_contended);
	}
}
