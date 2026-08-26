import { resolveCommandCodeBaseUrl } from "@oh-my-pi/pi-catalog/provider-models/command-code";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginCommandCode = createApiKeyLogin({
	providerLabel: "Command Code",
	authUrl: "https://commandcode.ai/studio/api-keys",
	instructions: "Create or copy a Provider API key from Command Code Studio",
	promptMessage: "Paste your Command Code API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "command-code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		model: "deepseek/deepseek-v4-flash",
	},
});

export const commandCodeProvider = {
	id: "command-code",
	name: "Command Code",
	prepareRequest: (model, options) => ({
		model: { ...model, baseUrl: resolveCommandCodeBaseUrl(model.api, model.baseUrl) },
		options,
	}),
	login: (cb: OAuthLoginCallbacks) => loginCommandCode(cb),
} as const satisfies ProviderDefinition;
