//! Query analysis, contextual literal boundaries, and the wiki relevance order.
//!
//! These are the query-time algorithms from docs/engine.ts. In particular, FTS
//! supplies recall and its final tie-breaker, not the primary relevance order.

use std::{
	cmp::Ordering,
	collections::{HashSet, VecDeque},
	ops::{Deref, Range},
	sync::{Arc, LazyLock},
};

use napi::{
	Result as NapiResult, ValueType,
	bindgen_prelude::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue},
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::{
	UnicodeNormalization,
	char::{canonical_combining_class, compose, decompose_compatible},
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Shape {
	Content,
	HeadingOnly,
	Stub,
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
		// SAFETY: N-API supplies the live environment; the static string is
		// borrowed directly until N-API has copied its bytes.
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
		// SAFETY: N-API supplies the live environment; no owned Rust string
		// allocation is needed for these static metadata values.
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

/// Edge slices share stored source even when one combining sequence spans many
/// sections. Empty lexer-only contexts do not allocate.
#[derive(Clone, Debug, Default)]
pub(crate) enum ContextEdge {
	#[default]
	Empty,
	Shared {
		source: Arc<str>,
		range:  Range<usize>,
	},
}

impl ContextEdge {
	pub(crate) fn shared(source: &Arc<str>, range: Range<usize>) -> Self {
		if range.is_empty() {
			Self::Empty
		} else {
			Self::Shared { source: Arc::clone(source), range }
		}
	}
}

impl From<String> for ContextEdge {
	fn from(source: String) -> Self {
		if source.is_empty() {
			return Self::Empty;
		}
		let length = source.len();
		Self::shared(&Arc::from(source), 0..length)
	}
}

impl Deref for ContextEdge {
	type Target = str;

	fn deref(&self) -> &str {
		match self {
			Self::Empty => "",
			Self::Shared { source, range } => &source[range.clone()],
		}
	}
}

#[derive(Clone, Debug)]
pub(crate) struct SectionContext {
	pub shape:          Shape,
	pub fence_prefix:   Option<String>,
	pub continues_line: bool,
	pub before:         ContextEdge,
	pub after:          ContextEdge,
}

#[derive(Debug)]
pub(crate) struct Candidate {
	pub section_id:   i64,
	pub raw_markdown: String,
	pub raw:          String,
	pub plain:        String,
	pub title:        String,
	pub shape:        Shape,
	pub exact:        bool,
	pub rank:         f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RankedSection {
	pub section_id: i64,
	pub shape:      Shape,
	pub match_kind: MatchKind,
	pub rank:       f64,
}

#[derive(Debug)]
pub(crate) struct QueryPlan {
	pub terms:          Vec<String>,
	pub technical_name: Option<String>,
	pub fts:            String,
}

struct CharacterProperties {
	letter:         Regex,
	number:         Regex,
	mark:           Regex,
	han:            Regex,
	cased:          Regex,
	case_ignorable: Regex,
}

static PROPERTIES: LazyLock<CharacterProperties> = LazyLock::new(|| CharacterProperties {
	letter:         Regex::new(r"\A\p{L}\z").expect("Unicode letter property"),
	number:         Regex::new(r"\A\p{N}\z").expect("Unicode number property"),
	mark:           Regex::new(r"\A\p{M}\z").expect("Unicode mark property"),
	han:            Regex::new(r"\A\p{Script=Han}\z").expect("Unicode Han script property"),
	cased:          Regex::new(r"\A\p{Cased}\z").expect("Unicode cased property"),
	case_ignorable: Regex::new(r"\A\p{Case_Ignorable}\z").expect("Unicode case-ignorable property"),
});

fn property(pattern: &Regex, character: char) -> bool {
	let mut encoded = [0; 4];
	pattern.is_match(character.encode_utf8(&mut encoded))
}

fn is_letter(character: char) -> bool {
	if character.is_ascii() {
		character.is_ascii_alphabetic()
	} else {
		property(&PROPERTIES.letter, character)
	}
}

fn is_number(character: char) -> bool {
	if character.is_ascii() {
		character.is_ascii_digit()
	} else {
		property(&PROPERTIES.number, character)
	}
}

fn is_letter_number(character: char) -> bool {
	is_letter(character) || is_number(character)
}

fn is_han(character: char) -> bool {
	!character.is_ascii() && property(&PROPERTIES.han, character)
}

// The analyzer intentionally uses these two BMP ranges, NOT Script=Han.
const fn is_query_han(character: char) -> bool {
	matches!(character, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}')
}

/// ECMAScript `WhiteSpace` and `LineTerminator` (not Unicode `White_Space`).
pub(crate) const fn is_ecmascript_whitespace(character: char) -> bool {
	matches!(character,
		'\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
		'\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
		'\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn lowercase_sigma(preceded_by_cased: bool, mut following: impl Iterator<Item = char>) -> char {
	let followed_by_cased = following
		.find(|&next| !property(&PROPERTIES.case_ignorable, next))
		.is_some_and(|next| property(&PROPERTIES.cased, next));
	if preceded_by_cased && !followed_by_cased {
		'\u{03c2}'
	} else {
		'\u{03c3}'
	}
}

/// Default Unicode lowercase, including ECMAScript's contextual `Final_Sigma`.
fn lowercase(text: &str, trim: Option<bool>) -> String {
	let mut result = String::with_capacity(text.len());
	let mut pending_space = false;
	let mut preceded_by_cased = false;
	let has_sigma = text.contains('\u{03a3}');
	{
		let mut append = |character| {
			if trim.is_some() && is_ecmascript_whitespace(character) {
				pending_space = true;
			} else {
				if pending_space && (trim == Some(false) || !result.is_empty()) {
					result.push(' ');
				}
				pending_space = false;
				result.push(character);
			}
		};
		for (offset, character) in text.char_indices() {
			if character == '\u{03a3}' {
				append(lowercase_sigma(
					preceded_by_cased,
					text[offset + character.len_utf8()..].chars(),
				));
			} else {
				for lower in character.to_lowercase() {
					append(lower);
				}
			}
			if has_sigma {
				if character.is_ascii_alphabetic() {
					preceded_by_cased = true;
				} else if !property(&PROPERTIES.case_ignorable, character) {
					preceded_by_cased = property(&PROPERTIES.cased, character);
				}
			}
		}
	}
	if pending_space && trim == Some(false) {
		result.push(' ');
	}
	result
}

fn normalize_unicode(text: &str, trim: Option<bool>) -> String {
	// ASCII is already NFKC. Avoid a whole-body temporary in the common case.
	if text.is_ascii() {
		lowercase(text, trim)
	} else {
		lowercase(&text.nfkc().collect::<String>(), trim)
	}
}

pub(crate) fn normalize_search_text(text: &str) -> String {
	normalize_unicode(text, Some(true))
}

fn function_word(word: &str) -> bool {
	matches!(
		word,
		"的"
			| "了"
			| "是"
			| "在"
			| "和"
			| "与"
			| "及"
			| "或"
			| "之"
			| "其"
			| "这"
			| "那"
			| "哪"
			| "什"
			| "么"
			| "怎"
			| "样"
			| "吗"
			| "呢"
			| "吧"
			| "我"
			| "你"
			| "他"
			| "她"
			| "它"
			| "们"
			| "以"
			| "于"
			| "请"
			| "如"
			| "何"
			| "把"
			| "被"
			| "让"
			| "给"
			| "用"
			| "从"
			| "到"
			| "对"
			| "为"
			| "就"
			| "都"
			| "还"
			| "而"
			| "里"
			| "外"
			| "个"
			| "些"
			| "怎么"
			| "怎样"
			| "哪些"
			| "哪个"
			| "什么"
			| "是否"
			| "以及"
			| "如何"
			| "多少"
			| "介绍"
			| "说明"
	)
}

fn generic_term(term: &str) -> bool {
	matches!(
		term,
		"the"
			| "a"
			| "an"
			| "and"
			| "or"
			| "for"
			| "of"
			| "to"
			| "in"
			| "on"
			| "is"
			| "are"
			| "what"
			| "which"
			| "how"
			| "does"
			| "do"
			| "can"
			| "should"
	)
}

fn analyze_terms(query: &str) -> Vec<String> {
	let normalized = normalize_unicode(query, None);
	let mut terms: Vec<&str> = Vec::new();
	let mut seen = HashSet::new();
	let mut add = |term| {
		if seen.insert(term) {
			terms.push(term);
		}
	};
	let mut characters = normalized.char_indices().peekable();
	while let Some((start, first)) = characters.next() {
		if !is_letter_number(first) && first != '_' {
			continue;
		}
		let han = is_query_han(first);
		let mut end = start + first.len_utf8();
		while let Some(&(offset, next)) = characters.peek() {
			if (!is_letter_number(next) && next != '_') || is_query_han(next) != han {
				break;
			}
			characters.next();
			end = offset + next.len_utf8();
		}
		let run = &normalized[start..end];
		if !han {
			add(run);
			continue;
		}
		if function_word(run) {
			continue;
		}
		let mut chars = run.char_indices();
		let Some((mut previous_offset, mut previous)) = chars.next() else {
			continue;
		};
		let mut paired = false;
		for (offset, character) in chars {
			paired = true;
			let pair = &run[previous_offset..offset + character.len_utf8()];
			let mut left = [0; 4];
			let mut right = [0; 4];
			if !(function_word(pair)
				|| function_word(previous.encode_utf8(&mut left))
					&& function_word(character.encode_utf8(&mut right)))
			{
				add(pair);
			}
			previous_offset = offset;
			previous = character;
		}
		if !paired {
			add(run);
		}
	}
	if terms.len() > 32 {
		(0..32)
			.map(|index| terms[index * (terms.len() - 1) / 31].to_owned())
			.collect()
	} else {
		terms.into_iter().map(str::to_owned).collect()
	}
}

const fn ascii_case_letter(character: char) -> bool {
	character.is_ascii_alphabetic() || matches!(character, '\u{017f}' | '\u{212a}')
}

fn technical_token(token: &str) -> bool {
	if !token.chars().any(is_letter_number) {
		return false;
	}
	if token.contains(['_', '+', '#', '/', '\\']) || token.contains("::") {
		return true;
	}
	let characters: Vec<char> = token.chars().collect();
	let leading = characters
		.iter()
		.take_while(|&&character| matches!(character, '.' | '-'))
		.count();
	if (1..=2).contains(&leading)
		&& characters
			.get(leading)
			.is_some_and(|&character| is_letter(character))
	{
		return true;
	}
	if characters.windows(3).any(|part| {
		is_letter_number(part[0]) && matches!(part[1], '.' | '-') && is_letter_number(part[2])
	}) {
		return true;
	}
	let letters = characters
		.iter()
		.take_while(|&&character| ascii_case_letter(character))
		.count();
	letters > 0
		&& characters.get(letters).is_some_and(char::is_ascii_digit)
		&& characters[letters + 1..]
			.iter()
			.all(|&character| is_letter_number(character))
}

fn technical_query_name(query: &str) -> Option<String> {
	let normalized: String = query.nfkc().collect();
	let spelling = normalized.trim_matches(is_ecmascript_whitespace);
	let mut characters = spelling.chars();
	if characters
		.next()
		.is_some_and(|first| is_letter(first) || first == '_')
		&& characters.all(|character| {
			is_letter_number(character) || character == '_' || property(&PROPERTIES.mark, character)
		})
		&& !spelling.chars().any(is_han)
	{
		return Some(spelling.to_owned());
	}
	let standalone = if let Some(first @ ('`' | '"' | '\'')) = spelling.chars().next() {
		if spelling.ends_with(first)
			&& spelling.len() > 2
			&& !spelling[1..spelling.len() - 1].contains(first)
		{
			&spelling[1..spelling.len() - 1]
		} else {
			spelling
		}
	} else {
		spelling
	};
	spelling
		.split(|character| {
			is_ecmascript_whitespace(character)
				|| is_query_han(character)
				|| matches!(
					character,
					'`' | '"' | '\'' | '(' | ')' | ',' | ';' | '!' | '?' | '。' | '！' | '？'
				)
		})
		.filter(|token| !token.is_empty())
		.map(|token| {
			if token == standalone {
				token
			} else {
				token.trim_end_matches(['.', ':'])
			}
		})
		.find(|token| technical_token(token))
		.map(str::to_owned)
}

pub(crate) fn analyze_query(query: &str) -> QueryPlan {
	let terms = analyze_terms(query);
	let fts = terms
		.iter()
		.map(|term| {
			let term = if term.chars().any(is_query_han) {
				term
					.chars()
					.map(|character| character.to_string())
					.collect::<Vec<_>>()
					.join(" ")
			} else {
				term.clone()
			};
			format!("\"{}\"", term.replace('"', "\"\""))
		})
		.collect::<Vec<_>>()
		.join(" OR ");
	QueryPlan { terms, technical_name: technical_query_name(query), fts }
}

// Normalize only the interacting edge sequences, carrying source membership
// through canonical ordering and composition. A character composed from context
// and body is not wholly contained in the stored section.
fn append_literal_edge(
	fragments: &[(&str, bool)],
	output: &mut String,
	outside: &mut Vec<std::ops::Range<usize>>,
) {
	if fragments.iter().all(|(text, _)| text.is_ascii()) {
		for &(text, body) in fragments {
			let start = output.len();
			output.push_str(text);
			if !body && !text.is_empty() {
				outside.push(start..output.len());
			}
		}
		return;
	}
	let mut decomposed = Vec::new();
	for &(text, body) in fragments {
		for character in text.chars() {
			decompose_compatible(character, |character| decomposed.push((character, body)));
		}
	}
	let mut marks = 0;
	for index in 0..=decomposed.len() {
		if index == decomposed.len() || canonical_combining_class(decomposed[index].0) == 0 {
			decomposed[marks..index]
				.sort_by_key(|&(character, _)| canonical_combining_class(character));
			marks = index + 1;
		}
	}
	let mut written = 0;
	let mut starter: Option<usize> = None;
	let mut last_class = 0;
	for read in 0..decomposed.len() {
		let (character, body) = decomposed[read];
		let class = canonical_combining_class(character);
		if let Some(index) = starter
			&& (last_class == 0 || last_class < class)
			&& let Some(combination) = compose(decomposed[index].0, character)
		{
			decomposed[index] = (combination, decomposed[index].1 && body);
			continue;
		}
		if class == 0 {
			starter = Some(written);
		}
		last_class = class;
		decomposed[written] = (character, body);
		written += 1;
	}
	for &(character, body) in &decomposed[..written] {
		let start = output.len();
		output.push(character);
		if !body {
			outside.push(start..output.len());
		}
	}
}

pub(super) fn literal_edge_starter(character: char) -> bool {
	if character.is_ascii() {
		return true;
	}
	let mut first = None;
	decompose_compatible(character, |decomposed| {
		first.get_or_insert(decomposed);
	});
	let first = first.expect("nonempty Unicode decomposition");
	canonical_combining_class(first) == 0
		// Hangul V/T jamo can compose with the preceding class-zero starter,
		// including when they come from a compatibility decomposition.
		&& !matches!(first, '\u{1161}'..='\u{1175}' | '\u{11a8}'..='\u{11c2}')
}

/// A bounded normalized search window. Provenance records normalization
/// sequences, not occurrences; even a short name repeated throughout a document
/// retains only one window's source ranges.
#[derive(Default)]
struct SourceMatchWindow {
	text:         String,
	provenance:   VecDeque<(usize, Range<usize>)>,
	offset:       usize,
	search_start: usize,
}

impl SourceMatchWindow {
	fn push(&mut self, character: char, source: &Range<usize>) {
		self.text.push(character);
		let end = self.offset + self.text.len();
		if let Some((previous_end, previous_source)) = self.provenance.back_mut()
			&& previous_source == source
		{
			*previous_end = end;
		} else {
			self.provenance.push_back((end, source.clone()));
		}
	}

	fn scan(
		&mut self,
		matcher: &LiteralMatcher,
		final_window: bool,
		matched: &mut impl FnMut(Range<usize>) -> bool,
	) -> bool {
		// Leave the literal's maximum byte width and two complete characters
		// for the existing right-boundary rule (including "." / ":" lookahead).
		let mut cutoff = if final_window {
			self.text.len()
		} else {
			self.text.len().saturating_sub(matcher.text.len() + 8)
		};
		while !self.text.is_char_boundary(cutoff) {
			cutoff -= 1;
		}
		let mut offset = self.search_start;
		while let Some(found) = self.text[offset..].find(&matcher.text) {
			let start = offset + found;
			if start >= cutoff {
				break;
			}
			let end = start + matcher.text.len();
			if matcher.boundaries(&self.text, start, end) {
				let normalized_start = self.offset + start;
				let normalized_end = self.offset + end;
				let first = self
					.provenance
					.partition_point(|(sequence_end, _)| *sequence_end <= normalized_start);
				let last = self
					.provenance
					.partition_point(|(sequence_end, _)| *sequence_end < normalized_end);
				if !matched(self.provenance[first].1.start..self.provenance[last].1.end) {
					return false;
				}
			}
			offset = start
				+ self.text[start..]
					.chars()
					.next()
					.expect("nonempty literal match")
					.len_utf8();
		}
		// Keep one preceding character for the existing left-boundary rule.
		let retained = self.text[..cutoff]
			.char_indices()
			.next_back()
			.map_or(0, |(offset, _)| offset);
		self.text.drain(..retained);
		self.offset += retained;
		self.search_start = cutoff - retained;
		while self
			.provenance
			.front()
			.is_some_and(|(end, _)| *end <= self.offset)
		{
			self.provenance.pop_front();
		}
		true
	}
}

/// A compiled literal and its Unicode edge rules, reusable across every row.
#[derive(Debug)]
pub(crate) struct LiteralMatcher {
	text:          String,
	path_basename: bool,
	starts_han:    bool,
	ends_han:      bool,
}

impl LiteralMatcher {
	pub(crate) fn new(text: &str, path_basename: bool) -> Self {
		Self {
			text: text.to_owned(),
			path_basename,
			starts_han: text.chars().next().is_some_and(is_han),
			ends_han: text.chars().next_back().is_some_and(is_han),
		}
	}

	fn boundaries(&self, text: &str, start: usize, end: usize) -> bool {
		if !self.starts_han
			&& let Some(previous) = text[..start].chars().next_back()
		{
			let blocked = is_letter_number(previous)
				|| matches!(previous, '_' | '+' | '#' | '.' | ':' | '-')
				|| (!self.path_basename && matches!(previous, '/' | '\\'));
			if !is_han(previous) && blocked {
				return false;
			}
		}
		if !self.ends_han {
			let mut suffix = text[end..].chars();
			if let Some(next) = suffix.next()
				&& !is_han(next)
				&& (is_letter_number(next)
					|| matches!(next, '_' | '+' | '#' | '/' | '\\' | '-')
					|| (matches!(next, '.' | ':')
						&& suffix
							.next()
							.is_some_and(|after| is_letter_number(after) || after == '_' || after == ':')))
			{
				return false;
			}
		}
		true
	}

	pub(crate) fn is_match(&self, text: &str) -> bool {
		if self.text.is_empty() {
			return text
				.char_indices()
				.map(|(offset, _)| offset)
				.chain(std::iter::once(text.len()))
				.any(|offset| self.boundaries(text, offset, offset));
		}
		let mut offset = 0;
		while let Some(found) = text[offset..].find(&self.text) {
			let start = offset + found;
			let end = start + self.text.len();
			if self.boundaries(text, start, end) {
				return true;
			}
			offset = start
				+ text[start..]
					.chars()
					.next()
					.expect("nonempty literal match")
					.len_utf8();
		}
		false
	}

	/// Stream complete source normalization sequences through the same literal
	/// and boundary matcher used for individual sections. The callback consumes
	/// each source range immediately and can stop once every section is decided.
	pub(super) fn source_matches<E>(
		&self,
		source: &str,
		check: &dyn Fn() -> Result<(), E>,
		mut matched: impl FnMut(Range<usize>) -> bool,
	) -> Result<(), E> {
		self.source_matches_with_window(
			source,
			check,
			&mut matched,
			&mut SourceMatchWindow::default(),
		)
	}

	/// Remove only syntax identified by the existing lexer. The normalized
	/// window still carries original byte ranges, including across formatting.
	pub(super) fn source_name_matches<E>(
		&self,
		source: &str,
		check: &dyn Fn() -> Result<(), E>,
		mut matched: impl FnMut(Range<usize>) -> bool,
	) -> Result<(), E> {
		if !source.contains(['*', '_', '~', '\\', '[']) {
			return self.source_matches(source, check, matched);
		}
		let super::markdown::NameSyntax { mut delimiters, link_openings, link_destinations } =
			super::markdown::name_delimiters(source);
		delimiters.extend(link_openings);
		delimiters.extend(link_destinations.iter().cloned());
		delimiters.sort_unstable_by_key(|range| range.start);
		let mut destinations = link_destinations.iter().peekable();
		let mut destination_window = SourceMatchWindow::default();
		let mut destination_error = None;
		let mut active = true;
		self.source_matches_ignoring_with_window(
			source,
			&delimiters,
			check,
			&mut |found: Range<usize>| {
				// 两条来源轨道按原字节顺序发布，避免目标与标签拼接或提前消费章节。
				active = match self.source_link_matches(
					source,
					&mut destinations,
					found.start,
					check,
					&mut matched,
					&mut destination_window,
				) {
					Ok(true) => matched(found),
					Ok(false) => false,
					Err(error) => {
						destination_error = Some(error);
						false
					},
				};
				active
			},
			&mut SourceMatchWindow::default(),
		)?;
		if let Some(error) = destination_error {
			return Err(error);
		}
		if active {
			self.source_link_matches(
				source,
				&mut destinations,
				usize::MAX,
				check,
				&mut matched,
				&mut destination_window,
			)?;
		}
		Ok(())
	}

	fn source_link_matches<E>(
		&self,
		source: &str,
		destinations: &mut std::iter::Peekable<std::slice::Iter<'_, Range<usize>>>,
		before: usize,
		check: &dyn Fn() -> Result<(), E>,
		matched: &mut impl FnMut(Range<usize>) -> bool,
		window: &mut SourceMatchWindow,
	) -> Result<bool, E> {
		while destinations
			.peek()
			.is_some_and(|range| range.start < before)
		{
			let range = destinations.next().expect("peeked link destination");
			let mut active = true;
			window.text.clear();
			window.provenance.clear();
			window.offset = 0;
			window.search_start = 0;
			self.source_matches_with_window(
				&source[range.clone()],
				check,
				&mut |found: Range<usize>| {
					active = matched(found.start + range.start..found.end + range.start);
					active
				},
				window,
			)?;
			if !active {
				return Ok(false);
			}
		}
		Ok(true)
	}

	fn source_matches_with_window<E>(
		&self,
		source: &str,
		check: &dyn Fn() -> Result<(), E>,
		matched: &mut impl FnMut(Range<usize>) -> bool,
		window: &mut SourceMatchWindow,
	) -> Result<(), E> {
		self.source_matches_ignoring_with_window(source, &[], check, matched, window)
	}

	fn source_matches_ignoring_with_window<E>(
		&self,
		source: &str,
		ignored: &[Range<usize>],
		check: &dyn Fn() -> Result<(), E>,
		matched: &mut impl FnMut(Range<usize>) -> bool,
		window: &mut SourceMatchWindow,
	) -> Result<(), E> {
		check()?;
		if self.text.is_empty() {
			return Ok(());
		}
		// Match lowercase()'s fast path without materializing all of NFKC.
		// Compatibility characters can introduce an uppercase Greek sigma.
		let has_sigma = source
			.chars()
			.filter(|character| !character.is_ascii())
			.any(|character| {
				let mut sigma = false;
				decompose_compatible(character, |decomposed| sigma |= decomposed == '\u{03a3}');
				sigma
			});
		let mut skipped = 0;
		let mut characters = source
			.char_indices()
			.filter(move |&(offset, _)| {
				while ignored
					.get(skipped)
					.is_some_and(|range| range.end <= offset)
				{
					skipped += 1;
				}
				!ignored
					.get(skipped)
					.is_some_and(|range| range.start <= offset)
			})
			.peekable();
		let mut preceded_by_cased = false;
		let limit = self.text.len() + 4096 + 12;
		while characters.peek().is_some() {
			check()?;
			let sequence = characters.clone();
			let (source_start, first) = characters.next().expect("peeked source character");
			let mut source_end = source_start + first.len_utf8();
			let mut count = 1;
			while characters
				.peek()
				.is_some_and(|&(_, character)| !literal_edge_starter(character))
			{
				let (offset, character) = characters.next().expect("peeked continuation");
				source_end = offset + character.len_utf8();
				count += 1;
			}
			let range = source_start..source_end;
			let mut normalized = sequence.take(count).map(|(_, character)| character).nfkc();
			while let Some(character) = normalized.next() {
				let lower = if character == '\u{03a3}' {
					lowercase_sigma(
						preceded_by_cased,
						normalized
							.clone()
							.chain(characters.clone().map(|(_, character)| character).nfkc()),
					)
				} else {
					character
				};
				for lower in lower.to_lowercase() {
					window.push(lower, &range);
					if window.text.len() >= limit {
						check()?;
						if !window.scan(self, false, matched) {
							return Ok(());
						}
					}
				}
				if has_sigma {
					if character.is_ascii_alphabetic() {
						preceded_by_cased = true;
					} else if !property(&PROPERTIES.case_ignorable, character) {
						preceded_by_cased = property(&PROPERTIES.cased, character);
					}
				}
			}
		}
		check()?;
		window.scan(self, true, matched);
		Ok(())
	}

	/// Legacy non-source-coordinate sections cannot join document
	/// reconstruction. Keep their existing contextual matcher, removing only
	/// lexer-owned syntax.
	pub(crate) fn matches_name_section(
		&self,
		raw: &str,
		markdown: &str,
		context: &SectionContext,
	) -> bool {
		if !markdown.contains(['*', '_', '~', '\\', '[']) {
			return self.matches_section(raw, markdown, context);
		}
		let super::markdown::NameSyntax { mut delimiters, link_openings, link_destinations } =
			super::markdown::section_name_delimiters(markdown, context);
		if link_destinations
			.iter()
			.any(|range| self.is_match(&normalize_search_text(&markdown[range.clone()])))
		{
			return true;
		}
		delimiters.extend(link_openings);
		delimiters.extend(link_destinations);
		delimiters.sort_unstable_by_key(|range| range.start);
		if delimiters.is_empty() {
			return self.matches_section(raw, markdown, context);
		}
		let removed: usize = delimiters.iter().map(|range| range.len()).sum();
		let mut projected = String::with_capacity(markdown.len() - removed);
		let mut start = 0;
		for range in delimiters {
			projected.push_str(&markdown[start..range.start]);
			start = range.end;
		}
		projected.push_str(&markdown[start..]);
		self.matches_section(&normalize_search_text(&projected), markdown, context)
	}

	pub(crate) fn matches_section(
		&self,
		text: &str,
		markdown: &str,
		context: &SectionContext,
	) -> bool {
		// An ASCII literal cannot be created by canonical reordering/composition
		// at a seam. Skip mark-only intermediate sections without expanding their
		// potentially document-sized shared edges; retain the full Unicode path.
		if self.text.is_ascii() && !text.contains(&self.text) {
			return false;
		}
		let before = if markdown
			.chars()
			.next()
			.is_some_and(is_ecmascript_whitespace)
		{
			" ".to_owned()
		} else {
			normalize_unicode(&context.before, Some(false))
		};
		let after = if markdown
			.chars()
			.next_back()
			.is_some_and(is_ecmascript_whitespace)
		{
			" ".to_owned()
		} else {
			normalize_unicode(&context.after, Some(false))
		};
		let mut contextual = String::with_capacity(before.len() + text.len() + after.len());
		let mut outside = Vec::new();
		let prefix_end = text
			.char_indices()
			.skip(1)
			.find(|&(_, character)| literal_edge_starter(character))
			.map_or(text.len(), |(offset, _)| offset);
		let suffix_start = text
			.char_indices()
			.rfind(|&(_, character)| literal_edge_starter(character))
			.map_or(0, |(offset, _)| offset);
		if prefix_end > suffix_start {
			append_literal_edge(
				&[(&before, false), (text, true), (&after, false)],
				&mut contextual,
				&mut outside,
			);
		} else {
			append_literal_edge(
				&[(&before, false), (&text[..prefix_end], true)],
				&mut contextual,
				&mut outside,
			);
			contextual.push_str(&text[prefix_end..suffix_start]);
			append_literal_edge(
				&[(&text[suffix_start..], true), (&after, false)],
				&mut contextual,
				&mut outside,
			);
		}
		let mut offset = 0;
		if self.text.is_empty() {
			return false;
		}
		while let Some(found) = contextual[offset..].find(&self.text) {
			let start = offset + found;
			let end = start + self.text.len();
			if self.boundaries(&contextual, start, end) {
				if !outside
					.iter()
					.any(|range| start < range.end && end > range.start)
				{
					return true;
				}
				// The original /gu matcher consumes even out-of-body matches.
				offset = end;
			} else {
				offset = start
					+ contextual[start..]
						.chars()
						.next()
						.expect("nonempty literal match")
						.len_utf8();
			}
		}
		false
	}
}

struct ScoredSection {
	section:      RankedSection,
	title_phrase: bool,
	phrase:       bool,
	topic_title:  usize,
	topic_body:   usize,
	relevance:    f64,
	body_hash:    Option<[u8; 32]>,
}

fn compare_scored(a: &ScoredSection, b: &ScoredSection) -> Ordering {
	(b.section.match_kind == MatchKind::ExactName)
		.cmp(&(a.section.match_kind == MatchKind::ExactName))
		.then_with(|| (a.section.shape == Shape::Stub).cmp(&(b.section.shape == Shape::Stub)))
		.then_with(|| b.title_phrase.cmp(&a.title_phrase))
		.then_with(|| b.topic_body.cmp(&a.topic_body))
		.then_with(|| b.topic_title.cmp(&a.topic_title))
		.then_with(|| (b.section.shape == Shape::Content).cmp(&(a.section.shape == Shape::Content)))
		.then_with(|| b.phrase.cmp(&a.phrase))
		.then_with(|| {
			b.relevance
				.partial_cmp(&a.relevance)
				.unwrap_or(Ordering::Equal)
		})
		.then_with(|| {
			a.section
				.rank
				.partial_cmp(&b.section.rank)
				.unwrap_or(Ordering::Equal)
		})
		.then_with(|| a.section.section_id.cmp(&b.section.section_id))
}

#[expect(
	clippy::suboptimal_flops,
	reason = "Keep separate TypeScript multiplication and addition; mul_add changes rounding."
)]
pub(crate) fn rank_candidates_with_check<F, E>(
	query: &str,
	terms: &[String],
	candidates: Vec<Candidate>,
	mut check: F,
) -> Result<Vec<RankedSection>, E>
where
	F: FnMut() -> Result<(), E>,
{
	check()?;
	let patterns: Vec<_> = terms
		.iter()
		.map(|term| LiteralMatcher::new(term, false))
		.collect();
	let phrase = LiteralMatcher::new(&normalize_search_text(query), false);
	let mut frequencies = vec![0usize; terms.len()];
	for (position, candidate) in candidates.iter().enumerate() {
		if position % 256 == 0 {
			check()?;
		}
		for (frequency, pattern) in frequencies.iter_mut().zip(&patterns) {
			*frequency +=
				usize::from(pattern.is_match(&candidate.raw) || pattern.is_match(&candidate.plain));
		}
	}
	#[expect(
		clippy::imprecise_flops,
		reason = "Keep the TypeScript ln(1 + x) operation order; ln_1p changes ranking weights."
	)]
	let weights: Vec<_> = terms
		.iter()
		.zip(frequencies)
		.map(|(term, frequency)| {
			(if generic_term(term) { 0.2 } else { 1.0 })
				* (1.0 + (1.0 + candidates.len() as f64 / (1.0 + frequency as f64)).ln())
		})
		.collect();
	let nfkc: String = query.nfkc().collect();
	let han_topics: HashSet<_> = nfkc
		.split(|character| !is_query_han(character))
		.filter(|part| !part.is_empty())
		.collect();
	let topics: Vec<_> = terms
		.iter()
		.map(|term| {
			!generic_term(term)
				&& (term.chars().any(ascii_case_letter) || han_topics.contains(term.as_str()))
		})
		.collect();
	let mut scored = Vec::with_capacity(candidates.len());
	for (position, candidate) in candidates.into_iter().enumerate() {
		if position % 256 == 0 {
			check()?;
		}
		let mut relevance = 0.0;
		let mut topic_title = 0;
		let mut topic_body = 0;
		for ((pattern, &weight), &topic) in patterns.iter().zip(&weights).zip(&topics) {
			let in_title = pattern.is_match(&candidate.title);
			let in_body = pattern.is_match(&candidate.raw) || pattern.is_match(&candidate.plain);
			if in_body {
				relevance += weight;
			}
			if in_title {
				relevance += weight * 3.0;
			}
			if topic {
				topic_body += usize::from(in_body);
				topic_title += usize::from(in_title);
			}
		}
		let body_hash = if candidate.raw_markdown.encode_utf16().nth(200).is_some() {
			Some(Sha256::digest(candidate.raw_markdown.as_bytes()).into())
		} else {
			None
		};
		scored.push(ScoredSection {
			section: RankedSection {
				section_id: candidate.section_id,
				shape:      candidate.shape,
				match_kind: if candidate.exact {
					MatchKind::ExactName
				} else {
					MatchKind::Related
				},
				rank:       candidate.rank,
			},
			title_phrase: phrase.is_match(&candidate.title),
			phrase: phrase.is_match(&candidate.raw) || phrase.is_match(&candidate.plain),
			topic_title,
			topic_body,
			relevance,
			body_hash,
		});
	}
	check()?;
	scored.sort_by(compare_scored);
	check()?;
	let mut seen = HashSet::new();
	let mut groups: [Vec<RankedSection>; 5] = std::array::from_fn(|_| Vec::new());
	for (position, entry) in scored.into_iter().enumerate() {
		if position % 256 == 0 {
			check()?;
		}
		let group =
			if entry.section.shape == Shape::Stub && entry.section.match_kind == MatchKind::Related {
				4
			} else {
				let repeated = entry.body_hash.is_some_and(|hash| !seen.insert(hash));
				if entry.section.match_kind == MatchKind::ExactName {
					usize::from(repeated)
				} else {
					2 + usize::from(repeated)
				}
			};
		groups[group].push(entry.section);
	}
	let mut ranked = Vec::with_capacity(groups.iter().map(Vec::len).sum());
	for group in groups {
		ranked.extend(group);
	}
	Ok(ranked)
}

