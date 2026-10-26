import { describe, expect, test as bunTest } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord, parseFrontmatter, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import {
	COMMANDS_REQUIRING_BASE_REVISION,
	LegacyProtocol,
	TopicWireFrameAssembler,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
	v4ConversationRowsRangeResultSchema,
	v4ConversationWorkflowRunsResultSchema,
} from "../../src/modes/zcode/schema";
import inventory from "../../src/spec-driven/vendor/inventory.json";
import {
	contentText,
	createProviderFixture,
	MARKER,
	type ModelRequest,
	type Reply,
	REQUIREMENT,
	respond,
	rolePayload,
} from "./provider-fixture";

const executable = Bun.env.OMP_SPEC_TEST_EXECUTABLE?.trim();
if (executable && !path.isAbsolute(executable))
	throw new Error("OMP_SPEC_TEST_EXECUTABLE must be an absolute executable path");
const launch = executable ? [executable] : [process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts")];
// One budget covers real CLI startup, native tools and the isolated local provider.
const GATE_BUDGET = 600_000;
type Frame = Record<string, unknown>;
const caseDiagnostics = new AsyncLocalStorage<Array<() => unknown>>();
function bounded(value: unknown): string {
	return JSON.stringify(
		value,
		(key, item: unknown) => {
			if (/authorization|apiKey|token|secret|password/iu.test(key)) return "[redacted]";
			if (typeof item === "string") return item.length > 2_000 ? `${item.slice(0, 2_000)}…[truncated]` : item;
			return item;
		},
		2,
	).slice(0, 24_000);
}
function test(name: string, body: () => Promise<void>, budget: number): void {
	bunTest(
		name,
		() =>
			caseDiagnostics.run([], async () => {
				const diagnostics = caseDiagnostics.getStore()!;
				let reported = false;
				const report = () => {
					if (reported) return;
					reported = true;
					const observations = diagnostics.map(snapshot => snapshot());
					console.error(
						`Public acceptance final status: ${JSON.stringify({
							case: name,
							observations: observations.map(observation =>
								isRecord(observation)
									? {
											command: observation.command,
											phase: observation.phase,
											phaseText: observation.phaseText,
										}
									: observation,
							),
						})}`,
					);
					console.error(
						`Public acceptance diagnostics: ${bounded({
							case: name,
							observations: observations.map(observation =>
								isRecord(observation)
									? {
											...observation,
											phase: isRecord(observation.phase)
												? {
														...observation.phase,
														statusMaterial: undefined,
														publishedText: undefined,
													}
												: observation.phase,
										}
									: observation,
							),
						})}`,
					);
				};
				// Diagnostic-only timer at the existing gate boundary, not a new execution deadline.
				const timer = setTimeout(report, budget);
				try {
					await body();
				} catch (error) {
					report();
					throw error;
				} finally {
					clearTimeout(timer);
				}
			}),
		budget,
	);
}
function executorToolDiagnostics(request: ModelRequest | undefined): unknown[] {
	if (!request) return [];
	return request.messages
		.filter(message => message.role === "tool")
		.slice(-8)
		.map(message => ({
			toolCallId: message.tool_call_id,
			result: contentText(message.content),
		}));
}

class PublicPeer {
	readonly child: Subprocess<"pipe", "pipe", "pipe">;
	readonly seen: Frame[] = [];
	readonly stderr: Promise<string>;
	#changed = Promise.withResolvers<void>();
	#ended = false;
	#failure?: unknown;
	#id = 0;
	#pump: Promise<void>;
	#currentCommand?: Frame;
	#waiting?: string;
	#stderrText = "";
	#observed: Frame[] = [];
	#assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
	constructor(cwd: string, env: NodeJS.ProcessEnv, provider: { requests: ModelRequest[]; failures: string[] }) {
		const child = Bun.spawn([...launch, "app-server", "--stdio", "--surface", "desktop", "--cwd", cwd], {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.child = child;
		caseDiagnostics.getStore()?.push(() => ({
			command: this.#currentCommand,
			waiting: this.#waiting,
			conversationTopics: [
				...new Set(
					this.seen
						.filter(frame => frame.method === "v4/conversation/frame")
						.map(frame => (isRecord(frame.params) ? frame.params.topic : undefined)),
				),
			],
			conversationFrames: this.seen.filter(frame => frame.method === "v4/conversation/frame").slice(-8),
			providerFailures: provider.failures.slice(-12),
			executorTools: executorToolDiagnostics(
				provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === "executor"),
			),
			providerRequests: provider.requests.slice(-8).map(request => ({
				model: request.model,
				role: rolePayload(request)?.specDrivenRole,
				tools: request.tools?.map(tool => tool.function?.name),
				lastUser: contentText(request.messages.findLast(message => message.role === "user")?.content),
				messages: request.messages.slice(-4).map(message => ({
					role: message.role,
					toolCalls: message.tool_calls,
					...(message.role === "tool" ? { content: contentText(message.content) } : {}),
				})),
			})),
			stderr: this.#stderrText,
			ended: this.#ended,
			frames: this.#observed,
		}));
		this.stderr = (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of child.stderr)
				this.#stderrText = `${this.#stderrText}${decoder.decode(chunk, { stream: true })}`.slice(-8_000);
			this.#stderrText = `${this.#stderrText}${decoder.decode()}`.slice(-8_000);
			return this.#stderrText;
		})();
		this.#pump = (async () => {
			try {
				for await (const value of readJsonl<unknown>(child.stdout)) {
					if (!isRecord(value) || "jsonrpc" in value || "type" in value || !("method" in value || "id" in value))
						throw new Error(`Non-public stdout frame: ${JSON.stringify(value)}`);
					this.#observed.push(value);
					if (this.#observed.length > 12) this.#observed.shift();
					if (typeof value.method === "string" && value.id !== undefined) {
						if (value.method === "session/requestRuntimePreferences")
							this.write({
								id: value.id,
								result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
							});
						else if (value.method === "subagents/readRuntimeConfig")
							this.write({
								id: value.id,
								error: {
									code: -32601,
									message: "Fixture host does not override native subagent configuration",
								},
							});
					}
					if (value.method === "v4/conversation/frame") {
						for (const event of this.#assembler.accept(
							conversationTopicWireCandidateSchema.parse(value.params),
						)) {
							if (event.kind === "fault")
								throw new Error(`Public conversation assembly failed: ${event.fault.reasonCode}`);
							this.seen.push({ method: value.method, params: event.frame });
						}
					} else this.seen.push(value);
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
	write(frame: Frame): void {
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}
	async next(predicate: (frame: Frame) => boolean | Promise<boolean>, since = 0): Promise<Frame> {
		let cursor = since;
		for (;;) {
			if (this.#failure) throw this.#failure;
			for (; cursor < this.seen.length; cursor++) if (await predicate(this.seen[cursor]!)) return this.seen[cursor]!;
			if (this.#ended) throw new Error(`OMP ended before expected public output: ${await this.stderr}`);
			await this.#changed.promise;
		}
	}
	async request(method: string, params: unknown): Promise<unknown> {
		const id = `spec-public-${++this.#id}`;
		this.#waiting = `${method} (${id})`;
		this.write({ id, method, params });
		const frame = await this.next(item => item.id === id);
		if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
		this.#waiting = undefined;
		return frame.result;
	}
	async ready(): Promise<void> {
		this.#waiting = "startup/storageState ready";
		await this.next(frame => {
			if (frame.method !== "startup/storageState" || !isRecord(frame.params)) return false;
			if (frame.params.phase === "failed")
				throw new Error(`Public storage startup failed: ${bounded(frame.params)}`);
			return frame.params.phase === "ready";
		});
		this.#waiting = undefined;
	}
	async create(cwd: string): Promise<string> {
		const snapshot = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await this.request("session/create", {
				workspace: workspace(cwd),
				model: { providerId: "spec-fixture", modelId: "chat-a" },
				titleGenerationEnabled: false,
			}),
		);
		const id = snapshot.session.sessionId;
		await this.request("v4/conversation/subscribe", {
			topic: `conversation/${id}`,
			connectionId: `spec-${id}`,
			clientMode: "desktop-continuous",
			includeSpecDriven: true,
		});
		return id;
	}
	async send(
		sessionId: string,
		text: string,
		status: "accepted" | "rejected" | "failed" = "accepted",
	): Promise<number> {
		const since = this.seen.length;
		const issuedAt = Date.now();
		this.#currentCommand = { sessionId, text, issuedAt, since };
		const type = "sendText";
		const current = COMMANDS_REQUIRING_BASE_REVISION.has(type)
			? v4ConversationRowsRangeResultSchema.parse(
					await this.request("v4/conversation/rowsRange", { sessionId, limit: 1 }),
				)
			: undefined;
		expect(
			await this.request("v4/command", {
				commandId: crypto.randomUUID(),
				clientId: "omp-spec-acceptance",
				sessionId,
				type,
				payload: { text },
				...(current ? { baseRevision: current.atRevision } : {}),
				issuedAt,
			}),
		).toMatchObject({ status, ...(status === "failed" ? { reasonCode: "fault.command.execution" } : {}) });
		return since;
	}
	async stage(sessionId: string, phase: string, ready = true) {
		let cursor = 0;
		for (;;) {
			const result = v4ConversationWorkflowRunsResultSchema.parse(
				await this.request("v4/conversation/workflowRuns", { sessionId, includeSpecDriven: true, limit: 64 }),
			);
			const run = result.runs.findLast(row => row.spec?.phase === phase);
			if (
				run?.spec &&
				(!ready ||
					run.spec.actions.some(action => action.id === "next" && action.available) ||
					run.spec.state === "terminal" ||
					run.spec.state === "blocked")
			)
				return { ...run, spec: run.spec };
			this.#waiting = `stage ${phase}: conversation/${sessionId}`;
			const event = await this.next(frame => isConversation(frame, sessionId), cursor);
			cursor = this.seen.indexOf(event) + 1;
		}
	}
	async settled(sessionId: string, since: number) {
		const command = this.#currentCommand;
		if (command?.since !== since || typeof command.issuedAt !== "number")
			throw new Error(`Native settlement has no matching public command: ${bounded({ sessionId, since, command })}`);
		await this.request("v4/conversation/subscribe", {
			topic: `conversation/${sessionId}`,
			connectionId: crypto.randomUUID(),
			clientMode: "desktop-continuous",
		});
		let cursor = this.seen.length;
		for (;;) {
			const result = v4ConversationRowsRangeResultSchema.parse(
				await this.request("v4/conversation/rowsRange", { sessionId, limit: 200 }),
			);
			const header = result.rows.findLast(row => row.kind === "turnHeader");
			if (header?.kind === "turnHeader" && header.startedAt >= command.issuedAt) {
				const rows = result.rows.filter(row => row.turnId === header.turnId);
				const hasInput = rows.some(row => row.kind === "userInput" && row.text.trim().length > 0);
				if (header.state === "failed" || header.state === "completedInterrupted")
					throw new Error(
						`Native turn did not complete successfully: ${bounded({ sessionId, command, header, rows })}`,
					);
				const hasResult = rows.some(
					row => row.kind === "assistantText" && row.state === "complete" && row.text.trim().length > 0,
				);
				if (hasInput && hasResult && header.state === "completedSuccess") {
					this.#waiting = undefined;
					return;
				}
			}
			this.#waiting = `settled: native turn completion on conversation/${sessionId}`;
			const event = await this.next(frame => isConversation(frame, sessionId), cursor);
			cursor = this.seen.indexOf(event) + 1;
		}
	}
	async [Symbol.asyncDispose](): Promise<void> {
		if (this.child.exitCode === null) this.child.kill();
		await this.child.exited;
		await this.#pump;
	}
}
function workspace(cwd: string) {
	return { workspacePath: cwd, workspaceKey: cwd };
}
function textValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(textValues);
	return isRecord(value) ? Object.values(value).flatMap(textValues) : [];
}
function isConversation(frame: Frame, sessionId: string): boolean {
	return (
		frame.method === "v4/conversation/frame" &&
		isRecord(frame.params) &&
		frame.params.topic === `conversation/${sessionId}`
	);
}
async function fixture(root: TempDir, baseUrl: string) {
	const cwd = root.join("project");
	const home = root.join("home");
	const configRoot = root.join("config");
	const agentDir = path.join(configRoot, "agent");
	// 原生隔离保护临时产物的父目录；临时空间与项目必须分开，
	// 否则把 fixture 根作为 TEMP 会连真实项目源码也划入受保护范围。
	const temp = root.join("tmp");
	for (const directory of [cwd, home, agentDir, temp]) await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  spec-fixture:\n    baseUrl: ${baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 200000\n      - id: chat-b\n        reasoning: false\n        contextWindow: 200000\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: spec-fixture/chat-a\n  smol: spec-fixture/chat-a\ntools:\n  xdev: false\nasync:\n  enabled: false\n",
	);
	const env: NodeJS.ProcessEnv = {
		PATH: Bun.env.PATH,
		SystemRoot: Bun.env.SystemRoot,
		WINDIR: Bun.env.WINDIR,
		ProgramFiles: Bun.env.ProgramFiles,
		LOCALAPPDATA: home,
		TEMP: temp,
		TMP: temp,
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: configRoot,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_OFFLINE: "0",
		PI_NO_TITLE: "1",
		NO_PROXY: "127.0.0.1,localhost",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: root.join("empty-gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "OMP Acceptance",
		GIT_AUTHOR_EMAIL: "omp-acceptance@example.invalid",
		GIT_COMMITTER_NAME: "OMP Acceptance",
		GIT_COMMITTER_EMAIL: "omp-acceptance@example.invalid",
		OPENSPEC_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
	};
	await fs.writeFile(env.GIT_CONFIG_GLOBAL!, "");
	await git(cwd, env, ["init", "--initial-branch=main"]);
	await fs.writeFile(path.join(cwd, "baseline.txt"), "Baseline belongs to the acceptance fixture.\n");
	await git(cwd, env, ["add", "baseline.txt"]);
	await git(cwd, env, ["-c", "core.hooksPath=", "commit", "-m", "Fixture baseline"]);
	return { cwd, env, root: root.path() };
}
async function run(cwd: string, env: NodeJS.ProcessEnv, command: string[]) {
	const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}
async function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
	const result = await run(cwd, env, ["git", ...args]);
	if (result.exitCode !== 0) throw new Error(`Fixture Git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

describe("spec-driven actual OMP public entry", () => {
	test(
		"ordinary sessions retain native read, write and Task outside /dev",
		async () => {
			await using root = await TempDir.create("@omp-spec-ordinary-control-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(config.cwd);
			const since = await peer.send(
				session,
				"OMP_SPEC_ORDINARY_CONTROL: exercise ordinary native read, write and Task.",
			);
			await peer.next(
				frame =>
					isConversation(frame, session) &&
					textValues(frame).some(text => text.includes("OMP_SPEC_ORDINARY_CONTROL_DONE")),
				since,
			);
			expect(await fs.readFile(path.join(config.cwd, "ordinary-note.txt"), "utf8")).toBe(
				"ordinary session remains writable\n",
			);
			expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
			const native = provider.requests
				.flatMap(request => request.messages)
				.flatMap(message => message.tool_calls ?? [])
				.filter(isRecord);
			expect(
				native.some(
					call =>
						isRecord(call.function) &&
						typeof call.function.name === "string" &&
						call.function.name.replace(/^_/u, "") === "task",
				),
			).toBe(true);
			expect(provider.failures).toEqual([]);
		},
		GATE_BUDGET,
	);
	test(
		"first Dev entry binds the native recipient before its first reply and keeps root history independent",
		async () => {
			await using root = await TempDir.create("@omp-dev-native-first-entry-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(config.cwd);
			await peer.send(session, "/dev");
			const since = await peer.send(session, `/dev new ${MARKER}: ${REQUIREMENT}`);
			const current = await peer.stage(session, "requirements", false);
			const stageId = current.spec.interaction?.recipient?.sessionId;
			if (!stageId) throw new Error("Native stage session missing");
			expect(stageId).not.toBe(session);
			await peer.settled(stageId, since);
			const read = (id: string) =>
				peer
					.request("v4/conversation/rowsRange", { sessionId: id, limit: 200 })
					.then(value => v4ConversationRowsRangeResultSchema.parse(value));
			const stage = await read(stageId);
			expect(stage.rows.some(row => row.kind === "toolCall" && row.status === "success")).toBe(true);
			expect(JSON.stringify(stage.rows)).toContain("文件已写入。");
			expect(JSON.stringify((await read(session)).rows)).not.toContain("文件已写入。");
			const feedback = "Keep the current requirements; explain their whitespace rule.";
			const replySince = peer.seen.length;
			const nativeCommand = {
				commandId: crypto.randomUUID(),
				clientId: "omp-spec-acceptance",
				sessionId: stageId,
				type: "sendText",
				payload: { text: feedback },
				baseRevision: (await read(stageId)).atRevision,
				issuedAt: Date.now(),
			};
			expect(await peer.request("v4/command", nativeCommand)).toMatchObject({ status: "accepted" });
			await peer.next(
				frame =>
					isConversation(frame, stageId) &&
					textValues(frame).some(text => text.includes(`${MARKER}_REQUIREMENTS_DIALOGUE`)),
				replySince,
			);
			expect(JSON.stringify((await read(stageId)).rows)).toContain(feedback);
			expect(JSON.stringify((await read(session)).rows)).not.toContain(`${MARKER}_REQUIREMENTS_DIALOGUE`);
			const replyCount = provider.requests.length;
			expect(await peer.request("v4/command", nativeCommand)).toMatchObject({ status: "duplicate" });
			const key = { sessionId: stageId, commandId: nativeCommand.commandId };
			expect(await peer.request("v4/commands/query", { commands: [key] })).toMatchObject({
				results: [{ key, result: { status: "accepted" } }],
			});
			expect(provider.requests.length).toBe(replyCount);
			await peer.send(session, "/dev");
			const ordinarySince = await peer.send(session, "ordinary conversation after Dev exit");
			await peer.next(
				frame =>
					isConversation(frame, session) && textValues(frame).some(text => text.includes(`${MARKER}_CHAT_READY`)),
				ordinarySince,
			);
			expect(JSON.stringify((await read(stageId)).rows)).not.toContain(`${MARKER}_CHAT_READY`);
			expect(provider.failures).toEqual([]);
		},
		GATE_BUDGET,
	);

	test(
		"linked requirements cannot change business files and resume after the link is removed",
		async () => {
			await using root = await TempDir.create("@omp-dev-document-link-");
			let cwd = "";
			let linkedDirectory = "";
			let blockedWrite: Reply["tool"];
			let repairing = false;
			let repairDispatched = false;
			await using provider = createProviderFixture({
				async reply(request) {
					const role = rolePayload(request)?.specDrivenRole;
					if (repairing && role === "requirements") {
						if (!repairDispatched && blockedWrite) {
							repairDispatched = true;
							return { tool: blockedWrite };
						}
						return { text: "需求文档已在正常目录中补齐，请确认。" };
					}
					const reply = respond(request);
					const requested = reply.tool?.args.path;
					if (
						role === "requirements" &&
						typeof requested === "string" &&
						requested.endsWith("/spec.md") &&
						!blockedWrite
					) {
						blockedWrite = reply.tool;
						linkedDirectory = path.dirname(path.join(cwd, requested));
						await fs.mkdir(path.dirname(linkedDirectory), { recursive: true });
						await fs.symlink(
							path.join(cwd, "src"),
							linkedDirectory,
							process.platform === "win32" ? "junction" : "dir",
						);
					}
					return reply;
				},
			});
			const config = await fixture(root, provider.baseUrl);
			cwd = config.cwd;
			await fs.mkdir(path.join(cwd, "src"));
			const business = path.join(cwd, "src/spec.md");
			await fs.writeFile(business, "business bytes");
			await using peer = new PublicPeer(cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(cwd);
			await peer.send(session, "/dev");
			const since = await peer.send(session, `/dev new ${MARKER}: ${REQUIREMENT}`);
			const current = await peer.stage(session, "requirements", false);
			const stageId = current.spec.interaction?.recipient?.sessionId;
			if (!stageId) throw new Error("Native requirements session missing");
			await peer.settled(stageId, since);
			if (!blockedWrite || !linkedDirectory) throw new Error("Native specification write was not exercised");
			expect(await fs.readFile(business, "utf8")).toBe("business bytes");
			await peer.send(session, "/dev next", "failed");
			expect((await peer.stage(session, "requirements", false)).spec.interaction?.recipient?.sessionId).toBe(
				stageId,
			);
			await fs.rm(linkedDirectory, { recursive: true, force: true });
			repairing = true;
			const repairSince = await peer.send(session, "请在已移除链接的原路径补齐需求文档");
			await peer.settled(stageId, repairSince);
			const nextSince = await peer.send(session, "/dev next");
			const solution = await peer.stage(session, "solution", false);
			const solutionId = solution.spec.interaction?.recipient?.sessionId;
			if (!solutionId) throw new Error("Native solution session missing");
			await peer.settled(solutionId, nextSince);
			expect(await fs.readFile(business, "utf8")).toBe("business bytes");
			expect(provider.failures).toEqual([]);
			await peer.send(session, "/dev");
		},
		GATE_BUDGET,
	);

	for (const [index, role] of (["requirements", "solution", "planner", "executor"] as const).entries()) {
		for (const kind of ["missing", "malformed", "unknown"] as const) {
			test(
				`${role} next rejects ${kind} native files without advancing or calling a successor`,
				async () => {
					await using root = await TempDir.create("@omp-dev-invalid-file-");
					await using provider = createProviderFixture({ fileFailure: { role, kind } });
					const config = await fixture(root, provider.baseUrl);
					await using peer = new PublicPeer(config.cwd, config.env, provider);
					await peer.ready();
					const session = await peer.create(config.cwd);
					await peer.send(session, "/dev");
					let since = await peer.send(session, `/dev new ${MARKER}: ${REQUIREMENT}`);
					const phases = ["requirements", "solution", "planning", "executing"];
					for (let position = 0; position < index; position++) {
						const current = await peer.stage(session, phases[position]!);
						const stageId = current.spec.interaction?.recipient?.sessionId;
						if (!stageId) throw new Error("Native stage session missing");
						await peer.settled(stageId, since);
						since = await peer.send(session, position === 1 ? "/dev next pure" : "/dev next");
					}
					const current = await peer.stage(session, phases[index]!);
					const stageId = current.spec.interaction?.recipient?.sessionId;
					if (!stageId) throw new Error("Native stage session missing");
					await peer.settled(stageId, since);
					const count = provider.requests.length;
					await peer.send(session, index === 1 ? "/dev next pure" : "/dev next", "failed");
					const refused = await peer.stage(session, phases[index]!);
					expect(refused.spec.phase).toBe(current.spec.phase);
					expect(refused.spec.explanation?.length).toBeGreaterThan(0);
					expect(provider.requests.length).toBe(count);
					expect(
						provider.requests
							.map(rolePayload)
							.filter(Boolean)
							.every(
								payload =>
									(["requirements", "solution", "planner", "executor"] as readonly string[]).indexOf(
										payload!.specDrivenRole,
									) <= index,
							),
					).toBe(true);
					expect(provider.failures).toEqual([]);
				},
				GATE_BUDGET,
			);
		}
	}

	for (const hasOpenSpec of [true, false]) {
		test(
			`packaged skills preserve directory-scoped OpenSpec discovery and manual access (${hasOpenSpec ? "with" : "without"} openspec)`,
			async () => {
				await using root = await TempDir.create("@omp-spec-skills-");
				await using provider = createProviderFixture();
				const config = await fixture(root, provider.baseUrl);
				if (hasOpenSpec) await fs.mkdir(path.join(config.cwd, "openspec"));
				const baseline = await git(config.cwd, config.env, ["rev-parse", "HEAD"]);
				await using peer = new PublicPeer(config.cwd, config.env, provider);
				await peer.ready();
				const defaultSkills: Record<string, true> = {
					"verification-before-completion": true,
					"systematic-debugging": true,
					"writing-skills": true,
				};
				if (hasOpenSpec)
					for (const entry of inventory.skills.filter(entry => entry.source === "openspec"))
						defaultSkills[entry.name] = true;
				const ordinary = await peer.create(config.cwd);
				let since = await peer.send(ordinary, `${MARKER} ordinary greeting, no skills requested`);
				await peer.next(
					frame =>
						isConversation(frame, ordinary) &&
						textValues(frame).some(text => text.includes(`${MARKER}_CHAT_READY`)),
					since,
				);
				const ordinaryRequests = provider.requests.filter(request => (request.tools?.length ?? 0) > 0);
				expect(ordinaryRequests.length).toBeGreaterThan(0);
				for (const request of ordinaryRequests)
					for (const skill of inventory.skills) {
						expect(JSON.stringify(request.messages)).not.toContain(`/skill:${skill.name}`);
						expect(JSON.stringify(request.messages)).not.toContain(`name: ${skill.name}`);
						expect(JSON.stringify(request.messages)).not.toContain(skill.path);
					}
				const catalog = LegacyProtocol.zcodeSkillsReferenceCatalogResultSchema.parse(
					await peer.request("skills/referenceCatalog", { workspace: workspace(config.cwd), sessionId: ordinary }),
				);
				const resourceMetadata = new Map<string, { name: string; description: string }>();
				for (const entry of inventory.skills) {
					const skill = catalog.skills.find(item => item.name === entry.name);
					if (!skill) throw new Error(`Public packaged skill missing: ${entry.name}`);
					const canonical = await fs.realpath(skill.path);
					expect(path.relative(config.root, canonical).startsWith("..")).toBe(false);
					expect(canonical.replaceAll("\\", "/")).toEndWith(entry.path);
					const source = await fs.readFile(canonical, "utf8");
					const metadata = parseFrontmatter(source, { source: canonical, repair: false, level: "off" });
					if (
						typeof metadata.frontmatter.name !== "string" ||
						typeof metadata.frontmatter.description !== "string"
					)
						throw new Error(`Packaged resource lacks skill identity: ${entry.name}`);
					for (const request of ordinaryRequests) {
						const context = request.messages.map(message => contentText(message.content)).join("\n");
						if (typeof metadata.frontmatter.description === "string") {
							if (defaultSkills[entry.name]) expect(context).toContain(entry.name);
							else expect(context).not.toContain(metadata.frontmatter.description);
						}
					}
					resourceMetadata.set(entry.name, {
						name: metadata.frontmatter.name,
						description: metadata.frontmatter.description,
					});
				}
				for (const entry of inventory.skills) {
					const session = await peer.create(config.cwd);
					const requestStart = provider.requests.length;
					const selectedPath = `skill://${entry.name}:raw`;
					const allowedPaths: string[] = [];
					const others = inventory.skills.filter(other => other.name !== entry.name && !defaultSkills[other.name]);
					const deniedPaths = others.map(other => `skill://${other.name}:raw`);
					since = await peer.send(
						session,
						`${entry.source === "openspec" && hasOpenSpec ? "Use OpenSpec; read the relevant skill instructions." : `/skill:${entry.name}`} ${MARKER} capability inspection only; do not implement, archive, commit, launch servers or execute destructive scripts.\nOMP_SPEC_MANUAL_RESOURCE ${JSON.stringify({ path: selectedPath, allowedPaths, deniedPaths })}`,
					);
					await peer.next(
						frame =>
							isConversation(frame, session) &&
							textValues(frame).some(text => text.includes(`${MARKER}_CHAT_READY`)),
						since,
					);
					const requests = provider.requests
						.slice(requestStart)
						.filter(request => (request.tools?.length ?? 0) > 0);
					expect(requests.length).toBeGreaterThan(0);
					// Inspect native results delivered back to the model, correlated by the
					// public provider tool-call ID. The model's final text is only a barrier.
					const completed = requests.at(-1)!;
					const published = v4ConversationRowsRangeResultSchema.parse(
						await peer.request("v4/conversation/rowsRange", { sessionId: session, limit: 100 }),
					);
					const readResult = (target: string): string => {
						const call = completed.messages
							.flatMap(message => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
							.find(value => {
								if (!isRecord(value) || !isRecord(value.function)) return false;
								if (typeof value.function.arguments !== "string") return false;
								const args: unknown = JSON.parse(value.function.arguments);
								return (
									typeof value.function.name === "string" &&
									value.function.name.replace(/^_/u, "") === "read" &&
									isRecord(args) &&
									args.path === target
								);
							});
						if (!isRecord(call) || typeof call.id !== "string")
							throw new Error(`No native read call for ${target}`);
						const result = completed.messages.find(
							message => isRecord(message) && message.role === "tool" && message.tool_call_id === call.id,
						);
						if (!result) throw new Error(`No native read result for ${target}`);
						if (target === selectedPath || allowedPaths.includes(target)) {
							const row = published.rows.find(item => item.kind === "toolCall" && item.toolCallId === call.id);
							if (!row || row.kind !== "toolCall" || row.status !== "success")
								throw new Error(
									`Selected package read failed: ${bounded({
										resource: entry.name,
										path: target,
										status: row?.kind === "toolCall" ? row.status : "missing",
										output: contentText(result.content).slice(0, 500),
									})}`,
								);
						}
						return contentText(result.content);
					};
					const selected = parseFrontmatter(readResult(selectedPath), {
						source: selectedPath,
						repair: false,
						level: "off",
					});
					// Resource identity and usable instructions, not rendered prompt wording
					// or a copied body, establish that the real package read succeeded.
					expect(selected.frontmatter.name).toBe(resourceMetadata.get(entry.name)!.name);
					expect(typeof selected.frontmatter.description).toBe("string");
					const denied = readResult(deniedPaths.join(";"));
					const context = completed.messages.map(message => contentText(message.content)).join("\n");
					for (const other of others) {
						expect(denied).toContain(`Skill access denied: ${other.name}`);
						const description = resourceMetadata.get(other.name)?.description;
						if (typeof description === "string") expect(context).not.toContain(description);
					}
				}
				// Public packaged companion entry uses the embedded runtime and trusted launcher,
				// not a raw extracted script or a developer-machine Node installation.
				const graphDirectory = root.join("graphviz-fixture");
				await fs.mkdir(graphDirectory, { recursive: true });
				await fs.writeFile(
					path.join(graphDirectory, "SKILL.md"),
					"# Acceptance graph\n\n```dot\ndigraph acceptance { specification -> approved; }\n```\n",
				);
				const rendered = await run(config.cwd, config.env, [
					...launch,
					"superpowers",
					"skills/writing-skills/render-graphs.js",
					graphDirectory,
				]);
				const graphOutput = `${rendered.stdout}\n${rendered.stderr}`;
				const svg = Bun.file(path.join(graphDirectory, "diagrams/acceptance.svg"));
				if (rendered.exitCode === 0) {
					expect(await svg.exists()).toBe(true);
					expect(await svg.text()).toContain("<svg");
					expect(graphOutput).toContain("Rendered:");
				} else {
					expect(await svg.exists()).toBe(false);
					expect(graphOutput).toMatch(/graphviz \(dot\) not found/iu);
					expect(graphOutput).not.toContain("Rendered:");
				}
				// Missing Bash is observable through the trusted public launcher. With Bash,
				// no-argument usage is a real safe failure; never run destructive inventory probes.
				const reviewUsage = await run(config.cwd, config.env, [
					...launch,
					"superpowers",
					"skills/subagent-driven-development/scripts/review-package",
				]);
				expect(reviewUsage.exitCode).not.toBe(0);
				expect(`${reviewUsage.stdout}\n${reviewUsage.stderr}`).toMatch(/usage|require.*bash/iu);
				expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
				expect(provider.failures).toEqual([]);
				expect(await git(config.cwd, config.env, ["status", "--porcelain"])).toBe("");
				expect(await git(config.cwd, config.env, ["rev-parse", "HEAD"])).toBe(baseline);
			},
			GATE_BUDGET,
		);
	}

	test(
		"detached public omp openspec dispatch supplies native commands, schema and instructions",
		async () => {
			await using root = await TempDir.create("@omp-openspec-distribution-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			const invoke = async (args: string[]) => run(config.cwd, config.env, [...launch, "openspec", ...args]);
			const help = await invoke(["--help"]);
			expect(help.exitCode).toBe(0);
			for (const command of [
				"init",
				"list",
				"view",
				"show",
				"change",
				"spec",
				"new",
				"status",
				"instructions",
				"schema",
				"validate",
				"archive",
			])
				expect(help.stdout).toContain(command);
			const version = await invoke(["--version"]);
			expect(version.exitCode).toBe(0);
			expect(version.stdout).toContain(inventory.openspec.version);
			let resourceRoot: string;
			{
				// Locate the distribution through its public skill catalog, not the source resource loader.
				await using peer = new PublicPeer(config.cwd, config.env, provider);
				await peer.ready();
				const session = await peer.create(config.cwd);
				const catalog = LegacyProtocol.zcodeSkillsReferenceCatalogResultSchema.parse(
					await peer.request("skills/referenceCatalog", { workspace: workspace(config.cwd), sessionId: session }),
				);
				const entry = catalog.skills.find(skill => skill.name === "brainstorming");
				if (!entry) throw new Error("Packaged Superpowers skill unavailable through public catalog");
				resourceRoot = path.resolve(entry.path, "../../../..");
				expect((await fs.realpath(resourceRoot)).startsWith(await fs.realpath(config.root))).toBe(true);
			}
			const catalogRequestCount = provider.requests.length;
			const bundledSchema = path.join(resourceRoot, "omp-spec");
			const schema = path.join(config.cwd, "openspec/schemas/omp-spec");
			await fs.mkdir(path.dirname(schema), { recursive: true });
			await fs.cp(bundledSchema, schema, { recursive: true });
			const created = await invoke(["new", "change", "distribution-check", "--schema", "omp-spec"]);
			expect(created.exitCode).toBe(0);
			const status = await invoke(["status", "--change", "distribution-check", "--json"]);
			expect(status.exitCode).toBe(0);
			const state = JSON.parse(status.stdout) as { artifacts: Array<{ id: string }> };
			expect(state.artifacts.map(artifact => artifact.id).sort()).toEqual(["proposal", "specs"]);
			for (const artifact of ["proposal", "specs"]) {
				const instruction = await invoke(["instructions", artifact, "--change", "distribution-check", "--json"]);
				expect(instruction.exitCode).toBe(0);
				const value: unknown = JSON.parse(instruction.stdout);
				expect(isRecord(value)).toBe(true);
				expect(JSON.stringify(value)).toContain(artifact);
				expect(JSON.stringify(value)).toContain("template");
			}
			const schemas = await invoke(["schema", "which", "omp-spec", "--json"]);
			expect(schemas.exitCode).toBe(0);
			expect(schemas.stdout.replaceAll("\\\\", "/").replaceAll("\\", "/")).toContain("omp-spec");
			const invalid = await invoke(["validate", "distribution-check", "--json"]);
			expect(invalid.exitCode).not.toBe(0);
			const change = path.join(config.cwd, "openspec/changes/distribution-check");
			await fs.writeFile(
				path.join(change, "proposal.md"),
				"## Why\nExercise packaged CLI.\n\n## What Changes\nAdd greeting.\n\n## Capabilities\n### New Capabilities\n- greeting: greeting behavior\n\n## Impact\nFixture only.\n",
			);
			await fs.mkdir(path.join(change, "specs/greeting"), { recursive: true });
			await fs.writeFile(
				path.join(change, "specs/greeting/spec.md"),
				"## ADDED Requirements\n\n### Requirement: Greeting\nThe system SHALL return a greeting.\n\n#### Scenario: Greeting requested\n- **WHEN** greeting is requested\n- **THEN** return a greeting\n",
			);
			const valid = await invoke(["validate", "distribution-check", "--json"]);
			expect(valid.exitCode).toBe(0);
			expect(valid.stdout).toContain("true");
			expect(provider.requests).toHaveLength(catalogRequestCount);
		},
		GATE_BUDGET,
	);
});
