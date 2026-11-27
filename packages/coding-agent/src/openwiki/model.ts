import * as path from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ChatOpenAI } from "@langchain/openai";
import { type AuthGatewayRouter, createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { routedModelsAreEqual } from "@oh-my-pi/pi-catalog/models";
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
import { bindEffects } from "../config/registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, initializeOfflineModelCommand, loadCliExtensionProviders } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import { cfgProvidersThinkingProbe } from "../session/settings";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking/levels";
import type { ConfiguredThinkingLevel } from "../utils/render-utils";

type OpenWikiModelRole = "default" | "plan";
type OpenWikiModelScope = { cwd: string; agentDir: string };

interface OpenWikiModelPreview {
	/** Origin of the selector, or automatic runtime selection when none is configured. */
	source: "selector" | "default-role" | "plan-role" | "automatic";
	/** The requested selector or configured role value, not a verified model ID. */
	selector?: string;
	/** Why the runtime model cannot be determined by this read-only preview. */
	reason: string;
}

/** Preview both roles using runtime's offline defaults without registry or auth-storage discovery. */
export async function previewOpenWikiModels(
	scope: OpenWikiModelScope,
	pageSelector?: string,
	plannerSelector = pageSelector,
): Promise<{ page: OpenWikiModelPreview; planner: OpenWikiModelPreview }> {
	const settings = await Settings.loadReadOnly(scope);
	await initializeOfflineModelCommand(settings);
	const page = previewModelSelection(pageSelector, "default", settings.getModelRole("default"));
	const plan = plannerSelector === undefined ? settings.getModelRole("plan") : undefined;
	const planner =
		plannerSelector !== pageSelector || plan ? previewModelSelection(plannerSelector, "plan", plan) : page;
	return { page, planner };
}

function previewModelSelection(
	selector: string | undefined,
	role: OpenWikiModelRole,
	roleValue: string | undefined,
): OpenWikiModelPreview {
	if (selector !== undefined) {
		if (!selector.trim()) throw new Error("OpenWiki model selector cannot be empty");
		return {
			source: "selector",
			selector,
			reason: "Unverified selector; the model is resolved at runtime using the model registry and availability.",
		};
	}

	if (roleValue) {
		return {
			source: `${role}-role`,
			selector: roleValue,
			reason: `Unverified ${role} role; the model is resolved at runtime using the model registry and availability.`,
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

interface OpenWikiModelSelection {
	selector: string | undefined;
	model: Model<Api>;
	thinkingLevel: ResolvedThinkingLevel | undefined;
}

/** Create an OMP-backed OpenWiki model with its own request lifetime. */
export async function createOpenWikiModel(scope: OpenWikiModelScope, selector?: string): Promise<OpenWikiModel> {
	const settings = await Settings.loadIsolated(scope);
	const agentDir = settings.getAgentDir();
	const releaseEffects = bindEffects(settings);
	let storage: AuthStorage | undefined;
	const disposeRuntime = () => {
		try {
			storage?.close();
		} finally {
			releaseEffects();
		}
	};
	try {
		const offline = await initializeOfflineModelCommand(settings);
		storage = await discoverAuthStorage(agentDir, { settings, offline });
		const registry = new ModelRegistry(storage, path.join(agentDir, "models.yml"), { settings });
		await registry.hydrateCredentialScopedModelCaches();
		await loadCliExtensionProviders(registry, settings, scope.cwd, { offline });
		await registry.refresh(offline ? "offline" : "online-if-uncached");
		const runtime = { settings, storage, registry };
		const selection = await resolveModelSelection(selector, runtime);
		return await createRuntimeModel(selection, runtime, disposeRuntime);
	} catch (error) {
		disposeRuntime();
		throw error;
	}
}

async function resolveModelSelection(
	selector: string | undefined,
	runtime: OpenWikiModelRuntime,
): Promise<OpenWikiModelSelection> {
	const { settings, registry } = runtime;
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
		const defaultRole = settings.getModelRole("default");
		if (defaultRole) {
			const resolved = resolveModelRoleValue(defaultRole, allowed, { settings });
			if (!resolved.model) throw new Error(`Default model ${defaultRole} is unavailable`);
			selected = resolved.model;
			thinkingLevel = resolved.thinkingLevel;
		} else {
			selected = pickDefaultAvailableModel(allowed, provider => registry.hasConcreteAuth(provider));
			if (!selected)
				throw new Error(
					getCompanyConfigError() ??
						"No default model available; configure the default role or model authentication",
				);
		}
	}
	return {
		selector,
		model: selected,
		thinkingLevel: resolveThinkingLevelForModel(selected, concreteThinkingLevel(thinkingLevel)),
	};
}

async function createRuntimeModel(
	selection: OpenWikiModelSelection,
	runtime: OpenWikiModelRuntime,
	disposeRuntime?: () => void,
): Promise<OpenWikiModel> {
	const { settings, storage, registry } = runtime;
	const { selector, model: selectedModel, thinkingLevel } = selection;
	let router: AuthGatewayRouter | undefined;
	const lifetime = new AbortController();
	try {
		const modelId = formatModelStringWithRouting(selectedModel);
		if (selectedModel.supportsTools === false) throw new Error(`Model ${modelId} does not support tool calling`);
		const initialKey = await registry.getApiKey(selectedModel, undefined, { signal: lifetime.signal });
		if (!initialKey) throw new Error(`No credential available for model ${modelId}`);

		router = createAuthGatewayRouter({
			storage,
			resolveModel: id => (id === modelId ? selectedModel : undefined),
			credentials: {
				resolve: (model, sessionId, signal, serviceTier) =>
					registry.getApiKeyWithCredentialForProvider(model.provider, sessionId, {
						baseUrl: model.baseUrl,
						modelId: model.id,
						signal,
						serviceTier,
					}),
				resolver: (model, sessionId, initialKey) =>
					registry.resolver(model.provider, { sessionId, baseUrl: model.baseUrl, modelId: model.id, initialKey }),
			},
			thinkingProbe: cfgProvidersThinkingProbe.get(settings),
			preserveAssistantToolTurns: true,
		});
		const activeRouter = router;
		const inProcessFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
			const signal = AbortSignal.any([request.signal, lifetime.signal]);
			return activeRouter.route(new Request(request, { signal }), "openwiki");
		};
		const reasoningEffort = shouldDisableReasoning(thinkingLevel) ? "none" : toReasoningEffort(thinkingLevel);
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
			async createPlannerModel(plannerSelector = selector) {
				const effectiveSelector =
					plannerSelector ?? (settings.getModelRole("plan") !== undefined ? "@plan" : undefined);
				if (effectiveSelector === undefined || effectiveSelector === selector) return this;
				const planner = await resolveModelSelection(effectiveSelector, runtime);
				if (thinkingLevel === planner.thinkingLevel && routedModelsAreEqual(selectedModel, planner.model))
					return this;
				return createRuntimeModel(planner, runtime);
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				lifetime.abort();
				activeRouter.close();
				disposeRuntime?.();
			},
		};
	} catch (error) {
		lifetime.abort();
		router?.close();
		throw error;
	}
}
