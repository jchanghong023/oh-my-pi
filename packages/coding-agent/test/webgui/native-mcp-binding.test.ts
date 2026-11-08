import { expect, spyOn, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import * as mcpClient from "../../src/mcp/client";
import { MCPManager, type MCPLoadResult } from "../../src/mcp/manager";
import type { MCPServerConnection } from "../../src/mcp/types";
import { createAgentSession, type CreateAgentSessionOptions } from "../../src/sdk";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

async function fixture(temp: TempDir, options: Partial<CreateAgentSessionOptions>) {
	const cwd = temp.path();
	const authStorage = createInMemoryAuthStorage();
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: temp.join("agent"),
			sessionManager: SessionManager.inMemory(cwd),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false, "memory.backend": "off" }),
			model: getTestModel("ascend"),
			toolNames: [],
			disableExtensionDiscovery: true,
			bindProcessState: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			enableLsp: false,
			taskDepth: 1,
			agentId: "SubAgent",
			...options,
		});
		return {
			session,
			async close() {
				try {
					await session.dispose();
				} finally {
					authStorage.close();
				}
			},
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

test("deferred SDK MCP reads remain synchronous while startup is pending and report the actual handshake failure", async () => {
	using temp = TempDir.createSync("@pi-native-mcp-binding-");
	const started = Promise.withResolvers<void>();
	const handshake = Promise.withResolvers<MCPServerConnection>();
	const connect = spyOn(mcpClient, "connectToServer").mockImplementation(() => {
		started.resolve();
		return handshake.promise;
	});
	let discovery: Promise<MCPLoadResult> | undefined;
	const discover = spyOn(MCPManager.prototype, "discoverAndConnect").mockImplementation(function (this: MCPManager) {
		discovery = this.connectServers({ server: { command: "fixture-server" } }, {});
		return discovery;
	});
	try {
		const f = await fixture(temp, { hasUI: true, enableMCP: true });
		try {
			await started.promise;
			const manager = f.session.mcpManager;
			if (!manager) throw new Error("Deferred SDK manager is unavailable");
			expect(manager.getStartupStatus()).toEqual({ connected: [], pending: ["server"], failed: [] });
			handshake.reject(new Error("fixture handshake rejected"));
			await discovery;
			await manager.waitForStartup(1000);
			expect(manager.getStartupStatus()).toEqual({
				connected: [],
				pending: [],
				failed: [{ name: "server", error: "fixture handshake rejected" }],
			});
		} finally {
			handshake.reject(new Error("fixture closed"));
			await discovery;
			await f.close();
		}
	} finally {
		discover.mockRestore();
		connect.mockRestore();
	}
});

test("SDK MCP authority rejects stale workspaces and disabled or restricted inherited capabilities", async () => {
	using temp = TempDir.createSync("@pi-native-mcp-authority-");
	const manager = new MCPManager(temp.path(), null);
	for (const policy of [{ enableMCP: true }, { enableMCP: false }, { enableMCP: true, restrictToolNames: true }]) {
		const f = await fixture(temp, { ...policy, mcpManager: manager });
		try {
			if (policy.enableMCP && !policy.restrictToolNames) {
				expect(f.session.mcpManager?.getStartupStatus()).toEqual({ connected: [], pending: [], failed: [] });
				f.session.sessionManager.setCwdWithoutRelocation(temp.join("different-workspace"));
				expect(f.session.mcpManager).toBeUndefined();
				f.session.sessionManager.setCwdWithoutRelocation(temp.path());
				expect(f.session.mcpManager?.getCwd()).toBe(temp.path());
			} else {
				expect(f.session.mcpManager).toBeUndefined();
			}
		} finally {
			await f.close();
		}
	}
	await manager.disconnectAll();
});
