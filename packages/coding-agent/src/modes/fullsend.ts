import { prompt } from "@oh-my-pi/pi-utils";
import fullsendNoticeTemplate from "../prompts/system/fullsend-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "@oh-my-pi/pi-tui/prompt/gradient-highlight";
import { magicKeywordRegex } from "@oh-my-pi/pi-tui/prompt/magic-keyword-boundary";
import { keywordInProse } from "@oh-my-pi/pi-tui/prompt/markdown-prose";

const FULLSEND_WORD = magicKeywordRegex("fullsend");

/** Render the hidden execution-policy notice for the tools available to the session. */
export function renderFullsendNotice({ tools }: { tools: readonly string[] }): string {
	return prompt.render(fullsendNoticeTemplate, { tools }).trim();
}

/** Whether text contains standalone lowercase "fullsend" in prose. */
export function containsFullsend(text: string): boolean {
	return keywordInProse(text, FULLSEND_WORD);
}

/** Highlight standalone prose occurrences with a magenta-to-red gradient. */
export const highlightFullsend: KeywordHighlighter = createGradientHighlighter({
	probe: /fullsend/,
	highlight: magicKeywordRegex("fullsend", "g"),
	stops: 14,
	hue: t => 300 + t * 60,
});
