import { decode } from "turbo-stream";
import { classifyModel } from "../compat/taxonomy";
import {
	DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
	fetchOpenAICompatibleModels,
	withOpenAICompatibleDiscoveryTimeout,
} from "../discovery/openai-compatible";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import { inheritReferenceThinking, resolveModelReference } from "../identity/reference";
import type { ModelManagerOptions } from "../model-manager";
import type { Api, FetchImpl, ModelCost, ModelSpec, TokenCost } from "../types";
import { discoveryFetch, isRecord } from "../utils";
import { resolveModelCacheProviderId } from "./cache-provider-id";
import type { ModelManagerConfig } from "./descriptor-types";

const COMMAND_CODE_PROVIDER_BASE_URL = "https://api.commandcode.ai/provider";
const COMMAND_CODE_PRICING_URL = "https://commandcode.ai/models.data";
// Command Code adds and removes models (including free lanes) without notice;
// reusing an older cached catalog at startup hides those models until the TTL
// lapses, so this provider refreshes far more often than the 2h default.
const COMMAND_CODE_CACHE_TTL_MS = 15 * 60 * 1000;
// Command Code's `/v1/models` payload carries no capability flags, so a model
// with no bundled reference row keeps the discovery default `reasoning: false`,
// and buildModel skips the thinking cascade for non-reasoning specs — leaving
// the model with no selectable level. Declare those ids here instead; the
// cascade then derives the same effort range as the siblings on this provider
// (`deepseek/deepseek-v4-flash` → low/high/max, all accepted by the endpoint).
const COMMAND_CODE_REASONING_MODEL_IDS: Readonly<Record<string, true>> = {
	"deepseek/deepseek-v4.1-flash": true,
};

function normalizeBasePath(baseUrl: string | undefined): string {
	const value = (baseUrl ?? COMMAND_CODE_PROVIDER_BASE_URL).trim().replace(/\/+$/, "");
	return value.endsWith("/v1") ? value.slice(0, -3) : value;
}

export function resolveCommandCodeBaseUrl(api: Api, baseUrl?: string): string {
	const basePath = normalizeBasePath(baseUrl);
	return api === "anthropic-messages" ? basePath : `${basePath}/v1`;
}

/**
 * Command Code exposes one model list but two wire protocols:
 * Anthropic model identities use `/provider/v1/messages`, while every other
 * model uses `/provider/v1/chat/completions`. Routing must be based on the
 * discovered model id itself, not whichever reseller reference wins metadata
 * lookup, because the same GPT/Gemini id can appear on Anthropic-shaped gateways.
 */
export function resolveCommandCodeApi(modelId: string): Api {
	return classifyModel("command-code", modelId, { lenient: true }).class === "anthropic"
		? "anthropic-messages"
		: "openai-completions";
}

function parseNonNegativeRate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseCommandCodeRates(value: unknown): TokenCost | undefined {
	if (!isRecord(value)) return undefined;
	const input = parseNonNegativeRate(value.input);
	const output = parseNonNegativeRate(value.output);
	if (input === undefined || output === undefined) return undefined;
	return {
		input,
		output,
		cacheRead: parseNonNegativeRate(value.cacheRead) ?? 0,
		cacheWrite: parseNonNegativeRate(value.cacheWrite) ?? 0,
	};
}

function parseLongContextThreshold(
	value: unknown,
): Pick<NonNullable<ModelCost["longContext"]>, "inputThreshold" | "inputThresholdInclusive"> | null {
	if (typeof value !== "string") return null;
	const match = /^\s*(>|>=|≥)\s*(\d+(?:\.\d+)?)\s*([km])\s*$/i.exec(value);
	if (!match) return null;
	const amount = Number(match[2]);
	const multiplier = match[3]?.toLowerCase() === "m" ? 1_000_000 : 1_000;
	const inputThreshold = amount * multiplier;
	if (!Number.isFinite(inputThreshold) || inputThreshold <= 0) return null;
	return {
		inputThreshold,
		...(match[1] !== ">" ? { inputThresholdInclusive: true } : {}),
	};
}

function parseCommandCodeCost(value: unknown): ModelCost | undefined {
	if (!isRecord(value) || !Array.isArray(value.tiers) || value.tiers.length === 0) return undefined;
	const firstTier = value.tiers[0];
	if (!isRecord(firstTier)) return undefined;
	const base = parseCommandCodeRates(firstTier.rates);
	if (!base) return undefined;

	// ModelCost supports one long-context rate card. Preserve it only when the
	// source has exactly two tiers; collapsing three tiers would misprice the
	// omitted middle band.
	if (value.tiers.length !== 2) return base;
	const secondTier = value.tiers[1];
	if (!isRecord(secondTier)) return base;
	const longRates = parseCommandCodeRates(secondTier.rates);
	const threshold = parseLongContextThreshold(secondTier.context);
	return longRates && threshold ? { ...base, longContext: { ...longRates, ...threshold } } : base;
}

