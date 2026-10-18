//! Direct port of marked/core.ts's default block rule order and inline queue.
use std::{borrow::Cow, collections::VecDeque, ops::Range, sync::LazyLock};

use regex::Regex;

use super::{Links, Token, TokenKind, inline, is_js_whitespace, js_regex, trim_js};

static HEADING_START: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^ {0,3}#{1,6}(?:\s|\z)"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| {
	js_regex(r"^ {0,3}(#{1,6})(?:[ \t]+|\z)([^\r\n\u{2028}\u{2029}]*?)(?:\n|\z)\z")
});
static HEADING_TAIL: LazyLock<Regex> = LazyLock::new(|| js_regex(r"[ \t]+#+[ \t]*\z"));
static HR: LazyLock<Regex> = LazyLock::new(|| {
	js_regex(r"^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})(?:\n|\z)\z")
});
static LIST: LazyLock<Regex> = LazyLock::new(|| {
	js_regex(
		r"^( {0,3})((?:[*+-])|(?:[0-9]{1,9}[.)]))(?:[ \t]+|(?P<empty>\n|\z))([^\r\n\u{2028}\u{2029}]*?)(?:\n|\z)\z",
	)
});
static QUOTE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^ {0,3}>[ \t]?"));
static DEFINITION_START: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^ {0,3}\[[^\]]+\]:"));
static DEFINITION: LazyLock<Regex> = LazyLock::new(|| {
	js_regex(
		r#"^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*(?:\n|\z)\z"#,
	)
});
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\s+"));
static SETEXT: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^ {0,3}(?:=+|-+)[ \t]*(?:\n|\z)\z"));
static TABLE_DELIMITER: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^:?-{1,}:?\z"));
static HTML: LazyLock<Regex> = LazyLock::new(|| {
	js_regex(
		r"^ {0,3}(?:<!--|<(?i-u:script|pre|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|/?>))",
	)
});
static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^ {0,3}<([A-Za-z][A-Za-z0-9_-]*)"));
static TASK: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^\[([ xX])\][ \t]+"));
static LOOSE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\n\s*\n"));

fn strip_newline(source: &str) -> &str {
	source.strip_suffix('\n').unwrap_or(source)
}
fn blank_line(source: &str) -> bool {
	source.ends_with('\n') && source.chars().all(is_js_whitespace)
}
fn blankish(source: &str) -> bool {
	source.chars().all(is_js_whitespace)
}
fn indent(source: &str) -> usize {
	source.bytes().take_while(|byte| *byte == b' ').count()
}
fn starts_whitespace(source: &str) -> bool {
	source.chars().next().is_some_and(is_js_whitespace)
}

fn fence(line: &str) -> Option<(char, usize)> {
	let line = strip_newline(line);
	let spaces = indent(line);
	if spaces > 3 {
		return None;
	}
	let rest = &line[spaces..];
	let marker = rest.chars().next()?;
	if marker != '`' && marker != '~' {
		return None;
	}
	let length = rest
		.bytes()
		.take_while(|byte| *byte == marker as u8)
		.count();
	if length < 3 || (marker == '`' && rest[length..].contains('`')) {
		return None;
	}
	Some((marker, length))
}
fn closes_fence(line: &str, marker: char, minimum: usize) -> bool {
	let line = strip_newline(line);
	let spaces = indent(line);
	if spaces > 3 {
		return false;
	}
	let rest = &line[spaces..];
	let length = rest
		.bytes()
		.take_while(|byte| *byte == marker as u8)
		.count();
	length >= minimum
		&& rest[length..]
			.bytes()
			.all(|byte| byte == b' ' || byte == b'\t')
}

struct ListMatch<'a> {
	indentation: usize,
	marker:      &'a str,
	text:        &'a str,
}
fn list_source_line(line: &str) -> &str {
	let line = line.strip_suffix('\n').unwrap_or(line);
	line.strip_suffix('\r').unwrap_or(line)
}

fn list_match(line: &str) -> Option<ListMatch<'_>> {
	let captures = LIST.captures(list_source_line(line))?;
	Some(ListMatch {
		indentation: captures.get(1)?.as_str().len(),
		marker:      captures.get(2)?.as_str(),
		text:        captures.get(4)?.as_str(),
	})
}
fn for_table_cell(line: &str, mut visit: impl FnMut(&str)) {
	let mut value = trim_js(line);
	if let Some(rest) = value.strip_prefix('|') {
		value = rest;
	}
	if value.ends_with('|') && !value.ends_with("\\|") {
		value = &value[..value.len() - 1];
	}
	let mut start = 0;
	let mut previous = None;
	for (position, character) in value.char_indices() {
		if character == '|' && previous != Some('\\') {
			visit(trim_js(&value[start..position]));
			start = position + 1;
		}
		previous = Some(character);
	}
	visit(trim_js(&value[start..]));
}

