import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildAnthropicClientOptions, buildAnthropicHeaders } from "@oh-my-pi/pi-ai/providers/anthropic";
import { NO_AUTH_SENTINEL } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	getZcodeApiModels,
	resolveZcodeApiBaseUrl,
	ZCODE_API_DEFAULT_BASE_URL,
	ZCODE_API_PROVIDER_ID,
} from "../src/config/zcode-api-models";

// The fork contract (docs-zh-CN/fork.md) pins the zcode-api roster to the
// `zhipu-coding-plan` lane: same parameters, minus the collapsed `[1m]` alias,
// served over the proxy's Anthropic route instead of the Zhipu OpenAI route.
const LANE =
	(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"openai-completions">>>)["zhipu-coding-plan"] ??
	{};

// The roster asserts the loopback default, so a host-level override must not
// leak in; the two endpoint tests set and restore the variable themselves.
const hostBaseUrl = Bun.env.ZCODE_API_BASE_URL;
beforeEach(() => {
	delete Bun.env.ZCODE_API_BASE_URL;
});
afterAll(() => {
	if (hostBaseUrl !== undefined) Bun.env.ZCODE_API_BASE_URL = hostBaseUrl;
});

describe("zcode-api runtime provider roster", () => {
	test("mirrors the zhipu-coding-plan lane except the collapsed [1m] alias", () => {
		const models = getZcodeApiModels();
		const laneIds = Object.keys(LANE).filter(id => id !== "glm-5.2-highspeed[1m]");
		expect(models.map(model => model.id).sort()).toEqual(laneIds.sort());
		for (const model of models) {
			const lane = LANE[model.id];
			expect(lane, `lane row for ${model.id}`).toBeDefined();
			expect(model.provider).toBe(ZCODE_API_PROVIDER_ID);
			expect(model.api).toBe("anthropic-messages");
			expect(model.baseUrl).toBe(ZCODE_API_DEFAULT_BASE_URL);
			expect(model.reasoning).toBe(true);
			expect(model.contextWindow).toBe(lane?.contextWindow);
			expect(model.maxTokens).toBe(lane?.maxTokens);
			expect(model.input).toEqual(lane?.input);
			expect(model.cost).toEqual(lane?.cost);
			// Rows without an explicit tokenizer resolve one at build time, so
			// only the lane's explicit values are comparable.
			if (lane?.tokenizer) expect(model.tokenizer).toBe(lane.tokenizer);
		}
	});

	test("thinking effort tiers match the coding-plan lane", () => {
		const byId = new Map(getZcodeApiModels().map(model => [model.id, model]));
		for (const [id, model] of byId) {
			const laneThinking = LANE[id]?.thinking;
			if (!laneThinking) continue;
			expect(model.thinking?.efforts, id).toEqual(laneThinking.efforts);
			if (laneThinking.defaultLevel !== undefined)
				expect(model.thinking?.defaultLevel, id).toBe(laneThinking.defaultLevel);
			if (laneThinking.requiresEffort !== undefined)
				expect(model.thinking?.requiresEffort, id).toBe(laneThinking.requiresEffort);
		}
		// Anchors for the contract wording itself, independent of the lane snapshot.
		expect(byId.get("glm-4.5")?.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(byId.get("glm-5.2")?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		expect(byId.get("glm-5.3")?.thinking).toMatchObject({
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: "max",
			requiresEffort: true,
		});
	});

	test("carries the coding-plan GLM tool_result id wire quirk", () => {
		for (const model of getZcodeApiModels()) {
			expect(model.compat.requiresToolResultId, model.id).toBe(true);
		}
	});
});

describe("zcode-api endpoint resolution", () => {
	test("keeps the loopback default unless a full override arrives", () => {
		const saved = Bun.env.ZCODE_API_BASE_URL;
		try {
			delete Bun.env.ZCODE_API_BASE_URL;
			expect(resolveZcodeApiBaseUrl()).toBe(ZCODE_API_DEFAULT_BASE_URL);
			Bun.env.ZCODE_API_BASE_URL = "  http://172.17.80.1:8080/  ";
			expect(resolveZcodeApiBaseUrl()).toBe("http://172.17.80.1:8080");
			// A value that reduces to nothing must not leave rows with an empty
			// base URL (the transport would reroute to the public API).
			Bun.env.ZCODE_API_BASE_URL = "///";
			expect(resolveZcodeApiBaseUrl()).toBe(ZCODE_API_DEFAULT_BASE_URL);
			// `/v1` stripping belongs to the Anthropic transport, not the resolver.
			Bun.env.ZCODE_API_BASE_URL = "http://proxy.invalid:8080/v1";
			expect(resolveZcodeApiBaseUrl()).toBe("http://proxy.invalid:8080/v1");
		} finally {
			if (saved === undefined) delete Bun.env.ZCODE_API_BASE_URL;
			else Bun.env.ZCODE_API_BASE_URL = saved;
		}
	});

	test("rows are memoized per endpoint and rebuilt when the endpoint changes", () => {
		const saved = Bun.env.ZCODE_API_BASE_URL;
		try {
			Bun.env.ZCODE_API_BASE_URL = "http://proxy-a.invalid:8080";
			const first = getZcodeApiModels();
			expect(first[0]?.baseUrl).toBe("http://proxy-a.invalid:8080");
			expect(getZcodeApiModels()).toBe(first);
			Bun.env.ZCODE_API_BASE_URL = "http://proxy-b.invalid:8080";
			const second = getZcodeApiModels();
			expect(second).not.toBe(first);
			expect(second[0]?.baseUrl).toBe("http://proxy-b.invalid:8080");
		} finally {
			if (saved === undefined) delete Bun.env.ZCODE_API_BASE_URL;
			else Bun.env.ZCODE_API_BASE_URL = saved;
		}
	});
});

describe("zcode-api keyless transport", () => {
	test("sends no Authorization and no X-Api-Key for the keyless sentinel", () => {
		const headers = buildAnthropicHeaders({ apiKey: NO_AUTH_SENTINEL, baseUrl: ZCODE_API_DEFAULT_BASE_URL });
		expect(headers.Authorization).toBeUndefined();
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	test("keeps an explicit Authorization from model.headers", () => {
		const headers = buildAnthropicHeaders({
			apiKey: NO_AUTH_SENTINEL,
			baseUrl: ZCODE_API_DEFAULT_BASE_URL,
			modelHeaders: { Authorization: "Bearer proxy-key" },
		});
		expect(headers.Authorization).toBe("Bearer proxy-key");
	});

	test("still sends a Bearer for a real key", () => {
		const headers = buildAnthropicHeaders({ apiKey: "sk-real", baseUrl: ZCODE_API_DEFAULT_BASE_URL });
		expect(headers.Authorization).toBe("Bearer sk-real");
	});

	test("client options suppress the sentinel so the SDK cannot inject X-Api-Key: N/A", () => {
		const options = buildAnthropicClientOptions({ model: getZcodeApiModels()[0]!, apiKey: NO_AUTH_SENTINEL });
		expect(options.apiKey).toBeNull();
		expect(options.defaultHeaders.Authorization).toBeUndefined();
	});
});
