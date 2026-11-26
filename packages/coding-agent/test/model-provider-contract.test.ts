import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Effort, getCustomApi, streamSimple } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CodeAgentTokenCache, getCodeAgentModels, streamCodeAgent } from "../src/config/codeagent-provider";
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
	// A rejected reserved registration must not install even its custom transport or key.
	test.each(["company", "codeagent"])("reserved %s registration fails atomically", async provider => {
		const { registry, auth } = await fixture();
		const before = registry.getAll("all");
		const source = auth.keys.source(provider);
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
			),
		).toThrow(new RegExp(provider, "i"));
		expect(registry.getAll("all")).toEqual(before);
		expect(auth.keys.source(provider)).toEqual(source);
		expect(getCustomApi("reserved-contract-api")).toBeUndefined();
	});

	test("runtime providers remain selectable after refresh without deleting stored credentials", async () => {
		const { registry, auth } = await fixture();
		const providers = ["opencode-zen", "custom-gateway"];
		for (const provider of providers) {
			await auth.credentials.set(provider, { type: "api_key", key: `${provider}-secret` });
			registry.registerProvider(provider, {
				api: "openai-completions",
				baseUrl: "https://remote.invalid/v1",
				apiKey: `${provider}-secret`,
				models: [definition],
			});
		}
		registry.registerProvider("retained-image-gateway", {
			api: "openai-images",
			baseUrl: "https://images.invalid/v1",
			apiKey: "fixture-key",
			models: [{ ...definition, kind: "image" }],
		});
		await registry.refresh("offline");
		expect(registry.getAll("image").find(model => model.provider === "retained-image-gateway")).toMatchObject({
			id: definition.id,
			kind: "image",
		});
		for (const provider of providers) {
			const selected = resolveSessionModelSelector(registry, `${provider}/${definition.id}`);
			expect(selected?.model).toMatchObject({ id: definition.id, provider, baseUrl: "https://remote.invalid/v1" });
			expect(await registry.getApiKey(selected!.model)).toBe(`${provider}-secret`);
			expect(auth.credentials.get(provider)).toMatchObject({ type: "api_key", key: `${provider}-secret` });
		}
	});

	test("the CodeAgent model uses its built-in gateway and omits the unsupported tool strict field", async () => {
		const model = getCodeAgentModels()[0]!;
		expect(model.api).toBe("openai-completions");
		let request: { url: string; tool?: { name: string; strict?: boolean } } | undefined;
		const result = await streamCodeAgent(
			model,
			{
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
				tools: [
					{
						name: "lookup",
						description: "Look up an item",
						strict: false,
						parameters: { type: "object", properties: {} },
					},
				],
			},
			{
				fetch: async (input, init) => {
					const body = JSON.parse(String(init?.body));
					request = { url: input instanceof Request ? input.url : String(input), tool: body.tools?.[0]?.function };
					const chunk = {
						id: "fixture",
						choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
					};
					return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
			new CodeAgentTokenCache(() => "fixture-token"),
		).result();
		expect(result.stopReason).toBe("stop");
		expect(request).toMatchObject({
			url: "https://snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com/api/v2/chat/completions",
			tool: { name: "lookup" },
		});
		expect(request?.tool?.strict).toBeUndefined();
	});

	test("offline refresh keeps a configured gateway's cached model selectable without rewriting the configuration", async () => {
		const { registry, dir, modelsPath } = await fixture();
		const saved = JSON.stringify({
			providers: {
				"custom-gateway": {
					api: "openai-completions",
					baseUrl: "https://legacy.invalid/v1",
					auth: "none",
					discovery: { type: "openai-models-list" },
				},
			},
		});
		await Bun.write(modelsPath, saved);
		writeModelCache(
			"custom-gateway:openai-models-list-context-v6",
			Date.now(),
			[
				buildModel({
					...definition,
					provider: "custom-gateway",
					api: "openai-completions",
					baseUrl: "https://legacy.invalid/v1",
				}),
			],
			true,
			"",
			dir.join("models.db"),
		);
		await registry.refresh("offline");
		expect(resolveSessionModelSelector(registry, `custom-gateway/${definition.id}`)?.model).toMatchObject({
			provider: "custom-gateway",
			id: definition.id,
			baseUrl: "https://legacy.invalid/v1",
		});
		expect(await Bun.file(modelsPath).text()).toBe(saved);
	});

	test.each([false, true])(
		"Ascend uses environment credentials and its fixed gateway (offline: %s)",
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
			const id = "qwen3.8-flash-next";
			const model = resolveSessionModelSelector(registry, `ascend/${id}`)?.model;
			if (!model) throw new Error("Ascend model is not selectable with ASCEND_API_KEY");
			expect(getModelPricingStatus(model)).toBe("unknown");
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
			expect(requests[0]?.url).toBe("http://models.ascend.huawei.com/v1/messages");
			expect(requests[0]?.headers.get("authorization")).toBe("Bearer ascend-contract-secret");
			expect(requests[0]?.headers.get("x-api-key")).toBeNull();
			expect(requests[0]?.body).toMatchObject({
				model: id,
				output_config: { effort: "xhigh" },
				thinking: { type: "enabled" },
			});
			expect(settings.getModelRole("default")).toBe("deepseek/explicit-default");
			expect(await Bun.file(modelsPath).exists()).toBe(false);
			expect(JSON.stringify(registry.getAll("all"))).not.toContain("ascend-contract-secret");
		},
	);
});