fn split_table_row(line: &str) -> Vec<String> {
	let mut cells = Vec::new();
	for_table_cell(line, |cell| cells.push(cell.replace("\\|", "|")));
	cells
}

// Only the name-delimiter projection supplies provenance. Normal lexing keeps
// this queue empty and performs no source-map allocation.
#[derive(Default)]
struct DelimiterQueue {
	sources: VecDeque<NameOrigins>,
	ranges:  Vec<Range<usize>>,
}

struct OriginRun {
	projected: Range<usize>,
	original:  Range<usize>,
}

impl OriginRun {
	fn original_range(&self, start: usize, end: usize) -> Range<usize> {
		if self.projected.len() == self.original.len() {
			self.original.start + start - self.projected.start
				..self.original.start + end - self.projected.start
		} else {
			// A normalized CRLF or expanded tab is one original source unit.
			self.original.clone()
		}
	}
}

/// Piecewise provenance exists only during delimiter collection. Ordinary
/// unchanged text, including multibyte UTF-8, occupies one offset run.
#[derive(Default)]
struct NameOrigins {
	runs: Vec<OriginRun>,
	len:  usize,
}

#[derive(Clone, Copy)]
struct OriginSlice<'a> {
	origins: &'a NameOrigins,
	start:   usize,
	end:     usize,
}

impl NameOrigins {
	fn view(&self) -> OriginSlice<'_> {
		OriginSlice { origins: self, start: 0, end: self.len }
	}

	fn push(&mut self, original: Range<usize>, length: usize) {
		if length == 0 {
			return;
		}
		if let Some(previous) = self.runs.last_mut()
			&& previous.projected.len() == previous.original.len()
			&& length == original.len()
			&& previous.original.end == original.start
		{
			previous.projected.end += length;
			previous.original.end = original.end;
		} else {
			self
				.runs
				.push(OriginRun { projected: self.len..self.len + length, original });
		}
		self.len += length;
	}

	fn append(&mut self, source: OriginSlice<'_>) {
		source.visit(|original, length| self.push(original, length));
	}

	fn truncate(&mut self, length: usize) {
		debug_assert!(length <= self.len);
		let retained = self
			.runs
			.partition_point(|run| run.projected.start < length);
		self.runs.truncate(retained);
		if let Some(last) = self.runs.last_mut() {
			last.original = last.original_range(last.projected.start, length);
			last.projected.end = length;
		}
		self.len = length;
	}

	fn discard_prefix(&mut self, length: usize) {
		debug_assert!(length <= self.len);
		let discarded = self.runs.partition_point(|run| run.projected.end <= length);
		self.runs.drain(..discarded);
		if let Some(first) = self.runs.first_mut() {
			first.original = first.original_range(length, first.projected.end);
			first.projected.start = length;
		}
		for run in &mut self.runs {
			run.projected.start -= length;
			run.projected.end -= length;
		}
		self.len -= length;
	}
}

impl OriginSlice<'_> {
	fn slice(self, range: Range<usize>) -> Self {
		debug_assert!(range.start <= range.end && range.end <= self.end - self.start);
		Self { start: self.start + range.start, end: self.start + range.end, ..self }
	}

	fn visit(self, mut visit: impl FnMut(Range<usize>, usize)) {
		let first = self
			.origins
			.runs
			.partition_point(|run| run.projected.end <= self.start);
		for run in &self.origins.runs[first..] {
			if run.projected.start >= self.end {
				break;
			}
			let start = run.projected.start.max(self.start);
			let end = run.projected.end.min(self.end);
			visit(run.original_range(start, end), end - start);
		}
	}

	fn owned(self) -> NameOrigins {
		let mut origins = NameOrigins::default();
		origins.append(self);
		origins
	}
}

fn source_origins<'a>(
	origins: Option<OriginSlice<'a>>,
	source: &str,
	part: &str,
) -> Option<OriginSlice<'a>> {
	origins.map(|origins| {
		let start = part.as_ptr() as usize - source.as_ptr() as usize;
		origins.slice(start..start + part.len())
	})
}

fn queue_origins(origins: Option<OriginSlice<'_>>, pending: &mut DelimiterQueue) {
	if let Some(origins) = origins {
		pending.sources.push_back(origins.owned());
	}
}

