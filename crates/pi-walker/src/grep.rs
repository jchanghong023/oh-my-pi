//! Shared two-engine regex compilation and matching for grep consumers.

use std::{fmt, sync::LazyLock};

use grep_matcher::Matcher;
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};

/// Resolves the PCRE2 JIT toggle for an `OMP_PCRE2_JIT` value.
///
/// `1` forces JIT on; `0`/`false` forces it off. Unset or empty, JIT stays on
/// everywhere except macOS, where PCRE2's SLJIT executable allocator can fault
/// while compiling patterns (issue #7399). The caller reads the variable from
/// its own environment: the builtins see the shell's exported variables, which
/// the host process environment does not carry.
pub fn pcre2_jit_enabled(setting: Option<&str>) -> bool {
	match setting {
		Some(value) if !value.is_empty() => value != "0" && !value.eq_ignore_ascii_case("false"),
		_ => !cfg!(target_os = "macos"),
	}
}

/// Builds a Rust regex matcher with the native grep line-terminator
/// optimization.
///
/// # Errors
/// Returns the regex engine's error if the pattern cannot be compiled.
pub fn build_regex_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<RegexMatcher, grep_regex::Error> {
	let build = |line_terminated| {
		let mut builder = RegexMatcherBuilder::new();
		builder.case_insensitive(ignore_case).multi_line(multiline);
		if line_terminated {
			builder.line_terminator(Some(b'\n'));
		}
		builder.build(pattern)
	};

	if !multiline && let Ok(matcher) = build(true) {
		return Ok(matcher);
	}
	build(false)
}

/// Builds a PCRE2 matcher using the process-wide `OMP_PCRE2_JIT` setting.
///
/// # Errors
/// Returns the PCRE2 engine's error if the pattern cannot be compiled.
pub fn build_pcre_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<PcreMatcher, grep_pcre2::Error> {
	static PCRE2_JIT_ENABLED: LazyLock<bool> =
		LazyLock::new(|| pcre2_jit_enabled(std::env::var("OMP_PCRE2_JIT").ok().as_deref()));
	let mut builder = PcreMatcherBuilder::new();
	builder
		.caseless(ignore_case)
		.multi_line(multiline)
		.utf(true)
		.ucp(true)
		.jit_if_available(*PCRE2_JIT_ENABLED);
	builder.build(pattern)
}

/// Both engine errors from compiling a strict documentation grep expression.
#[derive(Debug)]
pub struct StrictMatcherError {
	rust: grep_regex::Error,
	pcre: grep_pcre2::Error,
}

impl fmt::Display for StrictMatcherError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "Invalid documentation grep regex: {}; PCRE2: {}", self.rust, self.pcre)
	}
}

impl std::error::Error for StrictMatcherError {}

/// Compiles an unchanged expression with Rust regex, falling back to PCRE2.
///
/// # Errors
/// Returns both engine errors if neither can compile the expression.
pub fn build_strict_matcher(
	pattern: &str,
	ignore_case: bool,
) -> Result<CompiledMatcher, StrictMatcherError> {
	match build_regex_matcher(pattern, ignore_case, false) {
		Ok(matcher) => Ok(CompiledMatcher::Rust(matcher)),
		Err(rust) => build_pcre_matcher(pattern, ignore_case, false)
			.map(CompiledMatcher::Pcre)
			.map_err(|pcre| StrictMatcherError { rust, pcre }),
	}
}

/// A pattern compiled by one of the two engines: Rust `regex`, or PCRE2 for
/// syntax it lacks (look-around, back-references).
///
/// Hot search loops match on the variant and run monomorphized per engine;
/// the [`Matcher`] impl serves one-shot callers that only need an answer.
pub enum CompiledMatcher {
	/// The Rust regex engine.
	Rust(RegexMatcher),
	/// The PCRE2 engine.
	Pcre(PcreMatcher),
}

/// Search error from either engine behind a [`CompiledMatcher`].
#[derive(Debug)]
pub enum CompiledMatcherError {
	/// Error from the Rust regex engine.
	Rust(grep_matcher::NoError),
	/// Error from the PCRE2 engine.
	Pcre(grep_pcre2::Error),
}

impl fmt::Display for CompiledMatcherError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Rust(err) => err.fmt(formatter),
			Self::Pcre(err) => err.fmt(formatter),
		}
	}
}

impl Matcher for CompiledMatcher {
	type Captures = grep_matcher::NoCaptures;
	type Error = CompiledMatcherError;

	fn find_at(
		&self,
		haystack: &[u8],
		at: usize,
	) -> Result<Option<grep_matcher::Match>, Self::Error> {
		match self {
			Self::Rust(matcher) => matcher
				.find_at(haystack, at)
				.map_err(CompiledMatcherError::Rust),
			Self::Pcre(matcher) => matcher
				.find_at(haystack, at)
				.map_err(CompiledMatcherError::Pcre),
		}
	}

	fn new_captures(&self) -> Result<Self::Captures, Self::Error> {
		Ok(grep_matcher::NoCaptures::new())
	}
}
