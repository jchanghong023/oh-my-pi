import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCPManager connection status events", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-status-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	// Bun's Windows pipe layer can drop stdio handshake frames under load
	// (same race documented in rpc-client.restart.test.ts).
	it.skipIf(process.platform === "win32")(
		"emits connecting, connected, and failed updates for startup status",
		async () => {
			const manager = new MCPManager(workDir);
			const events: McpConnectionStatusEvent[] = [];
			const success: MCPServerConfig = {
				type: "stdio",
				command: BUN_EXEC,
				args: [FIXTURE_PATH],
			};
			const invalid: MCPServerConfig = { type: "stdio", command: "" };

			try {
				const result = await manager.connectServers({ alpha: success, broken: invalid }, {}, event =>
					events.push(event),
				);

				expect(result.connectedServers).toContain("alpha");
				expect(result.errors.get("broken")).toBe('Server "broken": stdio server requires "command" field');
				expect(events).toEqual([
					{ type: "connecting", serverNames: ["alpha", "broken"] },
					{
						type: "failed",
						serverName: "broken",
						error: 'Server "broken": stdio server requires "command" field',
					},
					{ type: "connected", serverName: "alpha" },
				]);
			} finally {
				await manager.disconnectAll();
			}
		},
	);

	it("includes the originating config path for an invalid discovered server", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const configPath = path.join(os.homedir(), ".codex", "config.toml");
		const error = 'Server "broken": stdio server requires "command" field';
		try {
			const result = await manager.connectServers(
				{ broken: { type: "stdio", command: "" } },
				{ broken: { provider: "codex", providerName: "Codex", path: configPath, level: "user" } },
				event => events.push(event),
			);
			expect(result.errors.get("broken")).toBe(error);
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["broken"] },
				{ type: "failed", serverName: "broken", error, sourcePath: configPath },
			]);
		} finally {
			await manager.disconnectAll();
		}
	});

	// Windows routes extensionless commands through cmd.exe, whose failure
	// mode for a missing binary is nondeterministic (stdout close, immediate
	// exit, or shell error text), so the spawn-ENOENT contract is POSIX-only.
	it.skipIf(process.platform === "win32")(
		"includes the originating config path when a discovered server fails to start",
		async () => {
			const manager = new MCPManager(workDir);
			const events: McpConnectionStatusEvent[] = [];
			const missingCommand = path.join(workDir, "missing-mcp-server");
			const configPath = path.join(os.homedir(), ".codex", "config.toml");

			try {
				const result = await manager.connectServers(
					{
						broken: {
							type: "stdio",
							command: missingCommand,
						},
					},
					{
						broken: {
							provider: "codex",
							providerName: "Codex",
							path: configPath,
							level: "user",
						},
					},
					event => events.push(event),
				);

				const message = result.errors.get("broken") ?? "";
				expect(message).toMatch(/ENOENT|No such file|not found/i);
				expect(events).toEqual([
					{ type: "connecting", serverNames: ["broken"] },
					{
						type: "failed",
						serverName: "broken",
						error: message,
						sourcePath: configPath,
					},
				]);
			} finally {
				await manager.disconnectAll();
			}
		},
	);
});
