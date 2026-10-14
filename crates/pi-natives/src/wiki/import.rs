//! Byte-preserving Markdown import and filesystem traversal.

use std::{
	collections::HashSet,
	fs::{self, File, Metadata, OpenOptions},
	io::Read,
	path::{Path, PathBuf},
	sync::LazyLock,
	time::UNIX_EPOCH,
};

use icu_collator::{CollatorBorrowed, options::CollatorOptions};
use icu_locale_core::locale;
use napi::{Env, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use regex::Regex;
use sha2::{Digest, Sha256};

use super::{
	database::WikiError,
	markdown::{is_js_whitespace, lex_section, plain_text, section_shape, trim_js},
	query::{SectionContext, Shape},
};
use crate::task;

type CoreResult<T> = Result<T, WikiError>;
type Check<'a> = &'a dyn Fn() -> CoreResult<()>;
const MAX_SECTION_CHARS: usize = 18_000;
const CHUNK_OVERLAP_CHARS: usize = 500;
const HEADING_LABEL_MAX_CHARS: usize = 300;
const INVALID_UTF8: &str = "The encoded data was not valid for encoding utf-8";

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

#[derive(Clone, Copy)]
struct SourceLine<'a> {
	text:       &'a str,
	line:       usize,
	byte_start: usize,
	utf16_len:  usize,
}

impl SourceLine<'_> {
	const fn byte_end(self) -> usize {
		self.byte_start + self.text.len()
	}
}

struct Draft {
	heading_path:  Vec<String>,
	heading_level: usize,
	start:         usize,
	end:           usize,
}

#[derive(Clone, Copy)]
struct Fence {
	marker: u8,
	length: usize,
}

struct FenceMatch<'a> {
	fence:    Fence,
	trailing: &'a str,
}

fn parse_fence(line: &str) -> Option<FenceMatch<'_>> {
	// A CR is accepted only as part of a terminal CRLF, exactly like the
	// source regexp; a bare CR and an internal line break invalidate the run.
	let source = line
		.strip_suffix('\n')
		.map_or(line, |line| line.strip_suffix('\r').unwrap_or(line));
	let bytes = source.as_bytes();
	let mut start = 0;
	while start < bytes.len() && start < 3 && bytes[start] == b' ' {
		start += 1;
	}
	let marker = *bytes.get(start)?;
	if !matches!(marker, b'`' | b'~') {
		return None;
	}
	let mut end = start;
	while bytes.get(end) == Some(&marker) {
		end += 1;
	}
	if end - start < 3
		|| bytes[end..]
			.iter()
			.any(|byte| matches!(byte, b'\r' | b'\n'))
	{
		return None;
	}
	Some(FenceMatch { fence: Fence { marker, length: end - start }, trailing: &source[end..] })
}

fn next_fence(fence: Option<Fence>, found: Option<FenceMatch<'_>>) -> Option<Fence> {
	let Some(found) = found else { return fence };
	match fence {
		None if found.fence.marker == b'`' && found.trailing.contains('`') => None,
		None => Some(found.fence),
		Some(current)
			if current.marker == found.fence.marker
				&& found.fence.length >= current.length
				&& found
					.trailing
					.bytes()
					.all(|byte| matches!(byte, b' ' | b'\t')) =>
		{
			None
		},
		Some(current) => Some(current),
	}
}

struct Heading<'a> {
	level:  usize,
	text:   &'a str,
	setext: bool,
}

fn parse_heading<'a>(line: &'a str, next: Option<&str>, in_fence: bool) -> Option<Heading<'a>> {
	if in_fence {
		return None;
	}
	static ATX: LazyLock<Regex> = LazyLock::new(|| {
		Regex::new(r"\A {0,3}(#{1,6})[ \t]+([^\r\n\x{2028}\x{2029}]+?)(?:[ \t]+#+[ \t]*)?\z")
			.expect("static Markdown heading regexp")
	});
	let source = line
		.strip_suffix('\n')
		.map_or(line, |line| line.strip_suffix('\r').unwrap_or(line));
	if let Some(captures) = ATX.captures(source) {
		return Some(Heading {
			level:  captures.get(1).expect("heading marker").len(),
			text:   trim_js(captures.get(2).expect("heading text").as_str()),
			setext: false,
		});
	}
	let next = next?;
	let mut content = line;
	for _ in 0..3 {
		if let Some(rest) = content.strip_prefix(' ') {
			content = rest;
		} else {
			break;
		}
	}
	if content.chars().next().is_none_or(is_js_whitespace) {
		return None;
	}
	// The setext regexp permits a terminal CR with or without LF.
	let underline = next.strip_suffix('\n').unwrap_or(next);
	let underline = underline.strip_suffix('\r').unwrap_or(underline);
	let mut underline = underline;
	for _ in 0..3 {
		if let Some(rest) = underline.strip_prefix(' ') {
			underline = rest;
		} else {
			break;
		}
	}
	let marker = *underline.as_bytes().first()?;
	if !matches!(marker, b'=' | b'-') {
		return None;
	}
	let count = underline.bytes().take_while(|byte| *byte == marker).count();
	if !underline.as_bytes()[count..]
		.iter()
		.all(|byte| matches!(byte, b' ' | b'\t'))
	{
		return None;
	}
	Some(Heading { level: if marker == b'=' { 1 } else { 2 }, text: trim_js(line), setext: true })
}

