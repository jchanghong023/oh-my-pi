import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Guards builtins that createTools force-includes into the registry but an
// explicit `toolNames` whitelist would otherwise drop from the active set.
// createAgentSession must mirror those inclusions so the callable surface
// remains consistent with wiki/read pairing and auto-learn guidance.
describe("createAgentSession force-included tool activation", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	function noDiscoveryOptions() {
		return {
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-autolearn-active-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function activeToolNames(settings: Settings): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["read"],
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	it("activates wiki when an unrestricted explicit tool set includes read", async () => {
		const names = await activeToolNames(Settings.isolated({}));
		expect(names).toContain("wiki");
	});

	it("activates force-included manage_skill in a restricted top-level session", async () => {
		const names = await activeToolNames(Settings.isolated({ "autolearn.enabled": true }));
		expect(names).toContain("read");
		// Built by createTools' force-include AND activated by the SDK's explicit-list
		// re-inclusion, so guidance/controller point at a callable tool.
		expect(names).toContain("manage_skill");
	});

	it("initializes the selected memory backend before an auto-learn session can run", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"autolearn.enabled": true,
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://127.0.0.1:1",
				"hindsight.mentalModelsEnabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["read"],
		});
		sessions.push(session);

		expect(session.getHindsightSessionState()).toBeDefined();
	});

	it("omits manage_skill from a restricted session when auto-learn is off", async () => {
		const names = await activeToolNames(Settings.isolated({}));
		expect(names).toContain("read");
		expect(names).not.toContain("manage_skill");
	});

	it("activates checkpoint and rewind when only rewind is in an explicit toolNames list", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "checkpoint.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["rewind"],
			requireYieldTool: true,
		});
		sessions.push(session);
		const names = session.getActiveToolNames();
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});

	it("activates checkpoint and rewind in a restricted session with one-sided toolNames", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "checkpoint.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["checkpoint"],
			requireYieldTool: true,
			restrictToolNames: true,
		});
		sessions.push(session);
		const names = session.getActiveToolNames();
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});
});
