import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { NativeChildDirectory, type NativeChildChange } from "../../src/webgui/native-subagents";
import { acquireBrowserProject, type BrowserProjectLease } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

async function savedChild(file: string, cwd: string, answer?: string): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: cwd, suppressBreadcrumb: true });
	try {
		manager.appendMessage({ role: "user", content: "Inspect this child assignment.", timestamp: Date.now() });
		if (answer) manager.appendMessage(createAssistantMessage(answer));
		await manager.ensureOnDisk();
		await manager.flush();
		return manager.getSessionId();
	} finally {
		await manager.close();
	}
}

interface Fixture {
	root: AgentSession;
	registry: AgentRegistry;
	context: WebGuiServiceContext;
	artifacts: string;
	createChild(file: string, id: string): Promise<AgentSession>;
}

async function withRoot(temp: TempDir, work: (fixture: Fixture) => Promise<void>): Promise<void> {
	const authStorage = createInMemoryAuthStorage();
	const model = getTestModel("ascend");
	authStorage.keys.setRuntime(model.provider, "isolated-test-key");
	const modelRegistry = new ModelRegistry(authStorage, temp.join("models.yml"));
	const registry = new AgentRegistry();
	const sessions: AgentSession[] = [];
	let lease: BrowserProjectLease | undefined;
	async function create(manager: SessionManager, id: string, parent?: AgentSession): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.join("agent"),
			sessionManager: manager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			agentRegistry: registry,
			agentId: id,
			taskDepth: 1,
			parentAgentId: parent?.getAgentId(),
			subagentEventBus: parent?.subagentEventBus,
		});
		sessions.push(session);
		return session;
	}
	try {
		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		manager.appendMessage({ role: "user", content: "Keep the native root active.", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("The root remains the owner."));
		await manager.ensureOnDisk();
		await manager.flush();
		const root = await create(manager, "Main");
		const artifacts = manager.getArtifactsDir();
		if (!artifacts) throw new Error("Root fixture has no native artifact directory");
		await fs.mkdir(artifacts, { recursive: true });
		lease = await acquireBrowserProject(temp.path(), "webgui");
		await lease.activate(() => readWebGuiSessionInfo(root), { allowLan: false, nativeSession: root });
		const context: WebGuiServiceContext = {
			connectionId: crypto.randomUUID(),
			projectId: lease.projectId,
			workspacePath: temp.path(),
			nativeSession: root,
			signal: new AbortController().signal,
		};
		await work({
			root,
			registry,
			context,
			artifacts,
			createChild: async (file, id) =>
				create(
					await SessionManager.open(file, undefined, undefined, {
						initialCwd: temp.path(),
						suppressBreadcrumb: true,
					}),
					id,
					root,
				),
		});
	} finally {
		await lease?.close();
		for (const session of sessions.reverse()) await session.dispose();
		authStorage.close();
	}
}

test("late attachment reconstructs real conversation IDs, parent tool links and restart history without leaking another root", async () => {
	using temp = TempDir.createSync("@pi-native-child-history-");
	await withRoot(temp, async ({ root, registry, context, artifacts }) => {
		const file = path.join(artifacts, "Worker.jsonl");
		const childId = await savedChild(file, temp.path(), "A completed native child.");
		const nestedId = await savedChild(path.join(artifacts, "Worker", "Nested.jsonl"), temp.path(), "Nested work.");
		const pendingId = await savedChild(path.join(artifacts, "Pending.jsonl"), temp.path());
		const foreignFile = temp.join("different-root", "Foreign.jsonl");
		const foreignId = await savedChild(foreignFile, temp.path(), "Must remain private to another root.");
		registry.register({
			id: "Foreign",
			displayName: "Foreign",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: foreignFile,
			status: "parked",
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_native_task",
			toolName: "task",
			timestamp: Date.now(),
			isError: false,
			content: [{ type: "text", text: "Native task completed." }],
			details: { results: [{ id: "Worker", agent: "scout", exitCode: 0, description: "Inspect ownership" }] },
		};
		root.agent.appendMessage(result);
		root.sessionManager.appendMessage(result);
		await root.sessionManager.flush();
		const before = await fs.readFile(file);
		const rootId = root.sessionId;
		const manager = root.sessionManager;
		const directory = new NativeChildDirectory(root);
		try {
			const list = await directory.list(context, rootId);
			expect(childId).not.toBe("Worker");
			expect(list.childSessionIds.sort()).toEqual([childId, pendingId].sort());
			expect(list.ended.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						childSessionId: childId,
						agentId: "Worker",
						toolCallId: "call_native_task",
						status: "success",
					}),
					expect.objectContaining({ childSessionId: pendingId, status: "lost" }),
				]),
			);
			expect((await directory.list(context, childId)).childSessionIds).toEqual([nestedId]);
			expect(await directory.childSessionIdsForToolCall(context, rootId, "call_native_task")).toEqual([childId]);
			expect((await directory.resolve(context, nestedId)).parentSessionId).toBe(childId);
			expect(await directory.messages(context, childId)).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					content: [{ type: "text", text: "A completed native child." }],
				}),
			);
			await expect(directory.resolve(context, foreignId)).rejects.toThrow("not found");
			await expect(directory.resolve(context, file)).rejects.toThrow("not found");
			expect(root.sessionId).toBe(rootId);
			expect(root.sessionManager).toBe(manager);
			expect(await fs.readFile(file)).toEqual(before);
			expect(registry.get("Worker")).toBeUndefined();
		} finally {
			directory.dispose();
		}
		const reattached = new NativeChildDirectory(root);
		try {
			expect((await reattached.projection(context, rootId)).childSessionIds).toContain(childId);
			expect((await reattached.info(context, childId)).id).toBe(childId);
		} finally {
			reattached.dispose();
		}
	});
});