/// The limit is measured in JavaScript UTF-16 units, not bytes or scalars.
pub(super) fn truncate_heading(text: &str, max_chars: usize) -> String {
	if utf16_len(text) <= max_chars {
		return text.to_owned();
	}
	let end = utf16_prefix_bytes(text, max_chars.saturating_sub(1));
	let mut result = String::with_capacity(end + '…'.len_utf8());
	result.push_str(&text[..end]);
	result.push('…');
	result
}

fn utf16_len(text: &str) -> usize {
	if text.is_ascii() {
		text.len()
	} else {
		text.chars().map(char::len_utf16).sum()
	}
}

/// Largest scalar boundary at or below a UTF-16 unit boundary. This is also
/// JS's surrogate-safe backoff when the boundary falls inside a pair.
fn utf16_prefix_bytes(text: &str, units: usize) -> usize {
	let mut count = 0;
	for (offset, character) in text.char_indices() {
		count += character.len_utf16();
		if count > units {
			return offset;
		}
	}
	text.len()
}

fn normalization(markdown: &str, fence: Option<Fence>, continues_line: bool) -> String {
	let context = SectionContext {
		shape: Shape::Content,
		fence_prefix: fence.map(|fence| (fence.marker as char).to_string().repeat(fence.length)),
		continues_line,
		before: String::new(),
		after: String::new(),
	};
	plain_text(&lex_section(markdown, &context))
}

fn emit_section(
	sections: &mut Vec<WikiMarkdownSection>,
	draft: &Draft,
	first: SourceLine<'_>,
	last: SourceLine<'_>,
	source: &str,
	fence: Option<Fence>,
	continues_line: bool,
) {
	let raw = &source[first.byte_start..last.byte_end()];
	sections.push(WikiMarkdownSection {
		ordinal:       sections.len() as i64,
		heading_path:  draft.heading_path.clone(),
		heading_level: draft.heading_level as i64,
		line_start:    first.line as i64,
		line_end:      last.line as i64,
		byte_start:    first.byte_start as i64,
		byte_end:      last.byte_end() as i64,
		raw_markdown:  raw.to_owned(),
		plain_text:    normalization(raw, fence, continues_line),
	});
}

