//! DB slice reconstruction for original-line regex matching.
use std::collections::VecDeque;

use grep_matcher::Matcher;
use pi_builtins::CompiledMatcher;
use rusqlite::Connection;

use super::{
	database::WikiError,
	markdown::{ContextSection, ContextSectionRef, SectionContextScanner},
	query::{MatchKind, RankedSection},
};

type CoreResult<T> = Result<T, WikiError>;
type Check<'a> = &'a dyn Fn() -> CoreResult<()>;

struct PendingSection {
	start:   i64,
	end:     i64,
	ranked:  RankedSection,
	matched: bool,
}

#[derive(Default)]
struct Lines {
	text:     String,
	start:    i64,
	end:      i64,
	newlines: VecDeque<i64>,
	sections: VecDeque<PendingSection>,
	ranked:   Vec<RankedSection>,
}

impl Lines {
	fn append(&mut self, section: &ContextSection, shape: super::query::Shape) -> CoreResult<()> {
		let length = section.byte_end - section.byte_start;
		if length < 0 || length as usize != section.raw_markdown.len() {
			return Err(WikiError::message("Documentation search snapshot is inconsistent"));
		}
		if self.text.is_empty() && self.sections.is_empty() {
			self.start = section.byte_start;
			self.end = section.byte_start;
		}
		if section.byte_start > self.end {
			return Err(WikiError::message("Documentation search snapshot has a missing line slice"));
		}
		self.sections.push_back(PendingSection {
			start:   section.byte_start,
			end:     section.byte_end,
			ranked:  RankedSection {
				section_id: section.section_id,
				shape,
				match_kind: MatchKind::Regex,
				rank: 0.0,
			},
			matched: false,
		});
		if section.byte_end > self.end {
			let offset = (self.end - section.byte_start) as usize;
			let suffix = section
				.raw_markdown
				.get(offset..)
				.ok_or_else(|| WikiError::message("Documentation search snapshot is inconsistent"))?;
			for (position, byte) in suffix.bytes().enumerate() {
				if byte == b'\n' {
					self.newlines.push_back(self.end + position as i64 + 1);
				}
			}
			self.text.push_str(suffix);
			self.end = section.byte_end;
		}
		Ok(())
	}

	fn flush(
		&mut self,
		safe_end: i64,
		finish: bool,
		matcher: &CompiledMatcher,
		check: Check<'_>,
	) -> CoreResult<()> {
		let mut consumed = 0;
		while let Some(end) = self
			.newlines
			.front()
			.copied()
			.filter(|end| finish || *end <= safe_end)
		{
			check()?;
			self.newlines.pop_front();
			let until = (end - self.start) as usize;
			// Existing line grep uses LF terminators, retaining CR in CRLF lines.
			self.match_line(consumed, until - 1, matcher, check)?;
			consumed = until;
			self.retire(end);
		}
		if finish && consumed < self.text.len() {
			check()?;
			self.match_line(consumed, self.text.len(), matcher, check)?;
			consumed = self.text.len();
		}
		if consumed != 0 {
			self.text.drain(..consumed);
			self.start += consumed as i64;
		}
		if finish {
			self.retire(i64::MAX);
		}
		Ok(())
	}

