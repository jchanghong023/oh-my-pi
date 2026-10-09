import { CString, dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";
import { createConnection } from "node:net";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils";
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
				if (!advapi.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 0x0008, ptr(tokenOut)))
					return undefined;
				const token = read.ptr(ptr(tokenOut)) as Pointer;
				try {
					const length = new Uint32Array(1);
					advapi.symbols.GetTokenInformation(token, 1, null, 0, ptr(length));
					if (length[0] < 8 || length[0] > MAX_FRAME_BYTES) return undefined;
					const info = Buffer.alloc(length[0]);
					if (!advapi.symbols.GetTokenInformation(token, 1, ptr(info), info.length, ptr(length))) return undefined;
					const sidOut = Buffer.alloc(8);
					const sid = read.ptr(ptr(info)) as Pointer;
					if (!advapi.symbols.ConvertSidToStringSidA(sid, ptr(sidOut))) return undefined;
					const sidPointer = read.ptr(ptr(sidOut)) as Pointer;
					try {
						const session = new Uint32Array(1);
						if (!kernel.symbols.ProcessIdToSessionId(process.pid, ptr(session))) return undefined;
						return { sid: new CString(sidPointer).toString(), sessionId: session[0] };
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
	} catch {
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
	if (!isJchToolsDiscoveryEnabled(options)) return undefined;
	if (options.pipePath !== undefined) return options.pipePath;
	const identity = (options.identity ?? currentWindowsIdentity)();
	if (
		!identity ||
		!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(identity.sid) ||
		!Number.isInteger(identity.sessionId) ||
		identity.sessionId < 0 ||
		identity.sessionId > 0xffffffff
	)
		return undefined;
	const env = options.env ?? process.env;
	const testRuntime = options.testRuntime ?? (isBunTestRuntime() || env.PI_TEST_RUNTIME === "1");
	const suffix =
		testRuntime && env.JCHTOOLS_TEST_STATE_DIR
			? `-${new Bun.CryptoHasher("sha256").update(env.JCHTOOLS_TEST_STATE_DIR).digest("hex")}`
			: "";
	return `\\\\.\\pipe\\jchtools-acp-http-${identity.sid}-${identity.sessionId}${suffix}`;
}

/** A single read-only request with one bounded allocation after validating the length. */
export async function discoverJchTools(
	options: JchToolsDiscoveryOptions = {},
): Promise<JchToolsDescriptor | undefined> {
	const pipePath = getJchToolsPipePath(options);
	if (!pipePath || options.signal?.aborted) return undefined;
	const { promise, resolve } = Promise.withResolvers<JchToolsDescriptor | undefined>();
	const socket = createConnection({ path: pipePath });
	let settled = false;
	const finish = (value?: JchToolsDescriptor) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		socket.destroy();
		resolve(value);
	};
	const abort = () => finish();
	const timer = setTimeout(abort, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
	options.signal?.addEventListener("abort", abort, { once: true });
	const header = Buffer.alloc(4);
	let headerRead = 0;
	let body: Buffer | undefined;
	let bodyRead = 0;
	socket.once("connect", () => {
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
				finish();
				return;
			}
			body = Buffer.alloc(size);
		}
		if (!body) return;
		const count = Math.min(body.length - bodyRead, chunk.length - offset);
		chunk.copy(body, bodyRead, offset, offset + count);
		bodyRead += count;
		if (bodyRead !== body.length) return;
		if (offset + count !== chunk.length) {
			finish();
			return;
		}
		try {
			const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
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
				finish();
				return;
			}
			finish(validateJchToolsDescriptor(envelope.result.Ok));
		} catch {
			finish();
		}
	});
	socket.once("error", abort);
	socket.once("end", abort);
	socket.once("close", abort);
	if (options.signal?.aborted) abort();
	return promise;
}

export async function discoverJchToolsModels(options: JchToolsDiscoveryOptions = {}): Promise<Model<Api>[]> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	try {
		const descriptor = await discoverJchTools({ ...options, signal: controller.signal });
		if (!descriptor || descriptor.phase !== "ready" || !descriptor.base_url) return [];
		const response = await (options.fetch ?? fetch)(`${descriptor.base_url}/v1/models`, {
			signal: controller.signal,
			redirect: "error",
		});
		if (!response.ok || !response.body) return [];
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				length += value.length;
				if (length > MAX_FRAME_BYTES) {
					await reader.cancel();
					return [];
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const payload: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)),
		);
		if (!record(payload) || !Array.isArray(payload.data)) return [];
		const ids = new Set<string>();
		for (const row of payload.data) {
			if (
				!record(row) ||
				typeof row.id !== "string" ||
				row.id.length === 0 ||
				/[\u0000-\u001f\u007f-\u009f]/.test(row.id)
			)
				return [];
			ids.add(row.id);
		}
		// Build a neutral remote-Agent deployment, then preserve the raw backend ID.
		// Model-name lineage must never infer APIs, tools, reasoning or media here.
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
		return [...ids].map(id => ({ ...template, id, name: `${id} · 后端 Agent 执行 · 容量未知` }));
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
