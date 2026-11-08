import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { SourceMeta } from "../../src/capability/types";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { MCPManager, type MCPStartupStatus } from "../../src/mcp/manager";
import type { MCPServerConfig } from "../../src/mcp/types";
import { createAgentSession } from "../../src/sdk";
import { SessionManager } from "../../src/session/session-manager";
import { createNativeMcpMethods } from "../../src/webgui/native-mcp";
import { acquireBrowserProject } from "../../src/webgui/project-registry";
import { WebGuiNotImplementedError, type WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

// A pre-existing session manager cache; none of these fixtures performs discovery or transport I/O.
class CachedManager extends MCPManager {
	readonly configs: Record<string, MCPServerConfig>;
	readonly source: SourceMeta;
	reads = 0;

	constructor(cwd: string) {
		super(cwd, null);
		this.source = { provider: "omp", providerName: "OMP", path: `${cwd}/.omp/mcp.json`, level: "project" };
		this.configs = {
			configured: {
				type: "http",
				url: "https://user:url-password@example.test/private-path-token?token=query-secret#fragment-secret",
				headers: { Authorization: "Bearer header-secret", "X-Custom": "custom-header-secret" },
				oauth: { clientSecret: "oauth-secret" },
			},
			broken: { command: "private-command", args: ["argument-secret"], env: { TOKEN: "environment-secret" } },
		};
	}

	override getAllServerNames(): string[] {
		this.reads++;
		return Object.keys(this.configs);
	}
	override getServerConfig(name: string): MCPServerConfig | undefined {
		return this.configs[name];
	}
	override getSource(): SourceMeta {
		return this.source;
	}
	override getStartupStatus(): MCPStartupStatus {
		return {
			connected: [],
			pending: [],
			failed: [
				{
					name: "broken",
					error: "environment-secret https://user:url-password@example.test/?token=query-secret Authorization: Bearer header-secret",
				},
			],
		};
	}
}

async function fixture(temp: TempDir, withManager = true) {
	const cwd = temp.join("workspace");
	await fs.mkdir(cwd, { recursive: true });
	const manager = new CachedManager(cwd);
	const authStorage = createInMemoryAuthStorage();
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
		enableMCP: withManager,
		mcpManager: withManager ? manager : undefined,
		enableLsp: false,
		taskDepth: 1,
		agentId: "SubAgent",
	});
	const lease = await acquireBrowserProject(cwd, "webgui");
	await lease.activate(() => readWebGuiSessionInfo(session), { allowLan: false, nativeSession: session });
	const controller = new AbortController();
	const context: WebGuiServiceContext = {
		connectionId: "native-mcp-test",
		projectId: lease.projectId,
		workspacePath: temp.join("not-authority"),
		nativeSession: session,
		signal: controller.signal,
	};
	return {
		cwd,
		session,
		manager,
		controller,
		context,
		methods: createNativeMcpMethods(context),
		async close() {
			try {
				await lease.close();
			} finally {
				try {
					await session.dispose();
				} finally {
					authStorage.close();
				}
			}
		},
	};
}

test("native MCP reads preserve cached disconnected/failure meaning and expose only a non-editable redacted summary", async () => {
	using temp = TempDir.createSync("@pi-webgui-native-mcp-");
	const f = await fixture(temp);
	try {
		const catalog = await f.methods.loadMcpFromUserDirectory!({ workspacePath: f.cwd });
		const statuses = await f.methods.listWorkspaceMcpServerStatuses!({ workspacePath: f.cwd, mode: "status" });
		expect(catalog).toMatchObject({
			readOnly: true,
			configurationRedacted: true,
			source: "current-native-loaded-config",
			completeUserDirectoryExport: false,
			servers: [
				{
					name: "configured",
					scope: "workspace",
					projectPath: f.cwd,
					config: { type: "http" },
					endpointOrigin: "https://example.test",
					nativeSource: { provider: "omp", path: f.manager.source.path },
				},
				{ name: "broken", config: { type: "stdio" } },
			],
		});
		expect(statuses).toMatchObject({
			statuses: {
				configured: { status: "disconnected", transport: "http", toolCount: 0 },
				broken: { status: "failed", transport: "stdio", failureKind: "connection_failed" },
			},
		});
		const serialized = JSON.stringify({ catalog, statuses });
		for (const secret of [
			"url-password",
			"private-path-token",
			"query-secret",
			"fragment-secret",
			"header-secret",
			"custom-header-secret",
			"oauth-secret",
			"private-command",
			"argument-secret",
			"environment-secret",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(Object.keys(f.methods).sort()).toEqual(["listWorkspaceMcpServerStatuses", "loadMcpFromUserDirectory"]);
		expect(() => f.methods.listWorkspaceMcpServerStatuses!({ mode: "connect" })).toThrow(WebGuiNotImplementedError);
	} finally {
		await f.close();
	}
});

test("MCP reads reject foreign scopes, stale current-cwd managers, aborts and unavailable native ownership before cache access", async () => {
	using temp = TempDir.createSync("@pi-webgui-native-mcp-scope-");
	const f = await fixture(temp);
	try {
		expect(() => f.methods.loadMcpFromUserDirectory!({ workspacePath: temp.join("foreign") })).toThrow(/workspace/);
		expect(f.manager.reads).toBe(0);
		f.session.sessionManager.setCwdWithoutRelocation(temp.join("rebound"));
		expect(() => f.methods.loadMcpFromUserDirectory!()).toThrow(WebGuiNotImplementedError);
		expect(f.manager.reads).toBe(0);
		f.controller.abort(new Error("cancelled MCP read"));
		expect(() => f.methods.listWorkspaceMcpServerStatuses!()).toThrow("cancelled MCP read");
	} finally {
		await f.close();
	}
	const unavailable = await fixture(temp, false);
	try {
		expect(() => unavailable.methods.loadMcpFromUserDirectory!()).toThrow(WebGuiNotImplementedError);
		expect(() => unavailable.methods.listWorkspaceMcpServerStatuses!()).toThrow(WebGuiNotImplementedError);
	} finally {
		await unavailable.close();
	}
});
