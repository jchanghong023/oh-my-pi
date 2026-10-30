//! The exclusive import lease owns hidden rows until full publication or
//! rollback.
use std::sync::Arc;
#[cfg(test)]
use std::{path::Path, time::Instant};

use napi::{
	Env, Error, Result, Status,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use pi_wiki::importer as core;
#[cfg(test)]
use {pi_vfs::file_lock::FileLock, pi_wiki::import};

use super::{
	Owner,
	database::{WikiError, WikiErrorNapi},
	diagnostics::{self, DiagnosticCallback, WikiDiagnosticEvent},
	storage::WikiIndexSummary,
};
use crate::task::CancelToken;

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
fn callback_failure(value: diagnostics::CallbackFailure) -> core::CallbackFailure<Error> {
	core::CallbackFailure { error: value.error, error_type: value.error_type }
}

fn callback_error(error: Error) -> core::CallbackFailure<Error> {
	core::CallbackFailure { error, error_type: "Error".into() }
}

fn import_error(value: core::ImportError<Error>) -> ImportError {
	match value {
		core::ImportError::Core(error) => ImportError::Core(error),
		core::ImportError::Callback(failure) => {
			ImportError::Callback(failure.error, failure.error_type)
		},
	}
}

fn with_hooks<T>(
	owner: &Owner,
	cancel: &CancelToken,
	progress: Option<&ProgressCallback>,
	diagnostic: Option<&DiagnosticCallback>,
	at_callback: Option<&dyn Fn(&str)>,
	work: impl FnOnce(&core::ImportHooks<'_, Error>) -> T,
) -> T {
	let check = || owner.check_import(cancel);
	let identity = || owner.with_storage(cancel, |storage| Ok(storage.identity().to_owned()));
	let with_storage = |database: &str,
	                    operation: &mut dyn FnMut(
		&pi_wiki::storage::Storage,
	) -> std::result::Result<(), WikiError>| {
		owner.with_import_storage(cancel, database, operation)
	};
	let rollback = |build: &pi_wiki::storage::BuildIdentity| owner.rollback(build);
	let flush = || diagnostics::flush_async(&owner.diagnostics, diagnostic).map_err(callback_error);
	let event = |event: core::WikiDiagnosticEvent| {
		if let Some(hook) = at_callback {
			hook(&event.message);
		}
		if let Some(callback) = diagnostic {
			diagnostics::acknowledge(callback, WikiDiagnosticEvent {
				message:               event.message,
				level:                 event.level,
				component:             event.component,
				event:                 event.event,
				stage:                 event.stage,
				result:                event.result,
				elapsed_ms:            event.elapsed_ms,
				file_count:            event.file_count,
				document_count:        event.document_count,
				section_count:         event.section_count,
				index_count:           event.index_count,
				abandoned_index_count: event.abandoned_index_count,
				retry_limit:           event.retry_limit,
				schema_version:        event.schema_version,
				supported_version:     event.supported_version,
				from_version:          event.from_version,
				to_version:            event.to_version,
				index_id:              event.index_id,
				index_hash:            event.index_hash,
				cleanup:               event.cleanup,
				rollback:              event.rollback,
				failed_stage:          event.failed_stage,
				reason:                event.reason,
				error_type:            event.error_type,
				error_code:            event.error_code,
				error_errno:           event.error_errno,
			})
			.map_err(callback_error)?;
		}
		Ok(())
	};
	let progress_hook = |value: core::WikiBuildProgress| {
		let hook_phase = at_callback.map(|_| value.phase.clone());
		if let Some(callback) = progress {
			diagnostics::acknowledge_named(callback, WikiBuildProgress {
				phase:        value.phase,
				total:        value.total,
				completed:    value.completed,
				failed:       value.failed,
				current_path: value.current_path,
			})
			.map_err(callback_failure)?;
		}
		if let (Some(hook), Some(phase)) = (at_callback, hook_phase) {
			hook(&phase);
		}
		Ok(())
	};
	work(&core::ImportHooks {
		database_path: &owner.database_path,
		check:         &check,
		identity:      &identity,
		with_storage:  &with_storage,
		rollback:      &rollback,
		flush:         &flush,
		event:         &event,
		progress:      &progress_hook,
	})
}

fn result_from_core(value: core::WikiBuildResult) -> WikiBuildResult {
	WikiBuildResult {
		processed: value.processed,
		failed:    value.failed,
		index:     value.index.into(),
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
	with_hooks(owner, cancel, progress, diagnostic, None, |hooks| {
		core::run(hooks, root, name)
			.map(result_from_core)
			.map_err(import_error)
	})
}

#[cfg(test)]
struct Build<'a> {
	owner:          &'a Owner,
	cancel:         &'a CancelToken,
	at_callback:    Option<&'a dyn Fn(&str)>,
	published:      bool,
	lock_contended: bool,
}
#[cfg(test)]
impl Build<'_> {
	fn build(
		&mut self,
		root: &str,
		name: &str,
	) -> std::result::Result<WikiBuildResult, ImportError> {
		with_hooks(self.owner, self.cancel, None, None, self.at_callback, |hooks| {
			let mut build = core::Build::new(hooks);
			let result = build.build(root, name);
			self.published = build.published;
			result.map(result_from_core).map_err(import_error)
		})
	}

	fn acquire_lease(
		&mut self,
		started: Instant,
		database: &str,
	) -> std::result::Result<FileLock, ImportError> {
		with_hooks(self.owner, self.cancel, None, None, self.at_callback, |hooks| {
			let mut build = core::Build::new(hooks);
			let result = build.acquire_lease(started, database);
			self.lock_contended = build.lock_contended;
			result.map_err(import_error)
		})
	}
}
pub(super) use core::import_lease;
#[cfg(test)]
use core::lease_path;
#[cfg(test)]
fn acquire(
	owner: &Owner,
	cancel: &CancelToken,
	database: &str,
) -> std::result::Result<Option<FileLock>, WikiError> {
	core::acquire(&owner.database_path, &|| owner.check_import(cancel), database)
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
				at_callback: None,
				published: false,
				lock_contended: false,
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

	fn core_error(result: std::result::Result<FileLock, ImportError>) -> WikiError {
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
				"sqlite_master",
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
	fn first_callback_replacement_preserves_legacy_database_evidence() {
		callback_replacement_preserves_legacy_evidence("docs.init.started");
	}

	#[cfg(any(unix, windows))]
	#[test]
	fn prescan_callback_replacement_preserves_legacy_database_evidence() {
		callback_replacement_preserves_legacy_evidence("docs.init.scan.started");
	}

	#[cfg(any(unix, windows))]
	#[test]
	fn separate_imports_reopen_a_legitimately_replaced_profile() {
		let mut fixture = Fixture::new();
		let original = fixture.directory.join("original");
		let replacement = fixture.directory.join("replacement");
		let source = fixture.directory.join("source");
		for directory in [&original, &replacement, &source] {
			fs::create_dir(directory).unwrap();
		}
		fs::rename(&fixture.owner.database_path, original.join("docs.db")).unwrap();
		fs::write(replacement.join("docs.db"), []).unwrap();
		fs::write(source.join("document.md"), "# Document\nsearchable evidence\n").unwrap();
		let alias = ProfileAlias(fixture.directory.join("profile"));
		alias.point_to(&original);
		fixture.owner.database_path = alias.0.join("docs.db").to_string_lossy().into_owned();
		let cancel = CancelToken::default();
		let first = match fixture
			.build(&cancel)
			.build(source.to_str().unwrap(), "first")
		{
			Ok(result) => result,
			Err(_) => panic!("first import failed"),
		};
		assert_eq!(first.processed, 1);
		assert_eq!(first.index.name, "first");

		alias.point_to(&replacement);
		let second = match fixture
			.build(&cancel)
			.build(source.to_str().unwrap(), "second")
		{
			Ok(result) => result,
			Err(_) => panic!("import after profile replacement failed"),
		};
		assert_eq!(second.processed, 1);
		assert_eq!(second.index.name, "second");
		let indexes = fixture
			.owner
			.with_storage(&cancel, |storage| storage.list())
			.unwrap();
		assert_eq!(indexes.len(), 1);
		assert_eq!(indexes[0].name, "second");
		let original_db = rusqlite::Connection::open_with_flags(
			original.join("docs.db"),
			rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
		)
		.unwrap();
		let original_names = original_db
			.prepare("SELECT name FROM doc_indexes ORDER BY id")
			.unwrap()
			.query_map([], |row| row.get::<_, String>(0))
			.unwrap()
			.collect::<rusqlite::Result<Vec<_>>>()
			.unwrap();
		assert_eq!(original_names, ["first"]);
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
		let error = core_error(build.acquire_lease(Instant::now(), "missing"));
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
		let error = core_error(build.acquire_lease(Instant::now(), &identity));
		assert_eq!(
			error.error_message(),
			format!(
				"Another document index build is already running for this profile: {}",
				fixture.owner.database_path
			)
		);
		assert!(build.lock_contended);
		holder.release_native().unwrap();
		let mut successor = acquire(&fixture.owner, &cancel, &identity)
			.unwrap()
			.unwrap();
		assert!(successor.is_acquired());
		successor.release_native().unwrap();
	}

	#[test]
	fn cancellation_takes_priority_over_database_identity_failure() {
		let fixture = Fixture::new();
		fs::remove_file(&fixture.owner.database_path).unwrap();
		let mut cancel = CancelToken::default();
		cancel.emplace_abort_token().abort(AbortReason::Signal);
		let mut build = fixture.build(&cancel);
		let error = core_error(build.acquire_lease(Instant::now(), "missing"));
		assert_eq!(error.diagnostic_error_type(), "AbortError");
		assert!(!build.lock_contended);
	}
}
