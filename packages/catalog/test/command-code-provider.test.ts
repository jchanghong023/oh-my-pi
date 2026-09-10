import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
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

	// The discovery payload carries no capability flags, so an id with no bundled
	// reference row would otherwise keep `reasoning: false` and offer no level at
	// all. It inherits the shared V4.1 Flash lineage instead, which must resolve
	// the concrete range its DeepSeek siblings expose.
	test("gives V4.1 Flash ids a selectable thinking range", async () => {
		const fetch = (async (input: unknown) => {
			if (String(input) === "https://commandcode.ai/models.data") return new Response(null, { status: 503 });
			return Response.json({ data: [{ id: "deepseek/deepseek-v4.1-flash" }] });
		}) as typeof globalThis.fetch;
		const models = await commandCodeModelManagerOptions({ apiKey: "test-key", fetch }).fetchDynamicModels?.();
		const built = buildModel(models![0]!);

		expect(built.reasoning).toBe(true);
		expect(built.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		// The surface is inherited wholesale from the bundled `deepseek-v4-flash`
		// row, so the endpoint's own limits come along with the effort ladder.
		expect(built.contextWindow).toBe(1_000_000);
		expect(built.maxTokens).toBe(384_000);
	});

	// The inherited surface only reaches an installation that still fetches the
	// catalog. The gateway is authoritative, so a cache written before the
	// lineage existed is reused verbatim and keeps `reasoning: false` until the
	// TTL lapses — the level stays missing even though the code is fixed.
	// Lineage ids are therefore part of the migration policy and must refetch.
	test("invalidates catalogs cached before the V4.1 lineage", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-command-code-reasoning-cache-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		// `fetchDynamicModels` closes over this mock, so the counter has to live
		// here — overriding `fetch` on the resolve options has no effect.
		let fetches = 0;
		const fetch = (async (input: unknown) => {
			if (String(input) === "https://commandcode.ai/models.data") return new Response(null, { status: 503 });
			fetches++;
			return Response.json({ data: [{ id: "deepseek/deepseek-v4.1-flash" }] });
		}) as typeof globalThis.fetch;

		try {
			const options = commandCodeModelManagerOptions({ apiKey: "test-key", fetch });
			const cacheProviderId = options.cacheProviderId;
			if (!cacheProviderId) throw new Error("Command Code cache provider id is missing");

			// Fingerprint an installation predating the lineage would have
			// written, then replace its rows with what that build discovered: the
			// untouched `reasoning: false` default.
			await resolveProviderModels({ ...options, cacheDbPath, dropCachedModelIdsOnStaticMismatch: [] }, "online");
			const priorCache = readModelCache(cacheProviderId, Number.POSITIVE_INFINITY, Date.now, cacheDbPath);
			if (!priorCache) throw new Error("Command Code cache was not written");
			const stale = buildModel({
				id: "deepseek/deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				api: "openai-completions",
				provider: "command-code",
				baseUrl: "https://api.commandcode.ai/provider/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 384_000,
			});
			// The manager matches cached row ids exactly, and those carry the
			// provider namespace — a bare lineage key would leave the row in place.
			expect(options.dropCachedModelIdsOnStaticMismatch).toContain(stale.id);
			writeModelCache(
				cacheProviderId,
				priorCache.updatedAt,
				[stale],
				true,
				priorCache.staticFingerprint,
				cacheDbPath,
			);

			fetches = 0;
			const upgraded = await resolveProviderModels({ ...options, cacheDbPath }, "online-if-uncached");
			const model = upgraded.models.find(candidate => candidate.id === stale.id);

			expect(fetches).toBe(1);
			expect(model?.reasoning).toBe(true);
			expect(model?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
