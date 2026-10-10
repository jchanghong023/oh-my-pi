import { randomUUID } from "node:crypto";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { isOpenRouterEmbeddingUrl } from "@oh-my-pi/pi-mnemopi/config";
import { envTruthy } from "@oh-my-pi/pi-mnemopi/util/env";
import { logger } from "@oh-my-pi/pi-utils";
import { COMPANY_RETRIEVAL_MODELS } from "../config/company-models";
import { getCompanyConfig, isCompanyLaneActive } from "../config/company-provider";
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
	const operationId = logger.getLogContext().operation_id ?? `company-embedding-defaults-${randomUUID()}`;
	const skipped = (reason: string): undefined => {
		logger.info("Company embedding defaults skipped", {
			component: "company-embeddings",
			event: "company_embedding_defaults_skipped",
			stage: "policy",
			result: "skipped",
			reason,
			operation_id: operationId,
		});
		return undefined;
	};
	const config = getCompanyConfig();
	if (!config) return skipped(isCompanyLaneActive() ? "company_unavailable" : "company_lane_inactive");
	// Explicit vector configuration remains authoritative; never send company credentials to its URL.
	const model = cfgMnemopiEmbeddingModel.get(settings)?.trim();
	const genericApiUrl = Bun.env.OPENROUTER_BASE_URL;
	const genericUrlRoutesToApi =
		genericApiUrl !== undefined && genericApiUrl !== "" && !isOpenRouterEmbeddingUrl(genericApiUrl);
	// Generic API keys are shared with other providers; only a custom generic URL or
	// Mnemopi's explicit API-routing flag makes them embedding configuration here.
	const overrideReason = model
		? "explicit_model"
		: cfgMnemopiEmbeddingApiUrl.get(settings)?.trim()
			? "explicit_url"
			: settings.isConfigured(cfgMnemopiEmbeddingApiKey)
				? "explicit_credentials"
				: Bun.env.MNEMOPI_EMBEDDING_API_URL
					? "environment_url"
					: Bun.env.MNEMOPI_EMBEDDING_API_KEY
						? "environment_credentials"
						: genericUrlRoutesToApi
							? "generic_api_gateway"
							: envTruthy("MNEMOPI_EMBEDDINGS_VIA_API")
								? "generic_api_requested"
								: undefined;
	if (overrideReason) return skipped(overrideReason);
	// An explicitly configured variant is a user-chosen local model too; only the
	// schema default yields to the company lane.
	if (settings.isConfigured(cfgMnemopiEmbeddingVariant)) return skipped("explicit_variant");
	logger.info("Company embedding defaults applied", {
		component: "company-embeddings",
		event: "company_embedding_defaults_applied",
		stage: "policy",
		result: "applied",
		operation_id: operationId,
		model: COMPANY_RETRIEVAL_MODELS[0].id,
		source: "startup_snapshot",
		credentials_source: "startup_snapshot",
	});
	return {
		embeddingModel: COMPANY_RETRIEVAL_MODELS[0].id,
		embeddingApiUrl: config.embeddingBaseUrl,
		embeddingApiKey: cachedCompanyToken,
	};
}
