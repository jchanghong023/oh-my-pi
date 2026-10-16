//! Query-time projections of the shared default Markdown lexer.

use std::{
	collections::{HashMap, VecDeque},
	sync::{Arc, LazyLock},
};

use regex::Regex;

use super::query::{ContextEdge, SectionContext, Shape, literal_edge_starter};

mod block;
mod closers;
mod inline;
mod text;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum TokenKind {
	#[default]
	Text,
	Escape,
	Codespan,
	Heading,
	Paragraph,
	Blockquote,
	Code,
	Html,
	List,
	Table,
	Space,
	Hr,
	Br,
	Def,
	Em,
	Strong,
	Del,
	Link,
	Image,
	Checkbox,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Token {
	pub kind:     TokenKind,
	pub raw:      String,
	pub text:     String,
	pub children: Option<Vec<Self>>,
	pub items:    Vec<Vec<Self>>,
	/// Header first, followed by body rows; each cell contains inline tokens.
	pub rows:     Vec<Vec<Vec<Self>>>,
}

pub(crate) type Links = HashMap<String, String>;

pub(super) const fn is_js_whitespace(character: char) -> bool {
	super::query::is_ecmascript_whitespace(character)
}

pub(super) fn trim_js(source: &str) -> &str {
	source.trim_matches(is_js_whitespace)
}

pub(super) fn js_regex(pattern: &str) -> Regex {
	// Rust's Unicode whitespace includes U+0085 and excludes the BOM.
	let whitespace = r"[\x09-\x0d\x20\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
	let non_whitespace = r"[^\x09-\x0d\x20\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
	Regex::new(
		&pattern
			.replace(r"\s", whitespace)
			.replace(r"\S", non_whitespace),
	)
	.expect("shared Markdown regular expression")
}
pub(super) fn list_end<'a>(
	line: impl Fn(usize) -> &'a str,
	length: usize,
	index: usize,
) -> Option<usize> {
	block::list_end(line, length, index)
}

pub(crate) fn lex_section(markdown: &str, context: &SectionContext) -> Vec<Token> {
	let source = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
	if context.fence_prefix.is_none() && !context.continues_line {
		return block::lex(source);
	}
	let mut reconstructed = String::with_capacity(
		source.len() + context.fence_prefix.as_ref().map_or(0, |p| p.len() + 1) + 4,
	);
	if let Some(prefix) = &context.fence_prefix {
		reconstructed.push_str(prefix);
		reconstructed.push('\n');
	}
	if context.continues_line {
		if let Some(prefix) = context.fence_prefix.as_ref()
			&& let Some(marker) = prefix.find(['`', '~'])
		{
			reconstructed.extend(prefix[..marker].chars().map(|character| {
				if matches!(character, '>' | ' ' | '\t') {
					character
				} else {
					' '
				}
			}));
		}
		reconstructed.push_str("    ");
	}
	reconstructed.push_str(source);
	block::lex(&reconstructed)
}

fn render(tokens: &[Token], names: bool, output: &mut String) {
	for token in tokens {
		match token.kind {
			TokenKind::Table => {
				for (row_index, row) in token.rows.iter().enumerate() {
					if row_index != 0 {
						output.push('\n');
					}
					for (cell_index, cell) in row.iter().enumerate() {
						if cell_index != 0 {
							output.push(' ');
						}
						render(cell, names, output);
					}
				}
			},
			TokenKind::List => {
				for (index, item) in token.items.iter().enumerate() {
					if index != 0 {
						output.push('\n');
					}
					render(item, names, output);
				}
			},
			TokenKind::Space | TokenKind::Hr | TokenKind::Br => output.push('\n'),
			TokenKind::Def => {},
			_ => {
				let block_boundary = matches!(
					token.kind,
					TokenKind::Heading | TokenKind::Paragraph | TokenKind::Blockquote | TokenKind::Code
				);
				let name_boundary = names && (block_boundary || token.kind == TokenKind::Codespan);
				if name_boundary {
					output.push('\n');
				}
				if let Some(children) = &token.children {
					render(children, names, output);
				} else {
					output.push_str(&token.text);
				}
				if block_boundary || name_boundary {
					output.push('\n');
				}
			},
		}
	}
}

pub(crate) fn plain_text(tokens: &[Token]) -> String {
	let mut rendered = String::new();
	render(tokens, false, &mut rendered);
	let mut output = String::with_capacity(rendered.len());
	let mut in_space = false;
	for character in trim_js(&rendered).chars() {
		if matches!(character, ' ' | '\t') {
			if !in_space {
				output.push(' ');
			}
			in_space = true;
		} else {
			output.push(character);
			in_space = false;
		}
	}
	output
}

