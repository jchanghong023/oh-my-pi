import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	type AgentSessionStartupCleanupFailure,
	type CreateAgentSessionOptions,
	createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { getTestModel } from "./helpers/model-fixtures";

// Regression: a keep-alive subagent's AgentSession is disposed at park() but
// stays reachable through the lifecycle adoption record's reviver closure
// (which shares the runSubagent lexical environment that captured the live
// session). Before the fix, dispose() left the message array, append-only
// provider transcript, session-manager entries, and the raw-SSE debug buffer
// intact, so every completed subagent pinned duplicate transcripts and captured
// wire frames. dispose() must shed that heavy state so the pinned graph is only a husk.
// See issue #8003.
describe("AgentSession dispose releases retained memory", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dispose-release-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(getTestModel("ascend").provider, "test-key");
	});

	afterEach(async () => {
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createSession(): AgentSession {
		const model = getTestModel("ascend");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			agentId: "Main",
		});
		return session;
	}

	it("releases all in-memory transcript copies and the raw-SSE buffer on dispose", async () => {
		const current = createSession();
		const bulk = "x".repeat(4096);

		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: bulk }], timestamp: Date.now() },
		];
		current.agent.replaceMessages(messages);
		const appendOnlyContext = new AppendOnlyContextManager();
		appendOnlyContext.syncMessages([{ role: "user", content: bulk }]);
		current.agent.setAppendOnlyContext(appendOnlyContext);
		current.sessionManager.appendMessage({ role: "user", content: bulk, timestamp: Date.now() });
		current.rawSseDebugBuffer.recordEvent(
			{
				event: "content_block_delta",
				data: `data: ${bulk}`,
				raw: ["event: content_block_delta", `data: ${bulk}`],
			},
			current.agent.state.model,
		);

		// Precondition: the heavy state is actually present before dispose.
		expect(current.agent.state.messages.length).toBeGreaterThan(0);
		expect(current.agent.appendOnlyContext).toBe(appendOnlyContext);
		expect(appendOnlyContext.log.length).toBeGreaterThan(0);
		expect(current.sessionManager.getEntries().length).toBeGreaterThan(0);
		expect(current.rawSseDebugBuffer.toRawText().length).toBeGreaterThan(0);

		await current.dispose();
		session = undefined;

		expect(current.agent.state.messages).toHaveLength(0);
		expect(current.sessionManager.getEntries()).toHaveLength(0);
		expect(current.rawSseDebugBuffer.toRawText()).toBe("");
		expect(current.agent.appendOnlyContext).toBeUndefined();
		expect(current.rawSseDebugBuffer.snapshot().records).toHaveLength(0);
	});

	it("rejects late artifact writes while dispose is waiting for its final close", async () => {
		const current = createSession();
		expect(await current.sessionManager.saveArtifact("live spill", "read")).toBe("0");
		const reachedClose = Promise.withResolvers<void>();
		const finishClose = Promise.withResolvers<void>();
		const close = current.sessionManager.close.bind(current.sessionManager);
		vi.spyOn(current.sessionManager, "close").mockImplementation(async () => {
			reachedClose.resolve();
			await finishClose.promise;
			await close();
		});
		const disposing = current.dispose();
		try {
			await reachedClose.promise;
			expect(await current.sessionManager.saveArtifact(`late-${crypto.randomUUID()}`, "read")).toBeUndefined();
		} finally {
			finishClose.resolve();
			await disposing;
			session = undefined;
		}
	});

	it("waits for the active turn to settle before releasing memory", async () => {
		const current = createSession();
		const bulk = "y".repeat(4096);

		// Seed a captured frame that dispose must ultimately drop.
		current.rawSseDebugBuffer.recordEvent(
			{
				event: "content_block_delta",
				data: `data: ${bulk}`,
				raw: ["event: content_block_delta", `data: ${bulk}`],
			},
			current.agent.state.model,
		);

		const order: string[] = [];
		const reachedSettle = Promise.withResolvers<void>();
		const settle = Promise.withResolvers<void>();
		vi.spyOn(current.agent, "waitForIdle").mockImplementation(async () => {
			order.push("waitForIdle:start");
			reachedSettle.resolve();
			await settle.promise;
			// The aborted loop unwinds during the settle window: it appends its
			// terminal message just before dispose clears the transcript.
			current.agent.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: bulk }],
				timestamp: Date.now(),
			} as AgentMessage);
			order.push("waitForIdle:end");
		});
		const detachResp = current.agent.setProviderResponseInterceptor.bind(current.agent);
		vi.spyOn(current.agent, "setProviderResponseInterceptor").mockImplementation(fn => {
			order.push(`detach:resp:${fn === undefined ? "off" : "on"}`);
			detachResp(fn);
		});
		const reset = current.agent.reset.bind(current.agent);
		vi.spyOn(current.agent, "reset").mockImplementation(() => {
			order.push("reset");
			reset();
		});

		const disposeP = current.dispose();

		// dispose must block on the still-running turn: reaching the settle await
		// wins the race against dispose resolving. If dispose ever finished first
		// it would have cleared the transcript mid-turn (the bug under test).
		const winner = await Promise.race([
			reachedSettle.promise.then(() => "reached" as const),
			disposeP.then(() => "disposed" as const),
		]);
		expect(winner).toBe("reached");

		// The response interceptor was detached before the wait, and nothing has
		// been cleared yet.
		expect(order).toContain("detach:resp:off");
		expect(order.indexOf("detach:resp:off")).toBeLessThan(order.indexOf("waitForIdle:start"));
		expect(order).not.toContain("reset");

		settle.resolve();
		await disposeP;
		session = undefined;

		// reset ran only after the turn settled; the terminal message appended
		// during the unwind and the seeded frame were both dropped.
		expect(order.indexOf("reset")).toBeGreaterThan(order.indexOf("waitForIdle:end"));
		expect(current.agent.state.messages).toHaveLength(0);
		expect(current.rawSseDebugBuffer.snapshot().records).toHaveLength(0);
	});

	it("drains pending notifications before releasing retained session memory", async () => {
		const model = getTestModel("ascend");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// Persistence proceeds independently, but dispose must still drain the
		// notification handler before releasing the session state it can access.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async () => {
					reached.resolve();
					await release.promise;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"block-message-end",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		const current = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
		});
		session = current;

		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(4096) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		current.agent.emitExternalEvent({ type: "message_end", message });
		await reached.promise;

		// Dispose must not release memory until that in-flight handler settles.
		const reachedSettle = Promise.withResolvers<void>();
		const detach = current.agent.setProviderResponseInterceptor.bind(current.agent);
		vi.spyOn(current.agent, "setProviderResponseInterceptor").mockImplementation(fn => {
			detach(fn);
			reachedSettle.resolve();
		});
		let disposed = false;
		const disposeP = current.dispose().then(() => {
			disposed = true;
		});
		try {
			await reachedSettle.promise;
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(disposed).toBe(false);
		} finally {
			release.resolve();
			await disposeP;
		}
		session = undefined;
		expect(current.sessionManager.getEntries()).toHaveLength(0);
		expect(current.agent.state.messages).toHaveLength(0);
	});

	it("keeps session memory empty when notifications finish after the drain deadline", async () => {
		const model = getTestModel("ascend");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// Dispose must resolve at the deadline without retaining completed messages,
		// and late notification bookkeeping must not repopulate the session.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async () => {
					reached.resolve();
					await release.promise;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"slow-message-end",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const current = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
		});
		session = current;

		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "z".repeat(4096) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		current.agent.emitExternalEvent({ type: "message_end", message });
		await reached.promise;

		let releaseCalls = 0;
		const secondRelease = Promise.withResolvers<void>();
		const realRelease = current.sessionManager.releaseRetainedEntries.bind(current.sessionManager);
		vi.spyOn(current.sessionManager, "releaseRetainedEntries").mockImplementation(() => {
			realRelease();
			releaseCalls++;
			if (releaseCalls === 2) secondRelease.resolve();
		});
		try {
			await current.dispose({ drainTimeoutMs: 20 });
			session = undefined;
			expect(current.sessionManager.getEntries()).toHaveLength(0);
			expect(current.agent.state.messages).toHaveLength(0);
		} finally {
			release.resolve();
		}
		await secondRelease.promise;
		expect(current.sessionManager.getEntries()).toHaveLength(0);
		expect(current.agent.state.messages).toHaveLength(0);
	});

	it("seals the session file at release so an immediate revival owns it exclusively", async () => {
		const model = getTestModel("ascend");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		// File-backed: AgentLifecycleManager.park() resolves as soon as dispose()
		// returns, and ensureLive() may reopen this exact JSONL through a NEW
		// manager immediately — while the timed-out handler is still parked in
		// the extension hook holding the OLD manager.
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		let lateTitleAccepted: boolean | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async () => {
					reached.resolve();
					await release.promise;
					// Resumes after dispose returned and the revival opened the
					// file: the sealed manager must reject the title write (its
					// own async disk path) and drop the custom entry.
					lateTitleAccepted = await sessionManager.setSessionName("late-title", "user");
					sessionManager.appendCustomEntry("late-custom", { note: "dropped" });
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"slow-message-end-file",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const current = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
		});
		session = current;

		sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");

		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "completed before disposal" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		current.agent.emitExternalEvent({ type: "message_end", message });
		await reached.promise;

		let releaseCalls = 0;
		const secondRelease = Promise.withResolvers<void>();
		const realRelease = current.sessionManager.releaseRetainedEntries.bind(current.sessionManager);
		vi.spyOn(current.sessionManager, "releaseRetainedEntries").mockImplementation(() => {
			realRelease();
			releaseCalls++;
			if (releaseCalls === 2) secondRelease.resolve();
		});
		await current.dispose({ drainTimeoutMs: 20 });
		session = undefined;
		const bytesAfterDispose = await Bun.file(sessionFile).text();

		// Revival sees completed messages even though their notifications remain
		// parked; notification-side writes after sealing must still be rejected.
		const revived = await SessionManager.open(sessionFile, tempDir.path());
		const revivedTexts = revived
			.getEntries()
			.filter(entry => entry.type === "message")
			.map(entry => JSON.stringify(entry.message));
		try {
			expect(revivedTexts).toEqual([
				expect.stringContaining("seed"),
				expect.stringContaining("completed before disposal"),
			]);
		} finally {
			release.resolve();
		}
		await secondRelease.promise;
		expect(current.sessionManager.getEntries()).toHaveLength(0);
		expect(await Bun.file(sessionFile).text()).toBe(bytesAfterDispose);

		// The revival writer can append without losing completed messages or
		// incorporating the old notification handler's rejected writes.
		revived.appendMessage({ role: "user", content: "post-revive", timestamp: Date.now() });
		await revived.flush();
		await revived.close();
		const reread = await SessionManager.open(sessionFile, tempDir.path());
		const rereadTexts = reread
			.getEntries()
			.filter(entry => entry.type === "message")
			.map(entry => JSON.stringify(entry.message));
		expect(rereadTexts).toEqual([
			expect.stringContaining("seed"),
			expect.stringContaining("completed before disposal"),
			expect.stringContaining("post-revive"),
		]);
		const rereadSerialized = JSON.stringify(reread.getEntries());
		expect(rereadSerialized).not.toContain("late-title");
		expect(rereadSerialized).not.toContain("late-custom");
		expect(lateTitleAccepted).toBe(false);
		expect(reread.getSessionName()).not.toBe("late-title");
		await reread.close();
	});

	it("skips the authoritative repair rewrite once sealed so a failed batch cannot truncate the file", async () => {
		// The atomic-batch recovery path resets the disk tail itself, escaping
		// the close() serialization: a batch whose fenced rewrite fails across
		// the terminal seal would otherwise atomically publish the now-empty
		// entry list over a file a revival may already own.
		const gate = Promise.withResolvers<void>();
		const reachedAtomic = Promise.withResolvers<void>();
		let armed = false;
		let atomicWrites = 0;
		class FailingAtomicStorage extends FileSessionStorage {
			override async writeTextAtomic(
				filePath: string,
				body: string,
				options?: { commitGuard?: () => boolean },
			): Promise<void> {
				if (!armed) return super.writeTextAtomic(filePath, body, options);
				atomicWrites++;
				reachedAtomic.resolve();
				await gate.promise;
				throw new Error("injected atomic write failure");
			}
		}
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path(), new FailingAtomicStorage());
		sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const bytesBeforeBatch = await Bun.file(sessionFile).text();

		armed = true;
		const batch = sessionManager.appendEntriesAtomically(() => {
			sessionManager.appendCustomEntry("batch-entry", { note: "never durable" });
		});
		const settled = batch.catch((error: unknown) => error);
		// The fenced rewrite is parked inside storage; the terminal seal +
		// release land mid-flight, exactly as a dispose during the batch would.
		await reachedAtomic.promise;
		sessionManager.seal();
		sessionManager.releaseRetainedEntries();
		gate.resolve();

		// The batch surfaces the injected failure; the sealed repair path must
		// not attempt a second atomic publish of the emptied entry list.
		expect(String(await settled)).toContain("injected atomic write failure");
		expect(atomicWrites).toBe(1);
		expect(await Bun.file(sessionFile).text()).toBe(bytesBeforeBatch);

		// The transcript survives for revival.
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const reopenedTexts = reopened
			.getEntries()
			.filter(entry => entry.type === "message")
			.map(entry => JSON.stringify(entry.message));
		expect(reopenedTexts).toEqual([expect.stringContaining("seed")]);
		expect(JSON.stringify(reopened.getEntries())).not.toContain("never durable");
		await reopened.close();
	});

	it("preserves the agent_end transcript for an asynchronous extension during dispose", async () => {
		const model = getTestModel("ascend");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const notificationDone = Promise.withResolvers<void>();
		let observedMessageCount = -1;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", async event => {
					reached.resolve();
					await release.promise;
					observedMessageCount = event.messages.length;
					notificationDone.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"block-agent-end",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const current = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
		});
		session = current;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "terminal transcript" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		agent.replaceMessages([message]);
		agent.emitExternalEvent({ type: "agent_end", messages: agent.state.messages });
		await reached.promise;

		const resetDone = Promise.withResolvers<void>();
		const reset = agent.reset.bind(agent);
		vi.spyOn(agent, "reset").mockImplementation(() => {
			reset();
			resetDone.resolve();
		});
		const disposeP = current.dispose();
		await resetDone.promise;
		expect(agent.state.messages).toHaveLength(0);

		release.resolve();
		await notificationDone.promise;
		await disposeP;
		session = undefined;
		expect(observedMessageCount).toBe(1);
	});
});

