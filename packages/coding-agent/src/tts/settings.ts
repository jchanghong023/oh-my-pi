/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import {
	DEFAULT_TTS_SPEED,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_VOICE_OPTIONS,
	TTS_LOCAL_VOICE_VALUES,
	TTS_SPEED_OPTIONS,
} from "./models";

export const cfgTtsLocalVoice = register({
	id: "tts.localVoice",
	type: "enum",
	values: TTS_LOCAL_VOICE_VALUES,
	default: DEFAULT_TTS_VOICE,
	ui: {
		tab: "providers",
		group: "服务",
		label: "本地 TTS 音色",
		description: "本地 TTS 后端使用的 Kokoro 音色（美式/英式、女声/男声）",
		options: TTS_LOCAL_VOICE_OPTIONS,
	},
});

export const cfgTtsLocalSpeed = register({
	id: "tts.localSpeed",
	type: "number",
	default: DEFAULT_TTS_SPEED,
	ui: {
		tab: "providers",
		group: "服务",
		label: "本地 TTS 语速",
		description: "本地 TTS 后端（tts 工具、omp say）的语速。1 = 正常；限制在 0.5–2.5",
		options: TTS_SPEED_OPTIONS,
	},
});

export const cfgSpeechEnabled = register({
	id: "speech.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "服务",
		label: "语音朗读",
		description: "在助手输出流式生成时通过扬声器朗读",
	},
});

export const cfgSpeechMode = register({
	id: "speech.mode",
	type: "enum",
	values: ["all", "assistant", "yield"] as const,
	default: "assistant",
	ui: {
		tab: "providers",
		group: "服务",
		label: "语音朗读模式",
		description: "朗读内容：all = 助手消息和思考；assistant = 仅消息；yield = 仅每轮结束时的最终消息",
		options: [
			{ value: "all", label: "全部（消息和思考）" },
			{ value: "assistant", label: "助手消息" },
			{ value: "yield", label: "仅最终消息" },
		],
	},
});

export const cfgSpeechEnhanced = register({
	id: "speech.enhanced",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "服务",
		label: "增强语音改写",
		description:
			"合成语音前，使用 tiny/smol 模型将助手输出改写为自然口语（描述代码，去除链接和 Markdown）。失败时回退到机械清理",
	},
});

export const cfgSpeechVoice = register({
	id: "speech.voice",
	type: "enum",
	values: TTS_LOCAL_VOICE_VALUES,
	default: DEFAULT_TTS_VOICE,
	ui: {
		tab: "providers",
		group: "服务",
		label: "语音朗读音色",
		description: "朗读助手输出时使用的 Kokoro 音色",
		options: TTS_LOCAL_VOICE_OPTIONS,
	},
});

export const cfgSpeechSpeed = register({
	id: "speech.speed",
	type: "number",
	default: DEFAULT_TTS_SPEED,
	ui: {
		tab: "providers",
		group: "服务",
		label: "语音朗读语速",
		description: "朗读助手输出时的语速。1 = 正常；限制在 0.5–2.5",
		options: TTS_SPEED_OPTIONS,
	},
});
