//! Owner-scoped, database-only documentation search.
mod database;
pub(crate) mod markdown;
pub(crate) mod query;

use std::sync::{
	Arc,
	atomic::{AtomicBool, Ordering},
};

use database::{DatabaseEngine, WikiError, WikiSearchOptions, WikiSearchOutput};
use napi::{Env, Error, Result, Status, bindgen_prelude::*};
use napi_derive::napi;
use parking_lot::Mutex;

use crate::task::{self, CancelToken};

struct Owner {
	closed: Arc<AtomicBool>,
	engine: Mutex<DatabaseEngine>,
}

impl Owner {
	fn check(&self, cancel: &CancelToken) -> std::result::Result<(), WikiError> {
		if self.closed.load(Ordering::Acquire) {
			return Err(WikiError::message("Documentation search engine is closed"));
		}
		cancel
			.heartbeat()
			.map_err(|error| WikiError::message(error.reason))
	}

	fn search(
		&self,
		query: &str,
		options: &WikiSearchOptions,
		cancel: &CancelToken,
	) -> std::result::Result<WikiSearchOutput, WikiError> {
		self.check(cancel)?;
		// Queued calls can be cancelled without waiting for an active query.
		let mut engine = loop {
			self.check(cancel)?;
			if let Some(engine) = self
				.engine
				.try_lock_for(std::time::Duration::from_millis(10))
			{
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

/// One search connection and bounded complete-ranking cache per documentation
/// owner.
#[napi]
pub struct WikiSearchEngine {
	owner: Arc<Owner>,
}

#[napi]
impl WikiSearchEngine {
	/// Opening is deferred until TypeScript has prepared the storage schema.
	#[napi(constructor)]
	pub fn new(database_path: String, cursor_path: String) -> Self {
		Self {
			owner: Arc::new(Owner {
				closed: Arc::new(AtomicBool::new(false)),
				engine: Mutex::new(DatabaseEngine::new(database_path, cursor_path)),
			}),
		}
	}

	#[napi]
	pub fn search_window(
		&self,
		env: Env,
		query: String,
		options: WikiSearchOptions,
	) -> Result<WikiSearchOutput> {
		self
			.owner
			.search(&query, &options, &CancelToken::default())
			.map_err(|error| error.into_napi(env))
	}

	#[napi(ts_return_type = "Promise<WikiSearchOutput>")]
	pub fn search_window_async(
		&self,
		query: String,
		options: WikiSearchOptions,
		signal: Option<Unknown<'_>>,
	) -> task::Promise<WikiOutput> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking("wiki_search", cancel, move |cancel| {
			let result = owner.search(&query, &options, &cancel);
			Ok(WikiOutput { owner, cancel, result })
		})
	}

	/// Closing never waits on the mutex held by an active search.
	#[napi]
	pub fn close(&self) {
		self.owner.closed.store(true, Ordering::Release);
		if let Some(mut engine) = self.owner.engine.try_lock() {
			engine.close();
		}
	}
}

impl Drop for WikiSearchEngine {
	fn drop(&mut self) {
		self.close();
	}
}

/// Conversion runs on the JS thread, after the blocking task has settled.
/// Keep the owner alive and reject both closed-owner and late cancellation
/// results.
pub struct WikiOutput {
	owner:  Arc<Owner>,
	cancel: CancelToken,
	result: std::result::Result<WikiSearchOutput, WikiError>,
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
		let env_wrapper = Env::from_raw(env);
		if value.owner.closed.load(Ordering::Acquire) {
			return Err(Error::new(Status::GenericFailure, "Documentation search engine is closed"));
		}
		if let Some(reason) = value.cancel.abort_reason() {
			return Err(task::abort_error(env_wrapper, reason));
		}
		let output = value.result.map_err(|error| error.into_napi(env_wrapper))?;
		// SAFETY: N-API supplies the live environment; output fields are moved
		// directly into JS values after cancellation and domain-error mapping.
		unsafe { WikiSearchOutput::to_napi_value(env, output) }
	}
}
