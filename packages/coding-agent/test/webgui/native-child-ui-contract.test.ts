import { expect, test } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NativeTaskRunsSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/native-task-runs";
import { V4_WIRE_PROTOCOL_VERSION } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/core";
import type { ConversationTopicWireFrame } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/transport";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { nativeChatRuntime } from "../../src/webgui/native-chat";
import { activateNativeWebGuiComposition } from "../../src/webgui/native-composition";
import { acquireBrowserProject, type BrowserProjectLease, readBrowserProject } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "../../src/webgui/rpc-contract";
import { createAgentServices } from "../../src/webgui/services-agent";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

test("native task rows open the real child UUID, stream its conversation and reject child input without restoring the root", async () => {
	using temp = TempDir.createSync("@pi-native-child-ui-");
	activateNativeWebGuiComposition();
	const authStorage = createInMemoryAuthStorage();
	const model = getTestModel("ascend");
	authStorage.keys.setRuntime(model.provider, "isolated-test-key");
	const modelRegistry = new ModelRegistry(authStorage, temp.join("models.yml"));
	const registry = new AgentRegistry();
	const sessions: AgentSession[] = [];
	const services: WebGuiServiceDefinition[] = [];
	let lease: BrowserProjectLease | undefined;
	let finish!: () => void;
	const finished = new Promise<void>(resolve => {
		finish = resolve;
	});
	let prompt: Promise<boolean> | undefined;
	async function create(manager: SessionManager, id: string, parent?: AgentSession): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: temp.path(),
			bindProcessState: false,
			agentDir: temp.join("agent"),
			sessionManager: manager,
			authStorage,
			modelRegistry,
			model,
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
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
			taskDepth: parent ? 1 : 0,
			parentAgentId: parent?.getAgentId(),
			subagentEventBus: parent?.subagentEventBus,
		});
		sessions.push(session);
		return session;
	}
	try {
		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		const root = await create(manager, "Main");
		const user = { role: "user" as const, content: "Inspect a native task", timestamp: Date.now() };
		manager.appendMessage(user);
		root.agent.appendMessage(user);
		const call = createAssistantMessage("");
		call.stopReason = "toolUse";
		call.content = [{ type: "toolCall", id: "native-task-call", name: "task", arguments: { i: "Inspect child" } }];
		// A live task call belongs in both stores; restoring it before its result strips it as dangling.
		manager.appendMessage(call);
		root.agent.appendMessage(call);
		await manager.ensureOnDisk();
		await manager.flush();
		const artifacts = manager.getArtifactsDir();
		if (!artifacts) throw new Error("Missing native artifact directory");
		await fs.mkdir(artifacts, { recursive: true });
		const childManager = await SessionManager.open(path.join(artifacts, "Worker.jsonl"), undefined, undefined, {
			initialCwd: temp.path(),
			suppressBreadcrumb: true,
		});
		childManager.appendMessage({ role: "user", content: "Existing child assignment", timestamp: Date.now() });
		await childManager.ensureOnDisk();
		await childManager.flush();
		const child = await create(childManager, "Worker", root);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "native-task-call",
			toolName: "task",
			timestamp: Date.now(),
			isError: false,
			content: [{ type: "text", text: "Native child allocated" }],
			details: { results: [{ id: "Worker", agent: "scout", exitCode: 0, description: "Inspect child" }] },
		};
		manager.appendMessage(result);
		root.agent.appendMessage(result);
		await manager.flush();
		const childId = child.sessionId;
		const rootId = root.sessionId;
		lease = await acquireBrowserProject(temp.path(), "webgui");
		await lease.activate(() => readWebGuiSessionInfo(root), { allowLan: false, nativeSession: root });
		const originalProject = readBrowserProject(lease.projectId);
		const context: WebGuiServiceContext = {
			connectionId: "native-child-pane",
			projectId: lease.projectId,
			workspacePath: lease.root,
			nativeSession: root,
			signal: new AbortController().signal,
		};
		services.push(...createAgentServices(context));
		const agent = services.find(service => service.name === "zcode-agent");
		if (!agent) throw new Error("Missing native agent channel");
		const target = { workspacePath: lease.root };
		const runtime = nativeChatRuntime(context);
		// Task readers attach lazily on their first RPC, not when the service definitions are created.
		expect(runtime.taskRunsAvailable).toBe(false);
		const runs = await agent.call<NativeTaskRunsSnapshot>(context, "listNativeTaskRuns", [
			{ ...target, sessionId: rootId },
		]);
		expect(runtime.taskRunsAvailable).toBe(true);
		const parent = await runtime.snapshot(context, rootId);
		const row = parent.rows.window.find(
			row => row.kind === "subagent" && row.parentToolCallId === "native-task-call",
		);
		expect(row).toMatchObject({ kind: "subagent", childSessionId: childId });
		expect(childId).not.toBe("Worker");
		expect(parent.subagents?.childSessionIds).toContain(childId);
		expect(runs.runs[0]?.actors).toContainEqual(expect.objectContaining({ sessionId: childId }));
		const childSnapshot = await runtime.snapshot(context, childId);
		expect(childSnapshot.inputRouting).toEqual({ mode: "reject", reasonCode: "guard.nativeChildReadOnly" });
		await expect(agent.call(context, "resumeSession", [{ ...target, sessionId: childId }])).rejects.toThrow(
			"read-only",
		);
		await expect(
			agent.call(context, "sendPrompt", [{ ...target, sessionId: childId, content: "Forbidden input" }]),
		).rejects.toThrow("read-only");
		expect(root.sessionId).toBe(rootId);
		expect(root.sessionManager).toBe(manager);
		expect(readBrowserProject(lease.projectId)).toBe(originalProject);
		expect(originalProject?.nativeSession).toBe(root);
		expect([...(originalProject?.nativeSessions ?? [])]).toEqual([root]);
		await agent.call(context, "initializeConversationV4", [
			{
				kind: "clientHello",
				protocolVersion: V4_WIRE_PROTOCOL_VERSION,
				clientId: "child-pane-client",
				appVersion: "test",
			},
		]);
		const frames: ConversationTopicWireFrame[] = [];
		const waiters = new Set<{ matches: (frame: ConversationTopicWireFrame) => boolean; resolve: () => void }>();
		const subscription = agent.listen<ConversationTopicWireFrame>(
			context,
			"onDynamicConversationFrame",
			target,
		)(frame => {
			frames.push(frame);
			for (const waiter of waiters)
				if (waiter.matches(frame)) {
					waiters.delete(waiter);
					waiter.resolve();
				}
		});
		const waitFor = (matches: (frame: ConversationTopicWireFrame) => boolean): Promise<void> => {
			if (frames.some(matches)) return Promise.resolve();
			return new Promise(resolve => {
				waiters.add({ matches, resolve });
			});
		};
		try {
			await agent.call(context, "subscribeConversationV4", [{ ...target, sessionId: rootId }]);
			await agent.call(context, "subscribeConversationV4", [{ ...target, sessionId: childId }]);
			await waitFor(
				frame =>
					frame.kind === "complete" &&
					frame.topic === `conversation/${childId}` &&
					frame.frame.payload.kind === "snapshot",
			);
			const mock = createMockModel({ responses: [{ content: ["Live child reply"] }] });
			child.agent.streamFn = (selectedModel, messages, options) => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					for await (const event of mock.stream(selectedModel, messages, options)) {
						stream.push(event);
						if (event.type === "text_delta") await finished;
					}
				})().catch(error => stream.fail(error));
				return stream;
			};
			prompt = child.prompt("Continue native assignment");
			await waitFor(
				frame =>
					frame.kind === "complete" &&
					frame.topic === `conversation/${childId}` &&
					frame.frame.payload.kind === "deltas" &&
					frame.frame.payload.deltas.some(
						delta =>
							(delta.op === "row.appended" || delta.op === "row.upserted") &&
							delta.row.kind === "assistantText" &&
							delta.row.text === "Live child reply" &&
							delta.row.state === "streaming",
					),
			);
			await waitFor(
				frame =>
					frame.kind === "complete" &&
					frame.topic === `conversation/${rootId}` &&
					frame.frame.payload.kind === "deltas" &&
					frame.frame.payload.deltas.some(
						delta =>
							delta.op === "state.updated" &&
							delta.patch.subagents?.running.some(actor => actor.childSessionId === childId),
					),
			);
			finish();
			await prompt;
			expect(root.sessionId).toBe(rootId);
			expect(root.sessionManager).toBe(manager);
			expect(child.messages.some(message => message.role === "user" && message.content === "Forbidden input")).toBe(
				false,
			);
		} finally {
			subscription.dispose();
		}
		for (const service of services) service.dispose();
		expect(runtime.taskRunsAvailable).toBe(false);
		expect(runtime.childDirectory).toBeUndefined();
	} finally {
		finish();
		await prompt?.catch(() => undefined);
		for (const service of services) service.dispose();
		await lease?.close();
		for (const session of sessions.reverse()) await session.dispose();
		authStorage.close();
	}
}, 30_000);