fn table_row(
	line: &str,
	origins: Option<OriginSlice<'_>>,
	columns: usize,
	queue: &mut DelimiterQueue,
) -> Vec<Vec<Token>> {
	let mut cells = Vec::with_capacity(columns);
	for_table_cell(line, |cell| {
		if cells.len() == columns {
			return;
		}
		if let Some(origins) = source_origins(origins, line, cell) {
			let mut mapped = NameOrigins::default();
			let mut start = 0;
			for (index, _) in cell.match_indices("\\|") {
				mapped.append(origins.slice(start..index));
				origins
					.slice(index..index + 1)
					.visit(|range, _| queue.ranges.push(range));
				start = index + 1;
			}
			mapped.append(origins.slice(start..cell.len()));
			queue.sources.push_back(mapped);
		}
		cells.push(vec![pending(TokenKind::Text, String::new(), cell.replace("\\|", "|"))]);
	});
	while cells.len() < columns {
		if origins.is_some() {
			queue.sources.push_back(NameOrigins::default());
		}
		cells.push(vec![pending(TokenKind::Text, String::new(), String::new())]);
	}
	cells
}
fn block_start_line(line: &str, next: Option<&str>) -> bool {
	if !line.is_empty() && line.bytes().all(|byte| byte == b'\n') {
		return true;
	}
	if fence(line).is_some()
		|| HEADING_START.is_match(line)
		|| HR.is_match(line)
		|| list_match(line).is_some()
		|| QUOTE.is_match(line)
		|| DEFINITION_START.is_match(line)
		|| HTML.is_match(line)
		|| (line.starts_with("    ")
			&& line[4..]
				.chars()
				.next()
				.is_some_and(|character| !is_js_whitespace(character)))
	{
		return true;
	}
	if let Some(next) = next {
		if SETEXT.is_match(next) {
			return true;
		}
		if line.contains('|')
			&& split_table_row(next)
				.iter()
				.all(|cell| TABLE_DELIMITER.is_match(cell))
		{
			return true;
		}
	}
	false
}
fn block_start(lines: &[&str], index: usize) -> bool {
	block_start_line(lines[index], lines.get(index + 1).copied())
}

pub(super) fn quote_prefix(line: &str) -> Option<usize> {
	QUOTE.find(line).map(|matched| matched.end())
}

pub(super) fn list_prefix(line: &str) -> Option<(usize, usize, usize)> {
	if HR.is_match(list_source_line(line)) {
		return None;
	}
	let captures = LIST.captures(list_source_line(line))?;
	let indentation = captures.get(1)?.len();
	Some((indentation, indentation + captures.get(2)?.len() + 1, captures.get(4)?.start()))
}

pub(super) fn list_line_continues(line: &str, next: Option<&str>, indentation: usize) -> bool {
	!(!blankish(line) && indent(line) <= indentation && block_start_line(line, next))
		&& (starts_whitespace(line) || line == "\n")
}

fn list_item_end<'a>(
	line: &impl Fn(usize) -> &'a str,
	length: usize,
	start: usize,
	indentation: usize,
	compatible: &impl Fn(&ListMatch<'_>) -> bool,
) -> usize {
	let mut cursor = start + 1;
	while cursor < length {
		let next = line(cursor);
		if !list_line_continues(next, (cursor + 1 < length).then(|| line(cursor + 1)), indentation) {
			break;
		}
		if blank_line(next) {
			let mut lookahead = cursor + 1;
			while lookahead < length && blank_line(line(lookahead)) {
				lookahead += 1;
			}
			if lookahead >= length
				|| indent(line(lookahead)) <= indentation
					&& !list_match(line(lookahead)).is_some_and(|matched| compatible(&matched))
			{
				break;
			}
		}
		cursor += 1;
		// Every preceding source line already ended in LF. Thus the old
		// /\n\s*\n$/ check on the accumulated item text is exactly this
		// blank-line check, without constructing the text just to find its end.
		if blank_line(next) && cursor < length && !starts_whitespace(line(cursor)) {
			break;
		}
	}
	cursor
}

fn compatible_list(first: &ListMatch<'_>, matched: &ListMatch<'_>) -> bool {
	let ordered = first.marker.as_bytes()[0].is_ascii_digit();
	matched.marker.as_bytes()[0].is_ascii_digit() == ordered
		&& if ordered {
			first.marker.as_bytes().last() == matched.marker.as_bytes().last()
		} else {
			first.marker == matched.marker
		}
}

