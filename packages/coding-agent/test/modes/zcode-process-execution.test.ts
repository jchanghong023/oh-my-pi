import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	LegacyProtocol,
	TopicWireFrameAssembler,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
	conversationTopicWireFrameSchema,
	subscribeAckSchema,
	v4ConversationRowsRangeResultSchema,
} from "../../src/modes/zcode/schema";
import { SessionManager } from "../../src/session/session-manager";
import { DevWorkspace } from "../../src/spec-driven/workspace";
import {
	type Frame,
	model,
	ProcessPeer,
	fixture,
	workspace,
	create,
	command,
	subscribe,
	output,
	hasUserInput,
	finishedOutput,
} from "./zcode-process-harness";

describe("ZCode actual public app-server process", () => {
	test("automation preempts and stopped held input admits GUI CAS with frozen execution", async () => {
		await using root = await TempDir.create("@zcode-dispatch-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const id = await create(peer, config.cwdA);
		await subscribe(peer, id);
		// automation 派发(带 automationId、无 requestedDelivery)缺省 startNow:忙时抢占当前 turn
		// 立即执行,不再落 followupMode 默认 queue 排队(findings J「立即运行未直接派发」)。
		await command(peer, id, "sendText", { text: "ZCODE_TEST_DISPATCH_STREAM_BUSY" });
		await output(peer, id, "ZCODE_TEST_DISPATCH_STREAM_BUSY_STREAMING");
		expect(
			await command(peer, id, "sendText", {
				text: "ZCODE_TEST_DISPATCH_RUN",
				automationId: "automation-fixture-1",
			}),
		).toMatchObject({ status: "accepted", result: { type: "inputAccepted", delivery: "startNow" } });
		await finishedOutput(peer, id, "ZCODE_TEST_DISPATCH_RUN_DONE");
		expect(JSON.stringify(config.requests)).not.toContain("ZCODE_TEST_DISPATCH_STREAM_BUSY_DONE");
		// Stop 后保留 Q1，再走真实 GUI 的 keep/clear + CAS + 冻结 execution。
		const execution = { modelSelection: model, modelExecution: { selectionScope: "execution" } };
		await command(peer, id, "sendText", { text: "ZCODE_TEST_HELD_STREAM_BUSY", ...execution });
		await output(peer, id, "ZCODE_TEST_HELD_STREAM_BUSY_STREAMING");
		const queued = await command(peer, id, "sendText", {
			text: "ZCODE_TEST_HELD_QUEUED",
			requestedDelivery: "queue",
		});
		if (!isRecord(queued) || !isRecord(queued.result) || typeof queued.result.inputId !== "string")
			throw new Error("Held queue input was not admitted");
		const queuedInputId = queued.result.inputId;
		const sibling = await command(peer, id, "sendText", {
			text: "ZCODE_TEST_HELD_SIBLING",
			requestedDelivery: "queue",
		});
		if (!isRecord(sibling) || !isRecord(sibling.result) || typeof sibling.result.inputId !== "string")
			throw new Error("Held sibling input was not admitted");
		let expectedHeldQueueItemIds = [queued.result.inputId, sibling.result.inputId];
		expect(await command(peer, id, "stop", {})).toMatchObject({ status: "accepted" });
		// GUI 的 keep 带完整 CAS；旧用例只覆盖了不带 CAS 的绕行路径。
		// 冻结 execution 必须保留到真实模型请求，不能为通过 admission 丢弃材料。
		const staleInputId = crypto.randomUUID();
		expect(
			await command(
				peer,
				id,
				"sendText",
				{
					text: "ZCODE_TEST_HELD_STALE",
					heldQueueDisposition: "keepQueueAndSend",
					expectedHeldQueueItemIds: ["stale-input-id"],
					...execution,
				},
				staleInputId,
			),
		).toMatchObject({ status: "failed" });
		expect(JSON.stringify(config.requests)).not.toContain("ZCODE_TEST_HELD_STALE");
		expect(
			await command(peer, id, "sendText", {
				text: "ZCODE_TEST_HELD_KEEP",
				heldQueueDisposition: "keepQueueAndSend",
				expectedHeldQueueItemIds,
				...execution,
			}),
		).toMatchObject({ status: "accepted", result: { type: "inputAccepted", delivery: "startNow" } });
		await finishedOutput(peer, id, "ZCODE_TEST_HELD_KEEP_DONE");
		// 调度 Host 的既有无 CAS keep 仍可用，不改变旧调用方的保留语义。
		expect(
			await command(peer, id, "sendText", {
				text: "ZCODE_TEST_HELD_KEEP_NO_CAS",
				heldQueueDisposition: "keepQueueAndSend",
			}),
		).toMatchObject({ status: "accepted", result: { type: "inputAccepted", delivery: "startNow" } });
		await finishedOutput(peer, id, "ZCODE_TEST_HELD_KEEP_NO_CAS_DONE");
		let subscriptionId: string | undefined;
		const snapshot = async () => {
			const deliveryKind = subscriptionId ? "recovery" : "initial";
			if (subscriptionId) {
				await peer.request("v4/conversation/resync", {
					topic: `conversation/${id}`,
					connectionId: "test-web-remote-replayable",
					subscriptionId,
					base: null,
					forceSnapshot: true,
				});
			} else {
				const result = await subscribe(peer, id, "web-remote-replayable");
				if (!isRecord(result)) throw new Error("Missing held queue subscription ACK");
				subscriptionId = subscribeAckSchema.parse(result.ack).subscriptionId;
			}
			// 初始 desktop snapshot 仍在收件箱；按本次订阅身份组装，不能误读旧空队列。
			const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
			for (;;) {
				const frame = await peer.next(
					item =>
						item.method === "v4/conversation/frame" &&
						isRecord(item.params) &&
						item.params.topic === `conversation/${id}` &&
						item.params.subscriptionId === subscriptionId &&
						item.params.deliveryKind === deliveryKind,
				);
				for (const event of assembler.accept(conversationTopicWireCandidateSchema.parse(frame.params))) {
					if (event.kind === "fault") throw new Error(`Held queue snapshot: ${event.fault.reasonCode}`);
					if (event.frame.payload.kind === "snapshot") return event.frame.payload.snapshot;
				}
			}
		};
		const held = await snapshot();
		expect(held.inputRouting.mode).toBe("choice");
		expect(held.queue.items.map(item => item.queueItemId)).toEqual(expectedHeldQueueItemIds);
		expect(held.queue.autoDrain).toBe(false);
		// GUI 的立即发送携带冻结 execution；只消费 Q1，原 input/sourceCommand 不换成控制命令。
		const promotionCommandId = crypto.randomUUID();
		expect(
			await command(
				peer,
				id,
				"sendQueuedNow",
				{ queueItemId: queued.result.inputId, ...execution },
				promotionCommandId,
			),
		).toMatchObject({ status: "accepted" });
		await finishedOutput(peer, id, "ZCODE_TEST_HELD_QUEUED_DONE");
		const promoted = await snapshot();
		expect(
			promoted.rows.window.find(row => row.kind === "userInput" && row.sourceCommandId === queuedInputId),
		).toMatchObject({ kind: "userInput", sourceCommandId: queuedInputId });
		expect(
			promoted.rows.window.some(row => row.kind === "userInput" && row.sourceCommandId === promotionCommandId),
		).toBe(false);
		expectedHeldQueueItemIds = [sibling.result.inputId];
		expect(promoted.queue.items.map(item => item.queueItemId)).toEqual(expectedHeldQueueItemIds);
		expect(promoted.queue.autoDrain).toBe(false);
		expect(promoted.inputRouting.mode).toBe("choice");
		// clear 处置仍要求完整 CAS 集合:缺 expectedHeldQueueItemIds 显式拒绝。
		expect(
			await command(peer, id, "sendText", {
				text: "ZCODE_TEST_HELD_CLEAR",
				heldQueueDisposition: "clearQueueAndSend",
			}),
		).toMatchObject({ status: "failed" });
		expect(config.requests.every(request => !JSON.stringify(request).includes("ZCODE_TEST_HELD_CLEAR"))).toBe(true);
		expect(
			await command(peer, id, "sendText", {
				text: "ZCODE_TEST_HELD_CLEAR",
				heldQueueDisposition: "clearQueueAndSend",
				expectedHeldQueueItemIds,
				...execution,
			}),
		).toMatchObject({ status: "accepted", result: { type: "inputAccepted", delivery: "startNow" } });
		await finishedOutput(peer, id, "ZCODE_TEST_HELD_CLEAR_DONE");
		expect(JSON.stringify(config.requests)).not.toContain("ZCODE_TEST_HELD_SIBLING_DONE");
		// clear 只删仍 held 的 Q2，新输入仍有真实 user row；失败的 CAS 没有伪造 admission。
		const history = await peer.request("session/read", { sessionId: id });
		expect(JSON.stringify(history)).toContain("ZCODE_TEST_HELD_KEEP");
		expect(JSON.stringify(history)).toContain("ZCODE_TEST_HELD_CLEAR");
		expect(JSON.stringify(history)).not.toContain("ZCODE_TEST_HELD_STALE");
		expect((await snapshot()).queue.items).toEqual([]);
		expect(await peer.eof()).toBe(0);
		const files = await fs.readdir(path.join(config.agentDir, "sessions"), { recursive: true });
		const journalFile = files.find(file => file.endsWith(`_${id}.jsonl`));
		if (!journalFile) throw new Error("Missing held session journal");
		const journal = await fs.readFile(path.join(config.agentDir, "sessions", journalFile), "utf8");
		expect(journal).not.toContain(`"inputId":"${staleInputId}"`);
		const entries = journal
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as unknown);
		expect(
			entries.find(
				entry =>
					isRecord(entry) &&
					entry.type === "message" &&
					isRecord(entry.message) &&
					entry.message.role === "user" &&
					entry.message.inputId === queuedInputId,
			),
		).toMatchObject({
			message: { role: "user", inputId: queuedInputId, sourceCommand: { commandId: queuedInputId } },
		});
	}, 120_000);

	test("busy native Goal output persists and projects before the parent stream ends without steering it", async () => {
		await using root = await TempDir.create("@zcode-busy-command-output-");
		await using config = await fixture(root);
		let id = "";
		const marker = "ZCODE_TEST_COMMAND_STOP_GOAL";
		const rows = async (peer: ProcessPeer) =>
			v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId: id, limit: 100 }),
			).rows;
		const assertOutput = async (peer: ProcessPeer) => {
			expect((await rows(peer)).filter(row => JSON.stringify(row).includes("Goal mode paused."))).toHaveLength(1);
		};
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			id = await create(peer, config.cwdA);
			await subscribe(peer, id);
			expect(await command(peer, id, "sendText", { text: `/goal set ${marker}` })).toMatchObject({
				status: "accepted",
			});
			await output(peer, id, `${marker}_STREAMING`);
			expect(await command(peer, id, "sendText", { text: "/goal pause" })).toMatchObject({ status: "accepted" });
			await output(peer, id, "Goal mode paused.");
			const live = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
				await peer.request("session/read", { sessionId: id }),
			);
			expect(live.projection.status).toBe("running");
			expect(config.requests).toHaveLength(1);
			await assertOutput(peer);
			// 下一次原生 refresh 不能丢行；不依靠 Stop/stream 完成来解锁输出。
			await peer.request("session/read", { sessionId: id });
			await assertOutput(peer);
			const files = await fs.readdir(path.join(config.agentDir, "sessions"), { recursive: true });
			const journalFile = files.find(file => file.endsWith(`_${id}.jsonl`));
			if (!journalFile) throw new Error("Missing busy command journal");
			const entries = (await fs.readFile(path.join(config.agentDir, "sessions", journalFile), "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as Frame);
			expect(
				entries.filter(entry => entry.type === "custom_message" && entry.content === "Goal mode paused."),
			).toHaveLength(1);
			config.releaseHeldStream(marker);
			await finishedOutput(peer, id, `${marker}_DONE`);
			await assertOutput(peer);
			expect(
				(await rows(peer)).filter(
					row => row.kind === "assistantText" && JSON.stringify(row).includes(`${marker}_STREAMING`),
				),
			).toHaveLength(1);
			expect(config.requests).toHaveLength(1);
		}
		const requestCount = config.requests.length;
		await using cold = new ProcessPeer(config.cwdA, config.env);
		await cold.ready();
		await assertOutput(cold);
		await cold.request("session/resume", { sessionId: id });
		await assertOutput(cold);
		expect(config.requests).toHaveLength(requestCount);
	}, 120_000);

	test("running queued Goal promotion dispatches native intent before the current stream ends", async () => {
		await using root = await TempDir.create("@zcode-promoted-goal-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const id = await create(peer, config.cwdA);
		await subscribe(peer, id);
		const snapshot = async () => {
			const subscription = await subscribe(peer, id, "web-remote-replayable");
			if (!isRecord(subscription)) throw new Error("Missing promoted Goal subscription");
			const ack = subscribeAckSchema.parse(subscription.ack);
			const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
			for (;;) {
				const frame = await peer.next(
					frame =>
						frame.method === "v4/conversation/frame" &&
						isRecord(frame.params) &&
						frame.params.subscriptionId === ack.subscriptionId,
				);
				for (const event of assembler.accept(conversationTopicWireCandidateSchema.parse(frame.params))) {
					if (event.kind === "fault") throw new Error(event.fault.reasonCode);
					if (event.frame.payload.kind === "snapshot") return event.frame.payload.snapshot;
				}
			}
		};
		await command(peer, id, "setAutoDrain", { autoDrain: false });
		await command(peer, id, "sendText", { text: "ZCODE_TEST_STOP_PROMOTED_GOAL_BASE" });
		await output(peer, id, "ZCODE_TEST_STOP_PROMOTED_GOAL_BASE_STREAMING");
		const siblingId = crypto.randomUUID();
		const inputId = crypto.randomUUID();
		const promotionId = crypto.randomUUID();
		const objective = "ZCODE_TEST_PROMOTED_GOAL";
		expect(
			await command(
				peer,
				id,
				"sendText",
				{
					text: "ZCODE_TEST_UNSELECTED_GOAL_SIBLING",
					requestedDelivery: "queue",
				},
				siblingId,
			),
		).toMatchObject({ status: "accepted" });
		expect(
			await command(
				peer,
				id,
				"sendGoalCommand",
				{
					text: objective,
					requestedDelivery: "queue",
				},
				inputId,
			),
		).toMatchObject({ status: "accepted", result: { delivery: "queue", inputId } });
		const queued = await snapshot();
		expect(queued.goal).toBeNull();
		expect(queued.queue.items.map(item => item.queueItemId)).toEqual([siblingId, inputId]);
		expect(
			await command(peer, id, "sendQueuedNow", {
				queueItemId: inputId,
				modelSelection: model,
				modelExecution: { selectionScope: "execution" },
			}),
		).toMatchObject({ status: "failed" });
		expect((await snapshot()).goal).toBeNull();
		const request = {
			commandId: promotionId,
			clientId: "public-process-test",
			sessionId: id,
			type: "sendQueuedNow",
			payload: { queueItemId: inputId },
			baseRevision: (await snapshot()).revision,
			issuedAt: Date.now(),
		};
		// Replay the identical envelope: command idempotency cannot replace the native target twice.
		expect(await peer.request("v4/command", request)).toMatchObject({ status: "accepted" });
		const promoted = await snapshot();
		expect(promoted.goal).toMatchObject({ objective, status: "active" });
		const targetId = promoted.goal?.targetId;
		const replay = await peer.request("v4/command", request);
		expect(replay).toMatchObject({ status: expect.stringMatching(/^(?:accepted|duplicate)$/) });
		expect((await snapshot()).goal?.targetId).toBe(targetId);
		// Native steering keeps the input pending until the in-flight HTTP response lands.
		expect(promoted.queue.items.map(item => item.queueItemId)).toEqual([inputId, siblingId]);
		expect(promoted.rows.window.some(row => row.kind === "userInput" && row.sourceCommandId === inputId)).toBe(false);
		config.releaseHeldStream("ZCODE_TEST_STOP_PROMOTED_GOAL_BASE");
		await peer.next(frame => frame.method === "v4/conversation/frame" && hasUserInput(frame.params, inputId));
		const consumed = await snapshot();
		expect(consumed.queue.items.map(item => item.queueItemId)).toEqual([siblingId]);
		expect(consumed.queue.autoDrain).toBe(false);
		expect(
			consumed.rows.window.find(row => row.kind === "userInput" && row.sourceCommandId === inputId),
		).toMatchObject({ sourceCommandId: inputId });
		expect(consumed.rows.window.some(row => row.kind === "userInput" && row.sourceCommandId === promotionId)).toBe(
			false,
		);
		const requestBody = await config.waitForRequest(request =>
			JSON.stringify(request.messages.at(-1)).includes(objective),
		);
		expect(JSON.stringify(requestBody.messages.at(-1))).not.toContain(`/goal ${objective}`);
		expect(JSON.stringify(config.requests)).not.toContain("ZCODE_TEST_UNSELECTED_GOAL_SIBLING");
		await command(peer, id, "stop", {});
		expect(await peer.eof()).toBe(0);
		const files = await fs.readdir(path.join(config.agentDir, "sessions"), { recursive: true });
		const journalFile = files.find(file => file.endsWith(`_${id}.jsonl`));
		if (!journalFile) throw new Error("Missing promoted Goal journal");
		const entries = (await fs.readFile(path.join(config.agentDir, "sessions", journalFile), "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as unknown);
		expect(
			entries.find(
				entry =>
					isRecord(entry) &&
					entry.type === "message" &&
					isRecord(entry.message) &&
					entry.message.role === "user" &&
					entry.message.inputId === inputId,
			),
		).toMatchObject({ message: { inputId, sourceCommand: { commandId: inputId, type: "sendGoalCommand" } } });
	}, 120_000);

	test("host subagent runtime config overrides apply to spawned task children", async () => {
		await using root = await TempDir.create("@zcode-subagent-config-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		// I20:runtime 会话建立时向 Host 发起一次 subagents/readRuntimeConfig;
		// general-purpose 覆盖映射到 OMP task agent,子代理请求使用覆盖模型。
		peer.reverseReply = frame => {
			if (frame.method !== "subagents/readRuntimeConfig") return undefined;
			expect(frame.params).toMatchObject({ sessionId: expect.any(String) });
			return {
				kind: "ready",
				profiles: [],
				builtInModelSelectionOverrides: {
					"general-purpose": { ...model, modelId: "chat-b", options: { reasoningLevel: "disabled" } },
				},
				pluginAgentModelSelectionOverrides: {},
			};
		};
		await peer.ready();
		const id = await create(peer, config.cwdA);
		expect(peer.seen.some(frame => frame.method === "subagents/readRuntimeConfig")).toBe(true);
		await subscribe(peer, id);
		expect(await command(peer, id, "sendText", { text: "ZCODE_TEST_DELEGATE" })).toMatchObject({
			status: "accepted",
		});
		await finishedOutput(peer, id, "ZCODE_TEST_DELEGATE_DONE");
		// 父任务默认后台运行，父 idle 只证明 receipt；等待真正带工具面的 child 请求，
		// 而非同样引用 assignment、但使用 smol 模型且无工具的 task-label 请求。
		const child = await config.waitForRequest(
			request =>
				(request.tools?.length ?? 0) > 0 &&
				request.messages.some(
					message =>
						message.role === "user" && JSON.stringify(message.content).includes("ZCODE_TEST_CHILD_MARKER"),
				),
		);
		expect(child.model).toBe("chat-b");
		expect(
			config.requests.find(request => JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_DELEGATE"))
				?.model,
		).toBe("chat-a");
		const children = LegacyProtocol.zcodeSessionSubagentsResultSchema.parse(
			await peer.request("session/subagents", { sessionId: id }),
		);
		const childId = children.childSessionIds[0];
		if (!childId) throw new Error("Native child history was not registered");
		const watched = await subscribe(peer, childId, "web-remote-replayable");
		await output(peer, childId, "ZCODE_TEST_CHILD_MARKER_DONE");
		const count = config.requests.length;
		expect(await peer.request("session/close", { sessionId: id })).toEqual({ closed: true });
		const rows = v4ConversationRowsRangeResultSchema.parse(
			await peer.request("v4/conversation/rowsRange", { sessionId: childId, limit: 100 }),
		);
		expect(JSON.stringify(rows)).toContain("ZCODE_TEST_CHILD_MARKER_DONE");
		const { ack } = watched as { ack: { subscriptionId: string } };
		expect(
			await peer.request("v4/conversation/resync", {
				topic: `conversation/${childId}`,
				connectionId: "test-web-remote-replayable",
				subscriptionId: ack.subscriptionId,
				base: { logEpoch: rows.atLogEpoch, seq: rows.atSeq },
				forceSnapshot: true,
			}),
		).toMatchObject({ ack: { subscriptionId: ack.subscriptionId, mode: "snapshot" } });
		expect(config.requests).toHaveLength(count);
	}, 180_000);

	test("two Host owners cannot write one journal and profiles resolve independent storage", async () => {
		await using root = await TempDir.create("@zcode-owner-");
		await using config = await fixture(root);
		await using owner = new ProcessPeer(config.cwdA, config.env);
		await owner.ready();
		const id = await create(owner, config.cwdA);
		await using contender = new ProcessPeer(config.cwdA, config.env);
		await contender.ready();
		const conflict = await contender.requestFrame("session/resume", { sessionId: id });
		expect(conflict.error).toMatchObject({ code: expect.any(Number) });
		for (const method of ["skills/referenceCatalog", "plugins/referenceCatalog"]) {
			const activeCatalog = await owner.request(method, { workspace: workspace(config.cwdA), sessionId: id });
			expect(activeCatalog).toMatchObject({ authority: "session" });
			expect(await owner.requestFrame(method, { workspace: workspace(config.cwdB), sessionId: id })).toMatchObject({
				error: { code: -32602 },
			});
			expect(
				await contender.requestFrame(method, { workspace: workspace(config.cwdA), sessionId: id }),
			).toMatchObject({ error: { code: -32004 } });
		}
		await using otherProfile = new ProcessPeer(config.cwdA, config.env, ["--profile", "independent"]);
		await otherProfile.ready();
		const history = await otherProfile.request("session/list", { workspace: workspace(config.cwdA) });
		expect(JSON.stringify(history)).not.toContain(id);
		expect(config.requests).toHaveLength(0);
	}, 120_000);

	test("cold history reads do not execute and replayable recovery replaces unknown epochs", async () => {
		await using root = await TempDir.create("@zcode-cold-");
		await using config = await fixture(root);
		let id: string;
		const commandId = crypto.randomUUID();
		let originalReceipt: unknown;
		const proofPath = path.join(config.cwdA, "proof.txt");
		let proofModifiedAt = 0;
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			id = await create(peer, config.cwdA);
			await subscribe(peer, id);
			originalReceipt = await command(peer, id, "sendText", { text: "ZCODE_TEST_COLD_TOOL" }, commandId);
			await finishedOutput(peer, id, "ZCODE_TEST_COLD_TOOL_DONE");
			expect(await fs.readFile(proofPath, "utf8")).toBe("ZCODE_TEST_COLD_TOOL");
			proofModifiedAt = (await fs.stat(proofPath)).mtimeMs;
			expect(await peer.eof()).toBe(0);
		}
		const requestCount = config.requests.length;
		await using cold = new ProcessPeer(config.cwdA, config.env);
		await cold.ready();
		const history = await cold.request("session/messages", { sessionId: id });
		expect(JSON.stringify(history)).toContain("ZCODE_TEST_COLD_TOOL_DONE");
		await cold.request("session/list", { workspace: workspace(config.cwdA) });
		expect(config.requests).toHaveLength(requestCount);
		const recovery = await subscribe(cold, id, "web-remote-replayable", { logEpoch: "previous-process", seq: 999 });
		expect(recovery).toMatchObject({ ack: { mode: "snapshot", logEpoch: expect.any(String) } });
		const frame = await output(cold, id, "ZCODE_TEST_COLD_TOOL_DONE");
		expect(conversationTopicWireFrameSchema.safeParse(frame.params).success).toBe(true);
		expect(config.requests).toHaveLength(requestCount);
		const disposition = await cold.request("v4/commands/query", { commands: [{ sessionId: id, commandId }] });
		expect(disposition).toMatchObject({
			results: [{ key: { sessionId: id, commandId }, result: { commandId, status: "accepted" } }],
		});
		const duplicate = await command(cold, id, "sendText", { text: "ZCODE_TEST_COLD_TOOL" }, commandId);
		if (!isRecord(originalReceipt)) throw new Error("Missing persisted command ACK");
		expect(duplicate).toEqual({ ...originalReceipt, status: "duplicate" });
		expect(config.requests).toHaveLength(requestCount);
		const rows = v4ConversationRowsRangeResultSchema.parse(
			await cold.request("v4/conversation/rowsRange", { sessionId: id, limit: 100 }),
		);
		expect(rows.rows.filter(row => row.kind === "userInput" && row.sourceCommandId === commandId)).toHaveLength(1);
		expect(await fs.readFile(proofPath, "utf8")).toBe("ZCODE_TEST_COLD_TOOL");
		expect((await fs.stat(proofPath)).mtimeMs).toBe(proofModifiedAt);
		expect(config.requests).toHaveLength(requestCount);
	}, 120_000);
	test("cold projection eviction preserves pinned viewers and rebuilds history without replaying tools", async () => {
		await using root = await TempDir.create("@zcode-cold-cache-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const ids: string[] = [];
		for (let index = 0; index < 20; index++) {
			const id = await create(peer, config.cwdA);
			ids.push(id);
			if (index === 1) {
				await subscribe(peer, id);
				await command(peer, id, "sendText", { text: "ZCODE_TEST_CACHE_TOOL" });
				await finishedOutput(peer, id, "ZCODE_TEST_CACHE_TOOL_DONE");
				// Keep this cold projection unobserved until the next explicit subscription.
				await peer.request("v4/connection/flow", { connectionId: "test-desktop-continuous", state: "closed" });
			}
			await peer.request("session/close", { sessionId: id });
		}
		const count = config.requests.length;
		const proof = path.join(config.cwdA, "proof.txt");
		const modified = (await fs.stat(proof)).mtimeMs;
		const read = async (id: string) =>
			v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId: id, limit: 100 }),
			);
		const epochs = new Map<string, string>();
		for (const id of ids) {
			await peer.request("v4/conversation/subscribe", {
				topic: `conversation/${id}`,
				connectionId: "cache-viewer",
				clientMode: "desktop-continuous",
				includeSpecDriven: true,
			});
			epochs.set(id, (await read(id)).atLogEpoch);
		}
		// More active viewers than idle cache slots must remain attached to their epochs.
		expect((await read(ids[0]!)).atLogEpoch).toBe(epochs.get(ids[0]!)!);
		await peer.request("v4/connection/flow", { connectionId: "cache-viewer", state: "closed" });
		// Access refreshed the first entry, so it survives; the oldest remaining entry is evicted.
		expect((await read(ids[0]!)).atLogEpoch).toBe(epochs.get(ids[0]!)!);
		expect((await read(ids.at(-1)!)).atLogEpoch).toBe(epochs.get(ids.at(-1)!)!);
		const rebuilt = await read(ids[1]!);
		expect(rebuilt.atLogEpoch).not.toBe(epochs.get(ids[1]!));
		expect(JSON.stringify(rebuilt.rows)).toContain("ZCODE_TEST_CACHE_TOOL_DONE");
		for (const clientMode of ["desktop-continuous", "web-remote-replayable"]) {
			const result = await peer.request("v4/conversation/subscribe", {
				topic: `conversation/${ids[1]}`,
				connectionId: `recovered-${clientMode}`,
				clientMode,
				includeSpecDriven: true,
				base: { logEpoch: epochs.get(ids[1]!), seq: 0 },
			});
			expect(result).toMatchObject({ ack: { mode: "snapshot", logEpoch: rebuilt.atLogEpoch } });
		}
		expect(
			await peer.requestFrame("v4/conversation/rowsRange", { sessionId: crypto.randomUUID(), limit: 1 }),
		).toHaveProperty("error");
		expect(await fs.readFile(proof, "utf8")).toBe("ZCODE_TEST_CACHE_TOOL");
		expect((await fs.stat(proof)).mtimeMs).toBe(modified);
		expect(config.requests).toHaveLength(count);
	}, 120_000);

	test("cold native Dev stage history is queryable without acquiring a workspace owner", async () => {
		await using root = await TempDir.create("@zcode-native-dev-history-");
		await using config = await fixture(root);
		const directory = path.join(config.cwdA, ".omp", "dev", "sessions", "cold-run");
		const stage = SessionManager.create(config.cwdA, directory);
		stage.appendMessage({
			role: "user",
			content: [{ type: "text", text: "native-stage-history" }],
			timestamp: Date.now(),
		});
		await stage.ensureOnDisk();
		await stage.flush();
		const id = stage.getSessionId();
		const file = stage.getSessionFile()!;
		await stage.close();
		const before = await fs.readFile(file, "utf8");
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const requests = config.requests.length;
		const listed = LegacyProtocol.zcodeSessionListResultSchema.parse(
			await peer.request("session/list", {
				workspace: workspace(config.cwdA),
			}),
		);
		expect(listed.sessions.some(session => session.sessionId === id)).toBe(true);
		for (const clientMode of ["desktop-continuous", "web-remote-replayable"]) {
			await peer.request("v4/conversation/subscribe", {
				topic: `conversation/${id}`,
				connectionId: `native-stage-${clientMode}`,
				clientMode,
				includeSpecDriven: true,
			});
			const rows = v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", {
					sessionId: id,
					limit: 100,
				}),
			);
			expect(rows.rows.some(row => row.kind === "userInput" && row.text === "native-stage-history")).toBe(true);
		}
		expect(config.requests).toHaveLength(requests);
		expect(await fs.readFile(file, "utf8")).toBe(before);
		const owner = await DevWorkspace.acquire(config.cwdA);
		owner.release();
	}, 120_000);
});
