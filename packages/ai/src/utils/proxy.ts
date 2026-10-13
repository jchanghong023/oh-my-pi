import * as net from "node:net";
import * as tls from "node:tls";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { AbortError } from "../error/abort";
import { StreamTimeoutError, ValidationError } from "../error/validation";
import type { FetchImpl } from "../types";

/**
 * Host:port of a proxy URL for logging. Proxy URLs can carry basic-auth
 * credentials, so never log the raw value.
 */
function proxyLogTarget(proxyUrl: string): string {
	try {
		return new URL(proxyUrl).host;
	} catch {
		return "<unparseable>";
	}
}

/**
 * Checks if a host is local or cloud metadata, which should always bypass the proxy
 * (e.g. localhost, 127/8, ::1, 169.254.169.254, metadata.google.internal).
 */
export function isLocalOrMetadataHost(host: string): boolean {
	const lowerHost = host.toLowerCase();

	// Hostnames: localhost and the cloud metadata service.
	if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost === "metadata.google.internal") {
		return true;
	}

	// Strip IPv6 brackets before numeric checks.
	const ip = lowerHost.replace(/^\[|\]$/g, "");

	// IPv4 loopback (127/8), unspecified (0/8), RFC1918 private (10/8, 172.16/12,
	// 192.168/16) and link-local (169.254/16 — covers IMDS 169.254.169.254 and
	// ECS credentials 169.254.170.2). None are reachable through a remote egress
	// proxy, and credential/metadata probes must never leak to one.
	const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 127 || a === 10 || a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		return false;
	}

	// IPv6 loopback (::1), unspecified (::), link-local (fe80::/10) and
	// unique-local (fc00::/7 — covers EC2 IPv6 IMDS fd00:ec2::254).
	if (ip === "::1" || ip === "::") return true;
	if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
	if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;

	return false;
}

/**
 * Check if the url should bypass the proxy due to hard-coded localhost/metadata checks
 * or custom NO_PROXY/no_proxy environment variables rules.
 */
export function shouldBypassProxy(urlObj: URL): boolean {
	if (isLocalOrMetadataHost(urlObj.hostname)) {
		return true;
	}

	const noProxyVal = Bun.env.NO_PROXY || Bun.env.no_proxy;
	if (!noProxyVal) {
		return false;
	}

	const rules = noProxyVal
		.split(/[,\s]+/)
		.map(r => r.trim())
		.filter(Boolean);
	const targetHost = urlObj.hostname.toLowerCase();
	const targetPort = urlObj.port || (urlObj.protocol === "https:" || urlObj.protocol === "wss:" ? "443" : "80");

	for (const rule of rules) {
		if (rule === "*") {
			return true;
		}

		let ruleHost = rule.toLowerCase();
		let rulePort: string | undefined;

		if (ruleHost.includes("]:")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		} else if (!ruleHost.includes("]") && ruleHost.includes(":")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		}

		// Strip IPv6 brackets
		ruleHost = ruleHost.replace(/^\[|\]$/g, "");

		if (rulePort && rulePort !== targetPort) {
			continue;
		}

		// Match host part
		if (ruleHost.startsWith(".")) {
			const suffix = ruleHost;
			const cleanRule = ruleHost.slice(1);
			if (targetHost === cleanRule || targetHost.endsWith(suffix)) {
				return true;
			}
		} else {
			if (targetHost === ruleHost || targetHost.endsWith(`.${ruleHost}`)) {
				return true;
			}
		}
	}

	return false;
}

const proxyCache = new Map<string, string | undefined>();

/** Test seam: clears the provider proxy cache. */
export function __resetProxyCache(): void {
	proxyCache.clear();
}

/**
 * Normalizes provider id (e.g. github-copilot -> PI_PROXY_GITHUB_COPILOT) and looks it up.
 * If not found, falls back to PI_PROXY. Results are memoized because env values are static
 * for the lifetime of the process and this function is called for every outgoing request.
 */
