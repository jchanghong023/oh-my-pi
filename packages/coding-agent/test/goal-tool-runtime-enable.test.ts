import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ToolRestrictions } from "@oh-my-pi/pi-coding-agent/session/tool-restrictions";
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
		options: Partial<CreateAgentSessionOptions> & { allowRestrictedGoal?: boolean } = {},
	): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
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
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
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

	it.each([
		{
			label: "ordinary restricted default",
			optIn: undefined,
			requested: true,
			allowed: true,
			enabled: true,
			expected: false,
		},
		{ label: "explicit opt-out", optIn: false, requested: true, allowed: true, enabled: true, expected: false },
		{
			label: "explicit restricted Goal grant",
			optIn: true,
			requested: true,
			allowed: true,
			enabled: true,
			expected: true,
		},
		{
			label: "Goal omitted from exact list",
			optIn: true,
			requested: false,
			allowed: true,
			enabled: true,
			expected: false,
		},
		{
			label: "Goal denied by ToolRestrictions",
			optIn: true,
			requested: true,
			allowed: false,
			enabled: true,
			expected: false,
		},
		{
			label: "Goal disabled in settings",
			optIn: true,
			requested: true,
			allowed: true,
			enabled: false,
			expected: false,
		},
	])("restricted Goal admission: $label", async ({ optIn, requested, allowed, enabled, expected }) => {
		// The optional SDK seam is intentionally structural until core exports it.
		session = await makeSession(enabled, {
			restrictToolNames: true,
			allowRestrictedGoal: optIn,
			toolNames: requested ? ["read", "goal"] : ["read"],
			toolRestrictions: new ToolRestrictions({
				allowlist: ["read", "goal"],
				denylist: allowed ? [] : ["goal"],
			}),
		});
		await enterGoalMode(session);
		expect(session.getEnabledToolNames().includes("goal")).toBe(expected);
		const goal = session.agent.state.tools.find(tool => tool.name === "goal");
		expect(goal !== undefined).toBe(expected);
		if (expected) {
			const result = await goal!.execute("restricted-goal-get", { op: "get" } as never);
			expect(result.isError ?? false).toBe(false);
			expect(result.content.map(part => ("text" in part ? part.text : "")).join("\n")).toContain("test goal");
		}
	});
});
