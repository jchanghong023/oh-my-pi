//! Caller-local page selection and complete wiki evidence rendering.
//!
//! JS hit objects stay on the calling thread: custom costs see exactly the
//! hydrated objects, synchronously, and only through the first nonfitting hit.
use std::{collections::HashMap, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use napi::{Env, Error, JsValue, Result, ValueType, bindgen_prelude::*};
use napi_derive::napi;
use serde::Serialize;

use super::database::{WikiCursorBase, WikiError, WikiSearchHit};
use crate::{
	task::{self, CancelToken},
	text::ansi_seq_len_u16,
};

const INVALID_PAGE: &str = "Invalid documentation search page size";
const INVALID_COST: &str = "Invalid documentation search section cost";
const TEXT_BUDGET: usize = 8_000;

#[napi(object, object_from_js = false)]
pub struct WikiNormalizedSearchOptions {
	pub limit:            f64,
	pub character_budget: f64,
}

/// Math.floor, then the historical [1,500] clamp, including infinities.
#[napi]
pub fn wiki_normalize_search_options(
	limit: Option<f64>,
	character_budget: Option<f64>,
) -> Result<WikiNormalizedSearchOptions> {
	let limit = limit.unwrap_or(10.0).floor();
	let limit = if limit.is_nan() {
		limit
	} else {
		limit.clamp(1.0, 500.0)
	};
	let character_budget = page_budget(character_budget)?;
	if !limit.is_finite() {
		return Err(Error::from_reason(INVALID_PAGE));
	}
	Ok(WikiNormalizedSearchOptions { limit, character_budget })
}

fn page_budget(value: Option<f64>) -> Result<f64> {
	let value = value.unwrap_or(f64::INFINITY);
	if value.is_nan() || value < 0.0 {
		return Err(Error::from_reason(INVALID_PAGE));
	}
	Ok(value)
}

#[napi(object, object_from_js = false)]
pub struct WikiPreparedToolQuery {
	#[napi(ts_type = "string")]
	pub query:                  Option<Utf16String>,
	#[napi(ts_type = "string")]
	pub cursor:                 Option<Utf16String>,
	pub mode:                   Option<String>,
	pub r#case:                 Option<bool>,
	pub query_truncated:        bool,
	pub ignored_argument_count: u32,
	#[napi(ts_type = "string")]
	pub error:                  Option<Utf16String>,
	pub error_kind:             Option<String>,
}

fn ascii_units_equal(units: &[u16], bytes: &[u8]) -> bool {
	units.len() == bytes.len()
		&& units
			.iter()
			.zip(bytes)
			.all(|(&unit, &byte)| unit == u16::from(byte))
}

const fn js_whitespace(unit: u16) -> bool {
	matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim_units(units: &[u16]) -> &[u16] {
	let start = units
		.iter()
		.position(|&unit| !js_whitespace(unit))
		.unwrap_or(units.len());
	let end = units
		.iter()
		.rposition(|&unit| !js_whitespace(unit))
		.map_or(start, |position| position + 1);
	&units[start..end]
}

fn truncate_units(units: &[u16], maximum: usize) -> Vec<u16> {
	if units.len() <= maximum {
		return units.to_vec();
	}
	let mut end = maximum.saturating_sub(1);
	if end > 0 && matches!(units[end - 1], 0xd800..=0xdbff) {
		end -= 1;
	}
	let mut output = Vec::with_capacity(end + 1);
	output.extend_from_slice(&units[..end]);
	output.push(0x2026);
	output
}

/// Validation returns domain text for the host's `ToolError`, not a native
/// error pretending to be the host class. Host-provided cursor presence
/// preserves the old `in` check, including inherited and explicitly undefined
/// values.
#[napi(ts_args_type = "query: unknown, cursor: unknown, receivedKeys: string[], cursorPresent?: \
                       boolean | undefined | null, mode?: unknown, caseSensitive?: unknown")]
pub fn wiki_prepare_tool_query(
	query: Unknown<'_>,
	cursor: Unknown<'_>,
	received_keys: Vec<Utf16String>,
	cursor_present: Option<bool>,
	mode: Unknown<'_>,
	r#case: Unknown<'_>,
) -> Result<WikiPreparedToolQuery> {
	let mut received = received_keys;
	received.retain(|key| !ascii_units_equal(key, b"__parseError"));
	let mut result = WikiPreparedToolQuery {
		query:                  None,
		cursor:                 None,
		mode:                   None,
		r#case:                 None,
		query_truncated:        false,
		ignored_argument_count: received
			.iter()
			.filter(|key| {
				!ascii_units_equal(key, b"query")
					&& !ascii_units_equal(key, b"cursor")
					&& !ascii_units_equal(key, b"mode")
					&& !ascii_units_equal(key, b"case")
			})
			.count() as u32,
		error:                  None,
		error_kind:             None,
	};
	let mode_type = mode.get_type()?;
	if mode_type != ValueType::Undefined
		|| received.iter().any(|key| ascii_units_equal(key, b"mode"))
	{
		let mode = if mode_type == ValueType::String {
			Some(String::from_unknown(mode)?)
		} else {
			None
		};
		if let Some("search" | "grep") = mode.as_deref() {
			result.mode = mode;
		} else {
			result.error =
				Some(Utf16String::from("wiki mode must be \"search\" or \"grep\".".to_owned()));
			result.error_kind = Some("invalid_mode".to_owned());
			return Ok(result);
		}
	}
	let case_type = r#case.get_type()?;
	if case_type != ValueType::Undefined
		|| received.iter().any(|key| ascii_units_equal(key, b"case"))
	{
		if case_type != ValueType::Boolean {
			result.error = Some(Utf16String::from("wiki case must be a boolean.".to_owned()));
			result.error_kind = Some("invalid_case".to_owned());
			return Ok(result);
		}
		result.r#case = Some(bool::from_unknown(r#case)?);
	}
	let grep = result.mode.as_deref() == Some("grep");
	if grep {
		result.r#case = Some(result.r#case.unwrap_or(true));
	}
	let query = if query.get_type()? == ValueType::String {
		Some(Utf16String::from_unknown(query)?)
	} else {
		None
	};
	let query = query
		.as_deref()
		.map(|units| if grep { units } else { trim_units(units) })
		.filter(|units| !trim_units(units).is_empty());
	let Some(query) = query else {
		let mut error = Vec::new();
		append(&mut error, "wiki requires a query. Received: ");
		if received.is_empty() {
			append(&mut error, "nothing");
		} else {
			for (index, key) in received.iter().enumerate() {
				if index > 0 {
					append(&mut error, ", ");
				}
				error.extend_from_slice(key);
			}
		}
		append(&mut error, ". Example: {\"query\":\"MBIST\"}");
		result.error = Some(Utf16String::from(error));
		result.error_kind = Some("invalid_query".to_owned());
		return Ok(result);
	};
	if grep && query.len() > 500 {
		result.error =
			Some(Utf16String::from("wiki grep query must not exceed 500 UTF-16 units.".to_owned()));
		result.error_kind = Some("invalid_query".to_owned());
		return Ok(result);
	}
	if cursor_present.unwrap_or_else(|| received.iter().any(|key| ascii_units_equal(key, b"cursor")))
	{
		let cursor = if cursor.get_type()? == ValueType::String {
			Some(Utf16String::from_unknown(cursor)?)
		} else {
			None
		};
		match cursor {
			Some(cursor) if !trim_units(&cursor).is_empty() => result.cursor = Some(cursor),
			_ => {
				result.error = Some(Utf16String::from(
					"wiki cursor must be a nonempty string returned by the previous page.".to_owned(),
				));
				result.error_kind = Some("invalid_cursor".to_owned());
				return Ok(result);
			},
		}
	}
	result.query_truncated = !grep && query.len() > 500;
	result.query = Some(Utf16String::from(if grep {
		query.to_vec()
	} else {
		truncate_units(query, 500)
	}));
	Ok(result)
}

/// Public shape for both the native renderer and caller-local selection.
#[allow(
	dead_code,
	reason = "NAPI output metadata; selection returns original JavaScript hit identities"
)]
#[napi(object, object_from_js = false)]
pub struct WikiSearchResult {
	pub sections:           Vec<WikiSearchHit>,
	pub total:              i64,
	pub exact_name_matches: i64,
	pub technical_name:     Option<String>,
	pub has_more:           bool,
	pub cursor:             Option<String>,
}

