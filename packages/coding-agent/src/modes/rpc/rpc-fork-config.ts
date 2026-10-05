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
 *
 * The controller is session-optional: it holds the narrow
 * {@link RpcForkServiceContext} slice it actually needs, so project mode
 * (`omp --mode rpc-ui --rpc-project`) can answer every command here with ZERO
 * sessions loaded. Session-backed callers keep the historical constructor
 * shape and are converted via {@link serviceContextFromSession}.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Model, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getAgentDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import { YAML } from "bun";
import { orderedSettings } from "../../config/all-settings";
import { COMPANY_PROVIDER_ID } from "../../config/company-provider";
import { createSettingsHost } from "../../config/settings-ui";
import { lookup, settingValuesEqual } from "../../config/registry";
import {
	ModelsConfigFile,
	validateProviderConfiguration,
	type ProviderValidationConfig,
	type ProviderValidationModel,
} from "../../config/models-config";
import { cfgDisabledModels, cfgDisabledProviders, cfgEnabledModels } from "../../config/model-settings";
import {
	filterAvailableModelsByDisabledPatterns,
	filterAvailableModelsByEnabledPatterns,
} from "../../config/model-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import { UserSettingConflictError, withActiveSettings, type Settings } from "../../config/settings";
import { ZCODE_API_PROVIDER_ID } from "../../config/zcode-api-models";
import { replaceFileAtomically } from "../../utils/atomic-file";
import type { AuthStorage } from "../../session/auth-storage";
import type { AgentSession } from "../../session/agent-session";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase, RpcForkModelTestResult } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

const MASKED_CREDENTIAL = "••••••••";

/** Render an unknown thrown value as the wire error message. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Legal models.yml `api` values — must stay aligned with ApiSchema in config/models-config-schema-bundle.ts. */
const PROVIDER_APIS: readonly ProviderValidationConfig["api"][] = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"openrouter-decisions",
	"typesafe",
];

const PROVIDER_AUTH_MODES: readonly ProviderValidationConfig["auth"][] = ["apiKey", "none", "oauth"];

