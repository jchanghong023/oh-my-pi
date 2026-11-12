import * as path from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ChatOpenAI } from "@langchain/openai";
import { type AuthGatewayRouter, createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import {
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
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
import type { AuthStorage } from "../session/auth-storage";

export interface OpenWikiModelPreview {
	/** Origin of the selector, or automatic runtime selection when none is configured. */
	source: "selector" | "default-role" | "automatic";
	/** The requested selector or configured default role, not a verified model ID. */
	selector?: string;
	/** A concrete model ID, only when it can be resolved without runtime discovery or credentials. */
	modelId?: string;
	/** Why the runtime model cannot be determined by this read-only preview. */
	reason: string;
}

/** Keep explicit selectors; otherwise use the plan role only when configured. */
export async function resolveOpenWikiPlannerSelector(
	selector?: string,
	settings?: Settings,
): Promise<string | undefined> {
	if (selector !== undefined) return selector;
	settings ??= await Settings.loadReadOnly({ cwd: getProjectDir() });
	return settings.getModelRole("plan") !== undefined ? "@plan" : undefined;
}

/**
 * Preview the model selection without initializing the model registry or credentials.
 * Runtime discovery, availability and selector aliases can change the actual model,
 * so even a provider-qualified selector is reported as unverified rather than a model ID.
 */
export async function previewOpenWikiModel(selector?: string): Promise<OpenWikiModelPreview> {
	if (selector !== undefined) {
		if (!selector.trim()) throw new Error("OpenWiki model selector cannot be empty");
		return {
			source: "selector",
			selector,
			reason: "Unverified selector; the model is resolved at runtime using the model registry and availability.",
		};
	}

	const settings = await Settings.loadReadOnly({ cwd: getProjectDir() });
	const defaultRole = settings.getModelRole("default");
	if (defaultRole) {
		return {
			source: "default-role",
			selector: defaultRole,
			reason: "Unverified default role; the model is resolved at runtime using the model registry and availability.",
		};
	}

	return {
		source: "automatic",
		reason:
			"No default role is configured; the model is selected automatically at runtime based on availability and runtime defaults.",
	};
}

export interface OpenWikiModel {
	model: BaseChatModel;
	modelId: string;
	/** Resolve the planner after runtime defaults, sharing model discovery and credentials. */
	createPlannerModel(selector?: string): Promise<OpenWikiModel>;
	dispose(): void;
}

interface OpenWikiModelRuntime {
	settings: Settings;
	storage: AuthStorage;
	registry: ModelRegistry;
}

/** Create an OMP-backed OpenWiki model with its own request lifetime. */
export async function createOpenWikiModel(selector?: string): Promise<OpenWikiModel> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const offline = await initializeOfflineModelCommand(settings);
	const storage = await discoverAuthStorage(settings.getAgentDir(), { settings, offline });
	try {
		const registry = new ModelRegistry(storage, path.join(settings.getAgentDir(), "models.yml"), { settings });
		await registry.hydrateCredentialScopedModelCaches();
		await loadCliExtensionProviders(registry, settings, cwd, { offline });
		await registry.refresh(offline ? "offline" : "online-if-uncached");
		return await createRuntimeModel(selector, { settings, storage, registry }, true);
	} catch (error) {
		storage.close();
		throw error;
	}
}

async function createRuntimeModel(
	selector: string | undefined,
	runtime: OpenWikiModelRuntime,
	ownsStorage = false,
): Promise<OpenWikiModel> {
	const { settings, storage, registry } = runtime;
	let router: AuthGatewayRouter | undefined;
	const lifetime = new AbortController();
	try {
		const defaultRole = settings.getModelRole("default");
		let selected: Model<Api> | undefined;
		let thinkingLevel: ConfiguredThinkingLevel | undefined;
		if (selector !== undefined) {
			if (!selector.trim()) throw new Error("OpenWiki model selector cannot be empty");
			const resolved = resolveCliModel({ cliModel: selector, modelRegistry: registry, settings });
			if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `No model matches "${selector}"`);
			selected = resolved.model;
			thinkingLevel = resolved.thinkingLevel;
		} else {
			const allowed = await resolveAllowedModels(registry, settings, getModelMatchPreferences(settings));
			if (defaultRole) {
				const resolved = resolveModelRoleValue(defaultRole, allowed, { settings });
				selected = resolved.model;
				thinkingLevel = resolved.thinkingLevel;
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
		const resolvedThinking = resolveThinkingLevelForModel(selectedModel, concreteThinkingLevel(thinkingLevel));
		const reasoningEffort = shouldDisableReasoning(resolvedThinking) ? "none" : toReasoningEffort(resolvedThinking);
		const model = new ChatOpenAI({
			model: modelId,
			apiKey: "embedded",
			configuration: { baseURL: "http://openwiki.internal/v1", fetch: inProcessFetch },
			streaming: true,
			supportsStrictToolCalling: false,
			// OMP IDs are provider-qualified; bypass LangChain's model-name-based reasoning detection.
			modelKwargs: reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : undefined,
			maxRetries: 0,
		});
		let disposed = false;
		return {
			model,
			modelId,
			async createPlannerModel(plannerSelector?: string) {
				const effectiveSelector = await resolveOpenWikiPlannerSelector(plannerSelector, settings);
				if (effectiveSelector === undefined || effectiveSelector === selector) return this;
				return createRuntimeModel(effectiveSelector, runtime);
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				lifetime.abort();
				activeRouter.close();
				if (ownsStorage) storage.close();
			},
		};
	} catch (error) {
		lifetime.abort();
		router?.close();
		throw error;
	}
}