#[derive(Serialize)]
struct Cursor<'a> {
	v: u8,
	q: &'a str,
	s: &'a str,
	p: i64,
}

fn continuation(base: &WikiCursorBase, count: usize, total: i64) -> Result<Option<String>> {
	let next = base.p + count as i64;
	if next >= total {
		return Ok(None);
	}
	let bytes = serde_json::to_vec(&Cursor { v: base.v, q: &base.q, s: &base.s, p: next })
		.map_err(|error| Error::from_reason(error.to_string()))?;
	Ok(Some(URL_SAFE_NO_PAD.encode(bytes)))
}

fn result_object<'env>(
	env: &'env Env,
	window: &Object<'env>,
	sections: Array<'env>,
	cursor: Option<&str>,
) -> Result<Object<'env>> {
	let mut result = Object::new(env)?;
	result.set_named_property("sections", sections)?;
	result.set_named_property("total", window.get_named_property::<Unknown>("total")?)?;
	result.set_named_property(
		"exactNameMatches",
		window.get_named_property::<Unknown>("exactNameMatches")?,
	)?;
	let technical_name: Unknown = window.get_named_property("technicalName")?;
	if technical_name.get_type()? != ValueType::Undefined {
		result.set_named_property("technicalName", technical_name)?;
	}
	result.set_named_property("hasMore", cursor.is_some())?;
	if let Some(cursor) = cursor {
		result.set_named_property("cursor", cursor)?;
	}
	Ok(result)
}

