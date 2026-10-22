import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry, type ProviderConfigInput } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ZCodeProviderConfiguration } from "../../src/modes/zcode/provider-config";
import { ZCodeFrameWriter } from "../../src/modes/zcode/server";
import { ModelRoleService } from "../../src/modes/zcode/hosts/model-roles";
import { zcodeSessionConfigureResultSchema } from "../../src/modes/zcode/schema/omp-config-extension";
import { TeamConfigService } from "../../src/team/config";
import { AuthStorage } from "../../src/session/auth-storage";

const directories: string[] = [];
const authStores: AuthStorage[] = [];
afterEach(async () => {
	for (const auth of authStores.splice(0)) auth.close();
	await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "omp-zcode-provider-"));
	directories.push(dir);
	const personal = join(dir, "personal.json");
	const builtin = join(dir, "builtin.json");
	await writeFile(
		builtin,
		JSON.stringify({
			schemaVersion: 1,
			revision: 1,
			config: {
				providerConfigRules: { templateRules: [], providerRules: [] },
				modelConfigRules: {
					modelRules: [],
					modelApiRules: [],
					providerSiteRules: [],
					templateModelRules: [],
					builtinProviderModelRules: [],
				},
			},
		}),
	);
	const save = (key: string, baseUrl = "http://localhost:1234/v1") =>
		writeFile(
			personal,
			JSON.stringify({
				schemaVersion: 1,
				config: {
					providerConfigRules: {
						providerRules: [
							{
								providerId: "local-test",
								config: {
									group: "standard-personal",
									access: { type: "api-key", apiKey: key },
									api: { type: "openai-chat-completions", baseUrl },
									personalModelIds: ["model-a"],
								},
							},
						],
					},
					modelConfigRules: {
						providerModelRules: [],
						manualProviderModelRules: [
							{
								providerId: "local-test",
								modelId: "model-a",
								config: {
									properties: {
										contextWindow: 8192,
										inputFormat: { supportsText: true, supportsImage: false },
										supportsToolCall: true,
									},
									optionSpecs: { maxOutputTokens: { max: 1024 }, reasoningLevel: { values: ["off"] } },
								},
							},
						],
					},
				},
			}),
		);
	await save("secret-one");
	const settings = Settings.isolated();
	const auth = await AuthStorage.create(":memory:");
	authStores.push(auth);
	const modelRegistry = new ModelRegistry(auth, join(dir, "absent.yml"), { settings });
	return {
		cwd: dir,
		dir,
		save,
		settings,
		modelRegistry,
		env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal },
	};
}

