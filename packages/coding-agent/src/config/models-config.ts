/**
 * Custom model/provider config file handle and validation.
 */

import type { Api, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { OmpErrors, type } from "@oh-my-pi/omptype";
import { isRecord, once } from "@oh-my-pi/pi-utils";
import { ConfigFile } from "./config-file";
import type { ModelsConfig, ProviderAuthMode, ProviderDiscovery } from "./models-config-schema";
import { getModelsConfigSchema } from "./models-config-schema-bundle";

export type ProviderValidationMode = "models-config" | "runtime-register";

export interface ProviderValidationModel {
	id: string;
	api?: Api;
	contextWindow?: number;
	supportsTools?: boolean;
	maxTokens?: number;
}

export interface ProviderValidationConfig {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	api?: Api;
	auth?: ProviderAuthMode;
	oauthConfigured?: boolean;
	discovery?: ProviderDiscovery;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: unknown;
	disableStrictTools?: boolean;
	guardrailIdentifier?: string;
	requestMetadata?: Record<string, string>;
	modelOverrides?: Record<string, unknown>;
	models: ProviderValidationModel[];
}

export function validateProviderConfiguration(
	providerName: string,
	config: ProviderValidationConfig,
	mode: ProviderValidationMode,
): void {
	const hasProviderApi = !!config.api;
	const models = config.models;

	if (models.length === 0) {
		if (mode === "models-config") {
			const hasModelOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
			if (
				!config.baseUrl &&
				!config.headers &&
				!config.compat &&
				!config.apiKey &&
				config.auth !== "none" &&
				!config.disableStrictTools &&
				!config.guardrailIdentifier &&
				!config.requestMetadata &&
				!config.remoteCompaction &&
				!hasModelOverrides &&
				!config.discovery
			) {
				throw new Error(
					`Provider ${providerName}: must specify "baseUrl", "headers", "apiKey", "auth: none", "compat", "disableStrictTools", "guardrailIdentifier", "requestMetadata", "remoteCompaction", "modelOverrides", "discovery", or "models"`,
				);
			}
		}
	} else {
		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
		}
		const requiresAuth =
			mode === "runtime-register"
				? !config.apiKey && !config.oauthConfigured
				: !config.apiKey && (config.auth ?? "apiKey") !== "none" && (config.auth ?? "apiKey") !== "oauth";
		if (requiresAuth) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`
					: `Provider ${providerName}: "apiKey" is required when defining custom models unless auth is "none" or "oauth".`,
			);
		}
	}

	if (mode === "models-config" && config.discovery && !config.api && config.discovery.type !== "proxy") {
		throw new Error(`Provider ${providerName}: "api" is required when discovery is enabled at provider level.`);
	}

	for (const modelDef of models) {
		if (!hasProviderApi && !modelDef.api) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}, model ${modelDef.id}: no "api" specified.`
					: `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
			);
		}
		if (!modelDef.id) {
			throw new Error(`Provider ${providerName}: model missing "id"`);
		}
		if (mode === "models-config") {
			if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
			}
			if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}
}

// Ignored policy never enters the checked config, but the registry still needs
// to report that a reserved section contained fields it did not apply.
const ignoredProviderPolicies = new WeakSet<object>();

export function hasIgnoredModelProviderPolicy(providerConfig: object): boolean {
	return ignoredProviderPolicies.has(providerConfig);
}

const getReservedModelsConfigSchema = once(() => {
	const schema = getModelsConfigSchema();
	return type("unknown").pipe(input => {
		if (!isRecord(input) || !isRecord(input.providers)) return schema(input);
		const originalProviders = input.providers;
		const hasCompany = Object.hasOwn(originalProviders, "company");
		const hasZcode = Object.hasOwn(originalProviders, "zcode-api");
		if (!hasCompany && !hasZcode) return schema(input);

		const providers = { ...originalProviders };
		if (hasCompany) providers.company = {};
		const zcode = originalProviders["zcode-api"];
		const ignoredZcodePolicy = hasZcode && (!isRecord(zcode) || Object.keys(zcode).some(key => key !== "apiKey"));
		if (hasZcode) {
			// The credential is real input: keep it in the original provider schema
			// so invalid types and empty keys still fail instead of becoming keyless.
			providers["zcode-api"] = isRecord(zcode) && Object.hasOwn(zcode, "apiKey") ? { apiKey: zcode.apiKey } : {};
		}
		const checked = schema({ ...input, providers });
		if (!(checked instanceof OmpErrors) && ignoredZcodePolicy) {
			const providerConfig = checked.providers?.["zcode-api"];
			if (providerConfig) ignoredProviderPolicies.add(providerConfig);
		}
		return checked;
	});
});

export const ModelsConfigFile = new ConfigFile<ModelsConfig>("models", {
	kind: "deferred",
	resolve: getReservedModelsConfigSchema,
}).withValidation("models", config => {
	const providers = config.providers ?? {};
	for (const providerName in providers) {
		if (providerName === "company" || providerName === "zcode-api") continue;
		const providerConfig = providers[providerName];
		validateProviderConfiguration(
			providerName,
			{
				baseUrl: providerConfig.baseUrl,
				headers: providerConfig.headers,
				apiKey: providerConfig.apiKey,
				api: providerConfig.api as Api | undefined,
				auth: (providerConfig.auth ?? "apiKey") as ProviderAuthMode,
				discovery: providerConfig.discovery as ProviderDiscovery | undefined,
				compat: providerConfig.compat,
				remoteCompaction: providerConfig.remoteCompaction,
				disableStrictTools: providerConfig.disableStrictTools,
				guardrailIdentifier: providerConfig.guardrailIdentifier,
				requestMetadata: providerConfig.requestMetadata,
				modelOverrides: providerConfig.modelOverrides,
				models: (providerConfig.models ?? []) as ProviderValidationModel[],
			},
			"models-config",
		);
	}
});