fn check_signal(
	env: &Env,
	signal: Option<&Unknown<'_>>,
	indexing_cancellation: bool,
) -> Result<()> {
	if let Some(signal) = signal {
		let object = signal.coerce_to_object()?;
		if object.get_named_property::<bool>("aborted")? {
			if indexing_cancellation {
				return Err(
					WikiError::named("Document indexing cancelled", "AbortError", None).into_napi(*env),
				);
			}
			let throw: Function<(), Unknown> = object.get_named_property("throwIfAborted")?;
			throw.apply(object, ())?;
		}
	}
	Ok(())
}
#[napi]
pub fn wiki_check_indexing_cancellation(
	env: Env,
	#[napi(ts_arg_type = "AbortSignal | undefined | null")] signal: Option<Unknown<'_>>,
) -> Result<()> {
	check_signal(&env, signal.as_ref(), true)
}

#[napi(ts_return_type = "WikiSearchResult")]
pub fn wiki_select_page<'env>(
	env: &'env Env,
	#[napi(ts_arg_type = "WikiSearchWindow")] window: Object<'env>,
	character_budget: Option<f64>,
	#[napi(ts_arg_type = "((hit: WikiSearchHit, position: number) => number | undefined | null) \
	                      | undefined | null")]
	section_cost: Option<Function<'env, FnArgs<(Object<'_>, u32)>, Unknown<'env>>>,
	#[napi(ts_arg_type = "AbortSignal | undefined | null")] signal: Option<Unknown<'env>>,
	indexing_cancellation: Option<bool>,
) -> Result<Object<'env>> {
	let indexing_cancellation = indexing_cancellation.unwrap_or(false);
	check_signal(env, signal.as_ref(), indexing_cancellation)?;
	let budget = page_budget(character_budget)?;
	let hits: Array = window.get_named_property("sections")?;
	let mut selected = env.create_array(0)?;
	let mut cost = 0.0;
	let mut position = 0;
	// Array iterator reads the current length on each step, including callback
	// mutations. Do not snapshot/map the hits or invoke a worker callback.
	loop {
		let current = Array::from_unknown(hits.to_unknown())?;
		if position >= current.len() {
			break;
		}
		check_signal(env, signal.as_ref(), indexing_cancellation)?;
		let hit: Object = current
			.get(position)?
			.ok_or_else(|| Error::from_reason("Missing documentation search hit"))?;
		let callback_cost = section_cost
			.as_ref()
			.map(|callback| callback.call((hit, selected.len()).into()))
			.transpose()?;
		let section_cost = match callback_cost {
			Some(value) if !matches!(value.get_type()?, ValueType::Null | ValueType::Undefined) => {
				if value.get_type()? != ValueType::Number {
					return Err(Error::from_reason(INVALID_COST));
				}
				f64::from_unknown(value)?
			},
			_ => crate::js::utf16(hit.get_named_property::<napi::JsString>("text")?)?.len() as f64,
		};
		if !section_cost.is_finite() || section_cost < 0.0 {
			return Err(Error::from_reason(INVALID_COST));
		}
		if selected.len() > 0 && cost + section_cost > budget {
			break;
		}
		selected.insert(hit)?;
		cost += section_cost;
		position += 1;
	}
	let base: WikiCursorBase = window.get_named_property("cursorBase")?;
	let total: i64 = window.get_named_property("total")?;
	let cursor = continuation(&base, selected.len() as usize, total)?;
	result_object(env, &window, selected, cursor.as_deref())
}