fn chunk_draft(
	draft: &Draft,
	lines: &[SourceLine<'_>],
	source: &str,
	sections: &mut Vec<WikiMarkdownSection>,
) {
	let lines = &lines[draft.start..draft.end];
	if lines.iter().map(|line| line.utf16_len).sum::<usize>() <= MAX_SECTION_CHARS {
		emit_section(sections, draft, lines[0], lines[lines.len() - 1], source, None, false);
		return;
	}
	let mut fence = None;
	let fences: Vec<_> = lines
		.iter()
		.map(|line| {
			let before = fence;
			let text = if line.byte_start == 0 {
				line.text.strip_prefix('\u{feff}').unwrap_or(line.text)
			} else {
				line.text
			};
			fence = next_fence(fence, parse_fence(text));
			before
		})
		.collect();
	let flush = |start: usize, end: usize, sections: &mut Vec<WikiMarkdownSection>| {
		if start < end {
			emit_section(sections, draft, lines[start], lines[end - 1], source, fences[start], false);
		}
	};
	let mut start = 0;
	let mut chars = 0;
	for (index, line) in lines.iter().copied().enumerate() {
		if line.utf16_len > MAX_SECTION_CHARS {
			flush(start, index, sections);
			let mut consumed_bytes = 0;
			while consumed_bytes < line.text.len() {
				let rest = &line.text[consumed_bytes..];
				let length = utf16_prefix_bytes(rest, MAX_SECTION_CHARS);
				let text = &rest[..length];
				let part = SourceLine {
					text,
					line: line.line,
					byte_start: line.byte_start + consumed_bytes,
					utf16_len: 0,
				};
				emit_section(sections, draft, part, part, source, fences[index], consumed_bytes > 0);
				if length == rest.len() {
					break;
				}
				let advance_units = utf16_len(text) - CHUNK_OVERLAP_CHARS;
				consumed_bytes += utf16_prefix_bytes(text, advance_units);
			}
			start = index + 1;
			chars = 0;
			continue;
		}
		if chars + line.utf16_len > MAX_SECTION_CHARS && start < index {
			let split = (start..index)
				.rev()
				.find(|position| trim_js(lines[*position].text).is_empty())
				.map_or(index, |position| position + 1);
			flush(start, split, sections);
			start = split;
			chars = lines[start..index].iter().map(|line| line.utf16_len).sum();
			if chars + line.utf16_len > MAX_SECTION_CHARS {
				flush(start, index, sections);
				start = index;
				chars = 0;
			}
		}
		chars += line.utf16_len;
	}
	flush(start, lines.len(), sections);
}

pub(super) fn parse_markdown(bytes: &[u8]) -> CoreResult<WikiParsedMarkdown> {
	// Unlike String::from_utf8_lossy, this preserves the fatal TextDecoder
	// failure and keeps the initial BOM in raw Markdown and byte offsets.
	let source = std::str::from_utf8(bytes).map_err(|_| {
		WikiError::named(INVALID_UTF8, "TypeError", Some("ERR_ENCODING_INVALID_ENCODED_DATA"))
	})?;
	let mut byte_start = 0;
	let lines: Vec<_> = source
		.split_inclusive('\n')
		.enumerate()
		.map(|(index, text)| {
			let line = SourceLine { text, line: index + 1, byte_start, utf16_len: utf16_len(text) };
			byte_start += text.len();
			line
		})
		.collect();
	let mut drafts = Vec::new();
	let mut current =
		Draft { heading_path: Vec::new(), heading_level: 0, start: 0, end: 0 };
	let mut heading_path: Vec<Option<String>> = Vec::new();
	let mut fence = None;
	let mut title = None;
	let finish = |draft: Draft, drafts: &mut Vec<Draft>| {
		if draft.start == draft.end {
			return;
		}
		let raw = &source[lines[draft.start].byte_start..lines[draft.end - 1].byte_end()];
		// The first row carries the filename FTS terms, including converter
		// structural labels and whitespace-only documents.
		if drafts.is_empty() || section_shape(raw) != Shape::Stub {
			drafts.push(draft);
		}
	};
	let mut index = 0;
	while index < lines.len() {
		let line = lines[index];
		let source_line = if index == 0 {
			line.text.strip_prefix('\u{feff}').unwrap_or(line.text)
		} else {
			line.text
		};
		let found = parse_fence(source_line);
		let heading = parse_heading(
			source_line,
			lines.get(index + 1).map(|line| line.text),
			fence.is_some() || found.is_some(),
		);
		if let Some(heading) = heading {
			finish(current, &mut drafts);
			heading_path.truncate(heading.level - 1);
			heading_path.resize_with(heading.level, || None);
			heading_path[heading.level - 1] =
				Some(truncate_heading(heading.text, HEADING_LABEL_MAX_CHARS));
			if title.is_none() {
				title = Some(heading.text.to_owned());
			}
			current = Draft {
				heading_path:  heading_path.iter().filter_map(Clone::clone).collect(),
				heading_level: heading.level,
				start:         index,
				end:           index + 1,
			};
			if heading.setext {
				index += 1;
				current.end += 1;
			}
		} else {
			current.end = index + 1;
			fence = next_fence(fence, found);
		}
		index += 1;
	}
	finish(current, &mut drafts);
	let mut sections = Vec::new();
	for draft in drafts {
		chunk_draft(&draft, &lines, source, &mut sections);
	}
	Ok(WikiParsedMarkdown { title, sections })
}

fn io_error(error: std::io::Error, syscall: &str, path: &Path) -> WikiError {
	#[cfg(windows)]
	let error = if syscall == "read" && error.raw_os_error() == Some(5) {
		// libuv normalizes ReadFile's access-denied result to EBADF.
		std::io::Error::from_raw_os_error(windows_sys::Win32::Foundation::ERROR_INVALID_FLAGS as i32)
	} else {
		error
	};
	let (code, description) = system_error(&error);
	let message = if matches!(syscall, "read" | "fstat" | "uv_cwd") {
		format!("{code}: {description}, {syscall}")
	} else {
		format!("{code}: {description}, {syscall} '{}'", path.display())
	};
	WikiError::named(message, "Error", Some(code))
}

fn system_error(error: &std::io::Error) -> (&'static str, &'static str) {
	let code = system_error_code(error);
	let description = match code {
		"E2BIG" => "argument list too long",
		"EACCES" => "permission denied",
		"EAGAIN" => "resource temporarily unavailable",
		"EBADF" => "bad file descriptor",
		"EBUSY" => "resource busy or locked",
		"ECANCELED" => "operation canceled",
		"ECHARSET" => "invalid Unicode character",
		"ECONNABORTED" => "software caused connection abort",
		"ECONNREFUSED" => "connection refused",
		"ECONNRESET" => "connection reset by peer",
		"EEXIST" => "file already exists",
		"EFAULT" => "bad address in system call argument",
		"EFBIG" => "file too large",
		"EHOSTUNREACH" => "host is unreachable",
		"EINTR" => "interrupted system call",
		"EINVAL" => "invalid argument",
		"EIO" => "i/o error",
		"EISDIR" => "illegal operation on a directory",
		"ELOOP" => "too many symbolic links encountered",
		"EMFILE" => "too many open files",
		"ENAMETOOLONG" => "name too long",
		"ENETDOWN" => "network is down",
		"ENETUNREACH" => "network is unreachable",
		"ENFILE" => "file table overflow",
		"ENOBUFS" => "no buffer space available",
		"ENODEV" => "no such device",
		"ENOENT" => "no such file or directory",
		"ENOMEM" => "not enough memory",
		"ENOSPC" => "no space left on device",
		"ENOSYS" => "function not implemented",
		"ENOTCONN" => "socket is not connected",
		"ENOTDIR" => "not a directory",
		"ENOTEMPTY" => "directory not empty",
		"ENOTSUP" => "operation not supported on socket",
		"EOVERFLOW" => "value too large for defined data type",
		"EPERM" => "operation not permitted",
		"EPIPE" => "broken pipe",
		"ERANGE" => "result too large",
		"EROFS" => "read-only file system",
		"ESPIPE" => "invalid seek",
		"ETIMEDOUT" => "connection timed out",
		"ETXTBSY" => "text file is busy",
		"EXDEV" => "cross-device link not permitted",
		"EOF" => "end of file",
		"ENXIO" => "no such device or address",
		"EMLINK" => "too many links",
		"EILSEQ" => "illegal byte sequence",
		_ => "unknown error",
	};
	(code, description)
}

#[cfg(unix)]
fn system_error_code(error: &std::io::Error) -> &'static str {
	macro_rules! codes {
		($($code:ident),* $(,)?) => {
			match error.raw_os_error() {
				$(Some(libc::$code) => stringify!($code),)*
				_ => "UNKNOWN",
			}
		};
	}
	codes!(
		E2BIG,
		EACCES,
		EAGAIN,
		EBADF,
		EBUSY,
		ECANCELED,
		ECONNABORTED,
		ECONNREFUSED,
		ECONNRESET,
		EEXIST,
		EFAULT,
		EFBIG,
		EHOSTUNREACH,
		EINTR,
		EINVAL,
		EIO,
		EISDIR,
		ELOOP,
		EMFILE,
		ENAMETOOLONG,
		ENETDOWN,
		ENETUNREACH,
		ENFILE,
		ENOBUFS,
		ENODEV,
		ENOENT,
		ENOMEM,
		ENOSPC,
		ENOSYS,
		ENOTCONN,
		ENOTDIR,
		ENOTEMPTY,
		ENOTSUP,
		EOVERFLOW,
		EPERM,
		EPIPE,
		ERANGE,
		EROFS,
		ESPIPE,
		ETIMEDOUT,
		ETXTBSY,
		EXDEV,
		ENXIO,
		EMLINK,
		EILSEQ,
	)
}