/// The caller applies search normalization after preserving literal-code
/// boundaries.
pub(crate) fn name_text(tokens: &[Token]) -> String {
	let mut output = String::new();
	render(tokens, true, &mut output);
	output
}

pub(crate) fn local_title(markdown: &str, context: &SectionContext) -> String {
	if context.fence_prefix.is_some() || context.continues_line {
		return String::new();
	}
	static ATX: LazyLock<Regex> =
		LazyLock::new(|| js_regex(r"^ {0,3}#{1,6}\s+([^\r\n\u{2028}\u{2029}]+)"));
	static TEXT: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^ {0,3}\S"));
	static SETEXT: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^ {0,3}(?:=+|-+)\s*\z"));
	let source = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
	let mut lines = source.splitn(3, '\n');
	let first = lines.next().unwrap_or("");
	let second = lines.next().unwrap_or("");
	let heading = ATX
		.captures(first)
		.and_then(|captures| captures.get(1))
		.map_or_else(
			|| {
				if TEXT.is_match(first) && SETEXT.is_match(second) {
					first
				} else {
					""
				}
			},
			|matched| matched.as_str(),
		);
	if heading.is_empty() {
		String::new()
	} else {
		plain_text(&block::lex(heading))
	}
}

// JS multiline anchors also recognize CR, U+2028 and U+2029. The `end` capture
// is an assertion emulation: preserve it rather than swallowing a line ending.
fn strip_js_lines(source: &str, pattern: &Regex) -> String {
	let mut output = String::with_capacity(source.len());
	let mut copied = 0;
	let mut boundary = true;
	for (position, character) in source.char_indices() {
		if boundary
			&& position >= copied
			&& let Some(captures) = pattern.captures(&source[position..])
		{
			let matched = captures.get(0).expect("whole match");
			let end = captures
				.name("end")
				.map_or_else(|| matched.end(), |end| end.start());
			output.push_str(&source[copied..position]);
			copied = position + end;
		}
		boundary = matches!(character, '\r' | '\n' | '\u{2028}' | '\u{2029}');
	}
	output.push_str(&source[copied..]);
	output
}

pub(crate) fn section_shape(markdown: &str) -> Shape {
	static PAIR: LazyLock<Regex> = LazyLock::new(|| {
		js_regex(r"^ {0,3}\S[^\n]*\n {0,3}(?:=+|-+)[ \t]*\r?(?P<end>\z|[\r\n\u{2028}\u{2029}])")
	});
	static HEADING: LazyLock<Regex> =
		LazyLock::new(|| js_regex(r"^ {0,3}#{1,6}[ \t][^\r\n\u{2028}\u{2029}]*"));
	static UNDERLINE: LazyLock<Regex> =
		LazyLock::new(|| js_regex(r"^ {0,3}(?:=+|-+)[ \t]*\r?(?P<end>\z|[\r\n\u{2028}\u{2029}])"));
	static MARKER: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^ {0,3}#{1,6}[ \t]?"));
	let source = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
	let body = strip_js_lines(&strip_js_lines(&strip_js_lines(source, &PAIR), &HEADING), &UNDERLINE);
	if !trim_js(&body).is_empty() {
		return Shape::Content;
	}
	let heading = strip_js_lines(&strip_js_lines(source, &MARKER), &UNDERLINE);
	let heading = trim_js(&heading);
	if heading.is_empty()
		|| heading.eq_ignore_ascii_case("cell")
		|| heading.eq_ignore_ascii_case("row")
	{
		Shape::Stub
	} else {
		Shape::HeadingOnly
	}
}

pub(crate) struct ContextSection {
	pub section_id:   i64,
	pub document_id:  i64,
	pub byte_start:   i64,
	pub byte_end:     i64,
	pub raw_markdown: String,
}

#[derive(Clone, Copy)]
struct Fence {
	marker:      char,
	length:      usize,
	quote_depth: usize,
	list_depth:  usize,
}

struct ListContext {
	quote_depth: usize,
	indentation: usize,
	width:       usize,
	prefix:      String,
}

#[derive(Default)]
struct MarkdownFenceScanner {
	fence:           Option<Fence>,
	lists:           Vec<ListContext>,
	line_buffer:     String,
	continues_line:  bool,
	spaces:          usize,
	quote_depth:     usize,
	after_quote:     bool,
	matched:         Option<Fence>,
	trailing:        u8,
	in_info:         bool,
	invalid:         bool,
	carriage_return: bool,
}