#[cfg(test)]
mod tests {
	use std::convert::Infallible;

	use super::*;

	#[test]
	fn reconstructed_names_map_normalization_sequences_to_source_bytes() {
		for (source, name, expected) in [
			("foobar", "foobar", vec![0..6]),
			(" \u{fb03} ", "ffi", vec![1..4]),
			(" a\u{0303}b ", "ãb", vec![1..5]),
			("\u{1100}\u{1161}\u{11a8}", "각", vec![0..9]),
			("ΟΣ", "ος", vec![0..4]),
			("哈哈哈", "哈哈", vec![0..6, 3..9]),
		] {
			let mut found = Vec::new();
			LiteralMatcher::new(name, true)
				.source_matches(source, &|| Ok::<_, Infallible>(()), |range| {
					found.push(range);
					true
				})
				.unwrap();
			assert_eq!(found, expected, "{source:?}");
		}
	}

	#[test]
	fn lexical_name_boundaries_validate_each_original_occurrence() {
		for (source, name, expected) in [
			("**scan**ner scan", "scan", vec![12..16]),
			("**scan**ner `scan`ner", "scan", vec![13..17]),
			("**mbist_check.rpt**.bak", "mbist_check.rpt", vec![]),
			("**scan**ner", "scanner", vec![2..11]),
			("s**ca**n\u{0303}", "scañ", vec![0..10]),
			("`counter_value*factor*next`", "counter_value*factor*next", vec![1..26]),
			("[scan](scan)", "scan", vec![1..5, 7..11]),
			("std::[vector](target)", "std::vector", vec![0..12]),
			("中😀std::[vec**tor**](target)", "std::vector", vec![7..21]),
			("mbist\\_check.rpt", "mbist_check.rpt", vec![0..16]),
		] {
			let mut found = Vec::new();
			LiteralMatcher::new(name, true)
				.source_name_matches(source, &|| Ok::<_, Infallible>(()), |range| {
					found.push(range);
					true
				})
				.unwrap();
			assert_eq!(found, expected, "{source:?}");
		}
	}

