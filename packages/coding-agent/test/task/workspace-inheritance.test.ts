import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	createMockModel,
	registerMockApi,
	type MockModel,
	type MockModelOptions,
} from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { __closeExtensionParseCacheForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import {
	runStructuredSubagent,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { WORKSPACE_MODE_STATE_TYPE, type WorkspaceModeState } from "@oh-my-pi/pi-coding-agent/workspace-mode";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { __resetDirsFromEnvForTests, removeWithRetries, resolveEquivalentPath, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const API_SOURCE = "test/workspace-inheritance";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let root: string;
let savedEnv: Record<string, string | undefined>;
const cleanups: Array<() => Promise<void>> = [];

function env(key: string, value: string | undefined): void {
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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-inheritance-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	env("HOME", home);
	for (const key of ENV_KEYS.slice(1)) env(key, undefined);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(API_SOURCE);
});

afterEach(async () => {
	try {
		await AgentLifecycleManager.global().dispose();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		unregisterCustomApis(API_SOURCE);
		AgentStorage.close();
		closeModelCache();
		__closeExtensionParseCacheForTests();
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) env(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	}
});

function text(message: Message): string {
	return typeof message.content === "string"
		? message.content
		: message.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

function lastConversationalMessage(messages: readonly Message[]): Message | undefined {
	return messages.findLast(message => ["user", "assistant", "toolResult"].includes(message.role));
}

function localRoot(session: AgentSession): string {
	return resolveEquivalentPath(
		resolveLocalRoot({
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		}),
		{ throughMissing: true },
	);
}

// Identify the actual hidden request message by resolved session/system temporary paths,
// not the assistant's response, option echoes, or a fixed paragraph of prompt prose.
function reminders(messages: readonly Message[], session: AgentSession): string[] {
	return messages
		.map(text)
		.filter(value => value.includes(localRoot(session)) && value.includes(canonical(os.tmpdir())));
}

function canonical(value: string): string {
	return resolveEquivalentPath(value, { throughMissing: true });
}

interface Fixture {
	parent: ToolSession;
	model: MockModel;
	children: AgentSession[];
	cwd: string;
	project: string;
	extra: string;
	setState(state: WorkspaceModeState): void;
	spawn(overrides?: Partial<StructuredSubagentRequest>): ReturnType<typeof runStructuredSubagent>;
	coldOwner: AgentSession;
	auth: ReturnType<typeof createInMemoryAuthStorage>;
	registry: ModelRegistry;
	settings: Settings;
}

async function fixture(
	handler: MockModelOptions["handler"] = () => ({ content: ["done"] }),
	{ isolationEnabled = false }: { isolationEnabled?: boolean } = {},
): Promise<Fixture> {
	const cwd = path.join(root, "home", "untrusted-cwd");
	const project = path.join(root, "home", "parent-project");
	const extra = path.join(root, "home", "additional-project");
	const artifacts = path.join(root, "artifacts");
	await Promise.all([cwd, project, extra, artifacts].map(dir => fs.mkdir(dir, { recursive: true })));
	await fs.writeFile(path.join(cwd, "scope.txt"), "native child read evidence");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const model = createMockModel({ handler });
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
	registry.getAvailable = () => [model];
	const find = registry.find.bind(registry);
	registry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
	const settings = Settings.isolated({
		modelRoles: { default: `mock/${model.id}` },
		"task.structured": false,
		"task.agentIdleTtlMs": 0,
		"task.maxRecursionDepth": 4,
		"task.isolation.enabled": isolationEnabled,
		"task.isolation.apply": false,
		"task.isolation.commits": "generic",
		"isolation.backend": "rcopy",
		"workspace.additionalDirectories": [extra],
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
	});
	const worker: AgentDefinition = {
		name: "worker",
		description: "Workspace test worker",
		systemPrompt: "WORKSPACE_WORKER",
		source: "bundled",
		model: [`mock/${model.id}`],
		tools: ["read", "task"],
		spawns: ["leaf"],
	};
	const leaf: AgentDefinition = {
		...worker,
		name: "leaf",
		systemPrompt: "WORKSPACE_LEAF",
		tools: ["read"],
		spawns: [],
	};
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [worker, leaf], projectAgentsDir: null });
	const main = SessionManager.create(cwd, path.join(root, "main-sessions"));
	main.appendMessage({ role: "user", content: "delegate", timestamp: Date.now() });
	await main.flush();
	let state: WorkspaceModeState = { enabled: true, inheritedScope: { projectRoot: project, allowedRoots: [project] } };
	const parent = {
		cwd,
		hasUI: false,
		settings,
		authStorage: auth,
		modelRegistry: registry,
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
		getSessionFile: () => main.getSessionFile(),
		getArtifactsDir: () => artifacts,
		getSessionId: () => main.getSessionId(),
		getSessionSpawns: () => "*",
		getSessionAgents: () => [worker, leaf],
		getWorkspaceModeSnapshot: async () => structuredClone(state),
	} as unknown as ToolSession;
	const children: AgentSession[] = [];
	const create = sdk.createAgentSession;
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
		const result = await create(options);
		children.push(result.session);
		return result;
	});
	const coldOwner = {
		sessionManager: main,
		settings,
		getSessionAgents: () => [worker, leaf],
		getWorkspaceModeSnapshot: async () => structuredClone(state),
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
	} as unknown as AgentSession;
	cleanups.push(async () => {
		for (const child of children) await child.dispose();
		await main.close();
		await registry.awaitBackgroundRefresh();
		model.reset();
		settings.cancelPendingSaves();
		auth.close();
	});
	return {
		parent,
		model,
		children,
		cwd,
		project,
		extra,
		coldOwner,
		auth,
		registry,
		settings,
		setState: next => {
			state = next;
		},
		spawn: overrides =>
			runStructuredSubagent({
				session: parent,
				invocationKind: "task",
				assignment: "Inspect scope.txt",
				agent: "worker",
				structured: false,
				keepAlive: true,
				...overrides,
			}),
	};
}

