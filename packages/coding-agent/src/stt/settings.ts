/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";
import { register, type ScopeLike } from "../config/registry";
import { normalizeSttLanguage } from "./language";
import { STT_SUBMIT_TRIGGER_OPTIONS, STT_SUBMIT_TRIGGER_VALUES } from "./submit-trigger";

// Speech-to-text
export const cfgSttEnabled = register({
	id: "stt.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Speech",
		label: "Speech-to-Text",
		description: "Enable speech-to-text input via microphone",
	},
});

export const cfgSttLanguage = register({ id: "stt.language", type: "string", default: "zh-CN" });

/** Auto detection is requested by omitting the source language. */
export function sttLanguageHint(settings: ScopeLike): string | undefined {
	const language = cfgSttLanguage.get(settings).trim();
	return language && language.toLowerCase() !== "auto" ? language : undefined;
}

/** Choose the catalog's dictation policy for the configured source language. */
export function dictationDefaultSelectors(language = cfgSttLanguage.default): readonly string[] {
	const tag = language.trim().toLowerCase();
	const chinese = normalizeSttLanguage(tag) === "zh" || tag === "<|zh|>" || tag === "chinese";
	return roleDefaultModels()[chinese ? "dictation" : "dictation-other"] ?? [];
}

export const cfgSttSubmitTrigger = register({
	id: "stt.submitTrigger",
	type: "enum",
	values: STT_SUBMIT_TRIGGER_VALUES,
	default: "never",
	ui: {
		tab: "interaction",
		group: "Speech",
		label: "Speech-to-Text Submit Trigger",
		description:
			"Choose when speech dictation automatically submits: Never, Release (2+ words, with language-aware counting for Chinese, Japanese, and Korean), Release with complete sentence, or When I Say Submit.",
		options: STT_SUBMIT_TRIGGER_OPTIONS,
	},
});
