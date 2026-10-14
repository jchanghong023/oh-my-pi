use std::{collections::HashMap, sync::LazyLock};

use regex::Regex;

/// UTF-16 offsets are the parser's offsets. The byte map is built once per
/// root, never per delimiter, and all emitted ranges end at scalar boundaries.
pub(super) struct Source<'a> {
	pub text:  &'a str,
	pub units: Vec<u16>,
	bytes:     Vec<usize>,
}

impl<'a> Source<'a> {
	pub fn new(text: &'a str) -> Self {
		let mut units = Vec::with_capacity(text.len());
		let mut bytes = Vec::with_capacity(text.len() + 1);
		for (at, ch) in text.char_indices() {
			let mut encoded = [0; 2];
			for &unit in ch.encode_utf16(&mut encoded).iter() {
				units.push(unit);
				bytes.push(at);
			}
		}
		bytes.push(text.len());
		Self { text, units, bytes }
	}

	pub const fn len(&self) -> usize {
		self.units.len()
	}

	pub fn slice(&self, start: usize, end: usize) -> &'a str {
		&self.text[self.bytes[start]..self.bytes[end]]
	}
}

pub(super) const fn whitespace(unit: u16) -> bool {
	matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

pub(super) fn punctuation(unit: u16) -> bool {
	unit < 128 && b"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".contains(&(unit as u8))
}

fn letter_number(unit: u16) -> bool {
	// JS indexes one UTF-16 code unit before applying the Unicode regexp: a
	// surrogate neighbor is NOT a letter even when its scalar is astral L/N.
	let Some(ch) = char::from_u32(u32::from(unit)) else {
		return false;
	};
	static CATEGORY: LazyLock<Regex> =
		LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}]$").expect("static Unicode category regexp"));
	let mut buffer = [0; 4];
	CATEGORY.is_match(ch.encode_utf8(&mut buffer))
}

pub(super) const fn escaped_at(src: &[u16], index: usize) -> bool {
	let mut at = index;
	while at > 0 && src[at - 1] == 0x5c {
		at -= 1;
	}
	(index - at) % 2 == 1
}

pub(super) fn can_open(
	src: &[u16],
	index: usize,
	width: usize,
	marker: u16,
	previous: u16,
) -> bool {
	let before = if index == 0 { previous } else { src[index - 1] };
	if index == 0 && before == marker {
		return false;
	}
	let Some(&after) = src.get(index + width) else {
		return false;
	};
	if whitespace(after) {
		return false;
	}
	!(marker == 0x5f && letter_number(before) && letter_number(after))
}

pub(super) fn can_close(src: &[u16], index: usize, marker: u16) -> bool {
	let Some(&before) = index.checked_sub(1).and_then(|at| src.get(at)) else {
		return false;
	};
	let after = src.get(index + 1).copied().unwrap_or(0x0a);
	if whitespace(before) {
		return false;
	}
	if marker == 0x5f && letter_number(before) && letter_number(after) {
		return false;
	}
	!punctuation(before) || whitespace(after) || punctuation(after)
}

fn lower_bound(values: &[usize], target: usize) -> usize {
	values.partition_point(|&value| value < target)
}

#[derive(Default)]
struct ClosersByDepth(HashMap<i32, Vec<usize>>);
impl ClosersByDepth {
	fn add(&mut self, depth: i32, offset: usize) {
		self.0.entry(depth).or_default().push(offset);
	}

	fn first(&self, depth: i32, from: usize) -> Option<usize> {
		let offsets = self.0.get(&depth)?;
		offsets.get(lower_bound(offsets, from)).copied()
	}
}

struct BracketDepths {
	depth:   Vec<i32>,
	closers: ClosersByDepth,
	all:     Vec<usize>,
}
impl BracketDepths {
	fn new(src: &[u16], open: u16, close: u16) -> Self {
		let mut depth = vec![0; src.len() + 1];
		let mut closers = ClosersByDepth::default();
		let mut all = Vec::new();
		let mut level = 0;
		let mut i = 0;
		while i < src.len() {
			depth[i] = level;
			if src[i] == 0x5c {
				i += 1;
				depth[i] = level;
			} else if src[i] == open {
				level += 1;
			} else if src[i] == close {
				closers.add(level, i);
				all.push(i);
				level -= 1;
			}
			i += 1;
		}
		depth[src.len()] = level;
		Self { depth, closers, all }
	}

	fn close_after(&self, start: usize) -> Option<usize> {
		self.closers.first(self.depth[start], start)
	}

	fn closes_within(&self, from: usize, to: usize) -> bool {
		self
			.all
			.get(lower_bound(&self.all, from))
			.is_some_and(|&at| at < to)
	}
}

