import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import {
	LegacyProtocol,
	subscribeAckSchema,
	TopicWireFrameAssembler,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
} from "../../src/modes/zcode/schema";
import { AsyncJobManager } from "../../src/async/job-manager";
import { OmpTanBridge } from "../../src/modes/zcode/tan";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "../../src/modes/zcode/sessions";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../../src/session/messages";
import type { SessionEntry } from "../../src/session/session-entries";

type Frame = Record<string, unknown>;
type Request = {
	model: string;
	messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
	tools?: Array<{ function: { name: string } }>;
};
type Job = {
	jobId: string;
	agentId?: string;
	childSessionId?: string;
	sessionId: string;
	status: string;
	output?: string;
	error?: string;
};
const model = { providerId: "tan-local", modelId: "tan-chat" };
function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.flatMap(part =>
					isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
				)
				.join("")
		: "";
}
function assignmentMarker(content: unknown) {
	const texts =
		typeof content === "string"
			? [content]
			: Array.isArray(content)
				? content.flatMap(part =>
						isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
					)
				: [];
	// DateCwdReminderInjector 给首 user 加独立 text block 或这个固定模板前缀；保留其他告知的边界。
	return texts
		.map(text => text.replace(/^<system-reminder>\r?\nToday: [^\r\n]*\r?\n<\/system-reminder>\r?\n\r?\n/u, ""))
		.find(text => /^TAN_(?:CHECKPOINT|PARENT_BUSY|CHILD_[A-Z0-9_]+)$/u.test(text));
}
function assignmentIndex(request: Request) {
	// native 派发告知和 todo 提醒也可能成为 user 消息；只能匹配真实独立输入，不能按包含 marker 的告知重派。
	return request.messages.findLastIndex(
		message => message.role === "user" && assignmentMarker(message.content) !== undefined,
	);
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
	const gate = Promise.withResolvers<never>();
	const timer = setTimeout(() => gate.reject(new Error("Tan acceptance timed out")), 30000);
	try {
		return await Promise.race([promise, gate.promise]);
	} finally {
		clearTimeout(timer);
	}
}
class Peer {
	readonly child!: Subprocess<"pipe", "pipe", "pipe">;
	readonly stderr: Promise<string>;
	step = "startup";
	readonly snapshots = new Map<string, unknown>();
	readonly jobSnapshots = new Map<string, unknown>();
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
			{ cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		this.stderr = new Response(this.child.stderr).text();
		this.#pump = (async () => {
			try {
				for await (const value of readJsonl<unknown>(this.child.stdout)) {
					if (!isRecord(value)) throw new Error("Invalid native frame");
					if (typeof value.method === "string" && value.id !== undefined) {
						const result =
							value.method === "session/requestRuntimePreferences"
								? { nativeSearchEnhancementsEnabled: false, memoryEnabled: false }
								: value.method === "subagents/readRuntimeConfig"
									? {
											kind: "ready",
											profiles: [],
											builtInModelSelectionOverrides: {},
											pluginAgentModelSelectionOverrides: {},
										}
									: undefined;
						this.child.stdin.write(
							`${JSON.stringify(result === undefined ? { id: value.id, error: { code: -32601, message: "No fixture handler" } } : { id: value.id, result })}\n`,
						);
					}
					this.#queue.push(value);
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
					if (this.#ended) throw new Error(`Native CLI exited: ${await this.stderr}`);
					await this.#changed.promise;
				}
			})(),
		);
	}
	async request(method: string, params: unknown): Promise<unknown> {
		const id = `tan-${++this.#id}`;
		this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		const frame = await this.next(value => value.id === id);
		if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
		if (isRecord(params) && typeof params.sessionId === "string") {
			if (method === "session/read") this.snapshots.set(params.sessionId, frame.result);
			if (method === "omp/tan/list") this.jobSnapshots.set(params.sessionId, frame.result);
		}
		if (
			method === "session/create" &&
			isRecord(frame.result) &&
			isRecord(frame.result.session) &&
			typeof frame.result.session.sessionId === "string"
		) {
			this.snapshots.set(frame.result.session.sessionId, frame.result);
		}
		return frame.result;
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
	const bashRelease = root.join("release-background");
	const bashProof = `TAN_NATIVE_BASH_${crypto.randomUUID()}`;
	const bashScript = root.join("background-proof.cjs");
	await fs.writeFile(
		bashScript,
		`const fs = require("node:fs");\nprocess.stdout.write(${JSON.stringify(`${bashProof}\n`)});\nconst timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(bashRelease)})) { clearInterval(timer); process.stdout.write("TAN_BASH_RELEASED\\n"); } }, 20);\n`,
	);
	const bashCommand = [process.execPath, bashScript].map(value => `"${value.replaceAll("\\", "/")}"`).join(" ");
	const compaction = { held: false, started: false, aborted: false };
	const requests: Request[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();
	const started = new Set<string>();
	const aborted = new Set<string>();
	const gate = (marker: string) => {
		let value = gates.get(marker);
		if (!value) {
			value = Promise.withResolvers<void>();
			gates.set(marker, value);
		}
		return value;
	};
	const responses: Array<{ requestIndex: number; marker: string; status: number; delta?: unknown }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions")
				return new Response("Unexpected endpoint", { status: 500 });
			const body = (await request.json()) as Request;
			requests.push(body);
			const requestIndex = requests.length - 1;
			const userIndex = assignmentIndex(body);
			const marker = assignmentMarker(body.messages[userIndex]?.content) ?? "TAN_AUX";
			const active = Boolean(body.tools?.length);
			if (!active && compaction.held) {
				compaction.started = true;
				request.signal.addEventListener(
					"abort",
					() => {
						compaction.aborted = true;
					},
					{ once: true },
				);
				await gate("compaction").promise;
			}
			if (active) started.add(marker);
			if (active && marker === "TAN_CHILD_FAIL") {
				responses.push({ requestIndex, marker, status: 400 });
				return Response.json({ error: { message: "TAN_EXPECTED_FAILURE" } }, { status: 400 });
			}
			request.signal.addEventListener(
				"abort",
				() => {
					aborted.add(marker);
					gate(marker).resolve();
				},
				{ once: true },
			);
			const toolResults = body.messages.slice(userIndex + 1).filter(message => message.role === "tool");
			const finished = marker === "TAN_CHECKPOINT" ? toolResults.length > 0 : toolResults.length > 1;
			if (
				active &&
				(marker === "TAN_PARENT_BUSY" ||
					marker.includes("HOLD") ||
					marker.includes("STOP") ||
					marker.includes("EOF"))
			)
				await gate(marker).promise;
			const viewTodo = active && marker.startsWith("TAN_CHILD_") && toolResults.length === 0;
			const initTodo = active && marker === "TAN_CHECKPOINT" && !finished;
			const tool = active && ((marker.startsWith("TAN_CHILD_") && !finished) || initTodo);
			const backgroundBash = marker === "TAN_CHILD_BACKGROUND" && !viewTodo;
			const expectedName = viewTodo || initTodo ? "todo" : backgroundBash ? "bash" : "write";
			const name = body.tools?.find(
				value => value.function.name === expectedName || value.function.name === `_${expectedName}`,
			)?.function.name;
			if (tool && !name) throw new Error(`Native ${expectedName} tool must be advertised`);
			const args = initTodo
				? { op: "init", items: ["PARENT_ONLY_PENDING_TODO"] }
				: viewTodo
					? { op: "view" }
					: backgroundBash
						? { command: bashCommand, async: true, timeout: 30 }
						: { i: "Writing native Tan proof", path: `${marker}.txt`, content: marker };
			const id = `tan-call-${requests.length}`;
			const delta = tool
				? {
						role: "assistant",
						tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
					}
				: {
						role: "assistant",
						content: marker === "TAN_CHECKPOINT" ? "TAN_CHECKPOINT cedar-731" : `${marker}_DONE`,
					};
			responses.push({ requestIndex, marker, status: 200, delta });
			const chunk = (value: unknown, finish: string | null) =>
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
			return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  tan-local:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: tan-chat\n        reasoning: false\n      - id: tan-other\n        reasoning: false\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: tan-local/tan-chat\n  smol: tan-local/tan-chat\nasync:\n  enabled: true\ncompaction:\n  enabled: false\n  keepRecentTokens: 1\n  experimentalContextManagement: false\ntools:\n  xdev: false\n  approval:\n    write: allow\n    bash: allow\n",
	);
	const profileDir = path.join(configRoot, "profiles", "beta", "agent");
	await fs.mkdir(profileDir, { recursive: true });
	for (const name of ["models.yml", "config.yml"])
		await fs.copyFile(path.join(agentDir, name), path.join(profileDir, name));
	return {
		cwd,
		profileDir,
		requests,
		responses,
		started,
		aborted,
		bashProof,
		releaseBash: () => fs.writeFile(bashRelease, ""),
		compaction,
		release: (marker: string) => gate(marker).resolve(),
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
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_OFFLINE: "0",
			PI_NO_TITLE: "1",
			NO_PROXY: "127.0.0.1,localhost",
		},
		async [Symbol.asyncDispose]() {
			for (const value of gates.values()) value.resolve();
			await server.stop(true);
		},
	};
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
	return bounded(
		(async () => {
			for (;;) {
				const value = await read();
				if (accept(value)) return value;
				await Bun.sleep(20);
			}
		})(),
	);
}
async function create(peer: Peer, cwd: string) {
	return LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
		await peer.request("session/create", {
			workspace: { workspacePath: cwd, workspaceKey: cwd },
			model,
			titleGenerationEnabled: false,
		}),
	).session.sessionId;
}
async function state(peer: Peer, sessionId: string) {
	return LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(await peer.request("session/read", { sessionId }));
}
async function prompt(peer: Peer, sessionId: string, text: string, options: Record<string, unknown> = {}) {
	return peer.request("v4/command", {
		commandId: crypto.randomUUID(),
		clientId: "tan-host",
		sessionId,
		type: "sendText",
		payload: { text, ...options },
		issuedAt: Date.now(),
	});
}
function ref(cwd: string, sessionId: string) {
	return { workspace: { workspacePath: cwd, workspaceKey: cwd }, sessionId };
}
async function start(peer: Peer, cwd: string, sessionId: string, work: string): Promise<Job> {
	return ((await peer.request("omp/tan/start", { ...ref(cwd, sessionId), work })) as { job: Job }).job;
}
async function jobs(peer: Peer, cwd: string, sessionId: string): Promise<Job[]> {
	return ((await peer.request("omp/tan/list", ref(cwd, sessionId))) as { jobs: Job[] }).jobs;
}
async function settled(peer: Peer, cwd: string, sessionId: string, jobId: string) {
	return (
		await until(
			() => jobs(peer, cwd, sessionId),
			values =>
				values.some(value => value.jobId === jobId && ["completed", "cancelled", "failed"].includes(value.status)),
		)
	).find(value => value.jobId === jobId)!;
}
async function recover(peer: Peer, sessionId: string, clientMode: "desktop-continuous" | "web-remote-replayable") {
	const topic = `conversation/${sessionId}`;
	const connectionId = crypto.randomUUID();
	const reply = await peer.request("v4/conversation/subscribe", { topic, connectionId, clientMode });
	if (!isRecord(reply)) throw new Error("Missing subscription");
	const initialAck = subscribeAckSchema.parse(reply.ack);
	const readSnapshot = async (
		ack: { subscriptionId: string; logEpoch: string },
		deliveryKind: "initial" | "recovery",
	) => {
		const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
		for (;;) {
			const frame = await peer.next(
				value =>
					value.method === "v4/conversation/frame" &&
					isRecord(value.params) &&
					value.params.topic === topic &&
					value.params.subscriptionId === ack.subscriptionId &&
					value.params.deliveryKind === deliveryKind,
			);
			for (const event of assembler.accept(conversationTopicWireCandidateSchema.parse(frame.params))) {
				if (event.kind === "fault") throw new Error(event.fault.reasonCode);
				if (event.frame.payload.kind === "snapshot") {
					expect(event.frame.payload.snapshot.logEpoch).toBe(ack.logEpoch);
					return event.frame.payload.snapshot;
				}
			}
		}
	};
	// Topics.subscribe 使用 initial，resync 使用 recovery；分别消费并核对对应 ACK，不等待不存在的帧。
	const initial = await readSnapshot(initialAck, "initial");
	const resync = await peer.request("v4/conversation/resync", {
		topic,
		connectionId,
		subscriptionId: initialAck.subscriptionId,
		base: null,
		forceSnapshot: true,
	});
	if (!isRecord(resync)) throw new Error("Missing resync ACK");
	const ack = subscribeAckSchema.parse(resync.ack);
	expect(ack.subscriptionId).toBe(initialAck.subscriptionId);
	const restored = await readSnapshot(ack, "recovery");
	if (restored.logEpoch === initial.logEpoch) expect(restored.seq).toBeGreaterThanOrEqual(initial.seq);
	await peer.request("v4/conversation/unsubscribe", { topic, connectionId, subscriptionId: ack.subscriptionId });
	return restored;
}