fn append(output: &mut Vec<u16>, text: &str) {
	output.extend(text.encode_utf16());
}

/// JSON.stringify's string quoting, including its well-formed escaping of
/// lone surrogates. Escape DEL/C1 too so outward text sanitization cannot
/// change the query's meaning or its continuation cursor identity.
fn json_string(output: &mut Vec<u16>, units: &[u16]) {
	output.push(b'"' as u16);
	let mut index = 0;
	while index < units.len() {
		let unit = units[index];
		match unit {
			0x22 => append(output, "\\\""),
			0x5c => append(output, "\\\\"),
			0x08 => append(output, "\\b"),
			0x0c => append(output, "\\f"),
			0x0a => append(output, "\\n"),
			0x0d => append(output, "\\r"),
			0x09 => append(output, "\\t"),
			0x00..=0x1f | 0x7f..=0x9f => json_unicode_escape(output, unit),
			0xd800..=0xdbff
				if units
					.get(index + 1)
					.is_some_and(|next| matches!(next, 0xdc00..=0xdfff)) =>
			{
				output.extend_from_slice(&units[index..index + 2]);
				index += 1;
			},
			0xd800..=0xdfff => json_unicode_escape(output, unit),
			_ => output.push(unit),
		}
		index += 1;
	}
	output.push(b'"' as u16);
}

fn json_unicode_escape(output: &mut Vec<u16>, unit: u16) {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	output.extend_from_slice(&[
		b'\\' as u16,
		b'u' as u16,
		u16::from(HEX[(unit >> 12) as usize]),
		u16::from(HEX[((unit >> 8) & 0xf) as usize]),
		u16::from(HEX[((unit >> 4) & 0xf) as usize]),
		u16::from(HEX[(unit & 0xf) as usize]),
	]);
}

fn continuation_json(query: &[u16], cursor: &str, grep: bool, case_sensitive: bool) -> Vec<u16> {
	let mut output = Vec::with_capacity(query.len() + cursor.len() + 24 + if grep { 27 } else { 0 });
	append(&mut output, "{\"query\":");
	json_string(&mut output, query);
	if grep {
		append(&mut output, ",\"mode\":\"grep\",\"case\":");
		append(&mut output, if case_sensitive { "true" } else { "false" });
	}
	append(&mut output, ",\"cursor\":\"");
	// Only the empty allowance cursor or a generated base64url cursor enters
	// here.
	append(&mut output, cursor);
	append(&mut output, "\"}");
	output
}

fn sanitize_locator(units: &[u16]) -> Vec<u16> {
	let malformed = char::decode_utf16(units.iter().copied()).any(|decoded| decoded.is_err());
	let mut output = Vec::with_capacity(units.len());
	let mut index = 0;
	let mut whitespace = false;
	while index < units.len() {
		if let Some(length) = ansi_seq_len_u16(units, index) {
			index += length;
			continue;
		}
		let unit = units[index];
		if matches!(unit, 0xd800..=0xdbff)
			&& units
				.get(index + 1)
				.is_some_and(|next| matches!(next, 0xdc00..=0xdfff))
		{
			output.extend_from_slice(&units[index..index + 2]);
			index += 2;
			whitespace = false;
			continue;
		}
		index += 1;
		// sanitizeText removes CR, C0 except tab/LF, DEL/C1; malformed
		// input additionally drops every replacement character.
		if matches!(unit, 0x00..=0x08 | 0x0b..=0x1f | 0x7f..=0x9f | 0xd800..=0xdfff)
			|| (malformed && unit == 0xfffd)
		{
			continue;
		}
		if matches!(unit, 0x09 | 0x0a) {
			if !whitespace {
				output.push(b' ' as u16);
			}
			whitespace = true;
		} else {
			output.push(unit);
			whitespace = false;
		}
	}
	output
}

