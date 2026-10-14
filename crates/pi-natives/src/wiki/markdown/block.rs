//! Direct port of marked/core.ts's default block rule order and inline queue.
use std::{borrow::Cow, sync::LazyLock};

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
static LOOSE_END: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\n\s*\n\z"));

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
fn list_match(line: &str) -> Option<ListMatch<'_>> {
	let captures = LIST.captures(line)?;
	// The JS lookahead leaves an empty marker's newline unconsumed. Our
	// assertion emulation consumes it, but the text remains the same empty
	// value.
	Some(ListMatch {
		indentation: captures.get(1)?.as_str().len(),
		marker:      captures.get(2)?.as_str(),
		text:        captures.get(4)?.as_str(),
	})
}
fn split_table_row(line: &str) -> Vec<String> {
	let mut value = trim_js(line);
	if let Some(rest) = value.strip_prefix('|') {
		value = rest;
	}
	if value.ends_with('|') && !value.ends_with("\\|") {
		value = &value[..value.len() - 1];
	}
	let mut cells = Vec::new();
	let mut start = 0;
	let mut previous = None;
	for (position, character) in value.char_indices() {
		if character == '|' && previous != Some('\\') {
			cells.push(trim_js(&value[start..position]).replace("\\|", "|"));
			start = position + 1;
		}
		previous = Some(character);
	}
	cells.push(trim_js(&value[start..]).replace("\\|", "|"));
	cells
}
fn block_start(lines: &[&str], index: usize) -> bool {
	let line = lines[index];
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
	if let Some(next) = lines.get(index + 1) {
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
fn token(kind: TokenKind, raw: String, text: String) -> Token {
	Token { kind, raw, text, ..Token::default() }
}
fn pending(kind: TokenKind, raw: String, text: String) -> Token {
	Token { kind, raw, text, children: Some(Vec::new()), ..Token::default() }
}
fn make_table(lines: &[&str], index: usize) -> Option<(Token, usize)> {
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
	let mut rows = vec![header.into_iter().map(cell).collect()];
	let mut count = 2;
	while index + count < lines.len() && !blankish(lines[index + count]) {
		let mut cells = split_table_row(strip_newline(lines[index + count]));
		if cells.len() == 1 && !lines[index + count].contains('|') {
			break;
		}
		cells.resize(columns, String::new());
		rows.push(cells.into_iter().map(cell).collect());
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
fn parse_list(lines: &[&str], index: usize, links: &mut Links) -> Option<(Token, usize)> {
	let first = list_match(lines[index])?;
	let ordered = first.marker.as_bytes()[0].is_ascii_digit();
	let delimiter = if ordered {
		&first.marker[first.marker.len() - 1..]
	} else {
		first.marker
	};
	let compatible = |matched: &ListMatch<'_>| {
		matched.marker.as_bytes()[0].is_ascii_digit() == ordered
			&& (if ordered {
				&matched.marker[matched.marker.len() - 1..]
			} else {
				matched.marker
			}) == delimiter
	};
	let mut raw_items = Vec::new();
	let mut cursor = index;
	while cursor < lines.len() {
		let Some(matched) = list_match(lines[cursor]).filter(compatible) else {
			break;
		};
		let start = cursor;
		let width = matched.indentation + matched.marker.len() + 1;
		let mut text = matched.text.to_owned();
		if lines[cursor].ends_with('\n') {
			text.push('\n');
		}
		cursor += 1;
		while cursor < lines.len() {
			let next = lines[cursor];
			let indentation = indent(next);
			if !blankish(next) && indentation <= first.indentation && block_start(lines, cursor) {
				break;
			}
			if !starts_whitespace(next) && next != "\n" {
				break;
			}
			if blank_line(next) {
				let mut lookahead = cursor + 1;
				while lookahead < lines.len() && blank_line(lines[lookahead]) {
					lookahead += 1;
				}
				if lookahead >= lines.len() {
					break;
				}
				let following = lines[lookahead];
				if indent(following) <= first.indentation
					&& !list_match(following).is_some_and(|matched| compatible(&matched))
				{
					break;
				}
				text.push_str(next);
			} else {
				text.push_str(&next[indentation.min(width)..]);
			}
			cursor += 1;
			if LOOSE_END.is_match(&text) && cursor < lines.len() && !starts_whitespace(lines[cursor]) {
				break;
			}
		}
		let mut raw = lines[start..cursor].concat();
		if (cursor == lines.len() || blank_line(lines[cursor])) && raw.ends_with('\n') {
			raw.pop();
		}
		let task = TASK.find(&text).map(|matched| matched.as_str().to_owned());
		if let Some(task) = &task {
			text.drain(..task.len());
		}
		if text.ends_with('\n') {
			text.pop();
		}
		raw_items.push((raw, text, task));
	}
	if raw_items.is_empty() {
		return None;
	}
	let raw = lines[index..cursor].concat();
	let loose = raw_items.iter().any(|(raw, ..)| LOOSE.is_match(raw)) || LOOSE.is_match(&raw);
	let items = raw_items
		.into_iter()
		.map(|(_, text, task)| {
			let mut tokens = block_tokens(&text, links);
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

fn block_tokens(source: &str, links: &mut Links) -> Vec<Token> {
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
			while i < lines.len() {
				let next = lines[i];
				if let Some(marker) = QUOTE.find(next) {
					raw.push_str(next);
					text.push_str(&next[marker.end()..]);
					i += 1;
					continue;
				}
				if !blank_line(next) && !block_start(&lines, i) {
					raw.push_str(next);
					text.push_str(next);
					i += 1;
					continue;
				}
				break;
			}
			if text.ends_with('\n') {
				text.pop();
			}
			let children = block_tokens(&text, links);
			output.push(Token {
				kind: TokenKind::Blockquote,
				raw,
				text,
				children: Some(children),
				..Token::default()
			});
			continue;
		}
		if let Some((list, count)) = parse_list(&lines, i, links) {
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
		if let Some((table, count)) = make_table(&lines, i) {
			output.push(table);
			i += count;
			continue;
		}
		if i + 1 < lines.len() && SETEXT.is_match(lines[i + 1]) {
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

pub(super) fn lex(source: &str) -> Vec<Token> {
	let normalized = if source.contains(['\r', '\t']) {
		let mut output = String::with_capacity(source.len());
		let mut characters = source.chars().peekable();
		while let Some(character) = characters.next() {
			match character {
				'\r' => {
					if characters.peek() == Some(&'\n') {
						characters.next();
					}
					output.push('\n');
				},
				'\t' => output.push_str("    "),
				_ => output.push(character),
			}
		}
		Cow::Owned(output)
	} else {
		Cow::Borrowed(source)
	};
	let mut links = Links::new();
	let mut tokens = block_tokens(&normalized, &mut links);
	// Every nested definition is collected before any queued inline source is
	// resolved, including definitions in lists and blockquotes.
	resolve(&mut tokens, &links);
	tokens
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
}