// Match the shared lexer's tab expansion only when needed. Reuse one buffer
// across source slices; ordinary lines remain borrowed.
fn scanner_line<'a>(source: &'a str, buffer: &'a mut String) -> &'a str {
	if !source.contains('\t') {
		return source;
	}
	buffer.clear();
	for character in source.chars() {
		if character == '\t' {
			buffer.push_str("    ");
		} else {
			buffer.push(character);
		}
	}
	buffer
}

impl MarkdownFenceScanner {
	fn end_lists_before(&mut self, source: &str) {
		if self.continues_line || self.lists.is_empty() {
			return;
		}
		let mut lines = source.split_inclusive('\n');
		let mut buffer = std::mem::take(&mut self.line_buffer);
		let mut line = scanner_line(lines.next().unwrap_or(""), &mut buffer);
		let next = lines.next();
		let mut quote_depth = 0;
		let mut list_depth = 0;
		while let Some(list) = self.lists.get(list_depth) {
			if list.quote_depth == quote_depth {
				if !block::list_line_continues(line, next, list.indentation) {
					break;
				}
				let indentation = line.bytes().take_while(|byte| *byte == b' ').count();
				line = &line[indentation.min(list.width)..];
				list_depth += 1;
			} else if let Some(length) = block::quote_prefix(line) {
				line = &line[length..];
				quote_depth += 1;
			} else {
				break;
			}
		}
		self.lists.truncate(list_depth);
		if self
			.fence
			.is_some_and(|fence| fence.list_depth > list_depth)
		{
			self.fence = None;
		}
		self.line_buffer = buffer;
	}

	fn append(&mut self, source: &str) {
		let mut buffer = std::mem::take(&mut self.line_buffer);
		let mut lines = source.split_inclusive('\n').peekable();
		while let Some(source_line) = lines.next() {
			let mut line = if self.continues_line {
				source_line
			} else {
				scanner_line(source_line, &mut buffer)
			};
			if !self.continues_line {
				let mut quote_depth = 0;
				let mut list_depth = 0;
				loop {
					if let Some(list) = self.lists.get(list_depth)
						&& list.quote_depth == quote_depth
					{
						if block::list_line_continues(line, lines.peek().copied(), list.indentation) {
							let indentation = line.bytes().take_while(|byte| *byte == b' ').count();
							line = &line[indentation.min(list.width)..];
							list_depth += 1;
							continue;
						}
						self.lists.truncate(list_depth);
					}
					if self
						.fence
						.is_some_and(|fence| fence.list_depth > self.lists.len())
					{
						self.fence = None;
					}
					if self
						.fence
						.is_none_or(|fence| quote_depth < fence.quote_depth)
						&& let Some(length) = block::quote_prefix(line)
					{
						self.append_raw(&line[..length]);
						line = &line[length..];
						quote_depth += 1;
						continue;
					}
					if self.lists.len() > list_depth {
						self.lists.truncate(list_depth);
						if self
							.fence
							.is_some_and(|fence| fence.list_depth > list_depth)
						{
							self.fence = None;
						}
					}
					if self.fence.is_none()
						&& let Some((indentation, width, end)) = block::list_prefix(line)
					{
						let mut prefix = String::with_capacity(width);
						prefix.push_str(&line[..width - 1]);
						prefix.push(' ');
						self
							.lists
							.push(ListContext { quote_depth, indentation, width, prefix });
						line = &line[end..];
						list_depth += 1;
						continue;
					}
					break;
				}
			}
			self.append_raw(line);
		}
		self.line_buffer = buffer;
	}

