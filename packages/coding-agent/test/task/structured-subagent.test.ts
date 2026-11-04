import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type Api, type Model } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	createMockModel,
	registerMockApi,
	type MockModel,
	type MockModelOptions,
} from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
	disableProvider,
	enableProvider,
	getDisabledProviders,
	isProviderEnabled,
	setDisabledProviders,
} from "@oh-my-pi/pi-coding-agent/capability";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentCompactionThresholdOverride } from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";
import * as companyProvider from "@oh-my-pi/pi-coding-agent/config/company-provider";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	normalizeModelPatternList,
	resolveAdvisorRoleSelection,
	resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type {
	BeforeSubagentSpawnEvent,
	LoadExtensionsResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { __closeExtensionParseCacheForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ToolRestrictions } from "@oh-my-pi/pi-coding-agent/session/tool-restrictions";
import { setSubagentWorkerPoolForTests, SubagentWorkerPool } from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as seanceModule from "@oh-my-pi/pi-coding-agent/task/seance";
import {
	buildStructuredSubagentRecoveryHint,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, NativeSubagentHooks } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createSessionDefaults } from "../helpers/session-defaults";

import { cfgRetryFallbackChains, cfgRetryModelFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import {
	cfgTaskAgentModelOverrides,
	cfgTaskEnableEffort,
	cfgTaskIsolationApply,
	cfgTaskIsolationCommits,
	cfgTaskIsolationEnabled,
} from "@oh-my-pi/pi-coding-agent/task/settings";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function session(
	options: {
		cwd?: string;
		settings?: Settings;
		planMode?: boolean;
		parentSpawns?: string;
		outputSchema?: unknown;
		maxDepth?: number;
		isolationEnabled?: boolean;
		isolationApply?: boolean;
		modelRoles?: Record<string, string>;
		agentServiceTierOverrides?: Record<string, string>;
		agentCompactionThresholdOverrides?: Record<string, AgentCompactionThresholdOverride>;
		sessionAgents?: readonly AgentDefinition[];
	} = {},
): ToolSession {
	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings:
			options.settings ??
			Settings.isolated({
				"task.maxRecursionDepth": options.maxDepth ?? 2,
				"task.isolation.enabled": options.isolationEnabled ?? false,
				"isolation.backend": "rcopy",
				"task.enableLsp": true,
				...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
				...(options.isolationApply !== undefined ? { "task.isolation.apply": options.isolationApply } : {}),
				...(options.agentServiceTierOverrides
					? { "task.agentServiceTierOverrides": options.agentServiceTierOverrides }
					: {}),
				...(options.agentCompactionThresholdOverrides
					? { "task.agentCompactionThresholdOverrides": options.agentCompactionThresholdOverrides }
					: {}),
			}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.parentSpawns ?? "*",
		getSessionAgents: () => options.sessionAgents ?? [],
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

function consumerModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: `${provider}/${id}`,
		provider,
		api: "openai-completions",
		baseUrl: "https://model-selection.invalid",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

async function withConsumerCatalog(
	body: (fixture: {
		parent: ToolSession;
		selections: Array<{ model?: Model<Api>; thinkingLevel?: string }>;
		advisors: Array<{ model?: Model<Api>; thinkingLevel?: string } | undefined>;
		sessionOptions: sdkModule.CreateAgentSessionOptions[];
		setModels: (models: Model<Api>[]) => void;
	}) => Promise<void>,
): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-model-selection-"));
	const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
	let models: Model<Api>[] = [];
	const available = vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
	const selections: Array<{ model?: Model<Api>; thinkingLevel?: string }> = [];
	const advisors: Array<{ model?: Model<Api>; thinkingLevel?: string } | undefined> = [];
	const sessionOptions: sdkModule.CreateAgentSessionOptions[] = [];
	// Exercise the actual executor's resolution and deferred SDK inputs, stopping
	// at session creation so this selection regression sends no provider request.
	const create = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (options) sessionOptions.push(options);
		const selected = options?.model
			? { model: options.model, thinkingLevel: options.thinkingLevel }
			: resolveModelOverride(normalizeModelPatternList(options?.modelPattern), modelRegistry, options?.settings);
		selections.push(selected);
		advisors.push(options?.settings ? resolveAdvisorRoleSelection(options.settings, models) : undefined);
		throw new Error("model selection boundary reached");
	});
	const parent = session({ cwd });
	parent.modelRegistry = modelRegistry;
	parent.authStorage = authStorage;
	parent.enableLsp = false;
	parent.enableIrc = false;
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	parent.asyncJobManager = jobs;
	parent.getSessionId = () => "model-selection-parent";
	parent.getArtifactsDir = () => null;
	try {
		await body({
			parent,
			selections,
			advisors,
			sessionOptions,
			setModels: next => {
				models = next;
			},
		});
	} finally {
		await jobs.waitForAll();
		await jobs.dispose();
		create.mockRestore();
		available.mockRestore();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await authStorage.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("structured subagent primitive", () => {
	it("keeps automatic task and eval role choices out of a remote-only catalog", async () => {
		mockDiscovery({ ...AGENT, model: ["@smol:high"] });
		const remote = consumerModel("apple", "claude-haiku-5-5");
		const ordinary = consumerModel("anthropic", "claude-haiku-5-5");
		await withConsumerCatalog(async ({ parent, selections, setModels }) => {
			for (const invocationKind of ["task", "eval"] satisfies StructuredSubagentRequest["invocationKind"][]) {
				setModels([remote]);
				await runStructuredSubagent(request({ session: parent, invocationKind }));
				expect(selections.at(-1)?.model).toBeUndefined();
				setModels([remote, ordinary]);
				await runStructuredSubagent(request({ session: parent, invocationKind }));
				expect(selections.at(-1)?.model).toBe(ordinary);
				expect(selections.at(-1)?.thinkingLevel).toBe("high");
			}
			expect(selections).toHaveLength(4);
		});
	});

	it("preserves an offline agent-definition role and its deferred fallback context without an override", async () => {
		vi.spyOn(companyProvider, "isCompanyLaneActive").mockReturnValue(true);
		await withConsumerCatalog(async ({ parent, selections, sessionOptions }) => {
			parent.settings.setModelRole("task", "cold-provider/primary");
			cfgRetryFallbackChains.override(parent.settings, { task: ["cold-provider/fallback:low"] });
			const rolesBefore = { ...parent.settings.getModelRoles() };
			const child = await executorModule.runSubprocess({
				cwd: parent.cwd,
				agent: { ...AGENT, model: ["@task"] },
				task: "Inspect the target.",
				index: 0,
				id: "ColdDefinition",
				settings: parent.settings,
				modelRegistry: parent.modelRegistry,
				authStorage: parent.authStorage,
				parentActiveModelPattern: "parent-provider/parent-model",
				enableLsp: false,
				enableIrc: false,
				enableMCP: false,
				asyncJobManager: parent.asyncJobManager,
			});
			expect(child.exitCode).toBe(1);
			expect(selections.at(-1)?.model).toBeUndefined();
			const deferred = sessionOptions.at(-1);
			expect(deferred?.modelPattern).toEqual(["@task"]);
			expect(deferred?.modelPatternAuthFallback).toBe("parent-provider/parent-model");
			expect(deferred?.modelPatternFallbackRole).toBe("subagent:ColdDefinition");
			expect(deferred?.modelPatternDefaultFallbackChain).toEqual(["cold-provider/fallback:low"]);
			expect(parent.settings.getModelRoles()).toEqual(rolesBefore);
		});
	});

	it("preserves automatic spawn-hook roles while allowing explicit agent and configured role selections", async () => {
		mockDiscovery({ ...AGENT, model: ["@smol"] });
		const remote = consumerModel("apple", "claude-haiku-5-5");
		const ordinary = consumerModel("anthropic", "claude-haiku-5-5");
		await withConsumerCatalog(async ({ parent, selections, setModels }) => {
			parent.emitBeforeSubagentSpawn = async () => ({ model: "@smol:high" });
			setModels([remote]);
			await runStructuredSubagent(request({ session: parent }));
			expect(selections.at(-1)?.model).toBeUndefined();
			setModels([remote, ordinary]);
			await runStructuredSubagent(request({ session: parent }));
			expect(selections.at(-1)?.model).toBe(ordinary);
			expect(selections.at(-1)?.thinkingLevel).toBe("high");
			parent.emitBeforeSubagentSpawn = undefined;
			setModels([remote]);
			cfgTaskAgentModelOverrides.override(parent.settings, { worker: "apple/claude-haiku-5-5:high" });
			await runStructuredSubagent(request({ session: parent }));
			expect(selections.at(-1)?.model).toBe(remote);
			expect(selections.at(-1)?.thinkingLevel).toBe("high");
			cfgTaskAgentModelOverrides.override(parent.settings, {});
			parent.settings.setModelRole("smol", "apple/claude-haiku-5-5:high");
			await runStructuredSubagent(request({ session: parent }));
			expect(selections.at(-1)?.model).toBe(remote);
			expect(selections.at(-1)?.thinkingLevel).toBe("high");
			expect(selections).toHaveLength(4);
		});
	});

	it("keeps both vibe worker tiers role-aware without preventing an explicit remote override", async () => {
		const remoteFast = consumerModel("apple", "claude-haiku-5-5");
		const ordinaryFast = consumerModel("anthropic", "claude-haiku-5-5");
		const remoteGood = consumerModel("apple", "gpt-5.6-sol");
		const ordinaryGood = consumerModel("openai-codex", "gpt-5.6-sol");
		await withConsumerCatalog(async ({ parent, selections, setModels }) => {
			parent.settings.setModelRole("task", "@slow");
			for (const [cli, remote, ordinary] of [
				["fast", remoteFast, ordinaryFast],
				["good", remoteGood, ordinaryGood],
			] as const) {
				setModels([remote]);
				await VibeSessionRegistry.global().spawn(parent, { cli, prompt: "Inspect the target." });
				await parent.asyncJobManager?.waitForAll();
				expect(selections.at(-1)?.model).toBeUndefined();
				setModels([remote, ordinary]);
				await VibeSessionRegistry.global().spawn(parent, { cli, prompt: "Inspect the target." });
				await parent.asyncJobManager?.waitForAll();
				expect(selections.at(-1)?.model).toBe(ordinary);
			}
			setModels([remoteGood]);
			cfgTaskAgentModelOverrides.override(parent.settings, { task: "apple/gpt-5.6-sol:high" });
			await VibeSessionRegistry.global().spawn(parent, { cli: "good", prompt: "Inspect the target." });
			await parent.asyncJobManager?.waitForAll();
			expect(selections.at(-1)?.model).toBe(remoteGood);
			expect(selections.at(-1)?.thinkingLevel).toBe("high");
			expect(selections).toHaveLength(5);
		});
	});

	it("stamps automatic advisors without recursive selection or losing explicit owner choices", async () => {
		mockDiscovery({ ...AGENT, model: ["anthropic/claude-haiku-5-5"], advisor: "@advisor:high" });
		const primary = consumerModel("anthropic", "claude-haiku-5-5");
		const remote = consumerModel("apple", "gpt-5.6-sol");
		const ordinary = consumerModel("openai-codex", "gpt-5.6-sol");
		await withConsumerCatalog(async ({ parent, selections, advisors, setModels }) => {
			setModels([primary, remote]);
			await runStructuredSubagent(request({ session: parent }));
			expect(selections.at(-1)?.model).toBe(primary);
			expect(advisors.at(-1)).toBeUndefined();
			setModels([primary, remote, ordinary]);
			await runStructuredSubagent(request({ session: parent }));
			expect(advisors.at(-1)?.model).toBe(ordinary);
			expect(advisors.at(-1)?.thinkingLevel).toBe("high");
			parent.settings.setModelRole("advisor", "@advisor,apple/gpt-5.6-sol");
			setModels([primary, remote]);
			await runStructuredSubagent(request({ session: parent }));
			expect(advisors.at(-1)?.model).toBe(remote);
			expect(advisors.at(-1)?.thinkingLevel).toBe("high");
			expect(advisors).toHaveLength(3);
		});
	});
	it("resolves user-tagged model agents for task and eval but rejects untagged names", async () => {
		mockDiscovery();
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["a/x"] }];
		for (const invocationKind of ["task", "eval"] satisfies StructuredSubagentRequest["invocationKind"][]) {
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: taggedSession, agent: "m1", invocationKind }),
			);
			expect(policy.agent.name).toBe("m1");
			expect(policy.modelOverride).toEqual(["a/x"]);
		}
		await expect(resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m9" }))).rejects.toThrow(
			'Unknown agent "m9". Available: worker, m1',
		);
	});

	it("keeps discovered agents authoritative on pseudonym collisions", async () => {
		mockDiscovery({ ...AGENT, name: "m1", model: ["b/y"] });
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["a/x"] }];
		const policy = await resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m1" }));
		expect(policy.modelOverride).toEqual(["b/y"]);
	});

	it("keeps explicit host definitions ahead of session tags without sharing them across sessions", async () => {
		mockDiscovery({ ...AGENT, name: "m1", model: ["discovered/model"] });
		const tagged: AgentDefinition = {
			...AGENT,
			name: "m1",
			model: ["tagged/model:high"],
			thinkingLevel: Effort.High,
		};
		const explicit: AgentDefinition = { ...AGENT, name: "m1", model: ["host/model"] };
		const host = session({ sessionAgents: [tagged] });
		host.getAgentDefinitions = () => [explicit];
		const policy = await resolveEffectiveSubagentPolicy(request({ session: host, agent: "m1", effort: "lo" }));
		expect(policy.agent).toBe(explicit);
		expect(policy.modelOverride).toEqual(["host/model"]);
		expect(policy.effort).toBe("lo");
		const other = await resolveEffectiveSubagentPolicy(request({ session: session(), agent: "m1" }));
		expect(other.modelOverride).toEqual(["discovered/model"]);
	});

	it("keeps live native capabilities on the owning thread while ordinary runs use placement", async () => {
		const pool = new SubagentWorkerPool({ maxWorkers: () => 1 });
		setSubagentWorkerPoolForTests(pool);
		const place = vi.spyOn(pool, "place").mockImplementation(() => ({
			worker: undefined,
			release: pool.beginMainRun(),
		}));
		const controller = new AbortController();
		controller.abort();
		const base: executorModule.ExecutorOptions = {
			cwd: "/tmp",
			agent: AGENT,
			task: "Inspect the target.",
			index: 0,
			id: "NativeOwner",
			settings: Settings.isolated(),
			signal: controller.signal,
		};
		const capabilities: Partial<executorModule.ExecutorOptions>[] = [
			{ subagentHooks: { beforeSpawn: async () => ({}), configureSession: async () => ({}) } },
			{ subagentRequest: request() },
			{ onSessionCreated: () => {} },
			{
				createInteractionUI: () => {
					throw new Error("not called");
				},
			},
			{ getAgentDefinitions: () => [AGENT] },
		];
		try {
			for (const capability of capabilities) {
				const run = executorModule.runSubprocess({ ...base, ...capability });
				expect(pool.mainRuns).toBe(1);
				expect((await run).aborted).toBe(true);
				expect(pool.mainRuns).toBe(0);
			}
			expect(place).not.toHaveBeenCalled();
			await executorModule.runSubprocess(base);
			expect(place).toHaveBeenCalledTimes(1);
			expect(pool.mainRuns).toBe(0);
		} finally {
			setSubagentWorkerPoolForTests(undefined);
			pool.dispose();
		}
	});

	it("rescans agents when a plugin provider is disabled while an earlier discovery is in flight", async () => {
		const previouslyDisabled = getDisabledProviders();
		enableProvider("omp-plugins");
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let scans = 0;
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => {
			const pluginsEnabled = isProviderEnabled("omp-plugins");
			if (++scans === 1) {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			const agents = pluginsEnabled ? [AGENT, { ...AGENT, name: "plugin-worker" }] : [AGENT];
			return { agents, projectAgentsDir: null };
		});
		try {
			const first = resolveEffectiveSubagentPolicy(request({ agent: "plugin-worker" }));
			await firstEntered.promise;
			disableProvider("omp-plugins");
			const second = resolveEffectiveSubagentPolicy(request({ agent: "plugin-worker" }));
			releaseFirst.resolve();

			expect((await first).agent.name).toBe("plugin-worker");
			await expect(second).rejects.toThrow('Unknown agent "plugin-worker"');
		} finally {
			setDisabledProviders(previouslyDisabled);
		}
	});

	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("uses saved seance models in active-role/default order and honors an explicit available override", async () => {
		const seanceAgent = getBundledAgent("seance");
		if (!seanceAgent) throw new Error("Expected the bundled seance agent");
		mockDiscovery(seanceAgent);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-policy-"));
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const models = [consumerModel("anthropic", "claude-sonnet-4-5"), consumerModel("anthropic", "claude-sonnet-4-6")];
		// Saved-model restoration uses find; the explicit override uses the available catalog.
		// Keep both views explicit rather than depending on retired bundled model entries.
		vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
			models.find(model => model.provider === provider && model.id === id),
		);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
		const cwd = path.join(tempDir, "project");
		const sourceFile = path.join(tempDir, "sessions", "source.jsonl");
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await Bun.write(
			sourceFile,
			`${[
				{ type: "session", version: 3, id: "saved-source", timestamp: "2026-10-01T00:00:00.000Z", cwd },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp: "2026-10-01T00:00:01.000Z",
					model: "anthropic/claude-sonnet-4-5",
					role: "default",
				},
				{
					type: "model_change",
					id: "active-model",
					parentId: "default-model",
					timestamp: "2026-10-01T00:00:02.000Z",
					model: "anthropic/claude-sonnet-4-6",
					role: "fast",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const caller = Object.assign(session({ cwd }), { modelRegistry });
		try {
			const saved = await resolveEffectiveSubagentPolicy(
				request({ session: caller, agent: "seance", sourceSession: sourceFile }),
			);
			expect(saved.preparedSession?.fork.sourceFile).toBe(sourceFile);

			expect(saved.modelOverride).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
			expect(saved.enableLsp).toBe(false);
			expect(saved.enableIrc).toBe(false);

			const overridden = await resolveEffectiveSubagentPolicy(
				request({
					session: caller,
					agent: "seance",
					sourceSession: sourceFile,
					model: "anthropic/claude-sonnet-4-5",
				}),
			);
			expect(overridden.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
		} finally {
			authStorage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed when the source has no saved model or an explicit model is unavailable", async () => {
		const seanceAgent = getBundledAgent("seance");
		if (!seanceAgent) throw new Error("Expected the bundled seance agent");
		mockDiscovery(seanceAgent);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-model-fail-"));
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		const cwd = path.join(tempDir, "project");
		const sourceFile = path.join(tempDir, "sessions", "no-model.jsonl");
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await Bun.write(
			sourceFile,
			`${JSON.stringify({ type: "session", version: 3, id: "no-model-source", timestamp: "2026-10-01T00:00:00.000Z", cwd })}\n`,
		);
		const caller = Object.assign(session({ cwd }), { modelRegistry });
		try {
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: caller, agent: "seance", sourceSession: sourceFile })),
			).rejects.toThrow("The source session has no saved model.");
			await expect(
				resolveEffectiveSubagentPolicy(
					request({
						session: caller,
						agent: "seance",
						sourceSession: sourceFile,
						model: "missing-provider/missing-model",
					}),
				),
			).rejects.toThrow("No available saved model can serve this source.");
		} finally {
			authStorage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("gives task and eval invocations identical blocked-agent preflight errors", async () => {
		const previous = Bun.env.PI_BLOCKED_AGENT;
		Bun.env.PI_BLOCKED_AGENT = "worker";
		try {
			const discover = vi.spyOn(discoveryModule, "discoverAgents");
			const taskRequest = request();
			const evalRequest = request({ session: taskRequest.session, invocationKind: "eval" });
			const messages: string[] = [];
			for (const candidate of [taskRequest, evalRequest]) {
				try {
					await resolveEffectiveSubagentPolicy(candidate);
				} catch (error) {
					expect(error).toBeInstanceOf(StructuredSubagentError);
					messages.push((error as Error).message);
				}
			}
			expect(messages).toEqual([
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
			]);
			expect(discover).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete Bun.env.PI_BLOCKED_AGENT;
			else Bun.env.PI_BLOCKED_AGENT = previous;
		}
	});

	it("attenuates plan-mode agents and rejects mutable isolation controls before discovery", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), enableLsp: true, enableIrc: true }),
		);
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.enableLsp).toBe(false);
		expect(policy.enableIrc).toBe(false);

		vi.restoreAllMocks();
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		await expect(
			resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true }), isolation: { requested: false } }),
			),
		).rejects.toThrow("isolation, apply, and merge controls are unavailable in plan mode");

		const planSession = session({ planMode: true });
		const customTools = createEvalCustomTools(planSession, [
			{
				name: "word_count",
				description: "Count words",
				parameters: { type: "object", properties: {} },
				language: "python",
			},
		]);
		await expect(resolveEffectiveSubagentPolicy(request({ session: planSession, customTools }))).rejects.toThrow(
			"Eval-defined tools are unavailable in plan mode.",
		);
		expect(discover).not.toHaveBeenCalled();
	});
	it("reloads project task and retry policy before resolving an agent added during the session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-hot-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"task:\n  enableEffort: true\nretry:\n  modelFallback: true\n",
		);
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = {
			...session(),
			cwd: projectDir,
			settings: liveSettings,
		} as ToolSession;

		try {
			await Bun.write(
				path.join(projectDir, ".omp", "config.yml"),
				"task:\n  agentModelOverrides:\n    hot-worker: xai-oauth/grok-4.6:medium\n  enableEffort: false\nretry:\n  modelFallback: false\n",
			);
			await Bun.write(
				path.join(projectDir, ".omp", "agents", "hot-worker.md"),
				"---\nname: hot-worker\ndescription: Newly added worker.\nmodel: openai/gpt-4o\n---\n\nInspect the assignment.\n",
			);

			const policy = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "hot-worker" }));

			expect(policy.modelOverride).toEqual(["xai-oauth/grok-4.6:medium"]);
			expect(cfgTaskEnableEffort.get(liveSettings)).toBe(false);
			expect(cfgRetryModelFallback.get(liveSettings)).toBe(false);
		} finally {
			liveSettings.cancelPendingSaves();
			// `Settings.loadIsolated` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
			AgentStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("resolves only the exact case-sensitive service-tier override into the policy", async () => {
		mockDiscovery({ ...AGENT, name: "scout" });

		const exact = await resolveEffectiveSubagentPolicy(
			request({ session: session({ agentServiceTierOverrides: { scout: "priority" } }), agent: "scout" }),
		);
		expect(exact.serviceTierOverride).toBe("priority");

		const differentCase = await resolveEffectiveSubagentPolicy(
			request({ session: session({ agentServiceTierOverrides: { Scout: "priority" } }), agent: "scout" }),
		);
		expect(differentCase.serviceTierOverride).toBeUndefined();
	});

	it("resolves only the exact case-sensitive compaction threshold override into the policy", async () => {
		mockDiscovery({ ...AGENT, name: "scout" });
		const resolve = (overrides: Record<string, AgentCompactionThresholdOverride>) =>
			resolveEffectiveSubagentPolicy(
				request({ session: session({ agentCompactionThresholdOverrides: overrides }), agent: "scout" }),
			);

		expect((await resolve({ scout: "80%", task: 90000 })).compactionThresholdOverride).toEqual({
			thresholdPercent: 80,
			thresholdTokens: -1,
		});
		expect((await resolve({ Scout: "80%" })).compactionThresholdOverride).toBeUndefined();
		expect((await resolve({ task: 90000 })).compactionThresholdOverride).toBeUndefined();
	});

	it("reloads persisted per-agent service-tier overrides before each launch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-tier-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = session({ cwd: projectDir, settings: liveSettings });
		mockDiscovery({ ...AGENT, name: "scout" });
		const configPath = path.join(agentDir, "config.yml");

		try {
			await Bun.write(configPath, "task:\n  agentServiceTierOverrides:\n    scout: priority\n");
			const first = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "scout" }));
			expect(first.serviceTierOverride).toBe("priority");

			await Bun.write(configPath, "task:\n  agentServiceTierOverrides:\n    scout: none\n");
			const second = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "scout" }));
			expect(second.serviceTierOverride).toBe("none");
		} finally {
			liveSettings.cancelPendingSaves();
			AgentStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("forwards parent-authorized model agents to nested subagent sessions", async () => {
		mockDiscovery();
		const inheritedAgent: AgentDefinition = { ...AGENT, name: "m1", model: ["b/y"] };
		const parentSession = session({ sessionAgents: [inheritedAgent] });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(request({ session: parentSession, retainArtifacts: true }));

		expect(dispatched[0]?.inheritedSessionAgents).toEqual([inheritedAgent]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("starts a level-tagged agent at its tagged effort and other agents at the capped hint", async () => {
		const model = buildModel({
			id: "effort-target",
			name: "Effort Target",
			api: "openai-responses",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const selector = `${model.provider}/${model.id}`;
		mockDiscovery({ ...AGENT, model: [selector], thinkingLevel: Effort.High });
		const tagged: AgentDefinition = { ...AGENT, name: "m1", model: [`${selector}:high`], thinkingLevel: Effort.High };
		const untagged: AgentDefinition = { ...AGENT, name: "m2", model: [selector], thinkingLevel: Effort.Medium };
		const settings = Settings.isolated({ "task.maxEffort": "low", "task.isolation.enabled": false });
		const parent = Object.assign(session({ settings, sessionAgents: [tagged, untagged] }), {
			modelRegistry: { authStorage: {}, refresh: async () => {}, getAvailable: () => [model] },
			getApiKey: async () => "test-key",
		});
		const create = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			const listeners: Array<(event: AgentSessionEvent) => void> = [];
			const child = {
				...createSessionDefaults(),
				state: { messages: [] },
				agent: { state: { systemPrompt: ["test"] } },
				sessionManager: { appendSessionInit: () => {} },
				getActiveToolNames: () => ["read", "yield"],
				getEnabledToolNames: () => ["read", "yield"],
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.push(listener);
					return () => {};
				},
				prompt: async () => {
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: "yield",
							toolName: "yield",
							result: { content: [], details: { status: "success", data: { agent: true } } },
							isError: false,
						});
					}
					return true;
				},
			} as unknown as AgentSession;
			return {
				session: child,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				getToolContext: () => {
					throw new Error("This effort fixture does not execute host-context tools");
				},
				eventBus: new EventBus(),
			};
		});

		for (const agent of ["m1", "m2", "worker"]) {
			await runStructuredSubagent(request({ session: parent, agent, effort: "hi" }));
		}

		expect(create.mock.calls.map(([options]) => options?.thinkingLevel)).toEqual([
			Effort.High,
			Effort.Low,
			Effort.Low,
		]);
		expect(create.mock.calls[0]?.[0]?.thinkingLevelCeiling).toBeUndefined();
	});
	it("holds the parent on an inline child until it settles, but not on a detached one", async () => {
		mockDiscovery();
		const awaits = AgentRegistry.global().awaits;
		const heldDuringRun: boolean[] = [];
		const childIds: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			childIds.push(options.id);
			heldDuringRun.push(awaits.blocksOn("Main", options.id, Date.now()));
			return result();
		});

		const inline = await runStructuredSubagent(request({ detached: false, retainArtifacts: true }));
		const detached = await runStructuredSubagent(request({ detached: true, retainArtifacts: true }));

		expect(heldDuringRun).toEqual([true, false]);
		expect(awaits.blocksOn("Main", childIds[0]!, 0)).toBe(false);
		await fs.rm(inline.artifactsDir, { recursive: true, force: true });
		await fs.rm(detached.artifactsDir, { recursive: true, force: true });
	});
	it("propagates a custom thinking-suffixed role alias through policy, dispatch, and settlement", async () => {
		const customAgent = { ...AGENT, model: ["@reviewer:high"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return { ...result(), modelRole: options.modelRole };
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, agent: "worker", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBe("reviewer");
		expect(dispatched[0]?.modelRole).toBe("reviewer");
		expect(settled.result.modelRole).toBe("reviewer");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("does not treat a spawn handle as the HUD description", async () => {
		mockDiscovery();
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const handleOnly = await runStructuredSubagent(
			request({ identity: { id: "AuthLoader", label: "AuthLoader" }, retainArtifacts: true }),
		);
		expect(dispatched[0]?.description).toBeUndefined();
		expect(dispatched[0]?.id).toBe("AuthLoader");
		await fs.rm(handleOnly.artifactsDir, { recursive: true, force: true });

		dispatched.length = 0;
		const evalLabeled = await runStructuredSubagent(
			request({
				invocationKind: "eval",
				identity: { label: "Refactor the auth flow" },
				retainArtifacts: true,
			}),
		);
		expect(dispatched[0]?.description).toBe("Refactor the auth flow");
		await fs.rm(evalLabeled.artifactsDir, { recursive: true, force: true });
	});

	it("derives modelRole from the raw selector source in request, override, definition order", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const roleSession = session({
			modelRoles: {
				request: "openai/gpt-4o",
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		cfgTaskAgentModelOverrides.override(roleSession.settings, { worker: "@override" });

		const requestPolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession, model: "@request" }));
		expect(requestPolicy.modelRole).toBe("request");

		const overridePolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession }));
		expect(overridePolicy.modelRole).toBe("override");

		const concreteOverrideSession = session({
			modelRoles: {
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		cfgTaskAgentModelOverrides.override(concreteOverrideSession.settings, { worker: "openai/gpt-4o" });
		const concreteOverridePolicy = await resolveEffectiveSubagentPolicy(
			request({ session: concreteOverrideSession }),
		);
		expect(concreteOverridePolicy.modelRole).toBeUndefined();

		const definitionPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ modelRoles: { definition: "openai/gpt-4o" } }) }),
		);
		expect(definitionPolicy.modelRole).toBe("definition");
	});
	it("falls through an empty request selector to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model: "" }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("falls through an empty configured override to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });
		cfgTaskAgentModelOverrides.override(childSession.settings, { worker: "" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});
	it("falls through a configured alias that expands to no patterns", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { empty: "", definition: "openai/gpt-4o" } });
		cfgTaskAgentModelOverrides.override(childSession.settings, { worker: "@empty" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("lets before_subagent_spawn replace model patterns at dispatch without dropping role identity", async () => {
		mockDiscovery({ ...AGENT, model: ["@definition"] });
		const childSession = session({ modelRoles: { definition: "anthropic/claude-opus-4-5" } });
		const events: BeforeSubagentSpawnEvent[] = [];
		childSession.emitBeforeSubagentSpawn = async event => {
			events.push(event);
			return { model: "openai/gpt-4o", note: "pool test" };
		};
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		// Frontend preflight is side-effect free: stateful routers must not advance.
		await resolveEffectiveSubagentPolicy(request({ session: childSession }));
		expect(events).toEqual([]);

		const settled = await runStructuredSubagent(request({ session: childSession, retainArtifacts: true }));
		expect(dispatched[0]).toMatchObject({
			modelOverride: ["openai/gpt-4o"],
			modelRole: "definition",
			modelRoute: "pool test",
		});
		expect(events).toEqual([
			{
				type: "before_subagent_spawn",
				agent: "worker",
				invocationKind: "task",
				modelRole: "definition",
				patterns: ["anthropic/claude-opus-4-5"],
			},
		]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("rejects dispatch before leasing artifacts when an extension blocks the spawn", async () => {
		mockDiscovery();
		const blockedSession = session();
		blockedSession.emitBeforeSubagentSpawn = async () => ({ block: true, reason: "pool exhausted" });
		const run = vi.spyOn(executorModule, "runSubprocess");
		const error = await runStructuredSubagent(request({ session: blockedSession })).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect(error as StructuredSubagentError).toMatchObject({ kind: "preflight", message: "pool exhausted" });
		expect(run).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("does not assign a role when a child uses an explicit model selector", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, model: "openai/gpt-4o", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBeUndefined();
		expect(dispatched[0]?.modelRole).toBeUndefined();
		expect(settled.result.modelRole).toBeUndefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("retains temporary artifacts when the run failed but yielded schema-valid structured output", async () => {
		// Regression: a task can produce schema-valid data and then fail (or
		// exceed its runtime limit). The async notice still advertises the
		// full payload at `agent://<id>` for schema-valid output, so
		// retention must not require `exitCode === 0` too — otherwise the
		// directory is already gone by the time the model follows that URL
		// (PR #10625 review).
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			return {
				...result(),
				exitCode: 1,
				error: "runtime limit exceeded",
				structuredOutput: { source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			};
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.structuredOutput?.status).toBe("valid");
		await expect(fs.stat(settled.artifactsDir)).resolves.toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("uses identical non-plan LSP and IRC policy for task and eval invocations", async () => {
		mockDiscovery();
		const taskPolicy = await resolveEffectiveSubagentPolicy(request());
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval" }));

		expect(evalPolicy.enableLsp).toBe(taskPolicy.enableLsp);
		expect(evalPolicy.enableIrc).toBe(taskPolicy.enableIrc);
	});

	it("rejects an invalid caller schema before executor dispatch in both modes", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("returns a prose answer in one turn when structured task results are disabled", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unstructured-forwarding-"));
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = "structured-subagent-unstructured-regression";
		registerMockApi(sourceId);
		const report = "The direct answer is complete without a yield call.";
		const model = createMockModel({
			id: "structured-subagent-unstructured",
			handler: () => ({ content: [report] }),
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const find = modelRegistry.find.bind(modelRegistry);
		modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
		modelRegistry.getAvailable = () => [model];
		mockDiscovery({
			...AGENT,
			tools: ["read", "yield"],
			model: [`mock/${model.id}`],
		});
		const parentSession = Object.assign(session({ cwd }), {
			authStorage,
			modelRegistry,
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		});
		const agentId = "UnstructuredForwarding";
		let artifactsDir: string | undefined;

		try {
			const settled = await runStructuredSubagent(
				request({
					session: parentSession,
					structured: false,
					identity: { id: agentId },
					keepAlive: false,
				}),
			);
			artifactsDir = settled.artifactsDir;

			expect(model.calls).toHaveLength(1);
			expect(model.calls[0]?.context.tools?.some(tool => tool.name === "yield") ?? false).toBe(false);
			expect(settled.result.exitCode).toBe(0);
			expect(settled.result.output).toBe(report);
			expect(settled.result.structuredOutput).toBeUndefined();
		} finally {
			const ref = AgentRegistry.global().get(agentId);
			try {
				await ref?.session?.dispose();
			} finally {
				try {
					AgentRegistry.global().unregister(agentId);
					if (artifactsDir) await fs.rm(artifactsDir, { recursive: true, force: true });
				} finally {
					unregisterCustomApis(sourceId);
					authStorage.close();
					await fs.rm(root, { recursive: true, force: true });
				}
			}
		}
	});

	it("runs the remaining permitted scout when a plan-mode task omits its agent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-default-scout-"));
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = "plan-default-scout-regression";
		registerMockApi(sourceId);
		const agentId = "PlanModeDefaultScout";
		let artifactDir: string | undefined;
		try {
			const report = "The permitted plan-mode scout returned this answer.";
			const model = createMockModel({
				id: "plan-default-scout",
				handler: () => ({ content: [report] }),
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
			const find = modelRegistry.find.bind(modelRegistry);
			modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
			modelRegistry.getAvailable = () => [model];
			const seanceAgent = getBundledAgent("seance");
			const scoutAgent = getBundledAgent("scout");
			if (!seanceAgent || !scoutAgent) throw new Error("Expected bundled seance and scout agents");
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [
					seanceAgent,
					{
						...scoutAgent,
						model: [`mock/${model.id}`],
						tools: ["read", "yield"],
					},
				],
				projectAgentsDir: null,
			});
			const settings = Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.isolation.enabled": false,
				"task.batch": false,
				"task.structured": false,
				"task.enableLsp": false,
				"task.completionProbe": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"advisor.enabled": false,
				"autolearn.enabled": false,
				"todo.enabled": false,
			});
			const parentSession = Object.assign(session({ cwd, settings, planMode: true, parentSpawns: "seance,scout" }), {
				authStorage,
				modelRegistry,
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
			});
			const task = await TaskTool.create(parentSession);
			const result = await task.execute("plan-default-scout", {
				name: agentId,
				task: "Return the plan-mode scout answer.",
				solutionSpace: "The requested agent choice is a single permitted alternative.",
			});

			artifactDir = AgentRegistry.global().get(agentId)?.sessionFile
				? path.dirname(AgentRegistry.global().get(agentId)!.sessionFile!)
				: undefined;
			expect(result.details?.results).toHaveLength(1);
			expect(result.details?.results[0]?.agent).toBe("scout");
			expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(report);
		} finally {
			const ref = AgentRegistry.global().get(agentId);
			try {
				await ref?.session?.dispose();
			} finally {
				try {
					AgentRegistry.global().unregister(agentId);
					if (artifactDir) await fs.rm(artifactDir, { recursive: true, force: true });
				} finally {
					unregisterCustomApis(sourceId);
					authStorage.close();
					await fs.rm(root, { recursive: true, force: true });
				}
			}
		}
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts when isolation setup fails without recovery", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));

		await expect(
			runStructuredSubagent(
				request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
			),
		).rejects.toThrow("Isolated subagent execution could not be prepared: not a repository");
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses plan capability sources while preserving non-plan propagation", async () => {
		mockDiscovery();
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const extensionPaths = ["/plugins/example.ts"];
		const preparedExtensions = [
			{
				path: extensionPaths[0]!,
				resolvedPath: extensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		] as NonNullable<ToolSession["preparedExtensions"]>;
		const customToolPaths = [{ path: "/tools/example.ts", source: "project" }] as unknown as NonNullable<
			ToolSession["customToolPaths"]
		>;
		const planSession = session({ planMode: true });
		Object.assign(planSession, { mcpManager, extensionPaths, customToolPaths });
		const nonPlanSession = session();
		let explicitRoot = "/plugins/explicit";
		const extensionRoots = () => ({
			explicit: [explicitRoot],
			mode: "explicit-only" as const,
			configured: ["/plugins/configured"],
			configuredLevel: "project" as const,
		});
		Object.assign(nonPlanSession, {
			mcpManager,
			extensionPaths,
			customToolPaths,
			preparedExtensions,
			effectiveExtensionRoots: extensionRoots,
		});
		const mcpDisabledSession = session();
		mcpDisabledSession.enableMCP = false;
		const restrictedSession = session();
		const getApiKey = async () => "exact-account-key";
		Object.assign(restrictedSession, {
			restrictToolNames: true,
			getApiKey,
			mcpManager,
			extensionPaths,
			customToolPaths,
		});
		const options = [] as executorModule.ExecutorOptions[];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const planRun = await runStructuredSubagent(request({ session: planSession, retainArtifacts: true }));
		const nonPlanRun = await runStructuredSubagent(request({ session: nonPlanSession, retainArtifacts: true }));
		const mcpDisabledRun = await runStructuredSubagent(
			request({ session: mcpDisabledSession, retainArtifacts: true }),
		);
		const restrictedRun = await runStructuredSubagent(request({ session: restrictedSession, retainArtifacts: true }));

		expect(options[0]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[0]?.mcpManager).toBeUndefined();
		expect(options[1]).toMatchObject({
			enableMCP: true,
			mcpManager,
			preloadedExtensionPaths: extensionPaths,
			preloadedPreparedExtensions: preparedExtensions,
			preloadedCustomToolPaths: customToolPaths,
		});
		expect(options[1]?.restrictToolNames).toBe(false);
		expect(options[1]?.extensionRoots?.()).toEqual(extensionRoots());
		explicitRoot = "/plugins/explicit-after-spawn";
		expect(options[1]?.extensionRoots?.().explicit).toEqual([explicitRoot]);
		expect(options[2]).toMatchObject({ enableMCP: false });
		expect(options[2]?.mcpManager).toBeUndefined();
		expect(options[3]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[3]?.mcpManager).toBeUndefined();
		expect(options[3]?.getApiKey).toBe(getApiKey);
		await fs.rm(planRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(nonPlanRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(mcpDisabledRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(restrictedRun.artifactsDir, { recursive: true, force: true });
	});

	it("keeps nothing of the spawning session alive in what a parked child retains", async () => {
		// A parked child keeps its spawn options (its revive capture) for as long as it can be
		// revived. Nothing in them may hold the session that spawned it: a lead whose lanes spawn
		// reviewers would otherwise keep every finished lane in memory.
		mockDiscovery();
		const roots = { explicit: [], mode: "merge" as const, configured: [], configuredLevel: "user" as const };
		const extensionRoots = () => roots;
		// createAgentSession gives every tool session its own protocol options; the fallback
		// built from a bare test session would close over that session.
		const localProtocolOptions = { getArtifactsDir: () => null, getSessionId: () => null };
		const descriptor = {
			name: "review_echo",
			description: "Echo a review note.",
			parameters: { type: "object", properties: {} },
			language: "python" as const,
		};
		// What the executor carries past the run; these four end with it.
		const runScoped = new Set(["onProgress", "onToolResult", "onCleanupDeferred", "signal"]);
		const kept: Array<Partial<executorModule.ExecutorOptions>> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			kept.push(Object.fromEntries(Object.entries(executorOptions).filter(([key]) => !runScoped.has(key))));
			return result();
		});
		const spawners: WeakRef<ToolSession>[] = [];
		const spawn = async (): Promise<void> => {
			const parent = session();
			Object.assign(parent, { effectiveExtensionRoots: extensionRoots, localProtocolOptions });
			spawners.push(new WeakRef(parent));
			const customTools = createEvalCustomTools(parent, [descriptor]);
			const run = await runStructuredSubagent(request({ session: parent, customTools, retainArtifacts: true }));
			await fs.rm(run.artifactsDir, { recursive: true, force: true });
		};
		for (let i = 0; i < 3; i++) await spawn();
		// The spy's call log holds each run's whole options; keep only `kept`.
		vi.restoreAllMocks();
		// A WeakRef target read in a job stays alive until that job ends: yield, collect, then read.
		const alive = () => spawners.filter(ref => ref.deref() !== undefined).length;
		let remaining = alive();
		for (let i = 0; i < 10 && remaining > 0; i++) {
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			Bun.gc(true);
			remaining = alive();
		}

		expect(kept).toHaveLength(3);
		for (const options of kept) {
			expect(options.extensionRoots?.()).toBe(roots);
			expect(options.customTools?.map(tool => tool.name)).toEqual(["review_echo"]);
		}
		expect(remaining).toBe(0);
		// With its spawner gone, the child's kernel-defined tool reports itself unavailable.
		const tool = kept[0]!.customTools![0]!;
		const outcome = await tool.execute("call-1", {}, undefined, undefined as never, undefined);
		expect(outcome.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining('The session whose python kernel defined "review_echo" has ended.'),
			},
		]);
	});

	it("unregisters and removes a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		failingSession.agentOutputManager = {
			allocate: async () => {
				throw new Error("allocate failed");
			},
		} as unknown as ToolSession["agentOutputManager"];
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("unregisters and removes a temporary lease when plan reference loading fails", async () => {
		mockDiscovery();
		vi.spyOn(planHandoff, "loadOverallPlanReference").mockRejectedValue(new Error("plan unavailable"));
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request())).rejects.toThrow("Subagent execution failed: plan unavailable");

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed nonisolated handle artifacts", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ invocationKind: "eval", retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("reports a run that failed before yielding as unavailable, not schema-invalid", async () => {
		// Production 2026-09-21: a scout whose model stream died mid-prose
		// ("Anthropic stream envelope error: stream ended before message_stop")
		// was delivered as `Structured output: schema invalid: <provider error>`
		// with its half-streamed text as the offending payload. No payload was
		// ever validated, so the status is "unavailable", the error is the
		// provider's, and the partial prose is not presented as data.
		mockDiscovery();
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue({
			...result(),
			exitCode: 1,
			output: "I'll systematically investigate the codebase",
			stderr: error,
			error,
		});

		const settled = await runStructuredSubagent(request());

		expect(settled.result.structuredOutput).toEqual({
			source: "agent",
			mode: "permissive",
			status: "unavailable",
			error,
		});
		expect(settled.result.structuredOutput).not.toHaveProperty("data");
	});

	it("retains a detached task's artifacts on failure even without valid structured output", async () => {
		// Regression: a detached (async) task job that fails without a valid
		// structured payload previously had its temp dir wiped immediately,
		// breaking the "failed agent stays interrogable" invariant
		// (task/index.ts) — the model could no longer read the failure via
		// agent://<id> or history://<id> (PR #10625 review).
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true, detached: true }));

		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.structuredOutput?.status).toBe("unavailable");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		await expect(fs.stat(artifactsDir ?? "")).resolves.toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("retains isolated failure artifacts needed for recovery", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		});

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);

		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("names the preserved branch when nested persistence fails after a branch commit", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async () => ({
			...result(),
			branchName: "omp/task/Worker",
			branchBaseSha: "base",
			nestedPatches: [{ relativePath: "inner", patch: "diff --git a/b.txt b/b.txt\n" }],
			error: "Nested patch capture failed: ENOSPC. Isolation workspace retained at /wt/abc.",
		}));

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);

		expect(settled.mergeSummary).toContain("omp/task/Worker");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("defaults task isolation to auto-apply and lets config retain artifacts", async () => {
		mockDiscovery();
		const defaultPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);
		expect(defaultPolicy.applyChanges).toBe(true);

		const capturePolicy = await resolveEffectiveSubagentPolicy(
			request({
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(capturePolicy.applyChanges).toBe(false);

		const evalPolicy = await resolveEffectiveSubagentPolicy(
			request({
				invocationKind: "eval",
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(evalPolicy.applyChanges).toBe(true);
	});

	it("retains successful isolated task artifacts when auto-apply is disabled", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), patchPath: "/recovery/Worker.patch" };
		});
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);

		expect(merge).not.toHaveBeenCalled();
		expect(settled.changesApplied).toBeNull();
		expect(settled.mergeSummary).toContain("/recovery/Worker.patch");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});

