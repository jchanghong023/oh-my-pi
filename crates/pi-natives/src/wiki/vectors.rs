//! Internal asynchronous bindings for deferred wiki imports and vectors.
use std::sync::{Arc, atomic::Ordering};

use napi::{Env, Error, Result, bindgen_prelude::*};
use napi_derive::napi;
use pi_vfs::file_lock::FileLock;
use pi_wiki::{database::WikiError, vectors::VectorRow};

use super::{
	ImportGuard, WikiSearchEngine,
	database::WikiErrorNapi,
	diagnostics::DiagnosticFunction,
	importer::{self, ImportError, ProgressFunction, WikiDeferredImportOutput},
};
use crate::task::{self, CancelToken};

pub(super) struct DeferredImport {
	pub lease: FileLock,
	pub name:  String,
}

#[napi(object, object_from_js = false)]
pub struct WikiVectorImport {
	pub token: String,
	pub total: i64,
}
#[napi(object, object_from_js = false)]
pub struct WikiVectorSource {
	pub section_id: i64,
	pub text:       String,
}
#[napi(object, object_from_js = false)]
pub struct WikiVectorSourceBatch {
	pub sections:        Vec<WikiVectorSource>,
	pub next_section_id: Option<i64>,
}
#[napi(object)]
pub struct WikiVectorRow {
	pub section_id: i64,
	pub vector:     Float32Array,
}

fn reject(env: Env, error: WikiError) -> Error {
	error.into_napi(env)
}

#[napi]
impl WikiSearchEngine {
	#[napi(
		ts_return_type = "Promise<WikiDeferredBuildResult>",
		ts_args_type = "rootPath: string, name: string, onProgress?: (progress: WikiBuildProgress) \
		                => unknown, signal?: AbortSignal, diagnostic?: (event: WikiDiagnosticEvent) \
		                => unknown"
	)]
	pub fn init_deferred(
		&self,
		root_path: String,
		name: String,
		on_progress: Option<ProgressFunction<'_>>,
		signal: Option<Unknown<'_>>,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<task::MappedPromise<WikiDeferredImportOutput, ImportError>> {
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
		Ok(task::blocking_mapped(
			"wiki_import_deferred",
			(),
			ImportError::into_napi,
			importer::cancel_error,
			move |_| {
				let _guard = guard;
				let result = importer::run_deferred(
					&owner,
					&root_path,
					&name,
					&cancel,
					progress.as_ref(),
					diagnostic.as_ref(),
				)?;
				Ok(WikiDeferredImportOutput { owner, cancel, result })
			},
		))
	}

	#[napi(
		ts_return_type = "Promise<WikiVectorImport>",
		ts_args_type = "token: string, modelIdentity: string, signal?: AbortSignal"
	)]
	pub fn begin_vector_import(
		&self,
		token: String,
		model_identity: String,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<WikiVectorImport, WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped("wiki_vector_begin", cancel, reject, task::abort_error, move |cancel| {
			let total = owner.with_storage(&cancel, |storage| {
				storage.begin_vector_import(&token, &model_identity)
			})?;
			Ok(WikiVectorImport { token, total })
		})
	}

	#[napi(
		ts_return_type = "Promise<WikiVectorSourceBatch>",
		ts_args_type = "token: string, afterSectionId: number, limit: number, signal?: AbortSignal"
	)]
	pub fn read_vector_import_batch(
		&self,
		token: String,
		after_section_id: i64,
		limit: u32,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<WikiVectorSourceBatch, WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped("wiki_vector_read", cancel, reject, task::abort_error, move |cancel| {
			let rows = owner.with_storage(&cancel, |storage| {
				storage.read_vector_import_batch(&token, after_section_id, limit as usize)
			})?;
			let next_section_id = rows.last().map(|row| row.section_id);
			Ok(WikiVectorSourceBatch {
				sections: rows
					.into_iter()
					.map(|row| WikiVectorSource { section_id: row.section_id, text: row.text })
					.collect(),
				next_section_id,
			})
		})
	}

	#[napi(
		ts_return_type = "Promise<void>",
		ts_args_type = "token: string, rows: WikiVectorRow[], signal?: AbortSignal"
	)]
	pub fn write_vector_import_batch(
		&self,
		token: String,
		rows: Vec<WikiVectorRow>,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<(), WikiError> {
		let rows: Vec<VectorRow> = rows
			.into_iter()
			.map(|row| VectorRow { section_id: row.section_id, vector: row.vector.to_vec() })
			.collect();
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped("wiki_vector_write", cancel, reject, task::abort_error, move |cancel| {
			owner.with_storage(&cancel, |storage| storage.write_vector_import_batch(&token, &rows))
		})
	}

	#[napi(ts_return_type = "Promise<void>", ts_args_type = "token: string, signal?: AbortSignal")]
	pub fn publish_vector_import(
		&self,
		token: String,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<(), WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"wiki_vector_publish",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				owner.with_storage(&cancel, |storage| {
					storage.publish_vector_import(&token, &|| owner.check_import(&cancel))
				})
			},
		)
	}

	#[napi(ts_return_type = "Promise<void>", ts_args_type = "token: string, signal?: AbortSignal")]
	pub fn publish_deferred_import(
		&self,
		token: String,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<(), WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"wiki_import_publish",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let mut pending = owner.deferred.lock();
				let entry = pending.get(&token).ok_or_else(|| {
					WikiError::message("Deferred documentation import is no longer active")
				})?;
				owner.with_storage(&cancel, |storage| {
					storage.publish_deferred_import(&token, &entry.name)
				})?;
				if let Some(mut entry) = pending.remove(&token) {
					entry.lease.release_native().map_err(|error| {
						WikiError::message(format!("Failed to release native file lock: {error}"))
					})?;
				}
				Ok(())
			},
		)
	}

	#[napi(ts_return_type = "Promise<void>", ts_args_type = "token: string")]
	pub fn rollback_import(&self, token: String) -> task::MappedPromise<(), WikiError> {
		let owner = Arc::clone(&self.owner);
		task::blocking_mapped("wiki_import_rollback", (), reject, task::abort_error, move |_| {
			let mut pending = owner.deferred.lock();
			let entry = pending.remove(&token);
			{
				let state = owner.storage.lock();
				if let Some(storage) = state.storage.as_ref() {
					storage.rollback_published_import(&token)?;
				}
			}
			if let Some(mut entry) = entry {
				entry.lease.release_native().map_err(|error| {
					WikiError::message(format!("Failed to release native file lock: {error}"))
				})?;
			}
			Ok(())
		})
	}
}