	fn append_raw(&mut self, source: &str) {
		let mut line_start = (!self.continues_line).then_some(0);
		for (position, character) in source.char_indices() {
			if character == '\n' {
				if self
					.fence
					.is_some_and(|fence| self.quote_depth < fence.quote_depth)
				{
					let blank = !self.invalid && self.matched.is_none();
					// Missing quote markers may be lazy paragraph continuation.
					// Use the shared lexer for actual block interruptions instead of
					// treating every unquoted line as an end to the container.
					let interrupted = self.invalid
						&& line_start.is_some_and(|start| {
							let tokens = block::lex(&source[start..=position]);
							let mut children = tokens.as_slice();
							for _ in 0..self.quote_depth {
								children = children
									.first()
									.and_then(|token| token.children.as_deref())
									.unwrap_or(&[]);
							}
							children.first().is_some_and(|token| {
								!matches!(token.kind, TokenKind::Paragraph | TokenKind::Text)
							})
						});
					if blank || interrupted {
						self.fence = None;
					}
				}
				if !self.invalid
					&& let Some(matched) = self.matched.filter(|matched| matched.length >= 3)
				{
					self.fence = match self.fence {
						None if matched.marker != '`' || self.trailing != 2 => Some(matched),
						Some(fence) if matched.quote_depth < fence.quote_depth => {
							(matched.marker != '`' || self.trailing != 2).then_some(matched)
						},
						Some(fence)
							if fence.marker == matched.marker
								&& matched.length >= fence.length
								&& matched.quote_depth == fence.quote_depth
								&& self.trailing == 0 =>
						{
							None
						},
						fence => fence,
					};
				}
				self.continues_line = false;
				self.spaces = 0;
				self.quote_depth = 0;
				self.after_quote = false;
				self.matched = None;
				self.trailing = 0;
				self.in_info = false;
				self.invalid = false;
				self.carriage_return = false;
				line_start = Some(position + 1);
				continue;
			}
			self.continues_line = true;
			if self.invalid {
				continue;
			}
			if self.carriage_return {
				self.invalid = true;
				continue;
			}
			if character == '\r' {
				self.carriage_return = true;
			} else if let Some(matched) = &mut self.matched {
				if !self.in_info && character == matched.marker {
					matched.length += 1;
				} else {
					self.in_info = true;
					if character == '`' {
						self.trailing = 2;
					} else if character != ' ' && character != '\t' && self.trailing == 0 {
						self.trailing = 1;
					}
				}
			} else if self.after_quote && character == ' ' {
				self.after_quote = false;
			} else if self.after_quote && character == '\t' {
				// The shared lexer expands tabs to four spaces before stripping
				// the one optional space following a quote marker.
				self.after_quote = false;
				self.spaces = 3;
			} else if character == ' ' && self.spaces < 3 {
				self.after_quote = false;
				self.spaces += 1;
			} else if character == '>'
				&& self
					.fence
					.is_none_or(|fence| self.quote_depth < fence.quote_depth)
			{
				// Match the shared lexer's recursively stripped blockquote markers,
				// but never interpret a marker inside an already-open code block.
				self.quote_depth += 1;
				self.spaces = 0;
				self.after_quote = true;
			} else if character == '`' || character == '~' {
				self.matched = Some(Fence {
					marker:      character,
					length:      1,
					quote_depth: self.quote_depth,
					list_depth:  self.lists.len(),
				});
			} else {
				self.invalid = true;
			}
		}
	}
}

fn buffer_slice(source: &str, start: i64, end: i64) -> std::borrow::Cow<'_, str> {
	// Buffer.subarray clamps offsets, treating negatives relative to byte
	// length.
	let bytes = source.as_bytes();
	let offset = |offset: i64| -> usize {
		if offset < 0 {
			(bytes.len() as i64 + offset).clamp(0, bytes.len() as i64) as usize
		} else {
			offset.min(bytes.len() as i64) as usize
		}
	};
	let start = offset(start);
	let end = offset(end).max(start);
	String::from_utf8_lossy(&bytes[start..end])
}

/// Borrowed stored-source coordinates let migrations retain only the previous,
/// current and next SQLite row, rather than copying the raw corpus.
#[derive(Clone, Copy)]
pub(crate) struct ContextSectionRef<'a> {
	pub document_id:  i64,
	pub byte_start:   i64,
	pub byte_end:     i64,
	pub raw_markdown: &'a str,
}

impl<'a> From<&'a ContextSection> for ContextSectionRef<'a> {
	fn from(section: &'a ContextSection) -> Self {
		Self {
			document_id:  section.document_id,
			byte_start:   section.byte_start,
			byte_end:     section.byte_end,
			raw_markdown: &section.raw_markdown,
		}
	}
}

#[derive(Default)]
pub(crate) struct SectionContextScanner {
	scanner: MarkdownFenceScanner,
}

impl SectionContextScanner {
	/// FTS reconstruction needs only lexer state, not query edge/shape work.
	pub(crate) fn lex_context(
		&mut self,
		previous: Option<ContextSectionRef<'_>>,
		section: ContextSectionRef<'_>,
	) -> SectionContext {
		if let Some(previous) =
			previous.filter(|previous| previous.document_id == section.document_id)
		{
			let source = if section.byte_start < previous.byte_end {
				buffer_slice(previous.raw_markdown, 0, section.byte_start - previous.byte_start)
			} else {
				std::borrow::Cow::Borrowed(previous.raw_markdown)
			};
			self.scanner.append(if previous.byte_start == 0 {
				source.strip_prefix('\u{feff}').unwrap_or(&source)
			} else {
				&source
			});
		} else {
			self.scanner = MarkdownFenceScanner::default();
		}
		self.scanner.end_lists_before(section.raw_markdown);
		SectionContext {
			shape:          Shape::Content,
			fence_prefix:   self.scanner.fence.map(|fence| {
				let mut prefix = String::new();
				let mut quote_depth = 0;
				for list in self.scanner.lists.iter().take(fence.list_depth) {
					prefix.push_str(&"> ".repeat(list.quote_depth - quote_depth));
					prefix.push_str(&list.prefix);
					quote_depth = list.quote_depth;
				}
				prefix.push_str(&"> ".repeat(fence.quote_depth - quote_depth));
				prefix.extend(std::iter::repeat_n(fence.marker, fence.length));
				prefix
			}),
			continues_line: self.scanner.continues_line,
			before:         ContextEdge::default(),
			after:          ContextEdge::default(),
		}
	}
}

