import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai/types";

interface CompanyProbe {
	models: Model<"anthropic-messages">[];
	capped: Model<"anthropic-messages">[];
	roles: Record<string, string>;
	companyKey: string;
	credentialKey: string;
	resolvedKey: string;
	headers: Record<string, string>;
	ignoredCompanyKeySource: boolean;
	warnings: string[];
	warningsAfterRemoval: string[];
	zcodeVisible: boolean;
	retrievalVisible: boolean;
	serializedSecret: boolean;
	disabledAvailable: boolean;
	disabledFind: unknown;
	disabledModelKey: unknown;
	disabledProviderKey: unknown;
	disabledCredential: unknown;
	disabledResolverKey: unknown;
	disabledSessionModel: unknown;
	gatewayLocalProviders: string[];
	gatewayModelKey: string;
	gatewayProviderKey: string;
	ignoredPolicyError: unknown;
	ignoredPolicyWarnings: string[];
	ignoredProxyKey: string;
	invalidProxyKeyError: unknown;
	gatewayResolverKey: string;
	gatewayProxyId: string;
	requests: number;
}

function runCompanyProbe(): CompanyProbe {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "company-models-"));
	const claudeDir = path.join(home, ".claude");
	const modelsFile = path.join(home, "models.yml");
	const source = (name: string) => JSON.stringify(path.join(import.meta.dir, `../src/${name}.ts`));
	try {
		fs.mkdirSync(claudeDir);
		fs.writeFileSync(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({
				env: {
					ANTHROPIC_BASE_URL: "http://127.0.0.1:8081/gateway/v1/",
					ANTHROPIC_AUTH_TOKEN: "company-fixture-token",
				},
			}),
		);
		fs.writeFileSync(
			modelsFile,
			JSON.stringify({
				providers: {
					company: {
						apiKey: "ignored-yaml-company-key",
						baseUrl: "https://ignored.invalid",
						api: "anthropic-messages",
						headers: { Authorization: "Bearer ignored-header" },
						compat: { supportsOutputEffort: true },
						models: [{ id: "ignored-company-model", contextWindow: 100, maxTokens: 10 }],
					},
					"zcode-api": { apiKey: "proxy-fixture-key", baseUrl: "https://ignored.invalid" },
				},
			}),
		);
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
				let requests = 0;
				globalThis.fetch = async () => { requests++; throw new Error("unexpected model discovery"); };
				// Dynamic loading must follow the guard so no import-time request can escape the fixture.
				const { setCompanyOfflineEnabled } = await import(${source("config/company-provider")});
				const { getCompanyChatModels, setCompanyChatContextWindow, COMPANY_OFFLINE_CONTEXT_WINDOW,
					COMPANY_OFFLINE_ROLE_DEFAULTS } = await import(${source("config/company-models")});
				const { ModelRegistry } = await import(${source("config/model-registry")});
				const { Settings } = await import(${source("config/settings")});
				const { resolveSessionModelSelector, resolveModelRoleValue } = await import(${source("config/model-resolver")});
				const { createInMemoryAuthStorage } = await import(${JSON.stringify(path.join(import.meta.dir, "helpers/agent-session-setup.ts"))});
				const { resolveApiKeyOnce } = await import(${JSON.stringify(path.join(import.meta.dir, "../../ai/src/auth-retry.ts"))});
				const { buildAnthropicClientOptions } = await import(${JSON.stringify(path.join(import.meta.dir, "../../ai/src/providers/anthropic.ts"))});
				setCompanyOfflineEnabled(true);
				const models = getCompanyChatModels();
				setCompanyChatContextWindow(COMPANY_OFFLINE_CONTEXT_WINDOW);
				const authStorage = createInMemoryAuthStorage();
				const settings = Settings.isolated({ modelRoles: { ...COMPANY_OFFLINE_ROLE_DEFAULTS } });
				const registry = new ModelRegistry(authStorage, ${JSON.stringify(modelsFile)}, { settings });
				await registry.refresh("offline");
				const available = registry.getAvailable();
				const model = registry.find("company", "Qwen3.6-27B-public");
				if (!model) throw new Error("company model missing");
				const companyKey = await registry.getApiKey(model);
				const result = {
					models,
					capped: registry.getAll().filter(row => row.provider === "company"),
					roles: Object.fromEntries(Object.keys(COMPANY_OFFLINE_ROLE_DEFAULTS).map(role => [role,
						resolveModelRoleValue("@" + role, available, { settings }).model?.id])),
					companyKey,
					credentialKey: (await registry.getApiKeyWithCredentialForProvider("company"))?.apiKey,
					resolvedKey: await resolveApiKeyOnce(registry.resolver(model)),
					headers: buildAnthropicClientOptions({ model, apiKey: companyKey }).defaultHeaders,
					ignoredCompanyKeySource: authStorage.keys.source("company") !== undefined,
					warnings: registry.getReservedProviderWarnings(),
					zcodeVisible: registry.getAll().some(row => row.provider === "zcode-api") ||
						registry.find("zcode-api", "glm-5.2") !== undefined,
					retrievalVisible: registry.find("company", "Qwen3-VL-Embedding-2B") !== undefined ||
						registry.find("company", "Qwen3-VL-Reranker-2B") !== undefined,
					serializedSecret: JSON.stringify(registry.getAll()).includes("company-fixture-token"),
				};
				const disabled = new ModelRegistry(authStorage, ${JSON.stringify(modelsFile)}, {
					settings: Settings.isolated({ disabledProviders: ["company"] }),
				});
				Object.assign(result, {
					disabledAvailable: disabled.getAvailable().some(row => row.provider === "company"),
					disabledFind: disabled.find("company", model.id),
					disabledModelKey: await disabled.getApiKey(model),
					disabledProviderKey: await disabled.getApiKeyForProvider("company"),
					disabledCredential: await disabled.getApiKeyWithCredentialForProvider("company"),
					disabledResolverKey: await resolveApiKeyOnce(disabled.resolver(model)),
					disabledSessionModel: resolveSessionModelSelector(disabled, "company/" + model.id),
				});
				const gateway = new ModelRegistry(authStorage, ${JSON.stringify(modelsFile)}, {
					ignoreLocalModelConfig: true, settings: Settings.isolated({}),
				});
				result.gatewayLocalProviders = gateway.getAll().filter(row =>
					row.provider === "company" || row.provider === "zcode-api").map(row => row.provider);
				authStorage.keys.setRuntime("company", "broker-fixture-token");
				result.gatewayModelKey = await gateway.getApiKey(model);
				result.gatewayProviderKey = await gateway.getApiKeyForProvider("company");
				result.gatewayResolverKey = await resolveApiKeyOnce(gateway.resolver(model));
				gateway.registerProvider("zcode-api", {
					api: "anthropic-messages", baseUrl: "https://broker.invalid", apiKey: "broker-proxy-token",
					models: [{ id: "broker-proxy-model", name: "Broker model", reasoning: false,
						input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1000, maxTokens: 100 }],
				}, "broker://fixture");
				result.gatewayProxyId = gateway.find("zcode-api", "broker-proxy-model")?.id;
				const { rmSync, writeFileSync } = await import("node:fs");
				const ignoredFile = ${JSON.stringify(path.join(home, "ignored-models.json"))};
				writeFileSync(ignoredFile, JSON.stringify({ providers: {
					company: { apiKey: 42, models: true, compat: "ignored" },
					"zcode-api": { apiKey: "retained-proxy-key", baseUrl: 42, models: false,
						headers: 7, discovery: "ignored", compat: "ignored" },
				}}));
				const ignoredAuth = createInMemoryAuthStorage();
				const ignored = new ModelRegistry(ignoredAuth, ignoredFile, { settings: Settings.isolated({}) });
				result.ignoredPolicyError = ignored.getError();
				result.ignoredPolicyWarnings = ignored.getReservedProviderWarnings();
				result.ignoredProxyKey = await ignored.getApiKeyForProvider("zcode-api");
				const invalidFile = ${JSON.stringify(path.join(home, "invalid-models.json"))};
				writeFileSync(invalidFile, JSON.stringify({ providers: { "zcode-api": { apiKey: 42 } } }));
				const invalid = new ModelRegistry(ignoredAuth, invalidFile, { settings: Settings.isolated({}) });
				result.invalidProxyKeyError = invalid.getError();
				ignoredAuth.close();
				rmSync(${JSON.stringify(modelsFile)});
				await registry.refresh("offline");
				result.warningsAfterRemoval = registry.getReservedProviderWarnings();
				result.requests = requests;
				authStorage.close();
				console.log(JSON.stringify(result));
				`,
			],
			{
				cwd: home,
				env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		return JSON.parse(child.stdout.toString());
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

describe("company runtime catalog and request auth", () => {
	test("resolves the fixed chat lane and roles without discovery or YAML routing overrides", () => {
		const result = runCompanyProbe();
		expect(result.capped).toHaveLength(6);
		expect(result.zcodeVisible).toBe(false);
		expect(result.retrievalVisible).toBe(false);
		expect(result.requests).toBe(0);
		expect(result.roles).toEqual({
			default: "Qwen3.6-27B-public",
			task: "Qwen3.6-27B-public",
			vision: "Qwen3.6-27B-public",
			advisor: "Qwen3.6-27B-public",
			smol: "Qwen3.6-35B-A3B",
			tiny: "Qwen3.6-35B-A3B",
			commit: "Qwen3.6-35B-A3B",
			plan: "GLM-5.2-public",
			slow: "GLM-5.2-public",
		});
		for (const model of result.capped) {
			expect(model.baseUrl).toBe("http://127.0.0.1:8081/gateway");
			expect(model.contextWindow).toBe(200_000);
			expect(model.maxTokens).toBe(81_920);
			expect(model.compat).toMatchObject({ supportsOutputEffort: false, disableAdaptiveThinking: true });
		}
		const byId = new Map(result.models.map(model => [model.id, model]));
		expect(byId.get("DeepSeek-V4-Flash-public")).toMatchObject({
			contextWindow: 1_000_000,
			tokenizer: "deepseek-v3",
		});
		expect(byId.get("GLM-5.2-public")).toMatchObject({ contextWindow: 1_000_000, tokenizer: "glm5" });
		expect(byId.get("MiniMax-M2.7")?.contextWindow).toBe(204_800);
		for (const id of ["Qwen3.6-27B-public", "Qwen3.6-35B-A3B", "Qwen3.8-27B"]) {
			expect(byId.get(id)).toMatchObject({ contextWindow: 262_144, tokenizer: "qwen3", input: ["text", "image"] });
		}
		expect(result.companyKey).toBe("company-fixture-token");
		expect(result.credentialKey).toBe(result.companyKey);
		expect(result.resolvedKey).toBe(result.companyKey);
		expect(result.headers.Authorization).toBe("Bearer company-fixture-token");
		expect(result.headers["X-Api-Key"]).toBeUndefined();
		expect(result.ignoredCompanyKeySource).toBe(false);
		expect(result.serializedSecret).toBe(false);
		expect(result.warnings).toHaveLength(2);
		expect(result.warningsAfterRemoval).toEqual([]);
		expect(result.disabledAvailable).toBe(false);
		for (const key of [
			"disabledFind",
			"disabledModelKey",
			"disabledProviderKey",
			"disabledCredential",
			"disabledResolverKey",
			"disabledSessionModel",
		] as const)
			expect(result[key]).toBeUndefined();
		expect(result.gatewayLocalProviders).toEqual([]);
		expect(result.gatewayModelKey).toBe("broker-fixture-token");
		expect(result.gatewayProviderKey).toBe(result.gatewayModelKey);
		expect(result.gatewayResolverKey).toBe(result.gatewayModelKey);
		expect(result.gatewayProxyId).toBe("broker-proxy-model");
		expect(result.ignoredPolicyError).toBeUndefined();
		expect(result.ignoredPolicyWarnings).toHaveLength(2);
		expect(result.ignoredProxyKey).toBe("retained-proxy-key");
		expect(JSON.stringify(result.invalidProxyKeyError)).toContain("apiKey");
	}, 30_000);
});