pub(super) fn list_end<'a>(
	line: impl Fn(usize) -> &'a str,
	length: usize,
	index: usize,
) -> Option<usize> {
	if HR.is_match(list_source_line(line(index))) {
		return None;
	}
	let first = list_match(line(index))?;
	let compatible = |matched: &ListMatch<'_>| compatible_list(&first, matched);
	let mut cursor = index;
	while cursor < length && list_match(line(cursor)).is_some_and(|matched| compatible(&matched)) {
		cursor = list_item_end(&line, length, cursor, first.indentation, &compatible);
	}
	Some(cursor)
}
fn token(kind: TokenKind, raw: String, text: String) -> Token {
	Token { kind, raw, text, ..Token::default() }
}
fn pending(kind: TokenKind, raw: String, text: String) -> Token {
	Token { kind, raw, text, children: Some(Vec::new()), ..Token::default() }
}
fn make_table(
	lines: &[&str],
	index: usize,
	links_origins: Option<OriginSlice<'_>>,
	queue: &mut DelimiterQueue,
) -> Option<(Token, usize)> {
	let next = lines.get(index + 1)?;
	let header = split_table_row(strip_newline(lines[index]));
	let delimiter = split_table_row(strip_newline(next));
	if !lines[index].contains('|')
		|| header.len() != delimiter.len()
		|| !delimiter.iter().all(|cell| TABLE_DELIMITER.is_match(cell))
	{
		return None;
	}
	let columns = header.len();
	let cell = |text: String| vec![pending(TokenKind::Text, String::new(), text)];
	let mut rows = vec![if links_origins.is_some() {
		table_row(lines[index], source_origins(links_origins, lines[0], lines[index]), columns, queue)
	} else {
		header.into_iter().map(cell).collect()
	}];
	let mut count = 2;
	while index + count < lines.len() && !blankish(lines[index + count]) {
		let mut cells = split_table_row(strip_newline(lines[index + count]));
		if cells.len() == 1 && !lines[index + count].contains('|') {
			break;
		}
		rows.push(if links_origins.is_some() {
			table_row(
				lines[index + count],
				source_origins(links_origins, lines[0], lines[index + count]),
				columns,
				queue,
			)
		} else {
			cells.resize(columns, String::new());
			cells.into_iter().map(cell).collect()
		});
		count += 1;
	}
	Some((
		Token {
			kind: TokenKind::Table,
			raw: lines[index..index + count].concat(),
			rows,
			..Token::default()
		},
		count,
	))
}
fn parse_list(
	lines: &[&str],
	index: usize,
	links: &mut Links,
	origins: Option<OriginSlice<'_>>,
	queue: &mut DelimiterQueue,
) -> Option<(Token, usize)> {
	let first = list_match(lines[index])?;
	let compatible = |matched: &ListMatch<'_>| compatible_list(&first, matched);
	let mut raw_items = Vec::new();
	let mut cursor = index;
	while cursor < lines.len() {
		let Some(matched) = list_match(lines[cursor]).filter(compatible) else {
			break;
		};
		let start = cursor;
		let width = matched.indentation + matched.marker.len() + 1;
		let mut text = matched.text.to_owned();
		let mut text_origins =
			source_origins(origins, lines[0], matched.text).map(OriginSlice::owned);
		if lines[cursor].ends_with('\n') {
			text.push('\n');
			if let Some(mapped) = &mut text_origins {
				let newline = &lines[cursor][lines[cursor].len() - 1..];
				mapped.append(source_origins(origins, lines[0], newline).unwrap());
			}
		}
		cursor =
			list_item_end(&|index| lines[index], lines.len(), start, first.indentation, &compatible);
		for next in &lines[start + 1..cursor] {
			if blank_line(next) {
				text.push_str(next);
			} else {
				text.push_str(&next[indent(next).min(width)..]);
			}
			if let Some(mapped) = &mut text_origins {
				let part = if blank_line(next) {
					*next
				} else {
					&next[indent(next).min(width)..]
				};
				mapped.append(source_origins(origins, lines[0], part).unwrap());
			}
		}
		let mut raw = lines[start..cursor].concat();
		if (cursor == lines.len() || blank_line(lines[cursor])) && raw.ends_with('\n') {
			raw.pop();
		}
		let task = TASK.find(&text).map(|matched| matched.as_str().to_owned());
		if let Some(task) = &task {
			text.drain(..task.len());
			if let Some(mapped) = &mut text_origins {
				mapped.discard_prefix(task.len());
			}
		}
		if text.ends_with('\n') {
			text.pop();
			if let Some(mapped) = &mut text_origins {
				mapped.truncate(mapped.len - 1);
			}
		}
		raw_items.push((raw, text, task, text_origins));
	}
	if raw_items.is_empty() {
		return None;
	}
	let raw = lines[index..cursor].concat();
	let loose = raw_items.iter().any(|(raw, ..)| LOOSE.is_match(raw)) || LOOSE.is_match(&raw);
	let items = raw_items
		.into_iter()
		.map(|(_, text, task, text_origins)| {
			let mut tokens =
				block_tokens(&text, links, text_origins.as_ref().map(NameOrigins::view), queue);
			if !loose {
				for token in &mut tokens {
					if token.kind == TokenKind::Paragraph {
						token.kind = TokenKind::Text;
					}
				}
			}
			if let Some(raw) = task {
				tokens.insert(0, token(TokenKind::Checkbox, raw, String::new()));
			}
			tokens
		})
		.collect();
	Some((Token { kind: TokenKind::List, raw, items, ..Token::default() }, cursor - index))
}

