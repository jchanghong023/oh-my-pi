//! JavaScript representations of wiki query metadata.

use napi::{
	Result as NapiResult, ValueType,
	bindgen_prelude::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Shape {
	Content,
	HeadingOnly,
	Stub,
}

impl From<pi_wiki::query::Shape> for Shape {
	fn from(value: pi_wiki::query::Shape) -> Self {
		match value {
			pi_wiki::query::Shape::Content => Self::Content,
			pi_wiki::query::Shape::HeadingOnly => Self::HeadingOnly,
			pi_wiki::query::Shape::Stub => Self::Stub,
		}
	}
}

impl From<Shape> for pi_wiki::query::Shape {
	fn from(value: Shape) -> Self {
		match value {
			Shape::Content => Self::Content,
			Shape::HeadingOnly => Self::HeadingOnly,
			Shape::Stub => Self::Stub,
		}
	}
}

impl TypeName for Shape {
	fn type_name() -> &'static str {
		"String"
	}

	fn value_type() -> ValueType {
		ValueType::String
	}
}

impl ToNapiValue for Shape {
	unsafe fn to_napi_value(
		env: napi::sys::napi_env,
		value: Self,
	) -> NapiResult<napi::sys::napi_value> {
		let name = match value {
			Self::Content => "content",
			Self::HeadingOnly => "heading-only",
			Self::Stub => "stub",
		};
		// SAFETY: N-API supplies a live environment and copies the static string.
		unsafe { <&str>::to_napi_value(env, name) }
	}
}

impl FromNapiValue for Shape {
	unsafe fn from_napi_value(
		env: napi::sys::napi_env,
		value: napi::sys::napi_value,
	) -> NapiResult<Self> {
		// SAFETY: the enclosing typed object provides the live N-API environment.
		let name = unsafe { String::from_napi_value(env, value)? };
		match name.as_str() {
			"content" => Ok(Self::Content),
			"heading-only" => Ok(Self::HeadingOnly),
			"stub" => Ok(Self::Stub),
			_ => Err(napi::Error::from_reason("Invalid documentation section shape")),
		}
	}
}

impl ValidateNapiValue for Shape {}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchKind {
	ExactName,
	Related,
	Regex,
}

impl From<pi_wiki::query::MatchKind> for MatchKind {
	fn from(value: pi_wiki::query::MatchKind) -> Self {
		match value {
			pi_wiki::query::MatchKind::ExactName => Self::ExactName,
			pi_wiki::query::MatchKind::Related => Self::Related,
			pi_wiki::query::MatchKind::Regex => Self::Regex,
		}
	}
}

impl From<MatchKind> for pi_wiki::query::MatchKind {
	fn from(value: MatchKind) -> Self {
		match value {
			MatchKind::ExactName => Self::ExactName,
			MatchKind::Related => Self::Related,
			MatchKind::Regex => Self::Regex,
		}
	}
}

impl TypeName for MatchKind {
	fn type_name() -> &'static str {
		"String"
	}

	fn value_type() -> ValueType {
		ValueType::String
	}
}

impl ToNapiValue for MatchKind {
	unsafe fn to_napi_value(
		env: napi::sys::napi_env,
		value: Self,
	) -> NapiResult<napi::sys::napi_value> {
		let name = match value {
			Self::ExactName => "exact-name",
			Self::Related => "related",
			Self::Regex => "regex",
		};
		// SAFETY: N-API supplies a live environment and copies the static string.
		unsafe { <&str>::to_napi_value(env, name) }
	}
}

impl FromNapiValue for MatchKind {
	unsafe fn from_napi_value(
		env: napi::sys::napi_env,
		value: napi::sys::napi_value,
	) -> NapiResult<Self> {
		// SAFETY: the enclosing typed object provides the live N-API environment.
		let name = unsafe { String::from_napi_value(env, value)? };
		match name.as_str() {
			"exact-name" => Ok(Self::ExactName),
			"related" => Ok(Self::Related),
			"regex" => Ok(Self::Regex),
			_ => Err(napi::Error::from_reason("Invalid documentation section match kind")),
		}
	}
}

impl ValidateNapiValue for MatchKind {}
