import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { callTool } from "../../src/mcp/client";
import type { MCPManager } from "../../src/mcp/manager";
import { mcpOAuthCredentialId } from "../../src/mcp/oauth-flow";
import {
	forgetZCodeMcpConfiguration,
	normalizeZCodeMcpServers,
	persistZCodeMcpConfiguration,
	prepareZCodeMcpManager,
	restoreZCodeMcpConfiguration,
	zcodeMcpConfigurationIdentity,
} from "../../src/modes/zcode/tool-config";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const managers: MCPManager[] = [];
const servers: Bun.Server<undefined>[] = [];
const fixture = path.resolve(import.meta.dir, "../fixtures/readiness-mcp.ts");
const stdio = (name: string) => ({
	name,
	command: process.execPath,
	args: [fixture],
	env: [{ name: "SRV_NAME", value: name }],
	timeoutMs: 2_000,
});

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.disconnectAll()));
	for (const server of servers.splice(0)) server.stop(true);
});

describe("ZCode caller MCP configuration", () => {
	it("prepares actual stdio tools before returning and closes only its own manager", async () => {
		const first = await prepareZCodeMcpManager({ cwd: import.meta.dir, servers: [stdio("first")] });
		managers.push(first);
		const second = await prepareZCodeMcpManager({ cwd: import.meta.dir, servers: [stdio("second")] });
		managers.push(second);
		expect(first.getTools().map(tool => tool.name)).toEqual(["mcp__first_marker"]);
		expect(second.getTools().map(tool => tool.name)).toEqual(["mcp__second_marker"]);
		await first.disconnectAll();
		expect(first.getConnectedServers()).toEqual([]);
		const connection = second.getConnection("second");
		if (!connection) throw new Error("second session lost its connection");
		expect((await callTool(connection, "second_marker")).content).toEqual([
			{ type: "text", text: "MARKER_OK::second" },
		]);
	});

	it("uses actual HTTP discovery, literal caller headers and tool execution", async () => {
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method !== "POST") return new Response(null, { status: 405 });
				expect(request.headers.get("authorization")).toBe("Bearer literal-test-secret");
				const body = (await request.json()) as { id?: number; method: string };
				requests.push(body.method);
				if (body.id === undefined) return new Response(null, { status: 202 });
				const result =
					body.method === "initialize"
						? {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "http", version: "1" },
							}
						: body.method === "tools/list"
							? { tools: [{ name: "marker", inputSchema: { type: "object", properties: {} } }] }
							: { content: [{ type: "text", text: "HTTP_EXECUTED" }] };
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			},
		});
		servers.push(server);
		const manager = await prepareZCodeMcpManager({
			cwd: import.meta.dir,
			servers: [
				{
					name: "http",
					type: "http",
					url: `http://127.0.0.1:${server.port}/mcp`,
					headers: [{ name: "Authorization", value: "Bearer literal-test-secret" }],
				},
			],
		});
		managers.push(manager);
		expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__http_marker"]);
		const connection = manager.getConnection("http");
		if (!connection) throw new Error("HTTP server did not connect");
		expect((await callTool(connection, "marker")).content).toEqual([{ type: "text", text: "HTTP_EXECUTED" }]);
		expect(requests).toContain("tools/call");
		const auth = createInMemoryAuthStorage();
		try {
			const url = `http://127.0.0.1:${server.port}/mcp`;
			await auth.credentials.set(mcpOAuthCredentialId(url), {
				type: "oauth",
				access: "literal-test-secret",
				refresh: "",
				expires: Date.now() + 3_600_000,
			});
			const restored = await prepareZCodeMcpManager({
				cwd: import.meta.dir,
				authStorage: auth,
				servers: [
					{
						name: "saved-oauth",
						type: "http",
						url,
						headers: [],
						oauth: { type: "authorization_code", clientId: "saved-client" },
					},
				],
			});
			managers.push(restored);
			const savedConnection = restored.getConnection("saved-oauth");
			if (!savedConnection) throw new Error("Saved OAuth server did not connect");
			expect((await callTool(savedConnection, "marker")).content).toEqual([{ type: "text", text: "HTTP_EXECUTED" }]);
			await restored.disconnectAll();
		} finally {
			auth.close();
		}
	});

	it("uses caller load policy through the original MCP tool discoverable catalog", async () => {
		const manager = await prepareZCodeMcpManager({
			cwd: import.meta.dir,
			servers: [
				{ ...stdio("lazy"), alwaysLoad: false, protocolVersion: "legacy" },
				{ ...stdio("resident"), alwaysLoad: true },
			],
		});
		managers.push(manager);
		expect(manager.getTools().find(tool => tool.name === "mcp__lazy_marker")?.loadMode).toBe("discoverable");
		expect(manager.getTools().find(tool => tool.name === "mcp__resident_marker")?.loadMode).toBe("essential");
	});

	it("obtains and renews actual client credentials tokens through the original HTTP transport", async () => {
		let grants = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
					return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] });
				}
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return Response.json({ issuer: url.origin, token_endpoint: `${url.origin}/token` });
				}
				if (url.pathname === "/token") {
					const params = new URLSearchParams(await request.text());
					expect(params.get("grant_type")).toBe("client_credentials");
					expect(params.get("client_id")).toBe("caller-id");
					expect(params.get("client_secret")).toBe("caller-secret");
					expect(params.get("scope")).toBe("tools");
					grants++;
					return Response.json({ access_token: `access-${grants}`, token_type: "Bearer", expires_in: 3600 });
				}
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const body = (await request.json()) as { id?: number; method: string };
				if (body.id === undefined) return new Response(null, { status: 202 });
				if (body.method === "tools/call" && request.headers.get("authorization") === "Bearer access-1") {
					return new Response(null, { status: 401 });
				}
				expect(request.headers.get("authorization")).toBe(`Bearer access-${grants}`);
				const result =
					body.method === "initialize"
						? {
								protocolVersion: "2025-11-25",
								capabilities: { tools: {} },
								serverInfo: { name: "oauth", version: "1" },
							}
						: body.method === "tools/list"
							? { tools: [{ name: "marker", inputSchema: { type: "object", properties: {} } }] }
							: { content: [{ type: "text", text: "OAUTH_EXECUTED" }] };
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			},
		});
		servers.push(server);
		const manager = await prepareZCodeMcpManager({
			cwd: import.meta.dir,
			servers: [
				{
					name: "oauth",
					type: "http",
					url: `http://127.0.0.1:${server.port}/mcp`,
					headers: [],
					oauth: {
						type: "client_credentials",
						clientId: "caller-id",
						clientSecret: "caller-secret",
						scope: "tools",
					},
				},
			],
		});
		managers.push(manager);
		const connection = manager.getConnection("oauth");
		if (!connection) throw new Error("OAuth server did not connect");
		expect((await callTool(connection, "marker")).content).toEqual([{ type: "text", text: "OAUTH_EXECUTED" }]);
		expect(grants).toBe(2);
	});

	it("fails a bad session before admission without disconnecting a live session", async () => {
		const live = await prepareZCodeMcpManager({ cwd: import.meta.dir, servers: [stdio("live")] });
		managers.push(live);
		await expect(
			prepareZCodeMcpManager({
				cwd: import.meta.dir,
				servers: [
					{ name: "broken", command: "zcode-nonexistent-mcp-executable", args: [], env: [], timeoutMs: 100 },
				],
			}),
		).rejects.toThrow("MCP startup failed");
		expect(live.getConnectedServers()).toEqual(["live"]);
	});

	it("aborts a pending actual stdio handshake without affecting another owner", async () => {
		const live = await prepareZCodeMcpManager({ cwd: import.meta.dir, servers: [stdio("live")] });
		managers.push(live);
		const controller = new AbortController();
		const pending = prepareZCodeMcpManager({
			cwd: import.meta.dir,
			signal: controller.signal,
			servers: [{ ...stdio("slow"), env: [{ name: "DELAY_STARTUP", value: "5000" }] }],
		});
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(live.getConnectedServers()).toEqual(["live"]);
	});

	it("keeps explicit empty configs authoritative and does not perform ambient discovery", async () => {
		const manager = await prepareZCodeMcpManager({
			cwd: import.meta.dir,
			servers: [],
			loadConfigs: async () => {
				throw new Error("must not discover");
			},
		});
		managers.push(manager);
		expect(manager.getAllServerNames()).toEqual([]);
	});

	it("normalizes literal env and cwd without exposing credentials in identity", () => {
		const input = [{ ...stdio("server"), env: [{ name: "SECRET", value: "!literal-secret" }] }];
		const config = normalizeZCodeMcpServers(import.meta.dir, input).server;
		expect(config).toMatchObject({ cwd: import.meta.dir, envPolicy: "literal", env: { SECRET: "!literal-secret" } });
		const identity = zcodeMcpConfigurationIdentity(input);
		expect(identity).not.toContain("literal-secret");
		expect(identity).not.toBe(zcodeMcpConfigurationIdentity([{ ...input[0], args: ["changed"] }]));
	});

	it("restores cold-session config from the original credential store without journal secrets", async () => {
		const auth = createInMemoryAuthStorage();
		try {
			const input = [{ ...stdio("saved"), env: [{ name: "SECRET", value: "saved-secret" }] }];
			const reference = await persistZCodeMcpConfiguration(auth, "session-one", import.meta.dir, input);
			const other = await persistZCodeMcpConfiguration(auth, "session-two", import.meta.dir, [stdio("other")]);
			expect(JSON.stringify(reference)).not.toContain("saved-secret");
			expect(restoreZCodeMcpConfiguration(auth, reference)).toEqual(input);
			if (!reference.credentialProvider) throw new Error("Missing credential reference");
			await forgetZCodeMcpConfiguration(auth, reference);
			expect(restoreZCodeMcpConfiguration(auth, other)).toEqual([stdio("other")]);
			await forgetZCodeMcpConfiguration(auth, { version: 1, identity: "ambient" });
			expect(() => restoreZCodeMcpConfiguration(auth, reference)).toThrow("unavailable");
		} finally {
			auth.close();
		}
	});

	it("rejects conflicting names and unsupported settings rather than accepting ignored config", () => {
		expect(() => normalizeZCodeMcpServers(import.meta.dir, [stdio("same"), stdio("same")])).toThrow(
			"Duplicate MCP server",
		);
		expect(() =>
			normalizeZCodeMcpServers(import.meta.dir, [{ ...stdio("pin"), protocolVersion: "2026-07-28" }]),
		).toThrow("protocolVersion");
		expect(() =>
			normalizeZCodeMcpServers(import.meta.dir, [
				{
					...stdio("dup"),
					env: [
						{ name: "A", value: "1" },
						{ name: "A", value: "2" },
					],
				},
			]),
		).toThrow("Duplicate MCP environment");
	});
});