fn block_tokens(
	source: &str,
	links: &mut Links,
	origins: Option<OriginSlice<'_>>,
	queue: &mut DelimiterQueue,
) -> Vec<Token> {
	let lines = source.split_inclusive('\n').collect::<Vec<_>>();
	let mut output: Vec<Token> = Vec::new();
	let mut i = 0;
	while i < lines.len() {
		let line = lines[i];
		if blank_line(line) {
			let start = i;
			while i < lines.len() && blank_line(lines[i]) {
				i += 1;
			}
			let mut raw = String::new();
			if let Some(previous) = output.last_mut() {
				if previous.raw.ends_with('\n') {
					previous.raw.pop();
				}
				raw.push('\n');
			}
			raw.extend(lines[start..i].iter().copied());
			if raw.len() > 1 {
				output.push(token(TokenKind::Space, raw, String::new()));
			}
			continue;
		}
		if let Some((marker, length)) = fence(line) {
			let start = i;
			i += 1;
			let content_start = i;
			let mut content_end = i;
			while i < lines.len() {
				let next = lines[i];
				i += 1;
				if closes_fence(next, marker, length) {
					break;
				}
				content_end = i;
			}
			let mut raw = lines[start..i].concat();
			let text = strip_newline(&lines[content_start..content_end].concat()).to_owned();
			if i < lines.len() && blank_line(lines[i]) && raw.ends_with('\n') {
				raw.pop();
			}
			output.push(token(TokenKind::Code, raw, text));
			continue;
		}
		if line.starts_with("    ") {
			let mut raw = String::new();
			let mut text = String::new();
			while i < lines.len() && lines[i].starts_with("    ") {
				raw.push_str(lines[i]);
				text.push_str(&lines[i][4..]);
				i += 1;
				if i + 1 < lines.len() && blank_line(lines[i]) && lines[i + 1].starts_with("    ") {
					raw.push_str(lines[i]);
					text.push_str(lines[i]);
					i += 1;
				}
			}
			if i < lines.len() && blank_line(lines[i]) {
				if raw.ends_with('\n') {
					raw.pop();
				}
				if text.ends_with('\n') {
					text.pop();
				}
			}
			if text.ends_with('\n') {
				text.truncate(text.trim_end_matches('\n').len() + 1);
			}
			output.push(token(TokenKind::Code, raw, text));
			continue;
		}
		if let Some(heading) = HEADING.captures(line) {
			let text =
				trim_js(&HEADING_TAIL.replace(heading.get(2).expect("heading text").as_str(), ""))
					.to_owned();
			if origins.is_some() {
				let raw_text = heading.get(2).expect("heading text");
				let start = raw_text.start() + raw_text.as_str().len()
					- raw_text.as_str().trim_start_matches(is_js_whitespace).len();
				let line_origins = source_origins(origins, source, line);
				queue_origins(
					line_origins.map(|mapped| mapped.slice(start..start + text.len())),
					queue,
				);
			}
			let raw = if i + 1 < lines.len() && blank_line(lines[i + 1]) {
				strip_newline(line)
			} else {
				line
			};
			output.push(pending(TokenKind::Heading, raw.to_owned(), text));
			i += 1;
			continue;
		}
		if HR.is_match(line) {
			output.push(token(TokenKind::Hr, line.to_owned(), String::new()));
			i += 1;
			continue;
		}
		if QUOTE.is_match(line) {
			let mut raw = String::new();
			let mut text = String::new();
			let mut text_origins = origins.map(|_| NameOrigins::default());
			while i < lines.len() {
				let next = lines[i];
				if let Some(marker) = QUOTE.find(next) {
					raw.push_str(next);
					text.push_str(&next[marker.end()..]);
					if let Some(mapped) = &mut text_origins {
						mapped.append(source_origins(origins, source, &next[marker.end()..]).unwrap());
					}
					i += 1;
					continue;
				}
				if !blank_line(next) && !block_start(&lines, i) {
					raw.push_str(next);
					text.push_str(next);
					if let Some(mapped) = &mut text_origins {
						mapped.append(source_origins(origins, source, next).unwrap());
					}
					i += 1;
					continue;
				}
				break;
			}
			if text.ends_with('\n') {
				text.pop();
				if let Some(mapped) = &mut text_origins {
					mapped.truncate(mapped.len - 1);
				}
			}
			let children =
				block_tokens(&text, links, text_origins.as_ref().map(NameOrigins::view), queue);
			output.push(Token {
				kind: TokenKind::Blockquote,
				raw,
				text,
				children: Some(children),
				..Token::default()
			});
			continue;
		}
		if let Some((list, count)) = parse_list(&lines, i, links, origins, queue) {
			output.push(list);
			i += count;
			continue;
		}
		if HTML.is_match(line) {
			let mut raw = line.to_owned();
			let tag = HTML_TAG
				.captures(line)
				.and_then(|captures| captures.get(1))
				.map(|matched| matched.as_str().to_ascii_lowercase());
			i += 1;
			if line
				.trim_start_matches(is_js_whitespace)
				.starts_with("<!--")
			{
				while !raw.contains("-->") && i < lines.len() {
					raw.push_str(lines[i]);
					i += 1;
				}
			} else if let Some(tag) = tag {
				let closing = format!("</{tag}>");
				let closes = |line: &str| {
					line
						.as_bytes()
						.windows(closing.len())
						.any(|window| window.eq_ignore_ascii_case(closing.as_bytes()))
				};
				if !closes(&raw) {
					while i < lines.len() {
						let next = lines[i];
						i += 1;
						raw.push_str(next);
						if closes(next) {
							break;
						}
					}
				}
			}
			if i < lines.len() && blank_line(lines[i]) && raw.ends_with('\n') {
				raw.pop();
			}
			output.push(token(TokenKind::Html, raw.clone(), raw));
			continue;
		}
		if let Some(definition) = DEFINITION.captures(line) {
			let tag = WHITESPACE
				.replace_all(definition.get(1).expect("definition label").as_str(), " ")
				.to_lowercase();
			let href = inline::clean_url(
				definition
					.get(2)
					.or_else(|| definition.get(3))
					.map_or("", |matched| matched.as_str()),
			);
			links.insert(tag, href);
			output.push(token(TokenKind::Def, line.to_owned(), String::new()));
			i += 1;
			continue;
		}
		if let Some((table, count)) = make_table(&lines, i, origins, queue) {
			output.push(table);
			i += count;
			continue;
		}
		if i + 1 < lines.len() && SETEXT.is_match(lines[i + 1]) {
			queue_origins(source_origins(origins, source, strip_newline(line)), queue);
			output.push(pending(
				TokenKind::Heading,
				lines[i..i + 2].concat(),
				strip_newline(line).to_owned(),
			));
			i += 2;
			continue;
		}
		let start = i;
		i += 1;
		let mut previous_blankish = false;
		while i < lines.len() {
			let next = lines[i];
			let indented = !trim_js(next).is_empty() && next.starts_with("    ");
			if if indented {
				previous_blankish
			} else {
				block_start(&lines, i)
			} {
				break;
			}
			previous_blankish = trim_js(next).is_empty();
			i += 1;
		}
		let raw = lines[start..i].concat();
		let text = strip_newline(&raw).to_owned();
		if let Some(origins) = origins {
			let start = lines[start].as_ptr() as usize - source.as_ptr() as usize;
			queue_origins(Some(origins.slice(start..start + text.len())), queue);
		}
		output.push(pending(TokenKind::Paragraph, raw, text));
	}
	output
}