	#[test]
	fn legacy_name_context_keeps_code_and_rejects_emphasis_boundaries() {
		for (source, name, expected) in [
			("**scan**ner", "scan", false),
			("**mbist_check.rpt**.bak", "mbist_check.rpt", false),
			("`scan`ner", "scan", true),
			("`counter_value*factor*next`", "counter_value*factor*next", true),
			("[scan](scan)", "scan", true),
			("mbist\\_check.rpt", "mbist_check.rpt", true),
		] {
			assert_eq!(
				LiteralMatcher::new(name, true).matches_name_section(
					&normalize_search_text(source),
					source,
					&context("", ""),
				),
				expected,
				"{source:?}",
			);
		}
	}

	#[test]
	fn repeated_short_names_keep_bounded_source_match_storage() {
		let matcher = LiteralMatcher::new("x", true);
		for repeats in [8192, 262_144] {
			let mut source = "x ".repeat(repeats);
			let suffix_start = source.len();
			source.push_str("éx xé x:x x.é 中x x中 x. x: x\u{0301} ｘ");
			let mut window = SourceMatchWindow::default();
			let mut count = 0;
			let mut suffix_matches = Vec::new();
			matcher
				.source_matches_with_window(
					&source,
					&|| Ok::<_, Infallible>(()),
					&mut |range: Range<usize>| {
						count += 1;
						if range.start >= suffix_start {
							suffix_matches.push(source[range].to_owned());
						}
						true
					},
					&mut window,
				)
				.unwrap();
			assert_eq!(count, repeats + 6);
			assert_eq!(suffix_matches, ["x", "x", "x", "x", "x\u{0301}", "ｘ"]);
			// Check actual retained allocation capacities against the search
			// window, not elapsed time or machine-wide memory measurements.
			let capacity_bound = 2 * (matcher.text.len() + 4096 + 16);
			assert!(window.text.capacity() <= capacity_bound);
			assert!(window.provenance.capacity() <= capacity_bound);
		}
	}