function diagnose(
	fixture: {
		requests: Request[];
		responses: Array<{ requestIndex: number; marker: string; status: number; delta?: unknown }>;
		started: Set<string>;
		aborted: Set<string>;
	},
	peer: Peer,
	error: unknown,
) {
	// 全部内容来自本测试隔离模型；只输出消息正文，不输出认证头、环境或开发者配置。
	console.error(
		"TAN_ACCEPTANCE_DIAGNOSTICS",
		JSON.stringify({
			step: peer.step,
			error: error instanceof Error ? error.stack : String(error),
			started: [...fixture.started],
			aborted: [...fixture.aborted],
			parentSnapshots: Object.fromEntries(peer.snapshots),
			jobs: Object.fromEntries(peer.jobSnapshots),
			responses: fixture.responses,
			requests: fixture.requests.map((request, index) => ({
				index,
				model: request.model,
				hasTools: Boolean(request.tools?.length),
				assignmentIndex: assignmentIndex(request),
				messages: request.messages.map(message => ({
					role: message.role,
					content: message.content,
					text: textContent(message.content),
					tool_calls: message.tool_calls,
					tool_call_id: message.tool_call_id,
				})),
			})),
		}),
	);
}

test("real Tan controller keeps busy parent, native owner isolation, tools, parked history and delivery recovery", async () => {
	await using root = await TempDir.create("@zcode-tan-");
	await using f = await fixture(root);
	await using peer = new Peer(f.cwd, f.env);
	await peer.ready();
	await using profilePeer = new Peer(f.cwd, {
		...f.env,
		OMP_PROFILE: "beta",
		PI_PROFILE: "beta",
		PI_CODING_AGENT_DIR: f.profileDir,
	});
	await profilePeer.ready();
	try {
		peer.step = "create profile and parent sessions";
		const profileParent = await create(profilePeer, f.cwd);
		const profileJob = await start(profilePeer, f.cwd, profileParent, "TAN_CHILD_PROFILE");
		const parent = await create(peer, f.cwd);
		const other = await create(peer, f.cwd);
		peer.step = "checkpoint and busy parent";
		await prompt(peer, parent, "TAN_CHECKPOINT");
		await until(
			() => state(peer, parent),
			value => value.projection.status === "idle" && JSON.stringify(value).includes("cedar-731"),
		);
		await prompt(peer, parent, "TAN_PARENT_BUSY");
		await until(async () => f.started.has("TAN_PARENT_BUSY"), Boolean);
		peer.step = "start parallel Tan jobs";
		const first = await start(peer, f.cwd, parent, "TAN_CHILD_HOLD_A");
		const second = await start(peer, f.cwd, parent, "TAN_CHILD_HOLD_B");
		const unrelated = await start(peer, f.cwd, other, "TAN_CHILD_OTHER");
		expect(first.jobId).not.toBe(second.jobId);
		expect(first.agentId).not.toBe(second.agentId);
		expect((await state(peer, parent)).projection.status).not.toBe("idle");
		peer.step = "wait for child model requests";
		await until(async () => f.started.has("TAN_CHILD_HOLD_A") && f.started.has("TAN_CHILD_HOLD_B"), Boolean);
		const childRequest = f.requests.find(
			value =>
				value.tools?.length &&
				assignmentMarker(value.messages[assignmentIndex(value)]?.content) === "TAN_CHILD_HOLD_A",
		)!;
		expect(JSON.stringify(childRequest.messages)).toContain("cedar-731");
		// 中断父轮次不能把父未配对工具调用作为子执行继续；每个工具结果必须有自己的调用。
		const callIds = new Set(childRequest.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
		for (const message of childRequest.messages)
			if (message.role === "tool") expect(callIds.has(message.tool_call_id!)).toBe(true);
		for (const id of callIds)
			expect(childRequest.messages.some(message => message.role === "tool" && message.tool_call_id === id)).toBe(
				true,
			);
		peer.step = "open held Tan history with stable native identity";
		const heldJobs = await jobs(peer, f.cwd, parent);
		const heldChildren = new Map<string, string>();
		for (const job of [first, second]) {
			const held = heldJobs.find(value => value.jobId === job.jobId);
			expect(held?.status).toBe("running");
			expect(held?.childSessionId).toBeTruthy();
			heldChildren.set(job.jobId, held!.childSessionId!);
			const history = await state(peer, held!.childSessionId!);
			expect(history.session.sessionId).toBe(held!.childSessionId!);
			expect(JSON.stringify(history)).toContain("cedar-731");
		}
		for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
			const restored = await recover(peer, parent, mode);
			for (const childId of heldChildren.values()) expect(restored.subagents?.childSessionIds).toContain(childId);
		}
		f.release("TAN_PARENT_BUSY");
		peer.step = "release parent and observe parent completion";
		await until(
			() => state(peer, parent),
			value => JSON.stringify(value).includes("TAN_PARENT_BUSY_DONE"),
		);
		expect((await jobs(peer, f.cwd, parent)).filter(value => value.status === "running").length).toBeGreaterThan(0);
		f.release("TAN_CHILD_HOLD_A");
		f.release("TAN_CHILD_HOLD_B");
		peer.step = "release children and observe completion/history";
		for (const job of [first, second]) {
			const result = await settled(peer, f.cwd, parent, job.jobId);
			expect(result.status).toBe("completed");
			expect(result.output).toContain("_DONE");
			expect(result.childSessionId).toBe(heldChildren.get(job.jobId));
			const history = await state(peer, result.childSessionId!);
			expect(JSON.stringify(history)).toContain("_DONE");
		}
		expect((await settled(peer, f.cwd, other, unrelated.jobId)).status).toBe("completed");
		expect((await settled(profilePeer, f.cwd, profileParent, profileJob.jobId)).status).toBe("completed");
		const parentJobs = await jobs(peer, f.cwd, parent);
		expect(parentJobs).toHaveLength(2);
		expect(parentJobs.every(value => value.sessionId === parent)).toBe(true);
		expect(JSON.stringify(parentJobs)).not.toContain("TAN_CHILD_PROFILE");
		expect(JSON.stringify(await state(profilePeer, profileParent))).not.toContain("TAN_CHILD_HOLD_A_DONE");
		expect(await fs.readFile(path.join(f.cwd, "TAN_CHILD_HOLD_A.txt"), "utf8")).toBe("TAN_CHILD_HOLD_A");
		const afterTodo = f.requests.find(value => {
			const index = assignmentIndex(value);
			return (
				assignmentMarker(value.messages[index]?.content) === "TAN_CHILD_HOLD_A" &&
				value.messages.slice(index + 1).some(message => message.role === "tool")
			);
		});
		expect(afterTodo).toBeDefined();
		const childUser = assignmentIndex(afterTodo!);
		expect(
			JSON.stringify(afterTodo!.messages.slice(childUser + 1).find(message => message.role === "tool")?.content),
		).not.toContain("PARENT_ONLY_PENDING_TODO");
		await until(
			() => state(peer, parent),
			value => JSON.stringify(value).includes("TAN_CHILD_HOLD_A_DONE"),
		);
		const otherState = JSON.stringify(await state(peer, other));
		expect(otherState).not.toContain("TAN_CHILD_HOLD_A_DONE");
		expect(JSON.stringify(await state(peer, parent))).not.toContain("TAN_CHILD_OTHER_DONE");
		await until(
			() => state(peer, parent),
			value => value.projection.status === "idle",
		);
		await until(
			() => state(peer, other),
			value => value.projection.status === "idle",
		);
		const before = f.requests.filter(value => value.tools?.length).length;
		peer.step = "delivery recovery without redispatch";
		// 原生结果通知是隐藏 custom message；恢复 UI 由 parent child 索引、Tan 卡查询及只读子历史共同恢复，不要求内联通知文本。
		for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
			const restored = await recover(peer, parent, mode);
			const hydrated = await jobs(peer, f.cwd, parent);
			for (const expected of [
				{ jobId: first.jobId, output: "TAN_CHILD_HOLD_A_DONE" },
				{ jobId: second.jobId, output: "TAN_CHILD_HOLD_B_DONE" },
			]) {
				const job = hydrated.find(value => value.jobId === expected.jobId);
				expect(job).toMatchObject({ sessionId: parent, status: "completed", output: expected.output });
				expect(job?.childSessionId).toBeTruthy();
				expect(restored.subagents?.childSessionIds).toContain(job!.childSessionId!);
				const history = await recover(peer, job!.childSessionId!, mode);
				expect(history.rows.window.some(row => row.kind === "assistantText" && row.text === expected.output)).toBe(
					true,
				);
			}
		}
		expect(f.requests.filter(value => value.tools?.length).length).toBe(before);
	} catch (error) {
		diagnose(f, peer, error);
		throw error;
	}
}, 120000);