#[cfg(windows)]
fn system_error_code(error: &std::io::Error) -> &'static str {
	use windows_sys::Win32::Foundation::*;
	match error.raw_os_error().map(|code| code as u32) {
		Some(ERROR_ELEVATION_REQUIRED | ERROR_CANT_ACCESS_FILE) => "EACCES",
		Some(ERROR_NO_DATA) => "EAGAIN",
		Some(ERROR_INVALID_FLAGS | ERROR_INVALID_HANDLE) => "EBADF",
		Some(ERROR_LOCK_VIOLATION | ERROR_PIPE_BUSY | ERROR_SHARING_VIOLATION) => "EBUSY",
		Some(ERROR_OPERATION_ABORTED) => "ECANCELED",
		Some(ERROR_NO_UNICODE_TRANSLATION) => "ECHARSET",
		Some(ERROR_CONNECTION_ABORTED) => "ECONNABORTED",
		Some(ERROR_CONNECTION_REFUSED) => "ECONNREFUSED",
		Some(ERROR_NETNAME_DELETED) => "ECONNRESET",
		Some(ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS) => "EEXIST",
		Some(ERROR_NOACCESS) => "EFAULT",
		Some(ERROR_HOST_UNREACHABLE) => "EHOSTUNREACH",
		Some(
			ERROR_INSUFFICIENT_BUFFER
			| ERROR_INVALID_DATA
			| ERROR_INVALID_PARAMETER
			| ERROR_SYMLINK_NOT_SUPPORTED,
		) => "EINVAL",
		Some(
			ERROR_BEGINNING_OF_MEDIA
			| ERROR_BUS_RESET
			| ERROR_CRC
			| ERROR_DEVICE_DOOR_OPEN
			| ERROR_DEVICE_REQUIRES_CLEANING
			| ERROR_DISK_CORRUPT
			| ERROR_EOM_OVERFLOW
			| ERROR_FILEMARK_DETECTED
			| ERROR_GEN_FAILURE
			| ERROR_INVALID_BLOCK_LENGTH
			| ERROR_IO_DEVICE
			| ERROR_NO_DATA_DETECTED
			| ERROR_NO_SIGNAL_SENT
			| ERROR_OPEN_FAILED
			| ERROR_SETMARK_DETECTED
			| ERROR_SIGNAL_REFUSED,
		) => "EIO",
		Some(ERROR_CANT_RESOLVE_FILENAME) => "ELOOP",
		Some(ERROR_TOO_MANY_OPEN_FILES) => "EMFILE",
		Some(ERROR_BUFFER_OVERFLOW | ERROR_FILENAME_EXCED_RANGE) => "ENAMETOOLONG",
		Some(ERROR_NETWORK_UNREACHABLE) => "ENETUNREACH",
		Some(
			ERROR_BAD_PATHNAME
			| ERROR_DIRECTORY
			| ERROR_ENVVAR_NOT_FOUND
			| ERROR_FILE_NOT_FOUND
			| ERROR_INVALID_NAME
			| ERROR_INVALID_DRIVE
			| ERROR_INVALID_REPARSE_DATA
			| ERROR_MOD_NOT_FOUND
			| ERROR_PATH_NOT_FOUND,
		) => "ENOENT",
		Some(ERROR_NOT_ENOUGH_MEMORY | ERROR_OUTOFMEMORY) => "ENOMEM",
		Some(
			ERROR_CANNOT_MAKE
			| ERROR_DISK_FULL
			| ERROR_EA_TABLE_FULL
			| ERROR_END_OF_MEDIA
			| ERROR_HANDLE_DISK_FULL,
		) => "ENOSPC",
		Some(ERROR_NOT_CONNECTED) => "ENOTCONN",
		Some(ERROR_DIR_NOT_EMPTY) => "ENOTEMPTY",
		Some(ERROR_NOT_SUPPORTED) => "ENOTSUP",
		Some(ERROR_BROKEN_PIPE) => "EOF",
		Some(ERROR_ACCESS_DENIED | ERROR_PRIVILEGE_NOT_HELD) => "EPERM",
		Some(ERROR_BAD_PIPE | ERROR_PIPE_NOT_CONNECTED) => "EPIPE",
		Some(ERROR_WRITE_PROTECT) => "EROFS",
		Some(ERROR_SEM_TIMEOUT) => "ETIMEDOUT",
		Some(ERROR_NOT_SAME_DEVICE) => "EXDEV",
		Some(ERROR_INVALID_FUNCTION) => "EISDIR",
		Some(ERROR_META_EXPANSION_TOO_LONG) => "E2BIG",
		_ => "UNKNOWN",
	}
}

