import { describe, expect, test } from "bun:test";
import {
	COMPANY_CHAT_MODEL_SPECS,
	COMPANY_OFFLINE_CONTEXT_WINDOW,
	COMPANY_OFFLINE_ROLE_DEFAULTS,
	COMPANY_RETRIEVAL_MODELS,
} from "../src/config/company-models";

// The fork contract (docs-zh-CN/fork.md「公司内网模型」) pins the company lane
// to a fixed parameter table served over the internal Anthropic gateway; these
// assertions make any drift (local edit or upstream sync) fail loudly instead
// of silently changing what --offline sessions resolve to.

describe("company chat model contract table", () => {
	test("carries exactly the six contract models with their pinned parameters", () => {
		expect(COMPANY_CHAT_MODEL_SPECS).toEqual([
			{
				id: "DeepSeek-V4-Flash-public",
				input: ["text"],
				contextWindow: 1_000_000,
				maxTokens: 81_920,
				tokenizer: "deepseek-v3",
			},
			{ id: "GLM-5.2-public", input: ["text"], contextWindow: 1_000_000, maxTokens: 81_920, tokenizer: "glm5" },
			{ id: "MiniMax-M2.7", input: ["text"], contextWindow: 204_800, maxTokens: 81_920 },
			{
				id: "Qwen3.6-27B-public",
				input: ["text", "image"],
				contextWindow: 262_144,
				maxTokens: 81_920,
				tokenizer: "qwen3",
			},
			{
				id: "Qwen3.6-35B-A3B",
				input: ["text", "image"],
				contextWindow: 262_144,
				maxTokens: 81_920,
				tokenizer: "qwen3",
			},
			{ id: "Qwen3.8-27B", input: ["text", "image"], contextWindow: 262_144, maxTokens: 81_920, tokenizer: "qwen3" },
		]);
	});
});

describe("company offline defaults contract", () => {
	test("caps the offline context window at 200k without touching maxTokens", () => {
		// main.ts applies this via setCompanyChatContextWindow in --offline
		// processes; maxTokens stays at each model's table value (81_920).
		expect(COMPANY_OFFLINE_CONTEXT_WINDOW).toBe(200_000);
		for (const spec of COMPANY_CHAT_MODEL_SPECS) {
			expect(spec.maxTokens, spec.id).toBe(81_920);
		}
	});

	test("fills exactly the contract roles with the contract models", () => {
		expect({ ...COMPANY_OFFLINE_ROLE_DEFAULTS }).toEqual({
			default: "company/Qwen3.6-27B-public",
			task: "company/Qwen3.6-27B-public",
			vision: "company/Qwen3.6-27B-public",
			advisor: "company/Qwen3.6-27B-public",
			smol: "company/Qwen3.6-35B-A3B",
			tiny: "company/Qwen3.6-35B-A3B",
			commit: "company/Qwen3.6-35B-A3B",
			plan: "company/GLM-5.2-public",
			slow: "company/GLM-5.2-public",
		});
		// Every default must resolve to a model the lane actually serves.
		const served = new Set(COMPANY_CHAT_MODEL_SPECS.map(spec => `company/${spec.id}`));
		for (const selector of Object.values(COMPANY_OFFLINE_ROLE_DEFAULTS)) {
			expect(served.has(selector), selector).toBe(true);
		}
	});
});

describe("company retrieval catalog contract", () => {
	test("lists only the two 2B retrieval models, never as chat models", () => {
		expect(COMPANY_RETRIEVAL_MODELS).toEqual([
			{
				id: "Qwen3-VL-Embedding-2B",
				type: "embedding",
				input: ["text", "image"],
				contextWindow: 32_768,
				dimensions: 2048,
			},
			{ id: "Qwen3-VL-Reranker-2B", type: "reranker", input: ["text", "image"], contextWindow: 32_768 },
		]);
		for (const model of COMPANY_RETRIEVAL_MODELS) {
			expect(COMPANY_CHAT_MODEL_SPECS.some(spec => spec.id === model.id)).toBe(false);
		}
	});
});
