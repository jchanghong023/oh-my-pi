import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createAbortSourceTracker } from "../src/utils/abort";

describe("AIError.finalize structured provider codes", () => {
	it("preserves in-band wire spelling separately from normalized classification codes", async () => {
		const error = AIError.createInBandProviderError({
			error: { code: "Rate_Limit_Exceeded", status: 429, message: "Busy" },
		});
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		const result = await AIError.finalize(error);
		expect(result.providerErrorCode).toBe("Rate_Limit_Exceeded");
		expect(result.status).toBe(429);
		expect(AIError.retriable(result.id)).toBe(true);
	});

	it("does not promote an in-band event discriminator into a provider code", async () => {
		const error = AIError.createInBandProviderError({ type: "error", status: 429, message: "Busy" });
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		const result = await AIError.finalize(error);
		expect(result.providerErrorCode).toBeUndefined();
		expect(Object.hasOwn(result, "providerErrorCode")).toBe(false);
		expect(AIError.retriable(result.id)).toBe(true);
	});

	it("retains an OpenAI response code exactly without changing classification", async () => {
		const captured = {
			status: 429,
			bodyJson: { error: { code: "Peak_Quota.Exceeded", type: "rate_limit_error", message: "Busy" } },
		};
		const error = new AIError.OpenAIHttpError("Busy", captured, "rate_limit_error");
		const result = await AIError.finalize(error);
		expect(result.providerErrorCode).toBe("Peak_Quota.Exceeded");
		expect(result.status).toBe(429);
		expect(result.stopReason).toBe("error");
		expect(result.id).toBe(AIError.classify(error));
	});

	it("recovers actual numeric Google payload codes from captured HTTP JSON", async () => {
		const result = await AIError.finalize(new AIError.GoogleApiError("Unavailable", 503), {
			capturedErrorResponse: {
				status: 503,
				bodyText: '{"error":{"code":12345,"status":"UNAVAILABLE","message":"Busy"}}',
			},
		});
		expect(result.providerErrorCode).toBe("12345");
		expect(result.status).toBe(503);
	});

	it("retains Anthropic nested codes and its machine type when no code exists", async () => {
		for (const [payload, expected] of [
			[{ error: { code: "peak_limit", type: "overloaded_error" } }, "peak_limit"],
			[{ error: { details: { error_code: "organization_peak" }, type: "overloaded_error" } }, "organization_peak"],
			[{ error: { type: "overloaded_error", message: "Busy" } }, "overloaded_error"],
		] as const) {
			const error = await AIError.AnthropicApiError.fromResponse(
				new Response(JSON.stringify(payload), { status: 529 }),
			);
			const result = await AIError.finalize(error);
			expect(result.providerErrorCode).toBe(expected);
			expect(AIError.retriable(result.id)).toBe(true);
		}
	});

	it("follows wrapper causes only to provider-owned structured provenance", async () => {
		const provider = new AIError.ProviderResponseError("Wire failure", {
			kind: "runtime",
			providerErrorCode: "no_capacity",
		});
		const result = await AIError.finalize(new Error("Wrapped", { cause: provider }));
		expect(result.providerErrorCode).toBe("no_capacity");
		expect(AIError.providerErrorCode(new Error("Wrapped", { cause: { code: "no_capacity" } }))).toBeUndefined();
	});

	it("never invents codes from status, prose, transport codes, or classification", async () => {
		for (const error of [
			new AIError.ProviderHttpError("HTTP 429 no_capacity", 429),
			Object.assign(new Error("provider code: no_capacity"), { code: "ECONNRESET", status: 503 }),
			Object.assign(new Error("Busy"), { error: { code: "no_capacity" } }),
			new AIError.ProviderResponseError("No capacity", { kind: "incomplete-stream" }),
		]) {
			const result = await AIError.finalize(error);
			expect(result.providerErrorCode).toBeUndefined();
			expect(Object.hasOwn(result, "providerErrorCode")).toBe(false);
		}
		for (const bodyText of ["no_capacity", '{"status":503,"message":"no_capacity"}', '{"error":"no_capacity"}']) {
			const result = await AIError.finalize(new Error("Busy"), {
				capturedErrorResponse: { status: 503, bodyText },
			});
			expect(result.providerErrorCode).toBeUndefined();
		}
	});

	it("lets caller abort dominate a captured provider failure and earlier local abort", async () => {
		const caller = new AbortController();
		const tracker = createAbortSourceTracker(caller.signal);
		tracker.abortLocally(new AIError.ProviderHttpError("Local watchdog", 503, { code: "local_reason" }));
		caller.abort(new Error("Caller stopped"));
		const error = new AIError.ProviderHttpError("Busy", 429, { code: "no_capacity" });
		for (const opts of [{ signal: caller.signal }, { abortTracker: tracker }]) {
			const result = await AIError.finalize(error, {
				...opts,
				capturedErrorResponse: { status: 429, bodyJson: { error: { code: "peak_limit" } } },
			});
			expect(result.stopReason).toBe("aborted");
			expect(Object.hasOwn(result, "providerErrorCode")).toBe(false);
		}
	});

	it("bounds cyclic causes and leaves missing codes unavailable", () => {
		const error = new Error("Wrapped");
		error.cause = error;
		expect(AIError.providerErrorCode(error)).toBeUndefined();
	});
});