test("real Tan stop is job scoped, failures remain failed and owner EOF aborts native work", async () => {
	await using root = await TempDir.create("@zcode-tan-stop-");
	await using f = await fixture(root);
	await using peer = new Peer(f.cwd, f.env);
	await peer.ready();
	try {
		peer.step = "create stop owners";
		const parent = await create(peer, f.cwd);
		const other = await create(peer, f.cwd);
		// 原生 jobId 只在 owner 内唯一；先占父 bg_1，避免把另一 owner 合法的 bg_1 误判成越权。
		const seed = await start(peer, f.cwd, parent, "TAN_CHILD_SEED");
		peer.step = "wait for seed native job";
		const seeded = await settled(peer, f.cwd, parent, seed.jobId);
		expect(seeded.status).toBe("completed");
		expect(seeded.childSessionId).toBeTruthy();
		expect((await state(peer, seeded.childSessionId!)).session.sessionId).toBe(seeded.childSessionId!);
		const stop = await start(peer, f.cwd, parent, "TAN_CHILD_STOP");
		const keep = await start(peer, f.cwd, other, "TAN_CHILD_HOLD_KEEP");
		peer.step = "wait for stop and keep model requests";
		expect(stop.jobId).not.toBe(keep.jobId);
		await until(async () => f.started.has("TAN_CHILD_STOP") && f.started.has("TAN_CHILD_HOLD_KEEP"), Boolean);
		const stoppingChildId = (await jobs(peer, f.cwd, parent)).find(
			value => value.jobId === stop.jobId,
		)?.childSessionId;
		expect(stoppingChildId).toBeTruthy();
		expect(
			await peer.request("omp/profiles/prepareSwitch", {
				workspace: ref(f.cwd, parent).workspace,
				expectedProfile: null,
			}),
		).toMatchObject({ ready: false });
		peer.step = "wrong owner rejection and selected cancellation";
		await expect(peer.request("omp/tan/stop", { ...ref(f.cwd, other), jobId: stop.jobId })).rejects.toThrow();
		expect(await peer.request("omp/tan/stop", { ...ref(f.cwd, parent), jobId: stop.jobId })).toMatchObject({
			accepted: true,
		});
		const stopped = await settled(peer, f.cwd, parent, stop.jobId);
		expect(stopped).toMatchObject({ status: "cancelled", childSessionId: stoppingChildId });
		expect((await state(peer, stoppingChildId!)).session.sessionId).toBe(stoppingChildId!);
		expect((await jobs(peer, f.cwd, other)).find(value => value.jobId === keep.jobId)?.status).toBe("running");
		f.release("TAN_CHILD_HOLD_KEEP");
		expect((await settled(peer, f.cwd, other, keep.jobId)).status).toBe("completed");
		peer.step = "wait for native model failure";
		const fail = await start(peer, f.cwd, parent, "TAN_CHILD_FAIL");
		const failed = await settled(peer, f.cwd, parent, fail.jobId);
		expect(failed.status).toBe("failed");
		expect(failed.error).toBeTruthy();
		peer.step = "owner EOF abort";
		await start(peer, f.cwd, parent, "TAN_CHILD_EOF");
		await until(async () => f.started.has("TAN_CHILD_EOF"), Boolean);
		expect(await peer.eof()).toBe(0);
		await until(async () => f.aborted.has("TAN_CHILD_EOF"), Boolean);
		expect(await Bun.file(path.join(f.cwd, "TAN_CHILD_EOF.txt")).exists()).toBe(false);
	} catch (error) {
		diagnose(f, peer, error);
		throw error;
	}
}, 120000);

