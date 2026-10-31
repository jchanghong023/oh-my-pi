//! Async native boundary for snapshot-bound host-side ranking.
use std::{
	sync::{Arc, atomic::Ordering},
	time::Duration,
};

use napi::{Env, Error, bindgen_prelude::*};
use napi_derive::napi;
use pi_wiki::database::{HybridCandidate, HybridPreparation, HybridPrepared, WikiError};

use super::{
	Owner, WikiSearchEngine,
	database::{WikiErrorNapi, WikiSearchHit, WikiSearchOptions, WikiSearchOutput},
	query::MatchKind,
};
use crate::task::{self, CancelToken};

#[napi(object, object_from_js = false)]
pub struct WikiHybridRank {
	pub section_id:   i64,
	#[napi(ts_type = "'exact-name' | 'related' | 'regex'")]
	pub match_kind:   MatchKind,
	pub rank:         f64,
	pub source_order: i64,
}
#[napi(object, object_from_js = false)]
pub struct WikiHybridPrepared {
	pub token:             String,
	pub effective_query:   String,
	pub fulltext:          Vec<WikiHybridRank>,
	pub vector_dimensions: Vec<u32>,
	pub vector_failure:    bool,
}
#[napi(object, object_from_js = false)]
pub struct WikiHybridCandidate {
	pub section_id:    i64,
	pub index:         String,
	pub document_hash: String,
	pub path:          String,
	pub heading_path:  String,
	pub line_start:    i64,
	pub line_end:      i64,
	pub text:          String,
	#[napi(ts_type = "'content' | 'heading-only' | 'stub'")]
	pub shape:         super::query::Shape,
	#[napi(ts_type = "'exact-name' | 'related' | 'regex'")]
	pub match_kind:    MatchKind,
	pub rank:          f64,
	pub source_order:  i64,
}
impl From<HybridPrepared> for WikiHybridPrepared {
	fn from(value: HybridPrepared) -> Self {
		Self {
			token:             value.token,
			effective_query:   value.effective_query,
			fulltext:          value
				.fulltext
				.into_iter()
				.map(|item| WikiHybridRank {
					section_id:   item.section_id,
					match_kind:   item.match_kind.into(),
					rank:         item.rank,
					source_order: item.source_order,
				})
				.collect(),
			vector_dimensions: value
				.vector_dimensions
				.into_iter()
				.map(|dim| dim as u32)
				.collect(),
			vector_failure:    value.vector_failure,
		}
	}
}
impl From<HybridCandidate> for WikiHybridCandidate {
	fn from(value: HybridCandidate) -> Self {
		let hit: WikiSearchHit = value.hit.into();
		Self {
			section_id:    hit.section_id,
			index:         hit.index,
			document_hash: hit.document_hash,
			path:          hit.path,
			heading_path:  hit.heading_path,
			line_start:    hit.line_start,
			line_end:      hit.line_end,
			text:          hit.text,
			shape:         hit.shape,
			match_kind:    hit.match_kind,
			rank:          hit.rank,
			source_order:  value.source_order,
		}
	}
}
fn reject(env: Env, error: WikiError) -> Error {
	error.into_napi(env)
}

/// Delay owner and cancellation validation until N-API delivers the result.
pub struct Guarded<T> {
	owner:  Arc<Owner>,
	cancel: CancelToken,
	value:  T,
}
impl<T: TypeName> TypeName for Guarded<T> {
	fn type_name() -> &'static str {
		T::type_name()
	}

	fn value_type() -> napi::ValueType {
		T::value_type()
	}
}
impl<T: ToNapiValue> ToNapiValue for Guarded<T> {
	unsafe fn to_napi_value(
		env: napi::sys::napi_env,
		output: Self,
	) -> napi::Result<napi::sys::napi_value> {
		let wrapper = Env::from_raw(env);
		output
			.owner
			.check_hybrid(&output.cancel)
			.map_err(|error| error.into_napi(wrapper))?;
		// SAFETY: N-API supplies the live environment and the owned value is
		// consumed once.
		unsafe { T::to_napi_value(env, output.value) }
	}
}

impl Owner {
	fn check_hybrid(&self, cancel: &CancelToken) -> super::CoreResult<()> {
		if cancel.aborted() {
			return Err(WikiError::named("Documentation search cancelled", "AbortError", None));
		}
		self.check(cancel)
	}

	fn with_engine<T>(
		&self,
		cancel: &CancelToken,
		work: impl FnOnce(&mut pi_wiki::database::DatabaseEngine) -> super::CoreResult<T>,
	) -> super::CoreResult<T> {
		self.with_storage(cancel, |_| Ok(()))?;
		let mut engine = loop {
			self.check_hybrid(cancel)?;
			if let Some(engine) = self.engine.try_lock_for(Duration::from_millis(10)) {
				break engine;
			}
		};
		let result = work(&mut engine);
		if self.closed.load(Ordering::Acquire) {
			engine.close();
		}
		self.check_hybrid(cancel)?;
		result
	}
}

