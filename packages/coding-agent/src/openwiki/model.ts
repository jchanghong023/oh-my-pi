import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as path from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ChatOpenAI } from "@langchain/openai";
import { type AuthGatewayRouter, createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { routedModelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
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
import { getProviderSemaphore } from "../task/provider-concurrency";
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
	offline: boolean;
	signal?: AbortSignal;
}

interface OpenWikiModelSelection {
	selector: string | undefined;
	model: Model<Api>;
	thinkingLevel: ResolvedThinkingLevel | undefined;
	offlineOrigin?: string;
}

// Offline inference must use a transport that honors the gateway's fetch hook.
const offlineHttpApis = new Set<Api>([
	"anthropic-messages",
	"azure-openai-responses",
	"google-generative-ai",
	"ollama-chat",
	"openai-completions",
	"openai-responses",
	"openrouter",
]);

function isIntranetAddress(address: string): boolean {
	if (isIP(address) === 4) {
		return /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
	}
	return address === "::1" || /^(?:fc|fd)[0-9a-f]{2}:/i.test(address);
}

async function isIntranetEndpoint(url: URL): Promise<boolean> {
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host)) return isIntranetAddress(host);
	try {
		const addresses = await lookup(host, { all: true });
		return addresses.length > 0 && addresses.every(({ address }) => isIntranetAddress(address));
	} catch {
		return false;
	}
}

async function getOfflineModelOrigin(model: Model<Api>): Promise<string | undefined> {
	if (!offlineHttpApis.has(model.api)) return undefined;
	const url = URL.parse(model.baseUrl);
	return url && (await isIntranetEndpoint(url)) ? url.origin : undefined;
}

/** Create an OMP-backed OpenWiki model with its own request lifetime. */
export function createOpenWikiModel(
	scope: OpenWikiModelScope,
	selector?: string,
	signal?: AbortSignal,
): Promise<OpenWikiModel> {
	return untilAborted(signal, () => initializeOpenWikiModel(scope, selector, signal));
}

async function initializeOpenWikiModel(
	scope: OpenWikiModelScope,
	selector: string | undefined,
	signal?: AbortSignal,
): Promise<OpenWikiModel> {
	const settings = await Settings.loadIsolated(scope);
	signal?.throwIfAborted();
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
		signal?.throwIfAborted();
		storage = await discoverAuthStorage(agentDir, { settings, offline });
		signal?.throwIfAborted();
		const registry = new ModelRegistry(storage, path.join(agentDir, "models.yml"), { settings });
		await registry.hydrateCredentialScopedModelCaches();
		signal?.throwIfAborted();
		await loadCliExtensionProviders(registry, settings, scope.cwd, { offline });
		signal?.throwIfAborted();
		await registry.refresh(offline ? "offline" : "online-if-uncached");
		signal?.throwIfAborted();
		const runtime = { settings, storage, registry, offline, signal };
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
	role: OpenWikiModelRole = "default",
): Promise<OpenWikiModelSelection> {
	const { settings, registry } = runtime;
	let selected: Model<Api> | undefined;
	let thinkingLevel: ConfiguredThinkingLevel | undefined;
	let offlineOrigin: string | undefined;
	if (selector !== undefined) {
		if (!selector.trim()) throw new Error("OpenWiki model selector cannot be empty");
		const resolved = resolveCliModel({ cliModel: selector, modelRegistry: registry, settings });
		if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `No model matches "${selector}"`);
		selected = resolved.model;
		thinkingLevel = resolved.thinkingLevel;
	} else {
		const allowed = await resolveAllowedModels(registry, settings, getModelMatchPreferences(settings));
		const roleValue = settings.getModelRole(role);
		if (roleValue) {
			const resolved = resolveModelRoleValue(roleValue, allowed, { settings });
			if (!resolved.model) throw new Error(`OpenWiki ${role} role model ${roleValue} is unavailable`);
			selected = resolved.model;
			thinkingLevel = resolved.thinkingLevel;
		} else {
			const pick = (models: Model<Api>[]) =>
				pickDefaultAvailableModel(models, provider => registry.hasConcreteAuth(provider));
			selected = pick(allowed);
			if (runtime.offline) {
				let candidates = allowed;
				while (selected && !(offlineOrigin = await getOfflineModelOrigin(selected))) {
					runtime.signal?.throwIfAborted();
					const rejected = selected;
					candidates = candidates.filter(model => model.api !== rejected.api || model.baseUrl !== rejected.baseUrl);
					selected = pick(candidates);
				}
			}
			if (!selected)
				throw new Error(
					getCompanyConfigError() ??
						(runtime.offline
							? "No intranet model available for offline OpenWiki; configure an intranet model"
							: "No default model available; configure the default role or model authentication"),
				);
		}
	}
	if (runtime.offline && !(offlineOrigin ??= await getOfflineModelOrigin(selected))) {
		throw new Error(`Offline OpenWiki requires an intranet inference endpoint for ${formatModelStringWithRouting(selected)}`);
	}
	runtime.signal?.throwIfAborted();
	return {
		selector,
		model: selected,
		thinkingLevel: resolveThinkingLevelForModel(selected, concreteThinkingLevel(thinkingLevel)),
		offlineOrigin,
	};
}

async function createRuntimeModel(
	selection: OpenWikiModelSelection,
	runtime: OpenWikiModelRuntime,
	disposeRuntime?: () => void,
): Promise<OpenWikiModel> {
	const { settings, storage, registry } = runtime;
	const { selector, model: selectedModel, thinkingLevel, offlineOrigin } = selection;
	let router: AuthGatewayRouter | undefined;
	const lifetime = new AbortController();
	const modelSignal = runtime.signal ? AbortSignal.any([runtime.signal, lifetime.signal]) : lifetime.signal;
	try {
		const modelId = formatModelStringWithRouting(selectedModel);
		if (selectedModel.supportsTools === false) throw new Error(`Model ${modelId} does not support tool calling`);
		const initialKey = await untilAborted(modelSignal, () =>
			registry.getApiKey(selectedModel, undefined, { signal: modelSignal }),
		);
		modelSignal.throwIfAborted();
		if (!initialKey) throw new Error(`No credential available for model ${modelId}`);

		router = createAuthGatewayRouter({
			storage,
			resolveModel: id => (id === modelId ? selectedModel : undefined),
			fetch: offlineOrigin
				? async (input, init) => {
						const url = new URL(input instanceof Request ? input.url : input);
						if (url.origin !== offlineOrigin || !(await isIntranetEndpoint(url))) {
							throw new Error(`Offline OpenWiki blocked a request outside the intranet endpoint for ${modelId}`);
						}
						return fetch(input, { ...init, redirect: "error" });
					}
				: undefined,
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
			const signal = AbortSignal.any([request.signal, modelSignal]);
			const routed = new Request(request, { signal });
			const semaphore = getProviderSemaphore(settings, selectedModel.provider);
			if (!semaphore) return activeRouter.route(routed, "openwiki");
			await semaphore.acquire(signal);
			try {
				const response = await activeRouter.route(routed, "openwiki");
				if (!response.body) {
					semaphore.release();
					return response;
				}
				const { readable, writable } = new TransformStream<Uint8Array>();
				const heldResponse = new Response(readable, response);
				const release = () => semaphore.release();
				void response.body.pipeTo(writable, { signal }).then(release, release);
				return heldResponse;
			} catch (error) {
				semaphore.release();
				throw error;
			}
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
				if (plannerSelector === selector && (selector !== undefined || !settings.getModelRole("plan"))) return this;
				const planner = await untilAborted(modelSignal, () => resolveModelSelection(plannerSelector, runtime, "plan"));
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
