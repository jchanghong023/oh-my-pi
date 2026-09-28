/**
 * Fork-extension config surface, A tier (requirement 5.6, rpc-ui-protocol.md).
 *
 * Settings read/write wraps `createSettingsHost` (credential entries are
 * masked on read; persistence is the global config layer, matching the
 * settings panel — project scope is read-only). Provider/model listing merges
 * the live registry, models.yml, and discovery states; provider CRUD does its
 * own read-modify-write of models.yml (ConfigFile is read-only by design)
 * with `validateProviderConfiguration` gating. `test_model` fires a one-shot
 * `streamSimple` probe and attributes failures to six categories.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Model, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getAgentDir, isRecord } from "@oh-my-pi/pi-utils";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import { createSettingsHost } from "../../config/settings-ui";
import { lookup } from "../../config/registry";
import {
	ModelsConfigFile,
	validateProviderConfiguration,
	type ProviderValidationConfig,
} from "../../config/models-config";
import { cfgDisabledProviders, cfgEnabledModels } from "../../config/model-settings";
import { withActiveSettings, type Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase, RpcForkModelTestResult } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

const MASKED_CREDENTIAL = "••••••••";

export interface RpcForkSettingsEntry {
	key: string;
	type: string;
	value: unknown;
	defaultValue: unknown;
	credential: boolean;
	/** Where the effective value comes from (env/runtime/overlay/project/global/default). */
	provenance?: string;
	/** True when the project layer configures this key. */
	projectConfigured?: boolean;
}

function maskCredential(value: unknown): unknown {
	if (typeof value === "string" && value.length > 0) return MASKED_CREDENTIAL;
	if (value !== undefined && value !== null) return MASKED_CREDENTIAL;
	return value;
}