	#[test]
	fn source_match_windows_preserve_boundaries_and_sequence_ranges() {
		for padding in 4080..4140 {
			let prefix = " ".repeat(padding);
			for (body, name, expected) in [
				("x.", "x", vec![0..1]),
				("foobar", "foobar", vec![0..6]),
				("x.é", "x", vec![]),
				("éx", "x", vec![]),
				("中x", "x", vec![3..4]),
				("\u{fb03}", "ffi", vec![0..3]),
				("a\u{0303}b", "ãb", vec![0..4]),
				("ΟΣ\u{0301}", "ος\u{0301}", vec![0..6]),
				("\u{1100}\u{1161}\u{11a8}", "각", vec![0..9]),
				("ΟΣ'Α", "οσ'α", vec![0..7]),
			] {
				let source = format!("{prefix}{body} {}", " ".repeat(64));
				let mut found = Vec::new();
				LiteralMatcher::new(name, true)
					.source_matches(&source, &|| Ok::<_, Infallible>(()), |range| {
						found.push(range.start - padding..range.end - padding);
						true
					})
					.unwrap();
				assert_eq!(found, expected, "padding={padding}, body={body:?}");
			}
		}
	}

	fn context(before: &str, after: &str) -> SectionContext {
		SectionContext {
			shape:          Shape::Content,
			fence_prefix:   None,
			continues_line: false,
			before:         before.to_owned().into(),
			after:          after.to_owned().into(),
		}
	}

