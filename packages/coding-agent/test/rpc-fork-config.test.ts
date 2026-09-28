import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcForkConfigController, classifyModelTestError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-config";
import { RpcForkManageController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-manage";
import { RpcForkHost, type RpcForkContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-host";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSkillsEnableClaudeUser, cfgSkillsIgnoredSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const makeContext = (emitted: object[]): RpcForkContext => ({
	session: {} as RpcForkContext["session"],
	emit: frame => emitted.push(frame),
	success: (id, command, data) => ({ id, type: "response", command, success: true, data }) as RpcResponse,
	error: (id, command, message, code) =>
		({ id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) }) as RpcResponse,
});

interface Fixture {
	host: RpcForkHost;
	emitted: object[];
	run: (command: object) => Promise<RpcResponse>;
	session: AgentSession;
	settings: Settings;
}

let globalSettingsReady: Promise<unknown> | undefined;

beforeAll(async () => {
	// createSettingsHost routes through the process-global settings singleton;
	// tests initialize it in memory (never touches the user's real config).
	globalSettingsReady ??= Settings.init({ inMemory: true });
	await globalSettingsReady;
});

function setup(overrides?: Partial<Record<string, unknown>>): Fixture {
	const emitted: object[] = [];
	const host = new RpcForkHost(makeContext(emitted));
	host.activate();
	const settings = Settings.isolated();
	const session = {
		settings,
		sessionManager: { getCwd: () => process.cwd(), getSessionId: () => "s", getArtifactsDir: () => process.cwd() },
		modelRegistry: {
			authStorage: { keys: { get: async () => undefined }, usage: {} },
			awaitBackgroundRefresh: async () => {},
			getAvailableModels: () => [],
			getProviderBaseUrl: () => undefined,
			getProviderDiscoveryState: () => undefined,
		},
		getAvailableModels: () => [],
		...overrides,
	} as unknown as AgentSession;
	new RpcForkConfigController(host, session);
	new RpcForkManageController(host, session);
	return {
		host,
		emitted,
		run: command => host.handleCommand(command as { type: string }) as Promise<RpcResponse>,
		session,
		settings,
	};
}

