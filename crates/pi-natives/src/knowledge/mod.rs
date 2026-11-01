//! Owner-scoped documentation storage, importing, and complete-ranking search.
mod database;
mod diagnostics;
mod hybrid;
mod import;
mod importer;
mod page;
pub(crate) mod query;
mod storage;
mod vectors;

use std::{
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use database::{
	DatabaseEngine, KnowledgeError, KnowledgeErrorNapi, KnowledgeSearchOptions,
	KnowledgeSearchOutput,
};
use diagnostics::{DiagnosticFunction, DiagnosticQueue, KnowledgeDiagnosticEvent};
use importer::{ImportError, KnowledgeImportOutput, ProgressFunction};
use napi::{Env, Error, Result, Status, bindgen_prelude::*};
use napi_derive::napi;
use parking_lot::Mutex;
use storage::{BuildIdentity, KnowledgeIndexSummary, Storage};

use crate::task::{self, CancelToken};

type CoreResult<T> = std::result::Result<T, KnowledgeError>;
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
	deferred:      Mutex<std::collections::HashMap<String, vectors::DeferredImport>>,
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
			return Err(KnowledgeError::message("Documentation search engine is closed"));
		}
		cancel
			.heartbeat()
			.map_err(|error| KnowledgeError::message(error.reason))
	}

	fn check_import(&self, cancel: &CancelToken) -> CoreResult<()> {
		if self.closed.load(Ordering::Acquire) {
			return Err(KnowledgeError::message("Documentation search engine is closed"));
		}
		if cancel.aborted() {
			return Err(KnowledgeError::named("Document indexing cancelled", "AbortError", None));
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

	// Every import operation must use its captured physical database, even
	// before acquiring the lease. Never reopen or migrate a callback's
	// replacement.
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
			return Err(KnowledgeError::message(
				"Documentation database changed during document indexing",
			));
		}
		let storage = state.storage.as_ref().ok_or_else(|| {
			KnowledgeError::message("Documentation storage closed during document indexing")
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
			.ok_or_else(|| KnowledgeError::message("Documentation storage closed during rollback"))?;
		storage.rollback_build(build)
	}

	fn search(
		&self,
		query: &str,
		options: &pi_knowledge::database::KnowledgeSearchOptions,
		cancel: &CancelToken,
	) -> CoreResult<pi_knowledge::database::KnowledgeSearchOutput> {
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
				return Err(KnowledgeError::message("Documentation search engine is closed"));
			}
			cancellation
				.heartbeat()
				.map_err(|error| KnowledgeError::message(error.reason))
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
		KnowledgeDiagnosticEvent::operation(
			"knowledge.database.started",
			"knowledge.database",
			"open",
			"started",
			started,
		),
	);
	let result = Storage::open_with_diagnostics(path, diagnostics::storage_hook(Arc::clone(queue)));
	let mut event = KnowledgeDiagnosticEvent::operation(
		if result.is_ok() {
			"knowledge.database.completed"
		} else {
			"knowledge.database.failed"
		},
		"knowledge.database",
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
pub struct KnowledgeSearchEngine {
	owner: Arc<Owner>,
}
#[napi]
impl KnowledgeSearchEngine {
	#[napi(
		constructor,
		ts_args_type = "databasePath: string, cursorPath: string, diagnostic?: (event: \
		                KnowledgeDiagnosticEvent) => unknown"
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
				deferred: Mutex::new(std::collections::HashMap::new()),
			}),
		})
	}

	#[napi(ts_args_type = "diagnostic?: (event: KnowledgeDiagnosticEvent) => unknown")]
	pub fn list(
		&self,
		env: Env,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<Vec<KnowledgeIndexSummary>> {
		let started = Instant::now();
		diagnostics::enqueue(
			&self.owner.diagnostics,
			KnowledgeDiagnosticEvent::operation(
				"knowledge.list.started",
				"knowledge.list",
				"query",
				"started",
				started,
			),
		);
		let result = self
			.owner
			.with_storage(&CancelToken::default(), Storage::list);
		let mut event = KnowledgeDiagnosticEvent::operation(
			if result.is_ok() {
				"knowledge.list.completed"
			} else {
				"knowledge.list.failed"
			},
			"knowledge.list",
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
		result
			.map(|indexes| indexes.into_iter().map(Into::into).collect())
			.map_err(|error| error.into_napi(env))
	}

	#[napi(ts_args_type = "name: string, diagnostic?: (event: KnowledgeDiagnosticEvent) => unknown")]
	pub fn remove(
		&self,
		env: Env,
		name: String,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<()> {
		let started = Instant::now();
		diagnostics::enqueue(
			&self.owner.diagnostics,
			KnowledgeDiagnosticEvent::operation(
				"knowledge.remove.started",
				"knowledge.remove",
				"delete",
				"started",
				started,
			),
		);
		let result = self
			.owner
			.with_storage(&CancelToken::default(), |storage| storage.remove(&name));
		let (message, outcome) = match &result {
			Ok(true) => ("knowledge.remove.completed", "completed"),
			Ok(false) => ("knowledge.remove.rejected", "not_found"),
			Err(_) => ("knowledge.remove.failed", "failed"),
		};
		let mut event = KnowledgeDiagnosticEvent::operation(
			message,
			"knowledge.remove",
			"delete",
			outcome,
			started,
		);
		if let Err(error) = &result {
			event.level = "error".into();
			event.error(error);
		}
		diagnostics::enqueue(&self.owner.diagnostics, event);
		diagnostics::flush_sync(&self.owner.diagnostics, diagnostic.as_ref())?;
		match result {
			Ok(true) => Ok(()),
			Ok(false) => {
				Err(KnowledgeError::message(format!("Unknown document index: {name}")).into_napi(env))
			},
			Err(error) => Err(error.into_napi(env)),
		}
	}

	#[napi(
		ts_return_type = "Promise<KnowledgeBuildResult>",
		ts_args_type = "rootPath: string, name: string, onProgress?: (progress: \
		                KnowledgeBuildProgress) => unknown, signal?: AbortSignal, diagnostic?: \
		                (event: KnowledgeDiagnosticEvent) => unknown"
	)]
	pub fn init(
		&self,
		root_path: String,
		name: String,
		on_progress: Option<ProgressFunction<'_>>,
		signal: Option<Unknown<'_>>,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<task::MappedPromise<KnowledgeImportOutput, ImportError>> {
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
			"knowledge_import",
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
				result.map(|result| KnowledgeImportOutput { owner, cancel, result })
			},
		))
	}

	#[napi(ts_args_type = "query: string, options: KnowledgeSearchOptions, diagnostic?: (event: \
	                       KnowledgeDiagnosticEvent) => unknown")]
	pub fn search_window(
		&self,
		env: Env,
		query: String,
		options: KnowledgeSearchOptions,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<KnowledgeSearchOutput> {
		let result = self
			.owner
			.search(&query, &options.into(), &CancelToken::default());
		diagnostics::flush_sync(&self.owner.diagnostics, diagnostic.as_ref())?;
		result.map(Into::into).map_err(|error| error.into_napi(env))
	}

	#[napi(
		ts_return_type = "Promise<KnowledgeSearchOutput>",
		ts_args_type = "query: string, options: KnowledgeSearchOptions, signal?: AbortSignal, \
		                diagnostic?: (event: KnowledgeDiagnosticEvent) => unknown"
	)]
	pub fn search_window_async(
		&self,
		query: String,
		options: KnowledgeSearchOptions,
		signal: Option<Unknown<'_>>,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<task::Promise<KnowledgeOutput>> {
		let diagnostic = diagnostic
			.map(|callback| callback.build_threadsafe_function().build())
			.transpose()?;
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		let options = options.into();
		Ok(task::blocking("knowledge_search", cancel, move |cancel| {
			let result = owner.search(&query, &options, &cancel);
			diagnostics::flush_async(&owner.diagnostics, diagnostic.as_ref())?;
			Ok(KnowledgeOutput { owner, cancel, result })
		}))
	}

	#[napi]
	pub fn close(&self) {
		self.owner.closed.store(true, Ordering::Release);
		self.owner.deferred.lock().clear();
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
impl Drop for KnowledgeSearchEngine {
	fn drop(&mut self) {
		self.close();
	}
}

/// File-system path of the exclusive lease guarding document-index imports of
/// `database_path`.
///
/// Holding this path (from this process or another) contends
/// with any in-flight import of the same physical database.
#[napi]
pub fn knowledge_import_lease_path(env: Env, database_path: String) -> Result<String> {
	let (lease, _identity) =
		importer::import_lease(&database_path).map_err(|error| error.into_napi(env))?;
	Ok(lease.to_string_lossy().into_owned())
}

pub struct KnowledgeOutput {
	owner:  Arc<Owner>,
	cancel: CancelToken,
	result: CoreResult<pi_knowledge::database::KnowledgeSearchOutput>,
}
impl TypeName for KnowledgeOutput {
	fn type_name() -> &'static str {
		KnowledgeSearchOutput::type_name()
	}

	fn value_type() -> napi::ValueType {
		KnowledgeSearchOutput::value_type()
	}
}
impl ToNapiValue for KnowledgeOutput {
	unsafe fn to_napi_value(env: napi::sys::napi_env, value: Self) -> Result<napi::sys::napi_value> {
		let wrapper = Env::from_raw(env);
		if value.owner.closed.load(Ordering::Acquire) {
			return Err(Error::new(Status::GenericFailure, "Documentation search engine is closed"));
		}
		if let Some(reason) = value.cancel.abort_reason() {
			return Err(task::abort_error(wrapper, reason));
		}
		let output = value
			.result
			.map_err(|error| error.into_napi(wrapper))?
			.into();
		// SAFETY: N-API supplies the live env for this conversion; the owned
		// output is converted only after the retained owner's
		// closed/cancellation checks.
		unsafe { KnowledgeSearchOutput::to_napi_value(env, output) }
	}
}
