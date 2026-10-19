use std::{
	collections::{HashMap, VecDeque},
	fs,
	path::Path,
	sync::Arc,
	time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use napi::{
	Env, Error, JsValue,
	bindgen_prelude::{JsObjectValue, ToNapiValue, create_object_with_properties},
};
use napi_derive::napi;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, types::ValueRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
	markdown,
	projection::{DocumentProjection, SectionProjection},
	query::{self, Candidate, LiteralMatcher, MatchKind, RankedSection, SectionContext},
};

const INVALID_CURSOR: &str = "Invalid documentation search cursor";
const INDEX_ROWS: &str = "SELECT i.id,i.name,i.root_path,d.id \
                          document_id,d.relative_path,d.title,d.source_kind,d.sha256,d.size_bytes,\
                          d.mtime_ms FROM doc_indexes i LEFT JOIN documents d ON d.index_id=i.id \
                          WHERE i.name NOT GLOB '__building__*' ORDER BY i.id,d.id";
const SECTION_ROWS: &str = "SELECT s.id \
                            section_id,s.document_id,s.index_id,s.ordinal,s.byte_start,s.byte_end,\
                            s.heading_level,i.name index_name,d.relative_path,d.sha256 \
                            document_hash,s.heading_path,s.line_start,s.line_end,s.raw_markdown \
                            FROM sections s JOIN documents d ON d.id=s.document_id JOIN \
                            doc_indexes i ON i.id=s.index_id WHERE i.name NOT GLOB \
                            '__building__*' ORDER BY s.id";
const HYDRATE: &str = "SELECT s.id section_id,i.name index_name,d.sha256 \
                       document_hash,d.relative_path,s.heading_path,s.line_start,s.line_end,s.\
                       raw_markdown FROM sections s JOIN documents d ON d.id=s.document_id JOIN \
                       doc_indexes i ON i.id=s.index_id WHERE s.id=? AND i.name NOT GLOB \
                       '__building__*'";
type CoreResult<T> = std::result::Result<T, WikiError>;
type Check<'a> = &'a dyn Fn() -> CoreResult<()>;

#[derive(Debug)]
pub struct WikiError {
	message: String,
	sqlite:  Option<i32>,
	name:    Option<String>,
	code:    Option<String>,
}
impl WikiError {
	pub(super) fn message(message: impl Into<String>) -> Self {
		Self { message: message.into(), sqlite: None, name: None, code: None }
	}

	pub(super) fn named(message: impl Into<String>, name: &str, code: Option<&str>) -> Self {
		Self {
			message: message.into(),
			sqlite:  None,
			name:    Some(name.to_owned()),
			code:    code.map(str::to_owned),
		}
	}

	pub(super) fn error_message(&self) -> &str {
		&self.message
	}

	pub(super) fn diagnostic_error_type(&self) -> &str {
		self.name.as_deref().unwrap_or_else(|| {
			if self.sqlite.is_some() {
				"SQLiteError"
			} else {
				"Error"
			}
		})
	}

	pub(super) fn diagnostic_code(&self) -> Option<&str> {
		self
			.code
			.as_deref()
			.or_else(|| self.sqlite.map(sqlite_code))
	}

	pub(super) const fn diagnostic_sqlite_code(&self) -> Option<i32> {
		self.sqlite
	}

	pub(super) fn into_napi(self, env: Env) -> Error {
		let fallback = Error::from_reason(self.message.clone());
		if self.sqlite.is_none() && self.name.is_none() && self.code.is_none() {
			return fallback;
		}
		let built = (|| -> napi::Result<Error> {
			let mut error = if self.diagnostic_error_type() == "TypeError" {
				napi::JsTypeError::from(Error::from_reason(self.message.clone()))
					.into_unknown(env)
					.coerce_to_object()?
			} else {
				env.create_error(Error::from_reason(self.message.clone()))?
			};
			error.set_named_property("name", self.diagnostic_error_type())?;
			if let Some(code) = self.diagnostic_code() {
				error.set_named_property("code", code)?;
			}
			if let Some(code) = self.sqlite {
				error.set_named_property("errno", code)?;
			}
			Ok(Error::from(error.to_unknown()))
		})();
		built.unwrap_or(fallback)
	}
}
impl From<rusqlite::Error> for WikiError {
	fn from(error: rusqlite::Error) -> Self {
		if let rusqlite::Error::SqliteFailure(code, message) = error {
			Self {
				message: message.unwrap_or_else(|| code.to_string()),
				sqlite:  Some(code.extended_code),
				name:    None,
				code:    None,
			}
		} else {
			Self::message(error.to_string())
		}
	}
}
impl From<std::io::Error> for WikiError {
	fn from(error: std::io::Error) -> Self {
		Self::message(error.to_string())
	}
}
const fn sqlite_code(code: i32) -> &'static str {
	match code {
		256 => "SQLITE_OK_LOAD_PERMANENTLY",
		512 => "SQLITE_OK_SYMLINK",
		257 => "SQLITE_ERROR_MISSING_COLLSEQ",
		513 => "SQLITE_ERROR_RETRY",
		769 => "SQLITE_ERROR_SNAPSHOT",
		516 => "SQLITE_ABORT_ROLLBACK",
		261 => "SQLITE_BUSY_RECOVERY",
		517 => "SQLITE_BUSY_SNAPSHOT",
		773 => "SQLITE_BUSY_TIMEOUT",
		262 => "SQLITE_LOCKED_SHAREDCACHE",
		518 => "SQLITE_LOCKED_VTAB",
		264 => "SQLITE_READONLY_RECOVERY",
		520 => "SQLITE_READONLY_CANTLOCK",
		776 => "SQLITE_READONLY_ROLLBACK",
		1032 => "SQLITE_READONLY_DBMOVED",
		1288 => "SQLITE_READONLY_CANTINIT",
		1544 => "SQLITE_READONLY_DIRECTORY",
		266 => "SQLITE_IOERR_READ",
		522 => "SQLITE_IOERR_SHORT_READ",
		778 => "SQLITE_IOERR_WRITE",
		1034 => "SQLITE_IOERR_FSYNC",
		1290 => "SQLITE_IOERR_DIR_FSYNC",
		1546 => "SQLITE_IOERR_TRUNCATE",
		1802 => "SQLITE_IOERR_FSTAT",
		2058 => "SQLITE_IOERR_UNLOCK",
		2314 => "SQLITE_IOERR_RDLOCK",
		2570 => "SQLITE_IOERR_DELETE",
		2826 => "SQLITE_IOERR_BLOCKED",
		3082 => "SQLITE_IOERR_NOMEM",
		3338 => "SQLITE_IOERR_ACCESS",
		3594 => "SQLITE_IOERR_CHECKRESERVEDLOCK",
		3850 => "SQLITE_IOERR_LOCK",
		4106 => "SQLITE_IOERR_CLOSE",
		4362 => "SQLITE_IOERR_DIR_CLOSE",
		4618 => "SQLITE_IOERR_SHMOPEN",
		4874 => "SQLITE_IOERR_SHMSIZE",
		5130 => "SQLITE_IOERR_SHMLOCK",
		5386 => "SQLITE_IOERR_SHMMAP",
		5642 => "SQLITE_IOERR_SEEK",
		5898 => "SQLITE_IOERR_DELETE_NOENT",
		6154 => "SQLITE_IOERR_MMAP",
		6410 => "SQLITE_IOERR_GETTEMPPATH",
		6666 => "SQLITE_IOERR_CONVPATH",
		6922 => "SQLITE_IOERR_VNODE",
		7178 => "SQLITE_IOERR_AUTH",
		7434 => "SQLITE_IOERR_BEGIN_ATOMIC",
		7690 => "SQLITE_IOERR_COMMIT_ATOMIC",
		7946 => "SQLITE_IOERR_ROLLBACK_ATOMIC",
		8202 => "SQLITE_IOERR_DATA",
		8458 => "SQLITE_IOERR_CORRUPTFS",
		8714 => "SQLITE_IOERR_IN_PAGE",
		267 => "SQLITE_CORRUPT_VTAB",
		523 => "SQLITE_CORRUPT_SEQUENCE",
		779 => "SQLITE_CORRUPT_INDEX",
		270 => "SQLITE_CANTOPEN_NOTEMPDIR",
		526 => "SQLITE_CANTOPEN_ISDIR",
		782 => "SQLITE_CANTOPEN_FULLPATH",
		1038 => "SQLITE_CANTOPEN_CONVPATH",
		1294 => "SQLITE_CANTOPEN_DIRTYWAL",
		1550 => "SQLITE_CANTOPEN_SYMLINK",
		275 => "SQLITE_CONSTRAINT_CHECK",
		531 => "SQLITE_CONSTRAINT_COMMITHOOK",
		787 => "SQLITE_CONSTRAINT_FOREIGNKEY",
		1043 => "SQLITE_CONSTRAINT_FUNCTION",
		1299 => "SQLITE_CONSTRAINT_NOTNULL",
		1555 => "SQLITE_CONSTRAINT_PRIMARYKEY",
		1811 => "SQLITE_CONSTRAINT_TRIGGER",
		2067 => "SQLITE_CONSTRAINT_UNIQUE",
		2323 => "SQLITE_CONSTRAINT_VTAB",
		2579 => "SQLITE_CONSTRAINT_ROWID",
		2835 => "SQLITE_CONSTRAINT_PINNED",
		3091 => "SQLITE_CONSTRAINT_DATATYPE",
		279 => "SQLITE_AUTH_USER",
		283 => "SQLITE_NOTICE_RECOVER_WAL",
		539 => "SQLITE_NOTICE_RECOVER_ROLLBACK",
		795 => "SQLITE_NOTICE_RBU",
		284 => "SQLITE_WARNING_AUTOINDEX",
		_ => match code & 255 {
			1 => "SQLITE_ERROR",
			2 => "SQLITE_INTERNAL",
			3 => "SQLITE_PERM",
			4 => "SQLITE_ABORT",
			5 => "SQLITE_BUSY",
			6 => "SQLITE_LOCKED",
			7 => "SQLITE_NOMEM",
			8 => "SQLITE_READONLY",
			9 => "SQLITE_INTERRUPT",
			10 => "SQLITE_IOERR",
			11 => "SQLITE_CORRUPT",
			12 => "SQLITE_NOTFOUND",
			13 => "SQLITE_FULL",
			14 => "SQLITE_CANTOPEN",
			15 => "SQLITE_PROTOCOL",
			16 => "SQLITE_EMPTY",
			17 => "SQLITE_SCHEMA",
			18 => "SQLITE_TOOBIG",
			19 => "SQLITE_CONSTRAINT",
			20 => "SQLITE_MISMATCH",
			21 => "SQLITE_MISUSE",
			22 => "SQLITE_NOLFS",
			23 => "SQLITE_AUTH",
			24 => "SQLITE_FORMAT",
			25 => "SQLITE_RANGE",
			26 => "SQLITE_NOTADB",
			27 => "SQLITE_NOTICE",
			28 => "SQLITE_WARNING",
			_ => "SQLITE_ERROR",
		},
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
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
	v: u8,
	q: String,
	s: String,
	p: u64,
}
fn decode_cursor(value: &str) -> CoreResult<Cursor> {
	let invalid = || WikiError::message(INVALID_CURSOR);
	if value.is_empty()
		|| !value
			.bytes()
			.all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
	{
		return Err(invalid());
	}
	let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid())?;
	if URL_SAFE_NO_PAD.encode(&bytes) != value {
		return Err(invalid());
	}
	// JSON.parse accepts integer-valued floating JSON numbers (1.0, 1e0).
	let parsed: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
	let object = parsed.as_object().ok_or_else(invalid)?;
	if object.len() != 4 {
		return Err(invalid());
	}
	let v = object
		.get("v")
		.and_then(serde_json::Value::as_f64)
		.ok_or_else(invalid)?;
	let p = object
		.get("p")
		.and_then(serde_json::Value::as_f64)
		.ok_or_else(invalid)?;
	let q = object
		.get("q")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(invalid)?;
	let s = object
		.get("s")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(invalid)?;
	let hash = |text: &str| {
		text.len() == 64
			&& text
				.bytes()
				.all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
	};
	if v != 1.0 || p < 1.0 || p > 9_007_199_254_740_991.0 || p.fract() != 0.0 || !hash(q) || !hash(s)
	{
		return Err(invalid());
	}
	Ok(Cursor { v: 1, q: q.to_owned(), s: s.to_owned(), p: p as u64 })
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
struct Ranking {
	ranked:             Vec<RankedSection>,
	version:            String,
	exact_name_matches: usize,
}

