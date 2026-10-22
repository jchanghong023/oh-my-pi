import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import {
	COMMANDS_REQUIRING_BASE_REVISION,
	type CommandType,
	LegacyProtocol,
	ROW_TARGETING_COMMANDS,
	TopicWireFrameAssembler,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
	conversationTopicWireFrameSchema,
	sessionsIndexTopicWireFrameSchema,
	subscribeAckSchema,
	v4ConversationRowsRangeResultSchema,
	workspaceConfigTopicWireFrameSchema,
	zcodeSessionConfigureResultSchema,
} from "../../src/modes/zcode/schema";
import { conversationTelemetryFactSchema } from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/telemetry";
import { SessionManager } from "../../src/session/session-manager";

type Frame = Record<string, unknown>;
const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const explicitExecutable = Bun.env.OMP_ZCODE_TEST_EXECUTABLE?.trim();
if (explicitExecutable && !path.isAbsolute(explicitExecutable)) {
	throw new Error("OMP_ZCODE_TEST_EXECUTABLE must be an absolute executable path");
}
const model = { providerId: "zcode-fixture", modelId: "chat-a" };

async function deadline<T>(promise: Promise<T>, milliseconds = 30_000): Promise<T> {
	// Real child-process IO cannot use the parent test's fake clock.
	const timeout = Promise.withResolvers<T>();
	const timer = setTimeout(
		() => timeout.reject(new Error(`Public process boundary exceeded ${milliseconds}ms`)),
		milliseconds,
	);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

class ProcessPeer {
	readonly child: Subprocess<"pipe", "pipe", "pipe">;
	readonly seen: Frame[] = [];
	readonly stderr: Promise<string>;
	reverseReply?: (frame: Frame) => unknown;
	memoryEnabled = false;
	#queue: Frame[] = [];
	#changed = Promise.withResolvers<void>();
	#ended = false;
	#failure: unknown;
	#id = 0;
	#pump: Promise<void>;

	constructor(cwd: string, env: NodeJS.ProcessEnv, args: string[] = []) {
		const launch = explicitExecutable ? [explicitExecutable] : [process.execPath, cli];
		const child = Bun.spawn([...launch, "app-server", "--stdio", "--surface", "desktop", "--cwd", cwd, ...args], {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.child = child;
		this.stderr = new Response(child.stderr).text();
		this.#pump = (async () => {
			try {
				for await (const raw of readJsonl<unknown>(child.stdout)) {
					if (!isRecord(raw) || "jsonrpc" in raw || "type" in raw || !("method" in raw || "id" in raw)) {
						throw new Error(`Non-ZCode stdout frame: ${JSON.stringify(raw)}`);
					}
					if (typeof raw.method === "string" && raw.id !== undefined) {
						const result =
							raw.method === "session/requestRuntimePreferences"
								? LegacyProtocol.zcodeSessionRuntimePreferencesResultSchema.parse({
										nativeSearchEnhancementsEnabled: false,
										memoryEnabled: this.memoryEnabled,
									})
								: this.reverseReply?.(raw);
						if (result !== undefined) this.write({ id: raw.id, result });
						// 未实现 readRuntimeConfig 的夹具 Host 按 -32601 回应(runtime 会话建立时必发一次
						// 该请求);其余未知反向请求保持挂起,供 cancel/abort 语义测试使用。
						else if (raw.method === "subagents/readRuntimeConfig")
							this.write({
								id: raw.id,
								error: { code: -32601, message: "Fixture host does not implement subagents/readRuntimeConfig" },
							});
					}
					this.#queue.push(raw);
					this.seen.push(raw);
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
		return deadline(
			(async () => {
				for (;;) {
					if (this.#failure) throw this.#failure;
					const index = this.#queue.findIndex(predicate);
					if (index >= 0) return this.#queue.splice(index, 1)[0]!;
					if (this.#ended) throw new Error(`OMP ended before expected frame: ${await this.stderr}`);
					await this.#changed.promise;
				}
			})(),
		);
	}

	async requestFrame(method: string, params: unknown): Promise<Frame> {
		const id = `request-${++this.#id}`;
		this.write({ id, method, params });
		return this.next(frame => frame.id === id).catch(error => {
			throw new Error(`Waiting for ${method} (${id}) failed`, { cause: error });
		});
	}

	async request(method: string, params: unknown): Promise<unknown> {
		const response = await this.requestFrame(method, params);
		if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
		expect(response).toHaveProperty("result");
		return response.result;
	}

	async ready() {
		return this.next(
			frame => frame.method === "startup/storageState" && isRecord(frame.params) && frame.params.phase === "ready",
		);
	}

	async eof() {
		this.child.stdin.end();
		const code = await deadline(this.child.exited);
		await this.#pump;
		if (this.#failure) throw this.#failure;
		return code;
	}

	async [Symbol.asyncDispose]() {
		if (this.child.exitCode === null) {
			this.child.stdin.end();
			try {
				await deadline(this.child.exited, 5000);
			} catch {
				this.child.kill();
				await this.child.exited;
			}
		}
		await this.#pump;
	}
}

async function fixture(root: TempDir) {
	const cwdA = root.join("workspace-a");
	const cwdB = root.join("workspace-b");
	const home = root.join("home");
	const configRoot = root.join("config");
	const agentDir = path.join(configRoot, "agent");
	for (const directory of [cwdA, cwdB, home, agentDir]) await fs.mkdir(directory, { recursive: true });
	const requests: Array<{ model: string; messages: Array<{ role: string; content?: unknown }>; tools?: unknown[] }> =
		[];
	let requestChanged = Promise.withResolvers<void>();
	const requestHeaders: Headers[] = [];
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const heldStreams = new Map<string, () => void>();
	const endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions")
				return new Response("Unexpected model/catalog access", { status: 500 });
			const body = (await request.json()) as { model: string; messages: Array<{ role: string; content?: unknown }> };
			requests.push(body);
			const changed = requestChanged;
			requestChanged = Promise.withResolvers<void>();
			changed.resolve();
			requestHeaders.push(new Headers(request.headers));
			const user = [...body.messages].reverse().find(message => message.role === "user");
			const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
			const marker = text?.match(/ZCODE_TEST_[A-Z0-9_]+/u)?.[0] ?? "ZCODE_TEST_AUX";
			const toolFinished = body.messages.at(-1)?.role === "tool";
			const tool =
				!toolFinished && marker.includes("TOOL")
					? { name: "write", args: { path: "proof.txt", content: marker } }
					: !toolFinished && marker.includes("DELEGATE")
						? {
								name: "task",
								args: {
									agent: "task",
									task: "Return the evidence token ZCODE_TEST_CHILD_MARKER and nothing else.",
								},
							}
						: !toolFinished && marker.includes("QUESTION")
							? {
									name: "ask",
									args: {
										questions: [
											{
												id: "confirm",
												question: "Continue isolated session?",
												options: [{ label: "Continue" }, { label: "Cancel" }],
											},
										],
									},
								}
							: undefined;
			let timer: NodeJS.Timeout | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					streams.add(controller);
					const chunk = (delta: unknown, finish: string | null = null) =>
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
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
							: { content: `${marker}_STREAMING` }),
					});
					const finish = () => {
						heldStreams.delete(marker);
						if (!streams.delete(controller)) return;
						if (!tool) chunk({ content: ` ${marker}_DONE` });
						chunk({}, tool ? "tool_calls" : "stop");
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						controller.close();
					};
					if (marker.includes("STOP")) {
						heldStreams.set(marker, finish);
						return;
					}
					timer = setTimeout(finish, marker.includes("STREAM") ? 1000 : 10);
				},
				cancel() {
					clearTimeout(timer);
					heldStreams.delete(marker);
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  zcode-fixture:\n    baseUrl: http://127.0.0.1:${endpoint.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n      - id: chat-b\n        reasoning: false\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: zcode-fixture/chat-a\n  smol: zcode-fixture/chat-a\ntools:\n  xdev: false\nteam:\n  members:\n    - zcode-fixture/chat-a\n    - stale-provider/removed-model\n",
	);
	const env: NodeJS.ProcessEnv = {
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
	};
	return {
		cwdA,
		cwdB,
		env,
		requests,
		requestHeaders,
		providerBaseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
		agentDir,
		configRoot,
		releaseHeldStream: (marker: string) => {
			const finish = heldStreams.get(marker);
			if (!finish) throw new Error(`No held fixture stream: ${marker}`);
			finish();
		},
		waitForRequest: (predicate: (request: (typeof requests)[number]) => boolean) =>
			deadline(
				(async () => {
					for (;;) {
						const request = requests.find(predicate);
						if (request) return request;
						await requestChanged.promise;
					}
				})(),
			),
		waitForRequests: (marker: string, count: number) =>
			deadline(
				(async () => {
					for (;;) {
						if (
							requests.filter(request => JSON.stringify(request.messages.at(-1)).includes(marker)).length >=
							count
						)
							return;
						await requestChanged.promise;
					}
				})(),
			),
		[Symbol.asyncDispose]: async () => {
			streams.clear();
			endpoint.stop(true);
		},
	};
}

function workspace(cwd: string) {
	return { workspacePath: cwd, workspaceKey: cwd };
}
async function create(peer: ProcessPeer, cwd: string, selection = model) {
	const snapshot = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
		await peer.request("session/create", {
			workspace: workspace(cwd),
			model: selection,
			titleGenerationEnabled: false,
		}),
	);
	return snapshot.session.sessionId;
}
async function command(
	peer: ProcessPeer,
	sessionId: string,
	type: CommandType,
	payload: unknown,
	commandId = crypto.randomUUID(),
) {
	let base: { baseRevision?: number; baseLogEpoch?: string } | undefined;
	// CAS 命令必带 baseRevision;row 定位命令(setHighspeedMetrics 等)必带 baseLogEpoch。
	if (COMMANDS_REQUIRING_BASE_REVISION.has(type) || ROW_TARGETING_COMMANDS.has(type)) {
		const current = v4ConversationRowsRangeResultSchema.parse(
			await peer.request("v4/conversation/rowsRange", { sessionId, limit: 1 }),
		);
		base = {
			...(COMMANDS_REQUIRING_BASE_REVISION.has(type) ? { baseRevision: current.atRevision } : {}),
			...(ROW_TARGETING_COMMANDS.has(type) ? { baseLogEpoch: current.atLogEpoch } : {}),
		};
	}
	return peer.request("v4/command", {
		commandId,
		clientId: "public-process-test",
		sessionId,
		type,
		payload,
		...base,
		issuedAt: Date.now(),
	});
}
async function subscribe(
	peer: ProcessPeer,
	sessionId: string,
	clientMode = "desktop-continuous",
	base?: { logEpoch: string; seq: number },
) {
	return peer.request("v4/conversation/subscribe", {
		topic: `conversation/${sessionId}`,
		connectionId: `test-${clientMode}`,
		clientMode,
		...(base ? { base } : {}),
	});
}
async function output(peer: ProcessPeer, sessionId: string, marker: string) {
	return peer
		.next(
			frame =>
				frame.method === "v4/conversation/frame" &&
				isRecord(frame.params) &&
				frame.params.topic === `conversation/${sessionId}` &&
				JSON.stringify(frame.params).includes(marker),
		)
		.catch(error => {
			throw new Error(`Waiting for ${sessionId} output ${marker} failed`, { cause: error });
		});
}
function findInteraction(value: unknown): Frame | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findInteraction(item);
			if (found) return found;
		}
	} else if (isRecord(value)) {
		if (
			typeof value.interactionId === "string" &&
			isRecord(value.payload) &&
			value.payload.prompt === "Continue isolated session?"
		)
			return value;
		for (const item of Object.values(value)) {
			const found = findInteraction(item);
			if (found) return found;
		}
	}
	return undefined;
}
function hasUserInput(value: unknown, commandId: string): boolean {
	if (Array.isArray(value)) return value.some(item => hasUserInput(item, commandId));
	if (!isRecord(value)) return false;
	if (value.kind === "userInput" && value.sourceCommandId === commandId) return true;
	return Object.values(value).some(item => hasUserInput(item, commandId));
}
async function finishedOutput(peer: ProcessPeer, sessionId: string, marker: string): Promise<void> {
	await output(peer, sessionId, marker);
	for (;;) {
		const snapshot = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await peer.request("session/read", { sessionId }),
		);
		if (snapshot.projection.status === "idle") return;
		await peer.next(
			frame =>
				frame.method === "v4/conversation/frame" &&
				isRecord(frame.params) &&
				frame.params.topic === `conversation/${sessionId}`,
		);
	}
}
async function retainedModelIo(root: string): Promise<Map<string, string>> {
	const files = await fs.readdir(root, { recursive: true });
	const artifacts = new Map<string, string>();
	for (const relative of files.filter(file => /^\d+\.model-io\.log$/.test(path.basename(file))).sort()) {
		const actualPath = path.join(root, relative);
		artifacts.set(actualPath, await fs.readFile(actualPath, "utf8"));
	}
	return artifacts;
}

