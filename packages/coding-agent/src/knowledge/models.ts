import { rerank } from "@oh-my-pi/pi-ai/rerank";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	effectiveMaxInputChars,
	embedConfiguredApi,
	embeddingsDisabled,
	isApiModel,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { getMnemopiRuntimeOptions, withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { logger } from "@oh-my-pi/pi-utils";
import { COMPANY_RETRIEVAL_MODELS } from "../config/company-models";
import { getCompanyConfig, isCompanyLaneActive, setCompanyOfflineEnabled } from "../config/company-provider";
import { Settings } from "../config/settings";
import { resolveMnemopiEmbeddingOptions } from "../mnemopi/config";
import { cfgMnemopiDebug, cfgMnemopiEmbeddingModel, cfgMnemopiNoEmbeddings } from "../mnemopi/settings";
import { mapWithConcurrencyLimit } from "../task/parallel";
import { cfgKnowledgeRerankerApiKey, cfgKnowledgeRerankerBaseUrl, cfgKnowledgeRerankerModel } from "./settings";

export interface KnowledgeEmbedding {
	readonly identity: string;
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export interface KnowledgeReranker {
	readonly identity: string;
	rerank(query: string, docs: string[], signal?: AbortSignal): Promise<number[]>;
}
export interface KnowledgeModels {
	embedding?: KnowledgeEmbedding;
	reranker?: KnowledgeReranker;
}

// Bound request size while keeping each existing per-input window intact.
export const KNOWLEDGE_EMBEDDING_CONCURRENCY = 4;
export const KNOWLEDGE_EMBEDDING_BATCH_SIZE = 16;
export const KNOWLEDGE_EMBEDDING_CHAR_BUDGET = 32768;

function endpoint(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			return undefined;
		return url.href.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

/** Resolve independent, optional model capabilities without opening the memory database. */
export async function resolveKnowledgeModels(
	options: { agentDir?: string; cwd?: string; embedding?: boolean; reranker?: boolean } = {},
): Promise<KnowledgeModels> {
	const settings = await Settings.loadReadOnly(options);
	if (isCompanyLaneActive()) await setCompanyOfflineEnabled(true);
	const debug = cfgMnemopiDebug.get(settings);
	const result: KnowledgeModels = {};
	if (options.embedding !== false && !cfgMnemopiNoEmbeddings.get(settings) && !embeddingsDisabled()) {
		const embeddingOptions = resolveMnemopiEmbeddingOptions(settings);
		const configuredModel = cfgMnemopiEmbeddingModel.get(settings)?.trim();
		const model = configuredModel || (embeddingOptions.embeddingApiUrl ? embeddingOptions.embeddingModel : undefined);
		const apiKey = embeddingOptions.embeddingApiKey ?? "";
		const useConfiguredApi =
			model && apiKey && withMnemopiRuntimeOptions({ embeddings: { model } }, () => isApiModel(model));
		const baseUrl = endpoint(
			embeddingOptions.embeddingApiUrl ?? (useConfiguredApi ? "https://openrouter.ai/api/v1" : undefined),
		);
		if (model && baseUrl) {
			const active = getMnemopiRuntimeOptions()?.embeddings;
			const runtime = {
				embeddings: {
					model,
					apiUrl: baseUrl,
					apiKey,
					strictApi: true,
					disabled: active?.disabled,
					maxInputChars: active?.maxInputChars,
				},
				debug,
			};
			const maxChars = withMnemopiRuntimeOptions(runtime, effectiveMaxInputChars);
			const identity = JSON.stringify(["wiki-embedding-v1", baseUrl, model, "float32", "head-tail-v1", maxChars]);
			result.embedding = {
				identity,
				async embed(texts, signal) {
					signal?.throwIfAborted();
					if (!texts.length) return [];
					const batches: Array<{ start: number; end: number }> = [];
					for (let start = 0; start < texts.length;) {
						let end = start;
						let chars = 0;
						while (end < texts.length && end - start < KNOWLEDGE_EMBEDDING_BATCH_SIZE) {
							const length = maxChars > 0 ? Math.min(texts[end].length, maxChars) : texts[end].length;
							if (end > start && chars + length > KNOWLEDGE_EMBEDDING_CHAR_BUDGET) break;
							chars += length;
							end++;
						}
						batches.push({ start, end });
						start = end;
					}
					let dimension: number | undefined;
					const { results, aborted } = await mapWithConcurrencyLimit(
						batches,
						KNOWLEDGE_EMBEDDING_CONCURRENCY,
						async ({ start, end }, _index, workerSignal) => {
							workerSignal.throwIfAborted();
							const matrix = await withMnemopiRuntimeOptions(
								{
									...runtime,
									embeddings: { ...runtime.embeddings, maxInputChars: maxChars, signal: workerSignal },
								},
								() => embedConfiguredApi(texts.slice(start, end)),
							);
							workerSignal.throwIfAborted();
							if (!matrix || matrix.length !== end - start)
								throw new Error("Knowledge embedding unavailable or invalid");
							for (const row of matrix) {
								if (
									!row.length ||
									(dimension !== undefined && row.length !== dimension) ||
									row.some(v => !Number.isFinite(v)) ||
									!row.some(v => v !== 0)
								) {
									throw new Error("Knowledge embedding unavailable or invalid");
								}
								dimension = row.length;
							}
							return matrix.map(row => Array.from(row));
						},
						signal,
					);
					signal?.throwIfAborted();
					if (aborted) throw new Error("Knowledge embedding cancelled");
					// The shared pool drains failures and preserves input order despite out-of-order replies.
					return results.flatMap(matrix => {
						if (!matrix) throw new Error("Knowledge embedding unavailable or invalid");
						return matrix;
					});
				},
			};
		}
	}
	// A partial or empty explicit setup remains authoritative, including disabling reranking.
	const companyDefaults =
		options.reranker !== false &&
		![cfgKnowledgeRerankerModel, cfgKnowledgeRerankerBaseUrl, cfgKnowledgeRerankerApiKey].some(setting =>
			settings.isConfigured(setting),
		)
			? getCompanyConfig()
			: undefined;
	const rerankModel =
		options.reranker === false
			? undefined
			: (cfgKnowledgeRerankerModel.get(settings)?.trim() ??
				(companyDefaults ? COMPANY_RETRIEVAL_MODELS[1].id : undefined));
	const rerankUrl = rerankModel
		? endpoint(cfgKnowledgeRerankerBaseUrl.get(settings) ?? companyDefaults?.embeddingBaseUrl)
		: undefined;
	if (rerankModel && rerankUrl) {
		const explicitKey = cfgKnowledgeRerankerApiKey.get(settings);
		const company = explicitKey === undefined ? getCompanyConfig() : undefined;
		const apiKey =
			explicitKey ?? (endpoint(company?.embeddingBaseUrl) === rerankUrl ? company?.token : undefined) ?? "";
		const model = buildModel({
			id: rerankModel,
			name: rerankModel,
			api: "openrouter-rerank",
			provider: "knowledge",
			baseUrl: rerankUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		});
		result.reranker = {
			identity: JSON.stringify(["wiki-reranker-v1", rerankUrl, rerankModel]),
			async rerank(query, docs, signal) {
				signal?.throwIfAborted();
				if (!docs.length) return [];
				try {
					const requestSignal = signal
						? AbortSignal.any([signal, AbortSignal.timeout(30000)])
						: AbortSignal.timeout(30000);
					const response = await rerank(model, { query, documents: docs }, { apiKey, signal: requestSignal });
					signal?.throwIfAborted();
					if (response.model !== rerankModel || response.results.length !== docs.length)
						throw new Error("Invalid rerank response");
					const scores = new Array<number>(docs.length);
					for (const item of response.results) {
						if (
							!Number.isInteger(item.index) ||
							item.index < 0 ||
							item.index >= docs.length ||
							scores[item.index] !== undefined ||
							!Number.isFinite(item.relevanceScore)
						)
							throw new Error("Invalid rerank response");
						scores[item.index] = item.relevanceScore;
					}
					return scores;
				} catch {
					signal?.throwIfAborted();
					logger[debug ? "warn" : "debug"]("knowledge: optional reranker unavailable");
					throw new Error("Knowledge reranker unavailable or invalid");
				}
			},
		};
	}
	return result;
}
