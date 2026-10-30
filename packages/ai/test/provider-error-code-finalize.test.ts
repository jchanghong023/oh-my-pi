import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";

describe("provider error classification", () => {
	it("uses string codes and falls back to type for numeric OpenAI codes", () => {
		expect(
			AIError.OpenAIHttpError.parseEnvelope({ error: { code: "quota", type: "invalid_request" } }, undefined).code,
		).toBe("quota");
		expect(
			AIError.OpenAIHttpError.parseEnvelope({ error: { code: 7103, type: "invalid_request" } }, undefined).code,
		).toBe("invalid_request");
	});

	it("prefers Anthropic detail error_code over error type and code", async () => {
		const response = Response.json(
			{ error: { code: "outer", type: "invalid_request", details: { error_code: "inner" } } },
			{ status: 400 },
		);
		const error = await AIError.AnthropicApiError.fromResponse(response);
		expect(error.code).toBe("inner");
		const result = await AIError.finalize(error);
		expect(result.status).toBe(400);
		expect(Object.hasOwn(result, "providerErrorCode")).toBe(false);
	});
});