export function getProxyForProvider(provider: string): string | undefined {
	if (proxyCache.has(provider)) {
		return proxyCache.get(provider);
	}

	const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const envKey = `PI_PROXY_${normalized}`;
	const value = Bun.env[envKey] || Bun.env.PI_PROXY;
	proxyCache.set(provider, value);
	// Once per provider per process: a silently unproxied provider request is
	// otherwise indistinguishable from a proxied one until the region block
	// answers 403.
	logger.debug("provider proxy resolved", {
		provider,
		source: Bun.env[envKey] ? envKey : value ? "PI_PROXY" : "none",
		proxy: value ? proxyLogTarget(value) : undefined,
	});
	return value;
}

/** Resolves provider-specific and standard proxy variables for a target URL, honoring NO_PROXY. */
export function getProxyForUrl(provider: string, url: URL): string | undefined {
	if (shouldBypassProxy(url)) return undefined;
	const protocolProxy =
		url.protocol === "https:" || url.protocol === "wss:"
			? Bun.env.HTTPS_PROXY || Bun.env.https_proxy
			: Bun.env.HTTP_PROXY || Bun.env.http_proxy;
	return getProxyForProvider(provider) || protocolProxy || Bun.env.ALL_PROXY || Bun.env.all_proxy || undefined;
}

/**
 * Return `init` with `proxy: proxyUrl` set when the request should tunnel.
 * A caller-supplied `init.proxy` always wins (the innermost, most specific
 * decision); Unix sockets, local/metadata hosts, NO_PROXY matches, and
 * unparseable URLs pass through unchanged.
 */
export function withProxyInit(
	input: string | URL | Request,
	init: RequestInit | undefined,
	proxyUrl: string,
): RequestInit | undefined {
	if (init && (("unix" in init && init.unix) || ("proxy" in init && init.proxy))) return init;
	const urlStr = input instanceof Request ? input.url : input.toString();
	let urlObj: URL;
	try {
		urlObj = new URL(urlStr);
	} catch {
		return init;
	}

	if (shouldBypassProxy(urlObj)) {
		// A NO_PROXY rule silencing a configured proxy is otherwise invisible
		// until the unproxied egress is refused; local hosts are routine.
		if (!isLocalOrMetadataHost(urlObj.hostname)) {
			logger.debug("proxy bypassed by NO_PROXY", {
				host: urlObj.host,
				noProxy: Bun.env.NO_PROXY || Bun.env.no_proxy,
			});
		}
		return init;
	}

	const proxied: RequestInit & { proxy: string } = { ...init, proxy: proxyUrl };
	return proxied;
}

/** Wraps `fetchImpl` so non-local requests tunnel through `proxyUrl`; see {@link withProxyInit}. */
function wrapFetchWithProxyUrl(fetchImpl: FetchImpl, proxyUrl: string | undefined): FetchImpl {
	if (!proxyUrl) {
		return fetchImpl;
	}

	const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
		fetchImpl(input, withProxyInit(input, init, proxyUrl));

	if (fetchImpl.preconnect) {
		wrapped.preconnect = fetchImpl.preconnect;
	}
	return wrapped;
}

/**
 * Wraps a fetch implementation to inject proxy options for non-local hosts.
 */
export function wrapFetchForProxy(fetchImpl: FetchImpl, provider: string): FetchImpl {
	return wrapFetchWithProxyUrl(fetchImpl, getProxyForProvider(provider));
}

/**
 * Registry key holding the per-user Windows system proxy (WinInet "Internet
 * Settings"): the static proxy Windows apps pick up from Settings → Network &
 * Internet → Proxy. PAC (`AutoConfigURL`) and WPAD are not honored.
 */
const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** Static per-user Windows system proxy, normalized to proxy URLs Bun can drive. */
export interface WindowsSystemProxy {
	/** Proxy URL for `http:`/`ws:` targets, when configured. */
	http?: string;
	/** Proxy URL for `https:`/`wss:` targets, when configured. */
	https?: string;
}

