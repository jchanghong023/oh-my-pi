//! Versioned, query-independent derived data. Raw source exists only while
//! building.
use std::{collections::HashMap, ops::Range};

use serde::{Deserialize, Serialize};

use super::{
	database::WikiError,
	markdown,
	query::{self, LiteralMatcher, SectionContext},
};

type Check<'a> = &'a dyn Fn() -> Result<(), WikiError>;
const VERSION: u32 = 1;

pub(super) struct ProjectionSection<'a> {
	pub section_id:   i64,
	pub document_id:  i64,
	pub byte_start:   i64,
	pub byte_end:     i64,
	pub raw_markdown: &'a str,
}

#[derive(Serialize, Deserialize)]
pub(super) struct PreparedContext {
	fence_prefix:   Option<String>,
	continues_line: bool,
	before:         String,
	after:          String,
	shape:          query::Shape,
}

impl PreparedContext {
	pub(super) fn context(&self) -> SectionContext {
		SectionContext {
			fence_prefix:   self.fence_prefix.clone(),
			continues_line: self.continues_line,
			before:         self.before.clone().into(),
			after:          self.after.clone().into(),
			shape:          self.shape,
		}
	}
}

#[derive(Serialize, Deserialize)]
pub(super) struct SectionProjection {
	pub section_id:     i64,
	pub plain:          String,
	pub title:          String,
	pub shape:          query::Shape,
	pub legacy_context: Option<PreparedContext>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct DocumentProjection {
	version:      u32,
	pub sections: Vec<SectionProjection>,
	groups:       Vec<NameGroup>,
}

/// Linear runs support byte translation; nonlinear runs map every output byte
/// back to the whole input normalization sequence (including removed syntax).
#[derive(Serialize, Deserialize)]
struct ProvenanceRun {
	normalized: Range<usize>,
	source:     Range<usize>,
	linear:     bool,
}

#[derive(Default, Serialize, Deserialize)]
struct NameTrack {
	text: String,
	runs: Vec<ProvenanceRun>,
}

impl NameTrack {
	fn prepare(
		source: &str,
		ignored: &[Range<usize>],
		base: usize,
		check: Check<'_>,
	) -> Result<Self, WikiError> {
		let mut track = Self::default();
		query::visit_normalized_source(source, ignored, check, |character, range, linear| {
			let start = track.text.len();
			track.text.push(character);
			let end = track.text.len();
			let range = range.start + base..range.end + base;
			if let Some(previous) = track.runs.last_mut()
				&& ((linear && previous.linear && previous.source.end == range.start)
					|| (!linear && !previous.linear && previous.source == range))
			{
				previous.normalized.end = end;
				previous.source.end = range.end;
			} else {
				track
					.runs
					.push(ProvenanceRun { normalized: start..end, source: range, linear });
			}
			true
		})?;
		Ok(track)
	}

	fn source_range(&self, found: Range<usize>) -> Range<usize> {
		let first = &self.runs[self
			.runs
			.partition_point(|run| run.normalized.end <= found.start)];
		let last = &self.runs[self
			.runs
			.partition_point(|run| run.normalized.end < found.end)];
		let start = if first.linear {
			first.source.start + found.start - first.normalized.start
		} else {
			first.source.start
		};
		let end = if last.linear {
			last.source.start + found.end - last.normalized.start
		} else {
			last.source.end
		};
		start..end
	}

	fn matches(
		&self,
		name: &LiteralMatcher,
		check: Check<'_>,
		mut matched: impl FnMut(Range<usize>) -> bool,
	) -> Result<bool, WikiError> {
		name.normalized_matches(&self.text, check, |found| matched(self.source_range(found)))
	}
}

#[derive(Serialize, Deserialize)]
struct DestinationTrack {
	start: usize,
	track: NameTrack,
}

#[derive(Serialize, Deserialize)]
struct NameGroup {
	source_len:   usize,
	sections:     Vec<(i64, Range<usize>)>,
	main:         NameTrack,
	destinations: Vec<DestinationTrack>,
}

impl NameGroup {
	fn prepare(
		mut sections: Vec<(i64, Range<usize>)>,
		source: &str,
		check: Check<'_>,
	) -> Result<Self, WikiError> {
		sections.sort_unstable_by_key(|(_, range)| range.start);
		let (ignored, destinations) = query::name_source_syntax(source);
		let main = NameTrack::prepare(source, &ignored, 0, check)?;
		let destinations = destinations
			.into_iter()
			.map(|range| {
				Ok(DestinationTrack {
					start: range.start,
					track: NameTrack::prepare(&source[range.clone()], &[], range.start, check)?,
				})
			})
			.collect::<Result<Vec<_>, WikiError>>()?;
		Ok(Self { source_len: source.len(), sections, main, destinations })
	}

