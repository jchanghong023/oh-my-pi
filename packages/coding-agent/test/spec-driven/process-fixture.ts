import { expect, test as bunTest } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import {
	COMMANDS_REQUIRING_BASE_REVISION,
	LegacyProtocol,
	TopicWireFrameAssembler,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
	v4ConversationRowsRangeResultSchema,
	v4ConversationWorkflowRunsResultSchema,
} from "../../src/modes/zcode/schema";
import "../../src/tools"; // Runtime input of the spawned CLI for Bun --changed.
import {
	contentText,
	createProviderFixture,
	MARKER,
	type ModelRequest,
	REQUIREMENT,
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

function registerInvalidFileTests(roles: readonly ("requirements" | "solution" | "planner" | "executor")[]): void {
	for (const [index, role] of (["requirements", "solution", "planner", "executor"] as const).entries()) {
		if (!roles.includes(role)) continue;
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
}

export {
	bounded,
	fixture,
	GATE_BUDGET,
	git,
	isConversation,
	launch,
	PublicPeer,
	registerInvalidFileTests,
	run,
	test,
	textValues,
	workspace,
};
