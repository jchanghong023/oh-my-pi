import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("session runtime boundary regressions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-runtime-compact-review-");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		authStorage.close();
		closeModelCache();
		tempDir.removeSync();
	});

	it("does not fetch unrelated runtime catalogs after offline UI startup with an already-resolved explicit selector", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled startup model");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		let fetches = 0;
		const extension: ExtensionFactory = pi => {
			pi.registerProvider("offline-unrelated-runtime", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "test-runtime-key",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					fetches++;
					return [
						{
							id: "unrelated-model",
							name: "Unrelated Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 8192,
						},
					];
				},
			});
		};
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			model,
			modelPattern: `${model.provider}/${model.id}`,
			modelPatternSource: "explicit",
			offline: true,
			hasUI: true,
			settings: Settings.isolated({ "compaction.enabled": false, "prewalk.enabled": false }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		expect(fetches).toBe(0);
		await result.startBackgroundModelDiscovery?.();
		expect(fetches).toBe(0);
		expect(modelRegistry.find("offline-unrelated-runtime", "unrelated-model")).toBeUndefined();
	});

	it("rejects a report append while newSession has reset live context but has not committed its transcript", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test" });
		const manager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "prewalk.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: new Map(),
		});
		const oldSessionId = manager.getSessionId();
		const flushEntered = Promise.withResolvers<void>();
		const releaseFlush = Promise.withResolvers<void>();
		const originalFlush = manager.flush.bind(manager);
		spyOn(manager, "flush").mockImplementationOnce(async () => {
			flushEntered.resolve();
			await releaseFlush.promise;
			await originalFlush();
		});
		const transition = session.newSession();
		try {
			await flushEntered.promise;
			expect(manager.getSessionId()).toBe(oldSessionId);
			await expect(
				session.appendCustomMessage({
					customType: "team-result",
					content: "STALE_REPORT",
					display: true,
					attribution: "agent",
				}),
			).rejects.toThrow("Session changed");
			expect(JSON.stringify(manager.getEntries())).not.toContain("STALE_REPORT");
			expect(JSON.stringify(session.agent.state.messages)).not.toContain("STALE_REPORT");
		} finally {
			releaseFlush.resolve();
			await transition;
		}
		expect(manager.getSessionId()).not.toBe(oldSessionId);
		expect(JSON.stringify(session.agent.state.messages)).not.toContain("STALE_REPORT");
	});
});
