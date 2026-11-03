import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { COMPANY_PROVIDER_ID, getCompanyConfig } from "./company-provider";

// These are retrieval models, not Anthropic Messages models or tool-calling agents.
export const COMPANY_RETRIEVAL_MODELS = [
	{ id: "Qwen3-Embedding-8B", type: "embedding", input: ["text"], contextWindow: 32768, dimensions: 4096 },
	{ id: "Qwen3-Reranker-8B", type: "reranker", input: ["text"], contextWindow: 32768 },
	{ id: "Qwen3-VL-Embedding-2B", type: "embedding", input: ["text", "image"], contextWindow: 32768, dimensions: 2048 },
	{ id: "Qwen3-VL-Reranker-2B", type: "reranker", input: ["text", "image"], contextWindow: 32768 },
] as const;

/** OMP_OFFLINE defaults company chat context to 204,800 tokens; KDL retains model-specific limits
 * (process-only; `maxTokens` untouched) — fork contract. */
export const COMPANY_OFFLINE_CONTEXT_WINDOW = 204_800;

/**
 * Model roles OMP_OFFLINE fills in for this process when the company provider
 * is usable and the role is otherwise unconfigured — fork contract; existing
 * role config and explicit CLI model arguments always win.
 */
export const COMPANY_OFFLINE_ROLE_DEFAULTS: Readonly<Record<string, string>> = {
	default: "company/GLM-5.3-public",
	smol: "company/Qwen3.8-27B",
	tiny: "company/Qwen3.6-35B-A3B",
	commit: "company/Qwen3.6-35B-A3B",
	task: "company/Qwen3.8-27B",
	vision: "company/Qwen3.8-27B",
	advisor: "company/Qwen3.8-27B",
	plan: "company/GLM-5.3-public",
	slow: "company/GLM-5.3-public",
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
