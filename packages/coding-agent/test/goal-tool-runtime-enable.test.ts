import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgAsyncEnabled, cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";

describe("goal tool registration when goal mode is enabled at runtime", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-repro-9444-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function makeSession(
		goalEnabledAtStartup: boolean,
		options: Partial<CreateAgentSessionOptions> = {},
	): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("ascend", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.instance;
		cfgAsyncEnabled.set(settings, false);
		cfgToolsXdev.set(settings, true);
		cfgGoalEnabled.set(settings, goalEnabledAtStartup);
		const { session: created } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model: getBundledModel("ascend", "qwen3.8-flash-next"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			...options,
		});
		return created;
	}

	/** Mirror InteractiveMode.#enterGoalMode's tool operations. */
	async function enterGoalMode(s: AgentSession): Promise<void> {
		const previousTools = s.getEnabledToolNames().filter(n => n !== "goal");
		const state = await s.goalRuntime.createGoal({ objective: "test goal" });
		await s.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		s.setGoalModeState(state);
	}

	it("exposes the goal tool when goal.enabled is set at startup", async () => {
		session = await makeSession(true);
		await enterGoalMode(session);
		expect(session.getEnabledToolNames()).toContain("goal");
	});

	it("exposes the goal tool when goal.enabled is turned on after session start", async () => {
		// Regression for #9444: enabling goal mode at runtime (settings UI / config
		// reload) left the tool registry without `goal`, so entering goal mode
		// silently dropped the name and `xd://goal` failed with "No such tool".
		session = await makeSession(false);
		cfgGoalEnabled.set(Settings.instance, true);

		await enterGoalMode(session);

		expect(session.getEnabledToolNames()).toContain("goal");

		// The failing path in the report: a real xd://goal dispatch via the write
		// transport must now resolve the tool instead of throwing.
		const writeTool = session.agent.state.tools.find(t => t.name === "write");
		expect(writeTool).toBeDefined();
		const result = await writeTool!.execute("call_goal", {
			path: "xd://goal",
			content: JSON.stringify({ op: "get" }),
		} as never);
		expect(result.isError ?? false).toBe(false);
		const text = result.content?.map(c => ("text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
		expect(text).toContain("test goal");
	});

	it.each([true, false])(
		"keeps native Goal unavailable to restricted sessions (enabled at startup: %s)",
		async enabled => {
			session = await makeSession(enabled, { restrictToolNames: true, toolNames: ["read", "goal"] });
			cfgGoalEnabled.set(Settings.instance, true);
			await enterGoalMode(session);
			expect(session.agent.state.tools.map(tool => tool.name)).not.toContain("goal");
		},
	);
});