/// Assign complete normalization edges in two linear passes, retaining only
/// two preceding and three following starter positions rather than a per-scalar
/// index. The document source is shared, never copied once per section.
fn attach_edges(source: String, start: i64, contexts: &mut [(i64, i64, i64, SectionContext)]) {
	if contexts.is_empty() {
		return;
	}
	let source: Arc<str> = Arc::from(source);
	let mut preceding = source
		.char_indices()
		.filter(|&(_, ch)| literal_edge_starter(ch))
		.peekable();
	let mut following = source
		.char_indices()
		.filter(|&(_, ch)| literal_edge_starter(ch));
	let mut previous = [0; 2];
	let mut upcoming = VecDeque::with_capacity(3);
	for (_, byte_start, byte_end, context) in contexts {
		let left = (*byte_start - start).clamp(0, source.len() as i64) as usize;
		let right = (*byte_end - start).clamp(left as i64, source.len() as i64) as usize;
		while let Some(&(position, _)) = preceding.peek()
			&& position < left
		{
			previous = [previous[1], position];
			preceding.next();
		}
		context.before = ContextEdge::shared(&source, previous[0]..left);
		loop {
			while upcoming.len() < 3 {
				let Some((position, _)) = following.next() else {
					break;
				};
				upcoming.push_back(position);
			}
			if upcoming.front().is_some_and(|&position| position < right) {
				upcoming.pop_front();
			} else {
				break;
			}
		}
		let end = upcoming.get(2).copied().unwrap_or(source.len());
		context.after = ContextEdge::shared(&source, right..end);
	}
}

pub(crate) fn contexts(
	sections: impl IntoIterator<Item = ContextSection>,
) -> Vec<(i64, SectionContext)> {
	let mut previous: Option<ContextSection> = None;
	let mut scanner = SectionContextScanner::default();
	let mut output = Vec::new();
	let mut edges = Vec::new();
	let mut source = String::new();
	let mut source_start = 0;
	for section in sections {
		// Gaps and document boundaries must not invent source adjacency.
		if previous.as_ref().is_none_or(|previous| {
			previous.document_id != section.document_id
				|| section.byte_start < source_start
				|| section.byte_start > source_start + source.len() as i64
		}) {
			attach_edges(std::mem::take(&mut source), source_start, &mut edges);
			output.extend(
				std::mem::take(&mut edges)
					.into_iter()
					.map(|(id, _, _, context)| (id, context)),
			);
			source_start = section.byte_start;
		}
		let mut context = scanner.lex_context(
			previous.as_ref().map(ContextSectionRef::from),
			ContextSectionRef::from(&section),
		);
		if context.fence_prefix.is_none() && !context.continues_line {
			context.shape = section_shape(&section.raw_markdown);
		}
		let overlap = (source_start + source.len() as i64 - section.byte_start).max(0);
		source.push_str(&buffer_slice(
			&section.raw_markdown,
			overlap,
			section.raw_markdown.len() as i64,
		));
		edges.push((section.section_id, section.byte_start, section.byte_end, context));
		previous = Some(section);
	}
	attach_edges(source, source_start, &mut edges);
	output.extend(edges.into_iter().map(|(id, _, _, context)| (id, context)));
	output
}

#[cfg(test)]
mod tests {
	use super::*;

	fn context() -> SectionContext {
		SectionContext {
			shape:          Shape::Content,
			fence_prefix:   None,
			continues_line: false,
			before:         ContextEdge::default(),
			after:          ContextEdge::default(),
		}
	}

	fn section(id: i64, start: i64, end: i64, raw: &str) -> ContextSection {
		ContextSection {
			section_id:   id,
			document_id:  1,
			byte_start:   start,
			byte_end:     end,
			raw_markdown: raw.to_owned(),
		}
	}

