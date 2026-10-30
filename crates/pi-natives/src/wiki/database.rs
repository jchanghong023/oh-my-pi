use napi::{
	Env, Error, JsValue,
	bindgen_prelude::{JsObjectValue, ToNapiValue, create_object_with_properties},
};
use napi_derive::napi;
pub use pi_wiki::database::{DatabaseEngine, WikiError, file_identity};
#[cfg(test)]
use serde::Serialize;

use super::query::{self, MatchKind};

/// Converts core errors to JavaScript errors without losing diagnostic
/// metadata.
pub trait WikiErrorNapi {
	/// Convert the error in the supplied N-API environment.
	fn into_napi(self, env: Env) -> Error;
}
impl WikiErrorNapi for WikiError {
	fn into_napi(self, env: Env) -> Error {
		let fallback = Error::from_reason(self.error_message().to_owned());
		if !self.has_metadata() {
			return fallback;
		}
		let built = (|| -> napi::Result<Error> {
			let mut error = if self.diagnostic_error_type() == "TypeError" {
				napi::JsTypeError::from(Error::from_reason(self.error_message().to_owned()))
					.into_unknown(env)
					.coerce_to_object()?
			} else {
				env.create_error(Error::from_reason(self.error_message().to_owned()))?
			};
			error.set_named_property("name", self.diagnostic_error_type())?;
			if let Some(code) = self.diagnostic_code() {
				error.set_named_property("code", code)?;
			}
			if let Some(code) = self.diagnostic_sqlite_code() {
				error.set_named_property("errno", code)?;
			}
			Ok(Error::from(error.to_unknown()))
		})();
		built.unwrap_or(fallback)
	}
}

#[derive(Default)]
#[napi(object, object_to_js = false)]
pub struct WikiSearchOptions {
	pub index:  Option<String>,
	pub cursor: Option<String>,
	pub limit:  Option<f64>,
	pub mode:   Option<String>,
	pub r#case: Option<bool>,
}

#[derive(Debug)]
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
#[napi(object)]
pub struct WikiSearchHit {
	pub section_id:    i64,
	pub index:         String,
	pub document_hash: String,
	pub path:          String,
	pub heading_path:  String,
	pub line_start:    i64,
	pub line_end:      i64,
	pub text:          String,
	#[napi(ts_type = "'content' | 'heading-only' | 'stub'")]
	pub shape:         query::Shape,
	#[napi(ts_type = "'exact-name' | 'related' | 'regex'")]
	pub match_kind:    MatchKind,
	pub rank:          f64,
}

/// Output positions are JS numbers; the decoded cursor retains its u64.
#[derive(Debug)]
#[cfg_attr(test, derive(Serialize))]
#[napi(object)]
pub struct WikiCursorBase {
	#[napi(ts_type = "1")]
	pub v: u8,
	pub q: String,
	pub s: String,
	pub p: i64,
}

#[derive(Debug)]
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
#[napi(object, object_to_js = false)]
pub struct WikiSearchWindow {
	pub sections:           Vec<WikiSearchHit>,
	pub total:              i64,
	pub exact_name_matches: i64,
	#[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
	pub technical_name:     Option<String>,
	pub cursor_base:        WikiCursorBase,
}

impl ToNapiValue for WikiSearchWindow {
	unsafe fn to_napi_value(
		env: napi::sys::napi_env,
		value: Self,
	) -> napi::Result<napi::sys::napi_value> {
		let property = |name: &'static std::ffi::CStr, value| napi::sys::napi_property_descriptor {
			utf8name: name.as_ptr(),
			name: std::ptr::null_mut(),
			method: None,
			getter: None,
			setter: None,
			value,
			attributes: napi::sys::PropertyAttributes::writable
				| napi::sys::PropertyAttributes::enumerable
				| napi::sys::PropertyAttributes::configurable,
			data: std::ptr::null_mut(),
		};
		// SAFETY: N-API supplies the live environment, static property names
		// remain valid, and each owned field is consumed exactly once.
		unsafe {
			let sections = Vec::<WikiSearchHit>::to_napi_value(env, value.sections)?;
			let total = i64::to_napi_value(env, value.total)?;
			let exact_name_matches = i64::to_napi_value(env, value.exact_name_matches)?;
			let cursor_base = WikiCursorBase::to_napi_value(env, value.cursor_base)?;
			let mut properties = [
				property(c"sections", sections),
				property(c"total", total),
				property(c"exactNameMatches", exact_name_matches),
				property(c"cursorBase", cursor_base),
				property(c"cursorBase", cursor_base),
			];
			// napi's object derive appends optional fields after all required
			// ones. Batch the original order while omitting absent technicalName.
			let count = if let Some(name) = value.technical_name {
				properties[3] = property(c"technicalName", String::to_napi_value(env, name)?);
				5
			} else {
				4
			};
			create_object_with_properties(env, &properties[..count])
		}
	}
}

#[derive(Debug)]
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
#[napi(object, object_from_js = false)]
pub struct WikiSearchOutput {
	pub result:     WikiSearchWindow,
	pub cache_hit:  bool,
	pub term_count: i64,
}

impl From<WikiSearchOptions> for pi_wiki::database::WikiSearchOptions {
	fn from(value: WikiSearchOptions) -> Self {
		Self {
			index:  value.index,
			cursor: value.cursor,
			limit:  value.limit,
			mode:   value.mode,
			r#case: value.r#case,
		}
	}
}
impl From<pi_wiki::database::WikiSearchHit> for WikiSearchHit {
	fn from(value: pi_wiki::database::WikiSearchHit) -> Self {
		Self {
			section_id:    value.section_id,
			index:         value.index,
			document_hash: value.document_hash,
			path:          value.path,
			heading_path:  value.heading_path,
			line_start:    value.line_start,
			line_end:      value.line_end,
			text:          value.text,
			shape:         value.shape.into(),
			match_kind:    value.match_kind.into(),
			rank:          value.rank,
		}
	}
}
impl From<pi_wiki::database::WikiCursorBase> for WikiCursorBase {
	fn from(value: pi_wiki::database::WikiCursorBase) -> Self {
		Self { v: value.v, q: value.q, s: value.s, p: value.p }
	}
}
impl From<pi_wiki::database::WikiSearchWindow> for WikiSearchWindow {
	fn from(value: pi_wiki::database::WikiSearchWindow) -> Self {
		Self {
			sections:           value.sections.into_iter().map(Into::into).collect(),
			total:              value.total,
			exact_name_matches: value.exact_name_matches,
			technical_name:     value.technical_name,
			cursor_base:        value.cursor_base.into(),
		}
	}
}
impl From<pi_wiki::database::WikiSearchOutput> for WikiSearchOutput {
	fn from(value: pi_wiki::database::WikiSearchOutput) -> Self {
		Self {
			result:     value.result.into(),
			cache_hit:  value.cache_hit,
			term_count: value.term_count,
		}
	}
}