fn normalized_tail(tail: &str, windows: bool) -> String {
	let mut segments = Vec::new();
	for part in tail.split(|character| character == '/' || windows && character == '\\') {
		match part {
			"" | "." => {},
			".." => {
				segments.pop();
			},
			_ => segments.push(part),
		}
	}
	segments.join(if windows { "\\" } else { "/" })
}

#[cfg(windows)]
fn windows_root(path: &str) -> (String, bool, usize) {
	let bytes = path.as_bytes();
	let separator = |byte: u8| matches!(byte, b'/' | b'\\');
	if bytes.first().is_some_and(|byte| separator(*byte)) {
		if bytes.get(1).is_some_and(|byte| separator(*byte)) {
			let mut end = 2;
			while end < bytes.len() && !separator(bytes[end]) {
				end += 1;
			}
			if end > 2 && end < bytes.len() {
				let server = &path[2..end];
				while end < bytes.len() && separator(bytes[end]) {
					end += 1;
				}
				let share_start = end;
				while end < bytes.len() && !separator(bytes[end]) {
					end += 1;
				}
				if end > share_start {
					if matches!(server, "." | "?") {
						return (format!("\\\\{server}"), true, 4);
					}
					return (format!("\\\\{server}\\{}", &path[share_start..end]), true, end);
				}
			}
		}
		return (String::new(), true, 1);
	}
	if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
		let absolute = bytes.get(2).is_some_and(|byte| separator(*byte));
		return (path[..2].to_owned(), absolute, if absolute { 3 } else { 2 });
	}
	(String::new(), false, 0)
}

fn current_directory() -> CoreResult<String> {
	std::env::current_dir()
		.map(|path| path.to_string_lossy().into_owned())
		.map_err(|error| io_error(error, "uv_cwd", Path::new("")))
}