struct EmphasisDelimiters {
	marker:  u16,
	width:   usize,
	at:      Vec<usize>,
	depth:   Vec<i32>,
	closers: ClosersByDepth,
}
impl EmphasisDelimiters {
	fn new(src: &[u16], marker: u16, width: usize) -> Self {
		let mut result = Self {
			marker,
			width,
			at: Vec::new(),
			depth: Vec::new(),
			closers: ClosersByDepth::default(),
		};
		let mut level = 0;
		let mut run = 0;
		while run < src.len() {
			if src[run] != marker {
				run += 1;
				continue;
			}
			let mut end = run + 1;
			while src.get(end) == Some(&marker) {
				end += 1;
			}
			let mut at = if escaped_at(src, run) {
				run + width
			} else {
				run
			};
			while at + width <= end {
				result.at.push(at);
				result.depth.push(level);
				if can_close(src, at, marker) {
					result.closers.add(level, at);
					level -= 1;
				} else if can_open(src, at, width, marker, 0x0a) {
					level += 1;
				}
				at += width;
			}
			run = end;
		}
		result
	}

	fn close_for(&self, src: &[u16], opener: usize, end: usize) -> Option<usize> {
		let walk = opener + self.width;
		if self.width == 2
			&& src.get(walk) == Some(&self.marker)
			&& src.get(walk + 1) == Some(&self.marker)
		{
			return (walk + self.width <= end).then_some(walk);
		}
		let next = lower_bound(&self.at, walk);
		let &at = self.at.get(next)?;
		let close = self.closers.first(self.depth[next], at)?;
		(close + self.width <= end).then_some(close)
	}
}

struct CodeRuns {
	starts:  Vec<usize>,
	ends:    Vec<usize>,
	escaped: Vec<bool>,
	widest:  Vec<usize>,
	leaves:  usize,
}
impl CodeRuns {
	fn new(src: &[u16]) -> Self {
		let mut starts = Vec::new();
		let mut ends = Vec::new();
		let mut escaped = Vec::new();
		let mut widths = Vec::new();
		let mut at = 0;
		while at < src.len() {
			if src[at] != 0x60 {
				at += 1;
				continue;
			}
			let mut end = at + 1;
			while src.get(end) == Some(&0x60) {
				end += 1;
			}
			let escape = escaped_at(src, at);
			starts.push(at);
			ends.push(end);
			escaped.push(escape);
			widths.push(if escape { (end - at) >> 1 } else { end - at });
			at = end;
		}
		let leaves = widths.len().max(1).next_power_of_two();
		let mut widest = vec![0; 2 * leaves];
		widest[leaves..leaves + widths.len()].copy_from_slice(&widths);
		for node in (1..leaves).rev() {
			widest[node] = widest[2 * node].max(widest[2 * node + 1]);
		}
		Self { starts, ends, escaped, widest, leaves }
	}

	fn end_of(&self, at: usize) -> usize {
		self.ends[lower_bound(&self.starts, at + 1) - 1]
	}

	fn closer_after(&self, from: usize, width: usize) -> Option<usize> {
		let run = self.first_holding(lower_bound(&self.starts, from), width)?;
		Some(self.starts[run] + if self.escaped[run] { width } else { 0 })
	}

	fn first_holding(&self, first: usize, width: usize) -> Option<usize> {
		if first >= self.starts.len() {
			return None;
		}
		let mut node = self.leaves + first;
		if self.widest[node] >= width {
			return Some(first);
		}
		loop {
			if node == 1 {
				return None;
			}
			if node & 1 == 0 && self.widest[node + 1] >= width {
				break;
			}
			node >>= 1;
		}
		node += 1;
		while node < self.leaves {
			node = if self.widest[2 * node] >= width {
				2 * node
			} else {
				2 * node + 1
			};
		}
		Some(node - self.leaves)
	}
}

/// One set of lazy indexes per root source, shared by links and emphasis.
#[derive(Default)]
pub(super) struct CloserIndexes {
	square:       Option<BracketDepths>,
	round:        Option<BracketDepths>,
	emphasis:     HashMap<(u16, usize), EmphasisDelimiters>,
	tag_ends:     Option<Vec<Option<usize>>>,
	comment_ends: Option<Vec<usize>>,
	escapes:      Option<Vec<usize>>,
	code_runs:    Option<CodeRuns>,
	space:        Option<usize>,
	angle:        Option<usize>,
}
impl CloserIndexes {
	pub fn close_square(&mut self, src: &[u16], start: usize, end: usize) -> Option<usize> {
		self
			.square
			.get_or_insert_with(|| BracketDepths::new(src, 0x5b, 0x5d))
			.close_after(start)
			.filter(|&at| at < end)
	}