function expectScope(messages: readonly Message[], child: AgentSession, f: Fixture, extraRoots: string[] = []): void {
	const active = reminders(messages, child);
	expect(active).toHaveLength(1);
	for (const allowed of [f.project, ...extraRoots]) expect(active[0]).toContain(canonical(allowed));
	expect(active[0]).not.toContain(canonical(f.extra));
	if (!extraRoots.includes(f.cwd)) expect(active[0]).not.toContain(canonical(f.cwd));
}

describe("native workspace subagent inheritance", () => {
	it.each(["task", "eval"] as const)(
		"%s leaves ordinary disabled children without an active reminder",
		async invocationKind => {
			const f = await fixture();
			f.setState({ enabled: false });
			const result = await f.spawn({ invocationKind });
			expect(result.result.exitCode, [result.result.error, result.result.stderr].filter(Boolean).join("\n")).toBe(0);
			expect(f.model.calls.length).toBeGreaterThan(0);
			const child = f.children[0];
			for (const call of f.model.calls) expect(reminders(call.context.messages, child)).toHaveLength(0);
			expect(child.model?.provider).toBe("mock");
			expect(child.getEnabledToolNames()).toContain("read");
			expect(child.getEnabledToolNames()).toContain("task");
			expect(cfgToolsApprovalMode.get(child.settings)).toBe("yolo");
		},
		30_000,
	);

	it.each(["task", "eval"] as const)(
		"%s captures dispatch-time scope and keeps it after the parent toggles",
		async invocationKind => {
			const f: Fixture = await fixture(context => {
				if (lastConversationalMessage(context.messages)?.role === "toolResult") return { content: ["done"] };
				f.setState({ enabled: false });
				return { content: [{ type: "toolCall", name: "read", arguments: { path: "scope.txt" } }] };
			});
			// Resolution precedes actual spawn. A getter captured while constructing tools
			// would miss this update at the native discovery boundary.
			f.setState({ enabled: false });
			vi.spyOn(discovery, "discoverAgents").mockImplementation(async () => {
				const result = { agents: [...f.parent.getSessionAgents!()], projectAgentsDir: null };
				f.setState({ enabled: true, inheritedScope: { projectRoot: f.project, allowedRoots: [f.project] } });
				return result;
			});
			const result = await f.spawn({ invocationKind });
			expect(result.result.exitCode, [result.result.error, result.result.stderr].filter(Boolean).join("\n")).toBe(0);
			const child = f.children[0];
			const calls = f.model.calls.filter(call => call.context.tools?.some(tool => tool.name === "read"));
			expect(calls.length).toBeGreaterThanOrEqual(2);
			for (const call of calls) expectScope(call.context.messages, child, f);
			expect(
				calls.some(call =>
					call.context.messages.some(
						message => message.role === "toolResult" && text(message).includes("native child read evidence"),
					),
				),
			).toBe(true);
			expect(child.model?.provider).toBe("mock");
			expect(child.getEnabledToolNames()).toContain("read");
			expect(child.getEnabledToolNames()).toContain("task");
			expect(cfgToolsApprovalMode.get(child.settings)).toBe("yolo");
		},
		30_000,
	);

	it("inherits recursively through the child's real SDK task tool without trusting its cwd", async () => {
		const f = await fixture(context => {
			const last = lastConversationalMessage(context.messages);
			if (last?.role === "toolResult") {
				if (last.isError) throw new Error(text(last));
				return { content: ["done"] };
			}
			if (context.systemPrompt?.join("\n").includes("WORKSPACE_LEAF")) return { content: ["leaf done"] };
			return {
				content: [
					{
						type: "toolCall",
						name: "task",
						arguments: {
							context: "Inspect inherited scope",
							tasks: [
								{
									agent: "leaf",
									name: "InheritedLeaf",
									task: "Report scope",
									solutionSpace: "one action: report",
								},
							],
						},
					},
				],
			};
		});
		const result = await f.spawn();
		expect(result.result.exitCode, [result.result.error, result.result.stderr].filter(Boolean).join("\n")).toBe(0);
		const leaf = f.children.find(child => child.agent.state.systemPrompt.join("\n").includes("WORKSPACE_LEAF"));
		expect(leaf).toBeDefined();
		const leafCalls = f.model.calls.filter(call => call.context.systemPrompt?.join("\n").includes("WORKSPACE_LEAF"));
		expect(leafCalls.length).toBeGreaterThan(0);
		for (const call of leafCalls) expectScope(call.context.messages, leaf!, f);
	}, 30_000);

	it("authorizes an actual OMP native isolation directory, not an arbitrary child cwd", async () => {
		const f = await fixture(
			context =>
				lastConversationalMessage(context.messages)?.role === "toolResult"
					? { content: ["done"] }
					: { content: [{ type: "toolCall", name: "read", arguments: { path: "scope.txt" } }] },
			{ isolationEnabled: true },
		);
		const gitDir = path.join(f.cwd, ".git");
		await fs.mkdir(path.join(gitDir, "objects"), { recursive: true });
		await fs.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
		await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
		const repository = vcs.requireGit(f.cwd);
		await repository.configSet("user.name", "Workspace fixture");
		await repository.configSet("user.email", "workspace@example.invalid");
		await repository.configSet("commit.gpgsign", "false");
		await repository.configSet("core.hooksPath", path.join(gitDir, "hooks").replaceAll("\\", "/"));
		await repository.stageFiles(["scope.txt"]);
		await repository.commitCreate("fixture", {});
		const result = await f.spawn({ keepAlive: false, isolation: { requested: true, apply: false } });
		expect(result.result.exitCode, [result.result.error, result.result.stderr].filter(Boolean).join("\n")).toBe(0);
		expect(result.result.isolated).toBe(true);
		const child = f.children[0];
		const allocated = child.sessionManager.getCwd();
		expect(canonical(allocated)).not.toBe(canonical(f.cwd));
		const calls = f.model.calls.filter(call => call.context.tools?.some(tool => tool.name === "read"));
		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const call of calls) expectScope(call.context.messages, child, f, [allocated]);
		expect(
			calls.some(call =>
				call.context.messages.some(
					message => message.role === "toolResult" && text(message).includes("native child read evidence"),
				),
			),
		).toBe(true);
	}, 30_000);

	it("warm and cold revival retain persisted child scope despite later parent changes", async () => {
		const f = await fixture();
		const initial = await f.spawn({ identity: { id: "WorkspaceRevive" } });
		expect(initial.result.exitCode, [initial.result.error, initial.result.stderr].filter(Boolean).join("\n")).toBe(0);
		const id = initial.result.id;
		f.setState({ enabled: false });
		await AgentLifecycleManager.global().park(id);
		const warm = localSession(await AgentLifecycleManager.global().ensureLive(id));
		let start = f.model.calls.length;
		await warm.prompt("warm user continuation");
		expect(f.model.calls.length).toBeGreaterThan(start);
		for (const call of f.model.calls.slice(start)) expectScope(call.context.messages, warm, f);
		await AgentLifecycleManager.global().park(id);
		const ref = AgentRegistry.global().get(id);
		if (!ref) throw new Error("Missing persisted child registry ref");
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		const coldRef = AgentRegistry.global().register({ ...ref, session: null, status: "parked" });
		// Simulate a new process's factory: no executor adoption/reviver closure survives.
		f.setState({ enabled: true, inheritedScope: { projectRoot: f.extra, allowedRoots: [f.extra] } });
		const factory = createPersistedSubagentReviverFactory({
			session: f.coldOwner,
			authStorage: f.auth,
			modelRegistry: f.registry,
			settings: f.settings,
			enableLsp: false,
		});
		const revive = await factory(coldRef);
		if (!revive) throw new Error("Expected cold persisted reviver");
		const cold = localSession(await revive(coldRef));
		start = f.model.calls.length;
		await cold.prompt("cold user continuation");
		expect(f.model.calls.length).toBeGreaterThan(start);
		for (const call of f.model.calls.slice(start)) expectScope(call.context.messages, cold, f);
		expect(cold.model?.provider).toBe("mock");
		expect(cold.getEnabledToolNames()).toContain("read");
		expect(cfgToolsApprovalMode.get(cold.settings)).toBe("yolo");
	}, 30_000);

	it("keeps legacy child logs without workspace metadata off even under an enabled parent", async () => {
		const f = await fixture();
		const file = path.join(root, "artifacts", "LegacyWorkspace.jsonl");
		const manager = await SessionManager.open(file, undefined, undefined, {
			initialCwd: f.cwd,
			suppressBreadcrumb: true,
		});
		manager.appendSessionInit({
			systemPrompt: ["legacy child"],
			task: "legacy task",
			tools: ["read"],
			agent: "leaf",
			resolvedModel: "mock/mock-model",
		});
		manager.appendMessage({ role: "user", content: "legacy user", timestamp: Date.now() });
		await manager.close();
		const ref = AgentRegistry.global().register({
			id: "LegacyWorkspace",
			displayName: "LegacyWorkspace",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
			createdAt: 0,
			lastActivity: 0,
		});
		const factory = createPersistedSubagentReviverFactory({
			session: f.coldOwner,
			authStorage: f.auth,
			modelRegistry: f.registry,
			settings: f.settings,
			enableLsp: false,
		});
		const revive = await factory(ref);
		if (!revive) throw new Error("Expected legacy persisted reviver");
		const child = localSession(await revive(ref));
		await child.prompt("legacy continuation");
		expect(f.model.calls.length).toBeGreaterThan(0);
		for (const call of f.model.calls) expect(reminders(call.context.messages, child)).toHaveLength(0);
		expect(
			child.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === WORKSPACE_MODE_STATE_TYPE),
		).toBe(false);
	}, 30_000);
});