#[cfg(windows)]
fn resolve_paths(paths: &[&str]) -> CoreResult<PathBuf> {
	let mut device = String::new();
	let mut tail = String::new();
	let mut absolute = false;
	for index in (0..=paths.len()).rev() {
		let fallback;
		let path = if index > 0 {
			paths[index - 1]
		} else if device.is_empty() {
			fallback = current_directory()?;
			&fallback
		} else {
			fallback = match std::env::var(format!("={device}")) {
				Ok(directory) => directory,
				Err(_) => current_directory()?,
			};
			if fallback
				.get(..2)
				.is_some_and(|prefix| prefix.eq_ignore_ascii_case(&device))
			{
				&fallback
			} else {
				let normalized = normalized_tail(&tail, true);
				return Ok(PathBuf::from(format!("{device}\\{normalized}")));
			}
		};
		if path.is_empty() {
			continue;
		}
		let (found_device, found_absolute, root_end) = windows_root(path);
		if !found_device.is_empty() {
			if !device.is_empty()
				&& !device.eq_ignore_ascii_case(&found_device)
				&& device.to_lowercase() != found_device.to_lowercase()
			{
				continue;
			}
			if device.is_empty() {
				device = found_device;
			}
		}
		if !absolute {
			tail = format!("{}\\{tail}", &path[root_end..]);
			absolute = found_absolute;
		}
		if absolute && !device.is_empty() {
			break;
		}
	}
	let tail = normalized_tail(&tail, true);
	Ok(PathBuf::from(format!("{device}\\{tail}")))
}

#[cfg(not(windows))]
fn resolve_paths(paths: &[&str]) -> CoreResult<PathBuf> {
	let mut tail = String::new();
	let mut absolute = false;
	for path in paths.iter().rev() {
		if path.is_empty() {
			continue;
		}
		tail = format!("{path}/{tail}");
		if path.starts_with('/') {
			absolute = true;
			break;
		}
	}
	if !absolute {
		tail = format!("{}/{tail}", current_directory()?);
	}
	Ok(PathBuf::from(format!("/{}", normalized_tail(&tail, false))))
}

pub(super) fn resolve_root(root: &Path) -> CoreResult<PathBuf> {
	resolve_paths(&[&root.to_string_lossy()])
}

fn relative_path(root: &Path, absolute: &Path) -> String {
	let root = root.to_string_lossy();
	let absolute = absolute.to_string_lossy();
	let separator = std::path::MAIN_SEPARATOR;
	let from: Vec<_> = root
		.split(separator)
		.filter(|part| !part.is_empty())
		.collect();
	let to: Vec<_> = absolute
		.split(separator)
		.filter(|part| !part.is_empty())
		.collect();
	let equal = |left: &str, right: &str| {
		if cfg!(windows) {
			left.eq_ignore_ascii_case(right)
				|| (!left.is_ascii() || !right.is_ascii())
					&& left.to_lowercase() == right.to_lowercase()
		} else {
			left == right
		}
	};
	if cfg!(windows)
		&& from
			.first()
			.zip(to.first())
			.is_some_and(|(left, right)| !equal(left, right))
	{
		return absolute.into_owned();
	}
	let shared = from
		.iter()
		.zip(&to)
		.take_while(|(left, right)| equal(left, right))
		.count();
	let parts = std::iter::repeat_n("..", from.len() - shared)
		.chain(to[shared..].iter().copied())
		.collect::<Vec<_>>();
	parts.join(std::path::MAIN_SEPARATOR_STR)
}

// The infallible POSIX variant keeps the fallible Windows variant's Result
// signature so shared call sites can use `?` on both platforms.
#[allow(clippy::unnecessary_wraps)]
#[cfg(not(windows))]
fn node_symlink(_path: &Path, metadata: &Metadata) -> CoreResult<bool> {
	Ok(metadata.file_type().is_symlink())
}

#[cfg(windows)]
fn node_symlink(path: &Path, metadata: &Metadata) -> CoreResult<bool> {
	use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};

	use windows::{
		Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW},
		core::PCWSTR,
	};
	const REPARSE_POINT: u32 = 0x400;
	const SYMLINK_TAG: u32 = 0xa000_000c;
	if metadata.file_attributes() & REPARSE_POINT == 0 {
		return Ok(false);
	}
	let name: Vec<u16> = path
		.as_os_str()
		.encode_wide()
		.chain(std::iter::once(0))
		.collect();
	let mut data = WIN32_FIND_DATAW::default();
	// SAFETY: the UTF-16 path is terminated and data remains alive for the call.
	let handle = unsafe { FindFirstFileW(PCWSTR(name.as_ptr()), &mut data) }.map_err(|error| {
		io_error(std::io::Error::from_raw_os_error(error.code().0 & 0xffff), "lstat", path)
	})?;
	// SAFETY: FindFirstFileW returned a live search handle owned by this call.
	let _ = unsafe { FindClose(handle) };
	// Directory entries report junctions as directories. They are handled by
	// realpath cycle detection during enumeration, unlike lstat source checks.
	Ok(data.dwReserved0 == SYMLINK_TAG)
}