	pub fn close_round(&mut self, src: &[u16], start: usize, end: usize) -> Option<usize> {
		self
			.round
			.get_or_insert_with(|| BracketDepths::new(src, 0x28, 0x29))
			.close_after(start)
			.filter(|&at| at < end)
	}

	pub fn square_closer_within(&mut self, src: &[u16], from: usize, to: usize) -> bool {
		self
			.square
			.get_or_insert_with(|| BracketDepths::new(src, 0x5b, 0x5d))
			.closes_within(from, to)
	}

	pub fn escape_within(&mut self, src: &[u16], from: usize, to: usize) -> bool {
		let escapes = self.escapes.get_or_insert_with(|| {
			src.iter()
				.enumerate()
				.filter_map(|(at, &unit)| {
					(unit == 0x5c && src.get(at + 1).is_some_and(|&next| punctuation(next)))
						.then_some(at)
				})
				.collect()
		});
		escapes
			.get(lower_bound(escapes, from))
			.is_some_and(|&at| at + 1 < to)
	}

	pub fn close_emphasis(
		&mut self,
		src: &[u16],
		pos: usize,
		end: usize,
		marker: u16,
		width: usize,
	) -> Option<usize> {
		self
			.emphasis
			.entry((marker, width))
			.or_insert_with(|| EmphasisDelimiters::new(src, marker, width))
			.close_for(src, pos, end)
	}

	pub fn code_opener_width(&mut self, src: &[u16], pos: usize, end: usize) -> usize {
		self
			.code_runs
			.get_or_insert_with(|| CodeRuns::new(src))
			.end_of(pos)
			.min(end)
			- pos
	}

	pub fn close_code(
		&mut self,
		src: &[u16],
		pos: usize,
		end: usize,
		width: usize,
	) -> Option<usize> {
		self
			.code_runs
			.get_or_insert_with(|| CodeRuns::new(src))
			.closer_after(pos + width, width)
			.filter(|&at| at + width <= end)
	}

	pub fn close_url_autolink(&mut self, src: &[u16], from: usize, end: usize) -> Option<usize> {
		let space = self.space.get_or_insert(0);
		if *space < from {
			*space = src[from..]
				.iter()
				.position(|&unit| unit == 0x20)
				.map_or(usize::MAX, |at| at + from);
		}
		let angle = self.angle.get_or_insert(0);
		if *angle < from {
			*angle = src[from..]
				.iter()
				.position(|&unit| unit == 0x3e)
				.map_or(usize::MAX, |at| at + from);
		}
		let close = (*space).min(*angle);
		(close > from && close < end && src[close] == 0x3e).then_some(close)
	}

	pub fn close_tag(&mut self, src: &[u16], pos: usize, end: usize) -> Option<usize> {
		let ends = self.tag_ends.get_or_insert_with(|| {
			let mut ends = vec![None; src.len() + 1];
			let mut double = None;
			let mut single = None;
			for at in (0..src.len()).rev() {
				ends[at] = match src[at] {
					0x3e => Some(at),
					0x22 => {
						let found = double.and_then(|next: usize| ends[next + 1]);
						double = Some(at);
						found
					},
					0x27 => {
						let found = single.and_then(|next: usize| ends[next + 1]);
						single = Some(at);
						found
					},
					_ => ends[at + 1],
				};
			}
			ends
		});
		ends[pos + 1].filter(|&at| at < end)
	}

	pub fn close_comment(&mut self, src: &[u16], pos: usize, end: usize) -> Option<usize> {
		let ends = self.comment_ends.get_or_insert_with(|| {
			src.windows(3)
				.enumerate()
				.filter_map(|(at, units)| (units == [0x2d, 0x2d, 0x3e]).then_some(at))
				.collect()
		});
		ends
			.get(lower_bound(ends, pos + 4))
			.copied()
			.filter(|&at| at + 3 <= end)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn underscore_checks_single_utf16_neighbors() {
		let astral = Source::new("𐐀_x_𐐀");
		assert!(can_open(&astral.units, 2, 1, 0x5f, 0x0a));
		assert!(can_close(&astral.units, 4, 0x5f));
		let bmp = Source::new("a_x_a");
		assert!(!can_open(&bmp.units, 1, 1, 0x5f, 0x0a));
		assert!(!can_close(&bmp.units, 3, 0x5f));
	}

	#[test]
	fn code_segment_tree_respects_escaped_runs_and_end_bounds() {
		let src = Source::new("``a\\````b``");
		let mut indexes = CloserIndexes::default();
		assert_eq!(indexes.close_code(&src.units, 0, src.len(), 2), Some(6));
		assert_eq!(indexes.close_code(&src.units, 0, 7, 2), None);
	}
}
