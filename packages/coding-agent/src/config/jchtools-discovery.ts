import { CString, dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";
import { createConnection, type Socket } from "node:net";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import { JCHTOOLS_API, JCHTOOLS_PROVIDER_ID } from "./jchtools-provider";

const MAX_FRAME_BYTES = 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 1500;
const PHASES: Readonly<Record<string, true>> = {
	unconfigured: true,
	starting: true,
	ready: true,
	draining: true,
	stopping: true,
	stopped: true,
	error: true,
};

export interface JchToolsDescriptor {
	protocol_version: 1;
	service_id: "jchtools-acp-http";
	instance_id: string;
	phase: "unconfigured" | "starting" | "ready" | "draining" | "stopping" | "stopped" | "error";
	base_url: string | null;
	execution_mode: "server_agent";
	capabilities: { text: true; streaming: true; client_tools: false; server_tools: true };
}

export interface JchToolsDiscoveryOptions {
	/** Explicit transport seam for isolated IPC tests, never read from user configuration. */
	pipePath?: string;
	platform?: NodeJS.Platform;
	identity?: () => { sid: string; sessionId: number } | undefined;
	env?: NodeJS.ProcessEnv;
	testRuntime?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** The descriptor is a narrow trust boundary, not a general service-status payload. */
export function validateJchToolsDescriptor(value: unknown): JchToolsDescriptor | undefined {
	if (
		!record(value) ||
		!exactKeys(value, [
			"protocol_version",
			"service_id",
			"instance_id",
			"phase",
			"base_url",
			"execution_mode",
			"capabilities",
		])
	)
		return undefined;
	if (
		value.protocol_version !== 1 ||
		value.service_id !== "jchtools-acp-http" ||
		value.execution_mode !== "server_agent"
	)
		return undefined;
	if (
		typeof value.instance_id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.instance_id)
	)
		return undefined;
	if (typeof value.phase !== "string" || !Object.hasOwn(PHASES, value.phase)) return undefined;
	if (
		!record(value.capabilities) ||
		!exactKeys(value.capabilities, ["text", "streaming", "client_tools", "server_tools"])
	)
		return undefined;
	if (
		value.capabilities.text !== true ||
		value.capabilities.streaming !== true ||
		value.capabilities.client_tools !== false ||
		value.capabilities.server_tools !== true
	)
		return undefined;
	if (value.phase === "ready") {
		if (typeof value.base_url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.base_url))
			return undefined;
		const port = Number(value.base_url.slice(value.base_url.lastIndexOf(":") + 1));
		if (port > 65535) return undefined;
	} else if (value.base_url !== null) return undefined;
	return value as unknown as JchToolsDescriptor;
}

/** Uses the process token, not USERNAME, terminal variables or OMP's conversation ID. */
function currentWindowsIdentity(): { sid: string; sessionId: number } | undefined {
	if (process.platform !== "win32") return undefined;
	let stage = "load_libraries";
	const unavailable = () => {
		logger.warn("JchTools identity unavailable", {
			component: "jchtools",
			event: "jchtools_identity_unavailable",
			stage,
			result: "identity-unavailable",
		});
		return undefined;
	};
	try {
		const kernel = dlopen("kernel32.dll", {
			GetCurrentProcess: { args: [], returns: FFIType.ptr },
			ProcessIdToSessionId: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.bool },
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
			LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
		});
		try {
			const advapi = dlopen("advapi32.dll", {
				OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
				GetTokenInformation: {
					args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
					returns: FFIType.bool,
				},
				ConvertSidToStringSidA: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
			});
			try {
				const tokenOut = Buffer.alloc(8);
				stage = "open_process_token";
				if (!advapi.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 0x0008, ptr(tokenOut)))
					return unavailable();
				const token = read.ptr(ptr(tokenOut)) as Pointer;
				try {
					const length = new Uint32Array(1);
					advapi.symbols.GetTokenInformation(token, 1, null, 0, ptr(length));
					stage = "token_information_size";
					if (length[0] < 8 || length[0] > MAX_FRAME_BYTES) return unavailable();
					const info = Buffer.alloc(length[0]);
					stage = "token_information";
					if (!advapi.symbols.GetTokenInformation(token, 1, ptr(info), info.length, ptr(length)))
						return unavailable();
					const sidOut = Buffer.alloc(8);
					const sid = read.ptr(ptr(info)) as Pointer;
					stage = "convert_sid";
					if (!advapi.symbols.ConvertSidToStringSidA(sid, ptr(sidOut))) return unavailable();
					const sidPointer = read.ptr(ptr(sidOut)) as Pointer;
					try {
						const session = new Uint32Array(1);
						stage = "process_session";
						if (!kernel.symbols.ProcessIdToSessionId(process.pid, ptr(session))) return unavailable();
						const identity = { sid: new CString(sidPointer).toString(), sessionId: session[0] };
						logger.debug("JchTools identity resolved", {
							component: "jchtools",
							event: "jchtools_identity_resolved",
							stage,
							result: "success",
						});
						return identity;
					} finally {
						kernel.symbols.LocalFree(sidPointer);
					}
				} finally {
					kernel.symbols.CloseHandle(token);
				}
			} finally {
				advapi.close();
			}
		} finally {
			kernel.close();
		}
	} catch (error) {
		logger.warn("JchTools identity unavailable", {
			component: "jchtools",
			event: "jchtools_identity_unavailable",
			stage,
			result: "identity-unavailable",
			...logger.diagnosticError(error),
		});
		return undefined;
	}
}