	fn matches(
		&self,
		name: &LiteralMatcher,
		check: Check<'_>,
		mut matched: impl FnMut(Range<usize>) -> bool,
	) -> Result<(), WikiError> {
		let mut destinations = self.destinations.iter().peekable();
		let mut error = None;
		let mut active = true;
		self.main.matches(name, check, |found| {
			while let Some(destination) = destinations.peek()
				&& destination.start < found.start
			{
				let destination = destinations.next().expect("peeked destination");
				match destination.track.matches(name, check, &mut matched) {
					Ok(true) => {},
					Ok(false) => {
						active = false;
						return false;
					},
					Err(failure) => {
						error = Some(failure);
						active = false;
						return false;
					},
				}
			}
			active = matched(found);
			active
		})?;
		if let Some(error) = error {
			return Err(error);
		}
		if active {
			for destination in destinations {
				if !destination.track.matches(name, check, &mut matched)? {
					break;
				}
			}
		}
		Ok(())
	}
}

impl DocumentProjection {
	/// Validate persisted bounds before any query kind consumes derived fields.
	pub(super) fn validate(&self) -> Result<(), WikiError> {
		let invalid = || WikiError::message("Invalid documentation projection payload");
		if self.version != VERSION {
			return Err(WikiError::message("Unsupported documentation projection version"));
		}
		for group in &self.groups {
			let source_len = group.source_len;
			if group.sections.is_empty()
				|| group
					.sections
					.iter()
					.any(|(_, range)| range.start > range.end || range.end > source_len)
				|| group
					.sections
					.windows(2)
					.any(|pair| pair[0].1.start > pair[1].1.start)
			{
				return Err(invalid());
			}
			let validate_track = |track: &NameTrack, minimum: usize| {
				let mut end = 0;
				let mut source_end = minimum;
				for run in &track.runs {
					if run.normalized.start != end
						|| run.normalized.start >= run.normalized.end
						|| run.normalized.end > track.text.len()
						|| !track.text.is_char_boundary(run.normalized.start)
						|| !track.text.is_char_boundary(run.normalized.end)
						|| run.source.start < source_end
						|| run.source.start >= run.source.end
						|| run.source.end > group.source_len
						|| (run.linear && run.source.len() != run.normalized.len())
					{
						return Err(invalid());
					}
					end = run.normalized.end;
					source_end = run.source.end;
				}
				if end != track.text.len() {
					return Err(invalid());
				}
				Ok(())
			};
			validate_track(&group.main, 0)?;
			let mut previous = 0;
			for destination in &group.destinations {
				if destination.start < previous || destination.start > group.source_len {
					return Err(invalid());
				}
				validate_track(&destination.track, destination.start)?;
				previous = destination.start;
			}
		}
		Ok(())
	}