	#[test]
	fn ecmascript_normalization_and_final_sigma() {
		assert_eq!(normalize_search_text("\u{feff}ＦＯＯ\u{00a0}ΟΣ\u{2028}"), "foo ος");
		assert_eq!(normalize_search_text("ΟΣΑ ΟΣ\u{0301} ΟΣ'Α Α'Σ"), "οσα ος\u{0301} οσ'α α'ς");
		assert_eq!(
			normalize_search_text("A\u{0085}B\u{001c}C\u{200b}D"),
			"a\u{0085}b\u{001c}c\u{200b}d"
		);
		assert_eq!(normalize_search_text("İ"), "i\u{0307}");
	}

	#[test]
	fn analyzer_preserves_scripts_bigrams_and_tail() {
		assert_eq!(analyze_query("mbist问题 和与 是否 作用域 不").terms, [
			"mbist", "问题", "作用", "用域", "不"
		]);
		assert_eq!(analyze_query("問題").fts, "\"問 題\"");
		assert_eq!(analyze_query("a\u{0301}\u{0301}b 𠀀").terms, ["á", "b", "𠀀"]);
		let long = (0..65)
			.map(|index| format!("t{index}"))
			.collect::<Vec<_>>()
			.join(" ");
		let terms = analyze_query(&long).terms;
		assert_eq!(terms.len(), 32);
		assert_eq!(terms[0], "t0");
		assert_eq!(terms[1], "t2");
		assert_eq!(terms[31], "t64");
	}

