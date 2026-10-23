import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import {
	LegacyProtocol,
	TopicWireFrameAssembler,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
	sessionsIndexTopicFrameSchema,
	sessionsIndexTopicWireCandidateSchema,
	subscribeAckSchema,
} from "../../src/modes/zcode/schema";
import type {
	ConversationSnapshot,
	PendingInteraction,
} from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/snapshot";

type Frame = Record<string, unknown>;
interface ModelRequest {
	model: string;
	messages: Array<{ role: string; content?: unknown }>;
	tools?: Array<{ function: { name: string; parameters?: unknown } }>;
}
const model = { providerId: "permission-local", modelId: "permission-chat" };
async function bounded<T>(promise: Promise<T>): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("Permission CLI timed out")), 30_000);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// 只持有本测试启动的 stdio CLI；不接触桌面、真实模型或其他进程。
class PermissionPeer {
	readonly child!: Subprocess<"pipe", "pipe", "pipe">;
	readonly stderr: Promise<string>;
	#queue: Frame[] = [];
	#changed = Promise.withResolvers<void>();
	#ended = false;
	#failure: unknown;
	#pump: Promise<void>;
	#id = 0;
	constructor(cwd: string, env: NodeJS.ProcessEnv) {
		this.child = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "../../src/cli.ts"),
				"app-server",
				"--stdio",
				"--surface",
				"desktop",
				"--cwd",
				cwd,
			],
			{
				cwd,
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		this.stderr = new Response(this.child.stderr).text();
		this.#pump = (async () => {
			try {
				for await (const frame of readJsonl<unknown>(this.child.stdout)) {
					if (!isRecord(frame)) throw new Error("Invalid CLI frame");
					if (typeof frame.method === "string" && frame.id !== undefined) {
						const result =
							frame.method === "session/requestRuntimePreferences"
								? { nativeSearchEnhancementsEnabled: false, memoryEnabled: false }
								: frame.method === "subagents/readRuntimeConfig"
									? {
											kind: "ready",
											profiles: [],
											builtInModelSelectionOverrides: {},
											pluginAgentModelSelectionOverrides: {},
										}
									: undefined;
						this.child.stdin.write(
							`${JSON.stringify(result === undefined ? { id: frame.id, error: { code: -32601, message: "No fixture handler" } } : { id: frame.id, result })}\n`,
						);
					}
					this.#queue.push(frame);
					const changed = this.#changed;
					this.#changed = Promise.withResolvers<void>();
					changed.resolve();
				}
			} catch (error) {
				this.#failure = error;
			} finally {
				this.#ended = true;
				this.#changed.resolve();
			}
		})();
	}
	async next(predicate: (frame: Frame) => boolean): Promise<Frame> {
		return bounded(
			(async () => {
				for (;;) {
					if (this.#failure) throw this.#failure;
					const index = this.#queue.findIndex(predicate);
					if (index >= 0) return this.#queue.splice(index, 1)[0]!;
					if (this.#ended) throw new Error(`CLI exited: ${await this.stderr}`);
					await this.#changed.promise;
				}
			})(),
		);
	}
	async request(method: string, params: unknown): Promise<unknown> {
		const id = `permission-${++this.#id}`;
		this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		const reply = await this.next(frame => frame.id === id);
		if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
		return reply.result;
	}
	async ready() {
		await this.next(
			frame => frame.method === "startup/storageState" && isRecord(frame.params) && frame.params.phase === "ready",
		);
	}
	async eof() {
		this.child.stdin.end();
		const code = await bounded(this.child.exited);
		await this.#pump;
		if (this.#failure) throw this.#failure;
		return code;
	}
	async [Symbol.asyncDispose]() {
		if (this.child.exitCode === null) {
			try {
				await this.eof();
			} catch {
				this.child.kill();
				await this.child.exited;
			}
		}
		await this.#pump;
	}
}

async function fixture(root: TempDir) {
	const cwd = root.join("workspace");
	const home = root.join("home");
	const configRoot = root.join("config");
	const agentDir = path.join(configRoot, "agent");
	for (const dir of [cwd, home, agentDir]) await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(cwd, "read-proof.txt"), "READ_ONLY_SENTINEL");
	let calls = 0;
	const requests: ModelRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions")
				return new Response("Unexpected endpoint", { status: 500 });
			const body = (await request.json()) as ModelRequest;
			requests.push(body);
			const userIndex = body.messages.findLastIndex(message => message.role === "user");
			const text = JSON.stringify(body.messages[userIndex]?.content);
			const marker = text?.match(/PERM_[A-Z_]+/u)?.[0] ?? "PERM_AUX";
			const toolFinished = body.messages.slice(userIndex + 1).some(message => message.role === "tool");
			const name = marker.startsWith("PERM_TASK_")
				? "task"
				: marker.includes("READ")
					? "read"
					: marker.includes("BASH")
						? "bash"
						: "write";
			const target = `${marker}.txt`;
			const args =
				name === "task"
					? {
							context: "Run the delegated permission regression in this workspace.",
							tasks: [
								{
									name: "PermissionChild",
									task: marker.replace("PERM_TASK_", "PERM_CHILD_"),
									solutionSpace: "One write call followed by a final answer.",
									// tools 在原生 task 中表示 eval-defined tools，不是内建工具 allowlist。
								},
							],
						}
					: name === "read"
						? { path: "read-proof.txt" }
						: name === "bash"
							? { command: `echo ${marker} >> ${target}` }
							: { path: target, content: marker };
			const tool = !toolFinished && body.tools?.some(entry => entry.function.name === name);
			const id = `permission-tool-${++calls}`;
			const chunk = (delta: unknown, finish: string | null = null) =>
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			return new Response(
				chunk({
					role: "assistant",
					...(tool
						? {
								tool_calls: [
									{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
								],
							}
						: { content: `${marker}_DONE` }),
				}) +
					chunk({}, tool ? "tool_calls" : "stop") +
					"data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  permission-local:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: permission-chat\n        reasoning: false\n`,
	);
	// 显式 prompt 覆盖 read/write/bash，保证走原生策略，不借 GUI 模式伪造审批。
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: permission-local/permission-chat\n  smol: permission-local/permission-chat\n  task: permission-local/permission-chat\nasync:\n  enabled: false\ntask:\n  batch: true\ntools:\n  xdev: false\n  approval:\n    read: prompt\n    write: prompt\n    bash: prompt\n",
	);
	return {
		cwd,
		requests,
		env: {
			PATH: Bun.env.PATH,
			SystemRoot: Bun.env.SystemRoot,
			WINDIR: Bun.env.WINDIR,
			TEMP: root.path(),
			TMP: root.path(),
			HOME: home,
			USERPROFILE: home,
			OMP_CONFIG_ROOT: configRoot,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CONFIG_DIR: ".omp",
			OMP_OFFLINE: "0",
			PI_NO_TITLE: "1",
			NO_PROXY: "127.0.0.1,localhost",
		},
		async [Symbol.asyncDispose]() {
			await server.stop(true);
		},
	};
}
async function create(peer: PermissionPeer, cwd: string) {
	return LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
		await peer.request("session/create", {
			workspace: { workspacePath: cwd, workspaceKey: cwd },
			model,
			titleGenerationEnabled: false,
		}),
	).session.sessionId;
}
async function command(peer: PermissionPeer, sessionId: string, type: string, payload: unknown) {
	return peer.request("v4/command", {
		commandId: crypto.randomUUID(),
		clientId: "permission-host",
		sessionId,
		type,
		payload,
		issuedAt: Date.now(),
	});
}
async function state(peer: PermissionPeer, sessionId: string) {
	return LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(await peer.request("session/read", { sessionId }));
}
async function waitState(peer: PermissionPeer, sessionId: string, waiting: boolean) {
	return bounded(
		(async () => {
			for (;;) {
				const snapshot = await state(peer, sessionId);
				if (waiting ? snapshot.projection.pendingPermissions.length > 0 : snapshot.projection.status === "idle")
					return snapshot;
				await peer.next(
					frame =>
						frame.method === "v4/conversation/frame" &&
						isRecord(frame.params) &&
						frame.params.topic === `conversation/${sessionId}`,
				);
			}
		})(),
	);
}
async function subscribe(
	peer: PermissionPeer,
	sessionId: string,
	connectionId: string,
	clientMode: "desktop-continuous" | "web-remote-replayable",
) {
	const topic = `conversation/${sessionId}`;
	const result = await peer.request("v4/conversation/subscribe", { topic, connectionId, clientMode });
	if (!isRecord(result)) throw new Error("Missing ACK");
	const ack = subscribeAckSchema.parse(result.ack);
	return { topic, connectionId, subscriptionId: ack.subscriptionId };
}
interface Subscription {
	topic: string;
	connectionId: string;
	subscriptionId: string;
}
async function snapshot(peer: PermissionPeer, subscription: Subscription): Promise<ConversationSnapshot> {
	await peer.request("v4/conversation/resync", { ...subscription, base: null, forceSnapshot: true });
	const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
	for (;;) {
		const frame = await peer.next(
			item =>
				item.method === "v4/conversation/frame" &&
				isRecord(item.params) &&
				item.params.subscriptionId === subscription.subscriptionId &&
				item.params.deliveryKind === "recovery",
		);
		for (const event of assembler.accept(conversationTopicWireCandidateSchema.parse(frame.params))) {
			if (event.kind === "fault") throw new Error(event.fault.reasonCode);
			if (event.frame.payload.kind === "snapshot") return event.frame.payload.snapshot;
		}
	}
}
async function permissionCount(peer: PermissionPeer, cwd: string, sessionId: string): Promise<number> {
	const topic = `sessions-index/${cwd}`;
	const connectionId = crypto.randomUUID();
	const result = await peer.request("v4/conversation/subscribe", {
		topic,
		connectionId,
		clientMode: "web-remote-replayable",
		workspace: { workspacePath: cwd, workspaceKey: cwd },
	});
	if (!isRecord(result)) throw new Error("Missing index ACK");
	const { subscriptionId } = subscribeAckSchema.parse(result.ack);
	const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
	for (;;) {
		const frame = await peer.next(
			item =>
				item.method === "v4/conversation/frame" &&
				isRecord(item.params) &&
				item.params.subscriptionId === subscriptionId,
		);
		for (const event of assembler.accept(sessionsIndexTopicWireCandidateSchema.parse(frame.params))) {
			if (event.kind === "fault") throw new Error(event.fault.reasonCode);
			if (event.frame.payload.kind !== "snapshot") continue;
			const count = event.frame.payload.snapshot.sessions.find(item => item.sessionId === sessionId)
				?.pendingInteractionSummary?.permissionCount;
			await peer.request("v4/connection/flow", { connectionId, state: "closed" });
			if (count === undefined) throw new Error("Session summary missing");
			return count;
		}
	}
}
async function permission(
	peer: PermissionPeer,
	sessionId: string,
	subscription: Subscription,
	marker: string,
): Promise<PendingInteraction> {
	await command(peer, sessionId, "sendText", { text: marker });
	const legacy = await waitState(peer, sessionId, true);
	const current = await snapshot(peer, subscription);
	const pending = current.pendingInteractions.find(item => item.kind === "permission");
	if (!pending || pending.payload.kind !== "permission") throw new Error("Real native permission missing");
	expect(current.control.phase).toBe("running");
	const toolCallId = pending.payload.toolCallId;
	const row = current.rows.window.find(item => item.kind === "toolCall" && item.toolCallId === toolCallId);
	expect(row).toMatchObject({
		status: "pendingApproval",
		approvalInteractionId: pending.interactionId,
		rowId: pending.anchorRowId,
	});
	expect(legacy.projection.pendingPermissions).toHaveLength(1);
	expect(legacy.projection.pendingPermissions[0]?.requestId).toBe(pending.interactionId);
	return pending;
}
async function absent(cwd: string, marker: string) {
	expect(await Bun.file(path.join(cwd, `${marker}.txt`)).exists()).toBe(false);
}

