/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
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

export const cfgSttSubmitTrigger = register({
	id: "stt.submitTrigger",
	type: "enum",
	values: STT_SUBMIT_TRIGGER_VALUES,
	default: "never",
	ui: {
		tab: "interaction",
		group: "语音",
		label: "语音转文字提交触发方式",
		description: "选择语音听写自动提交的时机：从不、松开时（至少 2 个词）、松开且句子完整时，或说出提交指令时。",
		options: STT_SUBMIT_TRIGGER_OPTIONS,
	},
});
