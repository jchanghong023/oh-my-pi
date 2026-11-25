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
		group: "语音",
		label: "语音转文字",
		description: "启用通过麦克风进行语音转文字输入",
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
		group: "语音",
		label: "语音转文字提交触发方式",
		description:
			"选择语音听写自动提交的时机：从不、松开时（按听写语言分词，至少 2 个词）、松开且句子完整时，或说出提交指令时。",
		options: STT_SUBMIT_TRIGGER_OPTIONS,
	},
});