#[napi]
impl WikiSearchEngine {
	#[napi(
		ts_return_type = "Promise<boolean>",
		ts_args_type = "query: string, options: WikiSearchOptions, signal?: AbortSignal"
	)]
	pub fn has_cached_hybrid_candidates(
		&self,
		query: String,
		options: WikiSearchOptions,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<Guarded<bool>, WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		let options = options.into();
		task::blocking_mapped("wiki_hybrid_peek", cancel, reject, task::abort_error, move |cancel| {
			let value = owner
				.with_engine(&cancel, |engine| engine.has_cached_hybrid_candidates(&query, &options))?;
			Ok(Guarded { owner, cancel, value })
		})
	}

	#[napi(
		ts_return_type = "Promise<WikiSearchOutput | null>",
		ts_args_type = "query: string, options: WikiSearchOptions, configurationIdentity: string, \
		                signal?: AbortSignal"
	)]
	pub fn lookup_hybrid_search(
		&self,
		query: String,
		options: WikiSearchOptions,
		configuration_identity: String,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<Guarded<Option<WikiSearchOutput>>, WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		let options = options.into();
		task::blocking_mapped(
			"wiki_hybrid_lookup",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let value = owner.with_engine(&cancel, |engine| {
					engine
						.lookup_hybrid(&query, &options, &configuration_identity, &|| {
							owner.check_hybrid(&cancel)
						})
						.map(|value| value.map(Into::into))
				})?;
				Ok(Guarded { owner, cancel, value })
			},
		)
	}

	#[napi(
		ts_return_type = "Promise<WikiHybridPrepared | WikiSearchOutput>",
		ts_args_type = "query: string, options: WikiSearchOptions, modelIdentity?: string, signal?: \
		                AbortSignal"
	)]
	pub fn prepare_hybrid_search(
		&self,
		query: String,
		options: WikiSearchOptions,
		model_identity: Option<String>,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<Guarded<Either<WikiHybridPrepared, WikiSearchOutput>>, WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		let options = options.into();
		task::blocking_mapped(
			"wiki_hybrid_prepare",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let value = owner.with_engine(&cancel, |engine| {
					let owner = Arc::clone(&owner);
					let cancellation = cancel.clone();
					engine
						.prepare_hybrid(&query, &options, model_identity.as_deref(), move || {
							owner.check_hybrid(&cancellation)
						})
						.map(|value| match value {
							HybridPreparation::Ready(prepared) => Either::A(prepared.into()),
							HybridPreparation::Fulltext(output) => Either::B(output.into()),
						})
				})?;
				Ok(Guarded { owner, cancel, value })
			},
		)
	}

	#[napi(
		ts_return_type = "Promise<number[] | null>",
		ts_args_type = "token: string, query: Float32Array, limit: number, signal?: AbortSignal"
	)]
	pub fn score_hybrid_search(
		&self,
		token: String,
		query: Float32Array,
		limit: u32,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<Guarded<Option<Vec<i64>>>, WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		let query: Vec<f64> = query.iter().map(|value| f64::from(*value)).collect();
		task::blocking_mapped("wiki_hybrid_score", cancel, reject, task::abort_error, move |cancel| {
			let value = owner.with_engine(&cancel, |engine| {
				if query.is_empty()
					|| query.iter().any(|value| !value.is_finite())
					|| query.iter().map(|value| value * value).sum::<f64>() == 0.0
				{
					return Err(WikiError::message("Invalid documentation query vector"));
				}
				engine.score_hybrid(
					&token,
					query.len(),
					&|| owner.check_hybrid(&cancel),
					|matrix, dims| {
						crate::vectors::vector_index_top_k_slice(matrix, dims, &query, limit as usize)
							.into_iter()
							.map(|(_, row)| row)
							.collect()
					},
				)
			})?;
			Ok(Guarded { owner, cancel, value })
		})
	}

	#[napi(
		ts_return_type = "Promise<WikiHybridCandidate[]>",
		ts_args_type = "token: string, sectionIds: number[], signal?: AbortSignal"
	)]
	pub fn read_hybrid_candidates(
		&self,
		token: String,
		section_ids: Vec<i64>,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<Guarded<Vec<WikiHybridCandidate>>, WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"wiki_hybrid_candidates",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let value = owner.with_engine(&cancel, |engine| {
					engine
						.read_hybrid_candidates(&token, &section_ids, &|| owner.check_hybrid(&cancel))
						.map(|hits| hits.into_iter().map(Into::into).collect())
				})?;
				Ok(Guarded { owner, cancel, value })
			},
		)
	}

	#[napi(
		ts_return_type = "Promise<WikiSearchOutput>",
		ts_args_type = "token: string, finalSectionIds: number[], contextIdentity: string, \
		                configurationIdentity: string, signal?: AbortSignal"
	)]
	pub fn finish_hybrid_search(
		&self,
		token: String,
		final_section_ids: Vec<i64>,
		context_identity: String,
		configuration_identity: String,
		signal: Option<Unknown<'_>>,
	) -> task::MappedPromise<Guarded<WikiSearchOutput>, WikiError> {
		let owner = Arc::clone(&self.owner);
		let cancel = CancelToken::new(None, signal);
		task::blocking_mapped(
			"wiki_hybrid_finish",
			cancel,
			reject,
			task::abort_error,
			move |cancel| {
				let value = owner.with_engine(&cancel, |engine| {
					engine
						.finish_hybrid(
							&token,
							&final_section_ids,
							&context_identity,
							&configuration_identity,
							&|| owner.check_hybrid(&cancel),
						)
						.map(Into::into)
				})?;
				Ok(Guarded { owner, cancel, value })
			},
		)
	}
}