function normalizeProxyUrl(hostPort: string): string {
	const trimmed = hostPort.trim();
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * Parse `reg query` output for the Internet Settings key into a system proxy.
 * `ProxyEnable` must be nonzero; `ProxyServer` is either a bare `host:port`
 * applying to every protocol or a `http=h:p;https=h:p;…` per-protocol list,
 * where only the http/https entries map to proxies Bun's fetch can drive —
 * `socks=` entries are dropped, not silently applied to the wrong protocol.
 */
export function parseInternetSettingsProxy(regQueryOutput: string): WindowsSystemProxy | undefined {
	let enabled = false;
	let server: string | undefined;
	for (const line of regQueryOutput.split(/\r?\n/)) {
		const match = line.match(/^\s*(ProxyEnable|ProxyServer)\s+REG_(DWORD|SZ)\s+(.+?)\s*$/i);
		if (!match) continue;
		if (match[1].toLowerCase() === "proxyenable") {
			const raw = match[3];
			enabled = Number.parseInt(raw, raw.toLowerCase().startsWith("0x") ? 16 : 10) !== 0;
		} else {
			server = match[3];
		}
	}
	if (!enabled || !server) return undefined;
	if (!server.includes("=")) {
		return { http: normalizeProxyUrl(server), https: normalizeProxyUrl(server) };
	}
	const proxy: WindowsSystemProxy = {};
	for (const entry of server.split(";")) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const protocol = entry.slice(0, eq).trim().toLowerCase();
		const target = entry.slice(eq + 1).trim();
		if (!target) continue;
		if (protocol === "http") proxy.http = normalizeProxyUrl(target);
		else if (protocol === "https") proxy.https = normalizeProxyUrl(target);
	}
	return proxy.http || proxy.https ? proxy : undefined;
}

// `null` marks "not resolved yet"; `undefined` caches a resolved "no system proxy".
let windowsSystemProxyCache: WindowsSystemProxy | undefined | null = null;
let windowsSystemProxyReaderOverride: (() => WindowsSystemProxy | undefined) | undefined;

/** Test seam: replaces the registry reader and clears its cache. */
export function __setWindowsSystemProxyReader(reader: (() => WindowsSystemProxy | undefined) | undefined): void {
	windowsSystemProxyReaderOverride = reader;
	windowsSystemProxyCache = null;
}

/** Test seam: restores the real registry reader and clears its cache. */
export function __resetWindowsSystemProxy(): void {
	__setWindowsSystemProxyReader(undefined);
}

/**
 * Resolve the per-user Windows system proxy once per process. Non-Windows
 * processes and any registry read failure resolve to `undefined`, leaving
 * every request on its default route.
 */
function readWindowsSystemProxy(): WindowsSystemProxy | undefined {
	if (windowsSystemProxyReaderOverride) return windowsSystemProxyReaderOverride();
	if (process.platform !== "win32") return undefined;
	if (windowsSystemProxyCache !== null) return windowsSystemProxyCache;
	let proxy: WindowsSystemProxy | undefined;
	try {
		const result = Bun.spawnSync(["reg.exe", "query", INTERNET_SETTINGS_KEY], {
			stdout: "pipe",
			stderr: "ignore",
		});
		proxy = result.exitCode === 0 ? parseInternetSettingsProxy(result.stdout.toString()) : undefined;
	} catch (error) {
		logger.debug("windows system proxy read failed", { error: String(error) });
	}
	windowsSystemProxyCache = proxy;
	return proxy;
}

/**
 * Fork intranet bypass for the Windows system-proxy tier only, transcribed
 * from the corporate proxy-override list: company domains and CGNAT-style
 * ranges stay direct even when the per-user system proxy is enabled, because
 * the intranet is not reachable through the egress proxy. This list does NOT
 * gate `PI_PROXY` or env-var proxies — `NO_PROXY` stays their mechanism.
 *
 * Entry semantics, mirroring the source list's shape:
 * - leading `-` is the source format's exclusion marker and is stripped;
 * - an entry starting with a digit is an IP-literal prefix (`10.`, `100.120.`,
 *   `100.10`): the hostname must start with it;
 * - an entry containing `*` is a glob over the whole hostname (`100.7*`,
 *   `wo-dr*.dbankcloud.ru`);
 * - an entry both starting and ending with `.` (`.hisilicon.`) matches any
 *   hostname containing that dotted label;
 * - a leading dot alone is a domain suffix (`.huawei.com`);
 * - anything else is an exact host or a dot-suffix of it.
 */