	#[test]
	fn technical_names_keep_user_spelling_and_literal_punctuation() {
		assert_eq!(analyze_query("Ｆｏｏ").technical_name.as_deref(), Some("Foo"));
		assert_eq!(analyze_query("check Foo.bar.").technical_name.as_deref(), Some("Foo.bar"));
		assert_eq!(analyze_query("`Foo.bar.`").technical_name.as_deref(), Some("Foo.bar."));
		assert_eq!(analyze_query("Foo.bar.").technical_name.as_deref(), Some("Foo.bar."));
		assert_eq!(analyze_query("std::vector").technical_name.as_deref(), Some("std::vector"));
		assert_eq!(analyze_query("--flag").technical_name.as_deref(), Some("--flag"));
		assert_eq!(analyze_query("ordinary topic").technical_name, None);
		assert_eq!(analyze_query("𠀀").technical_name, None);
	}

	#[test]
	fn identifier_path_namespace_and_han_boundaries() {
		let name = LiteralMatcher::new("scan", false);
		for text in ["scan", "扫描scan说明", "scan.", "scan: ", "(scan)", "scan\u{0301}"] {
			assert!(name.is_match(text), "{text}");
		}
		for text in [
			"rescan",
			"scan2",
			"scan.log",
			"scan::",
			"scan/v",
			"path/scan",
			"scan_",
			"scan-",
			"scan+",
			"scan#",
		] {
			assert!(!name.is_match(text), "{text}");
		}
		assert!(LiteralMatcher::new("scan", true).is_match("path/scan"));
		assert!(!LiteralMatcher::new("path/scan", false).is_match("other/path/scan"));
		assert!(LiteralMatcher::new("𠀀", false).is_match("a𠀀b"));
	}