fn enumerate_directory(
	root: &Path,
	relative: &Path,
	visited: &mut HashSet<PathBuf>,
	files: &mut Vec<String>,
	check: Check<'_>,
) -> CoreResult<()> {
	check()?;
	let directory = root.join(relative);
	let real =
		fs::canonicalize(&directory).map_err(|error| io_error(error, "realpath", &directory))?;
	if !visited.insert(real) {
		return Ok(());
	}
	let mut entries = fs::read_dir(&directory)
		.map_err(|error| io_error(error, "scandir", &directory))?
		.map(|entry| entry.map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry)))
		.collect::<Result<Vec<_>, _>>()
		.map_err(|error| io_error(error, "scandir", &directory))?;
	// libuv's scandir sorts names before returning Dirents. Keep this order
	// under stable ICU-equal keys, rather than depending on OS enumeration.
	entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
	for (name, entry) in entries {
		check()?;
		let child = relative.join(&name);
		#[cfg(windows)]
		let (is_directory, is_file) = {
			use std::os::windows::fs::MetadataExt;
			let absolute = entry.path();
			let metadata = entry
				.metadata()
				.map_err(|error| io_error(error, "lstat", &absolute))?;
			if node_symlink(&absolute, &metadata)? {
				continue;
			}
			(metadata.file_attributes() & 0x10 != 0, metadata.is_file())
		};
		#[cfg(not(windows))]
		let (is_directory, is_file) = {
			let kind = entry
				.file_type()
				.map_err(|error| io_error(error, "lstat", &entry.path()))?;
			if kind.is_symlink() {
				continue;
			}
			(kind.is_dir(), kind.is_file())
		};
		if is_directory {
			enumerate_directory(root, &child, visited, files, check)?;
		} else if is_file && name.to_lowercase().ends_with(".md") {
			files.push(child.to_string_lossy().into_owned());
		}
	}
	Ok(())
}

pub(super) fn enumerate_markdown_files(root: &Path, check: Check<'_>) -> CoreResult<Vec<String>> {
	check()?;
	let root = resolve_root(root)?;
	if !fs::metadata(&root).is_ok_and(|metadata| metadata.is_dir()) {
		return Err(WikiError::message(format!(
			"Markdown root is not a directory: {}",
			root.display()
		)));
	}
	let mut files = Vec::new();
	enumerate_directory(&root, Path::new(""), &mut HashSet::new(), &mut files, check)?;
	check()?;
	let collator = CollatorBorrowed::try_new(locale!("en").into(), CollatorOptions::default())
		.map_err(|error| WikiError::message(error.to_string()))?;
	// slice::sort_by is stable: canonically equivalent names remain in the
	// source scandir/traversal order, as Array.sort(localeCompare) requires.
	files.sort_by(|left, right| collator.compare(left, right));
	check()?;
	Ok(files)
}

fn basename(path: &str) -> &str {
	let path = if cfg!(windows) {
		path.trim_end_matches(['/', '\\'])
	} else {
		path.trim_end_matches('/')
	};
	let name = path
		.rsplit(|character| character == '/' || cfg!(windows) && character == '\\')
		.next()
		.unwrap_or("");
	if cfg!(windows)
		&& name.as_bytes().get(1) == Some(&b':')
		&& name.as_bytes()[0].is_ascii_alphabetic()
	{
		&name[2..]
	} else {
		name
	}
}

fn file_title(path: &str) -> String {
	let name = basename(path);
	let extension = name
		.rfind('.')
		.filter(|position| *position > 0 && name != "..");
	// path.basename(original, extname(original)) treats a final separator as
	// part of the original path only for extname; read sources are files.
	extension
		.map_or(name, |position| &name[..position])
		.to_owned()
}

fn source_kind(path: &str) -> String {
	let name = basename(path);
	if let Some(stem) = name.strip_suffix(".md").or_else(|| {
		name
			.get(name.len().saturating_sub(3)..)
			.filter(|suffix| suffix.eq_ignore_ascii_case(".md"))
			.map(|_| &name[..name.len() - 3])
	}) && let Some((_, kind)) = stem.rsplit_once('_')
	{
		let kind = kind.to_ascii_lowercase();
		if matches!(
			kind.as_str(),
			"doc" | "docx" | "pdf" | "ppt" | "pptx" | "xls" | "xlsx" | "mp4" | "m4a"
		) {
			return kind;
		}
	}
	"markdown".to_owned()
}

