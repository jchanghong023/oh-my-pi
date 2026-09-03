import { resolveCommandCodeBaseUrl } from "@oh-my-pi/pi-catalog/provider-models/command-code";
import type { ProviderTransport } from "./build";

/**
 * Command Code request shaping: rewrite the model base URL for the provider's
 * unified `/provider` endpoint. Anthropic wire models talk to the bare path,
 * every other model to `/provider/v1` (see `resolveCommandCodeBaseUrl`).
 * Login is declarative: `rules/auth/command-code.kdl` (api-key paste, no
 * endpoint validation), matching the legacy flow's trim-only storage.
 */
export const commandCodeTransport: ProviderTransport = {
	prepareRequest: (model, options) => ({
		model: { ...model, baseUrl: resolveCommandCodeBaseUrl(model.api, model.baseUrl) },
		options,
	}),
};
