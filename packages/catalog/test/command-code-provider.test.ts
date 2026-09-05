import { describe, expect, test } from "bun:test";
import {
	commandCodeModelManagerOptions,
	resolveCommandCodeApi,
	resolveCommandCodeBaseUrl,
} from "@oh-my-pi/pi-catalog/provider-models/command-code";
import { encode } from "turbo-stream";

describe("Command Code provider", () => {
	test("routes only Anthropic model identities to messages", () => {
		expect(resolveCommandCodeApi("claude-opus-4-8")).toBe("anthropic-messages");
		expect(resolveCommandCodeApi("anthropic/claude-sonnet-4-6")).toBe("anthropic-messages");
		expect(resolveCommandCodeApi("gpt-5.5")).toBe("openai-completions");
		expect(resolveCommandCodeApi("openai/gpt-5.5")).toBe("openai-completions");
		expect(resolveCommandCodeApi("google/gemini-3.1-pro")).toBe("openai-completions");
		expect(resolveCommandCodeApi("deepseek/deepseek-v4-flash")).toBe("openai-completions");
	});

	test("normalizes provider overrides per wire", () => {
		expect(resolveCommandCodeBaseUrl("anthropic-messages", "https://proxy.example/provider/v1")).toBe(
			"https://proxy.example/provider",
		);
		expect(resolveCommandCodeBaseUrl("openai-completions", "https://proxy.example/provider/v1")).toBe(
			"https://proxy.example/provider/v1",
		);
		expect(resolveCommandCodeBaseUrl("anthropic-messages", "https://proxy.example/provider")).toBe(
			"https://proxy.example/provider",
		);
		expect(resolveCommandCodeBaseUrl("openai-completions", "https://proxy.example/provider")).toBe(
			"https://proxy.example/provider/v1",
		);
	});

	test("scopes model caches to the normalized provider endpoint", () => {
		const defaultCache = commandCodeModelManagerOptions().cacheProviderId;
		const teamA = commandCodeModelManagerOptions({
			baseUrl: "https://proxy.example/team-a/provider",
		}).cacheProviderId;
		const teamAV1 = commandCodeModelManagerOptions({
			baseUrl: "https://proxy.example/team-a/provider/v1/",
		}).cacheProviderId;
		const teamB = commandCodeModelManagerOptions({
			baseUrl: "https://proxy.example/team-b/provider",
		}).cacheProviderId;

		expect(teamA).toBe(teamAV1);
		expect(teamA).not.toBe(teamB);
		expect(teamA).not.toBe(defaultCache);
	});

	test("discovers mixed-wire models with live Command Code prices", async () => {
		const fetch = (async (input: unknown) => {
			const url = String(input);
			if (url === "https://commandcode.ai/models.data") {
				return new Response(
					encode({
						"routes/models/index": {
							data: {
								models: [
									{
										id: "claude-opus-4-8",
										tiers: [{ rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }],
									},
									{
										id: "gpt-5.5",
										tiers: [
											{ rates: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } },
											{
												context: "> 272K",
												rates: { input: 4, output: 12, cacheRead: 0.4, cacheWrite: 5 },
											},
										],
									},
								],
							},
						},
					}),
				);
			}
			expect(url).toBe("https://api.commandcode.ai/provider/v1/models");
			return new Response(
				JSON.stringify({
					data: [
						{ id: "claude-opus-4-8", object: "model" },
						{ id: "gpt-5.5", object: "model" },
						{ id: "kimi-k2", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof globalThis.fetch;

		const options = commandCodeModelManagerOptions({ apiKey: "test-key", fetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));

		expect(byId.get("claude-opus-4-8")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.commandcode.ai/provider",
			provider: "command-code",
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			costSource: "provider",
		});
		expect(byId.get("gpt-5.5")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			provider: "command-code",
			reasoning: true,
			cost: {
				input: 2,
				output: 8,
				cacheRead: 0.2,
				cacheWrite: 2.5,
				longContext: {
					input: 4,
					output: 12,
					cacheRead: 0.4,
					cacheWrite: 5,
					inputThreshold: 272_000,
				},
			},
		});
		expect(byId.get("kimi-k2")?.thinking).toBeUndefined();
	});

	test("falls back to bundled prices when live pricing is unavailable", async () => {
		const fetch = (async (input: unknown) => {
			const url = String(input);
			if (url === "https://commandcode.ai/models.data") return new Response(null, { status: 503 });
			return new Response(JSON.stringify({ data: [{ id: "deepseek/deepseek-v4-flash" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;

		const options = commandCodeModelManagerOptions({ apiKey: "test-key", fetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		expect(models[0]?.cost.input).toBeGreaterThan(0);
		expect(models[0]?.cost.output).toBeGreaterThan(0);
		expect(models[0]?.costSource).toBe("reference");
	});

	test("marks discovery defaults unknown without changing their rates", async () => {
		const fetch = (async (input: unknown) => {
			if (String(input) === "https://commandcode.ai/models.data") return new Response(null, { status: 503 });
			return Response.json({ data: [{ id: "unlisted-test-model-xyz" }] });
		}) as typeof globalThis.fetch;
		const models = await commandCodeModelManagerOptions({ apiKey: "test-key", fetch }).fetchDynamicModels?.();
		expect(models?.[0]).toMatchObject({
			costSource: "unknown",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});
});
