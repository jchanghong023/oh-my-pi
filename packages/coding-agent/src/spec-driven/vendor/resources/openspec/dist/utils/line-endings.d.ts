/**
 * Line-ending helpers.
 *
 * Every parser in this codebase normalizes CRLF to LF on the way in, so all
 * serialization logic can assume '\n'. That leaves the write side responsible
 * for restoring whatever convention the file already used: without it, editing
 * one requirement in a CRLF spec rewrites every line of the file and buries the
 * real change in the diff.
 */
export type LineEnding = '\n' | '\r\n';
/**
 * The dominant line ending in `content`, or undefined when it holds no line
 * break to judge from.
 *
 * Mixed files resolve to whichever ending is more common, with CRLF winning a
 * tie: a file that is mostly CRLF is a CRLF file that picked up a stray LF, and
 * settling the whole file on one ending is what keeps later diffs small.
 */
export declare function detectLineEnding(content: string): LineEnding | undefined;
/**
 * Re-apply `ending` to LF-normalized `content`.
 *
 * Normalizes to LF first, so the result is uniform even if the caller passed
 * content that already contained CRLF.
 */
export declare function applyLineEnding(content: string, ending: LineEnding): string;
/**
 * Rewrite `content` to match the convention of `original`.
 *
 * When `original` has no line break to learn from, `content` is left as LF —
 * the portable default this project writes new files with.
 */
export declare function matchLineEnding(content: string, original: string): string;
//# sourceMappingURL=line-endings.d.ts.map