pub(super) struct DatabaseEngine {
	path:            String,
	cursor_path:     String,
	connection:      Option<Connection>,
	identity:        String,
	generation:      u64,
	cache_guard:     Option<String>,
	cache:           VecDeque<(String, Arc<Ranking>)>,
	cached_sections: usize,
	#[cfg(test)]
	rank_builds:     usize,
	#[cfg(test)]
	after_snapshot:  Option<Box<dyn FnMut() -> CoreResult<()> + Send>>,
}
impl DatabaseEngine {
	pub(super) const fn new(path: String, cursor_path: String) -> Self {
		Self {
			path,
			cursor_path,
			connection: None,
			identity: String::new(),
			generation: 0,
			cache_guard: None,
			cache: VecDeque::new(),
			cached_sections: 0,
			#[cfg(test)]
			rank_builds: 0,
			#[cfg(test)]
			after_snapshot: None,
		}
	}

	pub(super) fn close(&mut self) {
		self.clear_cache();
		self.connection = None;
	}

	fn clear_cache(&mut self) {
		self.cache.clear();
		self.cached_sections = 0;
		self.cache_guard = None;
	}

	fn ensure_database(&mut self) -> CoreResult<()> {
		let identity = file_identity(Path::new(&self.path))?;
		if self.connection.is_some() && identity == self.identity {
			return Ok(());
		}
		self.close();
		let (connection, identity) = open_identified_connection(Path::new(&self.path), || {
			Ok(Connection::open_with_flags(
				&self.path,
				OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
			)?)
		})?;
		connection.busy_timeout(Duration::from_secs(5))?;
		// Share up to 500 MiB of file pages without enlarging the private page
		// cache.
		connection.execute_batch(
			"PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA mmap_size=524288000;",
		)?;
		check_file_identity(Path::new(&self.path), &identity)?;
		self.identity = identity;
		self.generation += 1;
		self.connection = Some(connection);
		Ok(())
	}

	fn guard(&self) -> CoreResult<String> {
		let connection = self.connection.as_ref().expect("opened search connection");
		let version: i64 = connection.query_row("PRAGMA data_version", [], |row| row.get(0))?;
		let changes: i64 = connection.query_row("SELECT total_changes()", [], |row| row.get(0))?;
		Ok(format!(
			"{}:{}:{version}:{changes}",
			file_identity(Path::new(&self.path))?,
			self.generation
		))
	}

	fn publish(&mut self, key: String, rank: Arc<Ranking>, guard: String) {
		if self.cache_guard.as_ref() != Some(&guard) {
			self.clear_cache();
			self.cache_guard = Some(guard);
		}
		if let Some(position) = self.cache.iter().position(|(stored, _)| stored == &key) {
			self.cached_sections -= self
				.cache
				.remove(position)
				.expect("cache entry")
				.1
				.ranked
				.len();
		}
		self.cached_sections += rank.ranked.len();
		self.cache.push_back((key, rank));
		while self.cache.len() > 8 || (self.cache.len() > 1 && self.cached_sections > 1_000_000) {
			self.cached_sections -= self
				.cache
				.pop_front()
				.expect("nonempty cache")
				.1
				.ranked
				.len();
		}
	}