test("real native permissions: exact once/deny/cancel, session ownership, delivery recovery and lifecycle teardown", async () => {
	await using root = await TempDir.create("@zcode-permissions-");
	await using config = await fixture(root);
	await using peer = new PermissionPeer(config.cwd, config.env);
	await peer.ready();
	const id = await create(peer, config.cwd);
	const other = await create(peer, config.cwd);
	const desktop = await subscribe(peer, id, "permission-desktop", "desktop-continuous");
	const remote = await subscribe(peer, id, "permission-remote", "web-remote-replayable");
	await subscribe(peer, other, "permission-other", "desktop-continuous");
	const pending = await permission(peer, id, desktop, "PERM_WRITE_ONCE");
	await absent(config.cwd, "PERM_WRITE_ONCE");
	expect(await permissionCount(peer, config.cwd, id)).toBe(1);
	expect(
		await command(peer, id, "resolveInteraction", {
			interactionId: crypto.randomUUID(),
			answer: { optionId: "once" },
		}),
	).toMatchObject({ status: "noop" });
	expect((await snapshot(peer, remote)).pendingInteractions).toEqual(
		(await snapshot(peer, desktop)).pendingInteractions,
	);
	expect(
		await command(peer, other, "resolveInteraction", {
			interactionId: pending.interactionId,
			answer: { optionId: "once" },
		}),
	).toMatchObject({ status: "noop" });
	await absent(config.cwd, "PERM_WRITE_ONCE");
	await peer.request("v4/conversation/unsubscribe", remote);
	expect((await state(peer, id)).projection.pendingPermissions).toHaveLength(1);
	const reattached = await subscribe(peer, id, "permission-remote", "web-remote-replayable");
	expect((await snapshot(peer, reattached)).pendingInteractions[0]?.interactionId).toBe(pending.interactionId);
	await peer.request("v4/conversation/unsubscribe", desktop);
	await subscribe(peer, other, desktop.connectionId, "desktop-continuous");
	await peer.request("v4/connection/flow", { connectionId: desktop.connectionId, state: "closed" });
	expect((await state(peer, id)).projection.pendingPermissions).toHaveLength(1);
	expect(
		await command(peer, id, "resolveInteraction", {
			interactionId: pending.interactionId,
			answer: { optionId: "once" },
		}),
	).toMatchObject({ status: "accepted" });
	await waitState(peer, id, false);
	expect(await permissionCount(peer, config.cwd, id)).toBe(0);
	expect(await fs.readFile(path.join(config.cwd, "PERM_WRITE_ONCE.txt"), "utf8")).toBe("PERM_WRITE_ONCE");
	expect(
		await command(peer, id, "resolveInteraction", {
			interactionId: pending.interactionId,
			answer: { optionId: "once" },
		}),
	).toMatchObject({ status: "noop" });

	for (const [marker, optionId] of [
		["PERM_WRITE_DENY", "deny"],
		["PERM_WRITE_FORGED", "fullAccess"],
		["PERM_BASH_DENY", "deny"],
		["PERM_READ_DENY", "deny"],
	]) {
		const request = await permission(peer, id, reattached, marker!);
		await absent(config.cwd, marker!);
		await command(peer, id, "resolveInteraction", { interactionId: request.interactionId, answer: { optionId } });
		await waitState(peer, id, false);
		await absent(config.cwd, marker!);
	}
	const cancelled = await permission(peer, id, reattached, "PERM_WRITE_CANCEL");
	await command(peer, id, "resolveInteraction", {
		interactionId: cancelled.interactionId,
		answer: { action: "cancel", content: { optionId: "session" } },
	});
	await waitState(peer, id, false);
	await absent(config.cwd, "PERM_WRITE_CANCEL");
	for (const marker of ["PERM_WRITE_SECOND", "PERM_BASH_ONCE", "PERM_READ_ONCE"]) {
		const request = await permission(peer, id, reattached, marker);
		await absent(config.cwd, marker);
		await command(peer, id, "resolveInteraction", {
			interactionId: request.interactionId,
			answer: { optionId: "once" },
		});
		await waitState(peer, id, false);
		if (!marker.includes("READ"))
			expect(await fs.readFile(path.join(config.cwd, `${marker}.txt`), "utf8")).toContain(marker);
		expect(
			await command(peer, id, "resolveInteraction", {
				interactionId: request.interactionId,
				answer: { optionId: "once" },
			}),
		).toMatchObject({ status: "noop" });
		if (marker.includes("BASH"))
			expect((await fs.readFile(path.join(config.cwd, `${marker}.txt`), "utf8")).trim().split(/\r?\n/u)).toEqual([
				marker,
			]);
		if (marker.includes("READ"))
			expect(JSON.stringify((await snapshot(peer, reattached)).rows.window)).toContain("READ_ONLY_SENTINEL");
	}
	const stopped = await permission(peer, id, reattached, "PERM_WRITE_STOP");
	const stopping = peer.request("session/stop", { sessionId: id });
	const lateApproval = command(peer, id, "resolveInteraction", {
		interactionId: stopped.interactionId,
		answer: { optionId: "session" },
	});
	await stopping;
	expect(await lateApproval).toMatchObject({ status: "noop" });
	await waitState(peer, id, false);
	await absent(config.cwd, "PERM_WRITE_STOP");
	const disconnected = await permission(peer, id, reattached, "PERM_WRITE_DISCONNECT");
	await peer.request("v4/conversation/unsubscribe", reattached);
	expect((await state(peer, id)).projection.pendingPermissions).toHaveLength(1);
	await subscribe(peer, other, reattached.connectionId, "web-remote-replayable");
	await peer.request("v4/connection/flow", { connectionId: reattached.connectionId, state: "closed" });
	const final = await subscribe(peer, id, "permission-final", "desktop-continuous");
	await waitState(peer, id, false);
	expect(
		await command(peer, id, "resolveInteraction", {
			interactionId: disconnected.interactionId,
			answer: { optionId: "once" },
		}),
	).toMatchObject({ status: "noop" });
	await absent(config.cwd, "PERM_WRITE_DISCONNECT");
	await permission(peer, id, final, "PERM_WRITE_CLOSE");
	await peer.request("session/close", { sessionId: id });
	await absent(config.cwd, "PERM_WRITE_CLOSE");
	const eofSession = await create(peer, config.cwd);
	const eofSub = await subscribe(peer, eofSession, "permission-eof", "desktop-continuous");
	await permission(peer, eofSession, eofSub, "PERM_WRITE_EOF");
	const eofCode = await peer.eof();
	expect(eofCode, `Permission CLI exited with ${eofCode} during owner EOF:\n${await peer.stderr}`).toBe(0);
	await absent(config.cwd, "PERM_WRITE_EOF");
	expect(await fs.readFile(path.join(config.cwd, "read-proof.txt"), "utf8")).toBe("READ_ONLY_SENTINEL");
}, 120_000);