describe("ZCode provider configuration consumer", () => {
	test("cold reasoning reads declared Host choices without catalog auth or runtime records", async () => {
		const f = await fixture();
		const path = f.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
		const stored = JSON.parse(await readFile(path, "utf8"));
		stored.config.modelConfigRules.manualProviderModelRules[0].config.optionSpecs.reasoningLevel = {
			values: ["disabled", "enabled"],
		};
		await writeFile(path, JSON.stringify(stored));
		const config = new ZCodeProviderConfiguration({
			env: f.env,
			records: () => {
				throw new Error("cold reasoning must not inspect runtime records");
			},
			createCatalogAuthStorage: () => {
				throw new Error("cold reasoning must not discover auth");
			},
		});
		expect(await config.readReasoningConfig("local-test", "model-a", "off")).toEqual({
			thought: "disabled",
			thoughtLevels: ["disabled", "enabled"],
		});
		expect(await config.readReasoningConfig("local-test", "model-a", "high")).toEqual({
			thought: "enabled",
			thoughtLevels: ["disabled", "enabled"],
		});
		expect(await config.readReasoningConfig("local-test", "missing", "off")).toEqual({
			thought: "disabled",
			thoughtLevels: [],
		});
		expect(await config.readReasoningConfig("local-test", "model-a", "unsupported")).toEqual({
			thought: "unsupported",
			thoughtLevels: ["disabled", "enabled"],
		});
		expect(await readFile(path, "utf8")).toBe(JSON.stringify(stored));
	});
	test("cold native off is the public disabled choice without a default-model substitution", async () => {
		const f = await fixture();
		const config = new ZCodeProviderConfiguration({ env: f.env });
		expect(await config.readReasoningConfig("local-test", "model-a", "off")).toEqual({
			thought: "disabled",
			thoughtLevels: ["disabled"],
		});
		expect(await config.readReasoningConfig("missing", "model-a", "high")).toEqual({
			thought: "high",
			thoughtLevels: [],
		});
	});
	test("startup installs actual selectable model and memory credentials before session creation", async () => {
		const f = await fixture();
		const config = new ZCodeProviderConfiguration({ env: f.env });
		await config.prepare(f.dir, f.settings, f.modelRegistry);
		expect(f.modelRegistry.find("local-test", "model-a")).toMatchObject({
			api: "openai-completions",
			baseUrl: "http://localhost:1234/v1",
			contextWindow: 8192,
			maxTokens: 1024,
		});
		expect(await f.modelRegistry.getApiKey(f.modelRegistry.find("local-test", "model-a")!)).toBe("secret-one");
	});

	test("binary Host reasoning remains declared while native selectors round-trip through payload maps", async () => {
		const f = await fixture();
		const path = f.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
		const stored = JSON.parse(await readFile(path, "utf8"));
		const specs = stored.config.modelConfigRules.manualProviderModelRules[0].config.optionSpecs;
		specs.reasoningLevel = { values: ["disabled", "enabled"], map: '{"mode": reasoningLevel}' };
		specs.maxOutputTokens = { max: 1024, map: '{"max_tokens": maxOutputTokens}' };
		await writeFile(path, JSON.stringify(stored));
		const config = new ZCodeProviderConfiguration({ env: f.env });
		await config.prepare(f.dir, f.settings, f.modelRegistry);
		const model = f.modelRegistry.find("local-test", "model-a")!;
		expect(config.getReasoningLevels("local-test", "model-a")).toEqual(["disabled", "enabled"]);
		expect(config.resolveThinkingLevel("local-test", "model-a", "enabled")).toBe(Effort.Max);
		expect(config.resolveThinkingLevel("local-test", "model-a", "disabled")).toBe("off");
		expect(config.resolveThinkingLevel("local-test", "model-a", "invented")).toBeUndefined();
		expect(config.resolveThinkingLevel("local-test", "model-a", "high")).toBeUndefined();
		for (const [native, declared] of [
			[Effort.Max, "enabled"],
			["off", "disabled"],
		]) {
			expect(
				config.transformRequestPayload({}, model, {
					providerId: "local-test",
					modelId: "model-a",
					options: { reasoningLevel: native },
				}),
			).toEqual({ mode: declared, max_tokens: 1024 });
		}
	});
	test("complete Host model candidates reach configuration consumers through the bounded wire writer", async () => {
		const f = await fixture();
		const path = f.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
		const stored = JSON.parse(await readFile(path, "utf8"));
		stored.config.providerConfigRules.providerRules[0].config.personalModelIds.push("model-b");
		stored.config.modelConfigRules.manualProviderModelRules.push({
			...stored.config.modelConfigRules.manualProviderModelRules[0],
			modelId: "model-b",
		});
		await writeFile(path, JSON.stringify(stored));
		let authRequests = 0;
		const config = new ZCodeProviderConfiguration({
			env: f.env,
			requestRuntimeHeaders: async () => {
				authRequests++;
				throw new Error("Catalog inspection must not request credentials");
			},
		});
		await config.prepare(f.dir, f.settings, f.modelRegistry);
		f.modelRegistry.syncExtensionSources([]);
		const currentModel = f.modelRegistry.find("local-test", "model-a")!;
		const dependencies = {
			getSettings: () => f.settings,
			getModelRegistry: () => f.modelRegistry,
			getSessionModel: () => currentModel,
			emit: () => {},
		};
		const roles = await new ModelRoleService(dependencies).listRoles({
			sessionModel: { provider: currentModel.provider, modelId: currentModel.id },
		});
		const models = new TeamConfigService(dependencies).getModels();
		const frames: string[] = [];
		const writer = new ZCodeFrameWriter(
			new Writable({
				write(chunk, _encoding, callback) {
					frames.push(chunk.toString());
					callback();
				},
			}),
		);
		await Promise.all([
			writer.write({ id: "roles", result: { operation: "get_model_roles", data: roles } }),
			writer.write({ id: "models", result: { operation: "get_team_models", data: models } }),
		]);
		const received = frames.map(frame => zcodeSessionConfigureResultSchema.parse(JSON.parse(frame).result));
		const roleResult = received.find(result => result.operation === "get_model_roles")!;
		const modelResult = received.find(result => result.operation === "get_team_models")!;
		if (roleResult.operation !== "get_model_roles" || modelResult.operation !== "get_team_models")
			throw new Error("Expected complete role and Team catalogs");
		const expected = ["model-a", "model-b"].map(modelId => ({ provider: "local-test", modelId }));
		expect(
			roleResult.data.roles
				.find(role => role.roleId === "default")
				?.candidateModels.filter(model => model.provider === "local-test"),
		).toEqual(expected);
		expect(modelResult.data.models.filter(item => item.model.provider === "local-test")).toEqual(
			expected.map(model => ({ model, name: model.modelId, selectable: true })),
		);
		expect(modelResult.data.models.some(item => !item.selectable && !!item.reasonCode && !!item.reason)).toBe(true);
		expect(roleResult.data.sessionModel?.model).toEqual(expected[0]);
		expect(dependencies.getSessionModel()).toBe(currentModel);
		expect(authRequests).toBe(0);
		expect(await readFile(path, "utf8")).toBe(JSON.stringify(stored));
	});
	test("request auth source admits selectable models without claiming a concrete credential", async () => {
		const f = await fixture();
		await new ZCodeProviderConfiguration({ env: f.env }).prepare(f.dir, f.settings, f.modelRegistry);
		const model = f.modelRegistry.find("local-test", "model-a")!;
		const registration = {
			baseUrl: "http://localhost:1234/v1",
			api: "openai-completions",
			models: [
				{
					id: model.id,
					name: "Request-auth fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
			],
		} satisfies ProviderConfigInput;
		expect(() => f.modelRegistry.registerProvider("request-only", registration)).toThrow();
		let available = false;
		const requestAuthConfigured = () => available;
		expect(() =>
			f.modelRegistry.registerProvider("request-only", { ...registration, requestAuthConfigured }),
		).toThrow();
		available = true;
		f.modelRegistry.registerProvider(
			"request-only",
			{ ...registration, requestAuthConfigured },
			"request-owner",
			"runtime",
		);
		f.modelRegistry.registerProvider("extension-only", { ...registration, requestAuthConfigured }, "extension-owner");
		f.modelRegistry.syncExtensionSources([]);
		expect(f.modelRegistry.find("extension-only", model.id)).toBeUndefined();
		expect(f.modelRegistry.find("local-test", model.id)).toBeDefined();
		expect(await f.modelRegistry.getApiKey(model)).toBe("secret-one");
		const requested = f.modelRegistry.find("request-only", model.id)!;
		expect(f.modelRegistry.getAvailable()).toContainEqual(requested);
		expect(f.modelRegistry.hasConfiguredAuth(requested)).toBe(true);
		expect(f.modelRegistry.hasConcreteAuth("request-only")).toBe(false);
		expect(await f.modelRegistry.getApiKey(requested)).toBeUndefined();
		available = false;
		expect(f.modelRegistry.getAvailable()).not.toContainEqual(requested);
		expect(f.modelRegistry.hasConfiguredAuth(requested)).toBe(false);
		f.modelRegistry.clearSourceRegistrations("request-owner");
		available = true;
		expect(f.modelRegistry.hasConfiguredAuth(requested)).toBe(false);
	});
	test("new same-process sessions reuse committed templates and API keys remain literal", async () => {
		const f = await fixture();
		await f.save("!not-a-command");
		const config = new ZCodeProviderConfiguration({ env: f.env });
		await config.refreshRegistry({ reason: "startup" });
		const auth = await AuthStorage.create(":memory:");
		authStores.push(auth);
		const settings = Settings.isolated();
		const registry = new ModelRegistry(auth, join(f.dir, "second.yml"), { settings });
		await config.prepare(join(f.dir, "other-workspace"), settings, registry);
		expect(await registry.getApiKey(registry.find("local-test", "model-a")!)).toBe("!not-a-command");
		expect(f.modelRegistry.find("local-test", "model-a")).toBeUndefined();
	});
	test("refresh changes live registry without changing role defaults and skips invalid providers with diagnostics", async () => {
		const f = await fixture();
		const config = new ZCodeProviderConfiguration({ env: f.env, records: () => [f] });
		await config.prepare(f.dir, f.settings, f.modelRegistry);
		await f.save("secret-two", "http://localhost:4321/v1");
		await config.refreshRegistry({ reason: "settings_saved" });
		expect(f.modelRegistry.find("local-test", "model-a")?.baseUrl).toBe("http://localhost:4321/v1");
		await f.save("bad", "not-a-url");
		// 用户裁定/新语义(provider-config.ts):单个不完整 provider 不再抛错毁掉整个 catalog,
		// 而是跳过该 provider 并记 diagnostic;坏配置(非法 baseUrl)不会被安装进注册表。
		await expect(config.refreshRegistry({ reason: "invalid" })).resolves.toEqual({ refreshed: true });
		expect(config.getDiagnostics()).toContainEqual({
			providerId: "local-test",
			message: "Incomplete provider configuration skipped",
		});
		expect(f.modelRegistry.find("local-test", "model-a")).toBeUndefined();
	});

	test("Host default source refresh remains separate from persisted role defaults", async () => {
		const f = await fixture();
		const path = f.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
		const stored = JSON.parse(await readFile(path, "utf8"));
		stored.config.defaultModelSelection = {
			providerId: "local-test",
			modelId: "model-a",
			options: { reasoningLevel: "off" },
		};
		await writeFile(path, JSON.stringify(stored));
		const config = new ZCodeProviderConfiguration({ env: f.env, records: () => [f] });
		await config.prepare(f.dir, f.settings, f.modelRegistry);
		const roleBefore = f.settings.getModelRole("default");
		expect(config.getDefaultModelSelection()).toEqual(stored.config.defaultModelSelection);
		delete stored.config.defaultModelSelection;
		await writeFile(path, JSON.stringify(stored));
		await config.refreshRegistry({ reason: "settings_saved" });
		expect(config.getDefaultModelSelection()).toBeUndefined();
		expect(f.settings.getModelRole("default")).toBe(roleBefore);
	});
	test("workspace templates and callbacks do not modify a different workspace", async () => {
		const f = await fixture();
		const calls: string[] = [];
		const config = new ZCodeProviderConfiguration({
			env: {},
			applyInteractionPreferences: (cwd, enabled) => {
				calls.push(`${cwd}:${enabled}`);
				return 2;
			},
			applyModelIoPreferences: () => 1,
		});
		const workspace = { workspacePath: f.dir, workspaceKey: "fixture" };
		const result = await config.updateInteractionPreferences({
			workspace,
			preferences: { askUserQuestionAutoResolutionEnabled: false },
		});
		expect(result.snoozedInteractionCount).toBe(2);
		expect(config.getWorkspacePreferences(f.dir).askUserQuestionAutoResolutionEnabled).toBe(false);
		expect(config.getWorkspacePreferences(join(f.dir, "other")).askUserQuestionAutoResolutionEnabled).toBe(true);
		expect(calls).toHaveLength(1);
		expect(
			(await config.updateModelIoPreferences({ workspace, preferences: { fullRetentionEnabled: true } }))
				.updatedSessionCount,
		).toBe(1);
	});
	test("missing live consumer fails without committing a preference template", async () => {
		const f = await fixture();
		const config = new ZCodeProviderConfiguration({
			env: {},
			records: () => [{ cwd: f.dir, settings: f.settings, modelRegistry: f.modelRegistry }],
		});
		await expect(
			config.updateModelIoPreferences({
				workspace: { workspacePath: f.dir, workspaceKey: "fixture" },
				preferences: { fullRetentionEnabled: true },
			}),
		).rejects.toThrow();
		expect(config.getWorkspacePreferences(f.dir).fullRetentionEnabled).toBe(false);
	});
	test("account revisions are idempotent and conflicting content does not replace memory auth", async () => {
		const f = await fixture();
		const config = new ZCodeProviderConfiguration({ env: f.env, records: () => [f] });
		await config.prepare(f.dir, f.settings, f.modelRegistry);
		const basedOnZCodeBuiltinRevision = `zcode-builtin:1:${createHash("sha256").update(f.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).digest("hex")}`;
		const account = { revision: "account-version-one", basedOnZCodeBuiltinRevision, providers: {}, states: {} };
		expect((await config.updateAccountConfig(account)).status).toBe("received");
		expect((await config.updateAccountConfig(account)).status).toBe("unchanged");
		await expect(
			config.updateAccountConfig({ ...account, providers: { unexpected: { apiKey: "must-not-appear" } } }),
		).rejects.toThrow("Account revision conflict");
		await expect(
			config.updateAccountConfig({
				...account,
				revision: "account-version-two",
				basedOnZCodeBuiltinRevision: "stale",
			}),
		).rejects.toThrow("Invalid ZCode provider configuration");
		await expect(config.updateAccountConfig({ ...account, revision: "", providers: {} })).rejects.toThrow();
		expect(await f.modelRegistry.getApiKey(f.modelRegistry.find("local-test", "model-a")!)).toBe("secret-one");
	});
	test("startup catalog and pure Host option maps feed actual request payloads", async () => {
		const f = await fixture();
		const path = f.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
		const stored = JSON.parse(await readFile(path, "utf8"));
		const specs = stored.config.modelConfigRules.manualProviderModelRules[0].config.optionSpecs;
		specs.reasoningLevel = { values: ["off", "high"], map: '{"reasoning_effort": reasoningLevel}' };
		specs.maxOutputTokens = { max: 1024, map: '{"max_tokens": maxOutputTokens}' };
		await writeFile(path, JSON.stringify(stored));
		const config = new ZCodeProviderConfiguration({
			env: f.env,
			createCatalogAuthStorage: () => AuthStorage.create(":memory:"),
		});
		const catalog = await config.catalog(f.dir);
		const model = catalog.find(item => item.provider === "local-test" && item.id === "model-a")!;
		expect(model).toBeDefined();
		expect(config.getReasoningLevels("local-test", "model-a")).toEqual(["off", "high"]);
		expect(config.getReasoningLevels("local-test", "missing")).toBeUndefined();
		const declaredLevels = config.getReasoningLevels("local-test", "model-a")!;
		expect(Object.isFrozen(declaredLevels)).toBe(true);
		expect(
			config.transformRequestPayload({ messages: [], max_tokens: 2 }, model, {
				providerId: "local-test",
				modelId: "model-a",
				options: { reasoningLevel: "high" },
			}),
		).toEqual({ messages: [], max_tokens: 1024, reasoning_effort: "high" });
		expect(() =>
			config.transformRequestPayload({}, model, {
				providerId: "local-test",
				modelId: "model-a",
				options: { reasoningLevel: "unsupported" },
			}),
		).toThrow("Unsupported Host reasoning level");
	});
	test("account credentials are resolved per request without registry persistence", async () => {
		const f = await fixture();
		const builtin = JSON.parse(await readFile(f.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "utf8"));
		const personal = JSON.parse(await readFile(f.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8"));
		const accountRule = personal.config.providerConfigRules.providerRules[0];
		accountRule.providerId = "account:test";
		accountRule.config.access = {
			type: "zhipu-account",
			accountType: "zai",
			mode: "individual-coding-plan",
			entitled: true,
		};
		accountRule.config.builtinModelIds = accountRule.config.personalModelIds;
		delete accountRule.config.personalModelIds;
		builtin.config.providerConfigRules.providerRules = [accountRule];
		builtin.config.modelConfigRules.builtinProviderModelRules =
			personal.config.modelConfigRules.manualProviderModelRules.map((item: Record<string, unknown>) => ({
				...item,
				providerId: "account:test",
			}));
		personal.config.providerConfigRules.providerRules = [];
		await writeFile(f.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, JSON.stringify(builtin));
		await writeFile(f.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, JSON.stringify(personal));
		const requests: unknown[] = [];
		let denied = false;
		const config = new ZCodeProviderConfiguration({
			env: f.env,
			requestRuntimeHeaders: async params => {
				requests.push(params);
				if (denied) return { headersApplied: false, errorMessage: "must-not-leak-secret" };
				return {
					headersApplied: true,
					requestAuth: { apiKey: "request-secret", headers: { "x-project": "scope-token" } },
				};
			},
		});
		const basedOnZCodeBuiltinRevision = `zcode-builtin:1:${createHash("sha256").update(f.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).digest("hex")}`;
		const providers = { "account:test": { access: { type: "zhipu-account", entitled: true } } };
		const states = { "account:test": { availability: "available", entitled: true, current: true } };
		// Host serializes the account source snapshot, including its content revision.
		const revision = `account:${JSON.stringify([basedOnZCodeBuiltinRevision, [{ providerId: "account:test", config: providers["account:test"] }], states])}`;
		expect(await config.updateAccountConfig({ revision, basedOnZCodeBuiltinRevision, providers, states })).toEqual({
			receivedRevision: revision,
			providerCount: 1,
			status: "received",
		});
		await expect(
			new ZCodeProviderConfiguration({ env: f.env }).updateAccountConfig({
				revision,
				basedOnZCodeBuiltinRevision,
				providers,
				states,
			}),
		).rejects.toThrow("Invalid ZCode provider configuration");
		await config.prepare(f.dir, f.settings, f.modelRegistry);
		// SDK startup synchronizes extension lifetimes after preparing Host configuration.
		f.modelRegistry.syncExtensionSources([]);
		const model = f.modelRegistry.find("account:test", "model-a")!;
		const catalog = await new ModelRoleService({
			getSettings: () => f.settings,
			getModelRegistry: () => f.modelRegistry,
			emit: () => {},
		}).listRoles();
		expect(catalog.roles.find(role => role.roleId === "default")?.candidateModels).toContainEqual({
			provider: "account:test",
			modelId: "model-a",
		});
		expect(f.modelRegistry.hasConcreteAuth("account:test")).toBe(false);
		expect(requests).toHaveLength(0);
		const context = {
			sessionId: "session-one",
			workspace: { workspacePath: f.dir, workspaceKey: "fixture" },
			modelSelection: { providerId: "account:test", modelId: "model-a" },
		};
		expect(await config.resolveRequestAuth(context, model)).toEqual({
			apiKey: "request-secret",
			headers: { "x-project": "scope-token" },
		});
		expect(await f.modelRegistry.getApiKey(model)).toBeUndefined();
		expect(requests).toHaveLength(1);
		denied = true;
		await expect(config.resolveRequestAuth(context, model)).rejects.toThrow(
			"Host provider credentials are unavailable",
		);
		expect(await f.modelRegistry.getApiKey(model)).toBeUndefined();
	});
});