describe("agent frontmatter structured opt-in", () => {
	const MOCK_API_SOURCE = "test/structured-subagent-opt-in";
	const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;

	function restoreEnvValue(key: string, value: string | undefined): void {
		if (value === undefined) {
			delete process.env[key];
			delete Bun.env[key];
			return;
		}
		process.env[key] = value;
		Bun.env[key] = value;
	}

	/** A user agent whose `output` requires `verdict`; only the frontmatter `structured` flag varies. */
	function agentFile(name: string, structured: boolean): string {
		return [
			"---",
			`name: ${name}`,
			"description: Reports a verdict",
			"model: mock/mock-model",
			...(structured ? ["structured: true"] : []),
			"output:",
			"  properties:",
			"    verdict:",
			"      type: string",
			"  optionalProperties:",
			"    note:",
			"      type: string",
			"---",
			"",
			`Role marker ${name}.`,
		].join("\n");
	}

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-opt-in-"));
		const home = path.join(root, "home");
		await fs.mkdir(home, { recursive: true });
		restoreEnvValue("HOME", home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registerMockApi(MOCK_API_SOURCE);
	});

	afterEach(async () => {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		unregisterCustomApis(MOCK_API_SOURCE);
		// Close native database handles while their isolated agent directory is still active.
		AgentStorage.close();
		closeModelCache();
		// SDK extension loading owns a separate process-wide cache under HOME,
		// not the registry's scoped models.db connection.
		__closeExtensionParseCacheForTests();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	});

	it("does not discover or dispatch an uncached automatic task role in offline mode", async () => {
		vi.spyOn(companyProvider, "isCompanyLaneActive").mockReturnValue(true);
		const cwd = path.join(root, "home", "offline-work");
		await fs.mkdir(cwd, { recursive: true });
		let discoveries = 0;
		let chatRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/v1/models") {
					discoveries++;
					return Response.json({ data: [{ id: "uncached-task-model", context_length: 65_536 }] });
				}
				chatRequests++;
				return Response.json({ error: { message: "Unexpected model dispatch" } }, { status: 500 });
			},
		});
		const authStorage = createInMemoryAuthStorage();
		try {
			const modelsPath = path.join(cwd, "models.yml");
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						"offline-primary": {
							baseUrl: server.url.toString(),
							api: "openai-completions",
							auth: "none",
							discovery: { type: "openai-models-list" },
						},
						"local-parent": {
							baseUrl: server.url.toString(),
							api: "openai-completions",
							auth: "none",
							models: [
								{
									id: "cached-parent",
									name: "Cached Parent",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 65_536,
									maxTokens: 8192,
								},
							],
						},
					},
				}),
			);
			const settings = Settings.isolated({
				modelRoles: { default: "local-parent/cached-parent", task: "offline-primary/uncached-task-model" },
				"retry.fallbackChains": { task: [] },
				"retry.enabled": false,
				"compaction.enabled": false,
				"task.agentIdleTtlMs": 0,
			});
			const modelRegistry = new ModelRegistry(authStorage, modelsPath, { settings });
			const child = await executorModule.runSubprocess({
				cwd,
				agent: { ...AGENT, model: ["@task"], tools: ["read"], output: undefined },
				task: "Inspect the target.",
				index: 0,
				id: "OfflineAutomatic",
				settings,
				modelRegistry,
				authStorage,
				parentActiveModelPattern: "local-parent/cached-parent",
				structured: false,
				enableLsp: false,
				enableIrc: false,
				enableMCP: false,
				preloadedExtensionPaths: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				skills: [],
				promptTemplates: [],
				rules: [],
			});
			expect(child.exitCode).toBe(1);
			expect(child.resolvedModel).toBeUndefined();
			expect(discoveries).toBe(0);
			expect(chatRequests).toBe(0);
			expect(settings.getModelRole("task")).toBe("offline-primary/uncached-task-model");
			expect(settings.getModelRole("default")).toBe("local-parent/cached-parent");
			expect(cfgRetryFallbackChains.get(settings).task).toEqual([]);
		} finally {
			await AgentLifecycleManager.global().dispose();
			authStorage.close();
			await server.stop(true);
		}
	});

	async function withNativeHookFixture(
		body: (fixture: { parent: ToolSession; cwd: string; model: MockModel; worker: AgentDefinition }) => Promise<void>,
		handler: MockModelOptions["handler"],
		isolationEnabled = false,
	): Promise<void> {
		const cwd = path.join(root, "home", "native-hooks");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const model = createMockModel({ handler });
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		modelRegistry.getAvailable = () => [model];
		const find = modelRegistry.find.bind(modelRegistry);
		modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
		const settings = Settings.isolated({
			modelRoles: { default: `mock/${model.id}` },
			"task.structured": false,
			"task.agentIdleTtlMs": 0,
			"task.maxRecursionDepth": 4,
			"task.isolation.enabled": isolationEnabled,
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
		});
		const parent = Object.assign(session({ cwd, settings }), {
			authStorage,
			modelRegistry,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		const worker = { ...AGENT, model: [`mock/${model.id}`], output: undefined, tools: ["read", "task"] };
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [worker, { ...worker, name: "leaf", tools: ["read"] }, getBundledAgent("seance")!],
			projectAgentsDir: null,
		});
		// Observe real SDK creation without installing hooks on the ordinary-child control.
		// One-shot children are not lifecycle-owned; keep their disposal promises reachable too.
		const createSession = sdkModule.createAgentSession;
		const children: AgentSession[] = [];
		const create = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const created = await createSession(options);
			children.push(created.session);
			return created;
		});
		try {
			await body({ parent, cwd, model, worker });
		} finally {
			try {
				await AgentLifecycleManager.global().dispose();
				for (const child of children) await child.dispose();
				await modelRegistry.awaitBackgroundRefresh();
			} finally {
				create.mockRestore();
				model.reset();
				settings.cancelPendingSaves();
				authStorage.close();
			}
		}
	}

	it("absent native hooks preserve an ordinary child read operation", async () => {
		await withNativeHookFixture(
			async ({ parent, cwd, model }) => {
				await fs.writeFile(path.join(cwd, "ordinary.txt"), "ordinary native child evidence");
				const settled = await runStructuredSubagent(
					request({ session: parent, structured: false, keepAlive: false }),
				);
				expect(settled.result.exitCode).toBe(0);
				expect(settled.result.output).toContain("ordinary native child evidence");
				expect(model.calls.length).toBeGreaterThanOrEqual(2);
				expect(artifactsDirsFromRegistry()).toEqual([]);
			},
			context => {
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") {
					return { content: [last.content.map(part => (part.type === "text" ? part.text : "")).join("\n")] };
				}
				return { content: [{ type: "toolCall", name: "read", arguments: { path: "ordinary.txt" } }] };
			},
		);
	}, 30_000);

	it("reports the final invocation result without waiting for warm-child release", async () => {
		await withNativeHookFixture(
			async ({ parent }) => {
				const outcomes: Array<SingleResult | undefined> = [];
				parent.subagentHooks = {
					beforeSpawn: async () => ({ keepAlive: true }),
					configureSession: async () => ({}),
					onSettled: async (_request, result) => {
						outcomes.push(result);
					},
				};
				const result = await runStructuredSubagent(
					request({ session: parent, structured: false, keepAlive: true }),
				);
				expect(outcomes).toEqual([result.result]);
				expect(outcomes[0]?.exitCode).toBe(0);
			},
			() => ({ content: ["real native result"] }),
		);
	}, 30_000);

	it.each([false, true])(
		"awaits settled shared-checkout observations (failure=%s)",
		async fail => {
			await withNativeHookFixture(
				async ({ parent, cwd }) => {
					const observations: string[] = [];
					let observed: SingleResult | undefined;
					parent.subagentHooks = {
						beforeSpawn: async () => ({ keepAlive: false }),
						configureSession: async (_request, options) => {
							expect(options.cwd).toBe(cwd);
							return {};
						},
						beforeCapture: async (_request, nativeResult) => {
							expect(nativeResult.output).toContain("settled shared result");
							await fs.writeFile(path.join(cwd, "observed.txt"), "settled");
							observations.push("before");
						},
						afterResult: async (_request, nativeResult) => {
							expect(await fs.readFile(path.join(cwd, "observed.txt"), "utf8")).toBe("settled");
							expect(nativeResult.patchPath).toBeUndefined();
							observed = nativeResult;
							observations.push("after");
							if (fail) throw new Error("shared persistence rejected");
						},
					};
					const invocation = runStructuredSubagent(
						request({ session: parent, structured: false, keepAlive: true }),
					);
					if (fail) {
						await expect(invocation).rejects.toThrow("shared persistence rejected");
						expect(observed?.outputPath).toBeDefined();
						expect(await Bun.file(observed!.outputPath!).exists()).toBe(true);
						await fs.rm(path.dirname(observed!.outputPath!), { recursive: true, force: true });
					} else {
						expect((await invocation).result).toBe(observed!);
					}
					expect(observations).toEqual(["before", "after"]);
				},
				() => ({ content: ["settled shared result"] }),
			);
		},
		30_000,
	);

	// Cold setup failures must release both the host admission and native resources.
	it.each(["configure", "attached"] as const)(
		"cold native %s failure cleans the child and temporary artifacts without model dispatch",
		async phase => {
			await withNativeHookFixture(
				async ({ parent, model }) => {
					const failure = new Error(`cold ${phase} rejected`);
					const disposed = Promise.withResolvers<void>();
					let created: AgentSession | undefined;
					let reserved = false;
					let configured = 0;
					const failed: unknown[] = [];
					const settled: Array<SingleResult | undefined> = [];
					parent.subagentHooks = {
						beforeSpawn: async () => {
							reserved = true;
							return { keepAlive: false };
						},
						configureSession: async () => {
							configured++;
							if (phase === "configure") throw failure;
							return {
								onSessionCreated: child => {
									created = child;
									child.addDisposer(() => disposed.resolve());
									throw failure;
								},
							};
						},
						onSpawnFailed: async (_request, error) => {
							reserved = false;
							failed.push(error);
							throw new Error("admission cleanup must not replace setup failure");
						},
						onSettled: async (_request, result) => {
							settled.push(result);
						},
					};
					const invocation = await runStructuredSubagent(
						request({ session: parent, structured: false, keepAlive: true }),
					);
					expect(invocation.result.exitCode).toBe(1);
					expect(invocation.result.error).toContain(failure.message);
					expect(configured).toBe(1);
					expect(failed).toEqual([failure]);
					expect(reserved).toBe(false);
					expect(settled).toEqual([invocation.result]);
					expect(model.calls).toHaveLength(0);
					if (phase === "attached") {
						expect(created).toBeDefined();
						await disposed.promise;
					} else {
						expect(created).toBeUndefined();
					}
					expect(AgentRegistry.global().get(invocation.result.id)?.session ?? null).toBeNull();
					expect(AgentLifecycleManager.global().has(invocation.result.id!)).toBe(false);
					expect(artifactsDirsFromRegistry()).toEqual([]);
					await expect(fs.stat(invocation.artifactsDir!)).rejects.toMatchObject({ code: "ENOENT" });
				},
				() => ({ content: ["unexpected dispatch"] }),
			);
		},
		30_000,
	);

	it.each(["configured", "original"] as const)(
		"warm revival disposes the attached session when the %s observer throws",
		async failingObserver => {
			await withNativeHookFixture(
				async ({ parent, cwd, worker }) => {
					const id = "ObserverRevival";
					// Native warm revival is registered only for an artifact-backed persisted child.
					const artifactsDir = path.join(cwd, "observer-revival-artifacts");
					await fs.mkdir(artifactsDir, { recursive: true });
					const failure = new Error(`${failingObserver} revival observer failed`);
					const sessions: sdkModule.CreateAgentSessionResult["session"][] = [];
					const cleaned: sdkModule.CreateAgentSessionResult["session"][] = [];
					let admissions = 0;
					let denyAdmission = false;
					let reserved = false;
					const failedSpawns: unknown[] = [];
					const hooks: NonNullable<executorModule.ExecutorOptions["subagentHooks"]> = {
						beforeSpawn: async () => {
							admissions++;
							if (denyAdmission) throw new Error("renewed admission denied");
							if (reserved) throw new Error("previous revival still owns admission");
							reserved = true;
						},
						onSpawnFailed: async (_child, error) => {
							expect(cleaned).toEqual(sessions);
							reserved = false;
							failedSpawns.push(error);
							throw new Error("cleanup must not replace the observer failure");
						},
						configureSession: async () => ({
							enableMCP: false,
							enableLsp: false,
							enableIrc: false,
							onSessionCreated: child => {
								sessions.push(child);
								const cleanup = () => {
									cleaned.push(child);
								};
								if (sessions.length === 2 && failingObserver === "configured") {
									child.addDisposer(cleanup);
									throw failure;
								}
								return cleanup;
							},
						}),
					};
					const settled = await executorModule.runSubprocess({
						cwd,
						artifactsDir,
						agent: worker,
						task: "Complete the initial child turn.",
						id,
						index: 0,
						structured: false,
						keepAlive: true,
						settings: parent.settings,
						authStorage: parent.authStorage,
						modelRegistry: parent.modelRegistry,
						enableMCP: false,
						enableLsp: false,
						enableIrc: false,
						subagentHooks: hooks,
						subagentRequest: request({ session: parent, structured: false, keepAlive: true }),
						onSessionCreated: () => {
							if (sessions.length === 2 && failingObserver === "original") throw failure;
						},
					});
					expect(settled.exitCode).toBe(0);
					const registry = AgentRegistry.global();
					const lifecycle = AgentLifecycleManager.global();
					expect(registry.get(id)?.sessionFile).toBe(path.join(artifactsDir, `${id}.jsonl`));
					expect(registry.get(id)?.session).toBe(sessions[0]);
					await lifecycle.park(id);
					expect(registry.get(id)?.status).toBe("parked");
					expect(registry.get(id)?.session).toBeNull();
					expect(cleaned).toEqual([sessions[0]]);

					await expect(lifecycle.ensureLive(id)).rejects.toBe(failure);
					expect(sessions).toHaveLength(2);
					expect(admissions).toBe(1);
					expect(cleaned).toEqual(sessions);
					expect(reserved).toBe(false);
					expect(failedSpawns).toEqual([failure]);
					expect(registry.get(id)?.session ?? null).toBeNull();
					expect(registry.get(id)?.status).not.toBe("running");
					denyAdmission = true;
					// A failed setup must never leave a session that bypasses live admission.
					await expect(lifecycle.ensureLive(id)).rejects.toThrow();
					expect(sessions).toHaveLength(2);
					expect(failedSpawns).toEqual([failure]);
				},
				() => ({ content: ["initial child complete"] }),
			);
		},
		30_000,
	);

	it.each(["worker", "seance"])(
		"beforeSpawn rejects %s before seance preparation, artifacts, isolation, or model dispatch",
		async agent => {
			await withNativeHookFixture(
				async ({ parent, model }) => {
					cfgTaskIsolationEnabled.set(parent.settings, true);
					const prepare = vi.spyOn(seanceModule, "prepareSeance");
					const isolate = vi.spyOn(isolationRunner, "prepareIsolationContext");
					const create = vi.spyOn(sdkModule, "createAgentSession");
					const artifacts = vi.fn(() => null);
					parent.getArtifactsDir = artifacts;
					const admission = vi.fn(async () => {
						throw new Error("native admission denied");
					});
					const configureSession = vi.fn<NativeSubagentHooks["configureSession"]>(async () => {
						throw new Error("session configuration must not run after denied admission");
					});
					parent.subagentHooks = { beforeSpawn: admission, configureSession };
					await expect(
						runStructuredSubagent(
							request({
								session: parent,
								agent,
								sourceSession: agent === "seance" ? path.join(root, "missing.jsonl") : undefined,
								isolation: { requested: true },
								structured: false,
								keepAlive: false,
							}),
						),
					).rejects.toThrow("native admission denied");
					expect(admission).toHaveBeenCalledTimes(1);
					expect(configureSession).not.toHaveBeenCalled();
					expect(prepare).not.toHaveBeenCalled();
					expect(artifacts).not.toHaveBeenCalled();
					expect(isolate).not.toHaveBeenCalled();
					expect(create).not.toHaveBeenCalled();
					expect(model.calls).toHaveLength(0);
					expect(artifactsDirsFromRegistry()).toEqual([]);
				},
				() => ({ content: ["unexpected dispatch"] }),
			);
		},
		30_000,
	);

	it.each([
		"capture",
		"apply",
		"branch",
		"subdir",
		"ordinary-subdir",
		"freeze-failure",
		"persist-failure",
		"retained",
	] as const)(
		"observes actual isolated source and preserves callback failures (%s)",
		async mode => {
			await withNativeHookFixture(
				async ({ parent, cwd }) => {
					cfgTaskIsolationEnabled.set(parent.settings, true);
					cfgTaskIsolationCommits.set(parent.settings, "generic");
					if (mode === "apply") cfgTaskIsolationApply.set(parent.settings, false);
					for (const args of [
						["init"],
						["config", "user.email", "native-hooks@example.invalid"],
						["config", "user.name", "Native hook fixture"],
					]) {
						const command = Bun.spawnSync(["git", ...args], { cwd });
						expect(command.exitCode).toBe(0);
					}
					await fs.writeFile(path.join(cwd, "scope.txt"), "isolated fixture");
					if (mode === "subdir" || mode === "ordinary-subdir") {
						const requestedCwd = path.join(cwd, "app");
						await fs.mkdir(requestedCwd);
						await fs.writeFile(path.join(requestedCwd, "scope.txt"), "approved subdir fixture");
						expect(Bun.spawnSync(["git", "add", "app/scope.txt"], { cwd }).exitCode).toBe(0);
						Object.assign(parent, { cwd: requestedCwd });
					}
					expect(Bun.spawnSync(["git", "add", "scope.txt"], { cwd }).exitCode).toBe(0);
					expect(Bun.spawnSync(["git", "commit", "-m", "fixture"], { cwd }).exitCode).toBe(0);
					let configuredCwd: string | undefined;
					let operatedCwd: string | undefined;
					let configuredBeforeDispatch = false;
					const observations: string[] = [];
					let observedResult: SingleResult | undefined;
					parent.subagentHooks = {
						beforeSpawn: async () => ({
							applyChanges: mode === "apply",
							keepAlive: mode === "retained",
							preserveCwd: mode === "subdir" ? true : undefined,
						}),
						configureSession: async (_request, options) => {
							configuredCwd = options.cwd;
							configuredBeforeDispatch = true;
							const probe: CustomTool = {
								name: "scope_probe",
								label: "Scope probe",
								description: "Read the bound workspace.",
								parameters: { type: "object", properties: {} },
								loadMode: "essential",
								execute: async (_id, _params, _update, context) => {
									operatedCwd = context.sessionManager.getCwd();
									await fs.writeFile(path.join(operatedCwd, "child-only.txt"), "child mutation");
									return {
										content: [
											{ type: "text", text: await fs.readFile(path.join(operatedCwd, "scope.txt"), "utf8") },
										],
									};
								},
							};
							return {
								restrictToolNames: true,
								allowRestrictedCustomTools: true,
								toolNames: ["scope_probe"],
								customTools: [probe],
								toolRestrictions: new ToolRestrictions({ allowlist: ["scope_probe"] }),
								enableMCP: false,
								enableLsp: false,
								enableIrc: false,
							};
						},
						beforeCapture: async (_request, nativeResult) => {
							expect(nativeResult.exitCode).toBe(0);
							expect(await fs.readFile(path.join(configuredCwd!, "child-only.txt"), "utf8")).toBe(
								"child mutation",
							);
							await Promise.resolve();
							observations.push("before");
							if (mode === "freeze-failure") throw new Error("freeze rejected");
						},
						afterResult: async (_request, nativeResult) => {
							observedResult = nativeResult;
							observations.push("after");
							if (mode === "freeze-failure") {
								expect(nativeResult.error).toContain("freeze rejected");
								return;
							}
							if (mode === "branch") {
								expect(nativeResult.branchName).toBeDefined();
								const committed = Bun.spawnSync(["git", "show", `${nativeResult.branchName}:child-only.txt`], {
									cwd,
								});
								expect(committed.exitCode).toBe(0);
								expect(committed.stdout.toString()).toBe("child mutation");
							} else {
								expect(await fs.readFile(nativeResult.patchPath!, "utf8")).toContain("child mutation");
								if (mode === "subdir") {
									expect(await fs.readFile(nativeResult.patchPath!, "utf8")).toContain("app/child-only.txt");
								}
							}
							expect(await Bun.file(path.join(configuredCwd!, "child-only.txt")).exists()).toBe(true);
							if (mode === "retained") {
								expect(await fs.readFile(nativeResult.patchPath!, "utf8")).toContain("late mutation");
							}
							if (mode === "persist-failure") throw new Error("persistence rejected");
						},
					};
					const settled = await runStructuredSubagent(
						request({
							session: parent,
							structured: false,
							keepAlive: true,
							isolation: { requested: true, merge: mode === "branch" ? "branch" : "patch" },
						}),
					);
					expect(settled.result.exitCode).toBe(0);
					expect(configuredBeforeDispatch).toBe(true);
					expect(configuredCwd).not.toBe(cwd);
					expect(operatedCwd).toBe(configuredCwd);
					expect(settled.result.output).toContain(
						mode === "subdir" ? "approved subdir fixture" : "isolated fixture",
					);
					if (mode === "subdir") expect(path.basename(configuredCwd!)).toBe("app");
					if (mode === "subdir" || mode === "ordinary-subdir") {
						expect(await Bun.file(path.join(cwd, "app", "child-only.txt")).exists()).toBe(false);
					}
					if (mode === "apply") {
						expect(settled.changesApplied).toBe(true);
						expect(await fs.readFile(path.join(cwd, "child-only.txt"), "utf8")).toBe("child mutation");
					} else {
						expect(await Bun.file(path.join(cwd, "child-only.txt")).exists()).toBe(false);
					}
					expect(cfgTaskIsolationApply.get(parent.settings)).toBe(mode !== "apply");
					if (mode === "retained") {
						expect(observations).toEqual([]);
						await fs.writeFile(path.join(configuredCwd!, "late.txt"), "late mutation");
						await AgentLifecycleManager.global().dispose();
					}
					expect(observations).toEqual(["before", "after"]);
					expect(observedResult).toBe(settled.result);
					if (mode === "freeze-failure" || mode === "persist-failure") {
						expect(settled.result.error).toContain(
							mode === "freeze-failure" ? "freeze rejected" : "persistence rejected",
						);
						const retained = /Isolation workspace retained at (.+)\./.exec(settled.result.error!)?.[1];
						expect(retained).toBeDefined();
						expect(await fs.readFile(path.join(retained!, "child-only.txt"), "utf8")).toBe("child mutation");
						await fs.rm(path.dirname(retained!), { recursive: true, force: true });
					} else {
						expect(settled.result.error).toBeUndefined();
						expect(await Bun.file(path.join(configuredCwd!, "child-only.txt")).exists()).toBe(false);
					}
					if (settled.artifactsDir) await fs.rm(settled.artifactsDir, { recursive: true, force: true });
				},
				context => {
					const names = (context.tools ?? []).map(tool => tool.name);
					expect(names).toContain("scope_probe");
					expect(names).not.toContain("write");
					expect(names).not.toContain("task");
					const last = context.messages.at(-1);
					if (last?.role === "toolResult")
						return { content: [last.content.map(part => (part.type === "text" ? part.text : "")).join("\n")] };
					return { content: [{ type: "toolCall", name: "scope_probe", arguments: {} }] };
				},
				true,
			);
		},
		30_000,
	);

	it("parallel native descendants retain per-invocation hooks through actual nested task calls", async () => {
		const operated: string[] = [];
		const admitted: string[] = [];
		await withNativeHookFixture(
			async ({ parent, worker }) => {
				// 原生 worker 未声明 spawns 时禁止后代；本夹具必须显式授权 leaf，而不是放宽核心策略。
				worker.spawns = ["leaf"];
				let arrivals = 0;
				const { promise: bothConfigured, resolve: release } = Promise.withResolvers<void>();
				function hooks(scope?: string): NativeSubagentHooks {
					return {
						beforeSpawn: async child => {
							if (scope) admitted.push(`${scope}:${child.identity?.label}`);
						},
						configureSession: async (child, options) => {
							const owner = scope ?? child.assignment;
							const leaf = scope !== undefined;
							if (!leaf) {
								if (++arrivals === 2) release();
								await bothConfigured;
							}
							const probe: CustomTool = {
								name: "scope_probe",
								label: "Scope probe",
								description: "Record this child's owner.",
								parameters: { type: "object", properties: {} },
								loadMode: "essential",
								execute: async (_id, _params, _update, context) => {
									expect(context.sessionManager.getCwd()).toBe(options.cwd!);
									operated.push(owner);
									return { content: [{ type: "text", text: owner }] };
								},
							};
							return {
								systemPrompt: `HOOK scope=${owner} tier=${leaf ? "leaf" : "root"}`,
								restrictToolNames: true,
								allowRestrictedCustomTools: true,
								toolNames: leaf ? ["scope_probe"] : ["task"],
								customTools: leaf ? [probe] : [],
								toolRestrictions: new ToolRestrictions({ allowlist: leaf ? ["scope_probe"] : ["task"] }),
								subagentHooks: hooks(owner),
								enableMCP: false,
								enableLsp: false,
								enableIrc: false,
							};
						},
					};
				}
				parent.subagentHooks = hooks();
				const results = await Promise.all(
					["A", "B"].map(assignment =>
						runStructuredSubagent(
							request({
								session: parent,
								assignment,
								structured: false,
								keepAlive: false,
							}),
						),
					),
				);
				expect(results.map(value => value.result.exitCode)).toEqual([0, 0]);
				expect(operated.sort()).toEqual(["A", "B"]);
				expect(admitted.sort()).toEqual(["A:NestedA", "B:NestedB"]);
			},
			context => {
				const system = context.systemPrompt?.join("\n") ?? "";
				const marker = /HOOK scope=([AB]) tier=(root|leaf)/.exec(system);
				if (!marker) throw new Error("Unbound native session in nested hook fixture");
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") {
					if (last.isError) {
						const detail = last.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
						throw new Error(`Nested ${marker[1]} ${last.toolName} failed: ${detail}`);
					}
					expect(last.toolName).toBe(marker[2] === "leaf" ? "scope_probe" : "task");
					return { content: ["complete"] };
				}
				if (marker[2] === "leaf") return { content: [{ type: "toolCall", name: "scope_probe", arguments: {} }] };
				return {
					content: [
						{
							type: "toolCall",
							name: "task",
							arguments: {
								context: "Run the child probe.",
								tasks: [
									{
										agent: "leaf",
										name: `Nested${marker[1]}`,
										task: "Probe.",
										solutionSpace: "one action: invoke probe",
									},
								],
							},
						},
					],
				};
			},
		);
	}, 30_000);
	it.each([
		{ setting: false, structured: { reporter: true, plain: false } },
		{ setting: true, structured: { reporter: true, plain: true } },
	])(
		"task.structured=$setting: yield and schema follow the agent opt-in",
		async ({ setting, structured }) => {
			// Under the isolated HOME so project discovery stops before the developer's real ~/.omp.
			const cwd = path.join(root, "home", "work");
			await fs.mkdir(cwd, { recursive: true });
			const agentsDir = path.join(root, "home", ".omp", "agent", "agents");
			await Bun.write(path.join(agentsDir, "reporter.md"), agentFile("reporter", true));
			await Bun.write(path.join(agentsDir, "plain.md"), agentFile("plain", false));

			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("mock", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const childTools = new Map<string, string[]>();
			const rejections = new Map<string, string>();
			const mock = createMockModel({
				handler: context => {
					const system = context.systemPrompt?.join("\n") ?? "";
					const agent = ["reporter", "plain"].find(name => system.includes(`Role marker ${name}.`));
					if (!agent) return { content: ["label"] };
					const tools = (context.tools ?? []).map(tool => tool.name);
					if (!childTools.has(agent)) childTools.set(agent, tools);
					if (!tools.includes("yield")) return { content: [`${agent} prose report`] };
					const last = context.messages.at(-1);
					if (last?.role === "toolResult" && last.toolName === "yield") {
						if (!last.isError) return { content: ["ok"] };
						rejections.set(agent, last.content.map(part => (part.type === "text" ? part.text : "")).join(""));
						return { content: [{ type: "toolCall", name: "yield", arguments: { data: { verdict: agent } } }] };
					}
					// First attempt omits the required `verdict`.
					return {
						content: [{ type: "toolCall", name: "yield", arguments: { data: { note: "no verdict yet" } } }],
					};
				},
			});
			const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

			const tool = await TaskTool.create({
				cwd,
				hasUI: false,
				settings: Settings.isolated({
					"task.structured": setting,
					"async.enabled": false,
					"task.agentIdleTtlMs": 0,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: { default: "mock/mock-model" },
				}),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				modelRegistry,
				authStorage,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			} as unknown as ToolSession);
			try {
				const result = await tool.execute("tc-opt-in", {
					context: "Report a verdict.",
					tasks: [
						{ agent: "reporter", name: "Reporter", task: "Report.", solutionSpace: "one fix: verdict given" },
						{ agent: "plain", name: "Plain", task: "Report.", solutionSpace: "one fix: verdict given" },
					],
				} as TaskParams);
				const results = new Map((result.details?.results ?? []).map(child => [child.agent, child]));
				for (const [agent, expectStructured] of Object.entries(structured)) {
					const child = results.get(agent);
					expect(child?.exitCode).toBe(0);
					if (expectStructured) {
						expect(childTools.get(agent)).toContain("yield");
						expect(rejections.get(agent)).toContain("does not match schema: verdict: is required");
						expect(child?.structuredOutput).toMatchObject({
							source: "agent",
							status: "valid",
							data: { verdict: agent },
						});
					} else {
						expect(childTools.get(agent)).not.toContain("yield");
						expect(rejections.has(agent)).toBe(false);
						expect(child?.output).toBe(`${agent} prose report`);
						expect(child?.structuredOutput).toBeUndefined();
					}
				}
			} finally {
				authStorage.close();
			}
		},
		30_000,
	);
});