	fn match_line(
		&mut self,
		from: usize,
		until: usize,
		matcher: &CompiledMatcher,
		check: Check<'_>,
	) -> CoreResult<()> {
		let line = &self.text[from..until];
		let mut at = 0;
		let mut previous_end = None;
		let mut section_at = 0;
		loop {
			check()?;
			let found = matcher.find_at(line.as_bytes(), at).map_err(|error| {
				WikiError::message(format!("Documentation grep regex error: {error}"))
			})?;
			let Some(found) = found else { break };
			// Suppress an empty match immediately following the previous match.
			// Advance on UTF-8 boundaries so PCRE2 never sees a bad UTF offset.
			if found.is_empty() && previous_end == Some(found.end()) {
				if found.end() == line.len() {
					break;
				}
				at = line.ceil_char_boundary(found.end() + 1);
				continue;
			}
			let start = self.start + from as i64 + found.start() as i64;
			let end = self.start + from as i64 + found.end() as i64;
			// Matches and section starts are ordered. Advance past matched or
			// expired sections, leaving only the first future section for the
			// next match. Reset this cursor per line: an unmatched section may
			// still contain a match on a later line.
			while let Some(section) = self.sections.get_mut(section_at) {
				check()?;
				if section.start > end || (start != end && section.start == end) {
					break;
				}
				// Empty matches include both endpoints, including shared edges.
				if section.end > start || (start == end && section.end == start) {
					section.matched = true;
				}
				section_at += 1;
			}
			previous_end = Some(found.end());
			if found.is_empty() {
				if found.end() == line.len() {
					break;
				}
				at = line.ceil_char_boundary(found.end() + 1);
			} else {
				at = found.end();
			}
		}
		Ok(())
	}

	fn retire(&mut self, end: i64) {
		while self
			.sections
			.front()
			.is_some_and(|section| section.end <= end)
		{
			let section = self.sections.pop_front().expect("pending section");
			if section.matched {
				self.ranked.push(section.ranked);
			}
		}
	}
}

pub(super) fn scan(
	connection: &Connection,
	matcher: &CompiledMatcher,
	index: Option<&str>,
	check: Check<'_>,
) -> CoreResult<Vec<RankedSection>> {
	let mut statement = connection.prepare_cached(
		"SELECT s.id,s.document_id,s.byte_start,s.byte_end,s.raw_markdown FROM sections s JOIN \
		 doc_indexes i ON i.id=s.index_id WHERE i.name NOT GLOB '__building__*' AND (? IS NULL OR \
		 i.name=?) ORDER BY s.index_id,s.document_id,s.ordinal,s.id",
	)?;
	let index = index.map(super::storage::sqlite_text);
	let mut rows = statement.query(rusqlite::params![index, index])?;
	let mut lines = Lines::default();
	let mut previous: Option<ContextSection> = None;
	let mut scanner = SectionContextScanner::default();
	while let Some(row) = rows.next()? {
		check()?;
		let mut section = ContextSection {
			section_id:   row.get(0)?,
			document_id:  row.get(1)?,
			byte_start:   row.get(2)?,
			byte_end:     row.get(3)?,
			raw_markdown: row.get(4)?,
		};
		// Legacy writers projected away the document-leading UTF-8 BOM but
		// kept its byte range. Restore only that first-section three-byte
		// deficit; all other range mismatches still fail in Lines::append.
		if section.byte_start == 0
			&& section.byte_end == section.raw_markdown.len() as i64 + 3
			&& !section.raw_markdown.starts_with('\u{feff}')
		{
			section.raw_markdown.insert(0, '\u{feff}');
		}
		// Converter-only headings are intentionally absent from both new and
		// existing indexes. Finish each stored run independently: omitted bytes
		// are neither evidence nor a bridge between original lines.
		let same_run = previous.as_ref().is_some_and(|previous| {
			let overlaps_stored_bytes = section.byte_start <= previous.byte_end;
			previous.document_id == section.document_id && overlaps_stored_bytes
		});
		lines.flush(section.byte_start, !same_run, matcher, check)?;
		if !same_run {
			previous = None;
		}
		let context = scanner.lex_context(
			previous.as_ref().map(ContextSectionRef::from),
			ContextSectionRef::from(&section),
		);
		let shape = if context.fence_prefix.is_none() && !context.continues_line {
			super::markdown::section_shape(&section.raw_markdown)
		} else {
			context.shape
		};
		lines.append(&section, shape)?;
		previous = Some(section);
	}
	lines.flush(i64::MAX, true, matcher, check)?;
	check()?;
	Ok(lines.ranked)
}