export function isJchToolsDiscoveryEnabled(options: JchToolsDiscoveryOptions = {}): boolean {
	const env = options.env ?? process.env;
	if (env.OMP_JCHTOOLS_DISCOVERY === "0") return false;
	if (options.pipePath !== undefined) return true;
	if ((options.platform ?? process.platform) !== "win32") return false;
	const testRuntime = options.testRuntime ?? (isBunTestRuntime() || env.PI_TEST_RUNTIME === "1");
	return !testRuntime || !!env.JCHTOOLS_TEST_STATE_DIR;
}

export function getJchToolsPipePath(options: JchToolsDiscoveryOptions = {}): string | undefined {
	if (!isJchToolsDiscoveryEnabled(options)) {
		logger.debug("JchTools discovery disabled", {
			component: "jchtools",
			event: "jchtools_pipe_path",
			stage: "resolve_pipe",
			result: "disabled",
		});
		return undefined;
	}
	if (options.pipePath !== undefined) {
		logger.debug("JchTools pipe path resolved", {
			component: "jchtools",
			event: "jchtools_pipe_path",
			stage: "resolve_pipe",
			result: "success",
		});
		return options.pipePath;
	}
	let identity: { sid: string; sessionId: number } | undefined;
	try {
		identity = (options.identity ?? currentWindowsIdentity)();
	} catch (error) {
		logger.warn("JchTools identity unavailable", {
			component: "jchtools",
			event: "jchtools_pipe_path",
			stage: "resolve_identity",
			result: "identity-unavailable",
			...logger.diagnosticError(error),
		});
		throw error;
	}
	if (
		!identity ||
		!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(identity.sid) ||
		!Number.isInteger(identity.sessionId) ||
		identity.sessionId < 0 ||
		identity.sessionId > 0xffffffff
	) {
		logger.warn("JchTools identity unavailable", {
			component: "jchtools",
			event: "jchtools_pipe_path",
			stage: "validate_identity",
			result: "identity-unavailable",
		});
		return undefined;
	}
	const env = options.env ?? process.env;
	const testRuntime = options.testRuntime ?? (isBunTestRuntime() || env.PI_TEST_RUNTIME === "1");
	const suffix =
		testRuntime && env.JCHTOOLS_TEST_STATE_DIR
			? `-${new Bun.CryptoHasher("sha256").update(env.JCHTOOLS_TEST_STATE_DIR).digest("hex")}`
			: "";
	logger.debug("JchTools pipe path resolved", {
		component: "jchtools",
		event: "jchtools_pipe_path",
		stage: "resolve_pipe",
		result: "success",
	});
	return `\\\\.\\pipe\\jchtools-acp-http-${identity.sid}-${identity.sessionId}${suffix}`;
}