	#[test]
	fn shape_preserves_converter_and_literal_code_distinctions() {
		assert_eq!(section_shape("\u{feff}#### Cell\r\n"), Shape::Stub);
		assert_eq!(section_shape("Row\n---\n"), Shape::Stub);
		assert_eq!(section_shape("# ATPG\n"), Shape::HeadingOnly);
		assert_eq!(section_shape("要求检查\n===\n"), Shape::HeadingOnly);
		assert_eq!(section_shape("    # Cell\n"), Shape::Content);
		assert_eq!(section_shape("\t# Cell\n"), Shape::Content);
		assert_eq!(section_shape("# Cell\u{2028}body"), Shape::Content);
		assert_eq!(section_shape("# Cell\u{0085}"), Shape::HeadingOnly);
	}

	#[test]
	fn local_title_is_local_and_obeys_default_lexer() {
		assert_eq!(local_title("\u{feff}# **check** `C++`\nbody", &context()), "check C++");
		assert_eq!(local_title("check `C++`\n---\nbody", &context()), "check C++");
		assert_eq!(local_title("    # check\n", &context()), "");
		let mut continued = context();
		continued.continues_line = true;
		assert_eq!(local_title("# check\n", &continued), "");
		continued.continues_line = false;
		continued.fence_prefix = Some("```".to_owned());
		assert_eq!(local_title("# check\n", &continued), "");
	}

	#[test]
	fn literal_code_preserves_punctuation_and_name_boundaries() {
		let tokens = lex_section("a`C++`17\n\n```cpp\nx->y::z()\n```\n", &context());
		assert_eq!(plain_text(&tokens), "aC++17\n\nx->y::z()");
		assert!(name_text(&tokens).contains("a\nC++\n17"));
		assert!(name_text(&tokens).contains("x->y::z()"));
	}

	#[test]
	fn fence_scanner_carries_partial_crlf_and_ignores_overlap() {
		let rows = [
			section(1, 0, 7, "\u{feff}```\r"),
			section(2, 7, 11, "\nx\r\n"),
			section(3, 11, 13, "# "),
		];
		let recovered = contexts(rows);
		assert!(recovered[1].1.continues_line);
		assert_eq!(recovered[1].1.fence_prefix, None);
		assert_eq!(recovered[2].1.fence_prefix.as_deref(), Some("```"));
		assert!(!recovered[2].1.continues_line);

		let overlap = contexts([section(1, 0, 8, "abc```x\n"), section(2, 3, 9, "```x\nz")]);
		assert!(overlap[1].1.continues_line);
		assert_eq!(overlap[1].1.fence_prefix, None);
		assert_eq!(plain_text(&lex_section("```x\nz", &overlap[1].1)), "```x\n\nz");
	}

	#[test]
	fn character_split_fences_agree_with_whole_line_context() {
		let source = "\u{feff}   ````python\r\nbody\r\n   ````\t \r\n~~~~`info`\nbody\n~~~~\n    \
		              ```bad\nbody\n```bad`info\nbody\n```info\rinside\nbody\n```valid\nbody\n```\n";
		// Independent whole-line oracle from endingMarkdownFence, not another
		// instance of the incremental scanner under test.
		let delimiter = Regex::new(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)$").unwrap();
		let whole_line_fence = |prefix: &str| {
			let mut fence: Option<Fence> = None;
			for line in prefix.split('\n') {
				let line = line.strip_suffix('\r').unwrap_or(line);
				let Some(matched) = delimiter.captures(line) else {
					continue;
				};
				let run = matched.get(1).unwrap().as_str();
				let marker = run.chars().next().unwrap();
				let trailing = matched.get(2).unwrap().as_str();
				fence = match fence {
					None if marker != '`' || !trailing.contains('`') => {
						Some(Fence { marker, length: run.len(), quote_depth: 0, list_depth: 0 })
					},
					Some(active)
						if active.marker == marker
							&& run.len() >= active.length
							&& trailing
								.chars()
								.all(|character| matches!(character, ' ' | '\t')) =>
					{
						None
					},
					fence => fence,
				};
			}
			fence.map(|fence| std::iter::repeat_n(fence.marker, fence.length).collect::<String>())
		};
		let mut sections = source
			.char_indices()
			.map(|(start, character)| ContextSectionRef {
				document_id:  1,
				byte_start:   start as i64,
				byte_end:     (start + character.len_utf8()) as i64,
				raw_markdown: &source[start..start + character.len_utf8()],
			})
			.peekable();
		let mut scanner = SectionContextScanner::default();
		let mut previous = None;
		while let Some(section) = sections.next() {
			let context = scanner.lex_context(previous, section);
			let prefix = source[..section.byte_start as usize]
				.strip_prefix('\u{feff}')
				.unwrap_or(&source[..section.byte_start as usize]);
			let line_end = prefix.rfind('\n').map_or(0, |position| position + 1);
			assert_eq!(context.fence_prefix, whole_line_fence(&prefix[..line_end]));
			assert_eq!(context.continues_line, prefix.len() > line_end);
			previous = Some(section);
		}
	}

