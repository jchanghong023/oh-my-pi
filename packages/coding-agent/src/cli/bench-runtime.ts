/**
 * Shared plumbing for the benchmark-style CLI commands (`omp bench`, `omp if-bench`).
 *
 * Owns the three pieces every benchmark command needs before it can talk to a
 * provider: the auth/settings/model-registry runtime, selector → model
 * resolution (including the credential fallback that keeps a bare fuzzy id from
 * landing on an unauthenticated provider), and the injectable `streamSimple`
 * signature tests substitute for a synthetic stream.
 */
import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { buildModelProviderPriorityRank } from "@oh-my-pi/pi-catalog/identity";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import {
	COMPANY_OFFLINE_CONTEXT_WINDOW,
	COMPANY_OFFLINE_ROLE_DEFAULTS,
	setCompanyChatContextWindow,
} from "../config/company-models";
import {
	COMPANY_PROVIDER_ID,
	getCompanyConfigError,
	isCompanyLaneActive,
	setCompanyOfflineEnabled,
} from "../config/company-provider";
import { ModelRegistry } from "../config/model-registry";
import {
	disabledProviderIds,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { concreteThinkingLevel, resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { offlineFromEnv } from "./args";

/** Flip the company lane before registry construction; return its credential-free diagnostic. */
export function initializeCompanyModelLane(offline: boolean): string | undefined {
	setCompanyOfflineEnabled(offline);
	if (!offline) return undefined;
	setCompanyChatContextWindow(COMPANY_OFFLINE_CONTEXT_WINDOW);
	return getCompanyConfigError();
}

/**
 * Initialize model-dependent subcommands only when they need a registry.
 * These defaults live in memory; offline catalog refreshes remain the caller's responsibility.
 */
export function initializeOfflineModelCommand(settings: Settings): boolean {
	const offline = offlineFromEnv();
	const companyError = initializeCompanyModelLane(offline);
	if (!offline) return false;
	if (companyError) {
		process.stderr.write(`${companyError}\n`);
	} else if (!disabledProviderIds(settings).has(COMPANY_PROVIDER_ID)) {
		settings.setModelRoleDefaults(COMPANY_OFFLINE_ROLE_DEFAULTS);
	}
	return true;
}

/** Injection point for the provider call; tests pass a synthetic event stream. */
export type StreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Model catalog + credential surface a benchmark command depends on. */
export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	hasConfiguredAuth?(model: Model<Api>): boolean;
	/**
	 * Discovery-backed providers the catalog may still need to fetch
	 * (models.yml discovery, ollama, llama.cpp, lm-studio). Absent on
	 * hand-rolled test registries, which opt out of the fallback pass.
	 */
	getDiscoverableProviders?(): string[];
	/** Cache-aware discovery pass; absent when the registry cannot fetch. */
	refresh?(): Promise<void>;
}

/** Live registry plus the settings and teardown hook backing it. */
export interface BenchRuntime {
	modelRegistry: BenchModelRegistry;
	settings?: Settings;
	close?: () => void;
}

/** One resolved benchmark subject: the selector the user typed and what it became. */
export interface BenchTarget {
	selector: string;
	model: Model<Api>;
	thinking: ResolvedThinkingLevel | undefined;
}

/** Open the benchmark runtime; an omitted offline option inherits the host process lane. */
export async function createDefaultBenchRuntime(options: { offline?: boolean } = {}): Promise<BenchRuntime> {
	const offline = options.offline ?? isCompanyLaneActive();
	const context = logger.getLogContext();
	return logger.withLogContext(
		offline
			? {
					operation_id: context.operation_id ?? `bench-runtime-${crypto.randomUUID()}`,
					call_id: context.call_id ?? `bench-runtime-${crypto.randomUUID()}`,
				}
			: {},
		async () => {
			const started = performance.now();
			const fields = {
				component: "offline-models",
				event: "offline_model_refresh",
				stage: "runtime_create",
				strategy: "offline",
				cache_only: true,
			};
			let stage = "lane_config";
			if (offline) {
				logger.info("offline_model_refresh.started", {
					...fields,
					result: "started",
					model_registry_ready: false,
					elapsed_ms: performance.now() - started,
				});
			}
			try {
				const companyError = initializeCompanyModelLane(offline);
				if (offline) {
					if (companyError) {
						logger.warn("offline_model_refresh.degraded", {
							...fields,
							stage,
							result: "degraded",
							company_config_valid: false,
							elapsed_ms: performance.now() - started,
						});
						process.stderr.write(`${companyError}\n`);
					}
				}
				const cwd = getProjectDir();
				stage = "settings_init";
				// Runtime defaults belong to this view, never the host singleton or later runtimes.
				const settings = (await Settings.init({ cwd })).overlay();
				if (offline && !companyError && !disabledProviderIds(settings).has(COMPANY_PROVIDER_ID)) {
					settings.setModelRoleDefaults(COMPANY_OFFLINE_ROLE_DEFAULTS);
				}
				stage = "auth_discovery";
				const authStorage = await discoverAuthStorage(undefined, { settings });
				try {
					stage = "registry_create";
					const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
					for (const warning of modelRegistry.getReservedProviderWarnings()) process.stderr.write(`${warning}\n`);
					stage = "cache_hydration";
					await modelRegistry.hydrateCredentialScopedModelCaches();
					stage = "extension_providers";
					await loadCliExtensionProviders(modelRegistry, settings, cwd, { offline });
					if (offline) {
						logger.info("offline_model_refresh.completed", {
							...fields,
							result: "completed",
							model_registry_ready: true,
							...offlineBenchModelSummary(modelRegistry),
							elapsed_ms: performance.now() - started,
						});
					}
					return {
						modelRegistry: offline ? offlineBenchRegistry(modelRegistry) : modelRegistry,
						settings,
						close: () => authStorage.close(),
					};
				} catch (error) {
					authStorage.close();
					throw error;
				}
			} catch (error) {
				if (offline) {
					const cancelled = error instanceof Error && error.name === "AbortError";
					const diagnostic = {
						...fields,
						result: cancelled ? "cancelled" : "failed",
						failed_stage: stage,
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					};
					if (cancelled) logger.info("offline_model_refresh.cancelled", diagnostic);
					else logger.error("offline_model_refresh.failed", diagnostic);
				}
				throw error;
			}
		},
	);
}

/** Catalog counts only: cache-only discovery does not disable benchmark API requests. */
function offlineBenchModelSummary(registry: ModelRegistry): Record<string, unknown> {
	try {
		const models = registry.getAll();
		let companyModelCount = 0;
		for (const model of models) {
			if (model.provider === "company") companyModelCount++;
		}
		return {
			model_summary_available: true,
			model_count: models.length,
			available_model_count: registry.getAvailable().length,
			company_model_count: companyModelCount,
		};
	} catch {
		// A diagnostic snapshot must not change the runtime or refresh outcome.
		return { model_summary_available: false };
	}
}

/**
 * Offline runs must never reach public discovery: keep every registry method,
 * but pin the resolver's fallback refresh to the cache-only strategy.
 */
function offlineBenchRegistry(registry: ModelRegistry): BenchModelRegistry {
	// Resolution may invoke this closure after runtime creation's async context ended.
	const context = logger.getLogContext();
	return {
		getAll: () => registry.getAll(),
		getAvailable: () => registry.getAvailable(),
		getApiKey: (model, sessionId) => registry.getApiKey(model, sessionId),
		resolver: (model, sessionId) => registry.resolver(model, sessionId),
		hasConfiguredAuth: model => registry.hasConfiguredAuth(model),
		getDiscoverableProviders: () => registry.getDiscoverableProviders(),
		refresh: () =>
			logger.withLogContext(
				{
					...context,
					parent_call_id: context.call_id,
					call_id: `bench-refresh-${crypto.randomUUID()}`,
				},
				async () => {
					const started = performance.now();
					const fields = {
						component: "offline-models",
						event: "offline_model_refresh",
						stage: "selector_miss_refresh",
						strategy: "offline",
						cache_only: true,
					};
					logger.info("offline_model_refresh.started", {
						...fields,
						result: "started",
						...offlineBenchModelSummary(registry),
						elapsed_ms: performance.now() - started,
					});
					try {
						await registry.refresh("offline");
						logger.info("offline_model_refresh.completed", {
							...fields,
							result: "completed",
							...offlineBenchModelSummary(registry),
							elapsed_ms: performance.now() - started,
						});
					} catch (error) {
						const cancelled = error instanceof Error && error.name === "AbortError";
						const diagnostic = {
							...fields,
							result: cancelled ? "cancelled" : "failed",
							...offlineBenchModelSummary(registry),
							elapsed_ms: performance.now() - started,
							...logger.diagnosticError(error),
						};
						if (cancelled) logger.info("offline_model_refresh.cancelled", diagnostic);
						else logger.error("offline_model_refresh.failed", diagnostic);
						throw error;
					}
				},
			),
	};
}

/** Highest-priority provider variant: native/OAuth transports outrank mirrors. */
function pickHighestPriorityProvider(models: Model<Api>[], providerOrder?: readonly string[]): Model<Api> | undefined {
	if (models.length <= 1) return models[0];
	const priority = buildModelProviderPriorityRank(providerOrder);
	return [...models].sort((a, b) => {
		const aRank = priority.get(a.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const bRank = priority.get(b.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		return aRank - bRank;
	})[0];
}

/**
 * Benchmarks resolve selectors against the entire catalog (credentials are
 * ignored), so an ambiguous id shared by several providers can land on one the
 * user never authenticated. For non-pinned selectors, redirect to an equivalent
 * model under a provider with configured auth. An explicit `provider/id`
 * selector is honored verbatim — even unauthenticated — so forced benchmarking
 * keeps working.
 */
function resolveAuthenticatedAlternative(
	selector: string,
	model: Model<Api>,
	modelRegistry: BenchModelRegistry,
	providerOrder?: readonly string[],
): Model<Api> | undefined {
	if (!modelRegistry.hasConfiguredAuth) return undefined;
	// A pinned `provider/...` selector is authoritative; never redirect off it.
	if (selector.trim().toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) return undefined;
	if (modelRegistry.hasConfiguredAuth(model)) return undefined;

	const seen = new Set<string>();
	const authenticated: Model<Api>[] = [];
	const consider = (candidate: Model<Api>): void => {
		const key = `${candidate.provider}/${candidate.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (modelRegistry.hasConfiguredAuth?.(candidate)) authenticated.push(candidate);
	};
	// Same-id fallback for equivalent entries under providers with configured auth.
	for (const candidate of modelRegistry.getAll()) {
		if (candidate.id === model.id) consider(candidate);
	}
	return pickHighestPriorityProvider(authenticated, providerOrder);
}

/**
 * Resolve every selector to a concrete model + thinking level, warning on
 * stderr when a selector was redirected to an authenticated provider. When any
 * selector misses the hydrated catalog, awaits one cache-aware discovery pass
 * and re-resolves every selector from the refreshed catalog before failing:
 * discovery-backed providers (models.yml discovery, ollama, llama.cpp,
 * lm-studio) ship no static models, and cached rows whose `Authorization`
 * header cannot be re-derived from config (#5780) drop every model of that
 * provider until a live probe runs. A refresh replaces the rows of every
 * touched discovery provider, so only a full re-resolve keeps all targets on
 * the same snapshot. Same lazy fallback the session boot path applies (issues
 * #6114, #6162) — the common path, where every selector resolves, never pays
 * for a fetch.
 *
 * @throws when any selector cannot be resolved; the message lists all failures.
 */
export async function resolveBenchTargets(
	selectors: string[],
	modelRegistry: BenchModelRegistry,
	settings: Settings | undefined,
	writeStderr: (text: string) => void,
): Promise<BenchTarget[]> {
	const preferences = getModelMatchPreferences(settings);
	// Resolution runs up to two passes (initial + post-refresh), and refresh
	// can change how an already-resolved selector redirects, so only the
	// final pass's warnings are real: each pass rebuilds the buffer, and it
	// is flushed once, so a warning that no longer applies is never printed.
	const warnings = new Map<string, string>();
	const warn = (selector: string, kind: string, text: string): void => {
		warnings.set(`${selector}\u0000${kind}`, text);
	};
	const resolvePass = (): Array<BenchTarget | string> => {
		warnings.clear();
		return selectors.map(selector => resolveOne(selector));
	};
	const resolveOne = (selector: string): BenchTarget | string => {
		// Benchmarks intentionally resolve against the full catalog first, then
		// apply the exact-id credential fallback below. Using the CLI resolver's
		// authenticated default here would silently redirect non-equivalent bare
		// ids and suppress the warning for equivalent cross-provider models.
		const result = resolveCliModel({
			cliModel: selector,
			modelRegistry,
			availableModels: modelRegistry.getAll(),
			settings,
			preferences,
		});
		if (result.error) return `${selector}: ${result.error}`;
		if (!result.model) return `${selector}: model not found`;
		if (result.warning) warn(selector, "resolver", result.warning);
		let model = result.model;
		const authSelector = result.configuredPatterns?.[result.configuredPatternIndex ?? 0] ?? selector;
		const authenticated = resolveAuthenticatedAlternative(
			authSelector,
			model,
			modelRegistry,
			preferences.providerOrder,
		);
		if (authenticated) {
			warn(
				selector,
				"redirect",
				`no credentials for "${model.provider}"; benchmarking ${formatModelString(authenticated)} instead. Pin "${formatModelString(model)}" to force it.`,
			);
			model = authenticated;
		}
		return {
			selector,
			model,
			thinking: resolveThinkingLevelForModel(model, concreteThinkingLevel(result.thinkingLevel)),
		};
	};
	let outcomes = resolvePass();
	if (
		outcomes.some(outcome => typeof outcome === "string") &&
		modelRegistry.refresh &&
		(modelRegistry.getDiscoverableProviders?.().length ?? 0) > 0
	) {
		await logger.time("resolveBenchTargetsDiscoveryFallback", () => modelRegistry.refresh!());
		// Refresh replaces the catalog rows of every touched discovery provider,
		// so re-resolve every selector — not just the misses — to keep all
		// targets on the same snapshot.
		outcomes = resolvePass();
	}
	for (const text of warnings.values()) writeStderr(`${chalk.yellow(`Warning: ${text}`)}\n`);
	const errors = outcomes.filter((outcome): outcome is string => typeof outcome === "string");
	if (errors.length > 0) {
		throw new Error(`Could not resolve ${errors.length === 1 ? "model" : "models"}:\n${errors.join("\n")}`);
	}
	return outcomes as BenchTarget[];
}
