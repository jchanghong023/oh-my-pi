//! Owner-scoped documentation storage, importing, and complete-ranking search.
mod database;
mod diagnostics;
mod grep;
mod import;
mod importer;
pub(crate) mod markdown;
mod page;
pub(crate) mod query;
mod storage;

use std::{
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use database::{DatabaseEngine, WikiError, WikiSearchOptions, WikiSearchOutput};
use diagnostics::{DiagnosticFunction, DiagnosticQueue, WikiDiagnosticEvent};
use importer::{ImportError, ProgressFunction, WikiImportOutput};
use napi::{Env, Error, Result, Status, bindgen_prelude::*};
use napi_derive::napi;
use parking_lot::Mutex;
use storage::{BuildIdentity, Storage, WikiIndexSummary};

use crate::task::{self, CancelToken};

type CoreResult<T> = std::result::Result<T, WikiError>;
struct StorageState {
	storage:  Option<Storage>,
	identity: String,
}
struct Owner {
	closed:        Arc<AtomicBool>,
	imports:       AtomicUsize,
	engine:        Mutex<DatabaseEngine>,
	storage:       Mutex<StorageState>,
	database_path: String,
	diagnostics:   DiagnosticQueue,
}
struct ImportGuard(Arc<Owner>);
impl Drop for ImportGuard {
	fn drop(&mut self) {
		if self.0.imports.fetch_sub(1, Ordering::AcqRel) == 1 && self.0.closed.load(Ordering::Acquire)
		{
			self.0.storage.lock().storage = None;
		}
	}
}
impl Owner {
	fn check(&self, cancel: &CancelToken) -> CoreResult<()> {
		if self.closed.load(Ordering::Acquire) {
			return Err(WikiError::message("Documentation search engine is closed"));
		}
		cancel
			.heartbeat()
			.map_err(|error| WikiError::message(error.reason))
	}

	fn check_import(&self, cancel: &CancelToken) -> CoreResult<()> {
		if self.closed.load(Ordering::Acquire) {
			return Err(WikiError::message("Documentation search engine is closed"));
		}
		if cancel.aborted() {
			return Err(WikiError::named("Document indexing cancelled", "AbortError", None));
		}
		Ok(())
	}

	/// Each operation borrows the one storage connection only while executing
	/// SQL. No JavaScript callback, scan, read, or lease wait holds this
	/// mutex.
	fn with_storage<T>(
		&self,
		cancel: &CancelToken,
		work: impl FnOnce(&Storage) -> CoreResult<T>,
	) -> CoreResult<T> {
		let mut state = loop {
			self.check_import(cancel)?;
			if let Some(state) = self.storage.try_lock_for(Duration::from_millis(10)) {
				break state;
			}
		};
		self.check_import(cancel)?;
		let identity = database::file_identity(Path::new(&self.database_path))?;
		if state.storage.is_none() || state.identity != identity {
			state.storage = None;
			let storage = open_storage(&self.database_path, &self.diagnostics)?;
			state.identity = storage.identity().into();
			state.storage = Some(storage);
		}
		let result = work(
			state
				.storage
				.as_ref()
				.expect("opened documentation storage"),
		);
		if self.closed.load(Ordering::Acquire) && self.imports.load(Ordering::Acquire) == 0 {
			state.storage = None;
		}
		result
	}

	// Recovery runs before a BuildIdentity exists. It must use the connection
	// covered by the physical import lease, never reopen a retargeted profile.
	fn with_import_storage<T>(
		&self,
		cancel: &CancelToken,
		database: &str,
		work: impl FnOnce(&Storage) -> CoreResult<T>,
	) -> CoreResult<T> {
		let state = loop {
			self.check_import(cancel)?;
			if let Some(state) = self.storage.try_lock_for(Duration::from_millis(10)) {
				break state;
			}
		};
		self.check_import(cancel)?;
		if state.identity != database
			|| database::file_identity(Path::new(&self.database_path))? != database
		{
			return Err(WikiError::message("Documentation database changed during document indexing"));
		}
		let storage = state.storage.as_ref().ok_or_else(|| {
			WikiError::message("Documentation storage closed during document indexing")
		})?;
		work(storage)
	}

	// Cleanup deliberately ignores cancellation and owner closure. An accepted
	// commit must remain removable even after close() interrupted the importer.
	fn rollback(&self, build: &BuildIdentity) -> CoreResult<()> {
		let state = self.storage.lock();
		let storage = state
			.storage
			.as_ref()
			.ok_or_else(|| WikiError::message("Documentation storage closed during rollback"))?;
		storage.rollback_build(build)
	}

	fn search(
		&self,
		query: &str,
		options: &WikiSearchOptions,
		cancel: &CancelToken,
	) -> CoreResult<WikiSearchOutput> {
		self.check(cancel)?;
		// Storage owns schema preparation, including reopening a replaced
		// database.
		self.with_storage(cancel, |_| Ok(()))?;
		let mut engine = loop {
			self.check(cancel)?;
			if let Some(engine) = self.engine.try_lock_for(Duration::from_millis(10)) {
				break engine;
			}
		};
		let closed = Arc::clone(&self.closed);
		let cancellation = cancel.clone();
		let result = engine.search(query, options, move || {
			if closed.load(Ordering::Acquire) {
				return Err(WikiError::message("Documentation search engine is closed"));
			}
			cancellation
				.heartbeat()
				.map_err(|error| WikiError::message(error.reason))
		});
		if self.closed.load(Ordering::Acquire) {
			engine.close();
		}
		self.check(cancel)?;
		result
	}
}
fn open_storage(path: &str, queue: &DiagnosticQueue) -> CoreResult<Storage> {
	let started = Instant::now();
	diagnostics::enqueue(
		queue,
		WikiDiagnosticEvent::operation(
			"docs.database.started",
			"docs.database",
			"open",
			"started",
			started,
		),
	);
	let result = Storage::open_with_diagnostics(path, diagnostics::storage_hook(Arc::clone(queue)));
	let mut event = WikiDiagnosticEvent::operation(
		if result.is_ok() {
			"docs.database.completed"
		} else {
			"docs.database.failed"
		},
		"docs.database",
		"open",
		if result.is_ok() {
			"completed"
		} else {
			"failed"
		},
		started,
	);
	if let Err(error) = &result {
		event.level = "error".into();
		event.error(error);
	}
	diagnostics::enqueue(queue, event);
	result
}

#[napi]
pub struct WikiSearchEngine {
	owner: Arc<Owner>,
}
#[napi]
impl WikiSearchEngine {
	#[napi(
		constructor,
		ts_args_type = "databasePath: string, cursorPath: string, diagnostic?: (event: \
		                WikiDiagnosticEvent) => unknown"
	)]
	pub fn new(
		env: Env,
		database_path: String,
		cursor_path: String,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<Self> {
		let queue = Arc::new(Mutex::new(Vec::new()));
		let storage = open_storage(&database_path, &queue);
		diagnostics::flush_sync(&queue, diagnostic.as_ref())?;
		let storage = storage.map_err(|error| error.into_napi(env))?;
		let identity = storage.identity().into();
		Ok(Self {
			owner: Arc::new(Owner {
				closed: Arc::new(AtomicBool::new(false)),
				imports: AtomicUsize::new(0),
				engine: Mutex::new(DatabaseEngine::new(database_path.clone(), cursor_path)),
				storage: Mutex::new(StorageState { storage: Some(storage), identity }),
				database_path,
				diagnostics: queue,
			}),
		})
	}

	#[napi(ts_args_type = "diagnostic?: (event: WikiDiagnosticEvent) => unknown")]
	pub fn list(
		&self,
		env: Env,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<Vec<WikiIndexSummary>> {
		let started = Instant::now();
		diagnostics::enqueue(
			&self.owner.diagnostics,
			WikiDiagnosticEvent::operation(
				"docs.list.started",
				"docs.list",
				"query",
				"started",
				started,
			),
		);
		let result = self
			.owner
			.with_storage(&CancelToken::default(), Storage::list);
		let mut event = WikiDiagnosticEvent::operation(
			if result.is_ok() {
				"docs.list.completed"
			} else {
				"docs.list.failed"
			},
			"docs.list",
			"query",
			if result.is_ok() {
				"completed"
			} else {
				"failed"
			},
			started,
		);
		match &result {
			Ok(indexes) => event.index_count = Some(indexes.len() as i64),
			Err(error) => {
				event.level = "error".into();
				event.error(error);
			},
		}
		diagnostics::enqueue(&self.owner.diagnostics, event);
		diagnostics::flush_sync(&self.owner.diagnostics, diagnostic.as_ref())?;
		result.map_err(|error| error.into_napi(env))
	}

	#[napi(ts_args_type = "name: string, diagnostic?: (event: WikiDiagnosticEvent) => unknown")]
	pub fn remove(
		&self,
		env: Env,
		name: String,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<()> {
		let started = Instant::now();
		diagnostics::enqueue(
			&self.owner.diagnostics,
			WikiDiagnosticEvent::operation(
				"docs.remove.started",
				"docs.remove",
				"delete",
				"started",
				started,
			),
		);
		let result = self
			.owner
			.with_storage(&CancelToken::default(), |storage| storage.remove(&name));
		let (message, outcome) = match &result {
			Ok(true) => ("docs.remove.completed", "completed"),
			Ok(false) => ("docs.remove.rejected", "not_found"),
			Err(_) => ("docs.remove.failed", "failed"),
		};
		let mut event =
			WikiDiagnosticEvent::operation(message, "docs.remove", "delete", outcome, started);
		if let Err(error) = &result {
			event.level = "error".into();
			event.error(error);
		}
		diagnostics::enqueue(&self.owner.diagnostics, event);
		diagnostics::flush_sync(&self.owner.diagnostics, diagnostic.as_ref())?;
		match result {
			Ok(true) => Ok(()),
			Ok(false) => {
				Err(WikiError::message(format!("Unknown document index: {name}")).into_napi(env))
			},
			Err(error) => Err(error.into_napi(env)),
		}
	}

	#[napi(
		ts_return_type = "Promise<WikiBuildResult>",
		ts_args_type = "rootPath: string, name: string, onProgress?: (progress: WikiBuildProgress) \
		                => unknown, signal?: AbortSignal, diagnostic?: (event: WikiDiagnosticEvent) \
		                => unknown"
	)]
	pub fn init(
		&self,
		root_path: String,
		name: String,
		on_progress: Option<ProgressFunction<'_>>,
		signal: Option<Unknown<'_>>,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<task::MappedPromise<WikiImportOutput, ImportError>> {
		let progress = on_progress
			.map(|callback| callback.build_threadsafe_function().build())
			.transpose()?;
		let diagnostic = diagnostic
			.map(|callback| callback.build_threadsafe_function().build())
			.transpose()?;
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		owner.imports.fetch_add(1, Ordering::AcqRel);
		let guard = ImportGuard(Arc::clone(&owner));
		// Use an uncancelled scheduler token: the importer must explicitly roll
		// back and its original callback/cleanup errors outrank a
		// simultaneously aborted signal.
		Ok(task::blocking_mapped(
			"wiki_import",
			(),
			ImportError::into_napi,
			importer::cancel_error,
			move |_| {
				let _guard = guard;
				let result = importer::run(
					&owner,
					&root_path,
					&name,
					&cancel,
					progress.as_ref(),
					diagnostic.as_ref(),
				);
				result.map(|result| WikiImportOutput { owner, cancel, result })
			},
		))
	}

	#[napi(ts_args_type = "query: string, options: WikiSearchOptions, diagnostic?: (event: \
	                       WikiDiagnosticEvent) => unknown")]
	pub fn search_window(
		&self,
		env: Env,
		query: String,
		options: WikiSearchOptions,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<WikiSearchOutput> {
		let result = self.owner.search(&query, &options, &CancelToken::default());
		diagnostics::flush_sync(&self.owner.diagnostics, diagnostic.as_ref())?;
		result.map_err(|error| error.into_napi(env))
	}

	#[napi(
		ts_return_type = "Promise<WikiSearchOutput>",
		ts_args_type = "query: string, options: WikiSearchOptions, signal?: AbortSignal, \
		                diagnostic?: (event: WikiDiagnosticEvent) => unknown"
	)]
	pub fn search_window_async(
		&self,
		query: String,
		options: WikiSearchOptions,
		signal: Option<Unknown<'_>>,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<task::Promise<WikiOutput>> {
		let diagnostic = diagnostic
			.map(|callback| callback.build_threadsafe_function().build())
			.transpose()?;
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		Ok(task::blocking("wiki_search", cancel, move |cancel| {
			let result = owner.search(&query, &options, &cancel);
			diagnostics::flush_async(&owner.diagnostics, diagnostic.as_ref())?;
			Ok(WikiOutput { owner, cancel, result })
		}))
	}

	#[napi]
	pub fn close(&self) {
		self.owner.closed.store(true, Ordering::Release);
		if let Some(mut engine) = self.owner.engine.try_lock() {
			engine.close();
		}
		// An active importer retains storage until its rollback/release
		// completes.
		if self.owner.imports.load(Ordering::Acquire) == 0
			&& let Some(mut storage) = self.owner.storage.try_lock()
		{
			storage.storage = None;
		}
	}
}
impl Drop for WikiSearchEngine {
	fn drop(&mut self) {
		self.close();
	}
}

pub struct WikiOutput {
	owner:  Arc<Owner>,
	cancel: CancelToken,
	result: CoreResult<WikiSearchOutput>,
}
impl TypeName for WikiOutput {
	fn type_name() -> &'static str {
		WikiSearchOutput::type_name()
	}

	fn value_type() -> napi::ValueType {
		WikiSearchOutput::value_type()
	}
}
impl ToNapiValue for WikiOutput {
	unsafe fn to_napi_value(env: napi::sys::napi_env, value: Self) -> Result<napi::sys::napi_value> {
		let wrapper = Env::from_raw(env);
		if value.owner.closed.load(Ordering::Acquire) {
			return Err(Error::new(Status::GenericFailure, "Documentation search engine is closed"));
		}
		if let Some(reason) = value.cancel.abort_reason() {
			return Err(task::abort_error(wrapper, reason));
		}
		let output = value.result.map_err(|error| error.into_napi(wrapper))?;
		// SAFETY: N-API supplies the live env for this conversion; the owned
		// output is converted only after the retained owner's
		// closed/cancellation checks.
		unsafe { WikiSearchOutput::to_napi_value(env, output) }
	}
}
