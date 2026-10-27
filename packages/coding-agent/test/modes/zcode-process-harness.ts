import { expect } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, type TempDir } from "@oh-my-pi/pi-utils";
import {
	COMMANDS_REQUIRING_BASE_REVISION,
	type CommandType,
	LegacyProtocol,
	ROW_TARGETING_COMMANDS,
	v4ConversationRowsRangeResultSchema,
} from "../../src/modes/zcode/schema";

export type Frame = Record<string, unknown>;
const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const explicitExecutable = Bun.env.OMP_ZCODE_TEST_EXECUTABLE?.trim();
if (explicitExecutable && !path.isAbsolute(explicitExecutable)) {
	throw new Error("OMP_ZCODE_TEST_EXECUTABLE must be an absolute executable path");
}
export const model = { providerId: "zcode-fixture", modelId: "chat-a" };

export async function deadline<T>(promise: Promise<T>, milliseconds = 30_000): Promise<T> {
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

export class ProcessPeer {
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

export async function fixture(root: TempDir, skillsEnabled = false) {
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
	// 非技能场景不启动描述压缩推理；真正验证资源的用例显式启用，保留其原生发现与读取链路。
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		`modelRoles:\n  default: zcode-fixture/chat-a\n  smol: zcode-fixture/chat-a\ntools:\n  xdev: false\nskills:\n  enabled: ${skillsEnabled}\nteam:\n  members:\n    - zcode-fixture/chat-a\n    - stale-provider/removed-model\n`,
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

export function workspace(cwd: string) {
	return { workspacePath: cwd, workspaceKey: cwd };
}
export async function create(peer: ProcessPeer, cwd: string, selection = model) {
	const snapshot = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
		await peer.request("session/create", {
			workspace: workspace(cwd),
			model: selection,
			titleGenerationEnabled: false,
		}),
	);
	return snapshot.session.sessionId;
}
export async function command(
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
export async function subscribe(
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
export async function output(peer: ProcessPeer, sessionId: string, marker: string) {
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
export function findInteraction(
	value: unknown,
	matches: (payload: Frame) => boolean = payload => payload.prompt === "Continue isolated session?",
): Frame | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findInteraction(item, matches);
			if (found) return found;
		}
	} else if (isRecord(value)) {
		if (typeof value.interactionId === "string" && isRecord(value.payload) && matches(value.payload)) return value;
		for (const item of Object.values(value)) {
			const found = findInteraction(item, matches);
			if (found) return found;
		}
	}
	return undefined;
}
export function hasUserInput(value: unknown, commandId: string): boolean {
	if (Array.isArray(value)) return value.some(item => hasUserInput(item, commandId));
	if (!isRecord(value)) return false;
	if (value.kind === "userInput" && value.sourceCommandId === commandId) return true;
	return Object.values(value).some(item => hasUserInput(item, commandId));
}
export async function finishedOutput(peer: ProcessPeer, sessionId: string, marker: string): Promise<void> {
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
export async function retainedModelIo(root: string): Promise<Map<string, string>> {
	const files = await fs.readdir(root, { recursive: true });
	const artifacts = new Map<string, string>();
	for (const relative of files.filter(file => /^\d+\.model-io\.log$/.test(path.basename(file))).sort()) {
		const actualPath = path.join(root, relative);
		artifacts.set(actualPath, await fs.readFile(actualPath, "utf8"));
	}
	return artifacts;
}