fn section_header(index: usize, section: &Object<'_>) -> Result<Vec<u16>> {
	let mut header = Vec::new();
	append(&mut header, &format!("[{index}] "));
	header
		.extend_from_slice(&crate::js::utf16(section.get_named_property::<napi::JsString>("path")?)?);
	append(
		&mut header,
		&format!(
			":{}-{} · ",
			section.get_named_property::<i64>("lineStart")?,
			section.get_named_property::<i64>("lineEnd")?
		),
	);
	header.extend(truncate_units(
		&crate::js::utf16(section.get_named_property::<napi::JsString>("headingPath")?)?,
		300,
	));
	for (prefix, name) in [(" · index=", "index"), (" · sha256=", "documentHash")] {
		append(&mut header, prefix);
		header.extend_from_slice(&crate::js::utf16(
			section.get_named_property::<napi::JsString>(name)?,
		)?);
	}
	append(
		&mut header,
		&format!(" · sectionId={} · match=", section.get_named_property::<i64>("sectionId")?),
	);
	header.extend_from_slice(&crate::js::utf16(
		section.get_named_property::<napi::JsString>("matchKind")?,
	)?);
	Ok(sanitize_locator(&header))
}

#[napi(object, object_from_js = false)]
pub struct WikiToolPage<'env> {
	#[napi(ts_type = "WikiSearchResult")]
	pub result:                 Object<'env>,
	#[napi(ts_type = "string")]
	pub text:                   Utf16String,
	pub rendered_section_count: u32,
	pub rendered_characters:    u32,
	pub duplicate_count:        u32,
	pub oversize_count:         u32,
}

#[napi]
pub fn wiki_tool_page<'env>(
	env: &'env Env,
	query: Utf16String,
	#[napi(ts_arg_type = "WikiSearchWindow")] window: Object<'env>,
	mode: Option<String>,
	case_sensitive: Option<bool>,
) -> Result<WikiToolPage<'env>> {
	let grep = match mode.as_deref() {
		None | Some("search") => false,
		Some("grep") => true,
		_ => return Err(Error::from_reason("wiki mode must be \"search\" or \"grep\".")),
	};
	let case_sensitive = case_sensitive.unwrap_or(true);
	let mut header = Vec::with_capacity(query.len() + 50);
	append(&mut header, "\"");
	header.extend_from_slice(&query);
	append(
		&mut header,
		if grep {
			"\" · grep searched imported Markdown corpus"
		} else {
			"\" · searched imported Markdown corpus"
		},
	);
	let footer_allowance = 512 + continuation_json(&query, "", grep, case_sensitive).len();
	let budget = TEXT_BUDGET.saturating_sub(header.len() + 2 + footer_allowance);
	let hits: Array = window.get_named_property("sections")?;
	let mut selected = env.create_array(0)?;
	let mut bodies = Vec::new();
	let mut shown: HashMap<Vec<u16>, u32> = HashMap::new();
	let mut cost = 0;
	for index in 0..hits.len().min(200) {
		let hit: Object = hits
			.get(index)?
			.ok_or_else(|| Error::from_reason("Missing documentation search hit"))?;
		let text = crate::js::utf16(hit.get_named_property::<napi::JsString>("text")?)?;
		let earlier = if text.len() > 200 {
			shown.get(&*text).copied()
		} else {
			None
		};
		let mut body = section_header(index as usize + 1, &hit)?;
		body.push(b'\n' as u16);
		if let Some(earlier) = earlier {
			append(&mut body, &format!("(identical text to hit [{}] on this page)", earlier + 1));
		} else {
			match hit.get_named_property::<String>("shape")?.as_str() {
				"heading-only" => append(&mut body, "(heading only)\n"),
				"stub" => append(&mut body, "(structural label)\n"),
				_ => {},
			}
			body.extend_from_slice(&text);
		}
		let section_cost = body.len() + if index > 0 { 2 } else { 0 };
		if index > 0 && cost + section_cost > budget {
			break;
		}
		cost += section_cost;
		if earlier.is_none() {
			shown.insert(text.to_vec(), index);
		}
		bodies.push(body);
		selected.insert(hit)?;
	}
	let base: WikiCursorBase = window.get_named_property("cursorBase")?;
	let total: i64 = window.get_named_property("total")?;
	let exact: i64 = window.get_named_property("exactNameMatches")?;
	let technical: Option<Utf16String> = window.get_named_property("technicalName")?;
	let cursor = continuation(&base, selected.len() as usize, total)?;
	let result = result_object(env, &window, selected, cursor.as_deref())?;
	let pointer = b"\n(identical text to hit [";
	let duplicates = bodies
		.iter()
		.filter(|body| {
			body
				.windows(pointer.len())
				.any(|window| ascii_units_equal(window, pointer))
		})
		.count();
	let mut text = header;
	for body in &bodies {
		append(&mut text, "\n\n");
		text.extend_from_slice(body);
	}
	let oversized = !bodies.is_empty() && text.len() + footer_allowance > TEXT_BUDGET;
	append(
		&mut text,
		&format!(
			"\n\n{total} matching section(s) in the searched imported corpus; this page carries {}.",
			bodies.len()
		),
	);
	if !grep && technical.as_ref().is_some_and(|name| !name.is_empty()) {
		if exact > 0 {
			append(
				&mut text,
				&format!(
					"\n{exact} exact-name section(s); other hits are related, not complete-name \
					 evidence."
				),
			);
		} else {
			append(
				&mut text,
				"\n未找到完整名称命中; any returned hits are related, not complete-name evidence.",
			);
		}
	}
	if total == 0 {
		append(
			&mut text,
			"\n0 matches does not establish that the information does not exist elsewhere.",
		);
	}
	if duplicates > 0 {
		append(
			&mut text,
			&format!(
				"\n{duplicates} repeated hit(s) collapsed to a page-local pointer; all source \
				 locators retained."
			),
		);
	}
	if oversized {
		append(
			&mut text,
			"\nThe first section exceeds the ~8000-character target and is carried whole.",
		);
	}
	if let Some(cursor) = cursor {
		append(&mut text, "\nMore results remain. Continue with the same query: ");
		text.extend(continuation_json(&query, &cursor, grep, case_sensitive));
	} else {
		append(&mut text, "\nAll matching results exhausted in the searched imported corpus.");
	}
	Ok(WikiToolPage {
		result,
		rendered_section_count: bodies.len() as u32,
		rendered_characters: text.len() as u32,
		duplicate_count: duplicates as u32,
		oversize_count: u32::from(oversized),
		text: Utf16String::from(text),
	})
}

