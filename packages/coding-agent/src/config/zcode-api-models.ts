/**
 * Built-in runtime provider "zcode-api": the local ZCode Proxy relaying the
 * domestic Zhipu coding-plan GLM models over its native Anthropic Messages
 * route.
 *
 * Rows are built here instead of shipping in `models.json`: the bundled
 * catalog must never carry loopback endpoints
 * (packages/ai/test/models-json-no-local-endpoints.test.ts), and this provider
 * has no discovery endpoint to materialize rows from. Wire policy (thinking
 * modes, tool-result ids) lives in `rules/providers/zcode-api.kdl` and is
 * applied by the compat engine inside `buildModel`.
 *
 * Roster and parameters mirror the `zhipu-coding-plan` lane.
 * `glm-5.2-highspeed[1m]` is intentionally absent: it is a collapsed alias of
 * `glm-5.2-highspeed` in that lane's provider-scoped variant table, which
 * this provider does not have.
 */
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

export const ZCODE_API_PROVIDER_ID = "zcode-api";

/** Default endpoint of the local ZCode Proxy (its `server.port` default). */
export const ZCODE_API_DEFAULT_BASE_URL = "http://127.0.0.1:8080";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const CHAT_MODELS: ReadonlyArray<
	Pick<ModelSpec<"anthropic-messages">, "id" | "name" | "input" | "contextWindow" | "maxTokens" | "tokenizer" | "cost">
> = [
	{ id: "glm-4.5", name: "GLM-4.5", input: ["text"], contextWindow: 131_072, maxTokens: 98_304, cost: FREE },
	{ id: "glm-4.5-air", name: "GLM-4.5-Air", input: ["text"], contextWindow: 131_072, maxTokens: 98_304, cost: FREE },
	{ id: "glm-4.6", name: "GLM-4.6", input: ["text"], contextWindow: 202_752, maxTokens: 131_072, cost: FREE },
	{
		id: "glm-4.6v",
		name: "GLM-4.6V",
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 32_768,
		cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
	},
	{ id: "glm-4.7", name: "GLM-4.7", input: ["text"], contextWindow: 204_800, maxTokens: 131_072, cost: FREE },
	{
		id: "glm-5",
		name: "GLM-5",
		input: ["text"],
		contextWindow: 204_800,
		maxTokens: 131_072,
		tokenizer: "glm5",
		cost: FREE,
	},
	{
		id: "glm-5-turbo",
		name: "GLM-5-Turbo",
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 131_072,
		tokenizer: "glm5",
		cost: FREE,
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5V-Turbo",
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 131_072,
		cost: FREE,
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 131_072,
		tokenizer: "glm5",
		cost: FREE,
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		tokenizer: "glm5",
		cost: FREE,
	},
	{
		id: "glm-5.2-highspeed",
		name: "GLM-5.2 Highspeed",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		tokenizer: "glm5",
		cost: FREE,
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		tokenizer: "glm5",
		cost: FREE,
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		tokenizer: "glm5",
		cost: FREE,
	},
	{
		id: "glm-5.3-highspeed",
		name: "GLM-5.3 Highspeed",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		tokenizer: "glm5",
		cost: FREE,
	},
];

/** Resolves the proxy endpoint; `ZCODE_API_BASE_URL` overrides the loopback default. */
export function resolveZcodeApiBaseUrl(): string {
	const override = Bun.env.ZCODE_API_BASE_URL?.trim();
	if (!override) return ZCODE_API_DEFAULT_BASE_URL;
	return override.replace(/\/+$/, "");
}

let cachedBaseUrl: string | undefined;
let cachedModels: Model<"anthropic-messages">[] | undefined;

/** Runtime rows, memoized per resolved endpoint. */
export function getZcodeApiModels(): Model<"anthropic-messages">[] {
	const baseUrl = resolveZcodeApiBaseUrl();
	if (cachedModels && cachedBaseUrl === baseUrl) return cachedModels;
	cachedBaseUrl = baseUrl;
	cachedModels = CHAT_MODELS.map(spec =>
		buildModel({
			...spec,
			provider: ZCODE_API_PROVIDER_ID,
			api: "anthropic-messages",
			baseUrl,
			reasoning: true,
		}),
	);
	return cachedModels;
}