test("Tan journal UUID reads live child Bash output and parked native history without crossing roots", async () => {
	await using root = await TempDir.create("@zcode-tan-output-");
	await using f = await fixture(root);
	await using peer = new Peer(f.cwd, f.env);
	await peer.ready();
	try {
		const parent = await create(peer, f.cwd);
		const other = await create(peer, f.cwd);
		const launched = await start(peer, f.cwd, parent, "TAN_CHILD_BACKGROUND");
		const live = await until(
			() => jobs(peer, f.cwd, parent),
			values => Boolean(values.find(job => job.jobId === launched.jobId)?.childSessionId),
		);
		const childId = live.find(job => job.jobId === launched.jobId)!.childSessionId!;
		// 真实工具 receipt 的 workId 与公开 journal UUID 联用；不能用 provider ID 或查询替身绕过 live 分支。
		const snapshot = await until(
			() => recover(peer, childId, "desktop-continuous"),
			value => value.rows.window.some(row => row.kind === "toolCall" && row.backgrounded && row.workId),
		);
		const row = snapshot.rows.window.find(row => row.kind === "toolCall" && row.backgrounded && row.workId);
		if (!row || row.kind !== "toolCall" || !row.workId) throw new Error("Missing native Bash work identity");
		const params = { sessionId: childId, workId: row.workId };
		const output = await until(
			() => peer.request("v4/conversation/backgroundBashOutput", params),
			value => isRecord(value) && value.kind === "output" && String(value.output).includes(f.bashProof),
		);
		expect(output).toMatchObject({ kind: "output", status: "running" });
		expect((await state(peer, childId)).session.sessionId).toBe(childId);
		expect(await peer.request("v4/conversation/backgroundBashOutput", { ...params, sessionId: other })).toMatchObject(
			{
				kind: "unavailable",
			},
		);
		await f.releaseBash();
		const parked = await settled(peer, f.cwd, parent, launched.jobId);
		expect(parked).toMatchObject({ status: "completed", childSessionId: childId });
		expect((await state(peer, childId)).session.sessionId).toBe(childId);
		// 原生 Tan park 会 dispose child 并逐 owner 驱逐已完成 proc；历史不能伪装成仍保留的 job 输出。
		const parkedOutput = await peer.request("v4/conversation/backgroundBashOutput", params);
		expect(parkedOutput).toMatchObject({ kind: "unavailable", workId: row.workId });
		for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
			const history = await recover(peer, childId, mode);
			// 原生历史保留 Bash receipt 和最终回复，不持久化进程 stdout；恢复不得伪造额外输出。
			expect(history.rows.window).toContainEqual(
				expect.objectContaining({
					kind: "toolCall",
					toolName: "Bash",
					backgrounded: true,
					workId: row.workId,
					input: row.input,
					output: row.output,
				}),
			);
			expect(history.rows.window).toContainEqual(
				expect.objectContaining({
					kind: "assistantText",
					text: "TAN_CHILD_BACKGROUND_DONE",
					state: "complete",
				}),
			);
		}
		expect(await peer.request("v4/conversation/backgroundBashOutput", { ...params, sessionId: other })).toMatchObject(
			{
				kind: "unavailable",
			},
		);
	} catch (error) {
		diagnose(f, peer, error);
		throw error;
	} finally {
		await f.releaseBash();
	}
}, 120000);

