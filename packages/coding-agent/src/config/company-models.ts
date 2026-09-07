import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { COMPANY_PROVIDER_ID, getCompanyConfig } from "./company-provider";

// Fixed metadata from the bundled public catalog; no discovery or public endpoints.
const CHAT_MODELS: ReadonlyArray<
	Pick<ModelSpec<"anthropic-messages">, "id" | "input" | "contextWindow" | "maxTokens" | "tokenizer">
> = [
	{
		id: "DeepSeek-V4-Flash-public",
		input: ["text"],
		contextWindow: 1000000,
		maxTokens: 384000,
		tokenizer: "deepseek-v3",
	},
	{ id: "GLM-5.2-public", input: ["text"], contextWindow: 1000000, maxTokens: 131072, tokenizer: "glm5" },
	{ id: "MiniMax-M2.7", input: ["text"], contextWindow: 204800, maxTokens: 131072 },
	{ id: "Qwen3.6-27B-public", input: ["text", "image"], contextWindow: 262144, maxTokens: 262144, tokenizer: "qwen3" },
	{ id: "Qwen3.6-35B-A3B", input: ["text", "image"], contextWindow: 262144, maxTokens: 262144, tokenizer: "qwen3" },
];

// These are retrieval models, not Anthropic Messages models or tool-calling agents.
export const COMPANY_RETRIEVAL_MODELS = [
	{ id: "Qwen3-Embedding-8B", type: "embedding", input: ["text"], contextWindow: 32768, dimensions: 4096 },
	{ id: "Qwen3-VL-Embedding-2B", type: "embedding", input: ["text", "image"], contextWindow: 32768, dimensions: 2048 },
	{ id: "Qwen3-VL-Reranker-2B", type: "reranker", input: ["text", "image"], contextWindow: 32768 },
] as const;

let chatModels: Model<"anthropic-messages">[] | undefined;

export function getCompanyChatModels(): Model<"anthropic-messages">[] {
	const config = getCompanyConfig();
	if (!config) return [];
	return (chatModels ??= CHAT_MODELS.map(spec =>
		buildModel({
			...spec,
			name: spec.id,
			provider: COMPANY_PROVIDER_ID,
			api: "anthropic-messages",
			baseUrl: config.baseUrl,
			reasoning: true,
			supportsTools: true,
			thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			costSource: "unknown",
			compat: {
				supportsContextManagement: false,
				supportsOutputEffort: false,
				disableStrictTools: true,
				disableAdaptiveThinking: true,
			},
		}),
	));
}