fn resolve(tokens: &mut [Token], links: &Links) {
	for token in tokens {
		if matches!(token.kind, TokenKind::Heading | TokenKind::Paragraph | TokenKind::Text)
			&& token.children.is_some()
		{
			token.children = Some(inline::lex(&token.text, links));
		} else if let Some(children) = &mut token.children {
			resolve(children, links);
		}
		for item in &mut token.items {
			resolve(item, links);
		}
		for row in &mut token.rows {
			for cell in row {
				let source = &cell[0].text;
				*cell = inline::lex(source, links);
			}
		}
	}
}

fn normalized_source<'a>(source: &'a str, mut origins: Option<&mut NameOrigins>) -> Cow<'a, str> {
	if !source.contains(['\r', '\t']) {
		if let Some(origins) = origins {
			origins.push(0..source.len(), source.len());
		}
		return Cow::Borrowed(source);
	}
	let mut output = String::with_capacity(source.len());
	let mut unchanged = 0;
	let mut characters = source.char_indices().peekable();
	while let Some((position, character)) = characters.next() {
		match character {
			'\r' => {
				let mut end = position + 1;
				if characters
					.peek()
					.is_some_and(|(_, character)| *character == '\n')
				{
					characters.next();
					end += 1;
				}
				output.push('\n');
				if let Some(origins) = &mut origins {
					origins.push(unchanged..position, position - unchanged);
					origins.push(position..end, 1);
				}
				unchanged = end;
			},
			'\t' => {
				output.push_str("    ");
				if let Some(origins) = &mut origins {
					origins.push(unchanged..position, position - unchanged);
					origins.push(position..position + 1, 4);
				}
				unchanged = position + 1;
			},
			_ => {
				output.push(character);
			},
		}
	}
	if let Some(origins) = &mut origins {
		origins.push(unchanged..source.len(), source.len() - unchanged);
	}
	Cow::Owned(output)
}