for (const phase of ["busy", "compacting", "held"] as const) {
	test(`generic colon Tan preserves ${phase} parent and model while dispatching one native child`, async () => {
		await using root = await TempDir.create(`@zcode-tan-colon-${phase}-`);
		await using f = await fixture(root);
		await using peer = new Peer(f.cwd, f.env);
		await peer.ready();
		try {
			const parent = await create(peer, f.cwd);
			const command = (type: string, payload: unknown = {}) =>
				peer.request("v4/command", {
					commandId: crypto.randomUUID(),
					clientId: "tan-host",
					sessionId: parent,
					type,
					payload,
					issuedAt: Date.now(),
				});
			await prompt(peer, parent, "TAN_CHECKPOINT");
			await until(
				() => state(peer, parent),
				value => value.projection.status === "idle",
			);
			const original = await recover(peer, parent, "desktop-continuous");
			let heldQueue: typeof original.queue | undefined;
			if (phase === "compacting") {
				await prompt(peer, parent, "TAN_CHECKPOINT");
				await until(
					() => state(peer, parent),
					value => value.projection.status === "idle",
				);
				f.compaction.held = true;
				await command("compact");
				await until(async () => f.compaction.started, Boolean);
				expect(
					(await recover(peer, parent, "desktop-continuous")).control.activeWorks.some(
						work => work.kind === "compact",
					),
				).toBe(true);
			} else {
				await prompt(peer, parent, "TAN_PARENT_BUSY");
				await until(async () => f.started.has("TAN_PARENT_BUSY"), Boolean);
				if (phase === "held") {
					await prompt(peer, parent, "TAN_QUEUED_NOT_DISPATCHED", { requestedDelivery: "queue" });
					await command("stop");
					const held = await until(
						() => recover(peer, parent, "desktop-continuous"),
						value => value.inputRouting.mode === "choice",
					);
					heldQueue = held.queue;
					expect(heldQueue.items).toHaveLength(1);
				}
			}
			// 冒号是原生命令分隔符；通用入口必须先识别 Tan，不能先抢占父轮次、改模型或要求处置 held queue。
			const reply = await prompt(peer, parent, "/tan:TAN_CHILD_COLON", {
				requestedDelivery: "startNow",
				modelSelection: { providerId: "tan-local", modelId: "tan-other" },
			});
			expect(reply).toMatchObject({ status: "accepted" });
			const dispatched = await until(
				() => jobs(peer, f.cwd, parent),
				values => values.length > 0,
			);
			expect(dispatched).toHaveLength(1);
			const result = await settled(peer, f.cwd, parent, dispatched[0]!.jobId);
			expect(result.status).toBe("completed");
			expect(await fs.readFile(path.join(f.cwd, "TAN_CHILD_COLON.txt"), "utf8")).toBe("TAN_CHILD_COLON");
			const after = await recover(peer, parent, "desktop-continuous");
			expect(after.config.modelSelection).toEqual(original.config.modelSelection);
			expect(f.requests.every(request => request.model === "tan-chat")).toBe(true);
			if (phase === "busy") {
				expect(f.aborted.has("TAN_PARENT_BUSY")).toBe(false);
				expect((await state(peer, parent)).projection.status).not.toBe("idle");
				f.release("TAN_PARENT_BUSY");
				await until(
					() => state(peer, parent),
					value => JSON.stringify(value).includes("TAN_PARENT_BUSY_DONE"),
				);
			} else if (phase === "compacting") {
				expect(f.compaction.aborted).toBe(false);
				expect(after.control.activeWorks.some(work => work.kind === "compact")).toBe(true);
				f.compaction.held = false;
				f.release("compaction");
				await until(
					() => recover(peer, parent, "desktop-continuous"),
					value => !value.control.activeWorks.some(work => work.kind === "compact"),
				);
			} else {
				// phase 分支不能收窄先前保存的可选快照；显式确认 held 队列后再完整比较。
				if (heldQueue === undefined) throw new Error("Missing held queue snapshot before Tan dispatch");
				expect(after.queue).toEqual(heldQueue);
			}
			expect(await jobs(peer, f.cwd, parent)).toHaveLength(1);
		} catch (error) {
			diagnose(f, peer, error);
			throw error;
		}
	}, 120000);
}

