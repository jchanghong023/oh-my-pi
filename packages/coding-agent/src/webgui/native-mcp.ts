import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import type { NativeMcpServerRecord } from "../../../../vendor/zcode-frontend/packages/shared/src/mcp";
import type { ZCodeMcpListResult } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol";
import { normalizeMCPTransportError } from "../mcp/errors";
import { redactUrlForLog } from "../mcp/json-rpc";
import type { MCPServerConfig } from "../mcp/types";
import { assertNativeChat } from "./native-chat";
import { WebGuiNotImplementedError, type WebGuiMethod, type WebGuiServiceContext } from "./rpc-contract";

interface NativeMcpRecord extends NativeMcpServerRecord {
	readonly readOnly: true;
	readonly configurationRedacted: true;
	readonly nativeSource: { readonly provider: string; readonly path: string; readonly level: string };
	readonly endpointOrigin?: string;
}

/** Only the transport is a configuration field: this is not an export or an editable credential replacement. */
function configurationSummary(config: MCPServerConfig): { type: "stdio" | "http" | "sse" } {
	return { type: config.type ?? "stdio" };
}

function endpointOrigin(config: MCPServerConfig): string | undefined {
	if (!("url" in config)) return undefined;
	try {
		// No path, query or fragment is needed to identify the endpoint's origin.
		// Run the native MCP redactor before parsing even this restricted view.
		const url = new URL(redactUrlForLog(config.url));
		return url.origin === "null" ? undefined : url.origin;
	} catch {
		return undefined;
	}
}

function ownedManager(context: WebGuiServiceContext, request: unknown) {
	const session = assertNativeChat(context);
	const cwd = session.sessionManager.getCwd();
	if (request !== undefined) {
		if (!request || typeof request !== "object" || Array.isArray(request))
			throw new Error("Invalid MCP read request");
		if ("workspacePath" in request && request.workspacePath !== undefined) {
			if (
				typeof request.workspacePath !== "string" ||
				normalizePathForComparison(request.workspacePath) !== normalizePathForComparison(cwd)
			) {
				throw new Error("MCP read workspace does not match the bound native session");
			}
		}
		if ("mode" in request && request.mode !== undefined && request.mode !== "status") {
			throw new WebGuiNotImplementedError("MCP connect/probe: only cached status reads are available");
		}
	}
	const manager = session.mcpManager;
	if (!manager || normalizePathForComparison(manager.getCwd()) !== normalizePathForComparison(cwd)) {
		throw new WebGuiNotImplementedError("MCP: no current-workspace native manager is bound");
	}
	return { manager, cwd };
}

/** Read the existing owner's cache only; never discover, connect, initialize, trust or reconnect. */
export function createNativeMcpMethods(context: WebGuiServiceContext): Readonly<Record<string, WebGuiMethod>> {
	return {
		loadMcpFromUserDirectory: (request?: unknown) => {
			const { manager, cwd } = ownedManager(context, request);
			const servers: NativeMcpRecord[] = [];
			for (const name of manager.getAllServerNames()) {
				const config = manager.getServerConfig(name);
				const source = manager.getSource(name);
				if (!config || !source) {
					throw new WebGuiNotImplementedError(
						"MCP configuration/source snapshot is not available from the native owner",
					);
				}
				servers.push({
					source: "mcp",
					scope: source.level === "project" ? "workspace" : source.level === "user" ? "user" : "common",
					name,
					config: configurationSummary(config),
					enabled: config.enabled !== false,
					...(source.level === "project" ? { projectPath: cwd } : {}),
					readOnly: true,
					configurationRedacted: true,
					nativeSource: { provider: source.provider, path: source.path, level: source.level },
					endpointOrigin: endpointOrigin(config),
				});
			}
			return {
				servers,
				readOnly: true,
				configurationRedacted: true,
				source: "current-native-loaded-config",
				completeUserDirectoryExport: false,
			};
		},
		listWorkspaceMcpServerStatuses: (request?: unknown): ZCodeMcpListResult => {
			const { manager } = ownedManager(context, request);
			const startup = manager.getStartupStatus();
			const failures = new Map(startup.failed.map(entry => [entry.name, entry.error]));
			const statuses = new Map<string, ZCodeMcpListResult["statuses"][string]>();
			const observedAt = new Date().toISOString();
			for (const name of manager.getAllServerNames()) {
				const config = manager.getServerConfig(name);
				if (!config || !manager.getSource(name)) {
					throw new WebGuiNotImplementedError(
						"MCP status configuration/source is unavailable from the native owner",
					);
				}
				const connection = manager.getConnection(name);
				const cached = manager.getConnectionStatus(name);
				if (cached === "connected" && connection?.tools === undefined) {
					throw new WebGuiNotImplementedError(
						"MCP connected-server tool-count snapshot is unavailable from the native owner",
					);
				}
				const failure = failures.get(name);
				let status: ZCodeMcpListResult["statuses"][string]["status"];
				let error: string | undefined;
				let failureKind: ZCodeMcpListResult["statuses"][string]["failureKind"];
				if (config.enabled === false) status = "disabled";
				else if (cached !== "disconnected") status = cached;
				else if (failure !== undefined) {
					status = "failed";
					const diagnostic = normalizeMCPTransportError(failure, {
						transport: config.type === "stdio" || !config.type ? "stdio" : "http",
						stage: "connect",
					});
					// Even a redacted remote error can repeat an arbitrary config secret without
					// a recognizable label. Publish its native classification, never raw text.
					error = `Native MCP connection failed (${diagnostic.failure}); detailed diagnostic text is withheld.`;
					failureKind = "connection_failed";
				} else status = cached;
				statuses.set(name, {
					status,
					transport: config.type ?? "stdio",
					toolCount: status === "connected" && connection?.tools ? connection.tools.length : 0,
					// The native cache has no lifecycle timestamp; this is the snapshot observation time.
					updatedAt: observedAt,
					...(error === undefined ? {} : { error, failureKind }),
				});
			}
			return { statuses: Object.fromEntries(statuses) };
		},
	};
}
