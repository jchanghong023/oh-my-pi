import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { $flag, logger } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";

const gzip = promisify(zlib.gzip);

/**
 * Bodies below one TCP segment gain nothing from compression; skip them.
 */
const MIN_GZIP_BODY_BYTES = 1024;

/**
 * zlib's default level. On multi-MB transcripts it shrinks bodies ~35% more
 * than level 1 for ~2x the CPU — a few ms per MB, which any uplink under
 * ~1 Gbps more than repays.
 */
const GZIP_LEVEL = 6;

/** Error codes/messages the Messages API returns when it cannot decode the body. */
const ENCODING_REJECTION = /request_body_encoding_invalid|Unsupported Content-Encoding/;

/**
 * Process-wide latch: once the API rejects a gzip body, stop compressing so
 * every later request does not pay a doubled upload.
 */
let gzipRejected = false;

type RequestHeaders = RequestInit["headers"];

function requestUrl(input: string | URL | Request): string | undefined {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return undefined;
}

function hasContentEncoding(headers: RequestHeaders): boolean {
	if (!headers) return false;
	if (headers instanceof Headers) return headers.has("content-encoding");
	if (Array.isArray(headers)) return headers.some(([name]) => name.toLowerCase() === "content-encoding");
	for (const name in headers) {
		if (name.toLowerCase() === "content-encoding") return true;
	}
	return false;
}

/** Adds `Content-Encoding: gzip`, preserving the caller's header container and casing. */
function withGzipEncoding(headers: RequestHeaders): RequestHeaders {
	if (headers instanceof Headers) {
		const copy = new Headers(headers);
		copy.set("Content-Encoding", "gzip");
		return copy;
	}
	if (Array.isArray(headers)) return [...headers, ["Content-Encoding", "gzip"]];
	return { ...headers, "Content-Encoding": "gzip" };
}

async function isEncodingRejection(response: Response): Promise<boolean> {
	if (response.status !== 400 && response.status !== 415) return false;
	try {
		return ENCODING_REJECTION.test(await response.clone().text());
	} catch {
		return false;
	}
}

/**
 * Gzips request bodies sent to the official Anthropic API, which accepts
 * `Content-Encoding: gzip` (and only gzip — zstd/br are rejected with 400).
 * Long sessions resend multi-MB transcripts every turn, so upload time
 * dominates time-to-first-token on ordinary uplinks.
 *
 * Install it beneath any body rewriter (e.g. the cch attestation patch): the
 * rewriter must see, and hash, the uncompressed bytes. Non-official hosts,
 * small bodies, and `PI_ANTHROPIC_GZIP=0` pass through untouched. If the API
 * rejects the encoding, the request is resent uncompressed once and gzip stays
 * off for the rest of the process.
 */
export function wrapFetchForAnthropicGzip(base: FetchImpl): FetchImpl {
	const wrapped: FetchImpl = async (input, init) => {
		const body = init?.body;
		const url = requestUrl(input);
		if (
			gzipRejected ||
			url === undefined ||
			!(typeof body === "string" || ArrayBuffer.isView(body)) ||
			// UTF-16 length undercounts UTF-8 bytes — fine for a size floor.
			(typeof body === "string" ? body.length : body.byteLength) < MIN_GZIP_BODY_BYTES ||
			hasContentEncoding(init?.headers) ||
			!isOfficialAnthropicApiUrl(url) ||
			!$flag("PI_ANTHROPIC_GZIP", true)
		) {
			return base(input, init);
		}

		let compressed: Uint8Array;
		try {
			// Off the event loop: `gzipSync` stalls the TUI ~120ms on a 9MB body.
			compressed = await gzip(body, { level: GZIP_LEVEL });
		} catch (error) {
			logger.debug("anthropic: request gzip failed; sending uncompressed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return base(input, init);
		}

		const response = await base(input, { ...init, body: compressed, headers: withGzipEncoding(init?.headers) });
		if (!(await isEncodingRejection(response))) return response;

		gzipRejected = true;
		logger.warn("anthropic: API rejected gzip request body; disabling request compression", {
			status: response.status,
		});
		await response.body?.cancel().catch(() => {});
		return base(input, init);
	};
	if (base.preconnect) wrapped.preconnect = base.preconnect;
	return wrapped;
}

/** Test hook: clears the process-wide rejection latch. */
export function resetAnthropicGzipRejectionForTesting(): void {
	gzipRejected = false;
}
