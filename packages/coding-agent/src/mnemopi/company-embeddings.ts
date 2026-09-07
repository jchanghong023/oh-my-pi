import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { COMPANY_RETRIEVAL_MODELS } from "../config/company-models";
import { getCompanyConfig } from "../config/company-provider";
import type { Settings } from "../config/settings";
import type { MnemopiProviderOptions } from "./config";

const cachedCompanyToken: ApiKeyResolver = () => getCompanyConfig()?.token;

export function getCompanyEmbeddingDefaults(settings: Settings): Partial<MnemopiProviderOptions> | undefined {
	const config = getCompanyConfig();
	if (!config) return undefined;
	// An explicit embedding setup remains authoritative; never send company credentials to its URL.
	const model = settings.get("mnemopi.embeddingModel")?.trim() || Bun.env.MNEMOPI_EMBEDDING_MODEL?.trim();
	if (
		settings.get("mnemopi.embeddingApiUrl")?.trim() ||
		settings.get("mnemopi.embeddingApiKey")?.trim() ||
		Bun.env.MNEMOPI_EMBEDDING_API_URL ||
		Bun.env.MNEMOPI_EMBEDDING_API_KEY
	)
		return undefined;
	if (model && !COMPANY_RETRIEVAL_MODELS.some(entry => entry.type === "embedding" && entry.id === model)) {
		return undefined;
	}
	return {
		embeddingModel: model || COMPANY_RETRIEVAL_MODELS[0].id,
		embeddingApiUrl: config.embeddingBaseUrl,
		embeddingApiKey: cachedCompanyToken,
	};
}
