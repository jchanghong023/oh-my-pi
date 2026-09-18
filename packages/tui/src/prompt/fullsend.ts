import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const FULLSEND_WORD = magicKeywordRegex("fullsend");

/**
 * Whether `text` contains the standalone keyword "fullsend" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsFullsend(text: string): boolean {
	return keywordInProse(text, FULLSEND_WORD);
}

/**
 * Gradient-highlight every standalone "fullsend" in `text` for editor display.
 * Sweeps magenta→red (hue 300..360), a range disjoint from the other keyword
 * gradients, so chained highlights stay visually distinct per keyword.
 */
export const highlightFullsend: KeywordHighlighter = createGradientHighlighter({
	probe: /fullsend/,
	highlight: magicKeywordRegex("fullsend", "g"),
	stops: 14,
	hue: t => 300 + t * 60,
});
