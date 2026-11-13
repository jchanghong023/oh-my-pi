import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { Effort, getCustomApi, streamSimple } from "@oh-my-pi/pi-ai";
import { getAllOAuthProviders, getOAuthProviders, isOAuthLoginSupported } from "@oh-my-pi/pi-ai/registry/oauth";
import { closeModelCache } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModels, getBundledProviders, getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getCodeAgentModels } from "../src/config/codeagent-provider";
import * as companyProvider from "../src/config/company-provider";
import { ModelRegistry } from "../src/config/model-registry";
import { resolveSessionModelSelector } from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
	const dir = await TempDir.create("@provider-contract-");
	cleanup.push(() => dir.remove());
	cleanup.push(() => closeModelCache());
	const auth = await AuthStorage.create(":memory:");
	cleanup.push(() => auth.close());
	const settings = Settings.isolated({ modelRoles: { default: "deepseek/explicit-default" } });
	const modelsPath = dir.join("models.yml");
	const registry = new ModelRegistry(auth, modelsPath, {
		settings,
		fetch: async () => {
			throw new Error("Unexpected external catalog discovery");
		},
	});
	return { dir, auth, settings, modelsPath, registry };
}

const definition = {
	id: "fixture-contract-model",
	name: "Fixture contract model",
	reasoning: false,
	input: ["text"] as Array<"text">,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function answer() {
	const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	return new Response(
		[
			frame("message_start", {
				type: "message_start",
				message: { id: "fixture", usage: { input_tokens: 1, output_tokens: 0 } },
			}),
			frame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			frame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "fixture answer" },
			}),
			frame("content_block_stop", { type: "content_block_stop", index: 0 }),
			frame("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 2 },
			}),
			frame("message_stop", { type: "message_stop" }),
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("fork provider boundaries", () => {
	test("retired Zen is absent from login choices but remains available for legacy credential management", () => {
		expect(getOAuthProviders().map(provider => provider.id)).not.toContain("opencode-zen");
		expect(isOAuthLoginSupported("opencode-zen")).toBe(false);
		expect(getAllOAuthProviders().map(provider => provider.id)).toContain("opencode-zen");
		expect(isOAuthLoginSupported("openai-codex")).toBe(true);
		expect(isOAuthLoginSupported("kagi")).toBe(true);
	});

	// Generated output, not rule text, must exclude retired and unsupported chat rows.
	test("bundled output contains only retained chat lanes while retaining non-chat models", () => {
		const allowed = [
			"company",
			"openai-codex",
			"codeagent",
			"ascend",
			"opencode-go",
			"deepseek",
			"alibaba-token-plan",
		];
		const models = getBundledProviders().flatMap(provider => getBundledModels(provider));
		expect(models.length).toBeGreaterThan(0);
		const chatProviders = [
			...new Set(
				models
					.filter(model => (model.kind ?? "chat") === "chat" && model.api !== "local-inference")
					.map(model => model.provider),
			),
		];
		expect(chatProviders.filter(provider => !allowed.includes(provider))).toEqual([]);
		expect(models.filter(model => model.provider === "opencode-zen")).toEqual([]);
		expect(models.some(model => model.api === "local-inference")).toBe(true);
		expect(models.some(model => model.kind === "embedding")).toBe(true);
		expect(models.some(model => model.kind === "rerank")).toBe(true);
	});

	// A rejected reserved registration must not install even its custom transport or key.
	test.each(["company", "codeagent"])(
		"reserved %s registration fails atomically for runtime and extension owners",
		async provider => {
			const { registry, auth } = await fixture();
			const before = registry.getAll("all");
			const source = auth.keys.source(provider);
			for (const lifetime of ["extension", "runtime"] as const) {
				expect(() =>
					registry.registerProvider(
						provider,
						{
							api: "reserved-contract-api",
							baseUrl: "https://replacement.invalid",
							apiKey: "replacement-secret",
							models: [definition],
							streamSimple: () => {
								throw new Error("Rejected transport must never run");
							},
						},
						"ext://reserved-contract",
						lifetime,
					),
				).toThrow(/built-in.*cannot be replaced/i);
				expect(registry.getAll("all")).toEqual(before);
				expect(auth.keys.source(provider)).toEqual(source);
				expect(getCustomApi("reserved-contract-api")).toBeUndefined();
			}
		},
	);

	// Legacy chat rows cannot bypass admission by registration, refresh or the local name.
	test("runtime admission rejects unsupported chat without deleting old credentials or non-chat capability", async () => {
		const { registry, auth } = await fixture();
		await auth.credentials.set("opencode-zen", { type: "api_key", key: "legacy-secret" });
		expect(await auth.keys.get("opencode-zen", "legacy-before")).toBe("legacy-secret");
		for (const provider of ["opencode-zen", "anthropic", "local", "unsupported-gateway"]) {
			registry.registerProvider(provider, {
				api: "openai-completions",
				baseUrl: "https://remote.invalid/v1",
				requestAuthConfigured: () => true,
				models: [definition],
			});
			expect(registry.find(provider, definition.id)).toBeUndefined();
		}
		registry.registerProvider("retained-image-gateway", {
			api: "openai-images",
			baseUrl: "https://images.invalid/v1",
			apiKey: "fixture-key",
			models: [{ ...definition, kind: "image" }],
		});
		registry.registerProvider("deepseek", {
			api: "openai-completions",
			baseUrl: "https://retained.invalid/v1",
			apiKey: "fixture-key",
			models: [definition],
		});
		await registry.refresh("offline");
		expect(registry.find("deepseek", definition.id)?.baseUrl).toBe("https://retained.invalid/v1");
		expect(registry.getAll("image").find(model => model.provider === "retained-image-gateway")).toMatchObject({
			id: definition.id,
			kind: "image",
		});
		for (const provider of ["opencode-zen", "anthropic", "local", "unsupported-gateway"]) {
			expect(registry.find(provider, definition.id)).toBeUndefined();
		}
		expect(await auth.keys.get("opencode-zen", "legacy-after")).toBe("legacy-secret");
	});

	// Read the real seeded model so wrong API/strict-tool axes cannot be hidden by a copied fixture.
	test("CodeAgent seed exposes the fixed no-auth OpenAI-compatible contract", () => {
		expect(getCodeAgentModels()).toHaveLength(1);
		expect(getCodeAgentModels()[0]).toMatchObject({
			provider: "codeagent",
			id: "deepseek-v4.1-flash-1017",
			name: "deepseek-v4.1-flash-1017",
			api: "openai-completions",
			baseUrl: "https://snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com/api/v2",
			reasoning: true,
			supportsTools: true,
			contextWindow: 409600,
			maxTokens: 32768,
			compat: { supportsStrictMode: false },
		});
	});

	test("old unsupported cache and selector references stay missing without rewriting user data", async () => {
		const { registry, settings, dir, modelsPath } = await fixture();
		const saved = JSON.stringify({
			providers: {
				"unsupported-gateway": {
					api: "openai-completions",
					baseUrl: "https://legacy.invalid/v1",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			},
		});
		await fs.writeFile(modelsPath, saved);
		writeModelCache(
			"unsupported-gateway",
			Date.now(),
			[
				buildModel({
					...definition,
					provider: "unsupported-gateway",
					api: "openai-completions",
					baseUrl: "https://legacy.invalid/v1",
				}),
			],
			true,
			"",
			dir.join("models.db"),
		);
		const historyPath = dir.join("old-session.jsonl");
		const history =
			JSON.stringify({ type: "model_change", provider: "unsupported-gateway", modelId: definition.id }) + "\n";
		await fs.writeFile(historyPath, history);
		await registry.refresh("offline");
		expect(resolveSessionModelSelector(registry, `unsupported-gateway/${definition.id}`)).toBeUndefined();
		expect(registry.getAll().some(model => model.provider === "unsupported-gateway")).toBe(false);
		expect(await fs.readFile(modelsPath, "utf8")).toBe(saved);
		expect(await fs.readFile(historyPath, "utf8")).toBe(history);
		expect(settings.getModelRole("default")).toBe("deepseek/explicit-default");
	});

	// Env authentication must make the fixed Ascend roster usable without a model file or role write.
	test.each([false, true])(
		"Ascend env authentication preserves the fixed roster and explicit default role (offline: %s)",
		async offline => {
			// Stub the unrelated company credential source; Ascend still uses the real registry and wire adapter.
			const lane = spyOn(companyProvider, "isCompanyLaneActive").mockReturnValue(offline);
			const companyConfig = spyOn(companyProvider, "getCompanyConfig").mockReturnValue(undefined);
			const companyError = spyOn(companyProvider, "getCompanyConfigError").mockReturnValue(undefined);
			cleanup.push(() => {
				companyError.mockRestore();
				companyConfig.mockRestore();
				lane.mockRestore();
			});
			const original = process.env.ASCEND_API_KEY;
			process.env.ASCEND_API_KEY = "ascend-contract-secret";
			cleanup.push(() => {
				if (original === undefined) delete process.env.ASCEND_API_KEY;
				else process.env.ASCEND_API_KEY = original;
			});
			const { registry, settings, modelsPath } = await fixture();
			const models = registry.getAvailable().filter(model => model.provider === "ascend");
			expect(models.map(model => model.id).sort()).toEqual(
				["minimax2.7", "kimi-k2.6", "deepseek-v4-flash", "qwen3.8-27b", "qwen-aw-35b", "qwen3.8-flash-next"].sort(),
			);
			for (const model of models) {
				expect(model).toMatchObject({
					api: "anthropic-messages",
					baseUrl: "http://models.ascend.huawei.com",
					reasoning: true,
					supportsTools: true,
					maxTokens: 32768,
					compat: { disableStrictTools: true },
				});
				expect(model.contextWindow).toBe(model.id.startsWith("qwen3.8-") ? 256000 : 200000);
				expect(model.input).toEqual(
					["qwen-aw-35b", "qwen3.8-flash-next"].includes(model.id) ? ["text", "image"] : ["text"],
				);
				expect(getModelPricingStatus(model)).toBe("unknown");
			}
			for (const id of ["qwen3.8-27b", "qwen3.8-flash-next"]) {
				const model = registry.find("ascend", id)!;
				expect(model.thinking).toMatchObject({
					mode: "anthropic-budget-effort",
					efforts: ["low", "medium", "high", "xhigh"],
					defaultLevel: "xhigh",
				});
				const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
				const result = await streamSimple(
					model,
					{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
					{
						apiKey: await registry.getApiKey(model),
						reasoning: Effort.High,
						fetch: async (input, init) => {
							requests.push({
								url: input instanceof Request ? input.url : String(input),
								headers: new Headers(init?.headers),
								body: JSON.parse(String(init?.body)),
							});
							return answer();
						},
					},
				).result();
				expect(result.stopReason).toBe("stop");
				expect(requests).toHaveLength(1);
				const endpoint = new URL(requests[0]!.url);
				expect(endpoint.origin).toBe("http://models.ascend.huawei.com");
				expect(endpoint.pathname).toBe("/v1/messages");
				expect(requests[0]?.headers.get("authorization")).toBe("Bearer ascend-contract-secret");
				expect(requests[0]?.headers.get("x-api-key")).toBeNull();
				expect(requests[0]?.body).toMatchObject({
					model: id,
					output_config: { effort: "xhigh" },
					thinking: { type: "enabled" },
				});
			}
			expect(settings.getModelRole("default")).toBe("deepseek/explicit-default");
			expect(
				await fs.stat(modelsPath).then(
					() => true,
					error => {
						if (error.code !== "ENOENT") throw error;
						return false;
					},
				),
			).toBe(false);
			expect(JSON.stringify(registry.getAll("all"))).not.toContain("ascend-contract-secret");
		},
	);
});
