import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { completeSimple, type Api, type Model } from "@oh-my-pi/pi-ai";
import { concreteThinkingLevel, parseConfiguredThinkingLevel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { z } from "zod";
import { ModelRegistry, type ProviderConfigInput } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { discoverAuthStorage } from "../../sdk";
import { AuthStorage } from "../../session/auth-storage";
import { modelSelectionSchema, type ModelSelection } from "./schema/vendor/model-selection";
import {
	compileModelOptionMaps,
	type CompiledModelOptionMaps,
	type JsonObject,
} from "./schema/vendor/model-option-map/index";
import {
	zcodeProviderUpdateAccountConfigParamsSchema,
	zcodeProviderRefreshRegistryParamsSchema,
	zcodeProviderTestModelConnectivityParamsSchema,
	zcodeWorkspaceUpdateInteractionPreferencesParamsSchema,
	zcodeWorkspaceUpdateModelIoPreferencesParamsSchema,
	zcodeProviderAccountAccessSchema,
	zcodeProviderRuntimeHeadersRequestParamsSchema,
	zcodeProviderRuntimeHeadersResponseSchema,
	type ZCodeProviderRuntimeHeadersRequestParams,
	type ZCodeProviderRuntimeHeadersResponse,
	type ZCodeProviderAccountAccess,
	type ZCodeWorkspaceRef,
} from "./schema/vendor/zcode-protocol/index";

export interface ZCodeConfigurationRecord {
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
}
export interface ZCodeWorkspacePreferences {
	askUserQuestionAutoResolutionEnabled: boolean;
	fullRetentionEnabled: boolean;
}
export interface ZCodeProviderConfigurationOptions {
	env?: Readonly<Record<string, string | undefined>>;
	records?: () => Iterable<ZCodeConfigurationRecord>;
	applyInteractionPreferences?: (cwd: string, enabled: boolean) => number;
	applyModelIoPreferences?: (cwd: string, enabled: boolean) => number;
	applyRegistryUpdate?: (record: ZCodeConfigurationRecord) => Promise<void>;
	requestRuntimeHeaders?: (params: ZCodeProviderRuntimeHeadersRequestParams, signal?: AbortSignal) => Promise<unknown>;
	createCatalogAuthStorage?: (cwd: string, settings: Settings) => Promise<AuthStorage>;
}
type ObjectValue = Record<string, unknown>;
const object = z.record(z.string(), z.unknown());
const api = z
	.object({
		type: z.enum(["anthropic-messages", "openai-chat-completions", "openai-responses"]).nullable().optional(),
		baseUrl: z.string().url().nullable().optional(),
		headers: z.record(z.string(), z.string()).nullable().optional(),
	})
	.strict();
// 个人层允许暂存编辑中的 endpoint(对齐 GUI provider-data-schema 的 personalProviderApiDataSchema);
// 完整性校验移到逐 provider 准入,单个草稿不再让整个 catalog 失败。
const personalApi = api.extend({ baseUrl: z.string().nullable().optional() });
const access = z
	.object({
		type: z.enum(["api-key", "zhipu-coding-plan-api-key", "zhipu-account"]),
		apiKey: z.string().nullable().optional(),
		apiKeyManagementUrl: z.string().nullable().optional(),
		accountType: z.string().optional(),
		mode: z.string().optional(),
		entitled: z.boolean().optional(),
	})
	.strict();
const provider = z
	.object({
		group: z.string().nullable().optional(),
		logo: object.nullable().optional(),
		access: access.nullable().optional(),
		api: api.nullable().optional(),
		builtinModelIds: z.array(z.string().min(1)).nullable().optional(),
		personalModelIds: z.array(z.string().min(1)).nullable().optional(),
		modelOrder: z.array(z.string().min(1)).nullable().optional(),
		visibility: z.enum(["visible", "hidden"]).nullable().optional(),
	})
	.strict();
const providerRule = z
	.object({
		providerId: z.string().min(1),
		templateId: z.string().nullable().optional(),
		providerName: z.string().nullable().optional(),
		enabled: z.boolean().optional(),
		config: provider,
	})
	.strict();
// 个人层 provider 规则使用宽松 api schema;完整 schema 仍逐 provider 校验,拒绝只影响该 provider 的准入。
const personalProvider = provider.extend({ api: personalApi.nullable().optional() });
const personalProviderRule = providerRule.extend({ config: personalProvider });
const rule = z
	.object({
		modelMatch: z.string().optional(),
		apiTypeMatch: z.string().optional(),
		baseUrlMatch: z.string().optional(),
		templateId: z.string().optional(),
		providerId: z.string().optional(),
		modelId: z.string().optional(),
		config: object,
	})
	.strict();
const modelRules = z
	.object({
		modelRules: z.array(rule).optional(),
		modelApiRules: z.array(rule).optional(),
		providerSiteRules: z.array(rule).optional(),
		templateModelRules: z.array(rule).optional(),
		builtinProviderModelRules: z.array(rule).optional(),
		providerModelRules: z.array(rule).optional(),
		manualProviderModelRules: z.array(rule).optional(),
	})
	.strict();
const sourceOf = (ruleSchema: typeof providerRule | typeof personalProviderRule) =>
	z
		.object({
			schemaVersion: z.literal(1),
			revision: z.number().int().nonnegative().optional(),
			config: z
				.object({
					providerOrder: z.array(z.string()).optional(),
					providerConfigRules: z
						.object({
							providerRules: z.array(ruleSchema),
							templateRules: z
								.array(z.object({ templateId: z.string(), templateNameMap: object, config: provider }).strict())
								.optional(),
						})
						.strict(),
					modelConfigRules: modelRules,
					defaultModelSelection: modelSelectionSchema.optional(),
				})
				.strict(),
		})
		.strict();
const source = sourceOf(providerRule);
// 个人层解析使用宽松 provider schema(允许 endpoint 草稿);缺失文件时仍回退为空配置。
const personalSource = sourceOf(personalProviderRule);
type Source = z.infer<typeof source>;
type ProviderAccess = z.infer<typeof access>;
type Account = z.infer<typeof zcodeProviderUpdateAccountConfigParamsSchema>;
interface HostModelConfiguration {
	accountAccess?: ZCodeProviderAccountAccess;
	optionMaps?: CompiledModelOptionMaps;
	reasoningLevels: readonly string[];
	maxOutputTokens: number;
}
interface Template {
	providers: Map<string, ProviderConfigInput>;
	models: Map<string, HostModelConfiguration>;
	/** 准入失败被跳过的 provider 诊断;只影响对应 provider,不阻塞其余 provider 生效。 */
	diagnostics: readonly ZCodeProviderDiagnostic[];
	defaultSelection?: ModelSelection;
}
/** 单个 provider 被跳过时的诊断记录(GUI 侧 personal 层允许草稿,OMP 侧只降级不失败)。 */
export interface ZCodeProviderDiagnostic {
	providerId: string;
	message: string;
}
export interface ZCodeModelRequestContext {
	sessionId: string;
	workspace: ZCodeWorkspaceRef;
	modelSelection: ModelSelection;
}
const SOURCE = "zcode-host-provider-config";
const defaults: ZCodeWorkspacePreferences = { askUserQuestionAutoResolutionEnabled: true, fullRetentionEnabled: false };

/** ZCode's public disabled selector is OMP's explicit reasoning-off selector. */
export function parseZCodeThinkingLevel(value: string | null | undefined) {
	return parseConfiguredThinkingLevel(value === "disabled" ? "off" : value);
}

export function toZCodeReasoningLevel(value: string): string {
	return value === "off" ? "disabled" : value;
}

function hostReasoningLevel(config: HostModelConfiguration, value: string | undefined): string | undefined {
	if (value === undefined) return config.reasoningLevels[0];
	if (config.reasoningLevels.includes(value)) return value;
	if (value === "off" && config.reasoningLevels.includes("disabled")) return "disabled";
	if (value === "disabled" && config.reasoningLevels.includes("off")) return "off";
	// Binary Host controls have no effort scale. Any active native effort is
	// the same declared "enabled" choice, not an invented Host capability.
	if (
		config.reasoningLevels.includes("enabled") &&
		parseZCodeThinkingLevel(value) !== undefined &&
		value !== "off" &&
		value !== "disabled"
	)
		return "enabled";
	return value;
}

function merge(base: ObjectValue, overlay: ObjectValue): ObjectValue {
	const result = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (value === null) {
			delete result[key];
			continue;
		}
		const previous = result[key];
		result[key] = isObject(previous) && isObject(value) ? merge(previous, value) : value;
	}
	return result;
}
function isObject(value: unknown): value is ObjectValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nested(value: ObjectValue, key: string): ObjectValue {
	const result = value[key];
	return isObject(result) ? result : {};
}
function positive(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		throw new Error("Incomplete model metadata");
	return value;
}
function matches(pattern: string | undefined, value: string): boolean {
	// 与 GUI 侧 model-config.ts 的 matchesRule(..., ignoreCase) 一致:
	// 规则与模型 id 大小写不一致时不应落空到 catch-all 规则(如 GLM-5.3 档位丢失)。
	return pattern === undefined || new RegExp(`^(?:${pattern})$`, "i").test(value);
}
function normalizeBaseUrlForRuleMatch(value: string): string {
	// 与 GUI 侧 normalizeBaseURLForRuleMatch 一致:Host 大小写、默认端口和尾部斜杠不应影响 provider-site 规则命中。
	try {
		const parsed = new URL(value);
		const suffix = `${parsed.search}${parsed.hash}`;
		const serialized = parsed.toString();
		const endpoint = suffix.length === 0 ? serialized : serialized.slice(0, -suffix.length);
		return `${endpoint.replace(/\/+$/, "")}${suffix}`;
	} catch {
		return value;
	}
}
/** Provider 准入完整性(对齐 GUI complete schema):api 完整、access 齐备且无危险 headers;通过时返回收窄后的配置。 */
function completeProviderConfig(config: z.infer<typeof provider>):
	| {
			api: {
				type: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
				baseUrl: string;
				headers?: Record<string, string> | null;
			};
			access: ProviderAccess;
	  }
	| undefined {
	const api = config.api;
	if (!api?.type || typeof api.baseUrl !== "string") return undefined;
	try {
		new URL(api.baseUrl);
	} catch {
		return undefined;
	}
	if (Object.values(api.headers ?? {}).some(value => value.startsWith("!"))) return undefined;
	const providerAccess = config.access;
	if (!providerAccess) return undefined;
	if (providerAccess.type !== "zhipu-account") {
		// api-key 系列(GUI completeApiKeyAccessDataSchema):无密钥的是未完成草稿,不进入注册。
		if (!(typeof providerAccess.apiKey === "string" && providerAccess.apiKey.trim().length > 0)) return undefined;
	}
	// 显式重建 api 以保留属性级收窄(直接返回变量会丢失 baseUrl/type 的非空收窄)。
	return { api: { type: api.type, baseUrl: api.baseUrl, headers: api.headers }, access: providerAccess };
}