test("real task children retain native permission identity and parent once/deny/cancel routing", async () => {
	await using root = await TempDir.create("@zcode-child-permissions-");
	await using config = await fixture(root);
	await using peer = new PermissionPeer(config.cwd, config.env);
	await peer.ready();
	const parent = await create(peer, config.cwd);
	const desktop = await subscribe(peer, parent, "child-permission-desktop", "desktop-continuous");
	const waitChildState = async (marker: string, waiting: boolean) => {
		try {
			return await waitState(peer, parent, waiting);
		} catch (error) {
			const current = await state(peer, parent);
			const conversation = await snapshot(peer, desktop);
			throw new Error(
				`Task permission ${marker} failed while waiting for ${waiting ? "approval" : "idle"}:\n${JSON.stringify({
					state: current,
					conversation,
					modelRequests: config.requests.map(request => ({
						model: request.model,
						tools: request.tools?.map(tool => tool.function.name),
						taskSchema: request.tools?.find(tool => tool.function.name === "task")?.function.parameters,
						messages: request.messages.filter(message => message.role !== "system").slice(-8),
					})),
				})}`,
				{ cause: error },
			);
		}
	};
	for (const [suffix, answer] of [
		["ONCE", { optionId: "once" }],
		["DENY", { optionId: "deny" }],
		["CANCEL", { action: "cancel", content: { optionId: "once" } }],
	] as const) {
		const marker = `PERM_CHILD_${suffix}`;
		await command(peer, parent, "sendText", { text: `PERM_TASK_${suffix}` });
		await waitChildState(marker, true);
		const current = await snapshot(peer, desktop);
		const pending = current.pendingInteractions.find(item => item.kind === "permission");
		if (!pending || pending.payload.kind !== "permission") throw new Error("Native task child permission missing");
		const { origin } = pending.payload;
		if (!origin) throw new Error("Native task child identity missing");
		expect(origin).toMatchObject({ kind: "subagent", parentSessionId: parent });
		expect(origin.childSessionId).not.toBe(parent);
		expect(current.subagents?.childSessionIds).toContain(origin.childSessionId);
		expect(current.rows.window).toContainEqual(
			expect.objectContaining({ kind: "toolCall", toolCallId: origin.parentToolCallId }),
		);
		expect(pending.payload).toMatchObject({
			toolName: "write",
			detail: { path: `${marker}.txt`, content: marker },
		});
		// 身份来自真实 task → SDK → child registry 包装链，而非测试手工注入审批 scope。
		await absent(config.cwd, marker);
		const remote = await subscribe(peer, parent, `child-permission-${suffix}`, "web-remote-replayable");
		expect((await snapshot(peer, remote)).pendingInteractions).toEqual(current.pendingInteractions);
		expect(
			await command(peer, parent, "resolveInteraction", { interactionId: pending.interactionId, answer }),
		).toMatchObject({ status: "accepted" });
		await waitChildState(marker, false);
		if (suffix === "ONCE") expect(await fs.readFile(path.join(config.cwd, `${marker}.txt`), "utf8")).toBe(marker);
		else await absent(config.cwd, marker);
		expect(
			await command(peer, parent, "resolveInteraction", {
				interactionId: pending.interactionId,
				answer: { optionId: "once" },
			}),
		).toMatchObject({ status: "noop" });
		if (suffix !== "ONCE") await absent(config.cwd, marker);
	}
}, 120_000);
