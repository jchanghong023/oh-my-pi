import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentPauseGate } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import {
	SUBAGENT_WORKER_THRESHOLD,
	SubagentWorkerPool,
	setSubagentWorkerPoolForTests,
} from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import { __resetDirsFromEnvForTests, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const API_SOURCE = "test/executor-pause-placement";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined>;
let temp: TempDir;
let pool: SubagentWorkerPool;
const cleanups: Array<() => void | Promise<void>> = [];

/** Signals an actual loop pause, without timers or polling session internals. */
class ObservedPauseGate extends AgentPauseGate {
	readonly waiting = Promise.withResolvers<void>();

	override async waitUntilResumed(signal?: AbortSignal): Promise<void> {
		if (this.paused) this.waiting.resolve();
		await super.waitUntilResumed(signal);
	}
}

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	temp = TempDir.createSync("omp-pause-placement-");
	const home = temp.join("home");
	const agentDir = path.join(home, ".omp", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(temp.join("artifacts"), { recursive: true });
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(API_SOURCE);
	pool = new SubagentWorkerPool({ maxWorkers: () => 1 });
	setSubagentWorkerPoolForTests(pool);
	// The next ordinary placement crosses the real worker threshold.
	for (let i = 1; i < SUBAGENT_WORKER_THRESHOLD; i++) cleanups.push(pool.beginMainRun());
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	setSubagentWorkerPoolForTests(undefined);
	pool.dispose();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(API_SOURCE);
	vi.restoreAllMocks();
	AgentStorage.close();
	closeModelCache();
	for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await temp.remove();
});

async function createOwner(name: string, pauseGate: AgentPauseGate) {
	const cwd = temp.join(name);
	await fs.mkdir(cwd, { recursive: true });
	const registry = new AgentRegistry();
	const authStorage = createInMemoryAuthStorage();
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("mock", "test-key");
	const model = createMockModel({ handler: { content: ["completed"] } });
	const modelRegistry = new ModelRegistry(authStorage, temp.join("models.yml"));
	const available = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [model, ...available(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: temp.join("home", ".omp", "agent"),
		agentRegistry: registry,
		pauseGate,
		authStorage,
		modelRegistry,
		model,
		settings,
		sessionManager: SessionManager.inMemory(cwd),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
	});
	cleanups.push(async () => {
		pauseGate.resume();
		await AgentRegistry.runScoped(registry, () => AgentLifecycleManager.global().dispose());
		await session.dispose();
	});
	const run = (id: string) =>
		AgentRegistry.runScoped(registry, () =>
			runSubprocess({
				cwd,
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
				task: "report completed",
				index: 0,
				id,
				structured: false,
				modelOverride: "mock/mock-model",
				authStorage,
				modelRegistry,
				settings,
				artifactsDir: temp.join("artifacts"),
				extensionRoots: () => session.effectiveExtensionRoots,
				preloadedPreparedExtensions: [],
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			}),
		);
	return { registry, session, authStorage, modelRegistry, model, settings, run };
}

it("keeps fresh gated children paused above the worker threshold without pausing another root", async () => {
	const gate = new ObservedPauseGate();
	const owner = await createOwner("owner", gate);
	const sibling = await createOwner("sibling", new AgentPauseGate());
	gate.pause();
	const run = owner.run("PausedChild");
	await Promise.race([
		gate.waiting.promise,
		run.then(result => {
			throw new Error(`Child finished before reaching its pause gate: ${result.error ?? result.output}`);
		}),
	]);
	expect(owner.model.calls).toHaveLength(0);
	expect(pool.mainRuns).toBe(SUBAGENT_WORKER_THRESHOLD);
	await sibling.session.prompt("independent root");
	expect(sibling.model.calls).toHaveLength(1);
	expect(owner.model.calls).toHaveLength(0);
	gate.resume();
	const result = await run;
	expect(result.exitCode).toBe(0);
	expect(result.output).toContain("completed");
	expect(owner.model.calls).toHaveLength(1);
	expect(pool.mainRuns).toBe(SUBAGENT_WORKER_THRESHOLD - 1);
	expect(pool.workers()).toHaveLength(0);
});

it("cold-revives a gated child on its owner's thread even when called from another registry", async () => {
	const gate = new ObservedPauseGate();
	const owner = await createOwner("revive-owner", gate);
	expect((await owner.run("RevivedChild")).exitCode).toBe(0);
	const revive = await AgentRegistry.runScoped(owner.registry, async () => {
		await AgentLifecycleManager.global().park("RevivedChild");
		const ref = owner.registry.get("RevivedChild");
		if (!ref) throw new Error("Missing parked child");
		const factory = createPersistedSubagentReviverFactory({ ...owner, enableLsp: false });
		const reviver = await factory(ref);
		if (!reviver) throw new Error("Missing persisted reviver");
		return () => reviver(ref);
	});
	gate.pause();
	const revived = localSession(await AgentRegistry.runScoped(new AgentRegistry(), revive));
	cleanups.push(() => revived.dispose());
	expect(pool.mainRuns).toBe(SUBAGENT_WORKER_THRESHOLD - 1);
	const prompt = revived.prompt("continue");
	await Promise.race([
		gate.waiting.promise,
		prompt.then(() => {
			throw new Error("Revived child finished before reaching its pause gate");
		}),
	]);
	expect(owner.model.calls).toHaveLength(1);
	gate.resume();
	await prompt;
	expect(owner.model.calls).toHaveLength(2);
	expect(revived.getLastAssistantText()).toContain("completed");
	expect(pool.workers()).toHaveLength(0);
});

it("still places ungated private and process roots on workers and releases their run counts", async () => {
	const privatePlacement = await AgentRegistry.runScoped(new AgentRegistry(), () => pool.acquire());
	const processPlacement = await pool.acquire();
	try {
		expect(privatePlacement.worker).toBeDefined();
		expect(processPlacement.worker).toBeDefined();
		expect(await privatePlacement.worker!.link.call("ping", 42)).toBe(42);
		expect(pool.mainRuns).toBe(SUBAGENT_WORKER_THRESHOLD - 1);
		expect(pool.runsInFlight).toBe(SUBAGENT_WORKER_THRESHOLD + 1);
	} finally {
		privatePlacement.release();
		privatePlacement.release();
		processPlacement.release();
	}
	expect(pool.runsInFlight).toBe(SUBAGENT_WORKER_THRESHOLD - 1);
});