const FORK_SYSTEM_PROXY_BYPASS = [
	// Company domain suffixes and specific intranet hosts.
	"dev.huaweicloud.com",
	"dev.myhuaweicloud.com",
	".ai.smartcitysz.com",
	".athuawei.com",
	".hic.cloud",
	".hisilicon.",
	".hisilicon.cn",
	".huawei.cn",
	".huawei.com",
	".huaweimarine.com",
	".huaweimossel.",
	".huaweistatic.cn",
	".huaweistatic.com",
	".hw3static.cn",
	".hw3static.com",
	".hwht.",
	".hwtelcloud.com",
	".hwtrip.",
	".inhuawei.com",
	".pinjiantrip.com",
	".yinwang.com",
	".yw-beta.com",
	".yw-partners.com",
	"acm.chaspark.com",
	"cn-north-5-console.huaweicloud.com",
	"cn-north-5.myhuaweicloud.com",
	"cn-north-6.myhuaweicloud.com",
	"heds.huaweigsc.com",
	"irad.huaweigsc.com",
	"paper.chaspark.com",
	"papers.chaspark.com",
	"tool.chaspark.net",
	"csbjupyter.siye.console-his.huaweicloud.com",
	"his.chaspark.com",
	"models.ascend.huawei.com",
	"wo-dr.dbankcloud.cn",
	// IP-literal prefixes: Huawei CGNAT/RFC1918-style internal ranges.
	"7.",
	"10.",
	"100.10",
	"100.11",
	"100.120.",
	"100.121.",
	"100.122.",
	"100.123.",
	"100.124.",
	"100.125.",
	"100.126.",
	"100.64.",
	"100.65.",
	"100.66.",
	"100.67.",
	"100.68.",
	"100.69.",
	"127.0.0.1",
	"172.16.",
	"172.17.",
	"172.18.",
	"172.19.",
	"172.20.",
	"172.21.",
	"172.22.",
	"172.23.",
	"172.24.",
	"172.25.",
	"172.26.",
	"172.27.",
	"172.28.",
	"172.29.",
	"172.30.",
	"172.31.",
	"172.32.",
	// Globs from the source list.
	"100.7*",
	"100.8*",
	"100.9*",
	"127.0.0.1*",
	"wo-dr*.dbankcloud.ru",
] as const;

const forkSystemProxyBypassGlobs = FORK_SYSTEM_PROXY_BYPASS.filter(entry => entry.includes("*")).map(
	entry =>
		new RegExp(
			`^${entry
				.split("*")
				.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*")}$`,
		),
);

/** Hostname match for {@link FORK_SYSTEM_PROXY_BYPASS}; see the entry semantics there. */
export function matchesForkSystemProxyBypass(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (forkSystemProxyBypassGlobs.some(glob => glob.test(host))) return true;
	for (const entry of FORK_SYSTEM_PROXY_BYPASS) {
		if (entry.includes("*")) continue;
		if (/^\d/.test(entry)) {
			if (host.startsWith(entry)) return true;
		} else if (entry.startsWith(".") && entry.endsWith(".")) {
			if (host.includes(entry)) return true;
		} else if (entry.startsWith(".")) {
			const clean = entry.slice(1);
			if (host === clean || host.endsWith(entry)) return true;
		} else if (host === entry || host.endsWith(`.${entry}`)) {
			return true;
		}
	}
	return false;
}

/**
 * System-proxy candidate for one URL, or `undefined` to leave the request on
 * its default route. Explicit env proxies always win: Bun's fetch applies
 * `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` natively, so injecting the system
 * proxy over them would silently override the user's explicit choice.
 * `NO_PROXY`, loopback/private targets, and the fork intranet bypass list
 * bypass exactly as they do for `PI_PROXY`.
 */