describe("RpcForkConfigController A tier (5.6)", () => {
	test("get_settings returns masked schema entries; project scope filters to configured keys", async () => {
		const fx = setup();
		const user = (await fx.run({ id: "g1", type: "get_settings", scope: "user" })) as {
			data: Record<string, unknown>;
		} & RpcResponse;
		expect(user.data!.scope).toBe("user");
		const entries = user.data!.entries as Array<{ key: string; credential: boolean; value: unknown }>;
		expect(entries.length).toBeGreaterThan(10);
		for (const entry of entries) {
			if (entry.credential) {
				expect(entry.value === null || entry.value === undefined || entry.value === "••••••••").toBe(true);
			}
		}

		const project = (await fx.run({ type: "get_settings", scope: "project" })) as {
			data: Record<string, unknown>;
		} & RpcResponse;
		expect(Array.isArray(project.data!.entries)).toBe(true);

		const bad = await fx.run({ type: "get_settings", scope: "galaxy" });
		expect(bad).toMatchObject({ success: false });
	});

	test("set_settings writes user scope, rejects project scope with read_only_scope", async () => {
		const fx = setup();
		const projectWrite = await fx.run({ type: "set_settings", scope: "project", key: "theme", value: "dark" });
		expect(projectWrite).toMatchObject({ success: false, code: "read_only_scope" });

		const ok = await fx.run({ id: "s1", type: "set_settings", scope: "user", key: "theme.dark", value: "titanium" });
		expect(ok).toMatchObject({ success: true, data: { key: "theme.dark" } });
		expect(fx.emitted.at(-1)).toMatchObject({ type: "settings_changed", scope: "user" });

		const invalid = await fx.run({ type: "set_settings", scope: "user", key: "no.such.key", value: 1 });
		expect(invalid).toMatchObject({ success: false });
	});

	test("list_providers merges registry models with discovery state", async () => {
		const model = { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200000 };
		const fx = setup({
			getAvailableModels: () => [model],
			modelRegistry: {
				awaitBackgroundRefresh: async () => {},
				getProviderBaseUrl: () => "https://api.anthropic.com",
				getProviderDiscoveryState: () => ({
					provider: "anthropic",
					status: "ok",
					optional: true,
					stale: false,
					models: [],
				}),
			},
		});
		const response = (await fx.run({ id: "lp", type: "list_providers" })) as {
			data: Record<string, unknown>;
		} & RpcResponse;
		const providers = response.data!.providers as Array<Record<string, unknown>>;
		const anthropic = providers.find(provider => provider.provider === "anthropic");
		expect(anthropic).toBeDefined();
		expect(anthropic!.models).toEqual([{ id: "claude-sonnet-4-5", contextWindow: 200000 }]);
		expect(anthropic!.discovery).toMatchObject({ status: "ok" });
	});

	test("upsert_provider validates before writing; delete_provider reports unconfigured providers", async () => {
		const fx = setup();
		const invalid = await fx.run({
			type: "upsert_provider",
			provider: { name: "acme", models: [{ id: "m1" }] }, // models require baseUrl
		});
		expect(invalid).toMatchObject({ success: false });

		const missing = await fx.run({ type: "delete_provider", provider: "acme" });
		expect(missing).toMatchObject({ success: false, code: "provider_not_configured" });
	});

	test("test_model attributes model_not_found and endpoint_not_configured without network calls", async () => {
		const fx = setup();
		const notFound = (await fx.run({ id: "t1", type: "test_model", provider: "acme", modelId: "m1" })) as Extract<
			RpcResponse,
			{ command: "test_model"; success: true }
		>;
		expect(notFound.data!.ok).toBe(false);
		expect(notFound.data!.error!.category).toBe("model_not_found");

		const withModel = setup({
			getAvailableModels: () => [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
			modelRegistry: {
				authStorage: { keys: { get: async () => undefined }, usage: {} },
				awaitBackgroundRefresh: async () => {},
				getProviderBaseUrl: () => undefined,
				getProviderDiscoveryState: () => undefined,
			},
		});
		const noEndpoint = (await withModel.run({
			id: "t2",
			type: "test_model",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		})) as Extract<RpcResponse, { command: "test_model"; success: true }>;
		expect(noEndpoint.data!.error!.category).toBe("endpoint_not_configured");
	});

	test("classifyModelTestError maps statuses, flags, and transport failures", () => {
		expect(classifyModelTestError("HTTP 401 Unauthorized")!.category).toBe("auth_failed");
		expect(classifyModelTestError("HTTP 429 slow down")!.category).toBe("rate_limited");
		expect(classifyModelTestError("HTTP 404 not found")!.category).toBe("model_not_found");
		expect(classifyModelTestError("ECONNREFUSED 127.0.0.1:8080")!.category).toBe("network");
		expect(classifyModelTestError("HTTP 502 bad gateway")!.category).toBe("server");
		expect(classifyModelTestError("something odd")!.category).toBe("server");
	});
});

describe("RpcForkManageController B tier (5.6)", () => {
	test("skill source toggles write the matching settings key; invalid sources rejected", async () => {
		const fx = setup();
		const bad = await fx.run({ type: "set_skill_source_enabled", source: "acme:user", enabled: true });
		expect(bad).toMatchObject({ success: false, code: "unsupported_source" });

		const ok = await fx.run({ id: "sk1", type: "set_skill_source_enabled", source: "claude:user", enabled: false });
		expect(ok).toMatchObject({ success: true });
		expect(cfgSkillsEnableClaudeUser.get(fx.settings)).toBe(false);

		const ignored = await fx.run({ id: "sk2", type: "set_skill_ignored", name: "some-skill", ignored: true });
		expect(ignored).toMatchObject({ success: true });
		expect(cfgSkillsIgnoredSkills.get(fx.settings)).toEqual(["some-skill"]);
	});

	test("list_skills returns skills and warnings arrays", async () => {
		const fx = setup();
		const response = (await fx.run({ id: "ls", type: "list_skills" })) as {
			data: Record<string, unknown>;
		} & RpcResponse;
		expect(Array.isArray(response.data!.skills)).toBe(true);
		expect(Array.isArray(response.data!.warnings)).toBe(true);
	});

	test("agent definitions: upsert writes project file, discovery lists it, delete removes it", async () => {
		await using cwdDir = await TempDir.create("rpc-manage-cwd-");
		const root = path.resolve(cwdDir.path());
		const fx = setup({
			sessionManager: { getCwd: () => root, getSessionId: () => "s", getArtifactsDir: () => root },
		});

		const upsert = (await fx.run({
			id: "ad1",
			type: "upsert_agent_definition",
			definition: { name: "rpc-probe-agent", description: "probe", systemPrompt: "Do probing.", tools: ["read"] },
		})) as { data: Record<string, unknown> } & RpcResponse;
		const filePath = upsert.data!.filePath as string;
		expect(await fs.readFile(filePath, "utf-8")).toContain("name: rpc-probe-agent");

		const list = (await fx.run({ type: "list_agent_definitions" })) as {
			data: Record<string, unknown>;
		} & RpcResponse;
		const names = (list.data!.agents as Array<{ name: string }>).map(agent => agent.name);
		expect(names).toContain("rpc-probe-agent");

		const removed = await fx.run({ id: "ad2", type: "delete_agent_definition", name: "rpc-probe-agent" });
		expect(removed).toMatchObject({ success: true });
		expect(await fs.readFile(filePath, "utf-8").catch(() => "gone")).toBe("gone");

		const undeletable = await fx.run({ type: "delete_agent_definition", name: "rpc-probe-agent" });
		expect(undeletable).toMatchObject({ success: false, code: "agent_not_deletable" });
	});

	test("mcp_reconnect validates the server against config files", async () => {
		const fx = setup();
		const unknown = await fx.run({ id: "mr", type: "mcp_reconnect", name: "definitely-not-configured" });
		expect(unknown).toMatchObject({ success: false, code: "unknown_mcp_server" });
	});

	test("get_usage returns the trimmed report payload", async () => {
		const fx = setup({
			modelRegistry: {
				authStorage: {
					keys: { get: async () => undefined },
					usage: {
						reports: async () => [{ provider: "anthropic", fetchedAt: 1, limits: [], raw: { heavy: true } }],
						history: () => [],
					},
				},
				awaitBackgroundRefresh: async () => {},
				getProviderBaseUrl: () => undefined,
				getProviderDiscoveryState: () => undefined,
			},
		});
		const response = (await fx.run({ id: "u1", type: "get_usage" })) as {
			data: Record<string, unknown>;
		} & RpcResponse;
		const reports = response.data!.reports as Array<Record<string, unknown>>;
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ provider: "anthropic" });
		expect(Object.hasOwn(reports[0]!, "raw")).toBe(false);
	});
});
