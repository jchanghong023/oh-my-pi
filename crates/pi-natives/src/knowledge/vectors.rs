//! Internal asynchronous bindings for deferred knowledge imports and vectors.
use std::{
	path::PathBuf,
	sync::{Arc, atomic::Ordering},
};

use napi::{Env, Error, Result, bindgen_prelude::*};
use napi_derive::napi;
use pi_knowledge::{database::KnowledgeError, vectors::VectorRow};
use pi_vfs::file_lock::FileLock;

use super::{
	ImportGuard, KnowledgeSearchEngine,
	database::KnowledgeErrorNapi,
	diagnostics::DiagnosticFunction,
	importer::{self, ImportError, KnowledgeDeferredImportOutput, ProgressFunction},
};
use crate::task::{self, CancelToken};

pub(super) struct DeferredImport {
	pub lease: FileLock,
	pub name:  String,
}

#[napi(object, object_from_js = false)]
pub struct KnowledgeVectorImport {
	pub token: String,
	pub total: i64,
}
#[napi(object, object_from_js = false)]
pub struct KnowledgeVectorRetry {
	pub token:      Option<String>,
	pub total:      i64,
	pub completed:  i64,
	pub dimensions: i64,
	pub complete:   bool,
}
#[napi(object, object_from_js = false)]
pub struct KnowledgeVectorSource {
	pub section_id: i64,
	pub text:       String,
}
#[napi(object, object_from_js = false)]
pub struct KnowledgeVectorSourceBatch {
	pub sections:        Vec<KnowledgeVectorSource>,
	pub next_section_id: Option<i64>,
}
#[napi(object)]
pub struct KnowledgeVectorRow {
	pub section_id: i64,
	pub vector:     Float32Array,
}

fn reject(env: Env, error: KnowledgeError) -> Error {
	error.into_napi(env)
}