	pub(super) fn exact_names(
		&self,
		name: &LiteralMatcher,
		check: Check<'_>,
	) -> Result<HashMap<i64, bool>, WikiError> {
		if self.version != VERSION {
			return Err(WikiError::message("Unsupported documentation projection version"));
		}
		let mut result = HashMap::new();
		for group in &self.groups {
			check()?;
			for (id, _) in &group.sections {
				result.insert(*id, false);
			}
			let mut pending = group.sections.iter().peekable();
			group.matches(name, check, |found| {
				while let Some((id, range)) = pending.peek()
					&& range.start < found.end
				{
					if range.end > found.start {
						result.insert(*id, true);
					}
					pending.next();
				}
				pending.peek().is_some()
			})?;
		}
		Ok(result)
	}
}

pub(super) fn prepare_document(
	sections: &[ProjectionSection<'_>],
	check: Check<'_>,
) -> Result<DocumentProjection, WikiError> {
	check()?;
	let contexts = markdown::contexts(sections.iter().map(|section| markdown::ContextSection {
		section_id:   section.section_id,
		document_id:  section.document_id,
		byte_start:   section.byte_start,
		byte_end:     section.byte_end,
		raw_markdown: section.raw_markdown,
	}));
	let mut projected = Vec::with_capacity(sections.len());
	for (section, (_, context)) in sections.iter().zip(contexts) {
		check()?;
		let tokens = markdown::lex_section(section.raw_markdown, &context);
		let plain = query::normalize_search_text(&markdown::plain_text(&tokens));
		let title =
			query::normalize_search_text(&markdown::local_title(section.raw_markdown, &context));
		let legacy = section.byte_end.checked_sub(section.byte_start)
			!= Some(section.raw_markdown.len() as i64);
		let legacy_context = legacy.then(|| PreparedContext {
			fence_prefix:   context.fence_prefix,
			continues_line: context.continues_line,
			before:         context.before.to_string(),
			after:          context.after.to_string(),
			shape:          context.shape,
		});
		projected.push(SectionProjection {
			section_id: section.section_id,
			plain,
			title,
			shape: context.shape,
			legacy_context,
		});
	}
	let mut groups = Vec::new();
	let mut source = String::new();
	let mut start = 0i64;
	let mut pending = Vec::new();
	let mut document_id = None;
	for section in sections {
		check()?;
		let valid = section.byte_end.checked_sub(section.byte_start)
			== Some(section.raw_markdown.len() as i64);
		let offset = section
			.byte_start
			.checked_sub(start)
			.and_then(|offset| usize::try_from(offset).ok());
		let contiguous = document_id == Some(section.document_id)
			&& offset.is_some_and(|offset| {
				if offset > source.len() {
					return false;
				}
				let overlap = (source.len() - offset).min(section.raw_markdown.len());
				source.get(offset..offset + overlap) == section.raw_markdown.get(..overlap)
					&& source.is_char_boundary(offset)
					&& section.raw_markdown.is_char_boundary(overlap)
			});
		if !valid || pending.is_empty() || !contiguous {
			if !pending.is_empty() {
				groups.push(NameGroup::prepare(std::mem::take(&mut pending), &source, check)?);
			}
			source.clear();
			start = section.byte_start;
			document_id = Some(section.document_id);
		}
		if !valid {
			continue;
		}
		let offset = (section.byte_start - start) as usize;
		let overlap = (source.len() - offset).min(section.raw_markdown.len());
		source.push_str(&section.raw_markdown[overlap..]);
		pending.push((section.section_id, offset..offset + section.raw_markdown.len()));
	}
	if !pending.is_empty() {
		groups.push(NameGroup::prepare(pending, &source, check)?);
	}
	check()?;
	Ok(DocumentProjection { version: VERSION, sections: projected, groups })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn check() -> Result<(), WikiError> {
		Ok(())
	}

	#[test]
	fn prepared_name_tracks_preserve_source_order_and_exact_spans() {
		let cases = [
			"scan **scan** s**ca**n `scan` ~~scan~~ _scan_ s\\can",
			"[scan](scan) [s**ca**n](dir/scan) ![scan](scan.md) [other](scan)",
			"```text\n**scan** [scan](scan)\n```\n    _scan_\n",
			"<code>scan</code> <https://example/scan> scan::item scan.md xscan scan-x",
			"中文scan中文 scan中文 中文scan /scan \\\\scan C++ C++17 a`C++`17",
			"cafe\u{301} café ＳＣＡＮ ﬃ ffi İ i\u{307} ΑΣ ΑΣΑ Σ ΟΣ\u{301} ΟΣ\u{301}Α",
			"s**ca**n [s**ca**n](scan) s~~ca~~n scan scan",
			"aaa aaaa aa [aaa](aaa) **aaa** 中文中文中 \u{1d6ba} Ο\u{1d6ba}",
		];
		let names = [
			"scan",
			"scan.md",
			"c++",
			"café",
			"ffi",
			"i\u{307}",
			"ας",
			"ασα",
			"σ",
			"ος\u{301}",
			"aa",
			"aaa",
			"中文中",
		];
		for source in cases {
			let group = NameGroup::prepare(vec![(1, 0..source.len())], source, &check).unwrap();
			for name in names {
				for basename in [false, true] {
					let matcher = LiteralMatcher::new(&query::normalize_search_text(name), basename);
					let mut expected = Vec::new();
					matcher
						.source_name_matches(source, &check, |range| {
							expected.push(range);
							true
						})
						.unwrap();
					let mut actual = Vec::new();
					group
						.matches(&matcher, &check, |range| {
							actual.push(range);
							true
						})
						.unwrap();
					assert_eq!(actual, expected, "{source:?}, {name:?}, basename={basename}");
				}
			}
		}
		let source = "s**ca**n";
		let group = NameGroup::prepare(vec![(1, 0..source.len())], source, &check).unwrap();
		let mut spans = Vec::new();
		group
			.matches(&LiteralMatcher::new("scan", true), &check, |range| {
				spans.push(range);
				true
			})
			.unwrap();
		assert_eq!(spans, vec![0..source.len()]);
	}

	#[test]
	fn prepared_scans_preserve_window_edges_and_overlapping_matches() {
		let source = format!(
			"{} aa aaa **aaa** [aaa](aaa) {} scan::item scan 中文scan中文",
			" ".repeat(4094),
			"x ".repeat(5000)
		);
		let group = NameGroup::prepare(vec![(1, 0..source.len())], &source, &check).unwrap();
		for name in ["aa", "aaa", "scan"] {
			let matcher = LiteralMatcher::new(name, true);
			let mut expected = Vec::new();
			matcher
				.source_name_matches(&source, &check, |range| {
					expected.push(range);
					true
				})
				.unwrap();
			let mut actual = Vec::new();
			group
				.matches(&matcher, &check, |range| {
					actual.push(range);
					true
				})
				.unwrap();
			assert_eq!(actual, expected, "{name}");
		}
	}

	#[test]
	fn provenance_compresses_equal_width_scalars_without_losing_expansions() {
		let ascii = NameTrack::prepare(&"ASCII text ".repeat(1000), &[], 0, &check).unwrap();
		assert_eq!(ascii.runs.len(), 1);
		let track = NameTrack::prepare("ﬃİe\u{301}Ａ", &[], 0, &check).unwrap();
		assert_eq!(track.text, "ffii\u{307}éa");
		assert_eq!(track.source_range(0..1), 0..3);
		assert_eq!(track.source_range(1..3), 0..3);
		assert_eq!(track.source_range(3..6), 3..5);
		assert_eq!(track.source_range(6..8), 5..8);
		assert_eq!(track.source_range(8..9), 8..11);
	}

	#[test]
	fn document_projection_keeps_split_overlapping_gapped_and_legacy_rows() {
		let rows = [
			ProjectionSection {
				section_id:   1,
				document_id:  1,
				byte_start:   0,
				byte_end:     3,
				raw_markdown: "s**",
			},
			ProjectionSection {
				section_id:   2,
				document_id:  1,
				byte_start:   3,
				byte_end:     7,
				raw_markdown: "ca**",
			},
			ProjectionSection {
				section_id:   3,
				document_id:  1,
				byte_start:   7,
				byte_end:     8,
				raw_markdown: "n",
			},
			ProjectionSection {
				section_id:   4,
				document_id:  1,
				byte_start:   3,
				byte_end:     8,
				raw_markdown: "ca**n",
			},
			ProjectionSection {
				section_id:   5,
				document_id:  1,
				byte_start:   20,
				byte_end:     22,
				raw_markdown: "sc",
			},
			ProjectionSection {
				section_id:   6,
				document_id:  1,
				byte_start:   30,
				byte_end:     32,
				raw_markdown: "an",
			},
			ProjectionSection {
				section_id:   7,
				document_id:  1,
				byte_start:   0,
				byte_end:     0,
				raw_markdown: "scan",
			},
			ProjectionSection {
				section_id:   8,
				document_id:  1,
				byte_start:   40,
				byte_end:     44,
				raw_markdown: "scan",
			},
		];
		let projection = prepare_document(&rows, &check).unwrap();
		let bytes = serde_json::to_vec(&projection).unwrap();
		let projection: DocumentProjection = serde_json::from_slice(&bytes).unwrap();
		projection.validate().unwrap();
		let names = projection
			.exact_names(&LiteralMatcher::new("scan", true), &check)
			.unwrap();
		assert_eq!(
			names,
			HashMap::from([
				(1, true),
				(2, true),
				(3, true),
				(4, true),
				(5, false),
				(6, false),
				(8, true)
			])
		);
		assert!(projection.sections[6].legacy_context.is_some());
		assert!(
			projection
				.sections
				.iter()
				.enumerate()
				.all(|(index, section)| index == 6 || section.legacy_context.is_none())
		);
		let contexts = markdown::contexts(rows.iter().map(|row| markdown::ContextSection {
			section_id:   row.section_id,
			document_id:  row.document_id,
			byte_start:   row.byte_start,
			byte_end:     row.byte_end,
			raw_markdown: row.raw_markdown,
		}));
		for ((row, (_, context)), prepared) in rows.iter().zip(contexts).zip(&projection.sections) {
			assert_eq!(
				prepared.plain,
				query::normalize_search_text(&markdown::plain_text(&markdown::lex_section(
					row.raw_markdown,
					&context
				)))
			);
			assert_eq!(
				prepared.title,
				query::normalize_search_text(&markdown::local_title(row.raw_markdown, &context))
			);
			assert_eq!(prepared.shape, context.shape);
		}
	}

	#[test]
	fn corrupt_version_and_provenance_are_rejected_before_matching() {
		let rows = [ProjectionSection {
			section_id:   1,
			document_id:  1,
			byte_start:   0,
			byte_end:     4,
			raw_markdown: "scan",
		}];
		let mut projection = prepare_document(&rows, &check).unwrap();
		projection.validate().unwrap();
		projection.version += 1;
		assert!(projection.validate().is_err());
		projection.version = VERSION;
		projection.groups[0].main.runs[0].normalized.end = usize::MAX;
		assert!(projection.validate().is_err());
		projection.groups[0].main.runs.clear();
		assert!(projection.validate().is_err());
	}
}