function systemProxyForUrl(urlObj: URL, systemProxy: WindowsSystemProxy): string | undefined {
	if (shouldBypassProxy(urlObj)) return undefined;
	if (matchesForkSystemProxyBypass(urlObj.hostname)) return undefined;
	const secure = urlObj.protocol === "https:" || urlObj.protocol === "wss:";
	const envProxy = secure ? Bun.env.HTTPS_PROXY || Bun.env.https_proxy : Bun.env.HTTP_PROXY || Bun.env.http_proxy;
	if (envProxy || Bun.env.ALL_PROXY || Bun.env.all_proxy) return undefined;
	return secure ? systemProxy.https : systemProxy.http;
}

/** Wraps `fetchImpl` so requests without an explicit proxy or env proxy tunnel through the Windows system proxy. */
function wrapFetchWithSystemProxy(fetchImpl: FetchImpl, systemProxy: WindowsSystemProxy): FetchImpl {
	const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const urlStr = input instanceof Request ? input.url : input.toString();
		let proxyUrl: string | undefined;
		try {
			proxyUrl = systemProxyForUrl(new URL(urlStr), systemProxy);
		} catch {
			// Unparseable targets pass through untouched.
		}
		return proxyUrl ? fetchImpl(input, withProxyInit(input, init, proxyUrl)) : fetchImpl(input, init);
	};
	if (fetchImpl.preconnect) wrapped.preconnect = fetchImpl.preconnect;
	return wrapped;
}

let globalProxyFetchInstalled = false;

/** Test seam: re-arms {@link installGlobalProxyFetch}. */
export function __resetGlobalProxyFetch(): void {
	globalProxyFetchInstalled = false;
}

/**
 * Fork zero-config network defaults: relax TLS certificate verification for
 * every `fetch` (`NODE_TLS_REJECT_UNAUTHORIZED=0`, honored by Bun's fetch) and
 * git SSL checks for spawned `git` children (`GIT_SSL_NO_VERIFY=true`), so
 * interception proxies and private gateways with unknown root CAs work without
 * per-machine environment setup.
 *
 * An explicitly set variable always wins — exporting
 * `NODE_TLS_REJECT_UNAUTHORIZED=1` (or `GIT_SSL_NO_VERIFY=false`) restores
 * strict verification. Applying the default mutates both `Bun.env` and
 * `process.env` so the runtime's lazy per-request read and child-process
 * inheritance see it. Fork behavior: this is a deliberate security-posture
 * default for a personal fork, not an upstream mechanism.
 */
export function applyForkNetworkDefaults(): void {
	if (Bun.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
		Bun.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	}
	if (Bun.env.GIT_SSL_NO_VERIFY === undefined && process.env.GIT_SSL_NO_VERIFY === undefined) {
		Bun.env.GIT_SSL_NO_VERIFY = process.env.GIT_SSL_NO_VERIFY = "true";
	}
}

/**
 * Routes the process-wide `globalThis.fetch` through `PI_PROXY`, or — when no
 * `PI_PROXY` is set — through the per-user Windows system proxy for requests
 * that carry no explicit proxy environment variable.
 *
 * Bun's native fetch resolves `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` by
 * itself but knows nothing about `PI_PROXY`. Provider *streams* get their proxy
 * from {@link wrapFetchForProxy}; every other provider-bound request — OAuth
 * token refresh and login, usage probes, model discovery — goes out through the
 * bare global `fetch` and would silently ignore `PI_PROXY`. That asymmetry is
 * fatal wherever a provider geo-blocks its token endpoint: the stream is
 * proxied, the refresh is not, and the credential dies with a 403.
 *
 * Neither Bun's fetch nor any provider path reads the Windows system proxy
 * (Settings → Network & Internet → Proxy), so a machine whose only proxy is
 * configured there sends every request direct. On Windows with no `PI_PROXY`,
 * the enabled static system proxy (WinInet Internet Settings) therefore becomes
 * the lowest explicit tier: explicit env proxies still win per URL — Bun
 * applies them natively and the system wrapper yields — matching the
 * installer's env-first, system-proxy-second resolution.
 *
 * A per-request `proxy` (including `PI_PROXY_<PROVIDER>` injected by
 * {@link wrapFetchForProxy}) still wins, and loopback / private-range /
 * `NO_PROXY` targets plus the fork intranet bypass list
 * ({@link FORK_SYSTEM_PROXY_BYPASS}) bypass, so local model servers, MCP
 * hosts, and company intranet endpoints stay direct. Idempotent; a no-op when
 * `PI_PROXY` is unset and no usable system proxy is enabled.
 */