	pub(super) fn search<F>(
		&mut self,
		query_text: &str,
		options: &WikiSearchOptions,
		check: F,
	) -> CoreResult<WikiSearchOutput>
	where
		F: Fn() -> CoreResult<()> + Clone + Send + 'static,
	{
		check()?;
		self.ensure_database()?;
		let limit = options.limit.unwrap_or(10.0).floor();
		if limit.is_nan() {
			return Err(WikiError::message("Invalid documentation search page size"));
		}
		let limit = limit.clamp(1.0, 500.0) as usize;
		let grep = match options.mode.as_deref().unwrap_or("search") {
			"search" => None,
			"grep" => {
				if query_text
					.trim_matches(query::is_ecmascript_whitespace)
					.is_empty()
				{
					return Err(WikiError::message("Missing documentation grep query"));
				}
				if query_text.encode_utf16().count() > 500 {
					return Err(WikiError::message("Documentation grep query exceeds 500 UTF-16 units"));
				}
				Some(
					crate::grep::build_strict_matcher(query_text, !options.r#case.unwrap_or(true))
						.map_err(|error| WikiError::message(error.reason))?,
				)
			},
			_ => return Err(WikiError::message("Invalid documentation search mode")),
		};
		let plan = if grep.is_some() {
			query::QueryPlan {
				terms:          Vec::new(),
				technical_name: None,
				fts:            String::new(),
			}
		} else {
			query::analyze_query(query_text)
		};
		let cursor = options.cursor.as_deref().map(decode_cursor).transpose()?;
		let key_json = if grep.is_some() {
			serde_json::to_string(&(
				query_text,
				"grep",
				options.r#case.unwrap_or(true),
				&options.index,
				&self.cursor_path,
			))
		} else {
			// Preserve the original search cursor identity, including ignored
			// case.
			serde_json::to_string(&(
				query::normalize_search_text(query_text),
				&options.index,
				&self.cursor_path,
			))
		}
		.expect("JSON strings");
		let key = digest(key_json.as_bytes());
		if cursor.as_ref().is_some_and(|cursor| cursor.q != key) {
			return Err(WikiError::message(
				"Documentation search cursor does not match query or index",
			));
		}
		loop {
			check()?;
			let mut cache_hit = false;
			let mut built = None;
			let result = (|| -> CoreResult<(String, WikiSearchWindow)> {
				let progress_check = check.clone();
				self
					.connection
					.as_ref()
					.expect("connection")
					.progress_handler(1000, Some(move || progress_check().is_err()))?;
				let before = self.guard()?;
				if self.cache_guard.as_ref() != Some(&before) {
					self.clear_cache();
					self.cache_guard = Some(before.clone());
				}
				self
					.connection
					.as_ref()
					.expect("connection")
					.execute_batch("BEGIN DEFERRED")?;
				self
					.connection
					.as_ref()
					.expect("connection")
					.query_row(
						"SELECT id FROM doc_indexes WHERE name NOT GLOB '__building__*' LIMIT 1",
						[],
						|_| Ok(()),
					)
					.map_err(|error| match error {
						rusqlite::Error::QueryReturnedNoRows => {
							WikiError::message("No documentation indexes available")
						},
						other => other.into(),
					})?;
				#[cfg(test)]
				if let Some(hook) = self.after_snapshot.as_mut() {
					hook()?;
				}
				let snapshot_guard = self.guard()?;
				let ranking = if snapshot_guard == before {
					self
						.cache
						.iter()
						.find(|(stored, _)| stored == &key)
						.map(|(_, ranking)| Arc::clone(ranking))
				} else {
					None
				};
				cache_hit = ranking.is_some();
				let ranking = if let Some(ranking) = ranking {
					ranking
				} else {
					#[cfg(test)]
					{
						self.rank_builds += 1;
					}
					let connection = self.connection.as_ref().expect("connection");
					let ranking = Arc::new(if let Some(matcher) = grep.as_ref() {
						rank_grep(connection, matcher, options.index.as_deref(), &check)?
					} else {
						rank(connection, query_text, &plan, options.index.as_deref(), &check)?
					});
					built = Some(Arc::clone(&ranking));
					ranking
				};
				if cursor
					.as_ref()
					.is_some_and(|cursor| cursor.s != ranking.version)
				{
					return Err(WikiError::message(
						"Stale documentation search cursor: indexed snapshot has changed",
					));
				}
				let start = cursor.as_ref().map_or(0, |cursor| cursor.p as usize);
				if cursor.is_some() && start >= ranking.ranked.len() {
					return Err(WikiError::message(INVALID_CURSOR));
				}
				let mut statement = self
					.connection
					.as_ref()
					.expect("connection")
					.prepare_cached(HYDRATE)?;
				let mut sections =
					Vec::with_capacity(limit.min(ranking.ranked.len().saturating_sub(start)));
				for entry in ranking.ranked.iter().skip(start).take(limit) {
					check()?;
					let hit = statement
						.query_row([entry.section_id], |row| {
							Ok(WikiSearchHit {
								section_id:    entry.section_id,
								index:         row.get(1)?,
								document_hash: row.get(2)?,
								path:          row.get(3)?,
								heading_path:  row.get(4)?,
								line_start:    row.get(5)?,
								line_end:      row.get(6)?,
								text:          row.get(7)?,
								shape:         entry.shape,
								match_kind:    entry.match_kind,
								rank:          entry.rank,
							})
						})
						.map_err(|error| match error {
							rusqlite::Error::QueryReturnedNoRows => {
								WikiError::message("Documentation search snapshot is inconsistent")
							},
							other => other.into(),
						})?;
					sections.push(hit);
				}
				Ok((before, WikiSearchWindow {
					sections,
					total: ranking.ranked.len() as i64,
					exact_name_matches: ranking.exact_name_matches as i64,
					technical_name: plan.technical_name.clone(),
					cursor_base: WikiCursorBase {
						v: 1,
						q: key.clone(),
						s: ranking.version.clone(),
						p: start as i64,
					},
				}))
			})();
			// Clear the callback even when registration, guards, or BEGIN failed.
			// Cleanup must precede cancellation/error propagation.
			let connection = self.connection.as_ref().expect("connection");
			let clear = connection.progress_handler(0, None::<fn() -> bool>);
			let finish = if connection.is_autocommit() {
				Ok(())
			} else {
				connection.execute_batch(if result.is_ok() && clear.is_ok() {
					"COMMIT"
				} else {
					"ROLLBACK"
				})
			};
			if let Err(error) = clear.and(finish) {
				// Discard any connection whose hook or transaction could not be
				// cleaned up; dropping it removes hooks and rolls back open work.
				self.close();
				return Err(error.into());
			}
			check()?;
			let (before, result) = result?;
			let after = self.guard()?;
			if before != after {
				self.clear_cache();
				if cache_hit {
					self.ensure_database()?;
					continue;
				}
			} else if let Some(ranking) = built {
				self.publish(key, ranking, before);
			} else if let Some(position) = self.cache.iter().position(|(stored, _)| stored == &key) {
				let entry = self.cache.remove(position).expect("cache hit");
				self.cache.push_back(entry);
			}
			return Ok(WikiSearchOutput { result, cache_hit, term_count: plan.terms.len() as i64 });
		}
	}
}

fn rank_grep(
	connection: &Connection,
	matcher: &pi_builtins::CompiledMatcher,
	index: Option<&str>,
	check: Check<'_>,
) -> CoreResult<Ranking> {
	let mut snapshot = Sha256::new();
	let mut buffer = String::new();
	for sql in [INDEX_ROWS, SECTION_ROWS] {
		let mut statement = connection.prepare_cached(sql)?;
		let mut rows = statement.query([])?;
		while let Some(row) = rows.next()? {
			check()?;
			hash_row(&mut snapshot, row, &mut buffer)?;
		}
	}
	// FTS changes still invalidate the database snapshot, although FTS never
	// supplies grep candidates. Stream shadow payloads without any schema work.
	for sql in [
		"SELECT id,block FROM sections_fts_data ORDER BY id",
		"SELECT segid,term,pgno FROM sections_fts_idx ORDER BY segid,term",
		"SELECT id,sz FROM sections_fts_docsize ORDER BY id",
		"SELECT k,v FROM sections_fts_config ORDER BY k",
	] {
		snapshot.update(sql.as_bytes());
		let mut statement = connection.prepare_cached(sql)?;
		let mut rows = statement.query([])?;
		while let Some(row) = rows.next()? {
			check()?;
			for column in 0..row.as_ref().column_count() {
				match row.get_ref(column)? {
					ValueRef::Blob(bytes) | ValueRef::Text(bytes) => {
						snapshot.update((bytes.len() as u64).to_le_bytes());
						for chunk in bytes.chunks(16_384) {
							check()?;
							snapshot.update(chunk);
						}
					},
					ValueRef::Integer(number) => snapshot.update(number.to_le_bytes()),
					ValueRef::Real(number) => snapshot.update(number.to_le_bytes()),
					ValueRef::Null => snapshot.update(b"null"),
				}
			}
		}
	}
	let ranked = super::grep::scan(connection, matcher, index, check)?;
	Ok(Ranking { ranked, version: format!("{:x}", snapshot.finalize()), exact_name_matches: 0 })
}

fn rank(
	connection: &Connection,
	query_text: &str,
	plan: &query::QueryPlan,
	index: Option<&str>,
	check: Check<'_>,
) -> CoreResult<Ranking> {
	let mut ranks = HashMap::new();
	let mut ordered_ranks = Vec::new();
	if !plan.terms.is_empty() {
		let filter = if index.is_some_and(|index| !index.is_empty()) {
			" AND i.name=?"
		} else {
			""
		};
		let sql = format!(
			"SELECT f.rowid section_id,bm25(sections_fts,0.0,0.0,0.5,2.0,1.0) rank FROM sections_fts \
			 f JOIN sections s ON s.id=f.rowid JOIN doc_indexes i ON i.id=s.index_id WHERE \
			 sections_fts MATCH ? AND i.name NOT GLOB '__building__*'{filter} ORDER BY f.rowid"
		);
		let mut statement = connection.prepare_cached(&sql)?;
		let mut rows = if filter.is_empty() {
			statement.query([&plan.fts])?
		} else {
			statement.query(rusqlite::params![plan.fts, index.map(super::storage::sqlite_text)])?
		};
		while let Some(row) = rows.next()? {
			check()?;
			let id: i64 = row.get(0)?;
			let value: f64 = row.get(1)?;
			ranks.insert(id, value);
			ordered_ranks.push((id, value));
		}
	}
	let name = plan.technical_name.as_deref().map(|name| {
		LiteralMatcher::new(
			&query::normalize_search_text(name),
			!name.contains(['/', '\\']) && !name.contains("::"),
		)
	});
	let mut snapshot = Sha256::new();
	let mut buffer = String::new();
	{
		let mut statement = connection.prepare_cached(INDEX_ROWS)?;
		let mut rows = statement.query([])?;
		while let Some(row) = rows.next()? {
			check()?;
			hash_row(&mut snapshot, row, &mut buffer)?;
		}
	}
	let mut document_contexts: HashMap<i64, DocumentContexts> = HashMap::new();
	let mut candidates = Vec::new();
	let mut statement = connection.prepare_cached(SECTION_ROWS)?;
	let mut rows = statement.query([])?;
	while let Some(row) = rows.next()? {
		check()?;
		hash_row(&mut snapshot, row, &mut buffer)?;
		if let Some(index) = index
			&& !matches!(row.get_ref(7)?, ValueRef::Text(name) if name == index.as_bytes())
		{
			continue;
		}
		let id: i64 = row.get(0)?;
		let bm25 = ranks.get(&id).copied();
		if bm25.is_none() && name.is_none() {
			continue;
		}
		let document_id: i64 = row.get(1)?;
		if let std::collections::hash_map::Entry::Vacant(entry) = document_contexts.entry(document_id)
		{
			entry.insert(load_contexts(connection, document_id, name.as_ref(), check)?);
		}
		let contexts = document_contexts
			.get_mut(&document_id)
			.expect("loaded document contexts");
		// Source-aware name matching has already decided these rows. Avoid
		// copying and projecting their bodies when neither recall path matched.
		if bm25.is_none() && contexts.exact_names.get(&id) == Some(&false) {
			continue;
		}
		let projection = contexts.projections.remove(&id);
		let context = contexts.sections.get(&id);
		if projection.is_none() && context.is_none() {
			return Err(WikiError::message("Documentation search snapshot is inconsistent"));
		}
		let markdown: String = row.get(13)?;
		let raw = query::normalize_search_text(&markdown);
		let exact = if let Some(exact) = contexts.exact_names.get(&id) {
			*exact
		} else if let Some(name) = name.as_ref() {
			// Legacy rows without source coordinates retain the same contextual
			// matcher, even when their scoring fields were prepared at import.
			let context = context
				.ok_or_else(|| WikiError::message("Documentation search snapshot is inconsistent"))?;
			name.matches_name_section(&raw, &markdown, context)
		} else {
			false
		};
		if bm25.is_none() && !exact {
			continue;
		}
		let (plain, title, shape) = if let Some(projection) = projection {
			(projection.plain, projection.title, projection.shape)
		} else {
			let context = context.expect("reconstructed section context");
			let tokens = markdown::lex_section(&markdown, context);
			(
				query::normalize_search_text(&markdown::plain_text(&tokens)),
				query::normalize_search_text(&markdown::local_title(&markdown, context)),
				context.shape,
			)
		};
		candidates.push(Candidate {
			section_id: id,
			raw_markdown: markdown,
			raw,
			plain,
			title,
			shape,
			exact,
			rank: bm25.unwrap_or(0.0),
		});
	}
	// JSON.stringify([...ranks]) uses JS's float formatter, not serde_json's.
	buffer.clear();
	buffer.push('[');
	for (position, (id, rank)) in ordered_ranks.into_iter().enumerate() {
		check()?;
		if position != 0 {
			buffer.push(',');
		}
		buffer.push('[');
		push_number(&mut buffer, id as f64);
		buffer.push(',');
		push_number(&mut buffer, rank);
		buffer.push(']');
		// Keep hashing streamed and avoid a corpus-sized rank JSON allocation.
		snapshot.update(buffer.as_bytes());
		buffer.clear();
	}
	buffer.push(']');
	snapshot.update(buffer.as_bytes());
	let ranked = query::rank_candidates_with_check(query_text, &plan.terms, candidates, check)?;
	let exact_name_matches = ranked
		.iter()
		.filter(|entry| entry.match_kind == MatchKind::ExactName)
		.count();
	Ok(Ranking { ranked, version: format!("{:x}", snapshot.finalize()), exact_name_matches })
}

struct DocumentContexts {
	sections:    HashMap<i64, SectionContext>,
	exact_names: HashMap<i64, bool>,
	projections: HashMap<i64, SectionProjection>,
}

/// Only contiguous, byte-consistent stored source participates in a name
/// occurrence. Never fill a source gap or concatenate independent documents.
#[derive(Default)]
struct NameSource {
	start:       i64,
	source:      String,
	sections:    Vec<(i64, std::ops::Range<usize>)>,
	exact_names: HashMap<i64, bool>,
}

impl NameSource {
	fn finish(&mut self, name: &LiteralMatcher, check: Check<'_>) -> CoreResult<()> {
		if !self.sections.is_empty() {
			for (id, _) in &self.sections {
				self.exact_names.insert(*id, false);
			}
			// Source ranges can overlap, so order by starts rather than assuming
			// section ends are monotonic. Each section is consumed at most once:
			// it either intersects this occurrence or ended before it.
			self.sections.sort_unstable_by_key(|(_, range)| range.start);
			let mut pending = self.sections.iter().peekable();
			let exact_names = &mut self.exact_names;
			name.source_name_matches(&self.source, check, |found| {
				while let Some((id, range)) = pending.peek()
					&& range.start < found.end
				{
					if range.end > found.start {
						exact_names.insert(*id, true);
					}
					pending.next();
				}
				pending.peek().is_some()
			})?;
		}
		self.source.clear();
		self.sections.clear();
		Ok(())
	}