test("Tan stop rejects journal-only and recovered non-Tan ID collisions but cancels live Tan", async () => {
	const manager = new AsyncJobManager({ maxRunningJobs: 2 });
	const entries: SessionEntry[] = [
		{
			type: "custom_message",
			id: "old-dispatch",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
			content: "old Tan dispatch",
			display: true,
			details: { jobId: "bg_1", work: "old work" },
		},
	];
	const record = {
		id: "restored-parent",
		run: async <T>(operation: () => Promise<T>) => operation(),
		session: { asyncJobManager: manager, getAgentId: () => "Main" },
	} as unknown as ZCodeSessionRecord;
	const bridge = new OmpTanBridge({
		get: () => record,
		read: async () => ({ entries, messages: [] }),
		childIdentities: async () => ({}),
	} as unknown as ZCodeSessionManager);
	const held = Promise.withResolvers<void>();
	try {
		expect(await bridge.stop(record, "bg_1")).toMatchObject({ accepted: false });
		const ordinary = manager.register(
			"task",
			"ordinary task",
			async () => {
				await held.promise;
				return "ordinary done";
			},
			{ ownerId: "Main", agentId: "Worker-1", suppressDelivery: true },
		);
		expect(ordinary).toBe("bg_1");
		expect(await bridge.stop(record, ordinary)).toMatchObject({ accepted: false });
		expect(manager.getJob(ordinary)?.status).toBe("running");
		expect(manager.getJob(ordinary)?.abortController.signal.aborted).toBe(false);
		const tan = manager.register(
			"task",
			"/tan live work",
			async () => {
				await held.promise;
				return "Tan done";
			},
			{ ownerId: "Main", agentId: "Tan-live", suppressDelivery: true },
		);
		expect(await bridge.stop(record, tan)).toMatchObject({ accepted: true, job: { status: "cancelled" } });
		expect(manager.getJob(ordinary)?.status).toBe("running");
	} finally {
		held.resolve();
		await manager.dispose();
	}
});