/** A single read-only request with one bounded allocation after validating the length. */
export async function discoverJchTools(
	options: JchToolsDiscoveryOptions = {},
): Promise<JchToolsDescriptor | undefined> {
	return logger.withLogContext(
		{
			operation_id: logger.getLogContext().operation_id ?? `jchtools-${crypto.randomUUID()}`,
			call_id: `discover-${crypto.randomUUID()}`,
			parent_call_id: logger.getLogContext().call_id,
		},
		async () => {
			const startedAt = performance.now();
			let stage = "resolve_pipe";
			logger.debug("JchTools discovery started", {
				component: "jchtools",
				event: "jchtools_discovery_started",
				stage,
				result: "started",
				timeout_ms: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
			});
			const terminal = (result: string, error?: unknown) => {
				const fields = {
					component: "jchtools",
					event: "jchtools_discovery_finished",
					stage,
					result,
					elapsed_ms: performance.now() - startedAt,
					...(error === undefined ? {} : logger.diagnosticError(error)),
				};
				if (result === "success") logger.info("JchTools discovery completed", fields);
				else if (["disabled", "identity-unavailable", "pipe-absent", "not-ready", "aborted"].includes(result))
					logger.debug("JchTools discovery unavailable", fields);
				else logger.warn("JchTools discovery failed", fields);
			};
			let pipePath: string | undefined;
			try {
				pipePath = getJchToolsPipePath(options);
			} catch (error) {
				terminal("identity-unavailable", error);
				throw error;
			}
			if (!pipePath || options.signal?.aborted) {
				terminal(
					options.signal?.aborted
						? "aborted"
						: isJchToolsDiscoveryEnabled(options)
							? "identity-unavailable"
							: "disabled",
				);
				return undefined;
			}
			const { promise, resolve } = Promise.withResolvers<JchToolsDescriptor | undefined>();
			stage = "ipc_connect";
			logger.info("JchTools IPC started", {
				component: "jchtools",
				event: "jchtools_ipc_started",
				stage,
				result: "started",
				method: "Discover",
				timeout_ms: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
			});
			let socket: Socket;
			try {
				socket = createConnection({ path: pipePath });
			} catch (error) {
				terminal("connect-failed", error);
				throw error;
			}
			let settled = false;
			const finish = (result: string, value?: JchToolsDescriptor, error?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				socket.destroy();
				terminal(result, error);
				resolve(value);
			};
			const abort = () => finish("aborted");
			const timer = setTimeout(() => finish("timeout"), options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
			options.signal?.addEventListener("abort", abort, { once: true });
			const header = Buffer.alloc(4);
			let headerRead = 0;
			let body: Buffer | undefined;
			let bodyRead = 0;
			socket.once("connect", () => {
				stage = "read_header";
				logger.info("JchTools IPC connected", {
					component: "jchtools",
					event: "jchtools_ipc_connected",
					stage,
					result: "connected",
					elapsed_ms: performance.now() - startedAt,
				});
				const payload = Buffer.from('"Discover"');
				const frame = Buffer.alloc(4 + payload.length);
				frame.writeUInt32LE(payload.length);
				payload.copy(frame, 4);
				socket.write(frame);
			});
			socket.on("data", (chunk: Buffer) => {
				let offset = 0;
				if (headerRead < 4) {
					const count = Math.min(4 - headerRead, chunk.length);
					chunk.copy(header, headerRead, 0, count);
					headerRead += count;
					offset = count;
					if (headerRead < 4) return;
					const size = header.readUInt32LE();
					if (size === 0 || size > MAX_FRAME_BYTES) {
						finish(size === 0 ? "descriptor-invalid" : "oversize");
						return;
					}
					stage = "read_frame";
					logger.debug("JchTools IPC frame started", {
						component: "jchtools",
						event: "jchtools_ipc_frame_started",
						stage,
						result: "started",
						size_bytes: size,
					});
					body = Buffer.alloc(size);
				}
				if (!body) return;
				const count = Math.min(body.length - bodyRead, chunk.length - offset);
				chunk.copy(body, bodyRead, offset, offset + count);
				bodyRead += count;
				if (bodyRead !== body.length) return;
				if (offset + count !== chunk.length) {
					finish("descriptor-invalid");
					return;
				}
				try {
					stage = "decode_utf8";
					const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
					stage = "decode_json";
					const envelope: unknown = JSON.parse(decoded);
					stage = "validate_descriptor";
					if (
						!record(envelope) ||
						!exactKeys(envelope, ["protocol", "pid", "result"]) ||
						envelope.protocol !== 1 ||
						typeof envelope.pid !== "number" ||
						!Number.isInteger(envelope.pid) ||
						envelope.pid < 1 ||
						envelope.pid > 0xffffffff ||
						!record(envelope.result) ||
						!exactKeys(envelope.result, ["Ok"])
					) {
						finish("descriptor-invalid");
						return;
					}
					const descriptor = validateJchToolsDescriptor(envelope.result.Ok);
					finish(
						!descriptor ? "descriptor-invalid" : descriptor.phase === "ready" ? "success" : "not-ready",
						descriptor,
					);
				} catch (error) {
					finish(
						stage === "decode_utf8" ? "UTF8" : stage === "decode_json" ? "JSON" : "descriptor-invalid",
						undefined,
						error,
					);
				}
			});
			socket.once("error", error => {
				const code = (error as NodeJS.ErrnoException).code;
				finish(
					stage === "ipc_connect" && (code === "ENOENT" || code === "ECONNREFUSED") ? "pipe-absent" : "ipc-failed",
					undefined,
					error,
				);
			});
			socket.once("end", () => finish("truncated"));
			socket.once("close", () => finish("truncated"));
			if (options.signal?.aborted) abort();
			return promise;
		},
	);
}

export async function discoverJchToolsModels(options: JchToolsDiscoveryOptions = {}): Promise<Model<Api>[]> {
	return logger.withLogContext(
		{
			operation_id: logger.getLogContext().operation_id ?? `jchtools-${crypto.randomUUID()}`,
			call_id: `models-${crypto.randomUUID()}`,
			parent_call_id: logger.getLogContext().call_id,
		},
		async () => {
			const startedAt = performance.now();
			let stage = "discovery";
			let result = "discovery-unavailable";
			let status: number | undefined;
			let modelCount = 0;
			let httpStartedAt: number | undefined;
			let diagnostic: Record<string, unknown> = {};
			const controller = new AbortController();
			const abort = () => controller.abort();
			const timer = setTimeout(abort, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			logger.debug("JchTools model discovery started", {
				component: "jchtools",
				event: "jchtools_models_started",
				stage,
				result: "started",
				timeout_ms: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
			});
			try {
				const descriptor = await discoverJchTools({ ...options, signal: controller.signal });
				if (!descriptor || descriptor.phase !== "ready" || !descriptor.base_url) {
					result = options.signal?.aborted
						? "aborted"
						: controller.signal.aborted
							? "timeout"
							: descriptor
								? "not-ready"
								: "discovery-unavailable";
					return [];
				}
				stage = "http_request";
				httpStartedAt = performance.now();
				logger.info("JchTools models HTTP started", {
					component: "jchtools",
					event: "jchtools_models_http_started",
					stage,
					result: "started",
					method: "GET",
					path: "/v1/models",
					host: "127.0.0.1",
					timeout_ms: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
				});
				const response = await (options.fetch ?? fetch)(`${descriptor.base_url}/v1/models`, {
					signal: controller.signal,
					redirect: "error",
				});
				status = response.status;
				logger.info("JchTools models HTTP response", {
					component: "jchtools",
					event: "jchtools_models_http_response",
					stage,
					result: response.ok ? "headers-received" : "http-non2xx",
					status,
					elapsed_ms: performance.now() - httpStartedAt,
				});
				if (!response.ok || !response.body) {
					result = !response.ok ? "http-non2xx" : "models-invalid-payload";
					return [];
				}
				stage = "read_body";
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let length = 0;
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						length += value.length;
						if (length > MAX_FRAME_BYTES) {
							result = "oversize";
							await reader.cancel();
							return [];
						}
						chunks.push(value);
					}
				} finally {
					reader.releaseLock();
				}
				stage = "decode_utf8";
				const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
				stage = "decode_json";
				const payload: unknown = JSON.parse(decoded);
				stage = "validate_models";
				if (!record(payload) || !Array.isArray(payload.data)) {
					result = "models-invalid-payload";
					return [];
				}
				const ids = new Set<string>();
				for (const row of payload.data) {
					if (
						!record(row) ||
						typeof row.id !== "string" ||
						row.id.length === 0 ||
						/[\u0000-\u001f\u007f-\u009f]/.test(row.id)
					) {
						result = "models-invalid-payload";
						return [];
					}
					ids.add(row.id);
				}
				// Build a neutral remote-Agent deployment, then preserve the raw backend ID.
				// Model-name lineage must never infer APIs, tools, reasoning or media here.
				stage = "build_models";
				const template = buildModel({
					id: "jchtools-remote-agent",
					name: "JchTools",
					api: JCHTOOLS_API,
					provider: JCHTOOLS_PROVIDER_ID,
					baseUrl: descriptor.base_url,
					reasoning: false,
					supportsTools: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					pricingStatus: "unknown",
					// The service does not publish capacities. Null is the catalog's unknown
					// sentinel, not a local transcript/output budget or a remote promise.
					contextWindow: null,
					maxTokens: null,
				});
				const models = [...ids].map(id => ({ ...template, id, name: `${id} · 后端 Agent 执行 · 容量未知` }));
				modelCount = models.length;
				result = "success";
				return models;
			} catch (error) {
				result = options.signal?.aborted
					? "aborted"
					: controller.signal.aborted
						? "timeout"
						: stage === "decode_utf8"
							? "UTF8"
							: stage === "decode_json"
								? "JSON"
								: stage === "read_body"
									? "truncated"
									: "failed";
				diagnostic = logger.diagnosticError(error);
				return [];
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				const fields = {
					component: "jchtools",
					event: "jchtools_models_finished",
					stage,
					result,
					status,
					model_count: modelCount,
					elapsed_ms: performance.now() - startedAt,
					...(httpStartedAt === undefined
						? {}
						: { method: "GET", path: "/v1/models", http_elapsed_ms: performance.now() - httpStartedAt }),
					...diagnostic,
				};
				if (result === "success") logger.info("JchTools models completed", fields);
				else if (["discovery-unavailable", "not-ready", "aborted"].includes(result))
					logger.debug("JchTools models unavailable", fields);
				else logger.warn("JchTools models failed", fields);
			}
		},
	);
}
