import {
	hashlineFileHash,
	hashlineFormatHeader,
	hashlineFormatNumberedLines,
	hashlineIsReadTruncationNotice,
	hashlineStripPrefixes,
} from "@oh-my-pi/pi-natives";

/** Opening delimiter of a hashline file header. */
export const HL_FILE_PREFIX = "[";
/** Closing delimiter of a hashline file header. */
export const HL_FILE_SUFFIX = "]";
/** Separator between the file path and content hash. */
export const HL_FILE_HASH_SEP = "#";
/** Number of characters in a displayed file hash. */
export const HL_FILE_HASH_LENGTH = 4;
/** Keyword identifying a file move operation. */
export const HL_MOVE_KEYWORD = "MV";
/** Keyword identifying a file removal operation. */
export const HL_REM_KEYWORD = "REM";
/** Separator between a line number and its body. */
export const HL_LINE_BODY_SEP = ":";

const HL_TRAILING_TAG_RE = new RegExp(`${HL_FILE_HASH_SEP}[0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}}$`);

/** Strip the hashline `[path#TAG]` wrapper from a write/edit target so the inner
 *  filesystem path drives both authorization and resolution. Only unwraps inputs
 *  that match the strict hashline header shape (`[path]` or `[path#XXXX]` with a
 *  4-hex tag); anything else returns the original string so the downstream
 *  resolver surfaces the real error. A valid tag disambiguates a `#` inside the
 *  path (yadm alt files: `conf.yaml##hostname.home`), matching the Rust
 *  tokenizer. Shared by execution and display callers making scheme/bridge-routing
 *  decisions before resolving the target. */
export function unwrapHashlineHeaderPath(targetPath: string): string {
	const trimmed = targetPath.trimEnd();
	if (
		trimmed.length < HL_FILE_PREFIX.length + HL_FILE_SUFFIX.length ||
		trimmed[0] !== HL_FILE_PREFIX ||
		trimmed[trimmed.length - 1] !== HL_FILE_SUFFIX
	) {
		return targetPath;
	}
	const inner = trimmed.slice(HL_FILE_PREFIX.length, trimmed.length - HL_FILE_SUFFIX.length);
	const tagMatch = HL_TRAILING_TAG_RE.exec(inner);
	const pathPart = tagMatch ? inner.slice(0, tagMatch.index) : inner;
	// A valid header is exactly `PATH` or `PATH#XXXX`; reject any other shape
	// (selectors, non-hex tags, untagged `#`) so we never silently rewrite a
	// path the model did not author.
	if (pathPart.length === 0 || (!tagMatch && pathPart.includes(HL_FILE_HASH_SEP))) return targetPath;
	return pathPart;
}

/** Format a file path and content hash as a hashline header. */
export function formatHashlineHeader(path: string, tag: string): string {
	return hashlineFormatHeader(path, tag);
}

/** Prefix each addressable line with its file line number. */
export function formatNumberedLines(text: string, startLine?: number): string {
	return hashlineFormatNumberedLines(text, startLine);
}

/** Prefix one line with its file line number. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}

/** Split file lines without treating a trailing newline as an empty address. */
export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** Remove model-facing hashline anchors from copied file content. */
export function stripHashlinePrefixes(lines: string[]): string[] {
	return hashlineStripPrefixes(lines);
}

/** Whether a row is a truncation notice emitted by `read`. */
export function isReadTruncationNotice(line: string): boolean {
	return hashlineIsReadTruncationNotice(line);
}

/** Compute the native hashline content fingerprint. */
export function computeFileHash(text: string): string {
	return hashlineFileHash(text);
}
