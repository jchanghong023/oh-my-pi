import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	commandAckSchema,
	commandsQueryResultSchema,
	LegacyProtocol,
	conversationTopicWireFrameSchema,
} from "../../src/modes/zcode/schema";
import { conversationTelemetryFactSchema } from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/telemetry";
import {
	type Frame,
	model,
	ProcessPeer,
	fixture,
	create,
	command,
	subscribe,
	output,
	findInteraction,
	finishedOutput,
} from "./zcode-process-harness";

describe("ZCode actual public app-server process", () => {
	test("clock probes bypass corrupt journals while ordinary command queries retain durable facts", async () => {
		await using root = await TempDir.create("@zcode-clock-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const key = { sessionId: null, commandId: crypto.randomUUID() };
		const ack = commandAckSchema.parse(
			await peer.request("v4/command", {
				...key,
				clientId: "public-process-test",
				type: "createSession",
				payload: { workspaceId: config.cwdA },
				issuedAt: Date.now(),
			}),
		);
		expect(ack).toMatchObject({ status: "accepted", result: { type: "createSession" } });
		const ordinary = commandsQueryResultSchema.parse(await peer.request("v4/commands/query", { commands: [key] }));
		expect(ordinary).toEqual({ results: [{ key, result: ack }] });
		const startedAt = performance.timeOrigin + performance.now();
		const probe = commandsQueryResultSchema.parse(
			await peer.request("v4/commands/query", { commands: [key], clock: true }),
		);
		const endedAt = performance.timeOrigin + performance.now();
		expect(probe.results).toEqual([{ key, result: "unknown" }]);
		if (!probe.clock) throw new Error("Missing app-server calibration clock");
		expect(probe.clock.receivedAt).toBeGreaterThanOrEqual(startedAt);
		expect(probe.clock.sentAt).toBeGreaterThanOrEqual(probe.clock.receivedAt);
		expect(probe.clock.sentAt).toBeLessThanOrEqual(endedAt);
		const keys = Array.from({ length: 64 }, (_, index) => ({ sessionId: null, commandId: `probe-${index}` }));
		const batch = commandsQueryResultSchema.parse(
			await peer.request("v4/commands/query", { commands: keys, clock: true }),
		);
		expect(batch.results).toEqual(keys.map(key => ({ key, result: "unknown" })));
		expect(batch.clock?.instanceId).toBe(probe.clock.instanceId);
		expect(await peer.eof()).toBe(0);
		// 冷进程消除内存 receipt 的影响；同一损坏 journal 必须阻断事实查询，却不影响纯时钟探测。
		const files = await fs.readdir(path.join(config.agentDir, "sessions"), { recursive: true });
		const journal = files.find(file => file.endsWith(".jsonl"));
		if (!journal) throw new Error("Missing durable createSession journal");
		await fs.writeFile(path.join(config.agentDir, "sessions", journal), "{invalid journal\n");
		await using cold = new ProcessPeer(config.cwdA, config.env);
		await cold.ready();
		const coldProbe = commandsQueryResultSchema.parse(
			await cold.request("v4/commands/query", { commands: [key], clock: true }),
		);
		expect(coldProbe.results).toEqual([{ key, result: "unknown" }]);
		expect(coldProbe.clock?.instanceId).toBeDefined();
		expect(coldProbe.clock?.instanceId).not.toBe(probe.clock.instanceId);
		expect((await cold.requestFrame("v4/commands/query", { commands: [key] })).error).toBeDefined();
		expect(config.requests).toHaveLength(0);
		expect(await cold.eof()).toBe(0);
	}, 90_000);

	test("workflow actor viewers retain the parent permission owner until the last real connection closes", async () => {
		await using root = await TempDir.create("@zcode-actor-owner-");
		await using config = await fixture(root);
		const directory = path.join(config.cwdA, ".zcode", "workflows");
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(
			path.join(directory, "permission-owner.dwf.ts"),
			'/* zcode-workflow\ndescription: Scoped actor permission ownership\n*/\nconst writer = agent("writer");\nreturn await writer.ask("ZCODE_TEST_TOOL_WORKFLOW_OWNER");\n',
		);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		for (const closeParentFirst of [true, false]) {
			const sessionId = await create(peer, config.cwdA);
			const parentConnection = `parent-${closeParentFirst}`;
			const actorConnection = `actor-${closeParentFirst}`;
			await peer.request("v4/conversation/subscribe", {
				topic: `conversation/${sessionId}`,
				connectionId: parentConnection,
				clientMode: "desktop-continuous",
			});
			expect(await command(peer, sessionId, "switchCollaborationMode", { mode: "build" })).toMatchObject({
				status: "accepted",
			});
			expect(
				await command(peer, sessionId, "startSavedWorkflow", { name: "permission-owner", args: {} }),
			).toMatchObject({ status: "accepted" });
			const isPermission = (payload: Frame) => payload.kind === "permission" && payload.toolName === "write";
			const waiting = await peer.next(
				frame =>
					frame.method === "v4/conversation/frame" &&
					isRecord(frame.params) &&
					frame.params.topic === `conversation/${sessionId}` &&
					findInteraction(frame.params, isPermission) !== undefined,
			);
			const interaction = findInteraction(waiting.params, isPermission)!;
			const interactionId = interaction.interactionId;
			if (typeof interactionId !== "string") throw new Error("Workflow permission has no interaction identity");
			if (!isRecord(interaction.payload) || !isRecord(interaction.payload.origin))
				throw new Error("Workflow permission has no native child origin");
			const actorId = interaction.payload.origin.childSessionId;
			if (typeof actorId !== "string") throw new Error("Workflow permission has no actor identity");
			const topic = `conversation/${actorId}`;
			const subscription = await peer.request("v4/conversation/subscribe", {
				topic,
				connectionId: actorConnection,
				clientMode: "web-remote-replayable",
			});
			if (!isRecord(subscription) || !isRecord(subscription.ack))
				throw new Error("Missing actor subscription acknowledgment");
			// 退订仅撤掉投影，不撤掉实际连接对父级 scoped 审批的所有权。
			await peer.request("v4/conversation/unsubscribe", {
				topic,
				connectionId: actorConnection,
				subscriptionId: subscription.ack.subscriptionId,
			});
			const first = closeParentFirst ? parentConnection : actorConnection;
			const last = closeParentFirst ? actorConnection : parentConnection;
			await peer.request("v4/connection/flow", { connectionId: first, state: "closed" });
			const retained = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
				await peer.request("session/read", { sessionId }),
			);
			expect(retained.runtime.pendingRequestIds).toContain(interactionId);
			await peer.request("v4/connection/flow", { connectionId: last, state: "closed" });
			const cancelled = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
				await peer.request("session/read", { sessionId }),
			);
			expect(cancelled.runtime.pendingRequestIds).not.toContain(interactionId);
			expect(await Bun.file(path.join(config.cwdA, "proof.txt")).exists()).toBe(false);
			expect(await command(peer, sessionId, "stop", {})).toMatchObject({ status: "accepted" });
		}
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("canonical skill references execute the resident native skill rather than remaining model prose", async () => {
		await using root = await TempDir.create("@zcode-native-reference-");
		await using config = await fixture(root, true);
		const directory = path.join(config.cwdA, ".omp", "skills", "zcode-reference");
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(
			path.join(directory, "SKILL.md"),
			"---\nname: zcode-reference\ndescription: Native reference process fixture\n---\nNative reference evidence body.\n",
		);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const sessionId = await create(peer, config.cwdA);
		await subscribe(peer, sessionId);
		expect(
			await command(peer, sessionId, "sendText", { text: "$zcode-reference ZCODE_TEST_SKILL_REFERENCE" }),
		).toMatchObject({ status: "accepted" });
		await finishedOutput(peer, sessionId, "ZCODE_TEST_SKILL_REFERENCE_DONE");
		const request = config.requests.find(item =>
			JSON.stringify(item.messages).includes("ZCODE_TEST_SKILL_REFERENCE"),
		);
		expect(request).toBeDefined();
		expect(JSON.stringify(request?.messages)).toContain("Native reference evidence body.");
	}, 90_000);

	test("prepare observes path before mutation and normal startup has its own ready attempt", async () => {
		await using root = await TempDir.create("@zcode-prepare-");
		await using config = await fixture(root);
		await using prepare = new ProcessPeer(config.cwdA, config.env, ["--prepare-storage"]);
		const profile = await prepare.next(frame => frame.method === "omp/startup/profile");
		const declaration = await prepare.next(frame => frame.method === "startup/storagePath");
		const resourcePath = LegacyProtocol.zcodeStoragePreparationFrameSchema.options[0].parse(declaration).params.path;
		expect(path.isAbsolute(resourcePath)).toBe(true);
		expect(prepare.seen.indexOf(profile)).toBeLessThan(prepare.seen.indexOf(declaration));
		expect(prepare.seen.some(frame => frame.method === "startup/storagePrepared")).toBe(false);
		prepare.write({ method: "startup/storagePathReady", reuse: false });
		const preparedReady = await prepare.ready();
		await prepare.next(frame => frame.method === "startup/storagePrepared");
		expect(await prepare.eof()).toBe(0);
		const preparedStates = prepare.seen
			.filter(frame => frame.method === "startup/storageState")
			.map(frame => LegacyProtocol.zcodeStorageStartupStateSchema.parse(frame.params));
		expect(preparedStates.map(state => state.phase)).toEqual(["checking", "ready"]);
		expect(preparedStates[1]!.sequence).toBeGreaterThan(preparedStates[0]!.sequence);
		expect(preparedStates[1]!.attemptId).toBe(preparedStates[0]!.attemptId);
		expect(preparedStates[1]!.databaseId).toBe(preparedStates[0]!.databaseId);
		// Host 只对同一已准备资源确认 reuse；不能再初始化或改变 profile/storage 身份。
		await using reuse = new ProcessPeer(config.cwdA, config.env, ["--prepare-storage"]);
		const reusedProfile = await reuse.next(frame => frame.method === "omp/startup/profile");
		const reusedPath = await reuse.next(frame => frame.method === "startup/storagePath");
		expect(reusedPath.params).toEqual(declaration.params);
		expect(reusedProfile.params).toEqual(profile.params);
		reuse.write({ method: "startup/storagePathReady", reuse: true });
		await reuse.next(frame => frame.method === "startup/storagePrepared");
		expect(await reuse.eof()).toBe(0);
		expect(reuse.seen.some(frame => frame.method === "startup/storageState")).toBe(false);
		await using normal = new ProcessPeer(config.cwdA, config.env);
		const normalReady = await normal.ready();
		expect(normalReady.params).not.toEqual(preparedReady.params);
		const nativeProfile = await normal.request("omp/profiles/list", {
			workspace: { workspaceKey: config.cwdA, workspacePath: config.cwdA },
		});
		if (!isRecord(profile.params)) throw new Error("Expected native startup profile identity");
		expect(nativeProfile).toMatchObject(profile.params);
		expect(config.requests).toHaveLength(0);
		expect(await normal.eof()).toBe(0);
	}, 90_000);

	test("preparation failures and invalid envelopes fail closed; unknown shutdown leaves the owner alive", async () => {
		await using root = await TempDir.create("@zcode-failure-");
		await using config = await fixture(root);
		for (const ack of [undefined, { method: "startup/storagePathReady", params: { reuse: true } }]) {
			await using peer = new ProcessPeer(config.cwdA, config.env, ["--prepare-storage"]);
			await peer.next(frame => frame.method === "startup/storagePath");
			if (ack) peer.write(ack);
			expect(await peer.eof()).not.toBe(0);
			expect(peer.seen.some(frame => frame.method === "startup/storagePrepared")).toBe(false);
			const failed = peer.seen
				.filter(frame => frame.method === "startup/storageState")
				.map(frame => LegacyProtocol.zcodeStorageStartupStateSchema.parse(frame.params));
			expect(failed).toHaveLength(1);
			expect(failed[0]).toMatchObject({
				phase: "failed",
				errorCode: ack ? "open_failed" : "transport_closed",
			});
		}
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const response = await peer.requestFrame("v4/command", {
			protocolVersion: 999,
			type: "sendText",
			payload: { text: "must never execute" },
		});
		expect(response.error).toMatchObject({ code: expect.any(Number) });
		expect((await peer.requestFrame("runtime/shutdown", {})).error).toMatchObject({ code: -32601 });
		expect(await peer.request("runtime/capabilities", {})).toBeDefined();
		expect(config.requests).toHaveLength(0);
		expect(await peer.eof()).toBe(0);
	}, 90_000);

	test("materialized native Memory policy stays frozen in ACK and live telemetry across cold restore", async () => {
		await using root = await TempDir.create("@zcode-memory-policy-");
		await using config = await fixture(root);
		let sessionId: string;
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			peer.memoryEnabled = true;
			sessionId = await create(peer, config.cwdA);
			await subscribe(peer, sessionId);
			peer.memoryEnabled = false;
			const inputId = crypto.randomUUID();
			expect(
				await command(peer, sessionId, "sendText", { text: "ZCODE_TEST_MEMORY_POLICY" }, inputId),
			).toMatchObject({ status: "accepted", memoryEnabled: true });
			await finishedOutput(peer, sessionId, "ZCODE_TEST_MEMORY_POLICY_DONE");
			const terminal = await peer.next(
				frame =>
					frame.method === "v4/telemetry/event" &&
					isRecord(frame.params) &&
					frame.params.sessionId === sessionId &&
					frame.params.kind === "turn.terminal",
			);
			expect(conversationTelemetryFactSchema.parse(terminal.params)).toMatchObject({
				sessionId,
				sourceCommandId: inputId,
				memoryEnabled: true,
			});
			expect(await peer.eof()).toBe(0);
		}
		await using restored = new ProcessPeer(config.cwdA, config.env);
		await restored.ready();
		await restored.request("session/resume", { sessionId });
		await subscribe(restored, sessionId);
		expect(await command(restored, sessionId, "sendText", { text: "ZCODE_TEST_MEMORY_RESTORED" })).toMatchObject({
			status: "accepted",
			memoryEnabled: true,
		});
		await finishedOutput(restored, sessionId, "ZCODE_TEST_MEMORY_RESTORED_DONE");
	}, 120_000);

	test("GUI canonical disabled reasoning admits create first input and execution-scoped input", async () => {
		await using root = await TempDir.create("@zcode-gui-reasoning-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const selection = { ...model, options: { reasoningLevel: "disabled" } };
		const created = await peer.request("v4/command", {
			commandId: crypto.randomUUID(),
			clientId: "public-process-test",
			sessionId: null,
			type: "createSession",
			payload: {
				workspaceId: config.cwdA,
				firstInput: { text: "ZCODE_TEST_STOP_GUI_FIRST", modelSelection: selection },
			},
			issuedAt: Date.now(),
		});
		expect(created).toMatchObject({ status: "accepted", memoryEnabled: false, result: { type: "createSession" } });
		if (!isRecord(created) || !isRecord(created.result) || typeof created.result.sessionId !== "string")
			throw new Error("GUI first input did not bind an actual session");
		const id = created.result.sessionId;
		await subscribe(peer, id);
		const snapshotFrame = await peer.next(
			frame =>
				frame.method === "v4/conversation/frame" &&
				isRecord(frame.params) &&
				frame.params.topic === `conversation/${id}` &&
				frame.params.kind === "complete" &&
				isRecord(frame.params.frame) &&
				isRecord(frame.params.frame.payload) &&
				frame.params.frame.payload.kind === "snapshot",
		);
		expect(conversationTopicWireFrameSchema.parse(snapshotFrame.params)).toMatchObject({
			kind: "complete",
			frame: {
				payload: {
					kind: "snapshot",
					snapshot: { config: { thought: "disabled" } },
				},
			},
		});
		await output(peer, id, "ZCODE_TEST_STOP_GUI_FIRST_STREAMING");
		expect(await command(peer, id, "stop", {})).toMatchObject({ status: "accepted" });
		expect(
			await command(peer, id, "sendText", {
				text: "ZCODE_TEST_GUI_EXECUTION",
				modelSelection: selection,
				modelExecution: { selectionScope: "execution" },
			}),
		).toMatchObject({ status: "accepted" });
		await finishedOutput(peer, id, "ZCODE_TEST_GUI_EXECUTION_DONE");
		expect(
			config.requests.some(request => JSON.stringify(request.messages).includes("ZCODE_TEST_GUI_EXECUTION")),
		).toBe(true);
	}, 120_000);

	test("accepted model selection stays canonical session config across switch, refresh and cold restore", async () => {
		await using root = await TempDir.create("@zcode-model-selection-");
		await using config = await fixture(root);
		const alternate = { providerId: model.providerId, modelId: "chat-b", options: { reasoningLevel: "disabled" } };
		const snapshotConfig = async (peer: ProcessPeer, sessionId: string, clientMode = "desktop-continuous") => {
			await subscribe(peer, sessionId, clientMode);
			const frame = await peer.next(
				item =>
					item.method === "v4/conversation/frame" &&
					isRecord(item.params) &&
					item.params.topic === `conversation/${sessionId}` &&
					item.params.kind === "complete" &&
					isRecord(item.params.frame) &&
					isRecord(item.params.frame.payload) &&
					item.params.frame.payload.kind === "snapshot",
			);
			const parsed = conversationTopicWireFrameSchema.parse(frame.params);
			if (parsed.kind !== "complete" || parsed.frame.payload.kind !== "snapshot")
				throw new Error("Snapshot frame was not delivered");
			return parsed.frame.payload.snapshot.config;
		};
		let sessionId: string;
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			const created = await peer.request("v4/command", {
				commandId: crypto.randomUUID(),
				clientId: "public-process-test",
				sessionId: null,
				type: "createSession",
				payload: {
					workspaceId: config.cwdA,
					firstInput: { text: "ZCODE_TEST_MODEL_KEEP", modelSelection: alternate },
				},
				issuedAt: Date.now(),
			});
			expect(created).toMatchObject({ status: "accepted", result: { type: "createSession" } });
			if (!isRecord(created) || !isRecord(created.result) || typeof created.result.sessionId !== "string")
				throw new Error("Session creation did not bind an actual session");
			sessionId = created.result.sessionId;
			await subscribe(peer, sessionId);
			await finishedOutput(peer, sessionId, "ZCODE_TEST_MODEL_KEEP_DONE");
			// 已接受的稀疏选择意图进入 canonical sessionConfig(B 缺陷:此前只刷新 effective 展示)。
			const initial = await snapshotConfig(peer, sessionId);
			expect(initial).toMatchObject({ modelSelection: alternate, thought: "disabled" });
			// switchModelConfig 接受的新选择写回 sessionConfig,成为最新会话事实。
			expect(
				await command(peer, sessionId, "switchModelConfig", {
					provider: alternate.providerId,
					model: alternate.modelId,
					thought: "disabled",
				}),
			).toMatchObject({ status: "accepted" });
			const switched = await snapshotConfig(peer, sessionId, "web-remote-replayable");
			expect(switched).toMatchObject({ modelSelection: alternate, model: "chat-b", thought: "disabled" });
			expect(await peer.eof()).toBe(0);
		}
		// 冷恢复:新进程从 journal 还原同一 canonical 选择,不落回默认/Recent。
		await using restored = new ProcessPeer(config.cwdA, config.env);
		await restored.ready();
		await restored.request("session/resume", { sessionId });
		expect(await snapshotConfig(restored, sessionId)).toMatchObject({
			modelSelection: alternate,
			model: "chat-b",
			thought: "disabled",
		});
	}, 120_000);
});
