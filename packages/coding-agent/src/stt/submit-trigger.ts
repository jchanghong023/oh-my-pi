/**
 * TTS/STT Submit Trigger options and evaluation logic.
 */

import { normalizeSttLanguage } from "./language";

export const STT_SUBMIT_TRIGGER_VALUES = ["never", "release", "release-complete", "say-submit"] as const;

export type SttSubmitTrigger = (typeof STT_SUBMIT_TRIGGER_VALUES)[number];

export const STT_SUBMIT_TRIGGER_OPTIONS = [
	{
		value: "never",
		label: "Never",
		description: "Never automatically submit; insert dictation and remain in editor.",
	},
	{
		value: "release",
		label: "Release",
		description: "Submit on release if the utterance has 2+ words to avoid accidental sends.",
	},
	{
		value: "release-complete",
		label: "Release with complete sentence",
		description: "Submit on release if the utterance ends with sentence-terminal punctuation (. ? ! etc.).",
	},
	{
		value: "say-submit",
		label: "When I Say Submit",
		description: "Submit if the utterance ends with a word containing 'submit' (strips that word before submitting).",
	},
] satisfies ReadonlyArray<{ value: SttSubmitTrigger; label: string; description: string }>;

function cjkWordLocale(text: string, language: string | undefined): string | undefined {
	// A CJK recognizer can return a lone non-CJK identifier, e.g. "foo-bar".
	// Keep the whitespace threshold for that text instead of splitting it on punctuation.
	if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return undefined;
	const code = normalizeSttLanguage(
		language
			?.trim()
			.toLowerCase()
			.replace(/^<\|(.+)\|>$/, "$1"),
	);
	switch (code) {
		case "zh":
		case "zho":
		case "chi":
		case "cmn":
		case "yue":
		case "chinese":
		case "mandarin":
		case "cantonese":
			return "zh";
		case "ja":
		case "jpn":
		case "japanese":
			return "ja";
		case "ko":
		case "kor":
		case "korean":
			return "ko";
		case undefined:
		case "":
		case "auto":
			// Some recognizers only return text. Use its script when no language is available.
			if (/\p{Script=Hangul}/u.test(text)) return "ko";
			if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
			return /\p{Script=Han}/u.test(text) ? "zh" : undefined;
		default:
			return undefined;
	}
}

/**
 * Evaluate the submit trigger against a transcribed utterance.
 * Returns whether to submit, and the number of characters to trim from the end of the utterance.
 */
export function evaluateSubmitTrigger(
	utterance: string,
	trigger: SttSubmitTrigger,
	language?: string,
): { submit: boolean; trimTrailing: number } {
	const trimmed = utterance.trim();
	if (!trimmed) {
		return { submit: false, trimTrailing: 0 };
	}

	if (trigger === "never") {
		return { submit: false, trimTrailing: 0 };
	}

	if (trigger === "release") {
		const locale = cjkWordLocale(trimmed, language);
		let words = 0;
		if (locale) {
			for (const { isWordLike } of new Intl.Segmenter(locale, { granularity: "word" }).segment(trimmed)) {
				if (isWordLike && ++words === 2) return { submit: true, trimTrailing: 0 };
			}
		} else {
			for (const word of trimmed.split(/\s+/u)) {
				if (/[\p{L}\p{N}]/u.test(word) && ++words === 2) return { submit: true, trimTrailing: 0 };
			}
		}
		return { submit: false, trimTrailing: 0 };
	}

	if (trigger === "release-complete") {
		// Matches typical sentence terminators: . ? ! ... or full-width equivalents, optionally followed by space
		const hasTerminalPunctuation = /[.?!…。？！]\s*$/.test(trimmed);
		return { submit: hasTerminalPunctuation, trimTrailing: 0 };
	}

	if (trigger === "say-submit") {
		// Matches space followed by any word containing "submit" (case-insensitive), optionally followed by punctuation/spaces
		// Also handles the case where "submit" is the only word in the utterance (no leading space)
		const match = utterance.match(/(?:^|\s+)(\S*submit\S*)[.?!…。？！]*\s*$/i);
		if (match && match.index !== undefined) {
			const trimTrailing = utterance.length - match.index;
			return { submit: true, trimTrailing };
		}
		return { submit: false, trimTrailing: 0 };
	}

	return { submit: false, trimTrailing: 0 };
}
