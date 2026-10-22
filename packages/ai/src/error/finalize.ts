import type { Api } from "../types";
import type { AbortSourceTracker } from "../utils/abort";
import type { CapturedHttpErrorResponse, RawHttpRequestDump } from "../utils/http-inspector";
import { OpenAIHttpError, ProviderHttpError } from "./classes";
import { classify, classifyMessage, status } from "./flags";
import { formatMessage } from "./format";
import { ProviderResponseError } from "./provider";

/** Context a provider catch block hands to {@link finalize}. */
export interface FinalizeOptions {
	/** Wire API, for api-specific text classification (e.g. stale-responses items). */
	api?: Api;
	/** Provider id; forwarded to the message formatter for copilot rewrites. */
	provider?: string;
	/** Requested model id; paired with provider for model-entitlement classification. */
	model?: string;
	/** Caller signal, for providers that don't run an abort tracker. */
	signal?: AbortSignal;
	/** Abort tracker, preferred over `signal`: distinguishes caller vs. local aborts. */
	abortTracker?: AbortSourceTracker;
	/** Raw request, dumped into the message for 400-class failures. */
	rawRequestDump?: RawHttpRequestDump;
	/** Captured non-2xx response body, used for status fallback and message detail. */
	capturedErrorResponse?: CapturedHttpErrorResponse;
}

/** The full bundle a provider assigns onto its `AssistantMessage` error fields. */
export interface FinalizeResult {
	/** Structured flag id from {@link classify}. */
	id: number;
	/** HTTP status, from the error or the captured response. */
	status: number | undefined;
	/** Exact structured provider code, absent when unavailable or caller-aborted. */
	providerErrorCode?: string;
	/** `"aborted"` when the caller cancelled, otherwise `"error"`. */
	stopReason: "aborted" | "error";
	/** User-facing message from {@link formatMessage}, or a local abort reason. */
	message: string;
}

function structuredCode(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function capturedProviderCode(captured: CapturedHttpErrorResponse | undefined): string | undefined {
	if (!captured) return undefined;
	let body = captured.bodyJson;
	if (body === undefined && captured.bodyText) {
		try {
			body = JSON.parse(captured.bodyText);
		} catch {
			return undefined;
		}
	}
	if (!body || typeof body !== "object" || !("error" in body)) return undefined;
	const error = body.error;
	if (!error || typeof error !== "object") return undefined;
	const code = "code" in error ? structuredCode(error.code) : undefined;
	if (code !== undefined) return code;
	if ("details" in error && error.details && typeof error.details === "object") {
		const details = error.details;
		const detailCode = "error_code" in details ? structuredCode(details.error_code) : undefined;
		if (detailCode !== undefined) return detailCode;
	}
	// Anthropic exposes the machine error identifier as error.type.
	return "type" in error ? structuredCode(error.type) : undefined;
}

/**
 * Preserve codes only from provider-owned errors or a captured HTTP JSON body.
 * Generic Error.code values are transport diagnostics, not provider identifiers.
 */
export function providerErrorCode(error: unknown, capturedResponse?: CapturedHttpErrorResponse): string | undefined {
	const capturedCode = capturedProviderCode(capturedResponse);
	if (capturedCode !== undefined) return capturedCode;
	// Bound cause traversal, including cycles, without retaining an error graph.
	for (let depth = 0; depth < 16 && error instanceof Error; depth++) {
		if (error instanceof ProviderResponseError) {
			const code = structuredCode(error.providerErrorCode);
			if (code !== undefined) return code;
		}
		if (error instanceof ProviderHttpError) {
			const code =
				(error instanceof OpenAIHttpError ? capturedProviderCode(error.captured) : undefined) ??
				structuredCode(error.providerErrorCode);
			if (code !== undefined) return code;
		}
		error = error.cause;
	}
	return undefined;
}

/**
 * Build the complete error bundle for a provider catch block, replacing the
 * `stopReason` / `errorStatus` / `errorId` / `errorMessage` boilerplate.
 *
 * `stopReason` comes from the abort tracker (caller intent dominates) or, when
 * no tracker is supplied, the raw `signal.aborted`. A local abort reason (e.g. a
 * first-event timeout) supersedes the formatted message. Message formatting is
 * wrapped so a formatter throw can never skip the caller's `stream.end()`.
 */
export async function finalize(error: unknown, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
	const aborted = opts.abortTracker ? opts.abortTracker.wasCallerAbort() : opts.signal?.aborted === true;
	const errorStatus = status(error);
	const currentStatus = errorStatus ?? opts.capturedErrorResponse?.status;

	let message: string;
	try {
		const localReason = opts.abortTracker?.getLocalAbortReason();
		message = localReason?.message ?? (await formatMessage(error, opts));
	} catch {
		message = error instanceof Error ? error.message : String(error);
	}

	// A captured status is transport context for the original error. Put it at
	// the root of the classification cause chain so terminal 4xx policy governs
	// nested diagnostics before they can contribute transient flags.
	const classificationError =
		errorStatus === undefined && currentStatus !== undefined ? { status: currentStatus, cause: error } : error;

	const id = classifyMessage({
		api: opts.api,
		provider: opts.provider,
		model: opts.model,
		errorId: classify(classificationError, opts.api),
		errorMessage: message,
		errorStatus: currentStatus,
	});

	const code = aborted ? undefined : providerErrorCode(error, opts.capturedErrorResponse);

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		message,
		...(code === undefined ? {} : { providerErrorCode: code }),
	};
}