	#[test]
	fn long_overlapping_line_retains_fence_and_resets_between_documents() {
		const CHUNK_COUNT: usize = 8192;
		let chunk = "x".repeat(18_000);
		let mut byte_start = 0i64;
		// Every long section borrows the same chunk. Only the three-row window
		// and the scalar scanner state survive each iteration.
		let mut sections = (0..CHUNK_COUNT + 6)
			.map(|index| {
				let (document_id, raw_markdown, advance) = match index {
					0 => (1, "```python\n", 10),
					1..=CHUNK_COUNT => {
						(1, chunk.as_str(), if index == CHUNK_COUNT { 18_000 } else { 17_500 })
					},
					index if index == CHUNK_COUNT + 1 => (1, "```\n", 4),
					index if index == CHUNK_COUNT + 2 => (1, "# Row\n", 6),
					index if index == CHUNK_COUNT + 3 => (1, "```\n", 4),
					index if index == CHUNK_COUNT + 4 => (1, "## ATPG\n", 8),
					_ => {
						byte_start = 0;
						(2, "## Next\n", 8)
					},
				};
				let section = ContextSectionRef {
					document_id,
					byte_start,
					byte_end: byte_start + raw_markdown.len() as i64,
					raw_markdown,
				};
				byte_start += advance;
				section
			})
			.peekable();
		let mut scanner = SectionContextScanner::default();
		let mut previous = None;
		let mut headings = Vec::new();
		let mut count = 0;
		while let Some(section) = sections.next() {
			let context = scanner.lex_context(previous, section);
			count += 1;
			if section.raw_markdown.starts_with('#') {
				headings.push((section.raw_markdown, context.fence_prefix, context.continues_line));
			}
			previous = Some(section);
		}
		assert_eq!(count, CHUNK_COUNT + 6);
		assert_eq!(headings, [
			("# Row\n", Some("```".to_owned()), false),
			("## ATPG\n", None, false),
			("## Next\n", None, false),
		]);
	}

	#[test]
	fn adjacent_context_preserves_utf8_and_complete_normalization_sequences() {
		let contexts = contexts([section(1, 0, 8, "a😀中"), section(2, 5, 10, "中bc")]);
		assert_eq!(&*contexts[1].1.before, "a😀");
		assert_eq!(&*contexts[0].1.after, "bc");
		assert_eq!(buffer_slice("😀x", 1, 5), "\u{fffd}\u{fffd}\u{fffd}x");
	}

	#[test]
	fn complete_edge_sequences_prevent_exact_names_created_by_chunking() {
		use super::super::query::{LiteralMatcher, normalize_search_text};

		let marks = "\u{0334}".repeat(128);
		let right = format!("scan{marks}\u{0303}");
		let left = format!("a{marks}\u{0303}scan");
		for (source, edge, query) in [
			(right.as_str(), 4, "scan"),
			(left.as_str(), 1 + marks.len(), "\u{0303}scan"),
			("\u{1100}\u{1161}\u{11a8}", 3, "\u{1100}"),
			("\u{1100}\u{1161}\u{11a8}", 6, "\u{11a8}"),
			("\u{3131}\u{314f}", 3, "\u{1100}"),
		] {
			let rows = [
				section(1, 0, edge as i64, &source[..edge]),
				section(2, edge as i64, source.len() as i64, &source[edge..]),
			];
			let recovered =
				contexts(rows.iter().map(|row| {
					section(row.section_id, row.byte_start, row.byte_end, &row.raw_markdown)
				}));
			let matcher = LiteralMatcher::new(query, true);
			for (row, (_, context)) in rows.iter().zip(recovered) {
				assert!(
					!matcher.matches_section(
						&normalize_search_text(&name_text(&lex_section(&row.raw_markdown, &context))),
						&row.raw_markdown,
						&context,
					),
					"{source:?} at {edge}: {query:?}",
				);
			}
		}
	}

