/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Exa
export const cfgExaEnabled = register({
	id: "exa.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Exa",
		description: "启用 Exa 网页搜索 Provider",
	},
});

export const cfgExaSearchDelayMs = register({
	id: "exa.searchDelayMs",
	type: "number",
	default: 1_000,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Exa 搜索间隔",
		description: "Exa 网页搜索请求之间的最短间隔（毫秒）；设为 0 可关闭限速",
	},
});

// SearXNG
export const cfgSearxngEndpoint = register({
	id: "searxng.endpoint",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_ENDPOINT", fallback: "blank" },
	ui: {
		tab: "providers",
		group: "服务",
		label: "SearXNG 端点",
		description: "用于网页搜索的自托管 SearXNG 实例基础 URL",
	},
});

export const cfgSearxngToken = register({
	id: "searxng.token",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_TOKEN", fallback: "blank" },
	credential: true,
});

export const cfgSearxngBasicUsername = register({
	id: "searxng.basicUsername",
	type: "string",
	default: undefined,
	// An empty username/password is a valid RFC 7617 credential, so blank text is kept.
	env: { name: "SEARXNG_BASIC_USERNAME", parse: raw => raw, fallback: true },
});

export const cfgSearxngBasicPassword = register({
	id: "searxng.basicPassword",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_BASIC_PASSWORD", parse: raw => raw, fallback: true },
	credential: true,
});

export const cfgSearxngCategories = register({ id: "searxng.categories", type: "string", default: undefined });

export const cfgSearxngEngines = register({ id: "searxng.engines", type: "string", default: undefined });

export const cfgSearxngLanguage = register({ id: "searxng.language", type: "string", default: undefined });

export const cfgSearxngSafesearch = register({ id: "searxng.safesearch", type: "number", default: undefined });
