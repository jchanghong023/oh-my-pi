/**
 * Contract: a vibe worker's spawn options carry the pre-expansion model role
 * and an id built from the worker name the user passed in.
 *
 * `#resolveWorker` expands explicitly configured worker roles (`good` -> `task`
 * -> `@task`, `fast` -> `sonic` -> `@smol`), but preserves aliases that reach
 * automatic priorities. Both paths forward role identity across
 * `ResolvedVibeWorker` -> `VibeRecord` -> `#buildSpawnOptions` -> `runSubprocess`.
 * The real executor must resolve those aliases without promoting automatic
 * candidates to explicit selections and inherit the selected role's retry chain.
 *
 * The id keeps only `[A-Za-z0-9_-]` from that name and falls back to a
 * generated name when nothing survives.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as nameGenerator from "@oh-my-pi/pi-coding-agent/task/name-generator";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { VibeCli } from "@oh-my-pi/pi-tui/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { createSessionDefaults } from "../helpers/session-defaults";

function makeParentSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

/** Spawn one worker and capture the ExecutorOptions the vibe path hands the executor. */
async function spawnAndCaptureOptions(cli: VibeCli, settings: Settings, name?: string): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	const executorSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		} as SingleResult;
	});

	try {
		const registry = VibeSessionRegistry.global();
		await registry.spawn(makeParentSession(settings), { cli, name, prompt: "work" });
		return await captured.promise;
	} finally {
		executorSpy.mockRestore();
	}
}

function workerModel(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://worker.example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

/** Keep the real executor's role matching and child fallback installation under test. */
async function consumeSpawnOptions(options: ExecutorOptions, models: Model<Api>[]) {
	const createSession = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async sessionOptions => {
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const session = {
			...createSessionDefaults(),
			agent: { state: { systemPrompt: ["test"] } },
			state: { messages: [] },
			model: sessionOptions?.model,
			extensionRunner: undefined,
			getActiveToolNames: () => ["yield"],
			getEnabledToolNames: () => ["yield"],
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async () => {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: "worker-yield",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { result: "worker fixture completed" } },
						},
						isError: false,
					});
				}
			},
		} as unknown as AgentSession;
		return { session, extensionsResult: {}, setToolUIContext: () => {} } as never;
	});

	const id = `consumer-${options.id}`;
	const result = await executorModule.runSubprocess({
		...options,
		id,
		cwd: process.cwd(),
		keepAlive: false,
		enableMCP: false,
		onProgress: undefined,
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => models,
			getApiKey: async () => "test-key",
		} as never,
	});
	expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
	expect(result.output).toContain("worker fixture completed");
	expect(createSession).toHaveBeenCalledTimes(1);
	const child = createSession.mock.calls[0]?.[0] as CreateAgentSessionOptions;
	if (!child.settings) throw new Error("Expected executor to create child settings");
	return {
		model: child.model,
		fallbackChain: cfgRetryFallbackChains.get(child.settings)?.[`subagent:${id}`],
	};
}

describe("vibe worker spawn options", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("forwards the `task` role behind the `good` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
			}),
		);

		expect(options.modelOverride).toEqual(["anthropic/sonnet"]);
		expect(options.modelRole).toBe("task");
	});

	it("forwards the `smol` role behind the `fast` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"fast",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", smol: "fast/hy3" },
			}),
		);

		expect(options.modelOverride).toEqual(["fast/hy3"]);
		expect(options.modelRole).toBe("smol");
	});

	// Automatic role provenance must survive the real vibe-to-executor hand-off.
	it.each([
		["good", "task"],
		["fast", "smol"],
	] as const)("preserves the automatic %s worker role until runtime resolution", async (cli, role) => {
		const settings = Settings.isolated({
			// `task` has no built-in priority list. Route it to the automatic
			// fast role as an operator can; an entirely unset task is inheritance,
			// not an automatic role alias.
			modelRoles: { task: "@smol" },
			"retry.fallbackChains": {
				default: ["company/default-fallback"],
				[role]: ["company/worker-fallback"],
			},
		});

		const options = await spawnAndCaptureOptions(cli, settings);

		expect(options.modelOverride).toEqual([`@${role}`]);
		expect(options.modelRole).toBe(role);

		// A removed-provider decoy must not win merely because it shares a
		// built-in priority's bare ID. Resolve the actual spawn payload, not a
		// separately reconstructed alias.
		const primary = workerModel("company", "claude-haiku-5-5");
		const child = await consumeSpawnOptions(options, [
			workerModel("apple", primary.id),
			primary,
			workerModel("company", "worker-fallback"),
			workerModel("company", "default-fallback"),
		]);
		expect(child.model).toBe(primary);
		expect(child.fallbackChain).toEqual(["company/worker-fallback"]);
	});

	it.each([
		["good", "task", "task"],
		["fast", "sonic", "smol"],
	] as const)("keeps an explicit %s worker selection ahead of automatic roles", async (cli, agent, role) => {
		const primary = workerModel("company", "selected-worker");
		const options = await spawnAndCaptureOptions(
			cli,
			Settings.isolated({
				modelRoles: { task: "@smol" },
				"task.agentModelOverrides": { [agent]: "company/selected-worker" },
				"retry.fallbackChains": {
					default: ["company/default-fallback"],
					[role]: ["company/role-fallback"],
				},
			}),
		);

		expect(options.modelOverride).toEqual(["company/selected-worker"]);
		expect(options.modelRole).toBeUndefined();
		const child = await consumeSpawnOptions(options, [
			workerModel("company", "claude-haiku-5-5"),
			primary,
			workerModel("company", "role-fallback"),
			workerModel("company", "default-fallback"),
		]);
		expect(child.model).toBe(primary);
		expect(child.fallbackChain).toEqual(["company/default-fallback"]);
	});

	it("drops role identity when an explicit per-agent model override replaces the alias", async () => {
		// `task.agentModelOverrides` wins over the agent definition, and an explicit
		// selector carries no role — the child must then inherit `default`, not
		// capture the routing of whichever role happens to name the same model.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentModelOverrides": { task: "openai-codex/sol" },
			}),
		);

		expect(options.modelOverride).toEqual(["openai-codex/sol"]);
		expect(options.modelRole).toBeUndefined();
	});

	it("restricts the first spawn to the worker agent's account pool, as revival does", async () => {
		// Without it a worker runs unrestricted until it is parked and revived.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentAccountPools": {
					task: { anthropic: ["email:a@example.com|org:org-a"] },
					sonic: { anthropic: [] },
				},
			}),
		);

		expect(options.oauthAccountPools).toEqual({ anthropic: ["email:a@example.com|org:org-a"] });
	});

	it("keeps only [A-Za-z0-9_-] from a custom worker name", async () => {
		const options = await spawnAndCaptureOptions("good", Settings.isolated(), "../My Worker!");

		expect(options.id).toBe("MyWorker");
	});

	it("falls back to a generated name when nothing in the custom name survives", async () => {
		vi.spyOn(nameGenerator, "generateTaskName").mockReturnValue("GeneratedWorker");

		const options = await spawnAndCaptureOptions("good", Settings.isolated(), "!!!");

		expect(options.id).toBe("GeneratedWorker");
	});
});
