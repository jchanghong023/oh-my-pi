//! JavaScript bindings for Markdown import.

use std::path::Path;

use napi::{Env, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use pi_wiki::import as core;

use super::database::{WikiError, WikiErrorNapi};
use crate::task;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct WikiMarkdownSection {
	pub ordinal:       i64,
	pub heading_path:  Vec<String>,
	pub heading_level: i64,
	pub line_start:    i64,
	pub line_end:      i64,
	pub byte_start:    i64,
	pub byte_end:      i64,
	pub raw_markdown:  String,
	pub plain_text:    String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct WikiMarkdownDocument {
	pub relative_path: String,
	pub title:         String,
	pub source_kind:   String,
	pub sha256:        String,
	pub size_bytes:    i64,
	pub mtime_ms:      f64,
	pub sections:      Vec<WikiMarkdownSection>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct WikiParsedMarkdown {
	pub title:    Option<String>,
	pub sections: Vec<WikiMarkdownSection>,
}

impl From<core::WikiMarkdownSection> for WikiMarkdownSection {
	fn from(value: core::WikiMarkdownSection) -> Self {
		Self {
			ordinal:       value.ordinal,
			heading_path:  value.heading_path,
			heading_level: value.heading_level,
			line_start:    value.line_start,
			line_end:      value.line_end,
			byte_start:    value.byte_start,
			byte_end:      value.byte_end,
			raw_markdown:  value.raw_markdown,
			plain_text:    value.plain_text,
		}
	}
}

impl From<core::WikiMarkdownDocument> for WikiMarkdownDocument {
	fn from(value: core::WikiMarkdownDocument) -> Self {
		Self {
			relative_path: value.relative_path,
			title:         value.title,
			source_kind:   value.source_kind,
			sha256:        value.sha256,
			size_bytes:    value.size_bytes,
			mtime_ms:      value.mtime_ms,
			sections:      value.sections.into_iter().map(Into::into).collect(),
		}
	}
}

impl From<core::WikiParsedMarkdown> for WikiParsedMarkdown {
	fn from(value: core::WikiParsedMarkdown) -> Self {
		Self { title: value.title, sections: value.sections.into_iter().map(Into::into).collect() }
	}
}

#[napi]
pub fn wiki_parse_markdown(env: Env, bytes: Uint8Array) -> napi::Result<WikiParsedMarkdown> {
	core::parse_markdown(&bytes)
		.map(Into::into)
		.map_err(|error| error.into_napi(env))
}

#[napi(ts_return_type = "Promise<string[]>")]
pub fn wiki_enumerate_markdown_files(root: String) -> task::MappedPromise<Vec<String>, WikiError> {
	task::blocking_mapped(
		"wiki_enumerate_markdown",
		(),
		|env, error| error.into_napi(env),
		|_, _| napi::Error::from_reason("The operation was aborted"),
		move |_| core::enumerate_markdown_files(Path::new(&root), &|| Ok(())),
	)
}

#[napi(ts_return_type = "Promise<WikiMarkdownDocument>")]
pub fn wiki_read_markdown_document(
	root: String,
	relative: String,
) -> task::MappedPromise<WikiMarkdownDocument, WikiError> {
	task::blocking_mapped(
		"wiki_read_markdown",
		(),
		|env, error| error.into_napi(env),
		|_, _| napi::Error::from_reason("The operation was aborted"),
		move |_| {
			core::read_markdown_document(Path::new(&root), &relative, &|| Ok(())).map(Into::into)
		},
	)
}

#[napi(ts_return_type = "'content' | 'heading-only' | 'stub'")]
pub fn wiki_section_shape(markdown: String) -> &'static str {
	core::section_shape_label(&markdown)
}

#[napi]
pub fn wiki_truncate_heading(text: String, max_chars: Option<u32>) -> String {
	core::truncate_heading(&text, max_chars.map_or(300, |value| value as usize))
}

#[napi]
pub fn wiki_normalize_plain_text(
	markdown: String,
	fence_prefix: Option<String>,
	continues_line: Option<bool>,
) -> String {
	core::normalize_plain_text(&markdown, fence_prefix, continues_line.unwrap_or(false))
}
