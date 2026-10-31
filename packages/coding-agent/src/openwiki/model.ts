import * as path from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ChatOpenAI } from "@langchain/openai";
import { type AuthGatewayRouter, createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { getCompanyConfigError } from "../config/company-provider";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelStringWithRouting,
	getModelMatchPreferences,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveCliModel,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { Settings } from "../config/settings";
import { discoverAuthStorage, initializeOfflineModelCommand, loadCliExtensionProviders } from "../sdk";

/** Select one OMP model for both the OpenWiki planner and every page worker. */
export async function createOpenWikiModel(selector?: string): Promise<{
	model: BaseChatModel;
	modelId: string;
	dispose(): void;
}> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const offline = initializeOfflineModelCommand(settings);
	const storage = await discoverAuthStorage(settings.getAgentDir(), { settings, offline });
	let router: AuthGatewayRouter | undefined;
	const lifetime = new AbortController();
	try {
		const registry = new ModelRegistry(storage, path.join(settings.getAgentDir(), "models.yml"), { settings });
		await registry.hydrateCredentialScopedModelCaches();
		await loadCliExtensionProviders(registry, settings, cwd, { offline });
		await registry.refresh(offline ? "offline" : "online-if-uncached");

		const defaultRole = settings.getModelRole("default");
		let selected: Model<Api> | undefined;
		if (selector !== undefined) {
			if (!selector.trim()) throw new Error("OpenWiki model selector cannot be empty");
			const resolved = resolveCliModel({ cliModel: selector, modelRegistry: registry, settings });
			if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `No model matches "${selector}"`);
			selected = resolved.model;
		} else {
			const allowed = await resolveAllowedModels(registry, settings, getModelMatchPreferences(settings));
			if (defaultRole) {
				selected = resolveModelRoleValue(defaultRole, allowed, { settings }).model;
				if (!selected) {
					const resolved = resolveCliModel({ cliModel: "@default", modelRegistry: registry, settings });
					throw new Error(resolved.error ?? `Default model ${defaultRole} is unavailable`);
				}
			} else {
				selected = pickDefaultAvailableModel(allowed, provider => registry.hasConcreteAuth(provider));
				if (!selected)
					throw new Error(
						getCompanyConfigError() ??
							"No default model available; configure the default role or model authentication",
					);
			}
		}

		if (!selected) throw new Error("No default model available");
		const selectedModel = selected;
		const modelId = formatModelStringWithRouting(selectedModel);
		if (selectedModel.supportsTools === false) throw new Error(`Model ${modelId} does not support tool calling`);
		const initialKey = await registry.getApiKey(selectedModel, undefined, { signal: lifetime.signal });
		if (!initialKey) throw new Error(`No credential available for model ${modelId}`);

		router = createAuthGatewayRouter({
			storage,
			resolveModel: id => (id === modelId ? selectedModel : undefined),
			credentials: {
				resolve: (model, sessionId, signal) =>
					registry.getApiKeyWithCredentialForProvider(model.provider, sessionId, {
						baseUrl: model.baseUrl,
						modelId: model.id,
						signal,
					}),
				resolver: (model, sessionId) => registry.resolver(model, sessionId),
			},
			preserveAssistantToolTurns: true,
		});
		const activeRouter = router;
		const inProcessFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
			const signal = AbortSignal.any([request.signal, lifetime.signal]);
			return activeRouter.route(new Request(request, { signal }), "openwiki");
		};
		const model = new ChatOpenAI({
			model: modelId,
			apiKey: "embedded",
			configuration: { baseURL: "http://openwiki.internal/v1", fetch: inProcessFetch },
			streaming: true,
			supportsStrictToolCalling: false,
			maxRetries: 0,
		});
		let disposed = false;
		return {
			model,
			modelId,
			dispose() {
				if (disposed) return;
				disposed = true;
				lifetime.abort();
				activeRouter.close();
				storage.close();
			},
		};
	} catch (error) {
		lifetime.abort();
		router?.close();
		storage.close();
		throw error;
	}
}