describe("per-call model preflight", () => {
	const target = createMockModel({ id: "target" });
	const painter = { ...createMockModel({ id: "painter" }), kind: "image" as const };
	function perCallSession(settings: Record<string, unknown>, warm = true, refreshPending = false): ToolSession {
		return Object.assign(
			session({
				settings: Settings.isolated({ "task.isolation.enabled": false, "task.maxRecursionDepth": 2, ...settings }),
			}),
			{
				getActiveModelString: () => "mock/parent",
				modelRegistry: {
					getAll: () => [target, painter],
					getAvailable: (kind?: string) => (!warm ? [] : kind === "chat" ? [target] : [target, painter]),
					isBackgroundRefreshPending: () => refreshPending,
				},
			},
		);
	}

	// `off` refuses every kind and `eval` refuses task calls. The selector is invalid on purpose:
	// the disabled gate is reported first, so a caller is never told to fix a selector it may not send.
	it.each([
		["off", "eval"],
		["eval", "task"],
	] as const)("rejects model under task.perCallModel: %s for %s calls", async (mode, invocationKind) => {
		mockDiscovery();
		await expect(
			resolveEffectiveSubagentPolicy(
				request({
					session: perCallSession({ "task.perCallModel": mode }),
					invocationKind,
					perCallModel: "@smol",
				}),
			),
		).rejects.toThrow(`task.perCallModel: ${mode}`);
	});

	it.each([
		["on", "task"],
		["eval", "eval"],
	] as const)("routes an approved model above the agent's own under %s for %s calls", async (mode, invocationKind) => {
		mockDiscovery({ ...AGENT, model: ["mock/agent-own"] });
		const policy = await resolveEffectiveSubagentPolicy(
			request({
				session: perCallSession({ "task.perCallModel": mode, modelRoles: { review: "mock/target" } }),
				invocationKind,
				perCallModel: "mock/target:high",
			}),
		);
		expect(policy.modelOverride).toEqual(["mock/target:high"]);
		// A requested model never falls back to the parent's.
		expect(policy.parentActiveModelPattern).toBeUndefined();
	});

	it.each(["SDK overlay", "nested subagent"])("reloads removed on-disk role grants through an %s", async kind => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-grant-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(projectDir, { recursive: true });
		const configPath = path.join(agentDir, "config.yml");
		const taskConfig = 'task:\n  perCallModel: "on"\n  isolation:\n    enabled: false\n';
		await Bun.write(configPath, `${taskConfig}modelRoles:\n  review: mock/target\n`);
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const child = executorModule.createSubagentSettings(liveSettings, {
			modelRoles: { ...liveSettings.getModelRoles(), advisor: "mock/other" },
		});
		const settings = kind === "SDK overlay" ? liveSettings.overlay({}) : executorModule.createSubagentSettings(child);
		const liveSession = Object.assign(perCallSession({}), { cwd: projectDir, settings });
		const call = request({ session: liveSession, perCallModel: "mock/target:high" });
		mockDiscovery();

		try {
			expect((await resolveEffectiveSubagentPolicy(call)).modelOverride).toEqual(["mock/target:high"]);
			await Bun.write(configPath, taskConfig);
			await expect(resolveEffectiveSubagentPolicy(call)).rejects.toThrow(
				'Per-call model mock/target is not approved for agent "worker"',
			);
		} finally {
			liveSettings.cancelPendingSaves();
			AgentStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["a selector that is not provider/model-id", "@smol", {}, false, /invalid `model`/],
		// Shaped like provider/model-id, but names the configured custom role `review`.
		["a legacy alias of a custom role", "pi/review", {}, false, /invalid `model`/],
		["an unavailable model", "mock/missing", {}, false, /No available model matches/],
		["a non-chat model", "mock/painter", {}, false, /image model; a subagent needs a chat model/],
		["a non-chat model while discovery is running", "mock/painter", {}, true, /image model/],
		["an unapproved model", "mock/target", { modelRoles: {} }, false, /not approved/],
		[
			"a model for an agent with an override",
			"mock/target",
			{ "task.agentModelOverrides": { worker: "mock/target" } },
			false,
			/conflicts with task\.agentModelOverrides/,
		],
	] as const)("rejects %s", async (_name, perCallModel, settings, refreshPending, error) => {
		mockDiscovery();
		await expect(
			resolveEffectiveSubagentPolicy(
				request({
					session: perCallSession(
						{ "task.perCallModel": "on", modelRoles: { review: "mock/x" }, ...settings },
						true,
						refreshPending,
					),
					perCallModel,
				}),
			),
		).rejects.toThrow(error);
	});

	// Both defer to the executor's post-refresh check: an unloaded model while discovery runs,
	// and availability plus approval while the registry is cold.
	it.each([
		["a model discovery has not loaded yet", "mock/missing", true, true],
		["an unapproved model while the registry is cold", "mock/target", false, false],
	] as const)("defers %s to the executor", async (_name, perCallModel, warm, refreshPending) => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: perCallSession({ "task.perCallModel": "on" }, warm, refreshPending), perCallModel }),
		);
		expect(policy.modelOverride).toEqual([perCallModel]);
		expect(policy.perCallModelGrants).toBeDefined();
	});

	it("leaves calls without model on their configured routing", async () => {
		mockDiscovery({ ...AGENT, model: ["mock/agent-own"] });
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: perCallSession({ "task.perCallModel": "on" }) }),
		);
		expect(policy.modelOverride).toEqual(["mock/agent-own"]);
		expect(policy.perCallModelGrants).toBeUndefined();
		expect(policy.parentActiveModelPattern).toBe("mock/parent");
	});

	it("rejects a per-call model for a level-tagged agent, even its own selector", async () => {
		mockDiscovery();
		const tagged: AgentDefinition = { ...AGENT, name: "m1", model: ["mock/target:high"], thinkingLevel: Effort.High };
		const taggedSession = Object.assign(perCallSession({ "task.perCallModel": "on", "task.maxEffort": "low" }), {
			getSessionAgents: () => [tagged],
		});
		const error = await resolveEffectiveSubagentPolicy(
			request({ session: taggedSession, agent: "m1", perCallModel: "mock/target:high" }),
		).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect((error as StructuredSubagentError).kind).toBe("preflight");
		expect((error as Error).message).toContain('agent "m1"');
		expect((error as Error).message).toContain("Omit model");
	});

	it("routes a per-call model for an untagged mention through its own model grant", async () => {
		mockDiscovery();
		const untagged: AgentDefinition = { ...AGENT, name: "m2", model: ["mock/target"], thinkingLevel: "auto" };
		const untaggedSession = Object.assign(perCallSession({ "task.perCallModel": "on" }), {
			getSessionAgents: () => [untagged],
		});
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: untaggedSession, agent: "m2", perCallModel: "mock/target:low" }),
		);
		expect(policy.modelOverride).toEqual(["mock/target:low"]);
	});

	it("treats a discovered agent's frontmatter level as its own, not a user tag", async () => {
		mockDiscovery({ ...AGENT, name: "m1", source: "project", thinkingLevel: Effort.High });
		const tagged: AgentDefinition = { ...AGENT, name: "m1", model: ["mock/target:high"], thinkingLevel: Effort.High };
		const shadowedSession = Object.assign(
			perCallSession({ "task.perCallModel": "on", modelRoles: { review: "mock/target" } }),
			{ getSessionAgents: () => [tagged] },
		);
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: shadowedSession, agent: "m1", perCallModel: "mock/target:low" }),
		);
		expect(policy.modelOverride).toEqual(["mock/target:low"]);
	});

	describe("an agent shadowing the seance name", () => {
		const shadow: AgentDefinition = { ...AGENT, name: "seance", source: "project", model: ["mock/agent-own"] };

		it.each([
			["the per-call gate", "off", "mock/target", "task.perCallModel: off"],
			["exact-selector validation", "on", ["mock/target"], /invalid `model`/],
		] as const)("holds its model to %s", async (_name, mode, seanceModel, error) => {
			mockDiscovery(shadow);
			await expect(
				resolveEffectiveSubagentPolicy(
					request({
						session: perCallSession({ "task.perCallModel": mode, modelRoles: { review: "mock/target" } }),
						agent: "seance",
						seanceModel: typeof seanceModel === "string" ? seanceModel : [...seanceModel],
					}),
				),
			).rejects.toThrow(error);
		});

		it("routes an approved model as a per-call worker", async () => {
			mockDiscovery(shadow);
			const policy = await resolveEffectiveSubagentPolicy(
				request({
					session: perCallSession({ "task.perCallModel": "on", modelRoles: { review: "mock/target" } }),
					agent: "seance",
					seanceModel: "mock/target",
				}),
			);
			expect(policy.modelOverride).toEqual(["mock/target"]);
			expect(policy.perCallModelGrants?.agentName).toBe("seance");
		});
	});
});