export class RpcForkConfigController {
	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
	) {
		host.registerCommand("get_settings", command => this.#getSettings(command));
		host.registerCommand("set_settings", command => this.#setSettings(command));
		host.registerCommand("unset_settings", command => this.#unsetSettings(command));
		host.registerCommand("list_providers", command => this.#listProviders(command));
		host.registerCommand("upsert_provider", command => this.#upsertProvider(command));
		host.registerCommand("delete_provider", command => this.#deleteProvider(command));
		host.registerCommand("set_model_enabled", command => this.#setModelEnabled(command));
		host.registerCommand("test_model", command => this.#testModel(command));
	}

	#settingsHost(): ReturnType<typeof createSettingsHost> {
		return createSettingsHost();
	}

	#projectLayer(settings: Settings): Record<string, unknown> {
		const raw = settings.getProjectSettings();
		return isRecord(raw) ? raw : {};
	}

	async #getSettings(command: RpcForkCommandBase): Promise<RpcResponse> {
		const scope = (command as { scope?: unknown }).scope;
		if (scope !== "user" && scope !== "project") {
			return this.host.context.error(command.id, "get_settings", `Invalid scope: ${String(scope)}`);
		}
		const settings = this.session.settings;
		const projectLayer = this.#projectLayer(settings);
		return withActiveSettings(settings, () => {
			const host = this.#settingsHost();
			const entries: RpcForkSettingsEntry[] = [];
			for (const entry of host.entries) {
				if (entry.condition && !entry.condition()) continue;
				const raw = host.get(entry.path);
				const value = entry.credential ? maskCredential(raw) : raw;
				const projectConfigured = Object.hasOwn(projectLayer, entry.path);
				if (scope === "project" && !projectConfigured) continue;
				const setting = lookup(entry.path);
				entries.push({
					key: entry.path,
					type: entry.type,
					value,
					defaultValue: entry.defaultValue,
					credential: entry.credential === true,
					...(setting ? { provenance: settings.getProvenance(setting) } : {}),
					projectConfigured,
				});
			}
			return this.host.context.success(command.id, "get_settings", { scope, entries });
		});
	}

	async #setSettings(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { scope, key, value } = command as { scope?: unknown; key?: unknown; value?: unknown };
		if (scope !== "user" && scope !== "project") {
			return this.host.context.error(command.id, "set_settings", `Invalid scope: ${String(scope)}`);
		}
		if (scope === "project") {
			return this.host.context.error(
				command.id,
				"set_settings",
				"Project scope is read-only over RPC: the settings layer persists to the user config only",
				"read_only_scope",
			);
		}
		if (typeof key !== "string" || !key) {
			return this.host.context.error(command.id, "set_settings", "key is required");
		}
		try {
			withActiveSettings(this.session.settings, () => this.#settingsHost().set(key, value));
		} catch (error) {
			return this.host.context.error(
				command.id,
				"set_settings",
				error instanceof Error ? error.message : String(error),
			);
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "set_settings", { key });
	}

	async #unsetSettings(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { scope, key } = command as { scope?: unknown; key?: unknown };
		if (scope !== "user" && scope !== "project") {
			return this.host.context.error(command.id, "unset_settings", `Invalid scope: ${String(scope)}`);
		}
		if (scope === "project") {
			return this.host.context.error(
				command.id,
				"unset_settings",
				"Project scope is read-only over RPC",
				"read_only_scope",
			);
		}
		if (typeof key !== "string" || !key) {
			return this.host.context.error(command.id, "unset_settings", "key is required");
		}
		try {
			withActiveSettings(this.session.settings, () => this.#settingsHost().unset(key));
		} catch (error) {
			return this.host.context.error(
				command.id,
				"unset_settings",
				error instanceof Error ? error.message : String(error),
			);
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "unset_settings", { key });
	}

	emitSettingsChanged(scope: "user" | "project"): void {
		this.host.context.emit({ type: "settings_changed", scope });
	}

	async #listProviders(command: RpcForkCommandBase): Promise<RpcResponse> {
		await this.session.modelRegistry.awaitBackgroundRefresh();
		const models = this.session.getAvailableModels();
		const byProvider = new Map<string, Array<{ id: string; contextWindow?: number }>>();
		for (const model of models) {
			const list = byProvider.get(model.provider) ?? [];
			list.push({
				id: model.id,
				...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
			});
			byProvider.set(model.provider, list);
		}
		const config = ModelsConfigFile.loadOrDefault();
		const configured = config.providers ?? {};
		const settings = this.session.settings;
		const disabled = cfgDisabledProviders.get(settings) ?? [];
		const providers = [...new Set([...byProvider.keys(), ...Object.keys(configured)])].sort().map(provider => {
			const discovery = this.session.modelRegistry.getProviderDiscoveryState(provider);
			return {
				provider,
				models: byProvider.get(provider) ?? [],
				configured: Object.hasOwn(configured, provider),
				disabled: disabled.includes(provider),
				baseUrl: this.session.modelRegistry.getProviderBaseUrl(provider),
				discovery: discovery
					? {
							status: discovery.status,
							stale: discovery.stale,
							...(discovery.error ? { error: discovery.error } : {}),
						}
					: undefined,
			};
		});
		return this.host.context.success(command.id, "list_providers", { providers });
	}

	async #upsertProvider(command: RpcForkCommandBase): Promise<RpcResponse> {
		const provider = (command as { provider?: unknown }).provider;
		if (!isRecord(provider) || typeof provider.name !== "string" || !provider.name.trim()) {
			return this.host.context.error(command.id, "upsert_provider", 'provider must be an object with a "name"');
		}
		const name = provider.name.trim();
		const models: Array<{ id: string; api?: unknown; contextWindow?: number; maxTokens?: number }> = Array.isArray(
			provider.models,
		)
			? (provider.models as Array<Record<string, unknown>>).map(model => ({
					id: String(model.id ?? ""),
					...(model.api !== undefined ? { api: model.api } : {}),
					...(model.contextWindow !== undefined ? { contextWindow: Number(model.contextWindow) } : {}),
					...(model.maxTokens !== undefined ? { maxTokens: Number(model.maxTokens) } : {}),
				}))
			: [];
		void models;
		const validationConfig: ProviderValidationConfig = {
			baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
			apiKey: typeof provider.apiKey === "string" ? provider.apiKey : undefined,
			auth: provider.auth as ProviderValidationConfig["auth"],
			...(typeof provider.api === "string" ? { api: provider.api as ProviderValidationConfig["api"] } : {}),
			models: models.map(model => ({
				id: model.id,
				...(typeof model.api === "string" ? { api: model.api as ProviderValidationConfig["api"] } : {}),
				...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
				...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
			})),
		};
		try {
			validateProviderConfiguration(name, validationConfig, "models-config");
		} catch (error) {
			return this.host.context.error(
				command.id,
				"upsert_provider",
				error instanceof Error ? error.message : String(error),
			);
		}
		const config = ModelsConfigFile.loadOrDefault();
		const providers = { ...(config.providers ?? {}) };
		providers[name] = {
			...(isRecord(providers[name]) ? providers[name] : {}),
			...(typeof provider.baseUrl === "string" ? { baseUrl: provider.baseUrl } : {}),
			...(typeof provider.apiKey === "string" ? { apiKey: provider.apiKey } : {}),
			...(provider.auth !== undefined ? { auth: provider.auth } : {}),
			...(provider.api !== undefined ? { api: provider.api } : {}),
			...(provider.models !== undefined ? { models: validationConfig.models } : {}),
		} as (typeof providers)[string];
		try {
			await this.#writeModelsConfig({ ...config, providers });
		} catch (error) {
			return this.host.context.error(
				command.id,
				"upsert_provider",
				error instanceof Error ? error.message : String(error),
			);
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "upsert_provider", { provider: name });
	}

	async #deleteProvider(command: RpcForkCommandBase): Promise<RpcResponse> {
		const name = (command as { provider?: unknown }).provider;
		if (typeof name !== "string" || !name) {
			return this.host.context.error(command.id, "delete_provider", "provider is required");
		}
		const config = ModelsConfigFile.loadOrDefault();
		const providers = { ...(config.providers ?? {}) };
		if (!Object.hasOwn(providers, name)) {
			return this.host.context.error(
				command.id,
				"delete_provider",
				`Provider not configured in models.yml: ${name}`,
				"provider_not_configured",
			);
		}
		delete providers[name];
		try {
			await this.#writeModelsConfig({ ...config, providers });
		} catch (error) {
			return this.host.context.error(
				command.id,
				"delete_provider",
				error instanceof Error ? error.message : String(error),
			);
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "delete_provider", { provider: name });
	}

	/** models.yml has no ConfigFile write API — read-modify-write + invalidate. */
	async #writeModelsConfig(config: Record<string, unknown>): Promise<void> {
		const filePath = path.join(getAgentDir(), "models.yml");
		await fs.writeFile(filePath, stringifyYamlConfig(config), "utf-8");
		ModelsConfigFile.invalidate();
	}

	async #setModelEnabled(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { provider, modelId, enabled } = command as { provider?: unknown; modelId?: unknown; enabled?: unknown };
		if (typeof provider !== "string" || typeof modelId !== "string" || typeof enabled !== "boolean") {
			return this.host.context.error(command.id, "set_model_enabled", "provider, modelId, and enabled are required");
		}
		const pattern = `${provider}/${modelId}`;
		const settings = this.session.settings;
		const current = cfgEnabledModels.get(settings) ?? [];
		const has = current.includes(pattern);
		if (enabled && !has) {
			// `enabledModels` is an allowlist: an empty list means "everything",
			// so the first explicit enable starts restricting the catalog.
			cfgEnabledModels.setMember(settings, pattern, { member: true });
		} else if (!enabled && has) {
			cfgEnabledModels.setMember(settings, pattern, { member: false });
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "set_model_enabled", { pattern, enabled });
	}

	async #testModel(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { provider, modelId } = command as { provider?: unknown; modelId?: unknown };
		if (typeof provider !== "string" || typeof modelId !== "string") {
			return this.host.context.error(command.id, "test_model", "provider and modelId are required");
		}
		let models = this.session.getAvailableModels();
		let model: Model | undefined = models.find(m => m.provider === provider && m.id === modelId);
		if (!model) {
			await this.session.modelRegistry.awaitBackgroundRefresh();
			models = this.session.getAvailableModels();
			model = models.find(m => m.provider === provider && m.id === modelId);
		}
		if (!model) {
			return this.host.context.success(command.id, "test_model", {
				ok: false,
				latencyMs: 0,
				error: { category: "model_not_found", message: `Model not found: ${provider}/${modelId}` },
			} satisfies RpcForkModelTestResult);
		}
		if (!this.session.modelRegistry.getProviderBaseUrl(provider)) {
			return this.host.context.success(command.id, "test_model", {
				ok: false,
				latencyMs: 0,
				error: { category: "endpoint_not_configured", message: `No endpoint configured for provider ${provider}` },
			} satisfies RpcForkModelTestResult);
		}
		const startedAt = Date.now();
		try {
			const apiKey = await this.session.modelRegistry.authStorage.keys.get(provider);
			if (!apiKey) {
				return this.host.context.success(command.id, "test_model", {
					ok: false,
					latencyMs: Date.now() - startedAt,
					error: { category: "auth_failed", message: `No credential available for provider ${provider}` },
				} satisfies RpcForkModelTestResult);
			}
			const stream = streamSimple(
				model,
				{
					systemPrompt: ["You are a connectivity probe. Reply with the single word: ok."],
					messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
				},
				{ apiKey, maxTokens: 16, sessionId: this.session.sessionId },
			);
			for await (const event of stream) {
				if (event.type === "error") {
					return this.host.context.success(command.id, "test_model", {
						ok: false,
						latencyMs: Date.now() - startedAt,
						error: classifyModelTestError(event.error?.errorMessage ?? "request failed"),
					} satisfies RpcForkModelTestResult);
				}
			}
			const message = await stream.result();
			if (message.stopReason === "error" || message.errorMessage) {
				return this.host.context.success(command.id, "test_model", {
					ok: false,
					latencyMs: Date.now() - startedAt,
					error: classifyModelTestError(message.errorMessage ?? "request failed"),
				} satisfies RpcForkModelTestResult);
			}
			return this.host.context.success(command.id, "test_model", {
				ok: true,
				latencyMs: Date.now() - startedAt,
			} satisfies RpcForkModelTestResult);
		} catch (error) {
			return this.host.context.success(command.id, "test_model", {
				ok: false,
				latencyMs: Date.now() - startedAt,
				error: classifyModelTestError(error instanceof Error ? error.message : String(error)),
			} satisfies RpcForkModelTestResult);
		}
	}
}

/** Six-way attribution from AIError flags plus transport-level heuristics. */
export function classifyModelTestError(message: string): RpcForkModelTestResult["error"] {
	const flags = AIError.classifyMessage({ errorMessage: message });
	const statusMatch = /(?<!\d)(401|403|404|429|50[0-4])(?!\d)/.exec(message);
	const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
	let category: NonNullable<RpcForkModelTestResult["error"]>["category"] = "server";
	if (AIError.is(flags, AIError.Flag.AuthFailed) || httpStatus === 401 || httpStatus === 403) {
		category = "auth_failed";
	} else if (httpStatus === 429 || AIError.is(flags, AIError.Flag.UsageLimit)) {
		category = "rate_limited";
	} else if (httpStatus === 404) {
		category = "model_not_found";
	} else if (/network|econnrefused|econnreset|enotfound|etimedout|fetch failed|socket/i.test(message)) {
		category = "network";
	}
	return {
		category,
		message,
		...(httpStatus !== undefined ? { httpStatus } : {}),
	};
}