describe("SDK strict owned disposal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: AgentRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-strict-dispose-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(getTestModel("ascend").provider, "test-key");
		registry = new AgentRegistry();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			const results = await Promise.allSettled(sessions.splice(0).map(current => current.dispose({ strict: true })));
			const failures = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
			if (failures.length) throw new AggregateError(failures, "SDK fixture cleanup failed");
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	async function createSession(
		agentId: string,
		options: Partial<CreateAgentSessionOptions> = {},
	): Promise<AgentSession> {
		const model = getTestModel("ascend");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			agentId,
			agentRegistry: registry,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({
				"async.enabled": false,
				"browser.enabled": false,
				"computer.enabled": false,
				"compaction.enabled": false,
				"todo.enabled": false,
			}),
			model,
			offline: true,
			bindProcessState: false,
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
			rules: [],
			enableMCP: false,
			enableLsp: false,
			...options,
		});
		sessions.push(session);
		return session;
	}

	function registerCleanup(current: AgentSession, callback: () => Promise<void>): void {
		// The SDK's actual read tool owns the ToolSession used by native resources.
		const toolSession: ToolSession | undefined = Reflect.get(current.getToolByName("read") ?? {}, "session");
		if (!toolSession?.registerDisposeCallback) throw new Error("expected native ToolSession cleanup registration");
		toolSession.registerDisposeCallback(callback);
	}

	it("retains the root route after a real final-close failure until retry, without closing another root", async () => {
		const current = await createSession("strict-close-root");
		const sibling = await createSession("independent-root");
		const ref = registry.get("strict-close-root");
		const siblingRef = registry.get("independent-root");
		expect(ref?.session).toBe(current);
		expect(siblingRef?.session).toBe(sibling);
		const siblingClose = vi.spyOn(sibling.sessionManager, "close");
		const close = current.sessionManager.close.bind(current.sessionManager);
		const failure = new Error("owned transcript close failed");
		const closeSpy = vi
			.spyOn(current.sessionManager, "close")
			.mockRejectedValueOnce(failure)
			.mockImplementation(close);
		const resourceCleanup = vi.fn(async () => {});
		registerCleanup(current, resourceCleanup);

		const failedClose = await current.dispose({ strict: true }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failedClose instanceof AggregateError ? failedClose.errors : [failedClose]).toContain(failure);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(registry.get("strict-close-root")).toBe(ref);
		expect(registry.get("strict-close-root")?.session).toBe(current);
		expect(registry.get("independent-root")).toBe(siblingRef);
		expect(siblingClose).not.toHaveBeenCalled();
		const completedCleanups = resourceCleanup.mock.calls.length;

		await current.dispose({ strict: true });
		expect(closeSpy).toHaveBeenCalledTimes(2);
		expect(registry.get("strict-close-root")).toBeUndefined();
		expect(resourceCleanup).toHaveBeenCalledTimes(Math.max(1, completedCleanups));
		expect(registry.get("independent-root")).toBe(siblingRef);
		expect(siblingClose).not.toHaveBeenCalled();
	});

	it("retries failed resource callbacks without duplicating completed cleanup or losing the registry route", async () => {
		const current = await createSession("strict-resources-root");
		const ref = registry.get("strict-resources-root");
		const closeSpy = vi.spyOn(current.sessionManager, "close");
		let fail = true;
		const failure = new Error("owned native resource close failed");
		const completed = vi.fn(async () => {});
		const failing = vi.fn(async () => {
			if (fail) throw failure;
		});
		const independent = vi.fn(async () => {});
		registerCleanup(current, completed);
		registerCleanup(current, failing);
		registerCleanup(current, independent);
		try {
			const failedCleanup = await current.dispose({ strict: true }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failedCleanup instanceof AggregateError ? failedCleanup.errors : [failedCleanup]).toContain(failure);
			expect(registry.get("strict-resources-root")).toBe(ref);
			expect(completed).toHaveBeenCalledTimes(1);
			expect(failing).toHaveBeenCalledTimes(1);
			expect(independent).toHaveBeenCalledTimes(1);
			expect(closeSpy).toHaveBeenCalledTimes(1);

			fail = false;
			await current.dispose({ strict: true });
			expect(registry.get("strict-resources-root")).toBeUndefined();
			expect(completed).toHaveBeenCalledTimes(1);
			expect(failing).toHaveBeenCalledTimes(2);
			expect(independent).toHaveBeenCalledTimes(1);
			expect(closeSpy).toHaveBeenCalledTimes(1);
		} finally {
			fail = false;
		}
	});

	it("retains actual failed startup resources and coalesces cleanup retries before releasing the root", async () => {
		const startupError = new Error("native startup failed after session attachment");
		const cleanupError = new Error("native startup resource remains busy");
		const retryReached = Promise.withResolvers<void>();
		const finishRetry = Promise.withResolvers<void>();
		let failCleanup = true;
		let actualSession: AgentSession | undefined;
		let pending: AgentSessionStartupCleanupFailure | undefined;
		let cleanupFailures = 0;
		const completed = vi.fn(async () => {});
		const failing = vi.fn(async () => {
			if (failCleanup) throw cleanupError;
			retryReached.resolve();
			await finishRetry.promise;
		});
		const attachSession = registry.attachSession.bind(registry);
		vi.spyOn(registry, "attachSession").mockImplementation((id, session, sessionFile, expected) => {
			const attached = attachSession(id, session, sessionFile, expected);
			if (!attached) return attached;
			actualSession = session as AgentSession;
			registerCleanup(actualSession, completed);
			registerCleanup(actualSession, failing);
			throw startupError;
		});
		function cleanupErrors(error: unknown): unknown[] {
			return error instanceof AggregateError ? error.errors.flatMap(cleanupErrors) : [error];
		}
		try {
			const error = await createSession("strict-startup-root", {
				strictStartupCleanup: true,
				onStartupCleanupFailure: failure => {
					cleanupFailures++;
					pending = failure;
				},
			}).then(
				() => undefined,
				(failure: unknown) => failure,
			);
			expect(cleanupErrors(error)).toContain(startupError);
			expect(cleanupErrors(error)).toContain(cleanupError);
			expect(cleanupFailures).toBe(1);
			expect(actualSession).toBeDefined();
			expect(pending?.session).toBe(actualSession);
			const ref = registry.get("strict-startup-root");
			expect(ref?.session).toBe(actualSession);
			expect(completed).toHaveBeenCalledTimes(1);
			expect(failing).toHaveBeenCalledTimes(1);
			if (!pending) throw new Error("expected actual retained startup cleanup");

			failCleanup = false;
			const firstRetry = pending.cleanup();
			const concurrentRetry = pending.cleanup();
			try {
				await retryReached.promise;
				expect(registry.get("strict-startup-root")).toBe(ref);
				expect(completed).toHaveBeenCalledTimes(1);
				expect(failing).toHaveBeenCalledTimes(2);
			} finally {
				finishRetry.resolve();
				await Promise.all([firstRetry, concurrentRetry]);
			}
			expect(registry.get("strict-startup-root")).toBeUndefined();
			expect(completed).toHaveBeenCalledTimes(1);
			expect(failing).toHaveBeenCalledTimes(2);
			expect(cleanupFailures).toBe(1);
		} finally {
			failCleanup = false;
			finishRetry.resolve();
			await pending?.cleanup();
		}
	});

	it("preserves ordinary SDK disposal's unregister-before-resource-error behavior", async () => {
		const current = await createSession("ordinary-dispose-root");
		let fail = true;
		const failure = new Error("ordinary native resource failure");
		registerCleanup(current, async () => {
			if (fail) throw failure;
		});
		try {
			await expect(current.dispose()).rejects.toBe(failure);
			expect(registry.get("ordinary-dispose-root")).toBeUndefined();
		} finally {
			fail = false;
			await current.dispose();
			const index = sessions.indexOf(current);
			if (index !== -1) sessions.splice(index, 1);
		}
	});
});
