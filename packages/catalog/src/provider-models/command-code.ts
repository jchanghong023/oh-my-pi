import { decode } from "turbo-stream";
import {
	DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
	fetchOpenAICompatibleModels,
	withOpenAICompatibleDiscoveryTimeout,
} from "../discovery/openai-compatible";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import { isAnthropicNamespacedModelId, isClaudeModelId } from "../identity/family";
import { inheritReferenceThinking, resolveModelReference } from "../identity/reference";
import type { ModelManagerOptions } from "../model-manager";
import type { Api, FetchImpl, ModelCost, ModelSpec, TokenCost } from "../types";
import { discoveryFetch, isRecord } from "../utils";
import { resolveModelCacheProviderId } from "./cache-provider-id";
import type { ModelManagerConfig } from "./descriptor-types";

const COMMAND_CODE_PROVIDER_BASE_URL = "https://api.commandcode.ai/provider";
const COMMAND_CODE_PRICING_URL = "https://commandcode.ai/models.data";

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
	return isClaudeModelId(modelId) || isAnthropicNamespacedModelId(modelId)
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
	return {
		...defaults,
		name: reference?.name ?? defaults.name,
		api,
		provider: "command-code",
		baseUrl: resolveCommandCodeBaseUrl(api, baseUrl),
		// Reasoning is an intrinsic model capability; buildModel derives the
		// Command Code transport's wire controls from the new API/id pair.
		reasoning: reference?.reasoning ?? defaults.reasoning,
		input: reference?.input ?? defaults.input,
		cost: pricingCost ?? reference?.cost ?? defaults.cost,
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
		dynamicModelsAuthoritative: true,
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