	#[test]
	fn left_edge_normalization_reaches_a_starter_more_than_one_section_away() {
		use super::super::query::{LiteralMatcher, normalize_search_text};

		let source = format!("a{}\u{0303}scan", "\u{0334}".repeat(36_000));
		let edges = [0, 24_001, 48_001, source.len()];
		let rows = edges.windows(2).enumerate().map(|(index, edge)| {
			section(index as i64, edge[0] as i64, edge[1] as i64, &source[edge[0]..edge[1]])
		});
		let recovered = contexts(rows);
		let body = &source[edges[2]..];
		let context = &recovered[2].1;
		assert!(!LiteralMatcher::new("\u{0303}scan", true).matches_section(
			&normalize_search_text(&name_text(&lex_section(body, context))),
			body,
			context,
		));
	}

	#[test]
	fn list_fences_do_not_split_code_headings_or_swallow_following_root_sections() {
		for newline in ["\n", "\r\n"] {
			let source = "# Guide\n\n- ```cpp\n  # not_a_heading\n  operator<< C++\n  ```\n\n# \
			              Real\nbody\n"
				.replace('\n', newline);
			let parsed = super::super::import::parse_markdown(source.as_bytes()).unwrap();
			assert_eq!(parsed.sections.len(), 2);
			assert_eq!(parsed.sections[0].heading_path, ["Guide"]);
			assert_eq!((parsed.sections[0].line_start, parsed.sections[0].line_end), (1, 7));
			assert_eq!(parsed.sections[1].heading_path, ["Real"]);
			assert_eq!((parsed.sections[1].line_start, parsed.sections[1].line_end), (8, 9));
			assert!(parsed.sections[0].plain_text.contains("operator<< C++"));
			assert_eq!(parsed.sections[1].raw_markdown, format!("# Real{newline}body{newline}"));
			for row in &parsed.sections {
				assert_eq!(row.raw_markdown, source[row.byte_start as usize..row.byte_end as usize],);
			}
		}
	}

	#[test]
	fn list_fence_context_survives_long_sections_and_long_line_overlaps() {
		for (opener, prefix) in [
			("- ```cpp", "  "),
			("1. ```cpp", "   "),
			("- ```cpp", "\t"),
			("1. ```cpp", "\t"),
			("> - ```cpp", ">   "),
			("> - ```cpp", ">\t"),
			("- > ```cpp", "  > "),
			("- - ```cpp", "    "),
		] {
			for long_line in [false, true] {
				let body = if long_line {
					format!(
						"{prefix}{} operator<< C++ [literal] {}\n",
						"x".repeat(17_970),
						"z".repeat(19_000)
					)
				} else {
					format!("{prefix}operator<< C++ [literal]\n").repeat(900)
				};
				let source = format!(
					"# Guide\n\n{opener}\n{body}{prefix}# not_a_heading\n{prefix}```\n\n# Real\nbody\n",
				);
				let parsed = super::super::import::parse_markdown(source.as_bytes()).unwrap();
				assert!(parsed.sections.len() > 2, "{opener}");
				let recovered = contexts(parsed.sections.iter().enumerate().map(|(index, row)| {
					section(index as i64, row.byte_start, row.byte_end, &row.raw_markdown)
				}));
				for (row, (_, context)) in parsed.sections.iter().zip(&recovered) {
					assert!(row.raw_markdown.encode_utf16().count() <= 18_000);
					assert_eq!(row.raw_markdown, source[row.byte_start as usize..row.byte_end as usize]);
					assert_eq!(row.plain_text, plain_text(&lex_section(&row.raw_markdown, context)));
					if row.raw_markdown.contains("# not_a_heading") {
						assert_eq!(context.shape, Shape::Content);
					}
					assert!(
						!row
							.heading_path
							.iter()
							.any(|heading| heading == "not_a_heading")
					);
				}
				assert!(
					parsed
						.sections
						.iter()
						.any(|row| row.plain_text.contains("operator<< C++ [literal]"))
				);
				let last = parsed.sections.last().unwrap();
				assert_eq!(last.heading_path, ["Real"]);
				assert_eq!(last.raw_markdown, "# Real\nbody\n");
				assert!(recovered.iter().skip(1).any(|(_, context)| {
					context.fence_prefix.as_deref() == Some(opener.trim_end_matches("cpp"))
				}));
			}
		}
	}

	#[test]
	fn unfinished_list_fences_end_with_their_container() {
		let source = "# Guide\n\n- ```cpp\n  operator<< C++\n\n# Real\nbody\n";
		let parsed = super::super::import::parse_markdown(source.as_bytes()).unwrap();
		assert_eq!(parsed.sections.len(), 2);
		assert_eq!(parsed.sections[1].heading_path, ["Real"]);
		assert_eq!(parsed.sections[1].raw_markdown, "# Real\nbody\n");
		assert_eq!(parsed.sections[1].plain_text, plain_text(&block::lex("# Real\nbody\n")));
	}
}