test("live child reads and invalidations survive parking but reject a reused native agent ID from another generation", async () => {
	using temp = TempDir.createSync("@pi-native-child-live-");
	await withRoot(temp, async ({ root, registry, context, artifacts, createChild }) => {
		const file = path.join(artifacts, "Worker.jsonl");
		const childId = await savedChild(file, temp.path(), "Earlier child history.");
		const child = await createChild(file, "Worker");
		const ref = registry.get("Worker");
		if (!ref) throw new Error("Native child fixture was not registered");
		const bus = root.subagentEventBus;
		if (!bus) throw new Error("Native root fixture has no descendant event bus");
		const directory = new NativeChildDirectory(root);
		const changes: NativeChildChange[] = [];
		const unsubscribe = directory.subscribe(change => changes.push(change));
		const streaming = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const stopObservingStream = child.subscribe(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") streaming.resolve();
		});
		const mock = createMockModel({ responses: [{ content: ["The child live reply."] }] });
		child.agent.streamFn = (model, messages, options) => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				for await (const event of mock.stream(model, messages, options)) {
					stream.push(event);
					if (event.type === "text_delta") {
						await finish.promise;
					}
				}
			})().catch(error => {
				streaming.reject(error);
				stream.fail(error);
			});
			return stream;
		};
		let prompt: Promise<boolean> | undefined;
		try {
			await directory.resolve(context, childId);
			const runningPrompt = child.prompt("Continue the native child assignment.");
			prompt = runningPrompt;
			void runningPrompt.catch(error => streaming.reject(error));
			await streaming.promise;
			const stats = child.getSessionStats();
			const startedAt = child.runStartedAt;
			if (startedAt === undefined) throw new Error("Streaming native fixture has no run start");
			bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				agent: "task",
				agentSource: "bundled",
				task: "Continue the native child assignment.",
				sessionFile: file,
				parentToolCallId: "call_live",
				progress: {
					index: 0,
					id: "Worker",
					agent: "task",
					agentSource: "bundled",
					status: "running",
					task: "Continue the native child assignment.",
					lastIntent: "Inspecting native state",
					completionPercent: 80,
					recentTools: [],
					recentOutput: [],
					toolCount: stats.toolCalls,
					requests: stats.assistantMessages,
					tokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
					cost: stats.cost,
					durationMs: Date.now() - startedAt,
				},
			} satisfies SubagentProgressPayload);
			expect((await directory.resolve(context, childId)).progress).toMatchObject({
				lastIntent: "Inspecting native state",
				completionPercent: 80,
			});
			expect((await directory.list(context, root.sessionId)).running).toContainEqual(
				expect.objectContaining({ childSessionId: childId, agentId: "Worker", status: "running" }),
			);
			expect(await directory.messages(context, childId)).toContainEqual(
				expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "The child live reply." }] }),
			);
			expect(
				changes.some(change => change.rootSessionId === root.sessionId && change.sessionIds.includes(childId)),
			).toBe(true);
			finish.resolve();
			await prompt;
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "Worker",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "completed",
				sessionFile: file,
				parentToolCallId: "call_live",
			} satisfies SubagentLifecyclePayload);
			registry.setStatus("Worker", "parked", ref);
			registry.detachSession("Worker", ref);
			await child.dispose();
			expect((await directory.resolve(context, childId)).session).toBeNull();
			expect((await directory.list(context, root.sessionId)).ended.items).toContainEqual(
				expect.objectContaining({ childSessionId: childId, toolCallId: "call_live", status: "success" }),
			);
			expect(await directory.messages(context, childId)).toContainEqual(
				expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "The child live reply." }] }),
			);
			const foreignFile = temp.join("other-root", "Worker.jsonl");
			const foreignId = await savedChild(
				foreignFile,
				temp.path(),
				"Different conversation with the same native agent ID.",
			);
			const replacement = registry.register({
				id: "Worker",
				displayName: "Worker",
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile: foreignFile,
				status: "parked",
			});
			expect(replacement.generation).not.toBe(ref.generation);
			const archived = await directory.resolve(context, childId);
			expect(archived.session).toBeNull();
			expect(archived.generation).toBeUndefined();
			await expect(directory.resolve(context, foreignId)).rejects.toThrow("not found");
			// A new conversation at the same native artifact path must not inherit
			// the previous UUID, generation, progress or parent tool-call identity.
			await fs.unlink(file);
			const nextId = await savedChild(file, temp.path(), "A new native conversation at the reused path.");
			expect(nextId).not.toBe(childId);
			expect((await directory.resolve(context, nextId)).parentToolCallId).toBeUndefined();
			await expect(directory.messages(context, childId)).rejects.toThrow("not found");
			expect((await directory.list(context, root.sessionId)).childSessionIds).not.toContain(childId);
			expect(root.sessionManager.getSessionId()).not.toBe(childId);
		} finally {
			finish.resolve();
			await prompt?.catch(() => undefined);
			unsubscribe();
			stopObservingStream();
			directory.dispose();
		}
	});
});