pub(super) fn lex(source: &str) -> Vec<Token> {
	let normalized = normalized_source(source, None);
	let mut links = Links::new();
	let mut tokens = block_tokens(&normalized, &mut links, None, &mut DelimiterQueue::default());
	// Every nested definition is collected before any queued inline source is
	// resolved, including definitions in lists and blockquotes.
	resolve(&mut tokens, &links);
	tokens
}

fn inline_delimiters(
	source: &str,
	links: &Links,
	queue: &mut DelimiterQueue,
	ranges: &mut Vec<Range<usize>>,
) {
	let origins = queue
		.sources
		.pop_front()
		.expect("pending inline source provenance");
	debug_assert_eq!(origins.len, source.len());
	let (_, delimiters) = inline::lex_with_delimiters(source, links);
	for delimiter in delimiters {
		origins
			.view()
			.slice(delimiter)
			.visit(|range, _| ranges.push(range));
	}
}

fn collect_delimiters(
	tokens: &[Token],
	links: &Links,
	queue: &mut DelimiterQueue,
	ranges: &mut Vec<Range<usize>>,
) {
	for token in tokens {
		if matches!(token.kind, TokenKind::Heading | TokenKind::Paragraph | TokenKind::Text)
			&& token.children.is_some()
		{
			inline_delimiters(&token.text, links, queue, ranges);
		} else if let Some(children) = &token.children {
			collect_delimiters(children, links, queue, ranges);
		}
		for item in &token.items {
			collect_delimiters(item, links, queue, ranges);
		}
		for row in &token.rows {
			for cell in row {
				inline_delimiters(&cell[0].text, links, queue, ranges);
			}
		}
	}
}

