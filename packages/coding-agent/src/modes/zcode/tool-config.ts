import { createHash } from "node:crypto";
import * as path from "node:path";
import type { SourceMeta } from "../../capability/types";
import { loadAllMCPConfigs } from "../../mcp/config";
import { type MCPConfigLoader, type MCPDiscoverOptions, MCPManager } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";
import type { AuthStorage } from "../../session/auth-storage";
import { LegacyProtocol } from "./schema";

type ZCodeProtocolMcpServer = LegacyProtocol.ZCodeProtocolMcpServer;

export interface PrepareZCodeMcpManagerOptions {
	cwd: string;
	/** Undefined uses normal scoped OMP discovery; an array is the complete caller-owned configuration. */
	servers?: readonly ZCodeProtocolMcpServer[];
	authStorage?: AuthStorage;
	/** Creation cancellation only. The returned manager is subsequently owned by its session. */
	signal?: AbortSignal;
	discoverOptions?: MCPDiscoverOptions;
	/** Allows the runtime to preserve its invocation/profile discovery scope on later reloads. */
	loadConfigs?: MCPConfigLoader;
}

function entriesToRecord(
	entries: readonly { name: string; value: string }[],
	kind: "environment" | "header",
): Record<string, string> {
	const result: Record<string, string> = Object.create(null);
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = kind === "header" ? entry.name.toLowerCase() : entry.name;
		if (seen.has(key)) throw new Error(`Duplicate MCP ${kind} entry`);
		seen.add(key);
		result[entry.name] = entry.value;
	}
	return result;
}

/** Translate Host startup config to the original OMP business types; never persist caller credentials. */
export function normalizeZCodeMcpServers(
	cwd: string,
	servers: readonly ZCodeProtocolMcpServer[],
): Record<string, MCPServerConfig> {
	const configs: Record<string, MCPServerConfig> = Object.create(null);
	for (const input of servers) {
		// Report only field paths: Zod's detailed input and caller values can contain credentials.
		const parsed = LegacyProtocol.zcodeProtocolMcpServerSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid MCP server startup configuration");
		const server = parsed.data;
		if (Object.hasOwn(configs, server.name)) throw new Error("Duplicate MCP server name");
		// OMP implements the legacy MCP era and negotiates that era's dated revisions itself.
		if (server.protocolVersion === "2026-07-28") {
			throw new Error("MCP protocolVersion 2026-07-28 is not supported by the OMP transport");
		}
		const shared = { timeout: server.timeoutMs, alwaysLoad: server.alwaysLoad ?? false };
		if ("command" in server) {
			configs[server.name] = {
				...shared,
				type: "stdio",
				command: server.command,
				args: [...server.args],
				env: entriesToRecord(server.env, "environment"),
				envPolicy: "literal",
				cwd: path.resolve(cwd),
			};
		} else {
			let url: URL;
			try {
				url = new URL(server.url);
			} catch {
				throw new Error("Invalid MCP server URL");
			}
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new Error("MCP server URL must use HTTP or HTTPS");
			if (url.username || url.password) throw new Error("MCP URL credentials must be supplied as headers");
			configs[server.name] = {
				...shared,
				type: server.type,
				url: server.url,
				headers: entriesToRecord(server.headers, "header"),
				headerPolicy: "origin-locked",
				oauth: server.oauth
					? {
							type: server.oauth.type,
							clientId: server.oauth.clientId,
							clientSecret: server.oauth.clientSecret,
							clientName: server.oauth.clientName,
							scope: server.oauth.scope,
							...("redirectPath" in server.oauth ? { callbackPath: server.oauth.redirectPath } : {}),
						}
					: undefined,
			};
		}
	}
	return configs;
}

