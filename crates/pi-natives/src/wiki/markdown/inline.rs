use std::sync::LazyLock;

use regex::Regex;

use super::{
	Links, Token, TokenKind,
	closers::{CloserIndexes, Source, can_close, can_open, escaped_at, punctuation, whitespace},
	is_js_whitespace as js_space, js_regex,
	text::{
		RootTextStops, TextRun, TextStops, dotted_domain, mail_local, scheme_width, starts_ascii_case,
	},
};

pub(super) fn unescape_markdown(value: &str) -> String {
	let mut output = String::with_capacity(value.len());
	let mut chars = value.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch == '\\'
			&& chars
				.peek()
				.is_some_and(|&next| u16::try_from(u32::from(next)).is_ok_and(punctuation))
		{
			output.push(chars.next().expect("peeked character"));
		} else {
			output.push(ch);
		}
	}
	output
}

pub(super) fn clean_url(value: &str) -> String {
	let value = value.trim_matches(js_space);
	let value = value.strip_prefix('<').unwrap_or(value);
	let value = value.strip_suffix('>').unwrap_or(value);
	unescape_markdown(value)
}

struct Root<'a> {
	source:  Source<'a>,
	closers: CloserIndexes,
	stops:   RootTextStops,
}

struct Nested {
	token:   Token,
	start:   usize,
	end:     usize,
	raw_end: usize,
}

fn token(kind: TokenKind, raw: &str, text: &str) -> Token {
	Token { kind, raw: raw.to_owned(), text: text.to_owned(), ..Token::default() }
}

fn find_delimiter(src: &[u16], marker: u16, width: usize, from: usize) -> Option<usize> {
	let mut at = from;
	while at + width <= src.len() {
		if src[at..at + width].iter().all(|&unit| unit == marker) {
			if !escaped_at(src, at) {
				return Some(at);
			}
			at += width;
		} else {
			at += 1;
		}
	}
	None
}

fn autolink_end(root: &mut Root<'_>, pos: usize, end: usize) -> Option<usize> {
	let src = &root.source.units;
	if src[pos] != 0x3c {
		return None;
	}
	let scheme = [b"http://".as_slice(), b"https://".as_slice(), b"ftp://".as_slice()]
		.into_iter()
		.find(|scheme| starts_ascii_case(src, pos + 1, end, scheme));
	if let Some(scheme) = scheme {
		return root
			.closers
			.close_url_autolink(src, pos + 1 + scheme.len(), end)
			.map(|at| at + 1);
	}
	let mut at = pos + 1;
	while at < end && !matches!(src[at], 0x20 | 0x3c | 0x3e | 0x40) {
		at += 1;
	}
	if at == pos + 1 || at == end || src[at] != 0x40 {
		return None;
	}
	let domain = at + 1;
	at = domain;
	while at < end && !matches!(src[at], 0x20 | 0x3c | 0x3e | 0x40) {
		at += 1;
	}
	(at > domain && at < end && src[at] == 0x3e).then_some(at + 1)
}

fn html_end(root: &mut Root<'_>, pos: usize, end: usize) -> Option<usize> {
	let src = &root.source.units;
	if src[pos] != 0x3c {
		return None;
	}
	if src.get(pos..pos + 4) == Some(&[0x3c, 0x21, 0x2d, 0x2d]) && pos + 4 <= end {
		return root.closers.close_comment(src, pos, end).map(|at| at + 3);
	}
	let mut at = pos + 1;
	if at < end && src[at] == 0x2f {
		at += 1;
	}
	if at >= end || !matches!(src[at], 0x41..=0x5a | 0x61..=0x7a) {
		return None;
	}
	at += 1;
	while at < end && matches!(src[at], 0x41..=0x5a | 0x61..=0x7a | 0x30..=0x39 | 0x2d) {
		at += 1;
	}
	if at >= end
		|| !(whitespace(src[at])
			|| src[at] == 0x3e
			|| (src[at] == 0x2f && at + 1 < end && src[at + 1] == 0x3e))
	{
		return None;
	}
	root.closers.close_tag(src, pos, end).map(|at| at + 1)
}