/** Host files remain the only persistent provider truth. Account credentials and templates are memory-only. */
export class ZCodeProviderConfiguration {
	readonly #options: ZCodeProviderConfigurationOptions;
	readonly #env: Readonly<Record<string, string | undefined>>;
	readonly #preferences = new Map<string, ZCodeWorkspacePreferences>();
	readonly #applied = new WeakMap<ModelRegistry, Template>();
	#account: Account | undefined;
	#template: Template | undefined;
	#serial: Promise<unknown> = Promise.resolve();
	constructor(options: ZCodeProviderConfigurationOptions = {}) {
		this.#options = options;
		this.#env = options.env ?? process.env;
	}
	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#serial.then(fn);
		this.#serial = result.catch(() => {});
		return result;
	}
	getWorkspacePreferences(cwd: string): ZCodeWorkspacePreferences {
		return { ...(this.#preferences.get(resolve(cwd)) ?? defaults) };
	}
	getDefaultModelSelection(): ModelSelection | undefined {
		const selection = this.#template?.defaultSelection;
		return selection ? structuredClone(selection) : undefined;
	}
	/** 最近一次已提交模板中因准入失败被跳过的 provider;诊断不阻塞其余 provider。 */
	getDiagnostics(): readonly ZCodeProviderDiagnostic[] {
		return this.#template?.diagnostics ?? [];
	}
	getReasoningLevels(providerId: string, modelId: string): readonly string[] | undefined {
		return this.#template?.models.get(`${providerId}\u0000${modelId}`)?.reasoningLevels;
	}
	/** History projection reads declared capabilities, never a model registry or credentials. */
	readReasoningConfig(providerId: string, modelId: string, thinkingLevel: string) {
		return this.#exclusive(async () => {
			const template = this.#template ?? (await this.#load(this.#account));
			const config = template.models.get(`${providerId}\u0000${modelId}`);
			return {
				thought: toZCodeReasoningLevel(
					(config ? hostReasoningLevel(config, thinkingLevel) : thinkingLevel) ?? thinkingLevel,
				),
				thoughtLevels: config?.reasoningLevels.map(toZCodeReasoningLevel) ?? [],
			};
		});
	}
	resolveThinkingLevel(providerId: string, modelId: string, level: string) {
		const config = this.#template?.models.get(`${providerId}\u0000${modelId}`);
		if (!config) return parseZCodeThinkingLevel(level);
		if (
			!config.reasoningLevels.includes(level) &&
			!(level === "off" && config.reasoningLevels.includes("disabled")) &&
			!(level === "disabled" && config.reasoningLevels.includes("off"))
		)
			return undefined;
		const declared = hostReasoningLevel(config, level);
		if (!declared || !config.reasoningLevels.includes(declared)) return undefined;
		// Native max means the model's supported ceiling; a binary Host switch
		// exposes no quantitative effort and remains "enabled" on the wire.
		return parseZCodeThinkingLevel(declared === "enabled" ? "max" : declared);
	}
	async catalog(cwd: string): Promise<Model<Api>[]> {
		const settings = await Settings.loadReadOnly({ cwd });
		const auth = await (this.#options.createCatalogAuthStorage?.(cwd, settings) ??
			discoverAuthStorage(undefined, { cwd, settings }));
		try {
			const registry = new ModelRegistry(auth, undefined, { settings });
			await this.prepare(cwd, settings, registry);
			await registry.hydrateCredentialScopedModelCaches();
			return registry.getAvailable();
		} finally {
			auth.close();
			settings.cancelPendingSaves();
		}
	}
	async testModelConnectivity(input: unknown, signal?: AbortSignal): Promise<{ success: true }> {
		const { workspace, selection } = zcodeProviderTestModelConnectivityParamsSchema.parse(input);
		signal?.throwIfAborted();
		const cwd = resolve(workspace.workspacePath);
		const live = this.#records().find(record => resolve(record.cwd) === cwd);
		const settings = live?.settings ?? (await Settings.loadReadOnly({ cwd }));
		let auth: AuthStorage | undefined;
		try {
			const registry =
				live?.modelRegistry ??
				new ModelRegistry(
					(auth = await (this.#options.createCatalogAuthStorage?.(cwd, settings) ??
						discoverAuthStorage(undefined, { cwd, settings }))),
					undefined,
					{ settings },
				);
			if (!live) await this.prepare(cwd, settings, registry);
			const model = registry.find(selection.providerId, selection.modelId);
			if (!model) throw new Error(`Unknown model: ${selection.providerId}/${selection.modelId}`);
			const level = selection.options?.reasoningLevel;
			const thinking = level === undefined ? undefined : this.resolveThinkingLevel(model.provider, model.id, level);
			if (level !== undefined && thinking === undefined) throw new Error("Unsupported Host reasoning level");
			const sessionId = randomUUID();
			const supplied = await this.resolveRequestAuth(
				{ sessionId, workspace, modelSelection: selection },
				model,
				signal,
			);
			// Host 显式 headers-only 凭据与正常会话一致：不得补入 registry/env 的另一把 key。
			const apiKey = supplied ? supplied.apiKey : await registry.getApiKey(model, sessionId, { signal });
			const headers = { ...(await registry.getProviderHeaders(model.provider)), ...supplied?.headers };
			if (apiKey === undefined && Object.keys(headers).length === 0)
				throw new Error(`No request authentication for provider: ${model.provider}`);
			// 连接测试必须执行原生请求并校验结果；不能把 HTTP 错误消息或空流当作连接成功。
			const response = await completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }] },
				{
					apiKey,
					headers,
					requestAuth: { apiKey, headers },
					signal,
					maxTokens: 8,
					maxHttpAttempts: 1,
					reasoning: toReasoningEffort(concreteThinkingLevel(thinking)),
					disableReasoning: thinking === "off",
					onPayload: payload => this.transformRequestPayload(payload, model, selection, 8),
				},
			);
			signal?.throwIfAborted();
			if (response.stopReason === "error" || response.stopReason === "aborted")
				throw new Error(response.errorMessage || `Provider request ${response.stopReason}`);
			if (!response.content.some(block => block.type === "text" && block.text.trim().length > 0))
				throw new Error("Provider returned no completion text");
			return { success: true };
		} finally {
			auth?.close();
			if (!live) settings.cancelPendingSaves();
		}
	}
	async resolveRequestAuth(
		context: ZCodeModelRequestContext,
		model: Model,
		signal?: AbortSignal,
	): Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined> {
		const config = this.#template?.models.get(`${model.provider}\u0000${model.id}`);
		if (!config?.accountAccess) return undefined;
		if (signal?.aborted) throw new Error("Provider credential request cancelled");
		if (!this.#options.requestRuntimeHeaders) throw new Error("Host provider credential resolver is unavailable");
		const reasoningLevel = hostReasoningLevel(config, context.modelSelection.options?.reasoningLevel);
		const params = zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
			requestId: randomUUID(),
			sessionId: context.sessionId,
			workspace: context.workspace,
			modelSelection:
				reasoningLevel === context.modelSelection.options?.reasoningLevel
					? context.modelSelection
					: { ...context.modelSelection, options: { reasoningLevel } },
			providerId: model.provider,
			accountAccess: config.accountAccess,
			reason: "model-request",
		});
		let response: ZCodeProviderRuntimeHeadersResponse;
		try {
			response = zcodeProviderRuntimeHeadersResponseSchema.parse(
				await this.#options.requestRuntimeHeaders(params, signal),
			);
		} catch {
			throw new Error("Host provider credential resolution failed");
		}
		if (signal?.aborted) throw new Error("Provider credential request cancelled");
		if (!response.headersApplied) throw new Error("Host provider credentials are unavailable");
		const { apiKey, headers } = response.requestAuth;
		if (!apiKey && Object.keys(headers ?? {}).length === 0)
			throw new Error("Host returned no request authentication");
		return { apiKey, headers };
	}
	transformRequestPayload(
		payload: unknown,
		model: Model | undefined,
		selection: ModelSelection,
		maxOutputTokens?: number,
	): unknown {
		if (!model) return payload;
		const config = this.#template?.models.get(`${model.provider}\u0000${model.id}`);
		if (!config?.optionMaps) return payload;
		if (!isObject(payload)) throw new Error("Host model request payload must be an object");
		const reasoningLevel = hostReasoningLevel(config, selection.options?.reasoningLevel);
		if (!reasoningLevel || !config.reasoningLevels.includes(reasoningLevel))
			throw new Error("Unsupported Host reasoning level");
		return config.optionMaps.apply(payload as JsonObject, {
			reasoningLevel,
			maxOutputTokens: Math.min(maxOutputTokens ?? config.maxOutputTokens, config.maxOutputTokens),
		});
	}
	prepare(cwd: string, settings: Settings, modelRegistry: ModelRegistry): Promise<void> {
		return this.#exclusive(async () => {
			const template = this.#template ?? (await this.#load(this.#account));
			await this.#validate(template, settings);
			this.#install(modelRegistry, template);
			this.#template = template;
			// Provider defaults are not model-role writes. SDK model resolution sees
			// the registry; explicit current-session selections stay untouched.
			void cwd;
		});
	}
	updateAccountConfig(input: unknown) {
		return this.#exclusive(async () => {
			const next = zcodeProviderUpdateAccountConfigParamsSchema.parse(input);
			// 退役 Host 源后保留明确错误，不被通用源解析错误包裹，也不悄悄接纳空账号。
			if (!this.#env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim())
				throw new Error("Account config requires matching built-in source");
			if (this.#account?.revision === next.revision) {
				if (JSON.stringify(this.#account) !== JSON.stringify(next)) throw new Error("Account revision conflict");
				return {
					receivedRevision: next.revision,
					providerCount: Object.keys(next.providers).length,
					status: "unchanged" as const,
				};
			}
			const template = await this.#load(next);
			await this.#commit(template);
			this.#account = next;
			return {
				receivedRevision: next.revision,
				providerCount: Object.keys(next.providers).length,
				status: "received" as const,
			};
		});
	}
	refreshRegistry(input: unknown): Promise<{ refreshed: true }> {
		return this.#exclusive(async () => {
			zcodeProviderRefreshRegistryParamsSchema.parse(input);
			await this.#commit(await this.#load(this.#account));
			return { refreshed: true };
		});
	}
	updateInteractionPreferences(input: unknown) {
		return this.#exclusive(async () => {
			const params = zcodeWorkspaceUpdateInteractionPreferencesParamsSchema.parse(input);
			const cwd = resolve(params.workspace.workspacePath);
			const enabled = params.preferences.askUserQuestionAutoResolutionEnabled;
			if (!this.#options.applyInteractionPreferences && this.#records().some(record => resolve(record.cwd) === cwd))
				throw new Error("Interaction preference consumer is unavailable");
			const count = this.#options.applyInteractionPreferences?.(cwd, enabled) ?? 0;
			this.#preferences.set(cwd, {
				...this.getWorkspacePreferences(cwd),
				askUserQuestionAutoResolutionEnabled: enabled,
			});
			return {
				workspace: params.workspace,
				askUserQuestionAutoResolutionEnabled: enabled,
				snoozedInteractionCount: count,
			};
		});
	}
	updateModelIoPreferences(input: unknown) {
		return this.#exclusive(async () => {
			const params = zcodeWorkspaceUpdateModelIoPreferencesParamsSchema.parse(input);
			const cwd = resolve(params.workspace.workspacePath);
			const enabled = params.preferences.fullRetentionEnabled;
			if (!this.#options.applyModelIoPreferences && this.#records().some(record => resolve(record.cwd) === cwd))
				throw new Error("Model IO retention consumer is unavailable");
			const count = this.#options.applyModelIoPreferences?.(cwd, enabled) ?? 0;
			this.#preferences.set(cwd, { ...this.getWorkspacePreferences(cwd), fullRetentionEnabled: enabled });
			return { workspace: params.workspace, fullRetentionEnabled: enabled, updatedSessionCount: count };
		});
	}
	#records(): ZCodeConfigurationRecord[] {
		return Array.from(this.#options.records?.() ?? []);
	}
	async #commit(template: Template): Promise<void> {
		const records = this.#records();
		if (records.length === 0) await this.#validate(template, Settings.isolated());
		for (const record of records) await this.#validate(template, record.settings);
		const updated: ZCodeConfigurationRecord[] = [];
		try {
			for (const record of records) {
				updated.push(record);
				this.#install(record.modelRegistry, template);
			}
			for (const record of records) await this.#options.applyRegistryUpdate?.(record);
		} catch {
			for (const record of updated) {
				const previous = this.#template;
				if (previous) this.#install(record.modelRegistry, previous);
			}
			for (const record of updated) await this.#options.applyRegistryUpdate?.(record);
			throw new Error("ZCode provider configuration update failed");
		}
		this.#template = template;
	}
	async #validate(template: Template, settings: Settings): Promise<void> {
		const auth = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(auth, undefined, { settings, ignoreLocalModelConfig: true });
			for (const [id, config] of template.providers) registry.registerProvider(id, config, SOURCE, "runtime");
		} catch {
			throw new Error("Invalid ZCode provider configuration");
		} finally {
			auth.close();
		}
	}
	#install(registry: ModelRegistry, template: Template): void {
		const previous = this.#applied.get(registry);
		registry.clearSourceRegistrations(SOURCE);
		try {
			for (const id of previous?.providers.keys() ?? []) registry.authStorage.keys.removeRuntime(id);
			for (const [id, config] of template.providers) {
				const { apiKey, ...registration } = config;
				registry.registerProvider(id, registration, SOURCE, "runtime");
				if (apiKey !== undefined) registry.authStorage.keys.setRuntime(id, apiKey);
			}
			this.#applied.set(registry, template);
		} catch {
			registry.clearSourceRegistrations(SOURCE);
			for (const id of template.providers.keys()) registry.authStorage.keys.removeRuntime(id);
			if (previous)
				for (const [id, config] of previous.providers) {
					const { apiKey, ...registration } = config;
					registry.registerProvider(id, registration, SOURCE, "runtime");
					if (apiKey !== undefined) registry.authStorage.keys.setRuntime(id, apiKey);
				}
			throw new Error("ZCode provider configuration update failed");
		}
	}
	async #load(account: Account | undefined): Promise<Template> {
		try {
			return await this.#readSources(account);
		} catch {
			throw new Error("Invalid ZCode provider configuration");
		}
	}
	async #readSources(account: Account | undefined): Promise<Template> {
		const builtinPath = this.#env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
		const personalPath = this.#env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
		if (!builtinPath && !personalPath) {
			if (account && Object.keys(account.providers).length)
				throw new Error("Account config requires matching built-in source");
			return { providers: new Map(), models: new Map(), diagnostics: [] };
		}
		if (!builtinPath || !personalPath) throw new Error("Both provider sources required");
		const builtin = source.parse(JSON.parse(await readFile(builtinPath, "utf8")));
		if (builtin.revision === undefined) throw new Error("Built-in revision required");
		let personal: Source;
		try {
			personal = personalSource.parse(JSON.parse(await readFile(personalPath, "utf8")));
		} catch (error) {
			if (!isObject(error) || error.code !== "ENOENT") throw error;
			personal = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: {} } };
		}
		for (const layer of [builtin, personal]) {
			const seen = new Set<string>();
			for (const entry of layer.config.providerConfigRules.providerRules) {
				if (seen.has(entry.providerId)) throw new Error("Duplicate provider identity");
				seen.add(entry.providerId);
			}
			for (const entries of Object.values(layer.config.modelConfigRules)) {
				for (const entry of entries ?? []) {
					for (const pattern of [entry.modelMatch, entry.apiTypeMatch, entry.baseUrlMatch])
						if (pattern !== undefined) new RegExp(`^(?:${pattern})$`);
				}
			}
		}
		const revision = `zcode-builtin:${builtin.revision}:${createHash("sha256").update(resolve(builtinPath)).digest("hex")}`;
		if (account && account.basedOnZCodeBuiltinRevision !== revision)
			throw new Error("Account and built-in revisions differ");
		const templates = new Map(
			(builtin.config.providerConfigRules.templateRules ?? []).map(item => [item.templateId, item.config]),
		);
		const rules = new Map<string, z.infer<typeof providerRule>>();
		for (const item of builtin.config.providerConfigRules.providerRules) {
			const template = item.templateId ? templates.get(item.templateId) : undefined;
			if (item.templateId && !template) throw new Error("Missing provider template");
			const overlay = account?.providers[item.providerId];
			const concrete = overlay === undefined ? item.config : merge(item.config, provider.parse(overlay));
			rules.set(item.providerId, { ...item, config: provider.parse(merge(template ?? {}, concrete)) });
		}
		for (const item of personal.config.providerConfigRules.providerRules) {
			if (item.providerId.startsWith("account:") && item.config.access !== undefined)
				throw new Error("Account access cannot be overridden by personal configuration");
			const existing = rules.get(item.providerId);
			const template = item.templateId ? templates.get(item.templateId) : undefined;
			if (item.templateId && !template) throw new Error("Missing provider template");
			rules.set(item.providerId, {
				...existing,
				...item,
				// 个人层允许草稿:合并结果按个人层宽松 schema 归一,完整性留待逐 provider 准入判定。
				config: personalProvider.parse(merge(existing?.config ?? template ?? {}, item.config)),
			});
		}
		const providers = new Map<string, ProviderConfigInput>();
		const hostModels = new Map<string, HostModelConfiguration>();
		const diagnostics: ZCodeProviderDiagnostic[] = [];
		for (const [id, item] of rules) {
			const config = item.config;
			const state = account?.states[id];
			if (item.enabled === false || (state && (state.availability !== "available" || !state.entitled))) continue;
			if (config.access?.type === "zhipu-account" && !config.access.entitled) continue;
			const ids = [...new Set([...(config.builtinModelIds ?? []), ...(config.personalModelIds ?? [])])];
			if (!ids.length) continue;
			// GUI 个人层允许草稿:单个不完整 provider 只跳过自身并记录诊断,
			// 不再抛错毁掉整个 catalog 与会话创建(GUI provider-data-schema 的 personal 层语义)。
			const admitted = completeProviderConfig(config);
			if (!admitted) {
				diagnostics.push({ providerId: id, message: "Incomplete provider configuration skipped" });
				continue;
			}
			const models: NonNullable<ProviderConfigInput["models"]> = [];
			try {
				for (const modelId of ids) {
					let metadata: ObjectValue = {};
					for (const layer of [builtin.config.modelConfigRules, personal.config.modelConfigRules]) {
						for (const category of [
							"modelRules",
							"modelApiRules",
							"providerSiteRules",
							"templateModelRules",
							"builtinProviderModelRules",
							"providerModelRules",
							"manualProviderModelRules",
						] as const) {
							for (const entry of layer[category] ?? []) {
								if (
									(entry.providerId !== undefined && entry.providerId !== id) ||
									(entry.templateId !== undefined && entry.templateId !== item.templateId) ||
									(entry.modelId !== undefined && entry.modelId !== modelId)
								)
									continue;
								if (
									matches(entry.modelMatch, modelId) &&
									matches(entry.apiTypeMatch, admitted.api.type) &&
									// baseUrl 规则匹配前按 GUI 侧做法归一化(去尾斜杠、统一 Host 大小写与默认端口)。
									matches(entry.baseUrlMatch, normalizeBaseUrlForRuleMatch(admitted.api.baseUrl))
								)
									metadata = merge(metadata, entry.config);
							}
						}
					}
					if (metadata.enabled === false) continue;
					const properties = nested(metadata, "properties"),
						options = nested(metadata, "optionSpecs"),
						input = nested(properties, "inputFormat");
					const levels = nested(options, "reasoningLevel").values;
					const reasoning = nested(options, "reasoningLevel"),
						output = nested(options, "maxOutputTokens");
					const reasoningLevels = z.array(z.string().min(1)).min(1).parse(levels);
					let optionMaps: CompiledModelOptionMaps | undefined;
					if (reasoning.map !== undefined || output.map !== undefined) {
						if (typeof reasoning.map !== "string" || typeof output.map !== "string")
							throw new Error("Incomplete Host model option maps");
						optionMaps = compileModelOptionMaps({
							reasoningLevel: { map: reasoning.map },
							maxOutputTokens: { map: output.map },
						});
					}
					const accountAccess =
						admitted.access.type === "zhipu-account"
							? zcodeProviderAccountAccessSchema.parse(admitted.access)
							: undefined;
					hostModels.set(`${id}\u0000${modelId}`, {
						accountAccess,
						optionMaps,
						reasoningLevels: Object.freeze(reasoningLevels),
						maxOutputTokens: positive(output.max),
					});
					// 展示名优先用模型规则元数据里的 name;registry Model 结构不承载 provider 级
					// group/logo/templateNameMap,无可用展示名时回退 modelId。
					const displayName =
						typeof metadata.name === "string" && metadata.name.trim().length > 0 ? metadata.name : modelId;
					models.push({
						id: modelId,
						name: displayName,
						reasoning: reasoningLevels.some(level => level !== "off" && level !== "none" && level !== "disabled"),
						input: input.supportsImage === true ? ["text", "image"] : ["text"],
						supportsTools: properties.supportsToolCall === true,
						contextWindow: positive(properties.contextWindow),
						maxTokens: positive(nested(options, "maxOutputTokens").max),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					});
				}
			} catch (error) {
				// 模型元数据不完整同样只影响该 provider 的准入,不拖垮其余 provider。
				diagnostics.push({
					providerId: id,
					message: `Provider skipped: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
			if (!models.length) continue;
			// modelOrder 决定 Host 目录内的展示顺序;未列出的模型保持原有相对顺序并稳定后置。
			const orderIndex = new Map((config.modelOrder ?? []).map((ordered, index) => [ordered, index]));
			models.sort((a, b) => (orderIndex.get(a.id) ?? orderIndex.size) - (orderIndex.get(b.id) ?? orderIndex.size));
			// visibility:"hidden" 的 provider(即使 entitled)不进入注册与 getAvailable 可见目录;
			// hostModels 已保留,既有会话的 reasoning 档位投影不受影响。
			if (config.visibility === "hidden") continue;
			const apiType = admitted.api.type === "openai-chat-completions" ? "openai-completions" : admitted.api.type;
			providers.set(id, {
				api: apiType,
				baseUrl: admitted.api.baseUrl,
				headers: admitted.api.headers ?? undefined,
				apiKey: admitted.access.apiKey ?? undefined,
				requestAuthConfigured: () =>
					admitted.access.type === "zhipu-account"
						? this.#options.requestRuntimeHeaders !== undefined
						: admitted.access.apiKey !== undefined,
				models,
			});
		}
		return {
			providers,
			models: hostModels,
			diagnostics,
			defaultSelection: personal.config.defaultModelSelection,
		};
	}
}