#[allow(
	clippy::suboptimal_flops,
	reason = "Preserve original ECMAScript IEEE-754 multiplication/addition order for exact \
	          timestamp parity."
)]
pub(super) fn read_markdown_document(
	root: &Path,
	relative: &str,
	check: Check<'_>,
) -> CoreResult<WikiMarkdownDocument> {
	check()?;
	let root = resolve_root(root)?;
	let absolute = resolve_paths(&[&root.to_string_lossy(), relative])?;
	let stored_relative = relative_path(&root, &absolute);
	if stored_relative == ".."
		|| stored_relative.starts_with(&format!("..{}", std::path::MAIN_SEPARATOR))
		|| Path::new(&stored_relative).is_absolute()
	{
		return Err(WikiError::message(format!("Markdown path escapes root: {relative}")));
	}
	let metadata =
		fs::symlink_metadata(&absolute).map_err(|error| io_error(error, "lstat", &absolute))?;
	if metadata.file_type().is_symlink() || node_symlink(&absolute, &metadata)? {
		return Err(WikiError::message(format!("Markdown path is a symbolic link: {relative}")));
	}
	let mut options = OpenOptions::new();
	options.read(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.custom_flags(libc::O_NOFOLLOW);
	}
	#[cfg(windows)]
	{
		use std::os::windows::fs::OpenOptionsExt;
		// libuv's read-only opens also allow directory handles; readFile then
		// reports the read error instead of an earlier open-permission error.
		options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS);
	}
	let mut file: File = options
		.open(&absolute)
		.map_err(|error| io_error(error, "open", &absolute))?;
	check()?;
	let metadata = file
		.metadata()
		.map_err(|error| io_error(error, "fstat", &absolute))?;
	let mut bytes = Vec::new();
	// Do not preallocate metadata.len(): a file can change between fstat and
	// read, and special files need the same read-before-regular-file check.
	file
		.read_to_end(&mut bytes)
		.map_err(|error| io_error(error, "read", &absolute))?;
	drop(file);
	if !metadata.is_file() {
		return Err(WikiError::message(format!("Markdown path is not a regular file: {relative}")));
	}
	check()?;
	let parsed = parse_markdown(&bytes).map_err(|error| {
		let quoted = serde_json::to_string(relative).expect("serializing a Markdown relative path");
		WikiError::message(format!("Unable to parse Markdown {quoted}: {}", error.error_message()))
	})?;
	check()?;
	let sha256 = format!("{:x}", Sha256::digest(&bytes));
	let modified = metadata
		.modified()
		.map_err(|error| io_error(error, "fstat", &absolute))?;
	let mtime_ms = match modified.duration_since(UNIX_EPOCH) {
		Ok(duration) => {
			duration.as_secs() as f64 * 1000.0 + duration.subsec_nanos() as f64 / 1_000_000.0
		},
		Err(error) => {
			let duration = error.duration();
			let nanos = duration.subsec_nanos();
			let (seconds, nanos) = if nanos == 0 {
				(-(duration.as_secs() as f64), 0)
			} else {
				(-(duration.as_secs() as f64) - 1.0, 1_000_000_000 - nanos)
			};
			seconds * 1000.0 + nanos as f64 / 1_000_000.0
		},
	};
	Ok(WikiMarkdownDocument {
		relative_path: stored_relative.replace(std::path::MAIN_SEPARATOR, "/"),
		title: parsed.title.unwrap_or_else(|| file_title(relative)),
		source_kind: source_kind(relative),
		sha256,
		size_bytes: bytes.len() as i64,
		mtime_ms,
		sections: parsed.sections,
	})
}

#[napi]
pub fn wiki_parse_markdown(env: Env, bytes: Uint8Array) -> napi::Result<WikiParsedMarkdown> {
	parse_markdown(&bytes).map_err(|error| error.into_napi(env))
}

#[napi(ts_return_type = "Promise<string[]>")]
pub fn wiki_enumerate_markdown_files(root: String) -> task::MappedPromise<Vec<String>, WikiError> {
	task::blocking_mapped(
		"wiki_enumerate_markdown",
		(),
		|env, error| error.into_napi(env),
		|_, _| napi::Error::from_reason("The operation was aborted"),
		move |_| enumerate_markdown_files(Path::new(&root), &|| Ok(())),
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
		move |_| read_markdown_document(Path::new(&root), &relative, &|| Ok(())),
	)
}

#[napi]
pub fn wiki_section_shape(markdown: String) -> Shape {
	section_shape(&markdown)
}

#[napi]
pub fn wiki_truncate_heading(text: String, max_chars: Option<u32>) -> String {
	truncate_heading(&text, max_chars.map_or(HEADING_LABEL_MAX_CHARS, |value| value as usize))
}

#[napi]
pub fn wiki_normalize_plain_text(
	markdown: String,
	fence_prefix: Option<String>,
	continues_line: Option<bool>,
) -> String {
	let context = SectionContext {
		shape: Shape::Content,
		fence_prefix,
		continues_line: continues_line.unwrap_or(false),
		before: String::new(),
		after: String::new(),
	};
	plain_text(&lex_section(&markdown, &context))
}
