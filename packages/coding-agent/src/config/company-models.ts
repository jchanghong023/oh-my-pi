import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { COMPANY_PROVIDER_ID, getCompanyConfig } from "./company-provider";

// These are retrieval models, not Anthropic Messages models or tool-calling agents.
export const COMPANY_RETRIEVAL_MODELS = [
	{ id: "Qwen3-VL-Embedding-2B", type: "embedding", input: ["text", "image"], contextWindow: 32768, dimensions: 2048 },
	{ id: "Qwen3-VL-Reranker-2B", type: "reranker", input: ["text", "image"], contextWindow: 32768 },
] as const;

/** `--offline` caps every company chat model's context at 200k tokens
 * (process-only; `maxTokens` untouched) — fork contract. */
export const COMPANY_OFFLINE_CONTEXT_WINDOW = 200_000;

/**
 * Model roles `--offline` fills in for this process when the company provider
 * is usable and the role is otherwise unconfigured — fork contract; existing
 * role config and explicit CLI model arguments always win.
 */
export const COMPANY_OFFLINE_ROLE_DEFAULTS: Readonly<Record<string, string>> = {
	default: "company/Qwen3.6-27B-public",
	smol: "company/Qwen3.6-35B-A3B",
	tiny: "company/Qwen3.6-35B-A3B",
	commit: "company/Qwen3.6-35B-A3B",
	task: "company/Qwen3.6-27B-public",
	vision: "company/Qwen3.6-27B-public",
	advisor: "company/Qwen3.6-27B-public",
	plan: "company/GLM-5.2-public",
	slow: "company/GLM-5.2-public",
};

let chatModels: Model<"anthropic-messages">[] | undefined;
const contextWindowKey = "omp.company-models.contextWindow";

/** Set before registry initialization; workers inherit this process-only override. */
export function setCompanyChatContextWindow(contextWindow: number): void {
	setEnvironmentData(contextWindowKey, contextWindow);
	chatModels = undefined;
}

export function getCompanyChatModelIds(): string[] {
	return getCompanyConfig() ? seedModels(COMPANY_PROVIDER_ID).map(model => model.id) : [];
}

export function getCompanyChatModels(): Model<"anthropic-messages">[] {
	const config = getCompanyConfig();
	if (!config) return [];
	return (chatModels ??= seedModels<"anthropic-messages">(COMPANY_PROVIDER_ID).map(spec =>
		buildModel({
			...spec,
			contextWindow: (getEnvironmentData(contextWindowKey) as number | undefined) ?? spec.contextWindow,
			baseUrl: config.baseUrl,
		}),
	));
}