pub struct WikiMinimumComplete {
	cancel: CancelToken,
}
impl TypeName for WikiMinimumComplete {
	fn type_name() -> &'static str {
		"void"
	}

	fn value_type() -> ValueType {
		ValueType::Undefined
	}
}
impl ToNapiValue for WikiMinimumComplete {
	unsafe fn to_napi_value(env: napi::sys::napi_env, value: Self) -> Result<napi::sys::napi_value> {
		if let Some(reason) = value.cancel.abort_reason() {
			return Err(task::abort_error(Env::from_raw(env), reason));
		}
		// SAFETY: the promise settles on its live JS environment.
		unsafe { <()>::to_napi_value(env, ()) }
	}
}

/// Caller elapsed time includes startup, IPC queueing, query and page work.
/// A Tokio monotonic deadline is rechecked after every wake; no DB/owner lock
/// or worker-thread sleep is involved. Settlement also rejects late aborts.
#[napi(ts_return_type = "Promise<void>")]
pub fn wiki_wait_minimum<'env>(
	env: &'env Env,
	elapsed_milliseconds: f64,
	#[napi(ts_arg_type = "AbortSignal | undefined | null")] signal: Option<Unknown<'env>>,
) -> Result<PromiseRaw<'env, WikiMinimumComplete>> {
	let cancel = CancelToken::new(None, signal);
	let remaining = (500.0 - elapsed_milliseconds).clamp(0.0, 500.0);
	let remaining = if remaining.is_nan() { 0.0 } else { remaining };
	let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(remaining / 1000.0);
	task::future(env, "wiki_minimum", async move {
		loop {
			if cancel.aborted() || tokio::time::Instant::now() >= deadline {
				break;
			}
			tokio::select! {
				biased;
				_ = cancel.wait() => break,
				() = tokio::time::sleep_until(deadline) => {},
			}
		}
		Ok(WikiMinimumComplete { cancel })
	})
}