	#[test]
	fn chunk_context_preserves_whitespace_and_global_match_consumption() {
		let name = LiteralMatcher::new("scan", true);
		assert!(!name.matches_section("scan", "scan", &context("re", "")));
		assert!(!name.matches_section("scan", "scan", &context("", ".l")));
		assert!(name.matches_section("scan", " scan\n", &context("re", ".l")));
		assert!(name.matches_section("scan", "scan", &context("/", "")));
		assert!(!LiteralMatcher::new("哈哈", false).matches_section(
			"哈哈",
			"哈哈",
			&context("哈", "")
		));
	}

	fn candidate(id: i64, raw: &str, exact: bool, shape: Shape, rank: f64) -> Candidate {
		Candidate {
			section_id: id,
			raw_markdown: raw.to_owned(),
			raw: normalize_search_text(raw),
			plain: normalize_search_text(raw),
			title: String::new(),
			shape,
			exact,
			rank,
		}
	}

	#[test]
	fn exact_duplicate_related_and_stub_redistribution() {
		let repeated = format!("scan {}", "x".repeat(201));
		let candidates = vec![
			candidate(1, &repeated, true, Shape::Content, -4.0),
			candidate(2, &repeated, true, Shape::Content, -3.0),
			candidate(3, "scan distinct", true, Shape::Content, -2.0),
			candidate(4, &repeated, false, Shape::Content, -4.0),
			candidate(5, "scan related", false, Shape::Content, -3.0),
			candidate(6, "scan stub", false, Shape::Stub, -9.0),
		];
		let ranked = rank_candidates_with_check("scan", &["scan".to_owned()], candidates, || {
			Ok::<_, Infallible>(())
		})
		.unwrap();
		assert_eq!(
			ranked
				.iter()
				.map(|entry| entry.section_id)
				.collect::<Vec<_>>(),
			[1, 3, 2, 5, 4, 6]
		);
	}

