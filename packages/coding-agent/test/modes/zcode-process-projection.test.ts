import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	commandAckSchema,
	LegacyProtocol,
	TopicWireFrameAssembler,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
	sessionsIndexTopicWireFrameSchema,
	subscribeAckSchema,
	v4ConversationRowsRangeResultSchema,
	workspaceConfigTopicWireFrameSchema,
} from "../../src/modes/zcode/schema";
import {
	type Frame,
	model,
	deadline,
	ProcessPeer,
	fixture,
	workspace,
	create,
	command,
	subscribe,
	output,
	findInteraction,
	hasUserInput,
	finishedOutput,
} from "./zcode-process-harness";

describe("ZCode actual public app-server process", () => {
	test("equal user text has distinct durable command identities, including input queued during streaming", async () => {
		await using root = await TempDir.create("@zcode-input-identity-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const id = await create(peer, config.cwdA);
		await subscribe(peer, id);
		const firstId = crypto.randomUUID();
		const secondId = crypto.randomUUID();
		await command(peer, id, "sendText", { text: "ZCODE_TEST_STREAM_EQUAL" }, firstId);
		await output(peer, id, "ZCODE_TEST_STREAM_EQUAL_STREAMING");
		await command(peer, id, "sendText", { text: "ZCODE_TEST_STREAM_EQUAL", requestedDelivery: "queue" }, secondId);
		await output(peer, id, "ZCODE_TEST_STREAM_EQUAL_DONE");
		await peer.next(frame => frame.method === "v4/conversation/frame" && hasUserInput(frame.params, secondId));
		const rows = v4ConversationRowsRangeResultSchema.parse(
			await peer.request("v4/conversation/rowsRange", { sessionId: id, limit: 100 }),
		);
		const inputs = rows.rows.filter(row => row.kind === "userInput" && row.text === "ZCODE_TEST_STREAM_EQUAL");
		expect(inputs).toHaveLength(2);
		expect(inputs.map(row => (row.kind === "userInput" ? row.sourceCommandId : undefined))).toEqual([
			firstId,
			secondId,
		]);
	}, 120_000);

	test("HS-E2E-02: late Highspeed cards apply only to the next round; busy execution rejects without card facts", async () => {
		await using root = await TempDir.create("@zcode-highspeed-input-");
		await using config = await fixture(root);
		const directCommandId = crypto.randomUUID();
		const queuedCommandId = crypto.randomUUID();
		const plainCommandId = crypto.randomUUID();
		const rejectedCommandId = crypto.randomUUID();
		const issuedAt = Date.now();
		const card = {
			schemaVersion: 1 as const,
			cardId: "public-card",
			taskId: "public-highspeed-task",
			provider: model.providerId,
			model: model.modelId,
			issuedAt,
			expiresAt: issuedAt + 60_000,
		};
		const queuedCard = { ...card, cardId: "queued-card" };
		const lateCardDelivery = Promise.withResolvers<typeof queuedCard>();
		const rejectedCard = { ...card, cardId: "rejected-busy-execution-card" };
		const metrics = {
			regularTps: 10.5,
			outputTokens: 42,
			durationMs: 2_000,
			highspeedTps: 21,
			savedDurationMs: 2_000,
			modelDurationMs: 2_000,
			toolDurationMs: 0,
			otherDurationMs: 0,
		};
		const subscriptions = new WeakMap<ProcessPeer, Map<string, string>>();
		const snapshot = async (peer: ProcessPeer, sessionId: string) => {
			let owned = subscriptions.get(peer);
			if (!owned) {
				owned = new Map();
				subscriptions.set(peer, owned);
			}
			let subscriptionId = owned.get(sessionId);
			const deliveryKind = subscriptionId ? "recovery" : "initial";
			if (subscriptionId) {
				await peer.request("v4/conversation/resync", {
					topic: `conversation/${sessionId}`,
					connectionId: "test-desktop-continuous",
					subscriptionId,
					base: null,
					forceSnapshot: true,
				});
			} else {
				const result = await subscribe(peer, sessionId);
				if (!isRecord(result)) throw new Error("Missing Highspeed subscription ACK");
				subscriptionId = subscribeAckSchema.parse(result.ack).subscriptionId;
				owned.set(sessionId, subscriptionId);
			}
			// The consumer assembles both complete and fragmented snapshots, scoped
			// to the owned subscription; refresh explicitly requests same-sub recovery.
			const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
			for (;;) {
				const notification = await peer.next(
					item =>
						item.method === "v4/conversation/frame" &&
						isRecord(item.params) &&
						item.params.topic === `conversation/${sessionId}` &&
						item.params.subscriptionId === subscriptionId &&
						item.params.deliveryKind === deliveryKind,
				);
				const wire = conversationTopicWireCandidateSchema.parse(notification.params);
				for (const event of assembler.accept(wire)) {
					if (event.kind === "fault") throw new Error(`Highspeed snapshot: ${event.fault.reasonCode}`);
					if (event.frame.payload.kind === "snapshot") {
						return event.frame.payload.snapshot;
					}
				}
			}
		};
		const rows = async (peer: ProcessPeer, sessionId: string) =>
			v4ConversationRowsRangeResultSchema
				.parse(await peer.request("v4/conversation/rowsRange", { sessionId, limit: 100 }))
				.rows.filter(row => row.kind === "userInput");
		const assertCards = async (peer: ProcessPeer, sessionId: string) => {
			const inputs = await rows(peer, sessionId);
			expect(inputs).toHaveLength(3);
			expect(inputs.find(row => row.sourceCommandId === directCommandId)?.highspeed).toEqual({
				...card,
				...metrics,
			});
			expect(inputs.find(row => row.sourceCommandId === queuedCommandId)?.highspeed).toEqual(queuedCard);
			expect(inputs.find(row => row.sourceCommandId === plainCommandId)?.highspeed).toBeUndefined();
			expect(inputs.some(row => row.sourceCommandId === rejectedCommandId)).toBe(false);
			const refreshed = await snapshot(peer, sessionId);
			expect(refreshed.rows.window.filter(row => row.kind === "userInput")).toEqual(inputs);
			return inputs;
		};
		let sessionId: string;
		let otherSessionId: string;
		let queuedItemId: string;
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			sessionId = await create(peer, config.cwdA);
			otherSessionId = await create(peer, config.cwdB);
			await snapshot(peer, sessionId);
			expect(
				await command(
					peer,
					sessionId,
					"sendText",
					{
						text: "ZCODE_TEST_CARD",
						highspeedMeta: card,
					},
					directCommandId,
				),
			).toMatchObject({ status: "accepted" });
			await finishedOutput(peer, sessionId, "ZCODE_TEST_CARD_DONE");
			expect((await rows(peer, sessionId))[0]).toMatchObject({
				sourceCommandId: directCommandId,
				highspeed: card,
			});
			const directInput = (await rows(peer, sessionId))[0]!;
			const directTarget = { rowId: directInput.rowId, entityId: directInput.entityId };
			expect(
				await command(peer, sessionId, "setHighspeedMetrics", { target: directTarget, ...metrics }),
			).toMatchObject({ status: "accepted" });
			expect((await rows(peer, sessionId))[0]!.highspeed).toEqual({ ...card, ...metrics });
			expect(
				(await snapshot(peer, sessionId)).rows.window
					.filter(row => row.kind === "userInput")
					.find(row => row.sourceCommandId === directCommandId)?.highspeed,
			).toEqual({ ...card, ...metrics });
			expect(
				await command(peer, sessionId, "setHighspeedMetrics", {
					target: { ...directTarget, entityId: "not-the-accepted-input" },
					...metrics,
				}),
			).toMatchObject({ status: "failed" });
			// HS-E2E-02：普通轮已开始后才收到卡，只能交给下一轮，不能追溯补标当前输入。
			// STOP fixture 确定性保持真实 localhost provider stream，无定时竞态。
			expect(
				await command(peer, sessionId, "sendText", { text: "ZCODE_TEST_CARD_STOP" }, plainCommandId),
			).toMatchObject({ status: "accepted" });
			await output(peer, sessionId, "ZCODE_TEST_CARD_STOP_STREAMING");
			const plainInputs = await rows(peer, sessionId);
			expect(plainInputs.find(row => row.sourceCommandId === plainCommandId)?.highspeed).toBeUndefined();
			lateCardDelivery.resolve(queuedCard);
			expect(
				await command(
					peer,
					sessionId,
					"sendText",
					{
						text: "ZCODE_TEST_REJECTED_CARD",
						requestedDelivery: "queue",
						modelSelection: model,
						modelExecution: { selectionScope: "execution" },
						highspeedMeta: rejectedCard,
					},
					rejectedCommandId,
				),
			).toMatchObject({ status: "failed" });
			expect(await rows(peer, sessionId)).toEqual(plainInputs);
			const rejectedSnapshot = await snapshot(peer, sessionId);
			expect(rejectedSnapshot.rows.window.filter(row => row.kind === "userInput")).toEqual(plainInputs);
			expect(rejectedSnapshot.queue.items).toEqual([]);
			expect(JSON.stringify(config.requests)).not.toContain("ZCODE_TEST_REJECTED_CARD");
			expect(
				await command(
					peer,
					sessionId,
					"sendText",
					{
						text: "ZCODE_TEST_CARD",
						requestedDelivery: "queue",
						highspeedMeta: await lateCardDelivery.promise,
					},
					queuedCommandId,
				),
			).toMatchObject({ status: "accepted" });
			const queued = (await snapshot(peer, sessionId)).queue.items;
			expect(queued).toHaveLength(1);
			expect(queued[0]).toMatchObject({ sourceCommandId: queuedCommandId, highspeed: queuedCard });
			queuedItemId = queued[0]!.queueItemId;
			expect((await rows(peer, sessionId)).some(row => row.sourceCommandId === queuedCommandId)).toBe(false);
			expect(await command(peer, sessionId, "stop", {})).toMatchObject({ status: "accepted" });
			// Promotion must consume the admitted card, not require a second UI copy.
			expect(await command(peer, sessionId, "sendQueuedNow", { queueItemId: queuedItemId })).toMatchObject({
				status: "accepted",
			});
			await peer.next(
				frame => frame.method === "v4/conversation/frame" && hasUserInput(frame.params, queuedCommandId),
			);
			await finishedOutput(peer, sessionId, "ZCODE_TEST_CARD_DONE");
			const inputs = await assertCards(peer, sessionId);
			const plainInput = inputs.find(row => row.sourceCommandId === plainCommandId)!;
			expect(
				await command(peer, sessionId, "setHighspeedMetrics", {
					target: { rowId: plainInput.rowId, entityId: plainInput.entityId },
					...metrics,
				}),
			).toMatchObject({ status: "failed" });
			await assertCards(peer, sessionId);
			expect((await snapshot(peer, sessionId)).queue.items).toEqual([]);
			expect(await rows(peer, sessionId)).toEqual(inputs);
			await snapshot(peer, otherSessionId);
			expect(await command(peer, otherSessionId, "sendText", { text: "ZCODE_TEST_CARD_OTHER" })).toMatchObject({
				status: "accepted",
			});
			await finishedOutput(peer, otherSessionId, "ZCODE_TEST_CARD_OTHER_DONE");
			expect(
				await command(peer, otherSessionId, "setHighspeedMetrics", { target: directTarget, ...metrics }),
			).toMatchObject({ status: "failed" });
			const otherInput = (await rows(peer, otherSessionId))[0]!;
			expect(
				await command(peer, otherSessionId, "setHighspeedMetrics", {
					target: { rowId: otherInput.rowId, entityId: otherInput.entityId },
					...metrics,
				}),
			).toMatchObject({ status: "failed" });
			await assertCards(peer, sessionId);
			expect((await rows(peer, otherSessionId)).every(row => row.highspeed === undefined)).toBe(true);
			expect(await peer.eof()).toBe(0);
		}
		const files = await fs.readdir(path.join(config.agentDir, "sessions"), { recursive: true });
		const journalFile = files.find(file => file.endsWith(`_${sessionId}.jsonl`));
		if (!journalFile) throw new Error("Missing Highspeed native journal");
		const entries = (await fs.readFile(path.join(config.agentDir, "sessions", journalFile), "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Frame);
		const inputFacts = entries.filter(entry => entry.type === "custom" && entry.customType === "session_input");
		const admittedCards = inputFacts.filter(
			entry => isRecord(entry.data) && entry.data.state === "admitted" && entry.data.highspeed !== undefined,
		);
		// 同一 input 在 queue admission 与显式 promotion 时可各记一次 admitted，
		// 消费事实按原 command 身份归并，不能把合法提升误判成第三张卡。
		const cardsByCommand = new Map<string, unknown>();
		for (const entry of admittedCards) {
			if (
				!isRecord(entry.data) ||
				!isRecord(entry.data.sourceCommand) ||
				typeof entry.data.sourceCommand.commandId !== "string"
			)
				throw new Error("Missing Highspeed input ownership");
			cardsByCommand.set(entry.data.sourceCommand.commandId, entry.data.highspeed);
		}
		expect([...cardsByCommand]).toEqual([
			[directCommandId, card],
			[queuedCommandId, queuedCard],
		]);
		expect(JSON.stringify(inputFacts)).not.toContain(rejectedCard.cardId);
		expect(JSON.stringify(inputFacts)).not.toContain(rejectedCommandId);
		const requestCount = config.requests.length;
		await using cold = new ProcessPeer(config.cwdA, config.env);
		await cold.ready();
		await snapshot(cold, sessionId);
		await assertCards(cold, sessionId);
		await cold.request("session/resume", { sessionId });
		await snapshot(cold, sessionId);
		await assertCards(cold, sessionId);
		const otherInputs = await rows(cold, otherSessionId);
		expect(otherInputs).toHaveLength(1);
		expect(otherInputs[0]!.highspeed).toBeUndefined();
		expect(config.requests).toHaveLength(requestCount);
	}, 120_000);
	test("contract noop commands stay idempotent, late interaction answers do not fail, unknown createSession workspaces are rejected", async () => {
		await using root = await TempDir.create("@zcode-noop-contract-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const id = await create(peer, config.cwdA);
		await subscribe(peer, id);
		await command(peer, id, "sendText", { text: "ZCODE_TEST_QUESTION_NOOP" });
		const waiting = await peer.next(
			frame => frame.method === "v4/conversation/frame" && findInteraction(frame.params) !== undefined,
		);
		const interaction = findInteraction(waiting.params)!;
		expect(
			await command(peer, id, "resolveInteraction", {
				interactionId: interaction.interactionId,
				answer: { optionId: "Continue" },
			}),
		).toMatchObject({ status: "accepted", result: { type: "resolveInteraction" } });
		await finishedOutput(peer, id, "ZCODE_TEST_QUESTION_NOOP_DONE");
		// 迟到/重复应答幂等收口(forkZcode 03-commands.md:80-81;vendor schema command.ts 注释):
		// 先到者生效,晚到返回 noop+proto.alreadyResolved,不再 -32602 变 failed。
		expect(
			await command(peer, id, "resolveInteraction", {
				interactionId: interaction.interactionId,
				answer: { optionId: "Cancel" },
			}),
		).toMatchObject({ status: "noop", reasonCode: "proto.alreadyResolved" });
		const digest = "a".repeat(64);
		const hookTarget = {
			sessionId: id,
			taskId: "fixture-task",
			runId: "fixture-run",
			workspaceIdentity: "fixture-identity",
			bundleDigest: digest,
			reviewFlowId: "fixture-flow",
			generation: 1,
			interactionId: "fixture-interaction",
		};
		// 6 个无本地实现场景的合同命令(findings I;vendor schema command.ts:189-292):
		// 通过信封校验后幂等 noop 收口,而不是 -32601 failed 毒化同 commandId 重试。
		const noopExpectation = { status: "noop", reasonCode: "proto.noop" };
		expect(
			await command(peer, id, "setAssistantFeedback", {
				target: { rowId: 1, entityId: "entity-1" },
				feedback: "like",
			}),
		).toMatchObject(noopExpectation);
		expect(
			await command(peer, id, "respondWorkspaceHookReview", {
				...hookTarget,
				decision: { action: "trust_selected", reviewItemIds: ["item-1"] },
			}),
		).toMatchObject(noopExpectation);
		expect(
			await command(peer, id, "toggleWorkspaceHookReviewItem", {
				...hookTarget,
				reviewItemId: "item-1",
				enabled: true,
			}),
		).toMatchObject(noopExpectation);
		expect(
			await command(peer, id, "revokeWorkspaceHookTrust", { ...hookTarget, reviewItemIds: ["item-1"] }),
		).toMatchObject(noopExpectation);
		expect(
			await command(peer, id, "requestWorkspaceHookReview", {
				sessionId: id,
				workspaceIdentity: "fixture-identity",
				bundleDigest: digest,
			}),
		).toMatchObject(noopExpectation);
		expect(await command(peer, id, "discardSharedContext", { contextId: "fixture-context" })).toMatchObject(
			noopExpectation,
		);
		// v4 createSession 未知 workspaceId 显式失败(findings J):不再静默落 process.cwd
		// 把派生会话挂错工作区;消息必须携带收到的 workspaceId 供 GUI 归因。
		const unknownWorkspaceId = "Z:/definitely-not-a-registered-workspace";
		const rejected = await peer.request("v4/command", {
			commandId: crypto.randomUUID(),
			clientId: "public-process-test",
			sessionId: null,
			type: "createSession",
			payload: { workspaceId: unknownWorkspaceId },
			issuedAt: Date.now(),
		});
		expect(rejected).toMatchObject({
			status: "failed",
			message: expect.stringContaining(unknownWorkspaceId),
		});
		expect(config.requests.every(request => !JSON.stringify(request).includes(unknownWorkspaceId))).toBe(true);
		// 桌面预热先读取另一个工作区的命令目录，再用 v4 创建草稿；不能要求先创建会话才能登记路由。
		const unregistered = commandAckSchema.parse(
			await peer.request("v4/command", {
				commandId: crypto.randomUUID(),
				clientId: "public-process-test",
				sessionId: null,
				type: "createSession",
				payload: { workspaceId: config.cwdB, config: { modelSelection: model } },
				issuedAt: Date.now(),
			}),
		);
		expect(unregistered).toMatchObject({
			status: "failed",
			message: expect.stringContaining(config.cwdB),
		});
		const presentation = LegacyProtocol.zcodeWorkspacePresentationSchema.parse(
			await peer.request("workspace/readPresentation", { workspace: workspace(config.cwdB) }),
		);
		expect(presentation.workspace).toEqual(workspace(config.cwdB));
		const created = commandAckSchema.parse(
			await peer.request("v4/command", {
				commandId: crypto.randomUUID(),
				clientId: "public-process-test",
				sessionId: null,
				type: "createSession",
				payload: { workspaceId: config.cwdB, config: { modelSelection: model } },
				issuedAt: Date.now(),
			}),
		);
		expect(created).toMatchObject({ status: "accepted", result: { type: "createSession" } });
		if (created.result?.type !== "createSession") throw new Error("Missing foreign draft createSession result");
		const draft = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await peer.request("session/read", { sessionId: created.result.sessionId }),
		);
		expect(draft.session.workspace.workspacePath).toBe(config.cwdB);
		expect(draft.session.workspace.workspaceKey).toBe(config.cwdB);
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("sessions-index topics only carry sessions owned by their workspace", async () => {
		await using root = await TempDir.create("@zcode-index-isolation-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const a = await create(peer, config.cwdA);
		const b = await create(peer, config.cwdB);
		const topic = `sessions-index/${config.cwdB}`;
		expect(
			await peer.request("v4/conversation/subscribe", {
				topic,
				connectionId: "index-owner",
				clientMode: "desktop-continuous",
				workspace: workspace(config.cwdB),
			}),
		).toMatchObject({ ack: { mode: "snapshot" } });
		const initial = await peer.next(
			frame => frame.method === "v4/conversation/frame" && isRecord(frame.params) && frame.params.topic === topic,
		);
		const wire = sessionsIndexTopicWireFrameSchema.parse(initial.params);
		if (wire.kind !== "complete" || wire.frame.payload.kind !== "snapshot")
			throw new Error("Expected complete initial sessions-index snapshot");
		// sessions-index 快照只含归属该工作区 cwd 的会话;manager.list() 的 listAll 合并了
		// 所有项目的会话,不过滤会把 cwdA 的会话泄漏进 cwdB 侧栏(findings P2)。
		const snapshot = wire.frame.payload.snapshot;
		expect(snapshot.workspaceId).toBe(config.cwdB);
		expect(snapshot.sessions.map(session => session.sessionId)).toEqual([b]);
		const c = await create(peer, config.cwdB);
		await peer.next(
			frame =>
				frame.method === "v4/conversation/frame" &&
				isRecord(frame.params) &&
				frame.params.topic === topic &&
				JSON.stringify(frame.params).includes(c),
		);
		const indexFrames = peer.seen.filter(
			frame => frame.method === "v4/conversation/frame" && isRecord(frame.params) && frame.params.topic === topic,
		);
		expect(JSON.stringify(indexFrames)).not.toContain(a);
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("background native registry discovery publishes into an already open workspace catalog", async () => {
		await using root = await TempDir.create("@zcode-native-catalog-discovery-");
		await using config = await fixture(root);
		const discovered = Promise.withResolvers<void>();
		const requested = Promise.withResolvers<void>();
		const endpoint = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/v1/models") return new Response(null, { status: 404 });
				requested.resolve();
				await discovered.promise;
				return Response.json({ data: [{ id: "background-chat" }] });
			},
		});
		try {
			await fs.appendFile(
				path.join(config.agentDir, "models.yml"),
				`  zcode-discovery:\n    baseUrl: http://127.0.0.1:${endpoint.port}/v1\n    auth: none\n    api: openai-completions\n    discovery:\n      type: openai-models-list\n`,
			);
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			const topic = `workspace-config/${config.cwdA}`;
			await peer.request("v4/conversation/subscribe", {
				topic,
				connectionId: "native-background",
				clientMode: "desktop-continuous",
				workspace: workspace(config.cwdA),
			});
			const initial = await peer.next(
				frame => frame.method === "v4/conversation/frame" && isRecord(frame.params) && frame.params.topic === topic,
			);
			expect(JSON.stringify(initial)).not.toContain("zcode-discovery/background-chat");
			await deadline(requested.promise);
			discovered.resolve();
			const notification = await peer.next(
				frame =>
					frame.method === "v4/conversation/frame" &&
					isRecord(frame.params) &&
					frame.params.topic === topic &&
					JSON.stringify(frame.params).includes("zcode-discovery/background-chat"),
			);
			const wire = workspaceConfigTopicWireFrameSchema.parse(notification.params);
			if (wire.kind !== "complete" || wire.frame.payload.kind !== "deltas")
				throw new Error("Background discovery did not publish a native config delta");
			expect(wire.frame.payload.deltas[0]?.op).toBe("config.updated");
			expect(config.requests).toHaveLength(0);
			expect(await peer.eof()).toBe(0);
		} finally {
			discovered.resolve();
			endpoint.stop(true);
		}
	}, 120_000);

	test("native workspace models and persisted default role update the existing subscription without Host sources", async () => {
		await using root = await TempDir.create("@zcode-native-model-catalog-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const topic = `workspace-config/${config.cwdA}`;
		await peer.request("v4/conversation/subscribe", {
			topic,
			connectionId: "native-catalog-hot",
			clientMode: "desktop-continuous",
			workspace: workspace(config.cwdA),
		});
		const readModelOption = async (expected: string, snapshot = false) => {
			const frame = await peer.next(item => {
				if (item.method !== "v4/conversation/frame" || !isRecord(item.params) || item.params.topic !== topic)
					return false;
				const wire = workspaceConfigTopicWireFrameSchema.parse(item.params);
				if (wire.kind !== "complete") return false;
				const payload = wire.frame.payload;
				const states =
					payload.kind === "snapshot" ? [payload.snapshot.config] : payload.deltas.map(delta => delta.config);
				return (
					(payload.kind === "snapshot") === snapshot &&
					states.some(state =>
						state.configOptions.some(option => option.id === "model" && option.currentValue === expected),
					)
				);
			});
			const wire = workspaceConfigTopicWireFrameSchema.parse(frame.params);
			if (wire.kind !== "complete") throw new Error("Expected complete isolated model config frame");
			const payload = wire.frame.payload;
			const state = payload.kind === "snapshot" ? payload.snapshot.config : payload.deltas.at(-1)!.config;
			return state.configOptions.find(option => option.id === "model")!;
		};
		const initial = await readModelOption("zcode-fixture/chat-a", true);
		if (!initial.options) throw new Error("Native model selector did not expose its catalog options");
		expect(initial.options.map(option => option.value)).toContain("zcode-fixture/chat-b");
		// 临时会话选 B 不能覆盖 workspace 持久 default=A。
		const sessionId = await create(peer, config.cwdA, { providerId: model.providerId, modelId: "chat-b" });
		expect((await peer.requestFrame("provider/refreshRegistry", { reason: "native-catalog" })).error).toMatchObject({
			code: -32601,
			message: "Host provider configuration is not supported",
		});
		const rejected = await peer.requestFrame("provider/updateAccountConfig", {
			revision: "1",
			basedOnZCodeBuiltinRevision: "1",
			providers: {},
			states: {},
		});
		expect(rejected.error).toMatchObject({ code: -32601, message: "Host provider configuration is not supported" });
		// 外部原生配置写入必须推送 config.updated，不依赖重连或切换会话。
		await fs.writeFile(
			path.join(config.agentDir, "config.yml"),
			"modelRoles:\n  default: zcode-fixture/chat-b\ntools:\n  xdev: false\nskills:\n  enabled: false\n",
		);
		expect((await readModelOption("zcode-fixture/chat-b")).currentValue).toBe("zcode-fixture/chat-b");
		const modelsPath = path.join(config.agentDir, "models.yml");
		await fs.appendFile(modelsPath, "      - id: chat-hot\n        reasoning: false\n");
		const changed = await peer.next(
			item =>
				item.method === "v4/conversation/frame" &&
				isRecord(item.params) &&
				item.params.topic === topic &&
				JSON.stringify(item.params).includes("zcode-fixture/chat-hot"),
		);
		const wire = workspaceConfigTopicWireFrameSchema.parse(changed.params);
		expect(wire.kind).toBe("complete");
		expect(JSON.stringify(wire)).toContain("config.updated");
		const current = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await peer.request("session/read", { sessionId }),
		);
		expect(current.settings.model.current).toMatchObject({ providerId: model.providerId, modelId: "chat-b" });
		expect(config.requests).toHaveLength(0);
		expect(await peer.eof()).toBe(0);
	}, 120_000);
});
