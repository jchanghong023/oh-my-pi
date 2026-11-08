import { expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { nativeChatRuntime } from "@oh-my-pi/pi-coding-agent/webgui/native-chat";
import { acquireBrowserProject, type BrowserProjectLease } from "@oh-my-pi/pi-coding-agent/webgui/project-registry";
import type { WebGuiServiceContext } from "@oh-my-pi/pi-coding-agent/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "@oh-my-pi/pi-coding-agent/webgui/session-source";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

type Snapshot = Awaited<ReturnType<ReturnType<typeof nativeChatRuntime>["snapshot"]>>;

test("native text streaming shares stable V4 rows across consumers and survives one consumer disconnecting", async () => {
	using temp = TempDir.createSync("@pi-webgui-native-stream-");
	const authStorage = createInMemoryAuthStorage();
	const finishStreams = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const closeConsumers: Array<() => void> = [];
	let session: AgentSession | undefined;
	let lease: BrowserProjectLease | undefined;
	try {
		const model = getTestModel("ascend");
		authStorage.keys.setRuntime(model.provider, "test-key");
		const manager = SessionManager.inMemory(temp.path());
		({ session } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			sessionManager: manager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
			model,
			toolNames: [],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			enableMCP: false,
			enableLsp: false,
			taskDepth: 1,
			agentId: "SubAgent",
		}));
		const native = session;
		const inputs = ["Describe the shared conversation.", "Continue after the first browser disconnects."];
		const prefixes = ["Shared", "Remaining"];
		const replies = ["Shared native reply.", "Remaining browser receives the continuation."];
		const mock = createMockModel({ responses: replies.map(text => ({ content: [text] })) });
		let streamIndex = 0;
		// The existing mock emits whole text blocks synchronously. Split its text delta
		// behind a barrier so the real AgentSession must expose an unfinished reply.
		native.agent.streamFn = (selectedModel, context, options) => {
			const index = streamIndex++;
			const stream = new AssistantMessageEventStream();
			void (async () => {
				for await (const event of mock.stream(selectedModel, context, options)) {
					if (event.type === "start") {
						stream.push({ ...event, partial: { ...event.partial, content: [] } });
					} else if (event.type === "text_start") {
						stream.push({ ...event, partial: { ...event.partial, content: [{ type: "text", text: "" }] } });
					} else if (event.type === "text_delta") {
						const prefix = prefixes[index]!;
						stream.push({
							...event,
							delta: prefix,
							partial: { ...event.partial, content: [{ type: "text", text: prefix }] },
						});
						await finishStreams[index]!.promise;
						stream.push({ ...event, delta: event.delta.slice(prefix.length) });
					} else {
						stream.push(event);
					}
				}
			})().catch(error => stream.fail(error));
			return stream;
		};

		lease = await acquireBrowserProject(temp.path(), "webgui");
		await lease.activate(() => readWebGuiSessionInfo(native), { allowLan: false, nativeSession: native });
		const contextA: WebGuiServiceContext = {
			connectionId: "browser-a",
			projectId: lease.projectId,
			workspacePath: lease.root,
			signal: new AbortController().signal,
			nativeSession: native,
		};
		const contextB: WebGuiServiceContext = { ...contextA, connectionId: "browser-b" };
		const runtime = nativeChatRuntime(contextA);
		expect(nativeChatRuntime(contextB)).toBe(runtime);
		const id = native.sessionId;
		const journal = manager.getSessionFile();
		const created = new Date(manager.getHeader()!.timestamp);
		runtime.recordHistory([
			{
				id,
				path: journal ?? "",
				cwd: manager.getCwd(),
				created,
				modified: created,
				messageCount: 0,
				size: 0,
				firstMessage: "",
				allMessagesText: "",
			},
		]);

		function observe(context: WebGuiServiceContext) {
			const seen: Snapshot[] = [];
			const pending = new Set<{
				matches: (snapshot: Snapshot) => boolean;
				resolve: (snapshot: Snapshot) => void;
				reject: (error: unknown) => void;
			}>();
			const release = runtime.retain();
			const subscription = runtime.changes.event(changedId => {
				if (changedId !== id) return;
				void runtime.snapshot(context, id).then(
					snapshot => {
						seen.push(snapshot);
						for (const waiter of pending)
							if (waiter.matches(snapshot)) {
								pending.delete(waiter);
								waiter.resolve(snapshot);
							}
					},
					error => {
						for (const waiter of pending) waiter.reject(error);
					},
				);
			});
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				subscription.dispose();
				release();
			};
			closeConsumers.push(close);
			return {
				seen,
				close,
				waitFor(matches: (snapshot: Snapshot) => boolean) {
					const previous = seen.find(matches);
					if (previous) return Promise.resolve(previous);
					const waiter = Promise.withResolvers<Snapshot>();
					pending.add({ matches, resolve: waiter.resolve, reject: waiter.reject });
					return waiter.promise;
				},
			};
		}
		const browserA = observe(contextA);
		const browserB = observe(contextB);
		const ended = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let endIndex = 0;
		const unsubscribe = native.subscribe(event => {
			if (event.type === "agent_end") ended[endIndex++]?.resolve();
		});
		closeConsumers.push(unsubscribe);

		for (let index = 0; index < inputs.length; index++) {
			const consumers = index === 0 ? [browserA, browserB] : [browserB];
			const partials = consumers.map(consumer =>
				consumer.waitFor(
					snapshot =>
						snapshot.control.phase === "running" &&
						snapshot.rows.window.some(
							row => row.kind === "assistantText" && row.state === "streaming" && row.text === prefixes[index],
						),
				),
			);
			const completions = consumers.map(consumer =>
				consumer.waitFor(
					snapshot =>
						snapshot.control.phase === "completedSuccess" &&
						snapshot.rows.window.some(
							row => row.kind === "assistantText" && row.state === "complete" && row.text === replies[index],
						),
				),
			);
			// submit resolves at native onPromptAdmitted, not at provider completion.
			await runtime.submit(
				index === 0 ? contextA : contextB,
				id,
				inputs[index]!,
				`input-${index}`,
				index === 0 ? "browser-a" : "browser-b",
			);
			const streaming = await Promise.all(partials);
			for (const snapshot of streaming) {
				expect(snapshot.inputRouting).toEqual({ mode: "reject", reasonCode: "guard.nativeSessionBusy" });
				expect(snapshot.control.sessionEnded).toBe(false);
				expect(snapshot.rows.window.filter(row => row.kind === "userInput").map(row => row.text)).toEqual(
					inputs.slice(0, index + 1),
				);
				expect(snapshot.rows.window.filter(row => row.kind === "turnHeader").at(-1)?.state).toBe("running");
			}
			if (index === 0) expect(streaming[0]!.rows).toEqual(streaming[1]!.rows);
			expect(native.messages.filter(message => message.role === "user").at(-1)?.content).toEqual([
				{ type: "text", text: inputs[index]! },
			]);
			finishStreams[index]!.resolve();
			await ended[index]!.promise;
			await native.waitForIdle();
			const completed = await Promise.all(completions);
			for (let consumerIndex = 0; consumerIndex < completed.length; consumerIndex++) {
				const snapshot = completed[consumerIndex]!;
				const partial = streaming[consumerIndex]!;
				const partialRow = partial.rows.window.find(
					row => row.kind === "assistantText" && row.text === prefixes[index],
				)!;
				const finalRow = snapshot.rows.window.find(
					row => row.kind === "assistantText" && row.text === replies[index],
				)!;
				expect({ rowId: finalRow.rowId, entityId: finalRow.entityId, turnId: finalRow.turnId }).toEqual({
					rowId: partialRow.rowId,
					entityId: partialRow.entityId,
					turnId: partialRow.turnId,
				});
				expect(snapshot.logEpoch).toBe(partial.logEpoch);
				expect(snapshot.seq).toBeGreaterThan(partial.seq);
				expect(snapshot.control.sessionEnded).toBe(true);
				expect(snapshot.inputRouting).toEqual({ mode: "startNow" });
				expect(snapshot.rows.window.filter(row => row.kind === "turnHeader").at(-1)?.state).toBe(
					"completedSuccess",
				);
				expect(snapshot.rows.window.filter(row => row.kind === "assistantText").map(row => row.text)).toEqual(
					replies.slice(0, index + 1),
				);
				expect(snapshot.rows.window.filter(row => row.kind === "userInput").map(row => row.text)).toEqual(
					inputs.slice(0, index + 1),
				);
			}
			if (index === 0) {
				expect(completed[0]!.rows).toEqual(completed[1]!.rows);
				browserA.close();
			}
			expect(native.sessionManager).toBe(manager);
			expect(native.sessionId).toBe(id);
			expect(manager.getSessionFile()).toBe(journal);
		}
		expect(mock.calls).toHaveLength(2);
		expect(endIndex).toBe(2);
		const persisted = manager.getEntries().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
		expect(persisted.filter(message => message.role === "user").map(message => message.content)).toEqual(
			inputs.map(text => [{ type: "text", text }]),
		);
		expect(persisted.filter(message => message.role === "assistant").map(message => message.content)).toEqual(
			replies.map(text => [{ type: "text", text }]),
		);
	} finally {
		for (const gate of finishStreams) gate.resolve();
		for (const close of closeConsumers) close();
		try {
			await session?.dispose();
		} finally {
			await lease?.close();
			authStorage.close();
		}
	}
});