pub(super) fn name_delimiters(source: &str) -> Vec<Range<usize>> {
	if !source.contains(['*', '_', '~', '\\']) {
		return Vec::new();
	}
	let mut origins = NameOrigins::default();
	let normalized = normalized_source(source, Some(&mut origins));
	let mut links = Links::new();
	let mut queue = DelimiterQueue::default();
	let tokens = block_tokens(&normalized, &mut links, Some(origins.view()), &mut queue);
	let mut ranges = std::mem::take(&mut queue.ranges);
	collect_delimiters(&tokens, &links, &mut queue, &mut ranges);
	debug_assert!(queue.sources.is_empty());
	ranges.sort_unstable_by_key(|range| range.start);
	let mut merged: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
	for range in ranges {
		if let Some(previous) = merged.last_mut()
			&& range.start <= previous.end
		{
			previous.end = previous.end.max(range.end);
		} else {
			merged.push(range);
		}
	}
	merged
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn references_resolve_after_nested_definition_collection() {
		let tokens = lex("[late]\n\n> [late]: /target\n");
		assert_eq!(tokens[0].children.as_ref().unwrap()[0].kind, TokenKind::Link);
		let tokens = lex("- [late]\n\n[late]: /target\n");
		assert_eq!(tokens[0].items[0][0].kind, TokenKind::Text);
		assert_eq!(tokens[0].items[0][0].children.as_ref().unwrap()[0].kind, TokenKind::Link);
		let tokens = lex("| [late] |\n| --- |\n\n[late]: /target\n");
		assert_eq!(tokens[0].rows[0][0][0].kind, TokenKind::Link);
	}

	#[test]
	fn block_rule_order_and_code_punctuation_are_preserved() {
		let tokens = lex("***\n\n- item\n\nbody\n    literal C++\n");
		assert_eq!(tokens[0].kind, TokenKind::Hr);
		assert_eq!(tokens[2].kind, TokenKind::List);
		assert_eq!(tokens[4].kind, TokenKind::Paragraph);
		assert!(tokens[4].text.contains("    literal C++"));
		let tokens = lex("```bad`info\nbody\n");
		assert_eq!(tokens[0].kind, TokenKind::Paragraph);
		let tokens = lex("```lang\u{2028}info\nC++ -> a::b\n```\n");
		assert_eq!(tokens[0].kind, TokenKind::Code);
		assert_eq!(tokens[0].text, "C++ -> a::b");
	}

	#[test]
	fn blank_lines_stay_outside_tight_lists_and_empty_heading_is_recognized() {
		let tokens = lex("- item\n\n");
		assert_eq!(tokens.len(), 2);
		assert_eq!(tokens[0].items[0][0].kind, TokenKind::Text);
		assert_eq!(tokens[0].raw, "- item");
		assert_eq!(tokens[1].kind, TokenKind::Space);
		let tokens = lex("#");
		assert_eq!(tokens[0].kind, TokenKind::Heading);
		assert!(tokens[0].children.as_ref().unwrap().is_empty());
		let tokens = lex("#\n\nbody");
		assert_eq!(tokens[0].kind, TokenKind::Paragraph);
		assert_eq!(tokens[0].text, "#");
	}

	#[test]
	fn name_delimiters_preserve_exact_original_positions_through_block_transforms() {
		for (source, expected) in [
			("a**scan**ner\n", "ascanner\n"),
			("# **scan**ner ##\r\n", "# scanner ##\r\n"),
			("> **scan\n> ner**\r\n", "> scan\n> ner\r\n"),
			("- [x] **scan**ner\r\n", "- [x] scanner\r\n"),
			("> - **scan**ner\r\n", "> - scanner\r\n"),
			("- item\n\t**scan**ner\r\n", "- item\n\tscanner\r\n"),
			("Title **scan**ner\r\n---\r\n", "Title scanner\r\n---\r\n"),
			("| a\\|**scan**ner |\r\n| --- |\r\n", "| a|scanner |\r\n| --- |\r\n"),
			(
				"| **scan**ner | **other** |\n| --- | --- |\n| ~~scan~~ner |\n",
				"| scanner | other |\n| --- | --- |\n| scanner |\n",
			),
			("[**scan**ner][ref]\n\n> [ref]: /target\n", "[scanner][ref]\n\n> [ref]: /target\n"),
			("中😀**scan**ner\r\n", "中😀scanner\r\n"),
			("\\*scan\\*ner\n", "*scan*ner\n"),
		] {
			let ranges = name_delimiters(source);
			let mut projected = String::new();
			let mut start = 0;
			for range in ranges {
				assert!(start <= range.start && range.start < range.end && range.end <= source.len());
				assert!(source.is_char_boundary(range.start) && source.is_char_boundary(range.end));
				projected.push_str(&source[start..range.start]);
				start = range.end;
			}
			projected.push_str(&source[start..]);
			assert_eq!(projected, expected, "{source:?}");
		}
	}

	#[test]
	fn name_delimiters_do_not_borrow_same_text_from_code_or_other_occurrences() {
		let source = "`**scan**ner` a**scan**ner `x*scan*` [raw](/a**scan**) <i data-x='**scan**'>\n";
		let ranges = name_delimiters(source);
		let first = source.find(" a**").unwrap() + 2;
		assert_eq!(ranges, [first..first + 2, first + 6..first + 8]);
		assert!(name_delimiters("```cpp\n**scan**ner\n```\n\n    **scan**ner\n").is_empty());
	}

	#[test]
	fn name_provenance_storage_tracks_conversion_runs_not_source_bytes() {
		let source = format!("{}a**scan**ner\r\n\tend", "中😀".repeat(100_000));
		let mut origins = NameOrigins::default();
		let normalized = normalized_source(&source, Some(&mut origins));
		assert_eq!(origins.len, normalized.len());
		assert_eq!(origins.runs.len(), 4);
		let start = normalized.find("scan").unwrap();
		let mut ranges = Vec::new();
		origins
			.view()
			.slice(start..start + 4)
			.visit(|range, _| ranges.push(range));
		let original = source.find("scan").unwrap();
		assert_eq!(ranges, [original..original + 4]);
		let delimiter = source.find("**").unwrap();
		assert_eq!(name_delimiters(&source), [
			delimiter..delimiter + 2,
			delimiter + 6..delimiter + 8
		]);
		let plain = "中😀".repeat(100_000);
		let mut origins = NameOrigins::default();
		let normalized = normalized_source(&plain, Some(&mut origins));
		assert!(matches!(normalized, Cow::Borrowed(_)));
		assert_eq!(origins.runs.len(), 1);
		assert_eq!(origins.runs[0].original, 0..plain.len());
	}
}
