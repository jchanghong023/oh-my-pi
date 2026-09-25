import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { COMPANY_RETRIEVAL_MODELS } from "../config/company-models";
import { getCompanyConfig } from "../config/company-provider";
import type { Settings } from "../config/settings";
import {
	cfgMnemopiEmbeddingApiKey,
	cfgMnemopiEmbeddingApiUrl,
	cfgMnemopiEmbeddingModel,
	cfgMnemopiEmbeddingVariant,
} from "./settings";
import type { MnemopiProviderOptions } from "./config";

const cachedCompanyToken: ApiKeyResolver = () => getCompanyConfig()?.token;

export function getCompanyEmbeddingDefaults(settings: Settings): Partial<MnemopiProviderOptions> | undefined {
	const config = getCompanyConfig();
	if (!config) return undefined;
	// An explicit embedding setup remains authoritative; never send company credentials to its URL.
	// `mnemopi.embeddingModel` already folds the MNEMOPI_EMBEDDING_MODEL env fallback into its value.
	const model = cfgMnemopiEmbeddingModel.get(settings)?.trim();
	if (
		cfgMnemopiEmbeddingApiUrl.get(settings)?.trim() ||
		cfgMnemopiEmbeddingApiKey.get(settings)?.trim() ||
		Bun.env.MNEMOPI_EMBEDDING_API_URL ||
		Bun.env.MNEMOPI_EMBEDDING_API_KEY
	)
		return undefined;
	// An explicitly configured variant is a user-chosen local model too; only the
	// schema default yields to the company lane.
	if (settings.isConfigured(cfgMnemopiEmbeddingVariant)) return undefined;
	if (model && !COMPANY_RETRIEVAL_MODELS.some(entry => entry.type === "embedding" && entry.id === model)) {
		return undefined;
	}
	return {
		embeddingModel: model || COMPANY_RETRIEVAL_MODELS[0].id,
		embeddingApiUrl: config.embeddingBaseUrl,
		embeddingApiKey: cachedCompanyToken,
	};
}