fn valid_destination(inside: &str) -> bool {
	static DESTINATION: LazyLock<Regex> =
		LazyLock::new(|| js_regex(r#"^(<[^>]*>|\S+?)(?:\s+(?:"(?s:.*)"|'(?s:.*)'|\((?s:.*)\)))?$"#));
	DESTINATION.is_match(inside)
}

fn normalize_label(label: &str) -> String {
	let mut normalized = String::with_capacity(label.len());
	let mut space = false;
	for ch in label.chars() {
		if js_space(ch) {
			if !space {
				normalized.push(' ');
			}
			space = true;
		} else {
			space = false;
			normalized.push(ch);
		}
	}
	// str::to_lowercase implements Unicode's context-sensitive final sigma, as
	// JS does.
	normalized.to_lowercase()
}

fn match_link(root: &mut Root<'_>, pos: usize, end: usize, links: &Links) -> Option<Nested> {
	let source = &root.source;
	let src = &source.units;
	let image = src[pos] == 0x21 && pos + 1 < end && src[pos + 1] == 0x5b;
	if !(image || src[pos] == 0x5b) {
		return None;
	}
	let label_start = pos + if image { 2 } else { 1 };
	let label_end = root.closers.close_square(src, label_start, end)?;
	let label = source.slice(label_start, label_end);
	let raw_end = if label_end + 1 < end && src[label_end + 1] == 0x28 {
		let destination_end = root.closers.close_round(src, label_end + 2, end)?;
		let inside = source
			.slice(label_end + 2, destination_end)
			.trim_matches(js_space);
		if !valid_destination(inside) {
			return None;
		}
		destination_end + 1
	} else {
		let mut reference_start = label_start;
		let mut reference_end = label_end;
		let mut finish = label_end + 1;
		if finish < end && src[finish] == 0x5b {
			let close = root.closers.close_square(src, finish + 1, end)?;
			if close > finish + 1 {
				reference_start = finish + 1;
				reference_end = close;
			}
			finish = close + 1;
		}
		if links.is_empty()
			|| root
				.closers
				.square_closer_within(src, reference_start, reference_end)
		{
			return None;
		}
		if !links.contains_key(&normalize_label(source.slice(reference_start, reference_end))) {
			return None;
		}
		finish
	};
	let text = if image && root.closers.escape_within(src, label_start, label_end) {
		unescape_markdown(label)
	} else {
		label.to_owned()
	};
	Some(Nested {
		token: Token {
			kind: if image {
				TokenKind::Image
			} else {
				TokenKind::Link
			},
			raw: source.slice(pos, raw_end).to_owned(),
			text,
			children: Some(Vec::new()),
			..Token::default()
		},
		start: label_start,
		end: label_end,
		raw_end,
	})
}

fn previous_unit(output: &[Token]) -> u16 {
	let Some(ch) = output
		.last()
		.and_then(|token| token.raw.chars().next_back())
	else {
		return 0x0a;
	};
	let code = u32::from(ch);
	if code <= 0xffff {
		code as u16
	} else {
		(0xdc00 + ((code - 0x10000) & 0x3ff)) as u16
	}
}

fn match_emphasis(root: &mut Root<'_>, pos: usize, end: usize, output: &[Token]) -> Option<Nested> {
	let src = &root.source.units[pos..end];
	let marker = src[0];
	if marker != 0x2a && marker != 0x5f {
		return None;
	}
	let previous = previous_unit(output);
	if src
		.get(..3)
		.is_some_and(|units| units.iter().all(|&unit| unit == marker))
		&& can_open(src, 0, 3, marker, previous)
		&& let Some(close) = find_delimiter(src, marker, 3, 3)
		&& can_close(src, close, marker)
	{
		return Some(Nested {
			token:   token(
				TokenKind::Em,
				root.source.slice(pos, pos + close + 3),
				root.source.slice(pos + 1, pos + close + 2),
			),
			start:   pos + 1,
			end:     pos + close + 2,
			raw_end: pos + close + 3,
		});
	}
	let width = if src.get(1) == Some(&marker) { 2 } else { 1 };
	if !can_open(src, 0, width, marker, previous) {
		return None;
	}
	let close = root
		.closers
		.close_emphasis(&root.source.units, pos, end, marker, width)?;
	Some(Nested {
		token:   token(
			if width == 2 {
				TokenKind::Strong
			} else {
				TokenKind::Em
			},
			root.source.slice(pos, close + width),
			root.source.slice(pos + width, close),
		),
		start:   pos + width,
		end:     close,
		raw_end: close + width,
	})
}

fn trim_bare_url(src: &[u16], pos: usize, mut end: usize) -> usize {
	while end > pos && matches!(src[end - 1], 0x2e | 0x2c | 0x3a | 0x3b | 0x21 | 0x3f) {
		end -= 1;
	}
	let mut opens = 0;
	let mut closes = 0;
	for &unit in &src[pos..end] {
		if unit == 0x28 {
			opens += 1;
		} else if unit == 0x29 {
			closes += 1;
		}
	}
	while closes > opens && end > pos && src[end - 1] == 0x29 {
		end -= 1;
		closes -= 1;
	}
	end
}

fn bare_url_end(src: &[u16], pos: usize, end: usize) -> Option<usize> {
	if let Some(width) = scheme_width(src, pos, end) {
		let mut at = pos + width;
		while at < end && !whitespace(src[at]) && src[at] != 0x3c {
			at += 1;
		}
		if at > pos + width {
			return Some(trim_bare_url(src, pos, at));
		}
	}
	let mut at = pos;
	while at < end && mail_local(src[at]) {
		at += 1;
	}
	if at == pos || at >= end || src[at] != 0x40 {
		return None;
	}
	dotted_domain(src, at + 1, end).map(|at| trim_bare_url(src, pos, at))
}

fn leaf_link(raw: &str, text: &str) -> Token {
	Token {
		kind: TokenKind::Link,
		raw: raw.to_owned(),
		text: text.to_owned(),
		children: Some(vec![token(TokenKind::Text, text, text)]),
		..Token::default()
	}
}

pub(crate) fn lex(source: &str, links: &Links) -> Vec<Token> {
	let mut root = Root {
		source:  Source::new(source),
		closers: CloserIndexes::default(),
		stops:   RootTextStops::default(),
	};
	let end = root.source.len();
	lex_range(&mut root, 0, end, links)
}

/// Nested links/emphasis retain only this small frame and use root-owned
/// indexes. Deletion intentionally enters `lex`, opening a NEW root just like
/// Tokenizer.del.
fn lex_range(root: &mut Root<'_>, start: usize, end: usize, links: &Links) -> Vec<Token> {
	let mut output = Vec::new();
	let mut stops = TextStops::default();
	let mut text_run = TextRun::default();
	let mut pos = start;
	while pos < end {
		let src = &root.source.units;
		if src[pos] == 0x5c && pos + 1 < end && punctuation(src[pos + 1]) {
			output.push(token(
				TokenKind::Escape,
				root.source.slice(pos, pos + 2),
				root.source.slice(pos + 1, pos + 2),
			));
			pos += 2;
			continue;
		}
		let mut br_end = pos;
		if src[pos] == 0x5c {
			br_end += 1;
		} else {
			while br_end < end && src[br_end] == 0x20 {
				br_end += 1;
			}
			if br_end - pos < 2 {
				br_end = pos;
			}
		}
		if br_end > pos && br_end < end && src[br_end] == 0x0a {
			output.push(token(TokenKind::Br, root.source.slice(pos, br_end + 1), ""));
			pos = br_end + 1;
			continue;
		}
		if src[pos] == 0x60 {
			let width = root.closers.code_opener_width(src, pos, end);
			if let Some(close) = root.closers.close_code(src, pos, end, width) {
				let text = root.source.slice(pos + width, close).replace('\n', " ");
				let text = if text.starts_with(' ')
					&& text.ends_with(' ')
					&& text.len() >= 2
					&& !text.contains(['\r', '\u{2028}', '\u{2029}'])
					&& !text.trim_matches(js_space).is_empty()
				{
					&text[1..text.len() - 1]
				} else {
					&text
				};
				output.push(token(TokenKind::Codespan, root.source.slice(pos, close + width), text));
				pos = close + width;
				continue;
			}
		}
		if let Some(finish) = autolink_end(root, pos, end) {
			output.push(leaf_link(
				root.source.slice(pos, finish),
				root.source.slice(pos + 1, finish - 1),
			));
			pos = finish;
			continue;
		}
		if let Some(finish) = html_end(root, pos, end) {
			let raw = root.source.slice(pos, finish);
			output.push(token(TokenKind::Html, raw, raw));
			pos = finish;
			continue;
		}
		if let Some(mut nested) =
			match_link(root, pos, end, links).or_else(|| match_emphasis(root, pos, end, &output))
		{
			// Rule frames have returned before entering the nested lex.
			nested.token.children = Some(lex_range(root, nested.start, nested.end, links));
			pos = nested.raw_end;
			output.push(nested.token);
			continue;
		}
		let src = &root.source.units;
		if pos + 1 < end
			&& src[pos] == 0x7e
			&& src[pos + 1] == 0x7e
			&& !src
				.get(pos + 2)
				.filter(|_| pos + 2 < end)
				.is_some_and(|&unit| whitespace(unit))
			&& let Some(close) = find_delimiter(&src[pos..end], 0x7e, 2, 2)
			&& close >= 2
			&& !whitespace(src[pos + close - 1])
		{
			let text = root.source.slice(pos + 2, pos + close);
			let children = lex(text, links);
			let mut deletion = token(TokenKind::Del, root.source.slice(pos, pos + close + 2), text);
			deletion.children = Some(children);
			output.push(deletion);
			pos += close + 2;
			continue;
		}
		if stops.bare_url_can_start(&mut root.stops, src, pos, end)
			&& let Some(finish) = bare_url_end(src, pos, end)
		{
			let raw = root.source.slice(pos, finish);
			output.push(leaf_link(raw, raw));
			pos = finish;
			continue;
		}
		let next = TextStops::text_length(&mut root.stops, src, pos, end);
		text_run.append(&mut output, &root.source, pos, pos + next);
		pos += next;
	}
	output
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn raw_escape_neighbor_prevents_emphasis_opening() {
		let tokens = lex(r"\**x*", &Links::new());
		assert_eq!(tokens.len(), 2);
		assert!(matches!(tokens[0].kind, TokenKind::Escape));
		assert!(matches!(tokens[1].kind, TokenKind::Text));
		assert_eq!(tokens[1].raw, "*x*");
	}

	#[test]
	fn nested_code_cannot_reach_beyond_label_end() {
		let tokens = lex("[`a](url)`", &Links::new());
		assert!(matches!(tokens[0].kind, TokenKind::Link));
		let children = tokens[0].children.as_ref().unwrap();
		assert_eq!(children.len(), 1);
		assert!(matches!(children[0].kind, TokenKind::Text));
		assert_eq!(children[0].raw, "`a");
	}

	#[test]
	fn unicode_neighbors_and_nested_image_escapes() {
		let tokens = lex("𐐀_x_𐐀 ![\\*x\\*](url)", &Links::new());
		assert!(
			tokens
				.iter()
				.any(|token| matches!(token.kind, TokenKind::Em))
		);
		let image = tokens
			.iter()
			.find(|token| matches!(token.kind, TokenKind::Image))
			.unwrap();
		assert_eq!(image.text, "*x*");
		assert!(matches!(image.children.as_ref().unwrap()[0].kind, TokenKind::Escape));
	}

	#[test]
	fn deletion_restarts_code_root_and_url_trimming_is_ordered() {
		let tokens = lex("~~`a~~ ` www.x/)).", &Links::new());
		assert!(matches!(tokens[0].kind, TokenKind::Del));
		assert!(matches!(tokens[0].children.as_ref().unwrap()[0].kind, TokenKind::Text));
		let link = tokens
			.iter()
			.find(|token| matches!(token.kind, TokenKind::Link))
			.unwrap();
		assert_eq!(link.raw, "www.x/");
	}

	#[test]
	fn code_padding_retains_js_dot_line_terminators() {
		let tokens = lex("` x\u{2028}y ` ` x\u{0085}y `", &Links::new());
		assert_eq!(tokens[0].text, " x\u{2028}y ");
		assert_eq!(tokens[2].text, "x\u{0085}y");
	}

	#[test]
	fn triple_emphasis_and_reference_labels_keep_nested_ranges() {
		let mut links = Links::new();
		links.insert("a b".to_owned(), "url".to_owned());
		let tokens = lex("***x*** [a\u{feff}b] [missing]", &links);
		assert!(matches!(tokens[0].kind, TokenKind::Em));
		let strong = &tokens[0].children.as_ref().unwrap()[0];
		assert!(matches!(strong.kind, TokenKind::Strong));
		assert_eq!(strong.children.as_ref().unwrap()[0].text, "x");
		assert!(matches!(tokens[2].kind, TokenKind::Link));
		assert_eq!(tokens[2].text, "a\u{feff}b");
		assert_eq!(tokens[3].raw, " [missing]");
	}

	#[test]
	fn text_ranges_merge_across_failed_delimiters() {
		let tokens = lex("x[missing]* trailing www.", &Links::new());
		assert_eq!(tokens.len(), 1);
		assert_eq!(tokens[0].raw, "x[missing]* trailing www.");
		assert_eq!(tokens[0].text, tokens[0].raw);
	}
}