	fn push(
		&mut self,
		section: &markdown::ContextSection,
		name: &LiteralMatcher,
		check: Check<'_>,
	) -> CoreResult<()> {
		// Legacy rows with non-source byte coordinates still use their
		// existing local matcher, but cannot establish source adjacency.
		if section.byte_end.checked_sub(section.byte_start) != Some(section.raw_markdown.len() as i64)
		{
			self.finish(name, check)?;
			return Ok(());
		}
		let offset = section
			.byte_start
			.checked_sub(self.start)
			.and_then(|offset| usize::try_from(offset).ok());
		let contiguous = offset.is_some_and(|offset| {
			if offset > self.source.len() {
				return false;
			}
			let overlap = (self.source.len() - offset).min(section.raw_markdown.len());
			self.source.get(offset..offset + overlap) == section.raw_markdown.get(..overlap)
				&& self.source.is_char_boundary(offset)
				&& section.raw_markdown.is_char_boundary(overlap)
		});
		if self.sections.is_empty() || !contiguous {
			self.finish(name, check)?;
			self.start = section.byte_start;
		}
		let offset = (section.byte_start - self.start) as usize;
		let overlap = (self.source.len() - offset).min(section.raw_markdown.len());
		self.source.push_str(&section.raw_markdown[overlap..]);
		self
			.sections
			.push((section.section_id, offset..offset + section.raw_markdown.len()));
		Ok(())
	}
}

fn load_contexts(
	connection: &Connection,
	document_id: i64,
	name: Option<&LiteralMatcher>,
	check: Check<'_>,
) -> CoreResult<DocumentContexts> {
	let payload: Option<Vec<u8>> = connection
		.query_row(
			"SELECT payload FROM wiki_document_projections WHERE document_id=?",
			[document_id],
			|row| row.get(0),
		)
		.optional()?;
	if let Some(payload) = payload {
		check()?;
		let projection: DocumentProjection = serde_json::from_slice(&payload).map_err(|error| {
			WikiError::message(format!("Invalid documentation query projection: {error}"))
		})?;
		projection.validate()?;
		let exact_names = match name {
			Some(name) => projection.exact_names(name, check)?,
			None => HashMap::new(),
		};
		let mut sections = HashMap::new();
		let mut projections = HashMap::with_capacity(projection.sections.len());
		for section in projection.sections {
			check()?;
			if let Some(context) = section.legacy_context.as_ref() {
				sections.insert(section.section_id, context.context());
			}
			projections.insert(section.section_id, section);
		}
		return Ok(DocumentContexts { sections, exact_names, projections });
	}
	let mut statement = connection.prepare_cached(
		"SELECT id,document_id,byte_start,byte_end,raw_markdown FROM sections WHERE document_id=? \
		 ORDER BY ordinal",
	)?;
	let mut rows = statement.query([document_id])?;
	let mut error = None;
	let mut source = NameSource::default();
	let sections = std::iter::from_fn(|| {
		let next = (|| -> CoreResult<Option<markdown::ContextSection>> {
			check()?;
			let Some(row) = rows.next()? else {
				return Ok(None);
			};
			let section = markdown::ContextSection {
				section_id:   row.get(0)?,
				document_id:  row.get(1)?,
				byte_start:   row.get(2)?,
				byte_end:     row.get(3)?,
				raw_markdown: row.get(4)?,
			};
			if let Some(name) = name {
				source.push(&section, name, check)?;
			}
			Ok(Some(section))
		})();
		match next {
			Ok(row) => row,
			Err(failure) => {
				error = Some(failure);
				None
			},
		}
	});
	let result = markdown::contexts(sections).into_iter().collect();
	if let Some(error) = error {
		return Err(error);
	}
	if let Some(name) = name {
		source.finish(name, check)?;
	}
	Ok(DocumentContexts {
		sections:    result,
		exact_names: source.exact_names,
		projections: HashMap::new(),
	})
}

fn push_number(output: &mut String, number: f64) {
	if !number.is_finite() {
		output.push_str("null");
	} else if number == 0.0 {
		output.push('0');
	} else {
		output.push_str(ryu_js::Buffer::new().format(number));
	}
}
fn push_string(output: &mut String, text: &str) {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	output.push('"');
	let mut start = 0;
	for (position, byte) in text.bytes().enumerate() {
		if byte >= 0x20 && byte != b'"' && byte != b'\\' {
			continue;
		}
		output.push_str(&text[start..position]);
		match byte {
			b'"' => output.push_str("\\\""),
			b'\\' => output.push_str("\\\\"),
			8 => output.push_str("\\b"),
			9 => output.push_str("\\t"),
			10 => output.push_str("\\n"),
			12 => output.push_str("\\f"),
			13 => output.push_str("\\r"),
			control => {
				output.push_str("\\u00");
				output.push(HEX[(control >> 4) as usize] as char);
				output.push(HEX[(control & 15) as usize] as char);
			},
		}
		start = position + 1;
	}
	output.push_str(&text[start..]);
	output.push('"');
}
fn hash_row(snapshot: &mut Sha256, row: &Row<'_>, output: &mut String) -> CoreResult<()> {
	output.clear();
	output.push('{');
	for position in 0..row.as_ref().column_count() {
		if position != 0 {
			output.push(',');
		}
		push_string(output, row.as_ref().column_name(position)?);
		output.push(':');
		match row.get_ref(position)? {
			ValueRef::Null => output.push_str("null"),
			ValueRef::Integer(value) => push_number(output, value as f64),
			ValueRef::Real(value) => push_number(output, value),
			ValueRef::Text(value) => push_string(output, &String::from_utf8_lossy(value)),
			ValueRef::Blob(value) => {
				output.push('{');
				for (position, byte) in value.iter().enumerate() {
					if position != 0 {
						output.push(',');
					}
					push_string(output, &position.to_string());
					output.push(':');
					output.push_str(&byte.to_string());
				}
				output.push('}');
			},
		}
	}
	output.push('}');
	snapshot.update(output.as_bytes());
	Ok(())
}
fn digest(bytes: &[u8]) -> String {
	format!("{:x}", Sha256::digest(bytes))
}
/// Never label a connection with an identity observed only after opening it.
/// A replacement racing the open fails this operation and drops its connection.
pub(super) fn open_identified_connection(
	path: &Path,
	open: impl FnOnce() -> CoreResult<Connection>,
) -> CoreResult<(Connection, String)> {
	let identity = file_identity(path)?;
	let connection = open()?;
	check_file_identity(path, &identity)?;
	Ok((connection, identity))
}

pub(super) fn check_file_identity(path: &Path, expected: &str) -> CoreResult<()> {
	if file_identity(path)? != expected {
		return Err(WikiError::message("Documentation database was replaced during the operation"));
	}
	Ok(())
}

pub(super) fn file_identity(path: &Path) -> CoreResult<String> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		let metadata = fs::metadata(path)?;
		let birth = metadata
			.created()
			.ok()
			.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
			.map_or(0, |duration| duration.as_nanos());
		Ok(format!("{}:{}:{birth}", metadata.dev(), metadata.ino()))
	}
	#[cfg(windows)]
	{
		use std::os::windows::io::AsRawHandle;

		use windows_sys::Win32::Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
		};
		let file = fs::File::open(path)?;
		let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
		// SAFETY: the live file handle and writable information struct satisfy
		// Win32's contract.
		if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
			return Err(std::io::Error::last_os_error().into());
		}
		// SAFETY: GetFileInformationByHandle succeeded and initialized the entire
		// struct.
		let info = unsafe { info.assume_init() };
		Ok(format!(
			"{}:{}:{}",
			info.dwVolumeSerialNumber,
			(u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
			(u64::from(info.ftCreationTime.dwHighDateTime) << 32)
				| u64::from(info.ftCreationTime.dwLowDateTime)
		))
	}
	#[cfg(not(any(unix, windows)))]
	{
		Ok(format!("{:?}", fs::metadata(path)?.created()?))
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashSet,
		path::PathBuf,
		sync::{
			atomic::{AtomicBool, AtomicU64, Ordering},
			mpsc,
		},
		thread,
	};

	use super::*;

	#[test]
	fn unsupported_projection_is_rejected_for_name_and_topic_queries() {
		let fixture = Fixture::new();
		let connection = Connection::open(&fixture.path).unwrap();
		let payload = serde_json::to_vec(&serde_json::json!({
			"version": 2,
			"sections": [],
			"groups": []
		}))
		.unwrap();
		connection
			.execute("INSERT INTO wiki_document_projections(document_id,payload) VALUES(1,?)", [
				payload,
			])
			.unwrap();
		for query in ["needle", "needle evidence"] {
			let error = fixture
				.engine()
				.search(query, &WikiSearchOptions::default(), &|| Ok(()))
				.unwrap_err();
			assert!(error.error_message().contains("projection"));
			assert!(error.error_message().contains("version"));
		}
	}

	#[test]
	fn reconstructed_names_require_contiguous_consistent_source_ranges() {
		let name = LiteralMatcher::new("foobar", true);
		for (second_start, second_body, expected) in
			[(3, "bar", true), (4, "bar", false), (2, "obar", true), (2, "xbar", false)]
		{
			let mut source = NameSource::default();
			for (id, start, body) in [(1, 0, "foo"), (2, second_start, second_body)] {
				source
					.push(
						&markdown::ContextSection {
							section_id:   id,
							document_id:  1,
							byte_start:   start,
							byte_end:     start + body.len() as i64,
							raw_markdown: body.into(),
						},
						&name,
						&|| Ok(()),
					)
					.unwrap();
			}
			source.finish(&name, &|| Ok(())).unwrap();
			assert_eq!(source.exact_names.get(&1).copied(), Some(expected));
			assert_eq!(source.exact_names.get(&2).copied(), Some(expected));
		}
	}

	#[test]
	fn repeated_source_names_cover_only_intersecting_sections() {
		let name = LiteralMatcher::new("x", true);
		let mut text = "x ".repeat(8192);
		let repeated_end = text.len();
		text.push_str("éx xé ");
		let blocked_end = text.len();
		text.push_str("中x x中 x\u{0301} ");
		let matched_end = text.len();
		text.push_str("éx xé");
		let mut source = NameSource::default();
		for (id, range) in [
			(1, 0..repeated_end / 2),
			(2, repeated_end / 2..repeated_end),
			(3, repeated_end..blocked_end),
			(4, blocked_end..matched_end),
			(5, matched_end..text.len()),
			// A later overlapping row must not assume monotonic section ends.
			(6, repeated_end / 2..matched_end),
		] {
			source
				.push(
					&markdown::ContextSection {
						section_id:   id,
						document_id:  1,
						byte_start:   range.start as i64,
						byte_end:     range.end as i64,
						raw_markdown: text[range].to_owned(),
					},
					&name,
					&|| Ok(()),
				)
				.unwrap();
		}
		source.finish(&name, &|| Ok(())).unwrap();
		assert_eq!(
			source
				.exact_names
				.into_iter()
				.filter_map(|(id, exact)| exact.then_some(id))
				.collect::<HashSet<_>>(),
			HashSet::from([1, 2, 4, 6]),
		);
	}

	#[test]
	fn reconstructed_names_keep_lexical_boundaries_across_chunks_and_overlap() {
		for (body, name, expected) in [
			("**scan**ner", "scan", false),
			("**mbist_check.rpt**.bak", "mbist_check.rpt", false),
			("**scan**ner", "scanner", true),
			("**mbist_check.rpt**.bak", "mbist_check.rpt.bak", true),
			("`scan`ner", "scan", true),
			("`counter_value*factor*next`", "counter_value*factor*next", true),
		] {
			let text = format!("{}{body}", "x ".repeat(8997));
			for overlap in [0, 500] {
				let matcher = LiteralMatcher::new(name, true);
				let mut source = NameSource::default();
				for (id, range) in [(1, 0..18_000), (2, 18_000 - overlap..text.len())] {
					source
						.push(
							&markdown::ContextSection {
								section_id:   id,
								document_id:  1,
								byte_start:   range.start as i64,
								byte_end:     range.end as i64,
								raw_markdown: text[range].to_owned(),
							},
							&matcher,
							&|| Ok(()),
						)
						.unwrap();
				}
				source.finish(&matcher, &|| Ok(())).unwrap();
				assert_eq!(source.exact_names.get(&1), Some(&expected), "{body} {overlap}");
				let second = expected && (overlap != 0 || body != "`scan`ner");
				assert_eq!(source.exact_names.get(&2), Some(&second), "{body} {overlap}");
			}
		}
	}

	static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
	struct Fixture {
		directory: PathBuf,
		path:      String,
	}
	impl Fixture {
		fn new() -> Self {
			let directory = std::env::temp_dir().join(format!(
				"omp-wiki-native-{}-{}-{}",
				std::process::id(),
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap()
					.as_nanos(),
				NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir_all(&directory).unwrap();
			let path = directory.join("docs.db").to_string_lossy().into_owned();
			let connection = Connection::open(&path).unwrap();
			connection
				.execute_batch(
					"
				PRAGMA journal_mode=WAL;
				CREATE TABLE doc_indexes(id INTEGER PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL);
				CREATE TABLE documents(id INTEGER PRIMARY KEY,index_id INTEGER NOT NULL,relative_path TEXT NOT \
					 NULL,title TEXT NOT NULL,source_kind TEXT NOT NULL,sha256 TEXT NOT \
					 NULL,size_bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL);
				CREATE TABLE sections(id INTEGER PRIMARY KEY,index_id INTEGER NOT NULL,document_id INTEGER NOT \
					 NULL,ordinal INTEGER NOT NULL,heading_path TEXT NOT NULL,heading_level INTEGER \
					 NOT NULL,line_start INTEGER NOT NULL,line_end INTEGER NOT NULL,byte_start INTEGER \
					 NOT NULL,byte_end INTEGER NOT NULL,raw_markdown TEXT NOT NULL);
				CREATE TABLE wiki_document_projections(document_id INTEGER PRIMARY KEY,payload BLOB NOT NULL);
				CREATE VIRTUAL TABLE sections_fts USING fts5(section_id UNINDEXED,index_id \
					 UNINDEXED,relative_path,heading_path,body,content='',contentless_delete=1);
			",
				)
				.unwrap();
			seed(&connection, "old", "old.md", "old-hash", "needle evidence old").unwrap();
			Self { directory, path }
		}

		fn engine(&self) -> DatabaseEngine {
			DatabaseEngine::new(self.path.clone(), self.path.clone())
		}
	}
	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.directory);
		}
	}
	fn seed(
		connection: &Connection,
		index: &str,
		path: &str,
		hash: &str,
		body: &str,
	) -> rusqlite::Result<()> {
		connection.execute("INSERT INTO doc_indexes VALUES(1,?,'/never-read')", [index])?;
		connection.execute(
			"INSERT INTO documents VALUES(1,1,?,'Title','markdown',?,100,1.0)",
			rusqlite::params![path, hash],
		)?;
		for id in 1..=3 {
			let body = format!("# Evidence {id}\n\n{body} {id}\n");
			connection.execute(
				"INSERT INTO sections VALUES(?,1,1,?,'Evidence',1,?,?,0,100,?)",
				rusqlite::params![id, id - 1, id * 10, id * 10 + 2, body],
			)?;
			connection.execute(
				"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) \
				 VALUES(?,?,1,?,'Evidence',?)",
				rusqlite::params![id, id, path, body],
			)?;
		}
		Ok(())
	}
	fn search(
		engine: &mut DatabaseEngine,
		query: &str,
		options: WikiSearchOptions,
	) -> serde_json::Value {
		serde_json::to_value(engine.search(query, &options, &|| Ok(())).unwrap()).unwrap()
	}
	fn cursor(window: &serde_json::Value, position: usize) -> String {
		let mut cursor = window["result"]["cursorBase"].clone();
		cursor["p"] = serde_json::json!(position);
		URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap())
	}
	fn install_swap(engine: &mut DatabaseEngine, path: String) -> thread::JoinHandle<()> {
		let (start_tx, start_rx) = mpsc::channel();
		let (done_tx, done_rx) = mpsc::channel();
		let writer = thread::spawn(move || {
			start_rx.recv().unwrap();
			let connection = Connection::open(path).unwrap();
			connection
				.execute_batch(
					"BEGIN IMMEDIATE; DELETE FROM sections_fts; DELETE FROM sections; DELETE FROM \
					 documents; DELETE FROM doc_indexes;",
				)
				.unwrap();
			seed(&connection, "new", "new.md", "new-hash", "needle evidence new").unwrap();
			connection.execute_batch("COMMIT").unwrap();
			done_tx.send(()).unwrap();
		});
		let mut fired = false;
		engine.after_snapshot = Some(Box::new(move || {
			if !fired {
				fired = true;
				start_tx.send(()).unwrap();
				done_rx.recv().unwrap();
			}
			Ok(())
		}));
		writer
	}

	#[test]
	fn snapshots_clear_progress_callback_on_success_cancellation_and_sql_error() {
		for mode in ["success", "cancel", "sql", "cancel-and-sql"] {
			let fixture = Fixture::new();
			let mut engine = fixture.engine();
			engine.ensure_database().unwrap();
			if mode.contains("sql") {
				engine
					.connection
					.as_ref()
					.unwrap()
					.execute_batch("DROP TABLE sections_fts")
					.unwrap();
			}
			let cancelled = Arc::new(AtomicBool::new(false));
			let calls = Arc::new(AtomicU64::new(0));
			if mode.contains("cancel") {
				let cancelled = Arc::clone(&cancelled);
				engine.after_snapshot = Some(Box::new(move || {
					cancelled.store(true, Ordering::Relaxed);
					Ok(())
				}));
			}
			let check_calls = Arc::clone(&calls);
			let result = engine.search("needle evidence", &WikiSearchOptions::default(), move || {
				check_calls.fetch_add(1, Ordering::Relaxed);
				if cancelled.load(Ordering::Relaxed) {
					Err(WikiError::message("cancelled snapshot"))
				} else {
					Ok(())
				}
			});
			match mode {
				"success" => {
					assert!(result.is_ok());
				},
				"sql" => {
					let error = result.unwrap_err();
					assert!(error.message.contains("no such table: sections_fts"));
					assert!(error.sqlite.is_some());
				},
				_ => {
					assert_eq!(result.unwrap_err().message, "cancelled snapshot");
				},
			}
			let connection = engine.connection.as_ref().unwrap();
			assert!(connection.is_autocommit(), "{mode} left a read transaction open");
			let before = calls.load(Ordering::Relaxed);
			let count: i64 = connection
				.query_row(
					"WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE \
					 n<10000) SELECT count(*) FROM numbers",
					[],
					|row| row.get(0),
				)
				.unwrap();
			assert_eq!(count, 10000);
			assert_eq!(calls.load(Ordering::Relaxed), before, "{mode} left a callback installed");
		}
	}

	#[test]
	fn acquired_snapshot_keeps_reused_rowid_provenance_and_does_not_publish_under_new_guard() {
		let fixture = Fixture::new();
		let mut engine = fixture.engine();
		let writer = install_swap(&mut engine, fixture.path.clone());
		let old = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			..Default::default()
		});
		writer.join().unwrap();
		assert_eq!(old["cacheHit"], false);
		assert_eq!(old["result"]["total"], 3);
		for hit in old["result"]["sections"].as_array().unwrap() {
			assert_eq!(hit["index"], "old");
			assert_eq!(hit["path"], "old.md");
			assert_eq!(hit["documentHash"], "old-hash");
			assert!(hit["text"].as_str().unwrap().contains("evidence old"));
			let id = hit["sectionId"].as_i64().unwrap();
			assert_eq!(hit["lineStart"], id * 10);
			assert_eq!(hit["lineEnd"], id * 10 + 2);
		}
		assert!(
			engine.cache.is_empty(),
			"old read snapshot must not be cached under the writer's new guard"
		);
		let new = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			..Default::default()
		});
		assert_eq!(new["cacheHit"], false);
		assert_eq!(engine.rank_builds, 2);
		assert_ne!(old["result"]["cursorBase"]["s"], new["result"]["cursorBase"]["s"]);
		for hit in new["result"]["sections"].as_array().unwrap() {
			assert_eq!(hit["index"], "new");
			assert_eq!(hit["path"], "new.md");
			assert_eq!(hit["documentHash"], "new-hash");
			assert!(hit["text"].as_str().unwrap().contains("evidence new"));
		}
		let stale = engine
			.search(
				"needle evidence",
				&WikiSearchOptions { cursor: Some(cursor(&old, 1)), ..Default::default() },
				&|| Ok(()),
			)
			.unwrap_err();
		assert_eq!(stale.message, "Stale documentation search cursor: indexed snapshot has changed");
	}

	#[test]
	fn cache_hit_crossing_external_commit_retries_without_mixed_page() {
		let fixture = Fixture::new();
		let mut engine = fixture.engine();
		search(&mut engine, "needle evidence", WikiSearchOptions::default());
		let writer = install_swap(&mut engine, fixture.path.clone());
		let new = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			..Default::default()
		});
		writer.join().unwrap();
		assert_eq!(new["cacheHit"], false);
		assert_eq!(engine.rank_builds, 2);
		for hit in new["result"]["sections"].as_array().unwrap() {
			assert_eq!(hit["documentHash"], "new-hash");
			assert!(hit["text"].as_str().unwrap().contains("evidence new"));
		}
	}

	#[test]
	fn owning_connection_body_and_contentless_fts_changes_invalidate_full_ranking() {
		for fts_only in [false, true] {
			let fixture = Fixture::new();
			let mut engine = fixture.engine();
			let first = search(&mut engine, "needle evidence", WikiSearchOptions {
				limit: Some(1.0),
				..Default::default()
			});
			assert_eq!(
				search(&mut engine, "needle evidence", WikiSearchOptions {
					limit: Some(1.0),
					..Default::default()
				})["cacheHit"],
				true
			);
			let connection = engine.connection.as_ref().unwrap();
			if fts_only {
				connection
					.execute("DELETE FROM sections_fts WHERE rowid=1", [])
					.unwrap();
			} else {
				connection
					.execute("UPDATE sections SET raw_markdown='needle evidence changed' WHERE id=1", [])
					.unwrap();
			}
			let changed = search(&mut engine, "needle evidence", WikiSearchOptions {
				limit: Some(500.0),
				..Default::default()
			});
			assert_eq!(changed["cacheHit"], false);
			assert_eq!(engine.rank_builds, 2);
			assert_ne!(first["result"]["cursorBase"]["s"], changed["result"]["cursorBase"]["s"]);
			assert_eq!(changed["result"]["total"], if fts_only { 2 } else { 3 });
			if !fts_only {
				assert!(
					changed["result"]["sections"]
						.as_array()
						.unwrap()
						.iter()
						.any(|hit| hit["text"] == "needle evidence changed")
				);
			}
			let stale = engine
				.search(
					"needle evidence",
					&WikiSearchOptions { cursor: Some(cursor(&first, 1)), ..Default::default() },
					&|| Ok(()),
				)
				.unwrap_err();
			assert_eq!(
				stale.message,
				"Stale documentation search cursor: indexed snapshot has changed"
			);
		}
	}

	#[test]
	fn one_full_rank_across_complete_window_continuation_and_budget_then_eviction_and_reopen() {
		let fixture = Fixture::new();
		let mut engine = fixture.engine();
		let complete = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			..Default::default()
		});
		let first = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(1.0),
			..Default::default()
		});
		let continuation = cursor(&first, 1);
		let rest = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			cursor: Some(continuation),
			..Default::default()
		});
		assert_eq!(first["cacheHit"], true);
		assert_eq!(rest["cacheHit"], true);
		assert_eq!(first["result"]["sections"][0], complete["result"]["sections"][0]);
		assert_eq!(
			rest["result"]["sections"].as_array().unwrap(),
			&complete["result"]["sections"].as_array().unwrap()[1..]
		);
		// The adapter's budget only selects a prefix of a native window and uses
		// its cursorBase.
		let budget_window = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			..Default::default()
		});
		let budget_prefix = &budget_window["result"]["sections"].as_array().unwrap()[..1];
		assert_eq!(budget_prefix, &complete["result"]["sections"].as_array().unwrap()[..1]);
		assert_eq!(engine.rank_builds, 1);
		for number in 0..8 {
			search(&mut engine, &format!("evidence topic{number}"), WikiSearchOptions::default());
		}
		assert_eq!(engine.cache.len(), 8);
		let after_eviction = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			cursor: Some(cursor(&first, 1)),
			..Default::default()
		});
		assert_eq!(after_eviction["cacheHit"], false);
		assert_eq!(after_eviction["result"], rest["result"]);
		assert_eq!(engine.rank_builds, 10);
		engine.close();
		let reopened = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			cursor: Some(cursor(&first, 1)),
			..Default::default()
		});
		assert_eq!(reopened["cacheHit"], false);
		assert_eq!(reopened["result"], rest["result"]);
		assert_eq!(engine.rank_builds, 11);
	}

	#[test]
	fn lru_and_metadata_target_evict_whole_queries_but_keep_oversized_newest() {
		let mut engine = DatabaseEngine::new(String::new(), String::new());
		let ranking = |count: usize| {
			Arc::new(Ranking {
				ranked:             (0..count)
					.map(|id| RankedSection {
						section_id: id as i64,
						shape:      query::Shape::Content,
						match_kind: MatchKind::Related,
						rank:       0.0,
					})
					.collect(),
				version:            "version".to_owned(),
				exact_name_matches: 0,
			})
		};
		engine.publish("old".to_owned(), ranking(1), "guard".to_owned());
		engine.publish("oversized".to_owned(), ranking(1_000_001), "guard".to_owned());
		assert_eq!(engine.cache.len(), 1);
		assert_eq!(engine.cached_sections, 1_000_001);
		assert_eq!(engine.cache[0].0, "oversized");
		engine.publish("new".to_owned(), ranking(1), "guard".to_owned());
		assert_eq!(engine.cache.len(), 1);
		assert_eq!(engine.cache[0].0, "new");
	}

	#[test]
	fn canonical_cursor_validation_accepts_legacy_numeric_forms_and_rejects_invalid_tokens() {
		let hash = "a".repeat(64);
		let valid = format!("{{\"v\":1.0,\"q\":\"{hash}\",\"s\":\"{hash}\",\"p\":1e0}}");
		assert_eq!(decode_cursor(&URL_SAFE_NO_PAD.encode(valid)).unwrap().p, 1);
		for invalid in [
			serde_json::json!({"v":1,"q":hash,"s":hash,"p":0}),
			serde_json::json!({"v":1,"q":hash,"s":hash,"p":1,"extra":1}),
			serde_json::json!({"v":1,"q":hash,"s":hash,"p":9007199254740992u64}),
			serde_json::json!({"v":2,"q":hash,"s":hash,"p":1}),
		] {
			assert_eq!(
				decode_cursor(&URL_SAFE_NO_PAD.encode(invalid.to_string()))
					.unwrap_err()
					.message,
				INVALID_CURSOR
			);
		}
		assert_eq!(decode_cursor("abc=").unwrap_err().message, INVALID_CURSOR);
		assert_eq!(decode_cursor("a").unwrap_err().message, INVALID_CURSOR);
	}

	#[test]
	fn snapshot_json_preserves_sql_column_order_js_numbers_and_control_escaping() {
		let connection = Connection::open_in_memory().unwrap();
		connection
			.query_row(
				"SELECT 1.0 first,1e-7 second,100000000000000000000.0 third,char(8,9,10,11,12,13,0) \
				 fourth,NULL fifth",
				[],
				|row| {
					let mut hash = Sha256::new();
					let mut text = String::new();
					hash_row(&mut hash, row, &mut text).unwrap();
					assert_eq!(
						text,
						"{\"first\":1,\"second\":1e-7,\"third\":100000000000000000000,\"fourth\":\"\\b\\\
						 t\\n\\u000b\\f\\r\\u0000\",\"fifth\":null}"
					);
					Ok(())
				},
			)
			.unwrap();
	}

	#[test]
	fn empty_index_keeps_truthy_fts_filter_difference_and_version_hashes_entire_corpus() {
		let fixture = Fixture::new();
		let mut engine = fixture.engine();
		let none = search(&mut engine, "needle evidence", WikiSearchOptions::default());
		let empty = search(&mut engine, "needle evidence", WikiSearchOptions {
			index: Some(String::new()),
			..Default::default()
		});
		assert_eq!(empty["result"]["total"], 0);
		assert_eq!(none["result"]["cursorBase"]["s"], empty["result"]["cursorBase"]["s"]);
		assert_ne!(none["result"]["cursorBase"]["q"], empty["result"]["cursorBase"]["q"]);
		let missing = search(&mut engine, "needle evidence", WikiSearchOptions {
			index: Some("missing".into()),
			..Default::default()
		});
		engine
			.connection
			.as_ref()
			.unwrap()
			.execute("INSERT INTO doc_indexes VALUES(2,'unrelated','/unread')", [])
			.unwrap();
		let changed = search(&mut engine, "needle evidence", WikiSearchOptions {
			index: Some("missing".into()),
			..Default::default()
		});
		assert_ne!(missing["result"]["cursorBase"]["s"], changed["result"]["cursorBase"]["s"]);
	}
	#[test]
	fn replacing_database_file_reopens_owner_and_discards_whole_rank_cache() {
		let old = Fixture::new();
		let replacement = Fixture::new();
		let mut engine = old.engine();
		let first = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(1.0),
			..Default::default()
		});
		{
			let connection = Connection::open(&replacement.path).unwrap();
			connection
				.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
				.unwrap();
			connection
				.execute(
					"UPDATE documents SET relative_path='replacement.md',sha256='replacement-hash'",
					[],
				)
				.unwrap();
			connection
				.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
				.unwrap();
		}
		// Windows SQLite's VFS does not allow renaming an open database file.
		// Preserve the cache but release that handle before exercising identity
		// replacement.
		#[cfg(windows)]
		{
			engine.connection = None;
		}
		let backup = old.directory.join("old.db");
		fs::rename(&old.path, &backup).unwrap();
		// A replacement SQLite main file must not inherit the predecessor's
		// sidecars.
		for suffix in ["-wal", "-shm"] {
			let path = format!("{}{suffix}", old.path);
			if Path::new(&path).exists() {
				fs::rename(path, old.directory.join(format!("old.db{suffix}"))).unwrap();
			}
		}
		fs::rename(&replacement.path, &old.path).unwrap();
		let changed = search(&mut engine, "needle evidence", WikiSearchOptions {
			limit: Some(500.0),
			..Default::default()
		});
		assert_eq!(changed["cacheHit"], false);
		assert_eq!(engine.generation, 2);
		assert_eq!(engine.rank_builds, 2);
		for hit in changed["result"]["sections"].as_array().unwrap() {
			assert_eq!(hit["path"], "replacement.md");
			assert_eq!(hit["documentHash"], "replacement-hash");
		}
		let stale = engine
			.search(
				"needle evidence",
				&WikiSearchOptions { cursor: Some(cursor(&first, 1)), ..Default::default() },
				&|| Ok(()),
			)
			.unwrap_err();
		assert_eq!(stale.message, "Stale documentation search cursor: indexed snapshot has changed");
	}

	fn grep_options() -> WikiSearchOptions {
		WikiSearchOptions { mode: Some("grep".into()), limit: Some(500.0), ..Default::default() }
	}

	fn last_published_index_disappears_before_query_snapshot(
		options: WikiSearchOptions,
		hidden_build: bool,
	) {
		let fixture = grep_fixture(&["# Evidence\nneedle evidence\n"]);
		let mut engine = fixture.engine();
		// A real published index makes zero matches a successful query, and
		// primes the empty ranking cache before another connection removes it.
		let empty = engine
			.search("absent_evidence", &options, &|| Ok(()))
			.unwrap();
		assert_eq!(empty.result.total, 0);
		let writer = Connection::open(&fixture.path).unwrap();
		let visible: i64 = writer
			.query_row(
				"SELECT count(*) FROM doc_indexes WHERE name NOT GLOB '__building__*'",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(visible, 1);
		// This is the tool's list/search race: after the successful preflight,
		// an external writer removes the last published corpus. A hidden build
		// must not turn the now-unqueryable snapshot into successful 0 matches.
		writer
			.execute_batch(
				"BEGIN IMMEDIATE; DELETE FROM sections_fts; DELETE FROM sections; DELETE FROM \
				 documents; DELETE FROM doc_indexes; COMMIT;",
			)
			.unwrap();
		if hidden_build {
			writer
				.execute("INSERT INTO doc_indexes VALUES(2,'__building__unfinished','/unread')", [])
				.unwrap();
		}
		let result = engine.search("absent_evidence", &options, &|| Ok(()));
		assert!(
			result.is_err(),
			"a snapshot with no published index must fail, not return {result:?}"
		);
		assert!(engine.connection.as_ref().unwrap().is_autocommit());
		assert!(engine.cache.is_empty());
		// Re-publication proves that rejecting this snapshot does not poison
		// the connection or convert later legitimate zero matches into errors.
		writer
			.execute_batch(
				"DELETE FROM doc_indexes; INSERT INTO doc_indexes VALUES(2,'published','/unread')",
			)
			.unwrap();
		assert_eq!(
			engine
				.search("absent_evidence", &options, &|| Ok(()))
				.unwrap()
				.result
				.total,
			0
		);
	}

	#[test]
	fn search_rejects_snapshot_after_last_published_index_is_removed() {
		for hidden_build in [false, true] {
			last_published_index_disappears_before_query_snapshot(
				WikiSearchOptions::default(),
				hidden_build,
			);
		}
	}

	#[test]
	fn grep_rejects_snapshot_after_last_published_index_is_removed() {
		for hidden_build in [false, true] {
			last_published_index_disappears_before_query_snapshot(grep_options(), hidden_build);
		}
	}

	fn grep_fixture(documents: &[&str]) -> Fixture {
		let fixture = Fixture::new();
		let connection = Connection::open(&fixture.path).unwrap();
		connection
			.execute_batch(
				"DELETE FROM sections_fts; DELETE FROM sections; DELETE FROM documents; DELETE FROM \
				 doc_indexes; INSERT INTO doc_indexes VALUES(1,'raw','/missing-source');",
			)
			.unwrap();
		for (position, body) in documents.iter().enumerate() {
			let document_id = position as i64 + 1;
			connection
				.execute(
					"INSERT INTO documents VALUES(?,1,?,'Title','markdown','hash',?,1.0)",
					rusqlite::params![document_id, format!("{position}.md"), body.len() as i64],
				)
				.unwrap();
			let parsed = super::super::import::parse_markdown(body.as_bytes()).unwrap();
			let count = parsed.sections.len() as i64;
			for section in parsed.sections {
				// IDs deliberately disagree with source order.
				let id = document_id * 1_000_000 + count - section.ordinal;
				connection
					.execute("INSERT INTO sections VALUES(?,1,?,?,?,1,?,?,?,?,?)", rusqlite::params![
						id,
						document_id,
						section.ordinal,
						"Heading",
						section.line_start,
						section.line_end,
						section.byte_start,
						section.byte_end,
						section.raw_markdown,
					])
					.unwrap();
				connection
					.execute(
						"INSERT INTO \
						 sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) \
						 VALUES(?,?,1,'raw.md','Heading','unrelated FTS words')",
						rusqlite::params![id, id],
					)
					.unwrap();
			}
		}
		fixture
	}

	fn grep_slice_fixture(source: &str, slices: &[(usize, usize)]) -> Fixture {
		let fixture = grep_fixture(&[source]);
		let connection = Connection::open(&fixture.path).unwrap();
		connection.execute("DELETE FROM sections", []).unwrap();
		for (ordinal, &(start, end)) in slices.iter().enumerate() {
			let raw = &source[start..end];
			let line_start = source[..start]
				.bytes()
				.filter(|byte| *byte == b'\n')
				.count() as i64
				+ 1;
			let line_end = line_start + raw.bytes().filter(|byte| *byte == b'\n').count() as i64
				- i64::from(raw.ends_with('\n'));
			connection
				.execute("INSERT INTO sections VALUES(?,1,1,?,'Raw',0,?,?,?,?,?)", rusqlite::params![
					(slices.len() - ordinal) as i64,
					ordinal as i64,
					line_start,
					line_end,
					start as i64,
					end as i64,
					raw
				])
				.unwrap();
		}
		fixture
	}

	#[test]
	fn grep_existing_converter_gaps_preserve_original_lines_and_stored_evidence() {
		let source = "# Title\n\nbody\n\n#### Cell\n\n# Next\n\nbody2\n";
		// Persist the old layout directly; the omitted heading is not available
		// to search and must not be reconstructed or require a reimport.
		let fixture = grep_slice_fixture(source, &[
			(0, source.find("#### Cell").unwrap()),
			(source.find("# Next").unwrap(), source.len()),
		]);
		let mut engine = fixture.engine();
		let first = search(&mut engine, "^body$", grep_options());
		let next = search(&mut engine, "^body2$", grep_options());
		assert_eq!(first["result"]["total"], 1);
		assert_eq!(next["result"]["total"], 1);
		assert_eq!(first["result"]["sections"][0]["text"], "# Title\n\nbody\n\n");
		assert_eq!(first["result"]["sections"][0]["lineStart"], 1);
		assert_eq!(first["result"]["sections"][0]["lineEnd"], 4);
		assert_eq!(next["result"]["sections"][0]["text"], "# Next\n\nbody2\n");
		assert_eq!(next["result"]["sections"][0]["lineStart"], 7);
		assert_eq!(next["result"]["sections"][0]["lineEnd"], 9);
		assert_eq!(
			search(&mut engine, "^# Next$", grep_options())["result"]["sections"],
			next["result"]["sections"]
		);
		for expression in ["Cell", "^bodybody2$", "body\\nbody2"] {
			assert_eq!(search(&mut engine, expression, grep_options())["result"]["total"], 0);
		}
		engine.close();
		assert_eq!(
			search(&mut engine, "^body2$", grep_options())["result"]["sections"],
			next["result"]["sections"]
		);
	}

	#[test]
	fn grep_adjacent_and_overlapping_slices_preserve_crlf_blank_and_utf8_positions() {
		let source = "αLONG\r\n\nlast";
		let fixture = grep_slice_fixture(source, &[(0, 3), (3, 7), (6, source.len())]);
		let mut engine = fixture.engine();
		assert_eq!(search(&mut engine, "^αLONG\\r$", grep_options())["result"]["total"], 3);
		assert_eq!(search(&mut engine, "^αLONG$", grep_options())["result"]["total"], 0);
		assert_eq!(search(&mut engine, "^$", grep_options())["result"]["total"], 1);
		assert_eq!(search(&mut engine, "(?<=α)LONG", grep_options())["result"]["total"], 2);
		assert_eq!(search(&mut engine, "last$", grep_options())["result"]["total"], 1);
		assert_eq!(search(&mut engine, "(?s)LONG.*last", grep_options())["result"]["total"], 0);
	}

	#[test]
	fn grep_dense_and_distant_matches_preserve_overlapping_slice_results() {
		let source = format!("α{}{}{}ω", "a".repeat(128), "gap".repeat(16), "z".repeat(128));
		let slices =
			[(0, 40), (30, 90), (80, 140), (130, 165), (155, 195), (185, 250), (240, source.len())];
		let fixture = grep_slice_fixture(&source, &slices);
		let mut engine = fixture.engine();
		let dense = search(&mut engine, ".", grep_options());
		let sections = dense["result"]["sections"].as_array().unwrap();
		assert_eq!(dense["result"]["total"], slices.len());
		for (ordinal, (hit, &(start, end))) in sections.iter().zip(&slices).enumerate() {
			assert_eq!(hit["sectionId"], (slices.len() - ordinal) as i64);
			assert_eq!(hit["text"], &source[start..end]);
			assert_eq!(hit["lineStart"], 1);
			assert_eq!(hit["lineEnd"], 1);
			assert_eq!(hit["matchKind"], "regex");
		}
		for expression in ["^αa+(?:gap)+z+ω$", "(?=.)"] {
			assert_eq!(
				search(&mut engine, expression, grep_options())["result"]["sections"],
				dense["result"]["sections"],
				"{expression}"
			);
		}
		for (expression, expected) in
			[("^α|ω$", vec![7, 1]), ("(?<=α)a|z(?=ω)", vec![7, 1]), ("^α|gap|ω$", vec![7, 5, 4, 3, 1])]
		{
			let found = search(&mut engine, expression, grep_options());
			let actual: Vec<_> = found["result"]["sections"]
				.as_array()
				.unwrap()
				.iter()
				.map(|hit| hit["sectionId"].as_i64().unwrap())
				.collect();
			assert_eq!(found["result"]["total"], expected.len(), "{expression}");
			assert_eq!(actual, expected, "{expression}");
		}
	}

	#[test]
	fn grep_empty_shared_edges_and_later_lines_preserve_pending_slices() {
		let source = "αab\r\n\nlater TARGET\r\nend";
		let slices = [(0, 2), (2, 4), (4, 6), (6, 10), (9, 16), (15, 22), (21, source.len())];
		let anchors = [(1, 1), (1, 1), (1, 1), (2, 3), (3, 3), (3, 4), (4, 4)];
		let fixture = grep_slice_fixture(source, &slices);
		let mut engine = fixture.engine();
		for (expression, expected) in [
			("(?<=α)", vec![7, 6]),
			("(?=a)", vec![7, 6, 4]),
			("^α|(?=b)", vec![7, 6]),
			("b|TARGET|end", vec![6, 3, 2, 1]),
			("^$|TARGET|end", vec![4, 3, 2, 1]),
			("$", vec![5, 4, 2, 1]),
		] {
			let found = search(&mut engine, expression, grep_options());
			let hits = found["result"]["sections"].as_array().unwrap();
			let actual: Vec<_> = hits
				.iter()
				.map(|hit| hit["sectionId"].as_i64().unwrap())
				.collect();
			assert_eq!(found["result"]["total"], expected.len(), "{expression}");
			assert_eq!(actual, expected, "{expression}");
			for hit in hits {
				let ordinal = slices.len() - hit["sectionId"].as_i64().unwrap() as usize;
				let (start, end) = slices[ordinal];
				assert_eq!(hit["text"], &source[start..end], "{expression}");
				assert_eq!(hit["lineStart"], anchors[ordinal].0, "{expression}");
				assert_eq!(hit["lineEnd"], anchors[ordinal].1, "{expression}");
				assert_eq!(hit["matchKind"], "regex", "{expression}");
			}
		}
	}

	#[test]
	fn grep_reconstructs_arbitrarily_long_original_lines_and_overlap_ranges() {
		let line = format!("LEFT{}RIGHT\r\n", "界".repeat(40_000));
		let body = format!("# Raw\r\n{line}# Unrelated\r\nnot a match\r\n");
		let fixture = grep_fixture(&[&body]);
		let mut engine = fixture.engine();
		let full = search(&mut engine, "LEFT界+RIGHT", grep_options());
		let sections = full["result"]["sections"].as_array().unwrap();
		assert!(sections.len() >= 3);
		assert!(
			sections
				.windows(2)
				.all(|pair| pair[0]["sectionId"].as_i64() > pair[1]["sectionId"].as_i64())
		);
		assert!(sections.iter().all(|hit| hit["matchKind"] == "regex"));
		assert_eq!(full["result"]["exactNameMatches"], 0);
		assert!(full["result"]["technicalName"].is_null());
		assert_eq!(
			search(&mut engine, "^LEFT界+RIGHT\\r$", grep_options())["result"]["total"],
			full["result"]["total"]
		);
		for expression in ["^界", "界$", "LEFT界+RIGHT$", "Raw.*LEFT", "RIGHT.*Unrelated"] {
			assert_eq!(
				search(&mut engine, expression, grep_options())["result"]["total"],
				0,
				"{expression}"
			);
		}
		// A later match on the same line must not be hidden by its first match.
		let ends = search(&mut engine, "LEFT|RIGHT", grep_options());
		assert_eq!(ends["result"]["total"], 2);
		let empty = search(&mut engine, "(?=界)", grep_options());
		assert_eq!(empty["result"]["total"], full["result"]["total"]);
	}

	#[test]
	fn grep_full_scan_is_db_only_and_preserves_spaces_case_and_document_isolation() {
		let mut body = String::new();
		for ordinal in 0..1400 {
			body.push_str(&format!("# Section {ordinal}\nunrelated\n"));
		}
		body.push_str("# Last\n  MARK::123  \n");
		let fixture = grep_fixture(&[&body, "start-only", "end-only"]);
		let mut engine = fixture.engine();
		let found = search(&mut engine, "  MARK::\\d+  ", grep_options());
		assert_eq!(found["result"]["total"], 1);
		assert!(
			found["result"]["sections"][0]["text"]
				.as_str()
				.unwrap()
				.contains("MARK::123")
		);
		assert_eq!(search(&mut engine, "MARK(?=::123)", grep_options())["result"]["total"], 1);
		assert_eq!(search(&mut engine, "(?<=MARK::)123", grep_options())["result"]["total"], 1);
		assert_eq!(search(&mut engine, "mark::123", grep_options())["result"]["total"], 0);
		assert_eq!(
			search(&mut engine, "mark::123", WikiSearchOptions {
				r#case: Some(false),
				..grep_options()
			})["result"]["total"],
			1
		);
		assert_eq!(search(&mut engine, "start-onlyend-only", grep_options())["result"]["total"], 0);
		assert_eq!(search(&mut engine, "no such evidence", grep_options())["result"]["total"], 0);
	}

	#[test]
	fn grep_rejects_invalid_blank_and_overlong_expressions_without_literal_fallback() {
		let fixture = grep_fixture(&["# Raw\nliteral (\n"]);
		let mut engine = fixture.engine();
		for expression in ["(", "[", "*", "(?notregex)"] {
			let error = engine
				.search(expression, &grep_options(), &|| Ok(()))
				.unwrap_err();
			assert!(
				error.message.contains("Invalid documentation grep regex"),
				"{expression}: {}",
				error.message
			);
		}
		for expression in ["", " \t\r\n"] {
			assert!(
				engine
					.search(expression, &grep_options(), &|| Ok(()))
					.is_err()
			);
		}
		for expression in ["x".repeat(501), "😀".repeat(251)] {
			assert!(
				engine
					.search(&expression, &grep_options(), &|| Ok(()))
					.unwrap_err()
					.message
					.contains("500 UTF-16")
			);
		}
		assert!(engine.cache.is_empty());
	}

	#[test]
	fn grep_pages_cache_and_reopen_preserve_source_order_and_isolate_cursor_options() {
		let fixture = grep_fixture(&["# One\nALPHA\n# Two\nALPHA\n# Three\nALPHA\n"]);
		let mut engine = fixture.engine();
		let full = search(&mut engine, "ALPHA", grep_options());
		let first =
			search(&mut engine, "ALPHA", WikiSearchOptions { limit: Some(1.0), ..grep_options() });
		assert_eq!(first["cacheHit"], true);
		let continuation = cursor(&first, 1);
		let rest = search(&mut engine, "ALPHA", WikiSearchOptions {
			cursor: Some(continuation.clone()),
			..grep_options()
		});
		assert_eq!(rest["cacheHit"], true);
		assert_eq!(
			&full["result"]["sections"].as_array().unwrap()[1..],
			rest["result"]["sections"].as_array().unwrap()
		);
		assert_eq!(engine.rank_builds, 1);
		for options in [
			WikiSearchOptions { cursor: Some(continuation.clone()), ..Default::default() },
			WikiSearchOptions {
				cursor: Some(continuation.clone()),
				r#case: Some(false),
				..grep_options()
			},
		] {
			assert!(
				engine
					.search("ALPHA", &options, &|| Ok(()))
					.unwrap_err()
					.message
					.contains("does not match")
			);
		}
		engine.close();
		let reopened = search(&mut engine, "ALPHA", WikiSearchOptions {
			cursor: Some(continuation),
			..grep_options()
		});
		assert_eq!(reopened["cacheHit"], false);
		assert_eq!(reopened["result"]["sections"], rest["result"]["sections"]);
		let default = search(&mut engine, "unrelated FTS", WikiSearchOptions::default());
		let ignored = search(&mut engine, "unrelated FTS", WikiSearchOptions {
			mode: Some("search".into()),
			r#case: Some(false),
			..Default::default()
		});
		assert_eq!(default["result"]["cursorBase"]["q"], ignored["result"]["cursorBase"]["q"]);
		assert_eq!(ignored["cacheHit"], true);
	}

	#[test]
	fn grep_snapshot_changes_expire_cursor_and_cancelled_scan_never_publishes_partial_rank() {
		let fixture =
			grep_fixture(&["# One\nALPHA\n#### Cell\n# Two\nALPHA\n##### Row\n# Three\nALPHA\n"]);
		let mut engine = fixture.engine();
		let first = search(&mut engine, "ALPHA", grep_options());
		engine
			.connection
			.as_ref()
			.unwrap()
			.execute("DELETE FROM sections_fts WHERE rowid=?", [first["result"]["sections"][0]
				["sectionId"]
				.as_i64()
				.unwrap()])
			.unwrap();
		assert!(
			engine
				.search(
					"ALPHA",
					&WikiSearchOptions { cursor: Some(cursor(&first, 1)), ..grep_options() },
					&|| Ok(())
				)
				.unwrap_err()
				.message
				.contains("Stale documentation search cursor")
		);
		assert_eq!(search(&mut engine, "ALPHA", grep_options())["result"]["total"], 3);
		engine.clear_cache();
		let checks = Arc::new(AtomicU64::new(0));
		let calls = Arc::clone(&checks);
		let error = engine
			.search("(?=.)", &grep_options(), move || {
				if calls.fetch_add(1, Ordering::Relaxed) > 40 {
					Err(WikiError::message("cancelled grep"))
				} else {
					Ok(())
				}
			})
			.unwrap_err();
		assert_eq!(error.message, "cancelled grep");
		assert!(engine.cache.is_empty());
		assert!(engine.connection.as_ref().unwrap().is_autocommit());
		assert_eq!(search(&mut engine, "ALPHA", grep_options())["result"]["total"], 3);
	}
}

