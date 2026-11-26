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
});