describe("ZCode actual public app-server process", () => {
	test("canonical skill references execute the resident native skill rather than remaining model prose", async () => {
		await using root = await TempDir.create("@zcode-native-reference-");
		await using config = await fixture(root);
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
		const declaration = await prepare.next(frame => frame.method === "startup/storagePath");
		expect(declaration.params).toHaveProperty("path");
		expect(prepare.seen.some(frame => frame.method === "startup/storagePrepared")).toBe(false);
		prepare.write({ method: "startup/storagePathReady", reuse: false });
		const preparedReady = await prepare.ready();
		await prepare.next(frame => frame.method === "startup/storagePrepared");
		expect(await prepare.eof()).toBe(0);
		await using normal = new ProcessPeer(config.cwdA, config.env);
		const normalReady = await normal.ready();
		expect(normalReady.params).not.toEqual(preparedReady.params);
		expect(config.requests).toHaveLength(0);
		expect(await normal.eof()).toBe(0);
	}, 90_000);

	test("preparation EOF and invalid acknowledgment fail closed, invalid command envelope never executes", async () => {
		await using root = await TempDir.create("@zcode-failure-");
		await using config = await fixture(root);
		for (const ack of [undefined, { method: "startup/storagePathReady", params: { reuse: true } }]) {
			await using peer = new ProcessPeer(config.cwdA, config.env, ["--prepare-storage"]);
			await peer.next(frame => frame.method === "startup/storagePath");
			if (ack) peer.write(ack);
			expect(await peer.eof()).not.toBe(0);
			expect(peer.seen.some(frame => frame.method === "startup/storagePrepared")).toBe(false);
		}
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const response = await peer.requestFrame("v4/command", {
			protocolVersion: 999,
			type: "sendText",
			payload: { text: "must never execute" },
		});
		expect(response.error).toMatchObject({ code: expect.any(Number) });
		expect(config.requests).toHaveLength(0);
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

	test("forks first and later assistant turns at their inherited boundary and resolves native path linkage on cold reopen", async () => {
		await using root = await TempDir.create("@zcode-fork-boundary-");
		await using config = await fixture(root);
		let parentId = "";
		let nativeId = "";
		const children: string[] = [];
		const rows = async (peer: ProcessPeer, sessionId: string) =>
			v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
			).rows;
		const assertBoundary = async (peer: ProcessPeer, sessionId: string, inheritedTurns: number) => {
			const history = await rows(peer, sessionId);
			const markerIndex = history.findIndex(
				row => row.kind === "timelineMarker" && row.marker.type === "forkNotice",
			);
			expect(markerIndex).toBeGreaterThan(0);
			expect(history[markerIndex]).toMatchObject({
				lane: "turnTailBoundary",
				marker: { type: "forkNotice", parentSessionId: parentId, parentRowId: 0 },
			});
			expect(history.slice(0, markerIndex).filter(row => row.kind === "userInput")).toHaveLength(inheritedTurns);
			expect(history.slice(markerIndex + 1).filter(row => row.kind === "userInput")).toHaveLength(1);
			expect(history[markerIndex - 1].kind).toBe("assistantText");
			expect(history[markerIndex + 1].kind).toBe("turnHeader");
			expect(history.map(row => row.rowId)).toEqual(history.map(row => row.rowId).sort((a, b) => a - b));
		};
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			parentId = await create(peer, config.cwdA);
			await subscribe(peer, parentId);
			for (const turn of [1, 2]) {
				await command(peer, parentId, "sendText", { text: `ZCODE_TEST_FORK_PARENT_${turn}` });
				await finishedOutput(peer, parentId, `ZCODE_TEST_FORK_PARENT_${turn}_DONE`);
			}
			const targets = (await rows(peer, parentId)).filter(
				row => row.kind === "assistantText" && row.actions?.canFork,
			);
			expect(targets).toHaveLength(2);
			for (const [index, target] of targets.entries()) {
				const ack = await command(peer, parentId, "forkAssistant", {
					target: { rowId: target.rowId, entityId: target.entityId },
				});
				if (!isRecord(ack) || !isRecord(ack.result) || typeof ack.result.sessionId !== "string")
					throw new Error("Missing fork session result");
				const child = ack.result.sessionId;
				children.push(child);
				await subscribe(peer, child);
				await command(peer, child, "sendText", { text: `ZCODE_TEST_FORK_CHILD_${index}` });
				await finishedOutput(peer, child, `ZCODE_TEST_FORK_CHILD_${index}_DONE`);
				await assertBoundary(peer, child, index + 1);
			}
			expect(await peer.eof()).toBe(0);
		}
		// Exercise native createBranchedSession, whose header stores the parent's path, not ID.
		const files = (await fs.readdir(config.configRoot, { recursive: true })).filter(file => file.endsWith(".jsonl"));
		const parentFile = files.find(file => file.includes(parentId));
		if (!parentFile) throw new Error("Missing parent journal");
		const manager = await SessionManager.open(path.join(config.configRoot, parentFile));
		try {
			const target = manager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			if (!target) throw new Error("Missing native branch target");
			manager.createBranchedSession(target.id);
			nativeId = manager.getSessionId();
			await manager.ensureOnDisk();
			await manager.flush();
		} finally {
			await manager.close();
		}
		await using cold = new ProcessPeer(config.cwdA, config.env);
		await cold.ready();
		for (const [index, child] of children.entries()) {
			await assertBoundary(cold, child, index + 1);
			await cold.request("session/resume", { sessionId: child });
			await assertBoundary(cold, child, index + 1);
		}
		const nativeHistory = await rows(cold, nativeId);
		expect(nativeHistory.at(-1)).toMatchObject({
			kind: "timelineMarker",
			marker: { type: "forkNotice", parentSessionId: parentId, parentRowId: 0 },
		});
		await cold.request("session/resume", { sessionId: nativeId });
		await subscribe(cold, nativeId);
		await command(cold, nativeId, "sendText", { text: "ZCODE_TEST_NATIVE_FORK_CHILD" });
		await finishedOutput(cold, nativeId, "ZCODE_TEST_NATIVE_FORK_CHILD_DONE");
		await assertBoundary(cold, nativeId, 2);
		await cold.request("session/close", { sessionId: nativeId });
		await assertBoundary(cold, nativeId, 2);
	}, 120_000);

	test("selected yolo mode authorizes actual writes while build rejects and sibling permissions stay unchanged", async () => {
		await using root = await TempDir.create("@zcode-mode-write-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const [a, b] = await Promise.all([create(peer, config.cwdA), create(peer, config.cwdB)]);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		expect(await command(peer, a, "switchCollaborationMode", { mode: "build" })).toMatchObject({
			status: "accepted",
		});
		expect(await command(peer, b, "switchCollaborationMode", { mode: "build" })).toMatchObject({
			status: "accepted",
		});
		await command(peer, a, "sendText", { text: "ZCODE_TEST_TOOL_BUILD_A" });
		await finishedOutput(peer, a, "ZCODE_TEST_TOOL_BUILD_A_DONE");
		expect(await Bun.file(path.join(config.cwdA, "proof.txt")).exists()).toBe(false);
		const denied = await peer.request("session/messages", { sessionId: a });
		expect(JSON.stringify(denied)).toContain("Native tool approval is not supported by the ZCode host");
		expect(await command(peer, a, "switchCollaborationMode", { mode: "yolo" })).toMatchObject({
			status: "accepted",
		});
		await command(peer, a, "sendText", { text: "ZCODE_TEST_TOOL_YOLO_A" });
		await finishedOutput(peer, a, "ZCODE_TEST_TOOL_YOLO_A_DONE");
		expect(await fs.readFile(path.join(config.cwdA, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_YOLO_A");
		await command(peer, b, "sendText", { text: "ZCODE_TEST_TOOL_BUILD_B" });
		await finishedOutput(peer, b, "ZCODE_TEST_TOOL_BUILD_B_DONE");
		expect(await Bun.file(path.join(config.cwdB, "proof.txt")).exists()).toBe(false);
		const sibling = await peer.request("session/messages", { sessionId: b });
		expect(JSON.stringify(sibling)).toContain("Native tool approval is not supported by the ZCode host");
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("one process streams two sessions, runs real cwd-bound tools, deduplicates command identity and stops only target", async () => {
		await using root = await TempDir.create("@zcode-concurrent-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const [a, b] = await Promise.all([create(peer, config.cwdA), create(peer, config.cwdB)]);
		expect(a).not.toBe(b);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		await command(peer, a, "sendText", { text: "ZCODE_TEST_STOP_A" });
		await output(peer, a, "ZCODE_TEST_STOP_A_STREAMING");
		const commandId = crypto.randomUUID();
		const first = await command(peer, b, "sendText", { text: "ZCODE_TEST_TOOL_B" }, commandId);
		const duplicate = await command(peer, b, "sendText", { text: "ZCODE_TEST_TOOL_B" }, commandId);
		if (!isRecord(first)) throw new Error("Missing original command ACK");
		expect(duplicate).toEqual({ ...first, status: "duplicate" });
		await output(peer, b, "ZCODE_TEST_TOOL_B_DONE");
		expect(await fs.readFile(path.join(config.cwdB, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_B");
		expect(await Bun.file(path.join(config.cwdA, "proof.txt")).exists()).toBe(false);
		await command(peer, a, "stop", {});
		await command(peer, b, "sendText", { text: "ZCODE_TEST_STREAM_B" });
		const streamed = await output(peer, b, "ZCODE_TEST_STREAM_B_STREAMING");
		expect(conversationTopicWireFrameSchema.safeParse(streamed.params).success).toBe(true);
		await output(peer, b, "ZCODE_TEST_STREAM_B_DONE");
		const history = await peer.request("session/messages", { sessionId: b });
		expect(JSON.stringify(history)).not.toContain("ZCODE_TEST_STOP_A");
		expect(
			config.requests.filter(
				request =>
					request.messages.at(-1)?.role === "user" &&
					JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_TOOL_B"),
			),
		).toHaveLength(1);
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("question and config waits remain session-affine; temporary model and saved defaults do not switch peers", async () => {
		await using root = await TempDir.create("@zcode-question-config-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const [a, b] = await Promise.all([create(peer, config.cwdA), create(peer, config.cwdB)]);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		await command(peer, a, "sendText", { text: "ZCODE_TEST_QUESTION_A" });
		const waiting = await peer.next(
			frame => frame.method === "v4/conversation/frame" && findInteraction(frame.params) !== undefined,
		);
		const interaction = findInteraction(waiting.params)!;
		await command(peer, b, "sendText", { text: "ZCODE_TEST_WHILE_WAITING_B" });
		await output(peer, b, "ZCODE_TEST_WHILE_WAITING_B_DONE");
		await command(peer, a, "resolveInteraction", {
			interactionId: interaction.interactionId,
			answer: { optionId: "Continue" },
		});
		await finishedOutput(peer, a, "ZCODE_TEST_QUESTION_A_DONE");
		await command(peer, a, "switchModelConfig", { provider: model.providerId, model: "chat-b", thought: "off" });
		const roles = zcodeSessionConfigureResultSchema.parse(
			await peer.request("session/configure", { sessionId: a, operation: "get_model_roles" }),
		);
		if (roles.operation !== "get_model_roles") throw new Error("Unexpected configuration operation");
		const role = roles.data.roles.find(item => item.roleId === "default");
		if (!role) throw new Error("Default role not listed");
		const saved = await peer.request("session/configure", {
			sessionId: a,
			operation: "set_model_role",
			roleId: "default",
			scope: "user",
			expectedRevision: role.revision,
			selection: { kind: "model", model: { provider: model.providerId, modelId: "chat-b" } },
		});
		expect(saved).toMatchObject({ operation: "set_model_role", data: { persisted: true } });
		const team = zcodeSessionConfigureResultSchema.parse(
			await peer.request("session/configure", { sessionId: a, operation: "get_team_config" }),
		);
		if (team.operation !== "get_team_config") throw new Error("Unexpected Team operation");
		expect(team.data.userMembers).toContainEqual(
			expect.objectContaining({ rawSelector: "stale-provider/removed-model", status: "unresolved" }),
		);
		const before = await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8");
		const preview = await peer.request("session/configure", {
			sessionId: a,
			operation: "get_team_config",
			preview: { clientRevision: "draft-1", members: [] },
		});
		expect(preview).toMatchObject({ data: { preview: { clientRevision: "draft-1", userMembers: [] } } });
		expect(await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8")).toBe(before);
		const save = await peer.request("session/configure", {
			sessionId: a,
			operation: "set_team_config",
			scope: "user",
			expectedRevision: team.data.revision,
			members: [
				{ provider: model.providerId, modelId: "chat-b" },
				{ provider: model.providerId, modelId: "chat-b" },
			],
		});
		expect(save).toMatchObject({ data: { saveState: "complete" } });
		const stale = await peer.requestFrame("session/configure", {
			sessionId: a,
			operation: "set_team_config",
			scope: "user",
			expectedRevision: team.data.revision,
			members: [],
		});
		expect(stale.error).toMatchObject({ code: expect.any(Number) });
		await Promise.all([
			command(peer, a, "sendText", { text: "ZCODE_TEST_MODEL_A" }),
			command(peer, b, "sendText", { text: "ZCODE_TEST_MODEL_B" }),
		]);
		await Promise.all([output(peer, a, "ZCODE_TEST_MODEL_A_DONE"), output(peer, b, "ZCODE_TEST_MODEL_B_DONE")]);
		// 标题 sidecar 同样携带用户 marker，且固定用 smol；本场景须等带工具面的主请求，
		// 不能按首次包含 marker 的辅助请求误判会话模型隔离。
		const mainRequest = (marker: string) =>
			config.waitForRequest(request => {
				const tools = Reflect.get(request, "tools");
				return Array.isArray(tools) && tools.length > 0 && JSON.stringify(request.messages.at(-1)).includes(marker);
			});
		const [requestA, requestB] = await Promise.all([
			mainRequest("ZCODE_TEST_MODEL_A"),
			mainRequest("ZCODE_TEST_MODEL_B"),
		]);
		expect(requestA.model).toBe("chat-b");
		expect(requestB.model).toBe("chat-a");
	}, 120_000);

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

	test("Highspeed input cards survive public queue promotion, refresh and cold journal recovery without leaking", async () => {
		await using root = await TempDir.create("@zcode-highspeed-input-");
		await using config = await fixture(root);
		const directCommandId = crypto.randomUUID();
		const queuedCommandId = crypto.randomUUID();
		const plainCommandId = crypto.randomUUID();
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
			// The existing STOP fixture holds a real provider stream open: queue admission
			// is observed while busy, without secrets or execution-selection overrides.
			expect(
				await command(peer, sessionId, "sendText", { text: "ZCODE_TEST_CARD_STOP" }, plainCommandId),
			).toMatchObject({ status: "accepted" });
			await output(peer, sessionId, "ZCODE_TEST_CARD_STOP_STREAMING");
			expect(
				await command(
					peer,
					sessionId,
					"sendText",
					{
						text: "ZCODE_TEST_CARD",
						requestedDelivery: "queue",
						highspeedMeta: queuedCard,
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

	test("workspace catalog is available before any conversation without creating history or invoking a model", async () => {
		await using root = await TempDir.create("@zcode-workspace-catalog-");
		await using config = await fixture(root);
		const skillDir = path.join(config.cwdA, ".omp", "skills", "zcode-process-fixture");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			"---\nname: zcode-process-fixture\ndescription: Isolated public process catalog fixture\n---\nReturn the isolated fixture marker.\n",
		);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const before = await peer.request("session/list", { workspace: workspace(config.cwdA) });
		const journalFilesBefore = (await fs.readdir(config.configRoot, { recursive: true }))
			.filter(file => file.endsWith(".jsonl"))
			.sort();
		const topic = `workspace-config/${config.cwdA}`;
		expect(
			await peer.request("v4/conversation/subscribe", {
				topic,
				connectionId: "pre-session-catalog",
				clientMode: "desktop-continuous",
				workspace: workspace(config.cwdA),
			}),
		).toMatchObject({ ack: { mode: "snapshot" } });
		const notification = await peer.next(
			frame => frame.method === "v4/conversation/frame" && isRecord(frame.params) && frame.params.topic === topic,
		);
		const physical = workspaceConfigTopicWireFrameSchema.parse(notification.params);
		if (physical.kind !== "complete" || physical.frame.payload.kind !== "snapshot") {
			throw new Error("Isolated two-model workspace catalog did not produce a complete initial snapshot");
		}
		const names = physical.frame.payload.snapshot.config.slashCommands.map(item => item.name.replace(/^\//, ""));
		for (const name of [
			"wiki",
			"repo",
			"team",
			"goal-autopilot",
			"jch-workflowzbatch",
			"skill:zcode-process-fixture",
		]) {
			expect(names).toContain(name);
		}
		const catalogParams = { workspace: workspace(config.cwdA) };
		expect(
			await peer.request("workspace/hooks/trustGrant", {
				...catalogParams,
				bundleDigest: "a".repeat(64),
				hookDeclarationDigest: "b".repeat(64),
			}),
		).toEqual({ accepted: false, reasonCode: "workspace_hooks_policy_requires_pretrust" });
		const skills = LegacyProtocol.zcodeSkillsReferenceCatalogResultSchema.parse(
			await peer.request("skills/referenceCatalog", catalogParams),
		);
		expect(skills.authority).toBe("workspace");
		expect(skills.skills).toContainEqual(
			expect.objectContaining({
				name: "zcode-process-fixture",
				enabled: true,
				path: path.join(skillDir, "SKILL.md"),
			}),
		);
		LegacyProtocol.zcodePluginsListResultSchema.parse(await peer.request("plugins/list", catalogParams));
		LegacyProtocol.zcodePluginsOverviewResultSchema.parse(await peer.request("plugins/overview", catalogParams));
		expect(
			LegacyProtocol.zcodePluginsReferenceCatalogResultSchema.parse(
				await peer.request("plugins/referenceCatalog", catalogParams),
			).authority,
		).toBe("workspace");
		for (const method of ["skills/referenceCatalog", "plugins/referenceCatalog"]) {
			const missing = await peer.requestFrame(method, { ...catalogParams, sessionId: "missing-session" });
			expect(missing.error).toMatchObject({ code: -32004 });
		}
		expect(await peer.request("session/list", { workspace: workspace(config.cwdA) })).toEqual(before);
		expect(
			(await fs.readdir(config.configRoot, { recursive: true })).filter(file => file.endsWith(".jsonl")).sort(),
		).toEqual(journalFilesBefore);
		expect(config.requests).toHaveLength(0);
	}, 90_000);

	test("public model IO preference reaches live and future matching sessions without capturing other workspaces", async () => {
		await using root = await TempDir.create("@zcode-model-io-process-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const a = await create(peer, config.cwdA);
		const b = await create(peer, config.cwdB);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		expect(
			await peer.request("workspace/updateModelIoPreferences", {
				workspace: workspace(config.cwdA),
				preferences: { fullRetentionEnabled: true },
			}),
		).toMatchObject({ fullRetentionEnabled: true, updatedSessionCount: 1 });
		await Promise.all([
			command(peer, a, "sendText", { text: "ZCODE_TEST_CAPTURE_LIVE_A" }),
			command(peer, b, "sendText", { text: "ZCODE_TEST_NO_CAPTURE_B" }),
		]);
		await Promise.all([
			finishedOutput(peer, a, "ZCODE_TEST_CAPTURE_LIVE_A_DONE"),
			finishedOutput(peer, b, "ZCODE_TEST_NO_CAPTURE_B_DONE"),
		]);
		const a2 = await create(peer, config.cwdA);
		await subscribe(peer, a2);
		await command(peer, a2, "sendText", { text: "ZCODE_TEST_CAPTURE_FUTURE_A" });
		await finishedOutput(peer, a2, "ZCODE_TEST_CAPTURE_FUTURE_A_DONE");
		// Public close drains the artifact owner's pending IO; no timing sleeps or private flush seam.
		await Promise.all([
			peer.request("session/close", { sessionId: a }),
			peer.request("session/close", { sessionId: a2 }),
		]);
		const retained = await retainedModelIo(config.configRoot);
		expect(retained.size).toBe(2);
		const records = [...retained.values()].flatMap(contents =>
			contents
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as Frame),
		);
		for (const [id, marker] of [
			[a, "ZCODE_TEST_CAPTURE_LIVE_A"],
			[a2, "ZCODE_TEST_CAPTURE_FUTURE_A"],
		] as const) {
			const owned = records.filter(record => record.sessionId === id);
			expect(
				owned.some(record => record.type === "provider_payload" && JSON.stringify(record.payload).includes(marker)),
			).toBe(true);
			expect(
				owned.some(
					record => record.type === "model_response" && JSON.stringify(record.message).includes(`${marker}_DONE`),
				),
			).toBe(true);
		}
		expect(
			records.some(record => record.sessionId === b || JSON.stringify(record).includes("ZCODE_TEST_NO_CAPTURE_B")),
		).toBe(false);
		await peer.request("session/resume", { sessionId: a });
		await subscribe(peer, a);
		expect(
			await peer.request("workspace/updateModelIoPreferences", {
				workspace: workspace(config.cwdA),
				preferences: { fullRetentionEnabled: false },
			}),
		).toMatchObject({ fullRetentionEnabled: false, updatedSessionCount: 1 });
		const a3 = await create(peer, config.cwdA);
		await subscribe(peer, a3);
		await Promise.all([
			command(peer, a, "sendText", { text: "ZCODE_TEST_CAPTURE_DISABLED_A" }),
			command(peer, a3, "sendText", { text: "ZCODE_TEST_CAPTURE_DISABLED_FUTURE" }),
		]);
		await Promise.all([
			finishedOutput(peer, a, "ZCODE_TEST_CAPTURE_DISABLED_A_DONE"),
			finishedOutput(peer, a3, "ZCODE_TEST_CAPTURE_DISABLED_FUTURE_DONE"),
		]);
		await Promise.all([a, a3, b].map(sessionId => peer.request("session/close", { sessionId })));
		expect(await retainedModelIo(config.configRoot)).toEqual(retained);
		expect(
			config.requests.some(request =>
				JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_CAPTURE_DISABLED_A"),
			),
		).toBe(true);
		expect(
			config.requests.some(request =>
				JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_CAPTURE_DISABLED_FUTURE"),
			),
		).toBe(true);
	}, 120_000);
	test("header-only account credentials cross the actual Host reverse-request boundary without persistence or fallback", async () => {
		await using root = await TempDir.create("@zcode-header-auth-");
		await using config = await fixture(root);
		const builtinPath = root.join("builtin-provider.json");
		const personalPath = root.join("personal-provider.json");
		const accountModel = { providerId: "account:test", modelId: "chat-a" };
		await fs.writeFile(
			builtinPath,
			JSON.stringify({
				schemaVersion: 1,
				revision: 1,
				config: {
					providerConfigRules: {
						templateRules: [],
						providerRules: [
							{
								providerId: accountModel.providerId,
								config: {
									group: "zai-family",
									access: {
										type: "zhipu-account",
										accountType: "zai",
										mode: "individual-coding-plan",
										entitled: true,
									},
									api: { type: "openai-chat-completions", baseUrl: config.providerBaseUrl },
									builtinModelIds: [accountModel.modelId, "chat-b"],
								},
							},
						],
					},
					modelConfigRules: {
						modelRules: [],
						modelApiRules: [],
						providerSiteRules: [],
						templateModelRules: [],
						builtinProviderModelRules: [
							{
								providerId: accountModel.providerId,
								config: {
									properties: {
										contextWindow: 8192,
										inputFormat: { supportsText: true, supportsImage: false },
										supportsToolCall: true,
									},
									optionSpecs: { maxOutputTokens: { max: 1024 }, reasoningLevel: { values: ["off"] } },
								},
							},
						],
					},
				},
			}),
		);
		await fs.writeFile(
			personalPath,
			JSON.stringify({
				schemaVersion: 1,
				config: {
					providerConfigRules: { providerRules: [] },
					modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
				},
			}),
		);
		config.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinPath;
		config.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalPath;
		const secret = `fixture-request-only-${crypto.randomUUID()}`;
		let authMode: "allow" | "deny" | "hold" = "allow";
		await using peer = new ProcessPeer(config.cwdA, config.env);
		peer.reverseReply = frame => {
			if (frame.method !== "interaction/requestProviderRuntimeHeaders") return undefined;
			const params = LegacyProtocol.zcodeProviderRuntimeHeadersRequestParamsSchema.parse(frame.params);
			expect(params.providerId).toBe(accountModel.providerId);
			expect(params.workspace).toEqual(workspace(config.cwdA));
			if (authMode === "hold") return undefined;
			if (authMode === "deny") return { headersApplied: false, errorMessage: "Fixture authorization denied" };
			return {
				headersApplied: true,
				requestAuth: { headers: { authorization: `Bearer ${secret}`, "x-fixture-auth": secret } },
			};
		};
		await peer.ready();
		const basedOnZCodeBuiltinRevision = `zcode-builtin:1:${createHash("sha256").update(path.resolve(builtinPath)).digest("hex")}`;
		const providers = { [accountModel.providerId]: { access: { type: "zhipu-account", entitled: true } } };
		const states = { [accountModel.providerId]: { availability: "available", entitled: true, current: true } };
		const account = {
			revision: `account:${JSON.stringify([basedOnZCodeBuiltinRevision, [{ providerId: accountModel.providerId, config: providers[accountModel.providerId] }], states])}`,
			basedOnZCodeBuiltinRevision,
			providers,
			states,
		};
		expect(await peer.request("provider/updateAccountConfig", account)).toMatchObject({ status: "received" });
		const allowed = await create(peer, config.cwdA, accountModel);
		const [roles, models] = await Promise.all(
			["get_model_roles", "get_team_models"].map(async operation =>
				zcodeSessionConfigureResultSchema.parse(
					await peer.request("session/configure", { sessionId: allowed, operation }),
				),
			),
		);
		if (roles?.operation !== "get_model_roles" || models?.operation !== "get_team_models")
			throw new Error("Expected complete public role and Team catalogs");
		const expectedModels = ["chat-a", "chat-b"].map(modelId => ({
			provider: accountModel.providerId,
			modelId,
		}));
		expect(
			roles.data.roles
				.find(role => role.roleId === "default")
				?.candidateModels.filter(candidate => candidate.provider === accountModel.providerId),
		).toEqual(expectedModels);
		expect(roles.data.sessionModel?.model).toEqual(expectedModels[0]);
		expect(models.data.models.filter(candidate => candidate.model.provider === accountModel.providerId)).toEqual(
			expectedModels.map(candidate => ({ model: candidate, name: candidate.modelId, selectable: true })),
		);
		expect(models.data.models).toContainEqual({
			model: { provider: model.providerId, modelId: "chat-b" },
			name: "chat-b",
			selectable: true,
		});
		expect(
			models.data.models.some(candidate => !candidate.selectable && !!candidate.reasonCode && !!candidate.reason),
		).toBe(true);
		expect(peer.seen.some(frame => frame.method === "interaction/requestProviderRuntimeHeaders")).toBe(false);
		expect(config.requests).toHaveLength(0);
		await subscribe(peer, allowed);
		await peer.request("workspace/updateModelIoPreferences", {
			workspace: workspace(config.cwdA),
			preferences: { fullRetentionEnabled: true },
		});
		expect(await command(peer, allowed, "sendText", { text: "ZCODE_TEST_ACCOUNT_ALLOWED" })).toMatchObject({
			status: "accepted",
		});
		await finishedOutput(peer, allowed, "ZCODE_TEST_ACCOUNT_ALLOWED_DONE");
		expect(config.requests).toHaveLength(1);
		expect(config.requestHeaders[0]!.get("authorization")).toBe(`Bearer ${secret}`);
		expect(config.requestHeaders[0]!.get("x-fixture-auth")).toBe(secret);
		await peer.request("session/close", { sessionId: allowed });
		const retained = await retainedModelIo(config.configRoot);
		expect(retained.size).toBe(1);
		expect([...retained.values()].join("\n")).toContain("ZCODE_TEST_ACCOUNT_ALLOWED_DONE");
		expect([...retained.values()].join("\n")).not.toContain(secret);

		authMode = "deny";
		const denied = await create(peer, config.cwdA, accountModel);
		await subscribe(peer, denied);
		expect(await command(peer, denied, "sendText", { text: "ZCODE_TEST_ACCOUNT_DENIED" })).toMatchObject({
			status: "failed",
		});
		expect(config.requests).toHaveLength(1);

		authMode = "hold";
		const cancelled = await create(peer, config.cwdA, accountModel);
		await subscribe(peer, cancelled);
		const pending = command(peer, cancelled, "sendText", { text: "ZCODE_TEST_ACCOUNT_CANCELLED" });
		const reverse = await peer.next(
			frame =>
				frame.method === "interaction/requestProviderRuntimeHeaders" &&
				isRecord(frame.params) &&
				frame.params.sessionId === cancelled,
		);
		const params = LegacyProtocol.zcodeProviderRuntimeHeadersRequestParamsSchema.parse(reverse.params);
		await command(peer, cancelled, "stop", {});
		await peer.next(
			frame =>
				frame.method === "interaction/providerRuntimeHeadersCancelled" &&
				isRecord(frame.params) &&
				frame.params.requestId === params.requestId,
		);
		expect(await pending).toMatchObject({ status: "failed" });
		// A late Host answer cannot revive cancelled work or fall back to an available local model.
		peer.write({
			id: reverse.id,
			result: { headersApplied: true, requestAuth: { headers: { "x-fixture-auth": secret } } },
		});
		await Promise.all([denied, cancelled].map(sessionId => peer.request("session/close", { sessionId })));
		expect(await peer.eof()).toBe(0);
		expect(config.requests).toHaveLength(1);
		expect(JSON.stringify(peer.seen)).not.toContain(secret);
		expect(await peer.stderr).not.toContain(secret);
		for (const relative of await fs.readdir(root.path(), { recursive: true })) {
			const actualPath = path.join(root.path(), relative);
			if ((await fs.stat(actualPath)).isFile())
				expect((await fs.readFile(actualPath)).includes(Buffer.from(secret))).toBe(false);
		}
	}, 120_000);
	test("legacy Goal set and replace preserve reserved objectives through native execution and canonical cold recovery", async () => {
		await using root = await TempDir.create("@zcode-goal-boundary-");
		await using config = await fixture(root);
		let sessionId: string;
		let targetId: string;
		const commandId = crypto.randomUUID();
		const canonicalObjective = "resume ZCODE_TEST_GOAL_CANONICAL";
		const readGoal = async (peer: ProcessPeer) => {
			const subscription = await subscribe(peer, sessionId);
			if (!isRecord(subscription)) throw new Error("Missing Goal subscription");
			const ack = subscribeAckSchema.parse(subscription.ack);
			const frame = await peer.next(
				frame =>
					frame.method === "v4/conversation/frame" &&
					isRecord(frame.params) &&
					frame.params.subscriptionId === ack.subscriptionId,
			);
			const wire = conversationTopicWireFrameSchema.parse(frame.params);
			if (wire.kind !== "complete" || wire.frame.payload.kind !== "snapshot")
				throw new Error("Expected complete initial Goal snapshot");
			const goal = wire.frame.payload.snapshot.goal;
			if (!goal) throw new Error("Missing native Goal in conversation snapshot");
			return goal;
		};
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			sessionId = await create(peer, config.cwdA);
			await subscribe(peer, sessionId);
			for (const [action, objective, marker] of [
				["set", "pause ZCODE_TEST_GOAL_CREATE", "ZCODE_TEST_GOAL_CREATE"],
				["replace", "replacement ZCODE_TEST_GOAL_REPLACE", "ZCODE_TEST_GOAL_REPLACE"],
			] as const) {
				const result = LegacyProtocol.zcodeSessionGoalResultSchema.parse(
					await peer.request("session/goal", {
						sessionId,
						action,
						objective,
						inputId: `input-${marker}`,
					}),
				);
				expect(result.snapshot.session.sessionId).toBe(sessionId);
				await finishedOutput(peer, sessionId, `${marker}_DONE`);
				expect(await readGoal(peer)).toMatchObject({ objective, status: "active" });
				const modelRequest = config.requests.find(request =>
					JSON.stringify(request.messages.at(-1)).includes(marker),
				);
				expect(modelRequest?.model).toBe("chat-a");
				expect(JSON.stringify(modelRequest?.messages.at(-1)?.content)).toContain(objective);
			}
			expect(
				await command(peer, sessionId, "sendGoalCommand", { text: canonicalObjective }, commandId),
			).toMatchObject({ status: "accepted" });
			await finishedOutput(peer, sessionId, "ZCODE_TEST_GOAL_CANONICAL_DONE");
			const goal = await readGoal(peer);
			expect(goal).toMatchObject({ objective: canonicalObjective, status: "active" });
			targetId = goal.targetId;
			const rows = v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
			);
			expect(rows.rows.filter(row => row.kind === "userInput" && row.sourceCommandId === commandId)).toEqual([
				expect.objectContaining({ text: canonicalObjective, sourceCommandId: commandId }),
			]);
			expect(
				config.requests.some(request =>
					JSON.stringify(request.messages.at(-1)?.content).includes(canonicalObjective),
				),
			).toBe(true);
			expect(await peer.eof()).toBe(0);
		}
		const requestCount = config.requests.length;
		await using cold = new ProcessPeer(config.cwdA, config.env);
		await cold.ready();
		const restored = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await cold.request("session/read", { sessionId }),
		);
		expect(restored.session.sessionId).toBe(sessionId);
		expect(await readGoal(cold)).toMatchObject({ targetId, objective: canonicalObjective });
		const rows = v4ConversationRowsRangeResultSchema.parse(
			await cold.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
		);
		expect(rows.rows.filter(row => row.kind === "userInput" && row.sourceCommandId === commandId)).toEqual([
			expect.objectContaining({ text: canonicalObjective, sourceCommandId: commandId }),
		]);
		expect(config.requests).toHaveLength(requestCount);
	}, 120_000);
	test("reset loops keep the public session and journal identity while replacing projection epoch only for that session", async () => {
		await using root = await TempDir.create("@zcode-loop-reset-process-");
		await using config = await fixture(root);
		await fs.mkdir(path.join(config.cwdA, ".omp"), { recursive: true });
		await fs.writeFile(path.join(config.cwdA, ".omp", "config.yml"), "loop:\n  mode: reset\n");
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const a = await create(peer, config.cwdA);
		const b = await create(peer, config.cwdB);
		const subscription = await subscribe(peer, a);
		if (!isRecord(subscription)) throw new Error("Missing initial loop subscription");
		const initialEpoch = subscribeAckSchema.parse(subscription.ack).logEpoch;
		await subscribe(peer, b);
		await Promise.all([
			command(peer, a, "sendText", { text: "ZCODE_TEST_LOOP_WARM_A" }),
			command(peer, b, "sendText", { text: "ZCODE_TEST_LOOP_WARM_B" }),
		]);
		await Promise.all([
			finishedOutput(peer, a, "ZCODE_TEST_LOOP_WARM_A_DONE"),
			finishedOutput(peer, b, "ZCODE_TEST_LOOP_WARM_B_DONE"),
		]);
		const journals = (await fs.readdir(config.configRoot, { recursive: true }))
			.filter(file => file.endsWith(".jsonl"))
			.sort();
		expect(journals).toHaveLength(2);
		await command(peer, b, "sendText", { text: "ZCODE_TEST_STOP_PEER_B" });
		await output(peer, b, "ZCODE_TEST_STOP_PEER_B_STREAMING");
		expect(await command(peer, a, "sendText", { text: "/loop 1 ZCODE_TEST_LOOP_RESET" })).toMatchObject({
			status: "accepted",
		});
		await config.waitForRequests("ZCODE_TEST_LOOP_RESET", 2);
		await finishedOutput(peer, a, "ZCODE_TEST_LOOP_RESET_DONE");
		await command(peer, a, "stop", {});
		const reread = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await peer.request("session/read", { sessionId: a }),
		);
		expect(reread.session.sessionId).toBe(a);
		expect(
			(await fs.readdir(config.configRoot, { recursive: true })).filter(file => file.endsWith(".jsonl")).sort(),
		).toEqual(journals);
		const listed = LegacyProtocol.zcodeSessionListResultSchema.parse(await peer.request("session/list", {}));
		expect(listed.sessions.map(item => item.sessionId).sort()).toEqual([a, b].sort());
		const recovery = await subscribe(peer, a);
		if (!isRecord(recovery)) throw new Error("Missing reset-loop subscription");
		expect(subscribeAckSchema.parse(recovery.ack).logEpoch).not.toBe(initialEpoch);
		const peerState = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await peer.request("session/read", { sessionId: b }),
		);
		expect(peerState.projection.status).toBe("running");
		await command(peer, b, "stop", {});
		await command(peer, b, "sendText", { text: "ZCODE_TEST_TOOL_AFTER_LOOP_B" });
		await finishedOutput(peer, b, "ZCODE_TEST_TOOL_AFTER_LOOP_B_DONE");
		expect(await fs.readFile(path.join(config.cwdB, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_AFTER_LOOP_B");
		expect(
			config.requests.filter(request => JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_LOOP_RESET")),
		).toHaveLength(2);
	}, 120_000);
});
