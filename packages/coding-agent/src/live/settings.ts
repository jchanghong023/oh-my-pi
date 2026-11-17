/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type ScopeLike } from "../config/registry";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS } from "./voices";

export const cfgLiveVoice = register({
	id: "live.voice",
	type: "string",
	default: DEFAULT_LIVE_VOICE,
	ui: {
		tab: "providers",
		group: "服务",
		label: "实时语音音色",
		description: "实时语音会话使用的音色；自定义实时语音端点可在配置中使用其他音色名称",
		options: LIVE_VOICE_OPTIONS,
	},
});

function validateLiveEndpoint(raw: unknown): void {
	if (typeof raw !== "string" || !raw.trim()) return;
	let protocol: string;
	try {
		protocol = new URL(raw.trim()).protocol;
	} catch {
		throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}
}

export const cfgLiveEndpoint = register({
	id: "live.endpoint",
	type: "string",
	default: undefined,
	validate: validateLiveEndpoint,
	ui: {
		tab: "providers",
		group: "服务",
		label: "实时语音端点",
		description: "替代 Codex 的 OpenAI Realtime WebRTC 兼容服务地址（如 http://127.0.0.1:8080/v1）；留空使用 Codex",
	},
});

export const cfgLiveApiKey = register({
	id: "live.apiKey",
	type: "string",
	default: undefined,
	credential: true,
	ui: {
		tab: "providers",
		group: "服务",
		label: "实时语音端点 API 密钥",
		description: "仅发送给实时语音端点的 Bearer 密钥：可填写密钥、环境变量名或 !command",
	},
});

/** The voice a live session uses: an explicit choice, else the `live.voice` setting, else the default. */
export function resolveLiveVoice(scope: ScopeLike, voice?: string): string {
	return voice?.trim() || cfgLiveVoice.get(scope).trim() || DEFAULT_LIVE_VOICE;
}