export interface RpcForkSettingsEntry {
	key: string;
	type: string;
	value: unknown;
	/** Persisted user-layer value, masked for credentials; omitted when unset. */
	userValue?: unknown;
	/** Opaque revision of the raw user field used by revision-controlled writes. */
	revision: string;
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

interface RpcUserSettingSnapshot {
	readonly key: string;
	readonly revision: string;
	readonly value: unknown;
}

interface RpcUserSettingsRevisions {
	readonly current: Map<string, RpcUserSettingSnapshot>;
	readonly previous: Map<string, RpcUserSettingSnapshot>;
}

const userSettingsRevisions = new WeakMap<Settings, RpcUserSettingsRevisions>();
const MAX_PREVIOUS_USER_SETTING_REVISIONS = 128;

/** Internal, unredacted CAS snapshot; wire projections must mask credential values. */
export function getRpcUserSettingSnapshot(settings: Settings, key: string): RpcUserSettingSnapshot {
	let revisions = userSettingsRevisions.get(settings);
	if (!revisions) {
		revisions = { current: new Map(), previous: new Map() };
		userSettingsRevisions.set(settings, revisions);
	}
	const value = settings.getUserSettingValue(key);
	const previous = revisions.current.get(key);
	if (previous && settingValuesEqual(previous.value, value)) return previous;
	if (previous) {
		revisions.previous.set(previous.revision, previous);
		if (revisions.previous.size > MAX_PREVIOUS_USER_SETTING_REVISIONS) {
			const oldest = revisions.previous.keys().next().value;
			if (oldest !== undefined) revisions.previous.delete(oldest);
		}
	}
	const snapshot = { key, value, revision: randomUUID() };
	revisions.current.set(key, snapshot);
	return snapshot;
}

function expectedRpcUserSettingSnapshot(settings: Settings, key: string, revision: unknown): RpcUserSettingSnapshot {
	const revisions = userSettingsRevisions.get(settings);
	const current = revisions?.current.get(key);
	const snapshot =
		current?.revision === revision
			? current
			: typeof revision === "string"
				? revisions?.previous.get(revision)
				: undefined;
	if (!snapshot || snapshot.key !== key) {
		throw Object.assign(new Error(`User setting "${key}" revision is stale or unknown`), { code: "stale_revision" });
	}
	return snapshot;
}

/** Persist against the exact published user field, never effective/runtime/project values. */
export async function saveRpcUserSetting(
	settings: Settings,
	key: string,
	value: unknown,
	expectedRevision: unknown,
): Promise<string> {
	const snapshot = expectedRpcUserSettingSnapshot(settings, key, expectedRevision);
	try {
		await settings.saveUserSetting(key, value, snapshot.value);
	} catch (error) {
		if (error instanceof UserSettingConflictError) {
			throw Object.assign(error, { code: "stale_revision" });
		}
		throw error;
	}
	return getRpcUserSettingSnapshot(settings, key).revision;
}

function settingsErrorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Minimal service context the fork config/manage controllers actually need.
 * Project mode answers `get_settings`/`set_settings`/`unset_settings`/
 * `list_providers`/provider CRUD/`set_model_enabled`/`test_model` (and the
 * manage tier) with zero sessions loaded, so the controllers operate on this
 * narrow slice instead of a full {@link AgentSession}. Session-backed callers
 * convert via {@link serviceContextFromSession}; wire behavior is identical
 * through either path.
 */
export interface RpcForkServiceContext {
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	/** Project root; the session cwd on the session path. */
	readonly cwd: string;
	/** Auth storage override; defaults to `modelRegistry.authStorage`. */
	readonly authStorage?: AuthStorage;
	/** Agent dir for models.yml / mcp.json; defaults to `getAgentDir()`. */
	readonly agentDir?: string;
	/**
	 * Session-bound availability view (`enabledModels`-filtered, exactly
	 * `session.getAvailableModels()`). Session-backed contexts call through to
	 * the live session; bare contexts omit it and the controllers mirror the
	 * same filtering over the registry plus settings.
	 */
	readonly getAvailableModels?: () => Model[];
	/** Owning session id (probe attribution in `test_model`); omitted contexts let the transport mint one. */
	readonly sessionId?: string;
}

/** Narrow an {@link AgentSession} to the {@link RpcForkServiceContext} slice the controllers use. */
export function serviceContextFromSession(session: AgentSession): RpcForkServiceContext {
	return {
		settings: session.settings,
		modelRegistry: session.modelRegistry,
		// Lazy getters keep the historical per-command read semantics: a
		// session's cwd and id can change mid-flight (cwd switches,
		// switchSession), and the controllers must follow, not snapshot.
		get cwd(): string {
			return session.sessionManager.getCwd();
		},
		authStorage: session.modelRegistry.authStorage,
		getAvailableModels: () => session.getAvailableModels(),
		get sessionId(): string | undefined {
			return session.sessionId;
		},
	};
}

/**
 * Constructor-argument normalizer: a context passes through unchanged, an
 * {@link AgentSession} converts. Detection keys off the context's `cwd` field:
 * AgentSession also exposes `settings`/`modelRegistry`, but it resolves its
 * cwd through `sessionManager.getCwd()` and has no `cwd` property.
 */
export function asRpcForkServiceContext(source: AgentSession | RpcForkServiceContext): RpcForkServiceContext {
	const candidate = source as Partial<RpcForkServiceContext>;
	return typeof candidate.cwd === "string" && candidate.settings !== undefined && candidate.modelRegistry !== undefined
		? (source as RpcForkServiceContext)
		: serviceContextFromSession(source as AgentSession);
}

export class RpcForkConfigController {
	readonly #agentDir: string;
	readonly #ctx: RpcForkServiceContext;

