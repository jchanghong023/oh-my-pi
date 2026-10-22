import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";
import type {
	ConversationTopicFrame,
	SubscribeAck,
} from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/transport";
import {
	LegacyProtocol,
	TopicWireFrameAssembler,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
	subscribeAckSchema,
	v4ConversationRowsRangeResultSchema,
} from "../../src/modes/zcode/schema";

type Frame = Record<string, unknown>;
type ModelRequest = {
	model: string;
	messages: Array<{ role: string; content?: unknown }>;
	tools?: Array<{ function: { name: string; parameters?: unknown } }>;
};
type LogicalFrame = ConversationTopicFrame;
interface CoreSubscription extends SubscribeAck {
	connectionId: string;
	topic: string;
	next(kind?: "initial" | "online" | "recovery"): Promise<LogicalFrame>;
}
const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const model = { providerId: "core-local", modelId: "core-chat" };

async function bounded<T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`Timed out: ${label}`)), ms);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// Only this test's CLI is owned here. No process-tree sweep or external process cleanup.
class CorePeer {
	readonly child!: Subprocess<"pipe", "pipe", "pipe">;
	readonly frames: Frame[] = [];
	readonly stderr: Promise<string>;
	readonly requests: Frame[] = [];
	#queue: Frame[] = [];
	#changed = Promise.withResolvers<void>();
	#ended = false;
	#failure: unknown;
	#pump: Promise<void>;
	#id = 0;
	constructor(cwd: string, env: NodeJS.ProcessEnv) {
		this.child = Bun.spawn([process.execPath, cli, "app-server", "--stdio", "--surface", "desktop", "--cwd", cwd], {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.stderr = new Response(this.child.stderr).text();
		this.#pump = (async () => {
			try {
				for await (const raw of readJsonl<unknown>(this.child.stdout)) {
					if (!isRecord(raw) || "jsonrpc" in raw || "type" in raw)
						throw new Error(`Unexpected stdout: ${JSON.stringify(raw)}`);
					this.frames.push(raw);
					if (typeof raw.method === "string" && raw.id !== undefined) {
						const result =
							raw.method === "session/requestRuntimePreferences"
								? { nativeSearchEnhancementsEnabled: false, memoryEnabled: false }
								: raw.method === "subagents/readRuntimeConfig"
									? {
											kind: "ready",
											profiles: [],
											builtInModelSelectionOverrides: {},
											pluginAgentModelSelectionOverrides: {},
										}
									: undefined;
						this.write(
							result === undefined
								? { id: raw.id, error: { code: -32601, message: "No fixture implementation" } }
								: { id: raw.id, result },
						);
					}
					this.#queue.push(raw);
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
	write(frame: Frame) {
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
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
			"public stdio frame",
		);
	}
	async request(method: string, params: unknown): Promise<unknown> {
		const id = `core-${++this.#id}`;
		const frame = { id, method, params };
		this.requests.push(frame);
		this.write(frame);
		const reply = await this.next(item => item.id === id);
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
		const code = await bounded(this.child.exited, "owner EOF exits CLI");
		await this.#pump;
		if (this.#failure) throw this.#failure;
		return code;
	}
	async close() {
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

async function fixture(root: string) {
	const cwdA = path.join(root, "workspace-a");
	const cwdB = path.join(root, "workspace-b");
	const home = path.join(root, "home");
	const configRoot = path.join(root, "config");
	const agentDir = path.join(configRoot, "agent");
	for (const dir of [cwdA, cwdB, home, agentDir]) await fs.mkdir(dir, { recursive: true });
	const requests: ModelRequest[] = [];
	const http: Array<{ url: string; body?: ModelRequest; error?: string }> = [];
	const held = new Map<string, { finish: () => void; cancelled: Promise<void> }>();
	let changed = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions") {
				http.push({ url: request.url, error: "Unexpected model/catalog endpoint" });
				return new Response("Unexpected endpoint", { status: 500 });
			}
			const body = (await request.json()) as ModelRequest;
			requests.push(body);
			http.push({ url: request.url, body });
			const user = [...body.messages].reverse().find(message => message.role === "user");
			const text = JSON.stringify(user?.content);
			const marker = text?.match(/CORE_(?:PARENT|CHILD|OTHER|OWNER|WORKFLOW)[A-Z_]*/u)?.[0] ?? "CORE_AUX";
			const hasTools = (body.tools?.length ?? 0) > 0;
			const latestUserIndex = body.messages.findLastIndex(message => message.role === "user");
			const toolFinished = body.messages.slice(latestUserIndex + 1).some(message => message.role === "tool");
			let tool: { name: string; args: unknown } | undefined;
			if (hasTools && !toolFinished && (marker === "CORE_PARENT" || marker === "CORE_OWNER")) {
				const item = {
					name: marker === "CORE_PARENT" ? "CoreChild" : "CoreOwner",
					agent: "task",
					task:
						marker === "CORE_PARENT"
							? "CORE_CHILD: write the requested proof then return CORE_CHILD_DONE."
							: "CORE_CHILD_OWNER: wait for the controlled response.",
					solutionSpace: "Fixed isolated native transport acceptance task",
				};
				const declaration = body.tools?.find(entry => entry.function.name === "task");
				tool = {
					name: "task",
					args: JSON.stringify(declaration?.function.parameters).includes('"tasks"')
						? { context: "Isolated protocol acceptance", tasks: [item] }
						: item,
				};
			} else if (hasTools && !toolFinished && (marker === "CORE_CHILD" || marker === "CORE_OTHER")) {
				tool = {
					name: "write",
					args: {
						path: marker === "CORE_CHILD" ? "child-proof.txt" : "other-proof.txt",
						content: `${marker}_PROOF`,
					},
				};
			}
			const cancellation = Promise.withResolvers<void>();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const chunk = (delta: unknown, finish: string | null = null) =>
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ id: `core-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
							),
						);
					chunk({
						role: "assistant",
						...(tool
							? {
									tool_calls: [
										{
											index: 0,
											id: `call-${requests.length}`,
											type: "function",
											function: { name: tool.name, arguments: JSON.stringify(tool.args) },
										},
									],
								}
							: { content: `${marker}_START` }),
					});
					const finish = () => {
						held.delete(marker);
						if (!tool) chunk({ content: ` ${marker}_DONE` });
						chunk({}, tool ? "tool_calls" : "stop");
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						controller.close();
					};
					if (
						hasTools &&
						!tool &&
						(marker === "CORE_CHILD" || marker === "CORE_CHILD_OWNER" || marker === "CORE_WORKFLOW")
					)
						held.set(marker, { finish, cancelled: cancellation.promise });
					else finish();
				},
				cancel() {
					held.delete(marker);
					cancellation.resolve();
				},
			});
			request.signal.addEventListener("abort", () => cancellation.resolve(), { once: true });
			const notification = changed;
			changed = Promise.withResolvers<void>();
			notification.resolve();
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  core-local:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: core-chat\n        reasoning: false\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: core-local/core-chat\n  smol: core-local/core-chat\ntools:\n  xdev: false\n",
	);
	const env: NodeJS.ProcessEnv = {
		PATH: Bun.env.PATH,
		SystemRoot: Bun.env.SystemRoot,
		WINDIR: Bun.env.WINDIR,
		TEMP: root,
		TMP: root,
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: configRoot,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_OFFLINE: "0",
		PI_NO_TITLE: "1",
		NO_PROXY: "127.0.0.1,localhost",
	};
	return {
		cwdA,
		cwdB,
		env,
		requests,
		http,
		server,
		held,
		async gate(marker: string) {
			return bounded(
				(async () => {
					for (;;) {
						const gate = held.get(marker);
						if (gate) return gate;
						await changed.promise;
					}
				})(),
				`local HTTP gate ${marker}`,
			);
		},
	};
}

async function create(peer: CorePeer, cwd: string) {
	return LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
		await peer.request("session/create", {
			workspace: { workspacePath: cwd, workspaceKey: cwd },
			model,
			titleGenerationEnabled: false,
		}),
	).session.sessionId;
}
async function send(peer: CorePeer, sessionId: string, text: string) {
	return peer.request("v4/command", {
		commandId: crypto.randomUUID(),
		clientId: "core-transport-host",
		sessionId,
		type: "sendText",
		payload: { text },
		issuedAt: Date.now(),
	});
}
async function subscription(
	peer: CorePeer,
	sessionId: string,
	connectionId: string,
	clientMode: "desktop-continuous" | "web-remote-replayable",
): Promise<CoreSubscription> {
	const result = await peer.request("v4/conversation/subscribe", {
		topic: `conversation/${sessionId}`,
		connectionId,
		clientMode,
	});
	if (!isRecord(result)) throw new Error("Missing subscription ACK");
	const ack = subscribeAckSchema.parse(result.ack);
	const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
	return {
		...ack,
		connectionId,
		topic: `conversation/${sessionId}`,
		async next(kind?: "initial" | "online" | "recovery"): Promise<LogicalFrame> {
			for (;;) {
				const notification = await peer.next(
					frame =>
						frame.method === "v4/conversation/frame" &&
						isRecord(frame.params) &&
						frame.params.subscriptionId === ack.subscriptionId &&
						(!kind || frame.params.deliveryKind === kind),
				);
				for (const event of assembler.accept(conversationTopicWireCandidateSchema.parse(notification.params))) {
					if (event.kind === "fault") throw new Error(`Wire assembly: ${event.fault.reasonCode}`);
					if (event.kind === "complete") return event.frame;
				}
			}
		},
	};
}
async function childFromParent(peer: CorePeer, parent: string): Promise<string> {
	for (;;) {
		const result = LegacyProtocol.zcodeSessionSubagentsResultSchema.parse(
			await peer.request("session/subagents", { sessionId: parent }),
		);
		if (result.childSessionIds[0]) return result.childSessionIds[0];
		await peer.next(
			frame =>
				frame.method === "v4/conversation/frame" &&
				isRecord(frame.params) &&
				frame.params.topic === `conversation/${parent}`,
		);
	}
}
async function markerFrame(sub: CoreSubscription, marker: string, cursor: number) {
	for (;;) {
		const frame = await sub.next();
		expect(frame.topic).toBe(sub.topic);
		expect(frame.fromSeq).toBe(cursor);
		expect(frame.toSeq).toBeGreaterThanOrEqual(frame.fromSeq);
		cursor = frame.toSeq;
		if (JSON.stringify(frame.payload).includes(marker)) return frame;
	}
}

// Protocol E2E only: these two trusted Host routes are not a mobile GUI/relay claim.
test("OMP-SA06/OMP-WF05/transport: native child and workflow delivery isolation, cold reads and owner EOF", async () => {
	const evidence = path.resolve(
		import.meta.dir,
		"../../../../runs/zcode-core-protocol",
		`${Date.now()}-${process.pid}-${crypto.randomUUID()}`,
	);
	const root = path.join(evidence, "isolated");
	await fs.mkdir(root, { recursive: true });
	const config = await fixture(root);
	const peers: CorePeer[] = [];
	try {
		const peer = new CorePeer(config.cwdA, config.env);
		peers.push(peer);
		await peer.ready();
		const parent = await create(peer, config.cwdA);
		const other = await create(peer, config.cwdB);
		const parentSub = await subscription(peer, parent, "parent-host", "desktop-continuous");
		await parentSub.next("initial");
		expect(await send(peer, parent, "CORE_PARENT")).toMatchObject({ status: "accepted" });
		const gate = await config.gate("CORE_CHILD");
		const child = await childFromParent(peer, parent);
		expect(child).not.toBe(parent);
		expect(await fs.readFile(path.join(config.cwdA, "child-proof.txt"), "utf8")).toBe("CORE_CHILD_PROOF");
		const count = config.requests.length;
		const desktop = await subscription(peer, child, "desktop-child", "desktop-continuous");
		let remote = await subscription(peer, child, "remote-child", "web-remote-replayable");
		expect(desktop.subscriptionId).not.toBe(remote.subscriptionId);
		const desktopInitial = await desktop.next("initial");
		const remoteInitial = await remote.next("initial");
		expect(desktopInitial.payload.kind).toBe("snapshot");
		expect(remoteInitial.payload).toEqual(desktopInitial.payload);
		expect(remoteInitial.toSeq).toBe(desktopInitial.toSeq);
		expect(config.requests).toHaveLength(count);
		await peer.request("session/read", { sessionId: child });
		await peer.request("session/subagents", { sessionId: child });
		await peer.request("v4/conversation/rowsRange", { sessionId: child, limit: 100 });
		expect(config.requests).toHaveLength(count);

		// Lose only the remote cursor; recovery must not mutate execution or desktop identity.
		const recovered = await peer.request("v4/conversation/resync", {
			topic: remote.topic,
			connectionId: remote.connectionId,
			subscriptionId: remote.subscriptionId,
			base: { logEpoch: "lost-remote-epoch", seq: remoteInitial.toSeq + 1000 },
			forceSnapshot: true,
		});
		expect(recovered).toMatchObject({ ack: { subscriptionId: remote.subscriptionId, mode: "snapshot" } });
		const remoteRecovery = await remote.next("recovery");
		expect(remoteRecovery.payload.kind).toBe("snapshot");
		expect(remoteRecovery.toSeq).toBeGreaterThanOrEqual(remoteInitial.toSeq);
		expect(config.requests).toHaveLength(count);
		const oldChildSubscription = remote.subscriptionId;
		await peer.request("v4/conversation/unsubscribe", {
			topic: remote.topic,
			connectionId: remote.connectionId,
			subscriptionId: remote.subscriptionId,
		});
		remote = await subscription(peer, child, "remote-child", "web-remote-replayable");
		expect(remote.subscriptionId).not.toBe(oldChildSubscription);
		const remoteReattached = await remote.next("initial");
		expect(remoteReattached.payload.kind).toBe("snapshot");
		expect(remoteReattached.toSeq).toBe(remoteRecovery.toSeq);
		expect(config.requests).toHaveLength(count);
		const otherSub = await subscription(peer, other, "other-host", "desktop-continuous");
		const otherInitial = await otherSub.next("initial");
		expect(await send(peer, other, "CORE_OTHER")).toMatchObject({ status: "accepted" });
		const otherDone = await markerFrame(otherSub, "CORE_OTHER_DONE", otherInitial.toSeq);
		expect(await fs.readFile(path.join(config.cwdB, "other-proof.txt"), "utf8")).toBe("CORE_OTHER_PROOF");
		expect(await Bun.file(path.join(config.cwdB, "child-proof.txt")).exists()).toBe(false);
		expect(await Bun.file(path.join(config.cwdA, "other-proof.txt")).exists()).toBe(false);
		gate.finish();
		await Promise.all([
			markerFrame(desktop, "CORE_CHILD_DONE", desktopInitial.toSeq),
			markerFrame(remote, "CORE_CHILD_DONE", remoteReattached.toSeq),
		]);
		const childRows = v4ConversationRowsRangeResultSchema.parse(
			await peer.request("v4/conversation/rowsRange", { sessionId: child, limit: 100 }),
		);
		expect(JSON.stringify(childRows)).toContain("CORE_CHILD_DONE");
		expect(JSON.stringify(childRows)).not.toContain("CORE_OTHER_DONE");
		const otherRows = await peer.request("v4/conversation/rowsRange", { sessionId: other, limit: 100 });
		expect(JSON.stringify(otherRows)).not.toContain("CORE_CHILD_DONE");
		const childToolCalls = config.requests.filter(
			request =>
				request.tools?.length &&
				request.messages.some(
					message => message.role === "user" && JSON.stringify(message.content).includes("CORE_CHILD:"),
				),
		);
		expect(childToolCalls).toHaveLength(2);
		// The saved-workflow DSL creates a real native actor, not a task-shaped fake run.
		const workflowDirectory = path.join(config.cwdA, ".zcode", "workflows");
		await fs.mkdir(workflowDirectory, { recursive: true });
		await fs.writeFile(
			path.join(workflowDirectory, "core-transport.dwf.ts"),
			'/* zcode-workflow\ndescription: Controlled native transport actor\n*/\nreturn await agent("transport-actor").ask("CORE_WORKFLOW");\n',
		);
		const workflowSession = await create(peer, config.cwdA);
		const launch = await peer.request("v4/command", {
			commandId: crypto.randomUUID(),
			clientId: "core-workflow-host",
			sessionId: workflowSession,
			type: "startSavedWorkflow",
			payload: { name: "core-transport", args: {} },
			issuedAt: Date.now(),
		});
		if (!isRecord(launch) || !isRecord(launch.result) || typeof launch.result.runId !== "string") {
			throw new Error(`Missing real workflow launch identity: ${JSON.stringify(launch)}`);
		}
		const workflowRunId = launch.result.runId;
		expect(launch.status).toBe("accepted");
		const workflowGate = await config.gate("CORE_WORKFLOW");
		const workflowRequestCount = config.requests.length;
		const wfDesktop = await subscription(peer, workflowSession, "wf-desktop", "desktop-continuous");
		let wfRemote = await subscription(peer, workflowSession, "wf-remote", "web-remote-replayable");
		const wfDesktopSnapshot = await wfDesktop.next("initial");
		const wfRemoteSnapshot = await wfRemote.next("initial");
		if (wfDesktopSnapshot.payload.kind !== "snapshot" || wfRemoteSnapshot.payload.kind !== "snapshot")
			throw new Error("Workflow routes did not receive snapshots");
		const workflowRun = wfDesktopSnapshot.payload.snapshot.workflowRuns?.runs.find(
			run => run.runId === workflowRunId,
		);
		expect(workflowRun?.status).toBe("running");
		expect(workflowRun?.actors).toHaveLength(1);
		const workflowActorId = workflowRun?.actors[0]?.sessionId;
		expect(typeof workflowActorId).toBe("string");
		expect(
			wfRemoteSnapshot.payload.snapshot.workflowRuns?.runs.find(run => run.runId === workflowRunId)?.actors,
		).toEqual(workflowRun?.actors);
		expect(wfRemoteSnapshot.toSeq).toBe(wfDesktopSnapshot.toSeq);
		const wfResync = await peer.request("v4/conversation/resync", {
			topic: wfRemote.topic,
			connectionId: wfRemote.connectionId,
			subscriptionId: wfRemote.subscriptionId,
			base: { logEpoch: "lost-workflow-epoch", seq: wfRemoteSnapshot.toSeq + 1000 },
			forceSnapshot: true,
		});
		expect(wfResync).toMatchObject({ ack: { subscriptionId: wfRemote.subscriptionId, mode: "snapshot" } });
		const wfRecovery = await wfRemote.next("recovery");
		expect(wfRecovery.payload.kind).toBe("snapshot");
		expect(wfRecovery.fromSeq).toBe(0);
		expect(wfRecovery.toSeq).toBeGreaterThanOrEqual(wfRemoteSnapshot.toSeq);
		if (wfRecovery.payload.kind !== "snapshot") throw new Error("Workflow gap recovery missed snapshot");
		expect(wfRecovery.payload.snapshot.workflowRuns?.runs.find(run => run.runId === workflowRunId)?.actors).toEqual(
			workflowRun?.actors,
		);
		const oldWorkflowSubscription = wfRemote.subscriptionId;
		await peer.request("v4/conversation/unsubscribe", {
			topic: wfRemote.topic,
			connectionId: wfRemote.connectionId,
			subscriptionId: wfRemote.subscriptionId,
		});
		wfRemote = await subscription(peer, workflowSession, "wf-remote", "web-remote-replayable");
		expect(wfRemote.subscriptionId).not.toBe(oldWorkflowSubscription);
		const wfReattached = await wfRemote.next("initial");
		if (wfReattached.payload.kind !== "snapshot") throw new Error("Workflow reattach missed snapshot");
		const reattachedRun = wfReattached.payload.snapshot.workflowRuns?.runs.find(run => run.runId === workflowRunId);
		expect(reattachedRun?.actors).toEqual(workflowRun?.actors);
		expect(config.requests).toHaveLength(workflowRequestCount);
		const runsBeforeEof = LegacyProtocol.zcodeWorkflowsRunsResultSchema.parse(
			await peer.request("workflows/runs", {
				workspace: { workspacePath: config.cwdA, workspaceKey: config.cwdA },
				name: "core-transport",
				limit: 10,
			}),
		);
		expect(runsBeforeEof.runs.filter(run => run.runId === workflowRunId)).toHaveLength(1);
		expect(
			config.requests.filter(
				request =>
					request.tools?.length &&
					request.messages.some(
						message => message.role === "user" && JSON.stringify(message.content).includes("CORE_WORKFLOW"),
					),
			),
		).toHaveLength(1);
		expect(
			JSON.stringify(await peer.request("v4/conversation/rowsRange", { sessionId: other, limit: 100 })),
		).not.toContain(workflowRunId);
		expect(await send(peer, other, "CORE_OTHER_LIVE")).toMatchObject({ status: "accepted" });
		await markerFrame(otherSub, "CORE_OTHER_LIVE_DONE", otherDone.toSeq);

		// EOF while a distinct native child owns an open Provider stream must cancel it.
		expect(await send(peer, parent, "CORE_OWNER")).toMatchObject({ status: "accepted" });
		const ownedGate = await config.gate("CORE_CHILD_OWNER");
		expect(await peer.eof()).toBe(0);
		await bounded(ownedGate.cancelled, "EOF aborts owned child Provider connection");
		await bounded(workflowGate.cancelled, "EOF aborts native workflow actor Provider connection");
		const beforeCold = config.requests.length;
		const cold = new CorePeer(config.cwdA, config.env);
		peers.push(cold);
		await cold.ready();
		await cold.request("session/read", { sessionId: child });
		await cold.request("session/subagents", { sessionId: child });
		const coldRows = await cold.request("v4/conversation/rowsRange", { sessionId: child, limit: 100 });
		expect(JSON.stringify(coldRows)).toContain("CORE_CHILD_DONE");
		const coldRemote = await subscription(cold, child, "cold-remote", "web-remote-replayable");
		const coldSnapshot = await coldRemote.next("initial");
		expect(coldSnapshot.payload.kind).toBe("snapshot");
		expect(JSON.stringify(coldSnapshot.payload)).toContain("CORE_CHILD_DONE");
		const ownerState = LegacyProtocol.zcodeSessionSubagentsResultSchema.parse(
			await cold.request("session/subagents", { sessionId: parent }),
		);
		expect(ownerState.running).toEqual([]);
		expect(ownerState.ended.items.some(item => item.status === "cancelled" || item.status === "lost")).toBe(true);
		const coldWorkflowRuns = LegacyProtocol.zcodeWorkflowsRunsResultSchema.parse(
			await cold.request("workflows/runs", {
				workspace: { workspacePath: config.cwdA, workspaceKey: config.cwdA },
				name: "core-transport",
				limit: 10,
			}),
		);
		expect(coldWorkflowRuns.runs.filter(run => run.runId === workflowRunId)).toHaveLength(1);
		expect(coldWorkflowRuns.runs.find(run => run.runId === workflowRunId)?.status).toBe("stopped");
		expect(config.requests).toHaveLength(beforeCold);
		expect(await cold.eof()).toBe(0);
	} finally {
		for (const peer of peers) await peer.close();
		config.server.stop(true);
		await fs.writeFile(path.join(evidence, "local-model-requests.json"), JSON.stringify(config.http, null, 2));
		for (const [index, peer] of peers.entries()) {
			await fs.writeFile(
				path.join(evidence, `peer-${index}-stdout.jsonl`),
				peer.frames.map(frame => JSON.stringify(frame)).join("\n"),
			);
			await fs.writeFile(
				path.join(evidence, `peer-${index}-stdin.jsonl`),
				peer.requests.map(frame => JSON.stringify(frame)).join("\n"),
			);
			await fs.writeFile(path.join(evidence, `peer-${index}-stderr.txt`), await peer.stderr);
		}
		console.info(`OMP-SA06/transport evidence: ${evidence}`);
	}
}, 180_000);