export function installGlobalProxyFetch(): void {
	if (globalProxyFetchInstalled) return;
	const proxyUrl = Bun.env.PI_PROXY?.trim();
	// One line naming every proxy-relevant variable this process can see: a
	// missing PI_PROXY and a NO_PROXY rule that silences it are otherwise
	// indistinguishable from a working proxy that the peer rejected.
	const env = {
		PI_PROXY: proxyUrl ? proxyLogTarget(proxyUrl) : undefined,
		PI_PROXY_ANTHROPIC: Bun.env.PI_PROXY_ANTHROPIC ? proxyLogTarget(Bun.env.PI_PROXY_ANTHROPIC) : undefined,
		HTTPS_PROXY: Bun.env.HTTPS_PROXY || Bun.env.https_proxy ? "set" : undefined,
		ALL_PROXY: Bun.env.ALL_PROXY || Bun.env.all_proxy ? "set" : undefined,
		NO_PROXY: Bun.env.NO_PROXY || Bun.env.no_proxy,
	};
	if (!proxyUrl) {
		const systemProxy = readWindowsSystemProxy();
		if (systemProxy?.http || systemProxy?.https) {
			globalProxyFetchInstalled = true;
			globalThis.fetch = wrapFetchWithSystemProxy(globalThis.fetch, systemProxy) as typeof globalThis.fetch;
			logger.debug("global system proxy fetch installed", {
				http: systemProxy.http ? proxyLogTarget(systemProxy.http) : undefined,
				https: systemProxy.https ? proxyLogTarget(systemProxy.https) : undefined,
				env,
			});
			return;
		}
		// Without any proxy variable there is nothing to diagnose; skip the
		// per-process line. When some are set, record why none was installed.
		if (Object.values(env).some(value => value !== undefined && value !== "")) {
			logger.debug("global proxy fetch not installed", {
				reason: "PI_PROXY unset",
				windowsSystemProxy: process.platform === "win32" ? "disabled" : undefined,
				env,
			});
		}
		return;
	}
	globalProxyFetchInstalled = true;
	globalThis.fetch = wrapFetchWithProxyUrl(globalThis.fetch, proxyUrl) as typeof globalThis.fetch;
	logger.debug("global proxy fetch installed", {
		proxy: proxyLogTarget(proxyUrl),
		env,
	});
}

export interface ConnectProxiedSocketOptions {
	/** Caller cancellation for the proxy TCP/TLS handshake and CONNECT tunnel. */
	signal?: AbortSignal;
	/** Maximum wall-clock time to establish the final TLS tunnel. Disabled when absent or non-positive. */
	timeoutMs?: number;
	/** Target TLS profile. Cursor defaults to HTTP/2 when this is absent. */
	tls?: tls.ConnectionOptions;
}

/**
 * Tunnel a socket connection through an HTTP CONNECT proxy.
 * This is used specifically to wrap Node's `http2.connect(baseUrl, { createConnection })` for Cursor.
 */