	constructor(
		private readonly host: RpcForkHost,
		session: AgentSession | RpcForkServiceContext,
		options?: { agentDir?: string },
	) {
		this.#ctx = asRpcForkServiceContext(session);
		this.#agentDir = options?.agentDir ?? this.#ctx.agentDir ?? getAgentDir();
		host.registerCommand("get_settings", command => this.#getSettings(command));
		host.registerCommand("set_settings", command => this.#setSettings(command));
		host.registerCommand("unset_settings", command => this.#unsetSettings(command));
		host.registerCommand("list_providers", command => this.#listProviders(command));
		host.registerCommand("upsert_provider", command => this.#upsertProvider(command));
		host.registerCommand("delete_provider", command => this.#deleteProvider(command));
		host.registerCommand("set_model_enabled", command => this.#setModelEnabled(command));
		host.registerCommand("test_model", command => this.#testModel(command));
	}

	/**
	 * Available models for listing/probing. Session-backed contexts reuse the
	 * session's `enabledModels`-filtered view; bare contexts mirror that
	 * filtering directly over the registry (same semantics as
	 * `session/model-controls getAvailableModels`).
	 */
	#availableModels(): Model[] {
		const sessionView = this.#ctx.getAvailableModels;
		if (sessionView) return sessionView();
		const all = this.#ctx.modelRegistry.getAvailable();
		const patterns = cfgEnabledModels.get(this.#ctx.settings) ?? [];
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.#ctx.settings);
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
		const settings = this.#ctx.settings;
		const projectLayer = this.#projectLayer(settings);
		return withActiveSettings(settings, () => {
			const entries: RpcForkSettingsEntry[] = [];
			for (const setting of orderedSettings()) {
				let projectValue: unknown = projectLayer;
				let projectConfigured = true;
				for (const segment of setting.segments) {
					if (!isRecord(projectValue) || !Object.hasOwn(projectValue, segment)) {
						projectConfigured = false;
						break;
					}
					projectValue = projectValue[segment];
				}
				if (scope === "project" && !projectConfigured) continue;
				const snapshot = getRpcUserSettingSnapshot(settings, setting.id);
				const credential = setting.isCredential;
				const raw = setting.layered(settings);
				const entry = {
					key: setting.id,
					type: setting.type,
					value: credential ? maskCredential(raw) : raw,
					userValue: credential ? maskCredential(snapshot.value) : snapshot.value,
					revision: snapshot.revision,
					defaultValue: credential ? maskCredential(setting.default) : setting.default,
					credential,
					provenance: settings.getProvenance(setting),
					projectConfigured,
				};
				entries.push(entry);
			}
			return this.host.context.success(command.id, "get_settings", { scope, entries });
		});
	}

	async #setSettings(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { scope, key, value, expectedRevision } = command as {
			scope?: unknown;
			key?: unknown;
			value?: unknown;
			expectedRevision?: unknown;
		};
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
			if (expectedRevision === undefined) {
				withActiveSettings(this.#ctx.settings, () => this.#settingsHost().set(key, value));
			} else {
				await saveRpcUserSetting(this.#ctx.settings, key, value, expectedRevision);
			}
		} catch (error) {
			return this.host.context.error(command.id, "set_settings", errorMessage(error), settingsErrorCode(error));
		}
		this.emitSettingsChanged("user");
		const snapshot = expectedRevision === undefined ? undefined : getRpcUserSettingSnapshot(this.#ctx.settings, key);
		return this.host.context.success(command.id, "set_settings", {
			key,
			...(snapshot
				? {
						revision: snapshot.revision,
						userValue: lookup(key)?.isCredential ? maskCredential(snapshot.value) : snapshot.value,
					}
				: {}),
		});
	}

	async #unsetSettings(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { scope, key, expectedRevision } = command as {
			scope?: unknown;
			key?: unknown;
			expectedRevision?: unknown;
		};
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
			if (expectedRevision === undefined) {
				withActiveSettings(this.#ctx.settings, () => this.#settingsHost().unset(key));
			} else {
				await saveRpcUserSetting(this.#ctx.settings, key, undefined, expectedRevision);
			}
		} catch (error) {
			return this.host.context.error(command.id, "unset_settings", errorMessage(error), settingsErrorCode(error));
		}
		this.emitSettingsChanged("user");
		const snapshot = expectedRevision === undefined ? undefined : getRpcUserSettingSnapshot(this.#ctx.settings, key);
		return this.host.context.success(command.id, "unset_settings", {
			key,
			...(snapshot
				? {
						revision: snapshot.revision,
						userValue: lookup(key)?.isCredential ? maskCredential(snapshot.value) : snapshot.value,
					}
				: {}),
		});
	}

	emitSettingsChanged(scope: "user" | "project"): void {
		this.host.context.emit({ type: "settings_changed", scope });
	}

	async #listProviders(command: RpcForkCommandBase): Promise<RpcResponse> {
		await this.#ctx.modelRegistry.awaitBackgroundRefresh();
		const models = this.#availableModels();
		const byProvider = new Map<string, Array<{ id: string; contextWindow?: number }>>();
		for (const model of models) {
			const list = byProvider.get(model.provider) ?? [];
			list.push({
				id: model.id,
				...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
			});
			byProvider.set(model.provider, list);
		}
		const config = await this.#readModelsConfig();
		const configured = isRecord(config.providers) ? config.providers : {};
		const settings = this.#ctx.settings;
		const disabled = cfgDisabledProviders.get(settings) ?? [];
		const providers = [...new Set([...byProvider.keys(), ...Object.keys(configured)])].sort().map(provider => {
			const discovery = this.#ctx.modelRegistry.getProviderDiscoveryState(provider);
			return {
				provider,
				models: byProvider.get(provider) ?? [],
				configured: Object.hasOwn(configured, provider),
				disabled: disabled.includes(provider),
				baseUrl: this.#ctx.modelRegistry.getProviderBaseUrl(provider),
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
		if (name === COMPANY_PROVIDER_ID) {
			return this.host.context.error(
				command.id,
				"upsert_provider",
				"Company provider configuration comes from the startup Claude settings, not models.yml",
				"unsupported",
			);
		}
		if (name === ZCODE_API_PROVIDER_ID && Object.keys(provider).some(key => key !== "name" && key !== "apiKey")) {
			return this.host.context.error(
				command.id,
				"upsert_provider",
				"zcode-api accepts only apiKey in models.yml; its endpoint, transport, and models are runtime-owned",
				"unsupported",
			);
		}
		// Sanitize first, then validate and write the exact same payload: values
		// models.yml's schema would reject on the next load must fail here instead
		// of bricking the config (loadOrDefault silently falls back to defaults,
		// dropping every custom provider).
		const payload: {
			baseUrl?: string;
			apiKey?: string;
			auth?: ProviderValidationConfig["auth"];
			api?: ProviderValidationConfig["api"];
			models?: ProviderValidationModel[];
		} = {};
		if (provider.baseUrl !== undefined) {
			if (typeof provider.baseUrl !== "string") {
				return this.host.context.error(command.id, "upsert_provider", "provider.baseUrl must be a string");
			}
			payload.baseUrl = provider.baseUrl;
		}
		if (provider.apiKey !== undefined) {
			if (typeof provider.apiKey !== "string") {
				return this.host.context.error(command.id, "upsert_provider", "provider.apiKey must be a string");
			}
			payload.apiKey = provider.apiKey;
		}
		if (provider.auth !== undefined) {
			if (
				typeof provider.auth !== "string" ||
				!PROVIDER_AUTH_MODES.includes(provider.auth as ProviderValidationConfig["auth"])
			) {
				return this.host.context.error(
					command.id,
					"upsert_provider",
					`provider.auth must be one of: ${PROVIDER_AUTH_MODES.join(", ")}`,
				);
			}
			payload.auth = provider.auth as ProviderValidationConfig["auth"];
		}
		if (provider.api !== undefined) {
			if (typeof provider.api !== "string" || !PROVIDER_APIS.includes(provider.api)) {
				return this.host.context.error(
					command.id,
					"upsert_provider",
					`provider.api must be one of: ${PROVIDER_APIS.join(", ")}`,
				);
			}
			payload.api = provider.api;
		}
		if (provider.models !== undefined) {
			if (!Array.isArray(provider.models)) {
				return this.host.context.error(command.id, "upsert_provider", "provider.models must be an array");
			}
			payload.models = [];
			for (const [index, entry] of provider.models.entries()) {
				if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) {
					return this.host.context.error(
						command.id,
						"upsert_provider",
						`provider.models[${index}] must be an object with a non-empty "id"`,
					);
				}
				const model: ProviderValidationModel = { id: entry.id };
				if (entry.api !== undefined) {
					if (typeof entry.api !== "string" || !PROVIDER_APIS.includes(entry.api)) {
						return this.host.context.error(
							command.id,
							"upsert_provider",
							`provider.models[${index}].api must be one of: ${PROVIDER_APIS.join(", ")}`,
						);
					}
					model.api = entry.api;
				}
				if (entry.contextWindow !== undefined) {
					if (
						typeof entry.contextWindow !== "number" ||
						!Number.isFinite(entry.contextWindow) ||
						entry.contextWindow <= 0
					) {
						return this.host.context.error(
							command.id,
							"upsert_provider",
							`provider.models[${index}].contextWindow must be a positive number`,
						);
					}
					model.contextWindow = entry.contextWindow;
				}
				if (entry.maxTokens !== undefined) {
					if (typeof entry.maxTokens !== "number" || !Number.isFinite(entry.maxTokens) || entry.maxTokens <= 0) {
						return this.host.context.error(
							command.id,
							"upsert_provider",
							`provider.models[${index}].maxTokens must be a positive number`,
						);
					}
					model.maxTokens = entry.maxTokens;
				}
				payload.models.push(model);
			}
		}
		try {
			validateProviderConfiguration(name, { ...payload, models: payload.models ?? [] }, "models-config");
		} catch (error) {
			return this.host.context.error(command.id, "upsert_provider", errorMessage(error));
		}
		try {
			await this.#updateModelsConfig(config => {
				const providers = { ...(isRecord(config.providers) ? config.providers : undefined) };
				providers[name] = {
					...(isRecord(providers[name]) ? providers[name] : {}),
					...(payload.baseUrl !== undefined ? { baseUrl: payload.baseUrl } : {}),
					...(payload.apiKey !== undefined ? { apiKey: payload.apiKey } : {}),
					...(payload.auth !== undefined ? { auth: payload.auth } : {}),
					...(payload.api !== undefined ? { api: payload.api } : {}),
					...(payload.models !== undefined ? { models: payload.models } : {}),
				};
				config.providers = providers;
			});
		} catch (error) {
			return this.host.context.error(command.id, "upsert_provider", errorMessage(error));
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "upsert_provider", { provider: name });
	}

	async #deleteProvider(command: RpcForkCommandBase): Promise<RpcResponse> {
		const name = (command as { provider?: unknown }).provider;
		if (typeof name !== "string" || !name.trim()) {
			return this.host.context.error(command.id, "delete_provider", "provider is required");
		}
		try {
			await this.#updateModelsConfig(config => {
				const providers = { ...(isRecord(config.providers) ? config.providers : undefined) };
				if (!Object.hasOwn(providers, name.trim())) {
					throw Object.assign(new Error(`Provider not configured in models.yml: ${name}`), {
						code: "provider_not_configured",
					});
				}
				delete providers[name.trim()];
				config.providers = providers;
			});
		} catch (error) {
			return this.host.context.error(command.id, "delete_provider", errorMessage(error), settingsErrorCode(error));
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "delete_provider", { provider: name.trim() });
	}

	/** Lock only the config transaction, including fresh reads, across project processes. */
	async #updateModelsConfig(update: (config: Record<string, unknown>) => void): Promise<void> {
		await fs.mkdir(this.#agentDir, { recursive: true, mode: 0o700 });
		const modelsPath = path.join(await fs.realpath(this.#agentDir), "models.yml");
		let writePath = modelsPath;
		try {
			writePath = await fs.realpath(modelsPath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		await withFileLock(writePath, async () => {
			ModelsConfigFile.invalidate();
			this.#assertModelsConfigLoadable();
			const config = await this.#readModelsConfig(writePath);
			update(config);
			await this.#writeModelsConfig(config, writePath);
		});
		await this.#ctx.modelRegistry.awaitBackgroundRefresh();
		await this.#ctx.modelRegistry.reapplyModelPolicies();
	}

	/**
	 * Refuses provider CRUD when the production models.yml exists but fails
	 * parse/schema validation: a read-modify-write would otherwise replace the
	 * whole file (other custom providers included) with defaults plus this
	 * edit. Not-found passes through. Only evaluated on the production path —
	 * an injected `agentDir` (test seam) skips this check so tests do not
	 * couple to the host machine's real config validity.
	 */
	#assertModelsConfigLoadable(): void {
		if (this.#agentDir !== getAgentDir()) return;
		const loaded = ModelsConfigFile.tryLoad();
		if (loaded.status === "error") {
			throw new Error(`models.yml is invalid (${loaded.error.message}); fix it before editing providers`);
		}
	}

	/**
	 * Preserve the persisted YAML, not the runtime-normalized view: loading
	 * strips ignored reserved-provider fields that unrelated CRUD must not erase.
	 */
	async #readModelsConfig(filePath = path.join(this.#agentDir, "models.yml")): Promise<Record<string, unknown>> {
		try {
			const parsed = YAML.parse(await fs.readFile(filePath, "utf-8"));
			if (parsed == null) return {};
			if (!isRecord(parsed)) throw new Error("models.yml must contain a mapping");
			if (parsed.providers !== undefined && !isRecord(parsed.providers)) {
				throw new Error("models.yml providers must contain a mapping");
			}
			return parsed;
		} catch (error) {
			if (isEnoent(error)) return {};
			throw error;
		}
	}

	/** models.yml has no ConfigFile write API — read-modify-write + invalidate. */
	async #writeModelsConfig(config: Record<string, unknown>, filePath: string): Promise<void> {
		const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(tmpPath, stringifyYamlConfig(config), { encoding: "utf-8", mode: 0o600 });
			await replaceFileAtomically(tmpPath, filePath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
		ModelsConfigFile.invalidate();
	}

	async #setModelEnabled(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { provider, modelId, enabled } = command as { provider?: unknown; modelId?: unknown; enabled?: unknown };
		if (typeof provider !== "string" || typeof modelId !== "string" || typeof enabled !== "boolean") {
			return this.host.context.error(command.id, "set_model_enabled", "provider, modelId, and enabled are required");
		}
		const pattern = `${provider}/${modelId}`;
		const settings = this.#ctx.settings;
		try {
			await this.#ctx.modelRegistry.awaitBackgroundRefresh();
			const catalog = this.#ctx.modelRegistry.getAll("all");
			const isTarget = (model: Model): boolean => model.provider === provider && model.id === modelId;
			if (!catalog.some(isTarget)) {
				return this.host.context.error(
					command.id,
					"set_model_enabled",
					`Model not found: ${pattern}`,
					"model_not_found",
				);
			}
			const positiveSnapshot = getRpcUserSettingSnapshot(settings, cfgEnabledModels.id);
			const negativeSnapshot = getRpcUserSettingSnapshot(settings, cfgDisabledModels.id);
			const positive = Array.isArray(positiveSnapshot.value) ? positiveSnapshot.value : [];
			const negative = Array.isArray(negativeSnapshot.value) ? negativeSnapshot.value : [];
			let nextPositive = positive;
			let nextNegative = negative;
			if (!enabled) {
				if (!negative.includes(pattern)) nextNegative = [...negative, pattern];
			} else {
				if (negative.includes(pattern)) nextNegative = negative.filter(value => value !== pattern);
				// Resolve persisted path-scoped arrays without staging mutations on the live settings.
				const prospective = settings.previewUserSettings({
					[cfgEnabledModels.id]: positive,
					[cfgDisabledModels.id]: nextNegative,
				});
				const remaining = filterAvailableModelsByDisabledPatterns(
					catalog,
					cfgDisabledModels.get(prospective),
					prospective,
				);
				if (!remaining.some(isTarget)) {
					return this.host.context.error(
						command.id,
						"set_model_enabled",
						`${pattern} remains excluded by another disabledModels rule; update that rule explicitly`,
						"unsupported",
					);
				}
				const patterns = cfgEnabledModels.get(prospective);
				if (
					patterns.length > 0 &&
					!filterAvailableModelsByEnabledPatterns(catalog, patterns, prospective).some(isTarget)
				) {
					nextPositive = [...positive, pattern];
					const expanded = settings.previewUserSettings({
						[cfgEnabledModels.id]: nextPositive,
						[cfgDisabledModels.id]: nextNegative,
					});
					if (
						!filterAvailableModelsByEnabledPatterns(catalog, cfgEnabledModels.get(expanded), expanded).some(
							isTarget,
						)
					) {
						return this.host.context.error(
							command.id,
							"set_model_enabled",
							`${pattern} remains outside the effective enabledModels scope`,
							"unsupported",
						);
					}
				}
			}
			const mutations: { settingId: string; value: unknown; expectedValue: unknown }[] = [
				{
					settingId: cfgDisabledModels.id,
					value: nextNegative === negative ? negativeSnapshot.value : nextNegative,
					expectedValue: negativeSnapshot.value,
				},
			];
			if (enabled) {
				mutations.push({
					settingId: cfgEnabledModels.id,
					value: nextPositive === positive ? positiveSnapshot.value : nextPositive,
					expectedValue: positiveSnapshot.value,
				});
			}
			await settings.saveUserSettings(mutations);
		} catch (error) {
			return this.host.context.error(
				command.id,
				"set_model_enabled",
				errorMessage(error),
				error instanceof UserSettingConflictError ? "stale_revision" : settingsErrorCode(error),
			);
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "set_model_enabled", {
			pattern,
			enabled,
			revisions: {
				enabledModels: getRpcUserSettingSnapshot(settings, cfgEnabledModels.id).revision,
				disabledModels: getRpcUserSettingSnapshot(settings, cfgDisabledModels.id).revision,
			},
		});
	}

	async #testModel(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { provider, modelId } = command as { provider?: unknown; modelId?: unknown };
		if (typeof provider !== "string" || typeof modelId !== "string") {
			return this.host.context.error(command.id, "test_model", "provider and modelId are required");
		}
		let models = this.#availableModels();
		let model: Model | undefined = models.find(m => m.provider === provider && m.id === modelId);
		if (!model) {
			await this.#ctx.modelRegistry.awaitBackgroundRefresh();
			models = this.#availableModels();
			model = models.find(m => m.provider === provider && m.id === modelId);
		}
		if (!model) {
			return this.host.context.success(command.id, "test_model", {
				ok: false,
				latencyMs: 0,
				error: { category: "model_not_found", message: `Model not found: ${provider}/${modelId}` },
			} satisfies RpcForkModelTestResult);
		}
		if (!this.#ctx.modelRegistry.getProviderBaseUrl(provider)) {
			return this.host.context.success(command.id, "test_model", {
				ok: false,
				latencyMs: 0,
				error: { category: "endpoint_not_configured", message: `No endpoint configured for provider ${provider}` },
			} satisfies RpcForkModelTestResult);
		}
		const startedAt = Date.now();
		try {
			const apiKey = await this.#ctx.modelRegistry.getApiKey(model, this.#ctx.sessionId);
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
				{ apiKey, maxTokens: 16, sessionId: this.#ctx.sessionId },
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
				error: classifyModelTestError(errorMessage(error)),
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