test("accepted slash Tan command retains its receipt after cold restart without redispatch", async () => {
	await using root = await TempDir.create("@zcode-tan-receipt-");
	await using f = await fixture(root);
	await using peer = new Peer(f.cwd, f.env);
	await peer.ready();
	const parent = await create(peer, f.cwd);
	const command = {
		commandId: crypto.randomUUID(),
		clientId: "tan-host",
		sessionId: parent,
		type: "sendText",
		payload: { text: "/tan:TAN_CHILD_RECEIPT" },
		issuedAt: Date.now(),
	};
	expect(await peer.request("v4/command", command)).toMatchObject({ status: "accepted" });
	const dispatched = await until(
		() => jobs(peer, f.cwd, parent),
		values => values.length === 1,
	);
	expect((await settled(peer, f.cwd, parent, dispatched[0]!.jobId)).status).toBe("completed");
	await prompt(peer, parent, "TAN_PARENT_BUSY");
	await until(async () => f.started.has("TAN_PARENT_BUSY"), Boolean);
	const queued = {
		...command,
		commandId: crypto.randomUUID(),
		payload: { text: "ordinary unpromoted input", requestedDelivery: "queue" },
	};
	expect(await peer.request("v4/command", queued)).toMatchObject({ status: "accepted" });
	expect(await peer.eof()).toBe(0);
	const before = f.requests.length;
	await using restarted = new Peer(f.cwd, f.env);
	await restarted.ready();
	expect(
		await restarted.request("v4/commands/query", {
			commands: [{ sessionId: parent, commandId: command.commandId }],
		}),
	).toMatchObject({ results: [{ result: { status: "accepted" } }] });
	expect(
		await restarted.request("v4/commands/query", {
			commands: [{ sessionId: parent, commandId: queued.commandId }],
		}),
	).toMatchObject({ results: [{ result: { status: "failed" } }] });
	expect(await restarted.request("v4/command", command)).toMatchObject({ status: "duplicate" });
	expect(await jobs(restarted, f.cwd, parent)).toHaveLength(1);
	expect(f.requests).toHaveLength(before);
}, 120000);