export async function connectProxiedSocket(
	proxyUrlStr: string,
	targetUrlStr: string,
	options?: ConnectProxiedSocketOptions,
): Promise<tls.TLSSocket> {
	if (options?.signal?.aborted) {
		throw new AbortError("Proxy tunnel aborted");
	}

	const proxyUrl = new URL(proxyUrlStr);
	const targetUrl = new URL(targetUrlStr);

	const useProxySsl = proxyUrl.protocol === "https:";
	const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : useProxySsl ? 443 : 80;
	const proxyHost = proxyUrl.hostname;

	const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
	const targetHost = targetUrl.hostname;

	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();

	const readyEvent = useProxySsl ? "secureConnect" : "connect";
	let tunnelSocket: tls.TLSSocket | undefined;
	let timeout: NodeJS.Timeout | undefined;
	let responseData = "";
	let settled = false;

	const cleanup = (): void => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		options?.signal?.removeEventListener("abort", onAbort);
		rawSocket?.off("error", onRawError);
		rawSocket?.off(readyEvent, onProxyReady);
		rawSocket?.off("data", onProxyData);
		tunnelSocket?.off("secureConnect", onTunnelReady);
		tunnelSocket?.off("error", onTunnelError);
	};
	const destroyInProgress = (): void => {
		tunnelSocket?.destroy();
		rawSocket?.destroy();
	};
	const rejectOnce = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		destroyInProgress();
		logger.debug("proxy tunnel failed", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			error: String(error),
			code: "code" in error ? String(error.code) : undefined,
		});
		reject(error);
	};
	const resolveOnce = (socket: tls.TLSSocket): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(socket);
	};
	const onAbort = (): void => rejectOnce(new AbortError("Proxy tunnel aborted"));
	const onRawError = (error: Error): void => rejectOnce(error);
	const onTunnelError = (error: Error): void => rejectOnce(error);
	const onTunnelReady = (): void => {
		if (!tunnelSocket) return;
		logger.debug("proxy tunnel established", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			peer: `${rawSocket?.remoteAddress ?? "?"}:${rawSocket?.remotePort ?? "?"}`,
			localPort: rawSocket?.localPort,
			alpn: tunnelSocket.alpnProtocol,
			authorized: tunnelSocket.authorized,
		});
		resolveOnce(tunnelSocket);
	};
	const onProxyData = (chunk: Buffer): void => {
		if (!rawSocket) return;
		responseData += chunk.toString("binary");
		if (!responseData.includes("\r\n\r\n")) return;

		rawSocket.off("data", onProxyData);
		rawSocket.off("error", onRawError);

		const firstLine = responseData.split("\r\n")[0];
		logger.debug("proxy tunnel CONNECT reply", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			reply: firstLine,
		});
		if (!firstLine.includes(" 200 ")) {
			rejectOnce(new ValidationError(`Proxy tunnel failed: ${firstLine}`));
			return;
		}

		const tlsOptions = options?.tls;
		const newTunnelSocket: tls.TLSSocket = tls.connect({
			...tlsOptions,
			socket: rawSocket,
			servername: tlsOptions?.servername ?? targetHost,
			ALPNProtocols: tlsOptions?.ALPNProtocols ?? ["h2"],
		});
		tunnelSocket = newTunnelSocket;
		newTunnelSocket.once("secureConnect", onTunnelReady);
		newTunnelSocket.once("error", onTunnelError);
	};
	const onProxyReady = (): void => {
		if (!rawSocket) return;
		let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n`;

		if (proxyUrl.username || proxyUrl.password) {
			const creds = Buffer.from(
				`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
			).toString("base64");
			connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
		}
		connectReq += "\r\n";

		rawSocket.write(connectReq);
		rawSocket.on("data", onProxyData);
		logger.debug("proxy tunnel CONNECT sent", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			peer: `${rawSocket.remoteAddress ?? "?"}:${rawSocket.remotePort ?? "?"}`,
		});
	};

	options?.signal?.addEventListener("abort", onAbort, { once: true });
	if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		const timeoutMs = Math.trunc(options.timeoutMs);
		timeout = setTimeout(() => {
			rejectOnce(new StreamTimeoutError(`Proxy tunnel timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timeout.unref?.();
	}

	const rawSocket = useProxySsl
		? tls.connect({
				host: proxyHost,
				port: proxyPort,
			})
		: net.connect({
				host: proxyHost,
				port: proxyPort,
			});
	rawSocket.once("error", onRawError);
	rawSocket.once(readyEvent, onProxyReady);

	return promise;
}