	#[test]
	fn duplicate_threshold_counts_utf16_and_ties_use_bm25_then_id() {
		for (count, expected) in [(100, vec![1, 2, 3]), (101, vec![1, 3, 2])] {
			let body = "😀".repeat(count);
			let candidates = vec![
				candidate(2, &body, false, Shape::Content, -2.0),
				candidate(3, "different", false, Shape::Content, -1.0),
				candidate(1, &body, false, Shape::Content, -2.0),
			];
			assert_eq!(
				rank_candidates_with_check("", &[], candidates, || Ok::<_, Infallible>(()))
					.unwrap()
					.iter()
					.map(|entry| entry.section_id)
					.collect::<Vec<_>>(),
				expected
			);
		}
	}

	#[test]
	fn topic_conjunction_precedes_local_title_and_bm25() {
		let mut title = candidate(1, "scan", false, Shape::Content, -10.0);
		title.title = "scan".to_owned();
		let both = candidate(2, "scan log", false, Shape::Content, -1.0);
		let terms = analyze_query("scan log").terms;
		assert_eq!(
			rank_candidates_with_check("scan log", &terms, vec![title, both], || {
				Ok::<_, Infallible>(())
			})
			.unwrap()
			.iter()
			.map(|entry| entry.section_id)
			.collect::<Vec<_>>(),
			[2, 1]
		);
	}
}
