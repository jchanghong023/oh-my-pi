import { afterEach, describe, expect, it } from "bun:test";
import {
	resetAnthropicGzipRejectionForTesting,
	wrapFetchForAnthropicGzip,
} from "@oh-my-pi/pi-ai/providers/anthropic-gzip";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const OFFICIAL_URL = "https://api.anthropic.com/v1/messages?beta=true";
const LARGE_BODY = JSON.stringify({ messages: [{ role: "user", content: "hello world ".repeat(500) }] });

interface Captured {
	body: RequestInit["body"];
	headers: Record<string, string>;
}

function captureFetch(responses: Response[]): { calls: Captured[]; fetch: FetchImpl } {
	const calls: Captured[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		calls.push({ body: init?.body, headers: init?.headers as Record<string, string> });
		return responses.shift() ?? new Response("{}", { status: 200 });
	};
	return { calls, fetch };
}

const post = (headers: Record<string, string> = { "Content-Type": "application/json" }) => ({
	method: "POST",
	headers,
	body: LARGE_BODY,
});

const encodingRejection = () =>
	new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Request body is not valid gzip.",
				details: { error_code: "request_body_encoding_invalid" },
			},
		}),
		{ status: 400 },
	);

afterEach(() => resetAnthropicGzipRejectionForTesting());

describe("wrapFetchForAnthropicGzip", () => {
	it("gzips large bodies to the official API without disturbing other headers", async () => {
		const { calls, fetch } = captureFetch([]);
		await wrapFetchForAnthropicGzip(fetch)(OFFICIAL_URL, post());

		expect(calls[0].headers).toEqual({ "Content-Type": "application/json", "Content-Encoding": "gzip" });
		expect(new TextDecoder().decode(Bun.gunzipSync(calls[0].body as Uint8Array<ArrayBuffer>))).toBe(LARGE_BODY);
	});

	it("leaves proxies and tiny bodies uncompressed", async () => {
		const { calls, fetch } = captureFetch([]);
		const wrapped = wrapFetchForAnthropicGzip(fetch);
		await wrapped("https://gateway.example/anthropic/v1/messages", post());
		await wrapped(OFFICIAL_URL, { method: "POST", body: '{"model":"x"}' });

		expect(calls.map(call => call.body)).toEqual([LARGE_BODY, '{"model":"x"}']);
		expect(calls[0].headers).toEqual({ "Content-Type": "application/json" });
	});

	it("resends uncompressed after an encoding rejection and stops compressing", async () => {
		const { calls, fetch } = captureFetch([encodingRejection()]);
		const wrapped = wrapFetchForAnthropicGzip(fetch);

		const response = await wrapped(OFFICIAL_URL, post());
		await wrapped(OFFICIAL_URL, post());

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(3);
		expect(calls[0].headers["Content-Encoding"]).toBe("gzip");
		expect(calls.slice(1).map(call => [call.body, call.headers["Content-Encoding"]])).toEqual([
			[LARGE_BODY, undefined],
			[LARGE_BODY, undefined],
		]);
	});

	it("surfaces unrelated 400s once, with the error body still readable", async () => {
		const error = '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}';
		const { calls, fetch } = captureFetch([new Response(error, { status: 400 })]);

		const response = await wrapFetchForAnthropicGzip(fetch)(OFFICIAL_URL, post());

		expect(calls).toHaveLength(1);
		expect(await response.text()).toBe(error);
	});
});
