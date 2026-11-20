use super::{Token, TokenKind, closers::Source};

pub(super) const fn mail_local(unit: u16) -> bool {
	matches!(unit, 0x61..=0x7a | 0x41..=0x5a | 0x30..=0x39 | 0x2e | 0x5f | 0x2b | 0x2d)
}
const fn domain_char(unit: u16) -> bool {
	matches!(unit, 0x61..=0x7a | 0x41..=0x5a | 0x30..=0x39 | 0x5f | 0x2d)
}

pub(super) fn starts_ascii_case(src: &[u16], at: usize, end: usize, value: &[u8]) -> bool {
	at + value.len() <= end
		&& src[at..at + value.len()]
			.iter()
			.zip(value)
			.all(|(&unit, &byte)| unit < 128 && (unit as u8).eq_ignore_ascii_case(&byte))
}

pub(super) fn scheme_width(src: &[u16], at: usize, end: usize) -> Option<usize> {
	[b"http://".as_slice(), b"https://".as_slice(), b"ftp://".as_slice(), b"www.".as_slice()]
		.into_iter()
		.find(|scheme| starts_ascii_case(src, at, end, scheme))
		.map(<[u8]>::len)
}

/// End of the sticky /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/ match.
pub(super) fn dotted_domain(src: &[u16], start: usize, end: usize) -> Option<usize> {
	let mut at = start;
	while at < end && domain_char(src[at]) {
		at += 1;
	}
	if at == start {
		return None;
	}
	let mut dotted = false;
	while at + 1 < end && src[at] == 0x2e && domain_char(src[at + 1]) {
		dotted = true;
		at += 2;
		while at < end && domain_char(src[at]) {
			at += 1;
		}
	}
	dotted.then_some(at)
}

/// Monotonic root searches: a cached stop is searched again only after it is
/// passed.
#[derive(Default)]
pub(super) struct RootTextStops {
	token_char:    Option<usize>,
	scheme:        Option<usize>,
	scheme_end:    usize,
	mail:          Option<usize>,
	mail_at:       usize,
	hard_break:    Option<usize>,
	hard_break_at: usize,
}
impl RootTextStops {
	fn token_char_from(&mut self, src: &[u16], from: usize) -> usize {
		if self.token_char.is_none_or(|at| at < from) {
			self.token_char = Some(
				src.get(from..)
					.and_then(|rest| {
						rest.iter().position(|&unit| {
							matches!(unit, 0x5c | 0x60 | 0x3c | 0x5b | 0x21 | 0x2a | 0x5f | 0x7e | 0x0a)
						})
					})
					.map_or(usize::MAX, |at| at + from),
			);
		}
		self.token_char.unwrap()
	}

	fn scheme_from(&mut self, src: &[u16], from: usize, end: usize) -> usize {
		if self.scheme.is_none_or(|at| at < from) {
			self.scheme = Some(usize::MAX);
			self.scheme_end = usize::MAX;
			for at in from..src.len() {
				if let Some(width) = scheme_width(src, at, src.len()) {
					self.scheme = Some(at);
					self.scheme_end = at + width;
					break;
				}
			}
		}
		if self.scheme_end <= end {
			self.scheme.unwrap()
		} else {
			usize::MAX
		}
	}

	fn mail_from(&mut self, src: &[u16], from: usize, end: usize) -> usize {
		if self.mail.is_none_or(|at| at < from) {
			if self.mail.is_some() && from < self.mail_at {
				self.mail = Some(from);
			} else {
				self.mail = Some(usize::MAX);
				for at in from.saturating_add(1)..src.len() {
					if src[at] != 0x40 {
						continue;
					}
					let mut start = at;
					while start > from && mail_local(src[start - 1]) {
						start -= 1;
					}
					if start < at {
						self.mail_at = at;
						self.mail = Some(start);
						break;
					}
				}
			}
		}
		if self.mail_at < end {
			self.mail.unwrap()
		} else {
			usize::MAX
		}
	}

	fn hard_break_from(&mut self, src: &[u16], from: usize, end: usize) -> usize {
		if self.hard_break.is_none_or(|at| at < from) {
			self.hard_break = Some(usize::MAX);
			for at in from.saturating_add(1)..src.len() {
				if src[at] != 0x0a {
					continue;
				}
				let mut start = at;
				while start > from && src[start - 1] == 0x20 {
					start -= 1;
				}
				if at - start < 2 {
					if src[at - 1] != 0x5c {
						continue;
					}
					start = at - 1;
				}
				self.hard_break_at = at;
				self.hard_break = Some(start);
				break;
			}
		}
		if self.hard_break_at < end {
			self.hard_break.unwrap()
		} else {
			usize::MAX
		}
	}
}

/// Each nested source has its own bounded domain check, but shares every root
/// search.
#[derive(Default)]
pub(super) struct TextStops {
	domain_at:     Option<usize>,
	dotted_domain: bool,
}
impl TextStops {
	pub fn bare_url_can_start(
		&mut self,
		root: &mut RootTextStops,
		src: &[u16],
		pos: usize,
		end: usize,
	) -> bool {
		if root.scheme_from(src, pos, end) == pos {
			return true;
		}
		if root.mail_from(src, pos, end) != pos {
			return false;
		}
		if self.domain_at != Some(root.mail_at) {
			self.domain_at = Some(root.mail_at);
			self.dotted_domain = dotted_domain(src, root.mail_at + 1, end).is_some();
		}
		self.dotted_domain
	}

	pub fn text_length(root: &mut RootTextStops, src: &[u16], pos: usize, end: usize) -> usize {
		let from = pos + 1;
		end.min(root.token_char_from(src, from))
			.min(root.scheme_from(src, from, end))
			.min(root.mail_from(src, from, end))
			.min(root.hard_break_from(src, from, end))
			- pos
	}
}

/// The run keeps source ranges, rather than rereading a growing raw string.
/// Rust's owned token strings append only the newly covered slice (amortized
/// growth), the equivalent of JS extending a flat source slice without copying
/// the entire previous token at each unsuccessful delimiter.
#[derive(Default)]
pub(super) struct TextRun {
	token: Option<usize>,
	start: usize,
	end:   usize,
}
impl TextRun {
	pub fn append(&mut self, tokens: &mut Vec<Token>, src: &Source<'_>, start: usize, end: usize) {
		if end <= start {
			return;
		}
		if let Some(previous) = tokens.last_mut()
			&& matches!(previous.kind, TokenKind::Text)
			&& previous.children.is_none()
		{
			let raw = src.slice(start, end);
			previous.raw.push_str(raw);
			previous.text.push_str(raw);
			if self.token == Some(tokens.len() - 1) && start == self.end {
				self.end = end;
			}
			return;
		}
		self.token = Some(tokens.len());
		self.start = start;
		self.end = end;
		let raw = src.slice(self.start, self.end).to_owned();
		tokens.push(Token { kind: TokenKind::Text, text: raw.clone(), raw, ..Token::default() });
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn schemes_and_mail_matches_stay_inside_nested_end() {
		let source = Source::new("www.x a@b.c");
		let mut root = RootTextStops::default();
		let mut nested = TextStops::default();
		assert!(!nested.bare_url_can_start(&mut root, &source.units, 0, 3));
		assert!(nested.bare_url_can_start(&mut root, &source.units, 0, 5));
		assert!(!nested.bare_url_can_start(&mut root, &source.units, 6, 9));
		assert!(TextStops::default().bare_url_can_start(&mut root, &source.units, 6, source.len()));
	}
}
