/**
 * Provider-controlled error bodies and custom model/provider identifiers must
 * not leak into diagnostic files. Status and safe failure classification stay
 * available; successful turns do not produce an error event.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { logProviderTurnError } from "../../src/session/messages";

function makeMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor",
		provider: "cursor",
		model: "composer-2.5",
		usage: {} as AssistantMessage["usage"],
		stopReason: "error",
		timestamp: 1,
		...overrides,
	};
}

describe("logProviderTurnError", () => {
	const events: logger.LogEvent[] = [];
	const dispose = logger.registerLogSink(event => events.push(event));

	afterEach(() => {
		events.length = 0;
	});
	afterAll(() => dispose());

	it("retains HTTP failure evidence without exposing provider-controlled content", () => {
		const secret = "PRIVATEPROVIDERERROR";
		logProviderTurnError(
			makeMessage({
				provider: `${secret}CUSTOMPROVIDER`,
				model: `${secret}CUSTOMMODEL`,
				errorMessage: `${secret}BODY /private/project Authorization: Bearer ${secret}TOKEN`,
				errorStatus: 500,
				errorId: 42,
			}),
		);

		const warn = events.find(e => e.level === "warn" && e.context?.event === "provider_turn_failed");
		expect(warn?.context).toMatchObject({
			stage: "assistant_turn",
			result: "failed",
			error_kind: "http_error",
			errorStatus: 500,
			errorId: 42,
			error_message_present: true,
		});
		expect(warn?.context?.provider_hash).toMatch(/^[a-f0-9]{12}$/);
		expect(warn?.context?.model_hash).toMatch(/^[a-f0-9]{12}$/);
		expect(warn?.context?.error_fingerprint).toMatch(/^[a-f0-9]{12}$/);
		expect(JSON.stringify(warn)).not.toContain(secret);
		expect(JSON.stringify(warn)).not.toContain("/private/project");
	});

	it("distinguishes stream stalls without publishing their raw error text", () => {
		logProviderTurnError(makeMessage({ errorMessage: "stream stall: idle watchdog fired PRIVATESTALL" }));
		expect(events.find(e => e.context?.event === "provider_turn_failed")?.context?.error_kind).toBe("stream_stall");
		expect(JSON.stringify(events)).not.toContain("PRIVATESTALL");
	});

	it("does not emit for a successful stop", () => {
		logProviderTurnError(makeMessage({ stopReason: "stop", errorMessage: undefined }));
		expect(events.some(e => e.message === "agent turn ended with provider error")).toBe(false);
	});
});
