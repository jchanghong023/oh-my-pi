//! Query-time projections of the shared default Markdown lexer.

use std::{collections::HashMap, sync::LazyLock};

use regex::Regex;

use super::query::{SectionContext, Shape};

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
	marker: char,
	length: usize,
}

#[derive(Default)]
struct MarkdownFenceScanner {
	fence:           Option<Fence>,
	continues_line:  bool,
	spaces:          usize,
	matched:         Option<Fence>,
	trailing:        u8,
	in_info:         bool,
	invalid:         bool,
	carriage_return: bool,
}

impl MarkdownFenceScanner {
	fn append(&mut self, source: &str) {
		for character in source.chars() {
			if character == '\n' {
				if !self.invalid
					&& let Some(matched) = self.matched.filter(|matched| matched.length >= 3)
				{
					self.fence = match self.fence {
						None if matched.marker != '`' || self.trailing != 2 => Some(matched),
						Some(fence)
							if fence.marker == matched.marker
								&& matched.length >= fence.length
								&& self.trailing == 0 =>
						{
							None
						},
						fence => fence,
					};
				}
				self.continues_line = false;
				self.spaces = 0;
				self.matched = None;
				self.trailing = 0;
				self.in_info = false;
				self.invalid = false;
				self.carriage_return = false;
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
			} else if character == ' ' && self.spaces < 3 {
				self.spaces += 1;
			} else if character == '`' || character == '~' {
				self.matched = Some(Fence { marker: character, length: 1 });
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

// The neighbor must contain bytes on the requested side of the edge, not the
// entire current section. Equality at the opposite boundary is intentional.
const fn contains_bytes_before_edge(neighbor: &ContextSection, edge: i64) -> bool {
	neighbor.byte_start < edge && neighbor.byte_end >= edge
}

const fn contains_bytes_after_edge(neighbor: &ContextSection, edge: i64) -> bool {
	neighbor.byte_start <= edge && neighbor.byte_end > edge
}

pub(crate) fn contexts(
	sections: impl IntoIterator<Item = ContextSection>,
) -> Vec<(i64, SectionContext)> {
	let mut rows = sections.into_iter();
	let mut previous: Option<ContextSection> = None;
	let mut current = rows.next();
	let mut scanner = MarkdownFenceScanner::default();
	let mut output = Vec::new();
	while let Some(section) = current {
		if let Some(previous) = previous
			.as_ref()
			.filter(|previous| previous.document_id == section.document_id)
		{
			let source = if section.byte_start < previous.byte_end {
				buffer_slice(&previous.raw_markdown, 0, section.byte_start - previous.byte_start)
			} else {
				std::borrow::Cow::Borrowed(previous.raw_markdown.as_str())
			};
			scanner.append(if previous.byte_start == 0 {
				source.strip_prefix('\u{feff}').unwrap_or(&source)
			} else {
				&source
			});
		} else {
			scanner = MarkdownFenceScanner::default();
		}
		let next = rows.next();
		let before = if let Some(previous) = previous
			.as_ref()
			.filter(|previous| contains_bytes_before_edge(previous, section.byte_start))
		{
			let offset = section.byte_start - previous.byte_start;
			let slice = buffer_slice(&previous.raw_markdown, (offset - 8).max(0), offset);
			let mut characters = slice.chars().rev();
			let last = characters.next();
			let penultimate = characters.next();
			let mut before = String::with_capacity(8);
			if let Some(character) = penultimate {
				before.push(character);
			}
			if let Some(character) = last {
				before.push(character);
			}
			before
		} else {
			String::new()
		};
		let after = if let Some(next) = next
			.as_ref()
			.filter(|next| contains_bytes_after_edge(next, section.byte_end))
		{
			let offset = section.byte_end - next.byte_start;
			buffer_slice(&next.raw_markdown, offset, offset + 8)
				.chars()
				.take(2)
				.collect()
		} else {
			String::new()
		};
		let fence_prefix = scanner
			.fence
			.map(|fence| std::iter::repeat_n(fence.marker, fence.length).collect());
		let shape = if fence_prefix.is_some() || scanner.continues_line {
			Shape::Content
		} else {
			section_shape(&section.raw_markdown)
		};
		output.push((section.section_id, SectionContext {
			shape,
			fence_prefix,
			continues_line: scanner.continues_line,
			before,
			after,
		}));
		previous = Some(section);
		current = next;
	}
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
			before:         String::new(),
			after:          String::new(),
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
	fn adjacent_context_uses_two_scalars_and_utf8_replacement() {
		let contexts = contexts([section(1, 0, 8, "a😀中"), section(2, 5, 10, "中bc")]);
		assert_eq!(contexts[1].1.before, "a😀");
		assert_eq!(contexts[0].1.after, "bc");
		assert_eq!(buffer_slice("😀x", 1, 5), "\u{fffd}\u{fffd}\u{fffd}x");
	}
}
