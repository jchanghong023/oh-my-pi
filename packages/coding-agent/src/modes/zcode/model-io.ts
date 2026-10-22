import * as fs from "node:fs/promises";
import type { Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ArtifactManager } from "../../session/artifacts";
import { assertOfflineSessionPath } from "../../session/session-storage";

export interface ZCodeModelIoRetentionOptions {
	sessionId: string;
	/** The original session owner supplies its artifact manager, including offline-root policy. */
	artifacts: () => ArtifactManager | null;
	/** Diagnostic failure only: original ZCode capture never interrupts model execution. */
	onError: (error: Error) => void;
}

interface RequestGeneration {
	generation: number;
	enabled: boolean;
	signal?: AbortSignal;
	responseCaptured?: boolean;
}

// Full retention does not rotate or truncate committed records. Only pending memory is bounded.
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_RECORDS = 128;
const SECRET_KEY =
	/^(?:headers|requestHeaders|responseHeaders|auth|authorization|proxyAuthorization|x[-_]?api[-_]?key|api[-_]?key|coding[-_]?plan[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|secret|client[-_]?secret|cookie|set[-_]?cookie|credential[s]?|ticket|signature)$/i;

function sanitize(value: unknown, seen = new WeakSet<object>(), media = false): unknown {
	if (typeof value === "string") {
		return value
			.replace(/data:(?:image|video)\/[^\s"']+/gi, "[media omitted]")
			.replace(/https?:\/\/[^\s<>"']+/gi, "[URL omitted]")
			.replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [redacted]");
	}
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map(item => sanitize(item, seen, media));
		const object = value as Record<string, unknown>;
		const mediaType = object.mimeType ?? object.mediaType ?? object.media_type ?? object.type;
		const isMedia = media || (typeof mediaType === "string" && /^(?:image|video)(?:\/|$)/i.test(mediaType));
		const result = Object.create(null) as Record<string, unknown>;
		for (const [key, child] of Object.entries(object)) {
			if (SECRET_KEY.test(key)) {
				result[key] = "[redacted]";
				continue;
			}
			if (
				(isMedia && /^(?:data|image|video|url|dataUrl|bytes|base64|b64_json)$/i.test(key)) ||
				child instanceof Uint8Array
			) {
				result[key] = "[media omitted]";
				continue;
			}
			result[key] = sanitize(child, seen, isMedia);
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function modelKey(model?: { provider?: unknown; id?: unknown; model?: unknown }): string {
	return JSON.stringify([model?.provider ?? null, model?.id ?? model?.model ?? null]);
}

/** Explicit Host opt-in capture; never creates a second session store or telemetry authority. */
export class ZCodeModelIoRetention {
	readonly #options: ZCodeModelIoRetentionOptions;
	readonly #signals = new WeakMap<AbortSignal, RequestGeneration>();
	readonly #requests = new Map<string, RequestGeneration>();
	#lastRequest: RequestGeneration | undefined;
	#enabled = false;
	#closed = false;
	#generation = 0;
	#pendingBytes = 0;
	#pendingRecords = 0;
	#tail: Promise<void> = Promise.resolve();
	#path: string | undefined;
	#error: Error | undefined;

	constructor(options: ZCodeModelIoRetentionOptions) {
		this.#options = options;
	}

	setEnabled(enabled: boolean): void {
		if (this.#closed || enabled === this.#enabled) return;
		this.#enabled = enabled;
		this.#generation++;
	}

	readonly onPayload: NonNullable<SimpleStreamOptions["onPayload"]> = async (payload, model, signal) => {
		if (this.#closed) return;
		const request: RequestGeneration = { generation: this.#generation, enabled: this.#enabled, signal };
		this.#lastRequest = request;
		this.#requests.set(modelKey(model), request);
		if (signal) this.#signals.set(signal, request);
		await this.#capture(request, {
			type: "provider_payload",
			model: model ? { provider: model.provider, id: model.id, api: model.api } : undefined,
			payload,
		});
		// Observation only. Returning a record here would replace the actual provider payload.
	};

	readonly onResponse: NonNullable<SimpleStreamOptions["onResponse"]> = async (response, model, signal) => {
		const request = signal ? this.#signals.get(signal) : (this.#requests.get(modelKey(model)) ?? this.#lastRequest);
		// Never retain HTTP headers, endpoint URLs, credentials or response debug dumps.
		await this.#capture(request, {
			type: "provider_response",
			model: model ? { provider: model.provider, id: model.id, api: model.api } : undefined,
			status: response.status,
		});
	};

	onModelResponse(message: unknown, model?: Model, signal?: AbortSignal): void {
		if (!message || typeof message !== "object") return;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") return;
		const key = modelKey(model ?? record);
		const request = signal ? this.#signals.get(signal) : (this.#requests.get(key) ?? this.#requests.get(modelKey()));
		if (!this.#valid(request) || request.responseCaptured) return;
		request.responseCaptured = true;
		// A terminal response accepted before cancellation is completed IO. Closing the
		// session may abort its request signal while these already accepted writes drain.
		void this.#capture(request, { type: "model_response", message });
		for (const [requestKey, current] of this.#requests) {
			if (current === request) this.#requests.delete(requestKey);
		}
	}

	onSessionEvent(event: { type: string; message?: unknown }): void {
		if (this.#closed || event.type !== "message_end") return;
		this.onModelResponse(event.message);
	}
	async flush(): Promise<void> {
		await this.#tail;
		if (this.#error) throw this.#error;
	}

	async close(): Promise<void> {
		// Stop admission immediately, but drain already accepted records before releasing ownership.
		this.#closed = true;
		this.#requests.clear();
		this.#lastRequest = undefined;
		await this.flush();
	}

	#valid(request: RequestGeneration | undefined): request is RequestGeneration {
		return (
			request !== undefined &&
			request.enabled &&
			request.generation === this.#generation &&
			(request.responseCaptured === true || !request.signal?.aborted)
		);
	}

	#fail(cause: unknown): void {
		if (this.#error) return;
		// Provider payloads and arbitrary IO errors must not leak into protocol diagnostics.
		const code =
			cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
				? cause.code
				: undefined;
		this.#error = new Error(`Model IO retention failed${code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ""}`);
		try {
			this.#options.onError(this.#error);
		} catch {
			/* Diagnostic consumers cannot fail model execution. */
		}
	}

	async #capture(request: RequestGeneration | undefined, record: Record<string, unknown>): Promise<void> {
		if (this.#closed || this.#error || !this.#valid(request)) return;
		let line: string;
		try {
			line = `${JSON.stringify({ sessionId: this.#options.sessionId, timestamp: Date.now(), ...(sanitize(record) as Record<string, unknown>) })}\n`;
		} catch (error) {
			this.#fail(error);
			return;
		}
		const bytes = Buffer.byteLength(line);
		if (bytes + this.#pendingBytes > MAX_PENDING_BYTES || this.#pendingRecords >= MAX_PENDING_RECORDS) {
			this.#fail(new Error("Pending model IO retention capacity exceeded"));
			return;
		}
		this.#pendingBytes += bytes;
		this.#pendingRecords++;
		const write = this.#tail.then(async () => {
			if (!this.#valid(request) || this.#error) return;
			if (!this.#path) {
				const artifacts = this.#options.artifacts();
				if (!artifacts) throw new Error("Session has no persistent artifact owner");
				const allocated = await artifacts.allocatePath("model-io");
				this.#path = allocated.path;
			}
			if (!this.#valid(request)) return;
			assertOfflineSessionPath(this.#path);
			await fs.appendFile(this.#path, line, { encoding: "utf8", mode: 0o600 });
		});
		this.#tail = write
			.catch(error => this.#fail(error))
			.finally(() => {
				this.#pendingBytes -= bytes;
				this.#pendingRecords--;
			});
		await this.#tail;
	}
}