#[napi]
impl KnowledgeSearchEngine {
	#[napi(
		ts_return_type = "Promise<KnowledgeDeferredBuildResult>",
		ts_args_type = "rootPath: string, name: string, onProgress?: (progress: \
		                KnowledgeBuildProgress) => unknown, signal?: AbortSignal, diagnostic?: \
		                (event: KnowledgeDiagnosticEvent) => unknown"
	)]
	pub fn init_deferred(
		&self,
		root_path: String,
		name: String,
		on_progress: Option<ProgressFunction<'_>>,
		signal: Option<Unknown<'_>>,
		diagnostic: Option<DiagnosticFunction<'_>>,
	) -> Result<task::MappedPromise<KnowledgeDeferredImportOutput, ImportError>> {
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
			"knowledge_import_deferred",
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
				Ok(KnowledgeDeferredImportOutput { owner, cancel, result })
			},
		))
	}

	#[napi(
		ts_return_type = "Promise<KnowledgeVectorImport>",
		ts_args_type = "token: string, modelIdentity: string, signal?: AbortSignal"
	)]
	pub fn begin_vector_import(
		&self,
		token: String,
		model_identity: String,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<KnowledgeVectorImport, KnowledgeError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"knowledge_vector_begin",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let total = owner.with_storage(&cancel, |storage| {
					storage.begin_vector_import(&token, &model_identity)
				})?;
				Ok(KnowledgeVectorImport { token, total })
			},
		)
	}

	#[napi(
		ts_return_type = "Promise<KnowledgeVectorRetry>",
		ts_args_type = "indexId: number, leasePath: string, modelIdentity?: string, signal?: \
		                AbortSignal"
	)]
	pub fn begin_vector_retry(
		&self,
		index_id: i64,
		lease_path: String,
		model_identity: Option<String>,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<KnowledgeVectorRetry, KnowledgeError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"knowledge_vector_retry_begin",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let checkpoint = owner.with_storage(&cancel, |storage| {
					// A replacement between lease lookup and this call is not ours
					// to modify.
					if pi_knowledge::importer::lease_path(storage.identity())
						!= PathBuf::from(&lease_path)
					{
						return Err(KnowledgeError::message(
							"Knowledge database changed while acquiring vector retry lease",
						));
					}
					storage.begin_vector_retry(index_id, model_identity.as_deref())
				})?;
				Ok(KnowledgeVectorRetry {
					token:      checkpoint.token,
					total:      checkpoint.total,
					completed:  checkpoint.completed,
					dimensions: checkpoint.dimensions,
					complete:   checkpoint.complete,
				})
			},
		)
	}

	#[napi(ts_return_type = "Promise<void>")]
	pub fn finish_vector_retry(&self, token: String) -> task::MappedPromise<(), KnowledgeError> {
		let owner = Arc::clone(&self.owner);
		task::blocking_mapped(
			"knowledge_vector_retry_finish",
			(),
			reject,
			task::abort_error,
			move |_| {
				owner
					.with_storage(&CancelToken::default(), |storage| storage.finish_vector_retry(&token))
			},
		)
	}

	#[napi(
		ts_return_type = "Promise<KnowledgeVectorSourceBatch>",
		ts_args_type = "token: string, afterSectionId: number, limit: number, signal?: AbortSignal"
	)]
	pub fn read_vector_import_batch(
		&self,
		token: String,
		after_section_id: i64,
		limit: u32,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<KnowledgeVectorSourceBatch, KnowledgeError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"knowledge_vector_read",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let rows = owner.with_storage(&cancel, |storage| {
					storage.read_vector_import_batch(&token, after_section_id, limit as usize)
				})?;
				let next_section_id = rows.last().map(|row| row.section_id);
				Ok(KnowledgeVectorSourceBatch {
					sections: rows
						.into_iter()
						.map(|row| KnowledgeVectorSource {
							section_id: row.section_id,
							text:       row.text,
						})
						.collect(),
					next_section_id,
				})
			},
		)
	}

	#[napi(
		ts_return_type = "Promise<void>",
		ts_args_type = "token: string, rows: KnowledgeVectorRow[], signal?: AbortSignal"
	)]
	pub fn write_vector_import_batch(
		&self,
		token: String,
		rows: Vec<KnowledgeVectorRow>,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<(), KnowledgeError> {
		let rows: Vec<VectorRow> = rows
			.into_iter()
			.map(|row| VectorRow { section_id: row.section_id, vector: row.vector.to_vec() })
			.collect();
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"knowledge_vector_write",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				owner.with_storage(&cancel, |storage| storage.write_vector_import_batch(&token, &rows))
			},
		)
	}

	#[napi(ts_return_type = "Promise<void>", ts_args_type = "token: string, signal?: AbortSignal")]
	pub fn publish_vector_import(
		&self,
		token: String,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<(), KnowledgeError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"knowledge_vector_publish",
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
	) -> task::MappedPromise<(), KnowledgeError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"knowledge_import_publish",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let mut pending = owner.deferred.lock();
				let entry = pending.get(&token).ok_or_else(|| {
					KnowledgeError::message("Deferred documentation import is no longer active")
				})?;
				owner.with_storage(&cancel, |storage| {
					storage.publish_deferred_import(&token, &entry.name)
				})?;
				if let Some(mut entry) = pending.remove(&token) {
					entry.lease.release_native().map_err(|error| {
						KnowledgeError::message(format!("Failed to release native file lock: {error}"))
					})?;
				}
				Ok(())
			},
		)
	}

	#[napi(ts_return_type = "Promise<void>", ts_args_type = "token: string")]
	pub fn rollback_import(&self, token: String) -> task::MappedPromise<(), KnowledgeError> {
		let owner = Arc::clone(&self.owner);
		task::blocking_mapped("knowledge_import_rollback", (), reject, task::abort_error, move |_| {
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
					KnowledgeError::message(format!("Failed to release native file lock: {error}"))
				})?;
			}
			Ok(())
		})
	}
}