#[cfg(test)]
mod connection_identity_tests {
	use super::*;

	#[test]
	fn replacement_during_open_is_rejected_and_the_next_open_binds_the_actual_file() {
		let directory = std::env::temp_dir().join(format!(
			"omp-wiki-open-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		fs::create_dir_all(&directory).unwrap();
		let path = directory.join("docs.db");
		let replacement = directory.join("replacement.db");
		for (file, value) in [(&path, "old"), (&replacement, "replacement")] {
			let connection = Connection::open(file).unwrap();
			connection
				.execute_batch("CREATE TABLE marker(value TEXT)")
				.unwrap();
			connection
				.execute("INSERT INTO marker VALUES(?)", [value])
				.unwrap();
		}
		let original = file_identity(&path).unwrap();
		let result = open_identified_connection(&path, || {
			// Unix exercises replacing an already-open SQLite file. Windows
			// exercises the same pre/post identity guard before its VFS locks
			// the file, without relying on renaming an open database.
			#[cfg(unix)]
			let connection = Connection::open(&path)?;
			fs::rename(&path, directory.join("old.db"))?;
			fs::rename(&replacement, &path)?;
			#[cfg(not(unix))]
			let connection = Connection::open(&path)?;
			Ok(connection)
		});
		assert!(result.is_err());
		let (connection, identity) =
			open_identified_connection(&path, || Ok(Connection::open(&path)?)).unwrap();
		assert_ne!(identity, original);
		assert_eq!(identity, file_identity(&path).unwrap());
		let value: String = connection
			.query_row("SELECT value FROM marker", [], |row| row.get(0))
			.unwrap();
		assert_eq!(value, "replacement");
		drop(connection);
		fs::remove_dir_all(directory).unwrap();
	}
}
