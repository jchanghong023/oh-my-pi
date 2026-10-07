import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";
import { envTruthy } from "@oh-my-pi/pi-mnemopi/util/env";
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
	// Explicit vector configuration remains authoritative; never send company credentials to its URL.
	const model = cfgMnemopiEmbeddingModel.get(settings)?.trim();
	const genericApiUrl = Bun.env.OPENROUTER_BASE_URL;
	const genericUrlRoutesToApi =
		genericApiUrl !== undefined && genericApiUrl !== "" && !hostMatchesUrl(genericApiUrl, "openrouter");
	// Generic API keys are shared with other providers; only a custom generic URL or
	// Mnemopi's explicit API-routing flag makes them embedding configuration here.
	if (
		Boolean(model) ||
		cfgMnemopiEmbeddingApiUrl.get(settings)?.trim() ||
		settings.isConfigured(cfgMnemopiEmbeddingApiKey) ||
		Bun.env.MNEMOPI_EMBEDDING_API_URL ||
		Bun.env.MNEMOPI_EMBEDDING_API_KEY ||
		genericUrlRoutesToApi ||
		envTruthy("MNEMOPI_EMBEDDINGS_VIA_API")
	)
		return undefined;
	// An explicitly configured variant is a user-chosen local model too; only the
	// schema default yields to the company lane.
	if (settings.isConfigured(cfgMnemopiEmbeddingVariant)) return undefined;
	return {
		embeddingModel: COMPANY_RETRIEVAL_MODELS[0].id,
		embeddingApiUrl: config.embeddingBaseUrl,
		embeddingApiKey: cachedCompanyToken,
	};
}
