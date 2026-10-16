/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { DEFAULT_STREAM_URL } from "@oh-my-pi/pi-wire";

const EMPTY_STRING_ARRAY: string[] = [];

// Live streaming (omp stream)
export const cfgStreamServerUrl = register({
	id: "stream.serverUrl",
	type: "string",
	default: DEFAULT_STREAM_URL,
	ui: {
		tab: "interaction",
		group: "直播",
		label: "直播服务器",
		description: "`omp stream` 使用的直播服务器（https://host[:port]）；观众通过 <base>/<your Stencil username> 观看",
	},
});

export const cfgStreamRedactPatterns = register({
	id: "stream.redactPatterns",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "直播",
		label: "额外脱敏规则",
		description: "在 env/secrets.yml 值和内置凭据模式之外，用于对每一行直播内容脱敏的额外正则表达式",
	},
});