function extractCommandCodePricing(value: unknown): ReadonlyMap<string, ModelCost> | null {
	if (!isRecord(value)) return null;
	const route = value["routes/models/index"];
	if (!isRecord(route)) return null;
	const payload = isRecord(route.data) ? route.data : route;
	if (!Array.isArray(payload.models)) return null;

	const pricing = new Map<string, ModelCost>();
	for (const model of payload.models) {
		if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) continue;
		const cost = parseCommandCodeCost(model);
		if (cost) pricing.set(model.id, cost);
	}
	return pricing.size > 0 ? pricing : null;
}

async function fetchCommandCodePricing(fetchOverride?: FetchImpl): Promise<ReadonlyMap<string, ModelCost> | null> {
	const fetchImpl = discoveryFetch(fetchOverride);
	try {
		return await withOpenAICompatibleDiscoveryTimeout(
			DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
			async signal => {
				const response = await fetchImpl(COMMAND_CODE_PRICING_URL, {
					method: "GET",
					headers: { Accept: "text/x-script" },
					signal,
				});
				if (!response.ok || !response.body) return null;
				const decoded = await decode(response.body);
				await decoded.done;
				return extractCommandCodePricing(decoded.value);
			},
		);
	} catch {
		return null;
	}
}

function mapCommandCodeModel(
	defaults: ModelSpec<Api>,
	baseUrl: string | undefined,
	pricingCost: ModelCost | undefined,
): ModelSpec<Api> {
	const reference = resolveModelReference(defaults.id, getBundledModelReferenceIndex());
	const api = resolveCommandCodeApi(defaults.id);
	const thinking = inheritReferenceThinking(defaults.thinking, reference, "command-code");
	// Declared ids win over the reference: the table records a capability proven
	// against the endpoint's own `reasoning_effort` handling.
	const reasoning = COMMAND_CODE_REASONING_MODEL_IDS[defaults.id] ?? reference?.reasoning ?? defaults.reasoning;
	return {
		...defaults,
		name: reference?.name ?? defaults.name,
		api,
		provider: "command-code",
		baseUrl: resolveCommandCodeBaseUrl(api, baseUrl),
		// Reasoning is an intrinsic model capability; buildModel derives the
		// Command Code transport's wire controls from the new API/id pair.
		reasoning,
		input: reference?.input ?? defaults.input,
		cost: pricingCost ?? reference?.cost ?? defaults.cost,
		costSource: pricingCost ? "provider" : reference?.cost ? "reference" : "unknown",
		contextWindow: reference?.contextWindow ?? defaults.contextWindow,
		maxTokens: reference?.maxTokens ?? defaults.maxTokens,
		// Wire-model aliases such as effortRouting are provider-specific. Keep
		// discovery-provided thinking, but never inherit another provider's routing.
		...(thinking ? { thinking } : {}),
	};
}

export function commandCodeModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const discoveryBaseUrl = resolveCommandCodeBaseUrl("openai-completions", config?.baseUrl);

	return {
		providerId: "command-code",
		cacheProviderId: resolveModelCacheProviderId("command-code", { baseUrl: discoveryBaseUrl }),
		cacheTtlMs: COMMAND_CODE_CACHE_TTL_MS,
		dynamicModelsAuthoritative: true,
		// The declarations above double as the cache-migration policy: the manager
		// folds this list into the static fingerprint, and an authoritative
		// provider only reuses a cache whose fingerprint matches, so adding a
		// declaration forces the refresh that the declaration itself needs.
		// Without it a row written before the declaration keeps `reasoning: false`
		// until the TTL lapses — which is what the first release of the v4.1
		// declaration did to installations that had already cached the catalog.
		dropCachedModelIdsOnStaticMismatch: Object.keys(COMMAND_CODE_REASONING_MODEL_IDS),
		...(apiKey && {
			fetchDynamicModels: async () => {
				const [models, pricing] = await Promise.all([
					fetchOpenAICompatibleModels<Api>({
						api: "openai-completions",
						provider: "command-code",
						baseUrl: discoveryBaseUrl,
						apiKey,
						fetch: config?.fetch,
					}),
					fetchCommandCodePricing(config?.fetch),
				]);
				if (models === null) return null;
				return models.map(defaults => mapCommandCodeModel(defaults, config?.baseUrl, pricing?.get(defaults.id)));
			},
		}),
	};
}