/** Private comparison token only: never put raw startup config in a session snapshot or error. */
export function zcodeMcpConfigurationIdentity(servers: readonly ZCodeProtocolMcpServer[] | undefined): string {
	if (servers === undefined) return "ambient";
	const canonical = servers
		.map(input => {
			const parsed = LegacyProtocol.zcodeProtocolMcpServerSchema.safeParse(input);
			if (!parsed.success) throw new Error("Invalid MCP server startup configuration");
			const server = parsed.data;
			return {
				...server,
				...("command" in server
					? { env: [...server.env].sort((a, b) => a.name.localeCompare(b.name)) }
					: { headers: [...server.headers].sort((a, b) => a.name.localeCompare(b.name)) }),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Prepare before createAgentSession so its first tool registry/model schema contains actual MCP tools.
 * This creates no singleton and no transport: MCPManager owns all connections, reconnects and teardown.
 * Even workspace-isolated Host configurations get a private manager bound to the immutable session cwd;
 * their workspace identity never becomes an execution directory or an additional-root config search.
 */
export async function prepareZCodeMcpManager(options: PrepareZCodeMcpManagerOptions): Promise<MCPManager> {
	options.signal?.throwIfAborted();
	const cwd = path.resolve(options.cwd);
	const configs = options.servers === undefined ? undefined : normalizeZCodeMcpServers(cwd, options.servers);
	const source: SourceMeta = { provider: "zcode", providerName: "ZCode session", path: cwd, level: "native" };
	const sources: Record<string, SourceMeta> = Object.create(null);
	for (const name of Object.keys(configs ?? {})) sources[name] = source;
	let preparing = true;
	const load: MCPConfigLoader = async (directory, discoveryOptions) => {
		if (preparing) options.signal?.throwIfAborted();
		const loaded =
			configs === undefined
				? await (options.loadConfigs ?? loadAllMCPConfigs)(directory, discoveryOptions)
				: { configs, sources, exaApiKeys: [] };
		if (preparing) options.signal?.throwIfAborted();
		return loaded;
	};
	const manager = new MCPManager(cwd, null, load);
	if (options.authStorage) manager.setAuthStorage(options.authStorage);
	let cancellation: Promise<void> | undefined;
	const abort = () => {
		cancellation ??= manager.disconnectAll();
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		const result = await manager.discoverAndConnect({ ...options.discoverOptions, startupTimeoutMs: 1 });
		options.signal?.throwIfAborted();
		// No cache-backed placeholder/deferred tools may count as a ready caller-supplied server.
		// timeoutMs bounds the original handshake and tool requests, not their combined
		// duration. Admission must reject their first failure rather than wait for retries.
		const status = await manager.waitForStartup(0, { stopOnFailure: true });
		options.signal?.throwIfAborted();
		if (result.errors.size || status.failed.length || status.pending.length) {
			throw new Error("MCP startup failed: configured servers did not complete tool discovery");
		}
		return manager;
	} catch (error) {
		await (cancellation ?? manager.disconnectAll());
		if (options.signal?.aborted) options.signal.throwIfAborted();
		// Remote errors and commands can echo secrets. The manager owns diagnostics; the wire does not.
		if (error instanceof Error && error.message.startsWith("MCP startup failed:")) throw error;
		throw new Error("MCP startup failed: configured servers did not complete tool discovery");
	} finally {
		preparing = false;
		options.signal?.removeEventListener("abort", abort);
	}
}

/** Journal-safe reference. Executable config and all credentials remain in the existing auth store. */
export interface ZCodeMcpConfigurationReference {
	version: 1;
	identity: string;
	credentialProvider?: string;
}

export async function persistZCodeMcpConfiguration(
	authStorage: AuthStorage,
	sessionId: string,
	cwd: string,
	servers: readonly ZCodeProtocolMcpServer[] | undefined,
): Promise<ZCodeMcpConfigurationReference> {
	const identity = zcodeMcpConfigurationIdentity(servers);
	if (servers === undefined) return { version: 1, identity };
	normalizeZCodeMcpServers(cwd, servers);
	const scope = createHash("sha256")
		.update(JSON.stringify([path.resolve(cwd), sessionId]))
		.digest("hex");
	const credentialProvider = `zcode-mcp:${scope}`;
	await authStorage.credentials.set(credentialProvider, { type: "api_key", key: JSON.stringify(servers) });
	return { version: 1, identity, credentialProvider };
}

export function restoreZCodeMcpConfiguration(
	authStorage: AuthStorage,
	reference: ZCodeMcpConfigurationReference,
): readonly ZCodeProtocolMcpServer[] | undefined {
	if (reference.version !== 1) throw new Error("Unsupported saved MCP configuration reference");
	if (reference.identity === "ambient" && reference.credentialProvider === undefined) return undefined;
	if (!reference.credentialProvider?.startsWith("zcode-mcp:")) throw new Error("Missing saved MCP configuration");
	const credential = authStorage.credentials.get(reference.credentialProvider);
	if (credential?.type !== "api_key") throw new Error("Saved MCP configuration credentials are unavailable");
	let value: unknown;
	try {
		value = JSON.parse(credential.key);
	} catch {
		throw new Error("Invalid saved MCP configuration");
	}
	if (!Array.isArray(value)) throw new Error("Invalid saved MCP configuration");
	const servers: ZCodeProtocolMcpServer[] = [];
	for (const input of value) {
		const parsed = LegacyProtocol.zcodeProtocolMcpServerSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid saved MCP configuration");
		servers.push(parsed.data);
	}
	if (zcodeMcpConfigurationIdentity(servers) !== reference.identity)
		throw new Error("Saved MCP configuration identity mismatch");
	return servers;
}

/** Explicit session deletion only; normal close retains the credential envelope for cold resume. */
export async function forgetZCodeMcpConfiguration(
	authStorage: AuthStorage,
	reference: ZCodeMcpConfigurationReference,
): Promise<void> {
	if (reference.version !== 1) throw new Error("Unsupported saved MCP configuration reference");
	if (reference.identity === "ambient" && reference.credentialProvider === undefined) return;
	if (!reference.credentialProvider || !/^zcode-mcp:[a-f0-9]{64}$/.test(reference.credentialProvider)) {
		throw new Error("Invalid saved MCP configuration credential reference");
	}
	await authStorage.credentials.remove(reference.credentialProvider);
}
