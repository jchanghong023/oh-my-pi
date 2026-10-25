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
import type { Skill } from "../../src/extensibility/skills";
import { loadSpecDrivenSkill } from "../../src/spec-driven/resources";
import {
	BEHAVIOR_TEST,
	CHANGE_ID,
	contentText,
	createProviderFixture,
	IMPLEMENTATION_PATH,
	HANDOFF_MARKER,
	MARKER,
	isNativeHandoff,
	type ModelRequest,
	type ProviderFixture,
	respond,
	REQUIREMENT,
	rolePayload,
	TEST_PATH,
	VALIDATION_COMMAND,
} from "./provider-fixture";

const executable = Bun.env.OMP_SPEC_TEST_EXECUTABLE?.trim();
if (executable && !path.isAbsolute(executable))
	throw new Error("OMP_SPEC_TEST_EXECUTABLE must be an absolute executable path");
const launch = executable ? [executable] : [process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts")];
// One gate budget covers child startup, native Team, real Git and all validations. No shorter IO deadlines.
const GATE_BUDGET = 600_000;
type Frame = Record<string, unknown>;
const caseDiagnostics = new AsyncLocalStorage<Array<() => unknown>>();
function bounded(value: unknown): string {
	return JSON.stringify(value, (key, item: unknown) => {
		if (/authorization|apiKey|token|secret|password/iu.test(key)) return "[redacted]";
		if (typeof item === "string") return item.length > 2_000 ? `${item.slice(0, 2_000)}…[truncated]` : item;
		return item;
	}).slice(0, 24_000);
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
	const input = rolePayload(request)?.input;
	const latestInput = request.messages.findLastIndex(
		message =>
			message.role === "user" && rolePayload({ ...request, messages: [message] })?.specDrivenRole === "executor",
	);
	const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
	const projection = {
		latestInput,
		messageCount: request.messages.length,
		tasks: tasks.map(task =>
			isRecord(task)
				? {
						id: task.id,
						status: task.status,
						execution: isRecord(task.execution)
							? {
									redRecordId: task.execution.redRecordId,
									greenRecordId: task.execution.greenRecordId,
									recordIds: task.execution.recordIds,
								}
							: null,
						recordCount: Array.isArray(task.records) ? task.records.length : null,
					}
				: null,
		),
	};
	return [
		projection,
		...request.messages
			.flatMap(message => message.tool_calls ?? [])
			.slice(-30)
			.map(call => {
				if (!isRecord(call) || !isRecord(call.function) || typeof call.function.arguments !== "string")
					return { malformed: true };
				const args: unknown = JSON.parse(call.function.arguments);
				const response = request.messages.find(
					message => message.role === "tool" && message.tool_call_id === call.id,
				);
				const raw = contentText(response?.content);
				let outcome: unknown = raw.slice(0, 1_400);
				try {
					const value: unknown = JSON.parse(raw);
					if (isRecord(value)) {
						const task = isRecord(value.task) ? { id: value.task.id, status: value.task.status } : undefined;
						outcome = {
							task,
							id: value.id,
							result: value.result,
							obligation: value.obligation,
							binding: value.binding,
							inputsBefore: isRecord(value.inputsBefore) ? value.inputsBefore.version : undefined,
							inputsAfter: isRecord(value.inputsAfter) ? value.inputsAfter.version : undefined,
						};
					}
				} catch {
					/* Native text errors remain useful without inventing structured success. */
				}
				return {
					id: call.id,
					name: call.function.name,
					args: isRecord(args)
						? {
								action: args.action,
								taskId: args.taskId,
								validationId: args.validationId,
								stage: args.stage,
								path: args.path,
								writeContent:
									typeof args.content === "string"
										? { length: args.content.length, includesBroken: args.content.includes("BROKEN") }
										: undefined,
							}
						: args,
					outcome,
				};
			}),
	];
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
	#currentPhase?: Frame;
	#currentPhaseText?: string;
	#waiting?: string;
	#stderrText = "";
	#observed: Frame[] = [];
	#statusRowIds = new Map<string, number>();
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
			phase: this.#currentPhase,
			phaseText: this.#currentPhaseText,
			phaseTextTail: this.#currentPhaseText?.slice(-4_000),
			waiting: this.#waiting,
			providerFailures: provider.failures.slice(-12),
			executorTools: executorToolDiagnostics(
				provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === "executor"),
			),
			providerRequests: provider.requests.slice(-8).map(request => ({
				model: request.model,
				role: rolePayload(request)?.specDrivenRole,
				kind: rolePayload(request)?.input.kind,
				tools: request.tools?.map(tool => tool.function?.name),
				nativeHandoff: isNativeHandoff(request),
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
		});
		return id;
	}
	async send(sessionId: string, text: string): Promise<number> {
		const since = this.seen.length;
		this.#currentCommand = { sessionId, text };
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
				issuedAt: Date.now(),
			}),
		).toMatchObject({ status: "accepted" });
		return since;
	}
	async reject(sessionId: string, text: string): Promise<void> {
		this.#currentCommand = { sessionId, text };
		const before = v4ConversationWorkflowRunsResultSchema.parse(
			await this.request("v4/conversation/workflowRuns", { sessionId, includeSpecDriven: true, limit: 64 }),
		);
		const current = v4ConversationRowsRangeResultSchema.parse(
			await this.request("v4/conversation/rowsRange", { sessionId, limit: 1 }),
		);
		expect(
			await this.request("v4/command", {
				commandId: crypto.randomUUID(),
				clientId: "omp-spec-acceptance",
				sessionId,
				type: "sendText",
				payload: { text },
				...(COMMANDS_REQUIRING_BASE_REVISION.has("sendText") ? { baseRevision: current.atRevision } : {}),
				issuedAt: Date.now(),
			}),
		).toMatchObject({ status: "rejected", reasonCode: "fault.command.invalid" });
		const after = v4ConversationWorkflowRunsResultSchema.parse(
			await this.request("v4/conversation/workflowRuns", { sessionId, includeSpecDriven: true, limit: 64 }),
		);
		expect(after.runs.filter(run => run.spec)).toEqual(before.runs.filter(run => run.spec));
	}
	async phase(
		sessionId: string,
		phase: string | readonly string[],
		since: number,
		allowStopped = false,
		requireStopped = false,
	): Promise<{ state: Frame; text: string }> {
		const expected = typeof phase === "string" ? [phase] : phase;
		this.#waiting = `session ${sessionId} phase ${phase}`;
		let observed: { state: Frame; text: string } | undefined;
		await this.next(async item => {
			const latest = await publishedStatus(item, sessionId, this.#statusRowIds.get(sessionId) ?? 0, this);
			if (!latest) return false;
			this.#statusRowIds.set(sessionId, latest.rowId);
			this.#currentPhase = latest.state;
			this.#currentPhaseText = latest.text;
			const state = latest.state;
			// A phase may publish before its native operation releases the decision gate.
			if (state.ready === false) return false;
			// A refused stale command can report a reason while leaving the workflow
			// active at its gate. Real workflow pauses and terminal failures still fail fast.
			// /dev cancel 的终态自身带 paused；仅该明确请求的终态可以通过，
			// 执行中的真实暂停仍立即失败，并保留状态正文里的阻塞原因。
			if (
				(state.paused === true &&
					!(expected.includes("cancelled") && state.phase === "cancelled") &&
					!allowStopped) ||
				((state.phase === "failed" || state.phase === "blocked" || state.blockedReason !== undefined) &&
					!expected.includes(String(state.phase)))
			)
				throw new Error(`Workflow stopped before ${phase}: ${bounded({ state, text: latest.text })}`);
			// 初始 gate-status 和运行中阶段不是本条命令的停止结果。
			if (requireStopped && !isStoppedStatus(state)) return false;
			if (!expected.includes(String(state.phase))) return false;
			observed = { state, text: latest.text };
			return true;
		}, since);
		if (!observed) throw new Error(`No current public status for ${phase}`);
		this.#waiting = undefined;
		return observed;
	}
	async stopped(sessionId: string, since: number): Promise<{ state: Frame; text: string }> {
		// Observe without consuming phase()'s row cursor: the later pause/cancel
		// command must still read its own published result.
		const minimumRowId = this.#statusRowIds.get(sessionId) ?? 0;
		let observed: { state: Frame; text: string } | undefined;
		await this.next(async item => {
			const latest = await publishedStatus(item, sessionId, minimumRowId, this);
			if (!latest) return false;
			this.#currentPhase = latest.state;
			this.#currentPhaseText = latest.text;
			if (!isStoppedStatus(latest.state)) return false;
			observed = latest;
			return true;
		}, since);
		if (!observed) throw new Error("No stopped command result");
		return observed;
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
function isStoppedStatus(state: Frame): boolean {
	if (state.ready === false) return false;
	return (
		state.paused === true ||
		state.blockedReason !== undefined ||
		[
			"awaiting-choice",
			"awaiting-plan",
			"awaiting-acceptance",
			"completed",
			"cancelled",
			"blocked",
			"failed",
		].includes(String(state.phase))
	);
}
async function publishedStatus(
	item: Frame,
	sessionId: string,
	minimumRowId: number,
	peer: PublicPeer,
): Promise<{ rowId: number; state: Frame; text: string } | undefined> {
	if (!isConversation(item, sessionId) || !isRecord(item.params)) return undefined;
	const frame = item.params;
	if (!isRecord(frame.payload) || frame.payload.kind !== "deltas" || !Array.isArray(frame.payload.deltas))
		return undefined;
	let latest: { rowId: number; text: string } | undefined;
	let workflowUpdated = false;
	for (const delta of frame.payload.deltas) {
		if (!isRecord(delta)) continue;
		if (
			delta.op === "workflowRun.updated" ||
			(delta.op === "state.updated" && isRecord(delta.patch) && delta.patch.workflowRuns !== undefined)
		)
			workflowUpdated = true;
		if (delta.op !== "row.appended" && delta.op !== "row.upserted") continue;
		const row = delta.row;
		if (!isRecord(row) || row.kind !== "assistantText" || typeof row.text !== "string") continue;
		if (typeof row.rowId !== "number" || row.rowId <= minimumRowId) continue;
		if (!latest || row.rowId >= latest.rowId) latest = { rowId: row.rowId, text: row.text };
	}
	// Terminal transitions need not append a new assistant row.
	if (!latest && !workflowUpdated) return undefined;
	const result = v4ConversationWorkflowRunsResultSchema.parse(
		await peer.request("v4/conversation/workflowRuns", { sessionId, includeSpecDriven: true, limit: 64 }),
	);
	const run = result.runs.findLast(run => run.spec);
	if (!run?.spec) return undefined;
	const spec = run.spec;
	return {
		rowId: latest?.rowId ?? minimumRowId,
		state: {
			phase: spec.phase,
			ready: spec.actions.every(action => action.available !== false),
			paused: spec.state === "paused" || spec.phase === "cancelled",
			blockedReason: spec.state === "blocked" || spec.state === "paused" ? spec.explanation : undefined,
			generation: spec.generation,
			runId: run.runId,
			specificationVersion: spec.versions.specification,
			planVersion: spec.versions.plan,
			acceptanceVersion: spec.versions.acceptance,
			selection: spec.selectedCandidate ?? undefined,
			candidates: spec.candidates,
			statusMaterial: run,
			publishedText: latest?.text,
		},
		// Decisions come from negotiated native actions, never from UI wording.
		text: spec.actions
			.filter(action => action.available !== false && action.command)
			.map(action => action.command)
			.join("\n"),
	};
}
function isConversation(frame: Frame, sessionId: string): boolean {
	return (
		frame.method === "v4/conversation/frame" &&
		isRecord(frame.params) &&
		frame.params.topic === `conversation/${sessionId}`
	);
}
async function confirmCancellation(peer: PublicPeer, sessionId: string): Promise<void> {
	const since = peer.seen.length;
	await peer.request("v4/conversation/subscribe", {
		topic: `conversation/${sessionId}`,
		connectionId: `cancel-confirmation-${crypto.randomUUID()}`,
		clientMode: "desktop-continuous",
	});
	const frame = await peer.next(
		frame =>
			isConversation(frame, sessionId) &&
			conversationTopicFrameSchema.parse(frame.params).payload.kind === "snapshot",
		since,
	);
	const payload = conversationTopicFrameSchema.parse(frame.params).payload;
	if (payload.kind !== "snapshot") throw new Error("Native confirmation snapshot missing");
	const confirmation = payload.snapshot.pendingInteractions.find(
		interaction => interaction.payload.kind === "userInput",
	);
	expect(confirmation).toBeDefined();
	expect(
		await peer.request("v4/command", {
			commandId: crypto.randomUUID(),
			clientId: "omp-spec-acceptance",
			sessionId,
			type: "resolveInteraction",
			payload: { interactionId: confirmation!.interactionId, answer: { optionId: "yes" } },
			issuedAt: Date.now(),
		}),
	).toMatchObject({ status: "accepted" });
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
		"modelRoles:\n  default: spec-fixture/chat-a\n  smol: spec-fixture/chat-a\ntools:\n  xdev: false\nasync:\n  enabled: false\ntask:\n  batch: true\n  isolation:\n    enabled: true\nteam:\n  members:\n    - spec-fixture/chat-a\n    - spec-fixture/chat-b\n",
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
async function absent(cwd: string, relative: string): Promise<void> {
	const stat = await fs.lstat(path.join(cwd, relative)).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	expect(stat).toBeUndefined();
}
function commandFrom(text: string, command: string): string {
	const line = text.split("\n").find(value => value.startsWith(`/dev ${command} `));
	if (!line) throw new Error(`No public /dev ${command} decision in ${text}`);
	return line;
}

async function assertNativeTransition(
	provider: ProviderFixture,
	cwd: string,
	ordinal: number,
	producer: string,
	successor: string,
	formalPath: string,
	decision: string,
) {
	expect(provider.handoffs).toHaveLength(ordinal);
	const handoff = provider.handoffs[ordinal - 1]!;
	expect(rolePayload(handoff)?.specDrivenRole).toBe(producer);
	const incoming = handoff.messages.map(message => contentText(message.content)).join("\n");
	const [file, pointer] = formalPath.split("#");
	const bytes = await fs.readFile(path.join(cwd, file!), "utf8");
	const formal = pointer === "/solution" ? JSON.stringify(JSON.parse(bytes).solution) : bytes;
	expect(incoming.includes(formal) || incoming.includes(JSON.stringify(formal).slice(1, -1))).toBe(true);
	expect(incoming).toContain(decision);
	const successorRequest = provider.requests.find(
		request => (request.tools?.length ?? 0) > 0 && rolePayload(request)?.specDrivenRole === successor,
	);
	expect(successorRequest).toBeDefined();
	expect(provider.requests.indexOf(successorRequest!)).toBeGreaterThan(provider.requests.indexOf(handoff));
	const successorInput = successorRequest!.messages
		.filter(message => message.role === "user")
		.map(message => contentText(message.content))
		.join("\n");
	expect(successorInput).toContain(`${HANDOFF_MARKER}-${ordinal}`);
	const nativeBody = `${respond(handoff).text}\n\nNative response identity: ${HANDOFF_MARKER}-${ordinal}`;
	expect(successorInput.includes(nativeBody) || successorInput.includes(JSON.stringify(nativeBody).slice(1, -1))).toBe(
		true,
	);
	expect(successorInput.includes(formal) || successorInput.includes(JSON.stringify(formal).slice(1, -1))).toBe(true);
	const names = ["requirements-to-solution", "solution-to-plan", "plan-to-execution"];
	const persisted = await fs.readFile(
		path.join(cwd, `openspec/changes/${CHANGE_ID}/handoffs/${names[ordinal - 1]}.md`),
		"utf8",
	);
	expect(persisted.trim()).toBe(nativeBody.trim());
}

async function assertFixedRoleSystems(requests: ModelRequest[]) {
	const controlled = loadSpecDrivenSkill as (
		source: "superpowers" | "jch",
		name: string,
		options: { role: "requirements" | "planner" | "executor" },
	) => Promise<Skill>;
	const required = {
		requirements: [
			["superpowers", "brainstorming"],
			["jch", "jch-grill-me"],
		],
		planner: [["superpowers", "writing-plans"]],
		executor: [
			["superpowers", "subagent-driven-development"],
			["superpowers", "test-driven-development"],
			["superpowers", "systematic-debugging"],
			["superpowers", "verification-before-completion"],
			["superpowers", "requesting-code-review"],
		],
	} as const;
	const systems = new Map<string, string>();
	for (const role of ["requirements", "solution", "planner", "executor"] as const) {
		const turns = requests.filter(
			request => (request.tools?.length ?? 0) > 0 && rolePayload(request)?.specDrivenRole === role,
		);
		expect(turns.length).toBeGreaterThan(0);
		for (const request of turns) {
			const system = request.messages
				.filter(message => message.role === "system")
				.map(message => contentText(message.content))
				.join("\n");
			expect(system).not.toContain(REQUIREMENT);
			expect(system).not.toContain(HANDOFF_MARKER);
			systems.set(role, system);
			if (role === "solution") {
				// No upstream skill is invented for this actor: its fixed authority
				// organizes native OMP Team and keeps the user in charge of selection.
				expect(system).toMatch(/(?:existing|native|原生).*Team|Team.*(?:existing|native|原生)/isu);
				expect(system).toMatch(/candidate|候选/iu);
				expect(system).toMatch(/(?:user|用户).*(?:select|choose|选择)|(?:selection|选择).*(?:user|用户)/isu);
				continue;
			}
			for (const [source, name] of required[role]) {
				const skill = await controlled(source, name, { role });
				const body = (await fs.readFile(skill.filePath, "utf8"))
					.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
					.trim();
				expect(body.length).toBeGreaterThan(100);
				expect(system).toContain(body);
			}
		}
	}
	expect(new Set(systems.values()).size).toBe(4);
}

async function assertNativeImplementationMethods(requests: ModelRequest[]) {
	const names = [
		"subagent-driven-development",
		"test-driven-development",
		"systematic-debugging",
		"verification-before-completion",
		"requesting-code-review",
	];
	const methods = await Promise.all(
		names.map(async name => {
			const skill = await loadSpecDrivenSkill("superpowers", name, { role: "executor" });
			const body = (await fs.readFile(skill.filePath, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim();
			return { name, body, allowed: name !== "subagent-driven-development" && name !== "requesting-code-review" };
		}),
	);
	const children = requests.filter(
		request =>
			(request.tools?.length ?? 0) > 0 &&
			request.messages.some(
				message => message.role === "user" && /OMP_SPEC_CHILD_TASK T00[23]/u.test(contentText(message.content)),
			) &&
			rolePayload(request)?.specDrivenRole !== "executor",
	);
	expect(children.length).toBeGreaterThan(0);
	for (const request of children) {
		const system = request.messages
			.filter(message => message.role === "system")
			.map(message => contentText(message.content))
			.join("\n");
		const methodInventory = [...system.matchAll(/^name:\s*(.+)$/gmu)].map(match => match[1]!.trim());
		expect(methodInventory.filter(name => names.includes(name)).sort()).toEqual(
			methods
				.filter(method => method.allowed)
				.map(method => method.name)
				.sort(),
		);
		for (const { body, allowed } of methods) {
			if (allowed) expect(system).toContain(body);
			else expect(system).not.toContain(body);
		}
	}
}

describe("spec-driven actual OMP public entry", () => {
	for (const failure of ["empty", "provider-error", "save-error", "version-drift"] as const) {
		test(
			`native handoff ${failure} blocks solution and native Team successor admission`,
			async () => {
				await using root = await TempDir.create("@omp-spec-handoff-failure-");
				let cwd = "";
				await using provider = createProviderFixture({
					async handoff(request) {
						if (failure === "empty") return { text: "" };
						if (failure === "provider-error") throw new Error("Injected native handoff transport failure");
						if (failure === "version-drift")
							await fs.appendFile(
								path.join(cwd, `openspec/changes/${CHANGE_ID}/proposal.md`),
								"\nExternal requirements change while native handoff is in flight.\n",
							);
						return { text: `${respond(request).text}\n${HANDOFF_MARKER}-1` };
					},
				});
				const config = await fixture(root, provider.baseUrl);
				cwd = config.cwd;
				await using peer = new PublicPeer(cwd, config.env, provider);
				await peer.ready();
				const session = await peer.create(cwd);
				const first = await peer.send(session, `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
				const specification = await peer.phase(session, "awaiting-specification", first);
				if (failure === "save-error")
					// A directory at the exact durable destination makes native result
					// persistence fail without mocking filesystem APIs or actor code.
					await fs.mkdir(path.join(cwd, `openspec/changes/${CHANGE_ID}/handoffs/requirements-to-solution.md`), {
						recursive: true,
					});
				const since = await peer.send(session, commandFrom(specification.text, "confirm-spec"));
				const stopped = await peer.stopped(session, since);
				if (!provider.handoffs.length)
					throw new Error(`Command stopped without native handoff ingress: ${bounded(stopped)}`);
				expect(provider.handoffs.length).toBeGreaterThan(0);
				expect(stopped.state.paused === true || ["blocked", "failed"].includes(String(stopped.state.phase))).toBe(
					true,
				);
				expect(provider.requests.filter(request => rolePayload(request)?.specDrivenRole === "solution")).toEqual(
					[],
				);
				expect(
					provider.requests.some(request => JSON.stringify(request.tools ?? []).includes("noViableProposal")),
				).toBe(false);
				await absent(cwd, `openspec/changes/${CHANGE_ID}/solution.md`);
				await absent(cwd, `openspec/changes/${CHANGE_ID}/plan.md`);
				await absent(cwd, IMPLEMENTATION_PATH);
				if (failure !== "provider-error") expect(provider.failures).toEqual([]);
				else
					expect(
						provider.failures.some(value => value.includes("Injected native handoff transport failure")),
					).toBe(true);
			},
			GATE_BUDGET,
		);
	}

	for (const interruption of ["pause", "cancel"] as const) {
		test(
			`native handoff ${interruption} rejects late generation and ${interruption === "pause" ? "reuses live producer on resume" : "never admits a successor"}`,
			async () => {
				await using root = await TempDir.create("@omp-spec-handoff-interrupt-");
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				await using provider = createProviderFixture({
					async handoff(request, ordinal) {
						if (ordinal === 1) {
							entered.resolve();
							await release.promise;
						}
						return { text: `${respond(request).text}\n${HANDOFF_MARKER}-${ordinal}` };
					},
				});
				const config = await fixture(root, provider.baseUrl);
				await using peer = new PublicPeer(config.cwd, config.env, provider);
				try {
					await peer.ready();
					const session = await peer.create(config.cwd);
					const first = await peer.send(session, `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
					const specification = await peer.phase(session, "awaiting-specification", first);
					const confirming = await peer.send(session, commandFrom(specification.text, "confirm-spec"));
					// A non-consuming observer cannot steal the interrupt command's
					// status row from phase(), which tracks each published row once.
					const completed = peer.stopped(session, confirming);
					// No sleeps or shorter IO timeouts: fail on the actual paused or
					// successor-gate result, with its real refusal text, not a waiting row.
					const ingress = await Promise.race([
						entered.promise.then(() => ({ kind: "handoff" as const })),
						completed.then(stopped => ({ kind: "completed" as const, stopped })),
					]);
					if (ingress.kind !== "handoff")
						throw new Error(`Command stopped before native handoff ingress: ${bounded(ingress.stopped)}`);
					const interrupting = await peer.send(session, `/dev ${interruption}`);
					if (interruption === "cancel") await confirmCancellation(peer, session);
					const paused = await peer.phase(
						session,
						interruption === "cancel" ? "cancelled" : ["team", "awaiting-specification"],
						interrupting,
						true,
						true,
					);
					expect(paused.state.paused).toBe(true);
					expect(Number(paused.state.generation)).toBeGreaterThan(Number(specification.state.generation));
					const ordinary = await peer.create(config.cwd);
					const ordinaryStart = await peer.send(
						ordinary,
						"/goal set OMP_SPEC_ORDINARY_CONTROL: exercise normal read, write and native Task while the other session is interrupted.",
					);
					await peer.next(
						frame =>
							isConversation(frame, ordinary) &&
							textValues(frame).some(text => text.includes("OMP_SPEC_ORDINARY_CONTROL_DONE")),
						ordinaryStart,
					);
					expect(await fs.readFile(path.join(config.cwd, "ordinary-note.txt"), "utf8")).toBe(
						"ordinary session remains writable\n",
					);
					const ordinaryRequests = provider.requests.filter(request =>
						request.messages.some(
							message =>
								message.role === "user" && contentText(message.content).includes("OMP_SPEC_ORDINARY_CONTROL"),
						),
					);
					expect(ordinaryRequests.length).toBeGreaterThan(0);
					for (const request of ordinaryRequests) {
						expect(rolePayload(request)).toBeUndefined();
						expect(request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "spec_task")).toBe(
							false,
						);
						expect(request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "spec_verify")).toBe(
							false,
						);
					}
					expect(
						ordinaryRequests.some(request =>
							request.messages.some(
								message =>
									message.role === "assistant" &&
									(message.tool_calls ?? []).some(
										call =>
											isRecord(call) &&
											isRecord(call.function) &&
											typeof call.function.name === "string" &&
											call.function.name.replace(/^_/u, "") === "goal",
									),
							),
						),
					).toBe(true);
					release.resolve();
					const statusStart = await peer.send(session, "/dev status");
					const late = await peer.phase(
						session,
						interruption === "cancel" ? "cancelled" : ["team", "awaiting-specification"],
						statusStart,
						true,
						true,
					);
					expect(late.state.generation).toBe(paused.state.generation);
					expect(provider.requests.filter(request => rolePayload(request)?.specDrivenRole === "solution")).toEqual(
						[],
					);
					await absent(config.cwd, `openspec/changes/${CHANGE_ID}/solution.md`);
					if (interruption === "pause") {
						const resuming = await peer.send(session, "/dev resume");
						await peer.phase(session, "awaiting-choice", resuming);
						expect(provider.handoffs).toHaveLength(2);
						const successor = provider.requests.find(
							request => (request.tools?.length ?? 0) > 0 && rolePayload(request)?.specDrivenRole === "solution",
						);
						expect(successor).toBeDefined();
						const input = successor!.messages.map(message => contentText(message.content)).join("\n");
						expect(input).toContain(`${HANDOFF_MARKER}-2`);
						expect(input).not.toContain(`${HANDOFF_MARKER}-1`);
					}
					expect(provider.failures).toEqual([]);
				} finally {
					release.resolve();
				}
			},
			GATE_BUDGET,
		);
	}

	for (const { executionMode, markdown } of [
		{ executionMode: "normal", markdown: false },
		{ executionMode: "goal", markdown: false },
		{ executionMode: "normal", markdown: true },
	] as const)
		test(
			`strict decisions drive native Team, real TDD, task commits, independent reviews, final entry and authorized archive${markdown ? " with existing Markdown authority" : executionMode === "goal" ? " with native Goal continuation" : ""}`,
			async () => {
				await using root = await TempDir.create("@omp-spec-public-");
				const nativeEntered = new Set<string>();
				const parallelReady = Promise.withResolvers<void>();
				await using provider = createProviderFixture({
					async observe(request) {
						const user = request.messages
							.filter(message => message.role === "user")
							.map(message => contentText(message.content))
							.join("\n");
						if (user.includes("OMP_SPEC_FORBIDDEN_")) {
							const matchedUserIndex = request.messages.findIndex(
								message =>
									message.role === "user" && contentText(message.content).includes("OMP_SPEC_FORBIDDEN_"),
							);
							const matched = contentText(request.messages[matchedUserIndex]?.content);
							const offset = matched.indexOf("OMP_SPEC_FORBIDDEN_");
							const labelRequest = request.messages.some(
								message =>
									message.role === "system" &&
									contentText(message.content).startsWith(
										"# Task\nLabel the delegated work in the next user message:",
									),
							);
							throw new Error(
								`Rejected native task reached provider ingress: ${JSON.stringify({
									tools: request.tools?.map(tool => tool.function?.name) ?? [],
									role: rolePayload(request)?.specDrivenRole ?? null,
									matchedUserIndex,
									context: matched.slice(Math.max(0, offset - 100), offset + 180),
									delegatedLabel: labelRequest
										? contentText(
												request.messages.findLast(message => message.role === "user")?.content,
											).slice(0, 240)
										: null,
								})}`,
							);
						}
						if (!request.tools?.length) return;
						const child = user.match(/OMP_SPEC_CHILD_TASK (T00[23])/u);
						if (!child) return;
						nativeEntered.add(child[1]!);
						if (nativeEntered.size === 2) parallelReady.resolve();
						await parallelReady.promise;
					},
				});
				const config = await fixture(root, provider.baseUrl);
				const authorityPath = "docs/requirements/greeting.md";
				const oldBehavior =
					"greet(name) returns Hello, <name>! without normalizing outer whitespace or empty names.";
				const preservedIntro =
					"# Greeting requirements\n\nThis document remains the sole long-term greeting authority.\n\n";
				const preservedScenarios =
					'### Scenario: Named greeting\nCalling greet("Ada") returns "Hello, Ada!".\n\n### Scenario: Internal whitespace\nCalling greet("Ada  Lovelace") returns "Hello, Ada  Lovelace!".\n';
				const preservedUnrelated =
					"\n## Release notes\n\nKeep the existing release cadence and operator instructions unchanged.\n";
				const originalAuthority = `${preservedIntro}## R001 Greeting\n${oldBehavior}\n\n${preservedScenarios}${preservedUnrelated}`;
				if (markdown) {
					await fs.mkdir(path.join(config.cwd, "docs/requirements"), { recursive: true });
					await fs.writeFile(path.join(config.cwd, authorityPath), originalAuthority);
					await git(config.cwd, config.env, ["add", authorityPath]);
					await git(config.cwd, config.env, [
						"-c",
						"core.hooksPath=",
						"commit",
						"-m",
						"Fixture existing Markdown authority",
					]);
				}
				// Unrelated staged, unstaged and new user material must survive workflow publication.
				await fs.writeFile(path.join(config.cwd, "user-staged.txt"), "user staged\n");
				await git(config.cwd, config.env, ["add", "user-staged.txt"]);
				await fs.appendFile(path.join(config.cwd, "baseline.txt"), "user unstaged\n");
				await fs.writeFile(path.join(config.cwd, "user-new.txt"), "user untracked\n");
				const baseline = await git(config.cwd, config.env, ["rev-parse", "HEAD"]);
				await using peer = new PublicPeer(config.cwd, config.env, provider);
				await peer.ready();
				const session = await peer.create(config.cwd);
				const first = await peer.send(
					session,
					`/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT} Authorize specification sync and archive only after my final acceptance.`,
				);
				const specification = await peer.phase(session, "awaiting-specification", first);
				const runtimeDirs = (await fs.readdir(path.join(config.cwd, ".omp/spec-sessions"))).filter(
					name => name !== ".gitignore",
				);
				expect(runtimeDirs).toHaveLength(1);
				const statePath = `.omp/spec-sessions/${runtimeDirs[0]}/state.json`;
				await absent(config.cwd, `openspec/changes/${CHANGE_ID}/requirements.md`);
				if (markdown) {
					const requirementsInput = provider.requests
						.map(rolePayload)
						.find(payload => payload?.specDrivenRole === "requirements")!.input;
					expect(isRecord(requirementsInput.originals)).toBe(true);
					const mapped = requirementsInput.originals as Record<string, unknown>;
					expect(mapped.version).toBeString();
					expect(JSON.stringify(mapped.files)).toContain(authorityPath);
					expect(JSON.stringify(mapped.entries)).toContain(oldBehavior);
					const sourceApproval = JSON.parse(
						await fs.readFile(
							path.join(config.cwd, `openspec/changes/${CHANGE_ID}/checks/source-approval.json`),
							"utf8",
						),
					);
					expect(sourceApproval.sourceMap.version).toBe(mapped.version);
					expect(sourceApproval.sourcePatches).toHaveLength(1);
					expect(sourceApproval.sourcePatches[0].operation).toBe("modify");
					const source = sourceApproval.sourceMap.entries.find(
						(entry: { id: string }) => entry.id === sourceApproval.sourcePatches[0].sourceId,
					);
					expect(source.path).toBe(authorityPath);
					expect(source.headingPath.at(-1)).toBe("R001 Greeting");
					expect(source.original).toContain(oldBehavior);
				}
				expect(
					provider.requests.some(request => JSON.stringify(request.tools ?? []).includes("noViableProposal")),
				).toBe(false);
				expect(await git(config.cwd, config.env, ["rev-parse", "HEAD"])).toBe(baseline);
				await absent(config.cwd, IMPLEMENTATION_PATH);
				await absent(config.cwd, TEST_PATH);
				await absent(config.cwd, `openspec/changes/${CHANGE_ID}/design.md`);
				await absent(config.cwd, `openspec/changes/${CHANGE_ID}/tasks.md`);
				const stale = await peer.send(session, "/dev confirm-spec obsolete-version");
				const rejected = await peer.phase(session, "awaiting-specification", stale);
				expect(rejected.state.specificationVersion).toBe(specification.state.specificationVersion);
				expect(
					provider.requests.some(request => JSON.stringify(request.tools ?? []).includes("noViableProposal")),
				).toBe(false);
				expect(rejected.state.planVersion).toBeUndefined();
				await absent(config.cwd, IMPLEMENTATION_PATH);
				await absent(config.cwd, TEST_PATH);
				await absent(config.cwd, `openspec/changes/${CHANGE_ID}/plan.md`);
				expect(await git(config.cwd, config.env, ["rev-parse", "HEAD"])).toBe(baseline);
				const discussionStart = await peer.send(session, commandFrom(specification.text, "confirm-spec"));
				const choice = await peer.phase(session, "awaiting-choice", discussionStart);
				await assertNativeTransition(
					provider,
					config.cwd,
					1,
					"requirements",
					"solution",
					`openspec/changes/${CHANGE_ID}/proposal.md`,
					String(specification.state.specificationVersion),
				);
				expect(choice.state.runId).toBeString();
				expect(
					provider.requests.filter(request => JSON.stringify(request.tools ?? []).includes("noViableProposal"))
						.length,
				).toBeGreaterThanOrEqual(2);
				expect(choice.state.candidates).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ adoptable: true, reviewSucceeded: true, recheckSucceeded: true }),
					]),
				);
				const planStart = await peer.send(session, commandFrom(choice.text, "choose"));
				const plan = await peer.phase(session, "awaiting-plan", planStart);
				await assertNativeTransition(
					provider,
					config.cwd,
					2,
					"solution",
					"planner",
					`${statePath}#/solution`,
					commandFrom(choice.text, "choose").split(" ").at(-1)!,
				);
				await absent(config.cwd, IMPLEMENTATION_PATH);
				await absent(config.cwd, TEST_PATH);
				expect(await git(config.cwd, config.env, ["rev-parse", "HEAD"])).toBe(baseline);
				const planNames = await fs.readdir(path.join(config.cwd, "docs/superpowers/plans"));
				expect(planNames).toHaveLength(1);
				const planPath = `docs/superpowers/plans/${planNames[0]}`;
				expect(await fs.readFile(path.join(config.cwd, planPath), "utf8")).toContain("T001");
				await absent(config.cwd, `openspec/changes/${CHANGE_ID}/plan.md`);
				await absent(config.cwd, `openspec/changes/${CHANGE_ID}/solution.md`);
				const runtimeState = JSON.parse(await fs.readFile(path.join(config.cwd, statePath), "utf8"));
				expect(runtimeState.solution.candidateId).toBe(runtimeState.status.selection.candidateId);
				expect(runtimeState.teamResult.runId).toBe(runtimeState.solution.runId);
				expect(runtimeState.plan.tasks[0].id).toBe("T001");
				expect(runtimeState.plan.path).toBe(planPath);
				expect(
					new Bun.CryptoHasher("sha256").update(await fs.readFile(path.join(config.cwd, planPath))).digest("hex"),
				).toBe(runtimeState.plan.documentVersion);
				const visible = await git(config.cwd, config.env, ["status", "--porcelain", "--untracked-files=all"]);
				expect(visible).not.toContain(".omp/spec-sessions/");
				const badPlan = await peer.send(session, "/dev confirm-plan obsolete-version");
				await peer.phase(session, "awaiting-plan", badPlan);
				await absent(config.cwd, IMPLEMENTATION_PATH);
				const executing = await peer.send(
					session,
					`${commandFrom(plan.text, "confirm-plan")}${executionMode === "goal" ? " --goal" : ""}`,
				);
				const acceptance = await peer.phase(session, "awaiting-acceptance", executing);
				const acceptedState = JSON.parse(await fs.readFile(path.join(config.cwd, statePath), "utf8"));
				expect(acceptedState.status.executionMode).toBe(executionMode);
				expect([...nativeEntered].sort()).toEqual(["T002", "T003"]);
				const executionRequests = provider.requests.filter(
					request => rolePayload(request)?.specDrivenRole === "executor",
				);
				const executionHistory = executionRequests.at(-1)!;
				for (const reason of ["unknown", "non-ready", "overlap"]) {
					const attempted = executionHistory.messages
						.flatMap(message => message.tool_calls ?? [])
						.find(call => {
							if (!isRecord(call) || !isRecord(call.function) || typeof call.function.arguments !== "string")
								return false;
							const args: unknown = JSON.parse(call.function.arguments);
							return isRecord(args) && args.context === `OMP_SPEC_REJECT_${reason}`;
						});
					if (!isRecord(attempted)) throw new Error(`No public native ${reason} admission probe`);
					const response = executionHistory.messages.find(
						message => message.role === "tool" && message.tool_call_id === attempted.id,
					);
					expect(contentText(response?.content)).toMatch(
						/reject|unknown|ready|active|bound|overlap|already|cannot|invalid|refus|error/iu,
					);
				}
				if (executionMode === "goal")
					expect(
						executionRequests.some(request =>
							request.messages.some(
								message =>
									message.role === "user" && contentText(message.content).includes("Continue active goal."),
							),
						),
					).toBe(true);
				else
					expect(
						executionRequests
							.flatMap(request => request.tools ?? [])
							.some(tool => tool.function?.name.replace(/^_/u, "") === "goal"),
					).toBe(false);
				await assertNativeTransition(
					provider,
					config.cwd,
					3,
					"planner",
					"executor",
					planPath,
					String(plan.state.planVersion),
				);
				await assertFixedRoleSystems(provider.requests);
				await assertNativeImplementationMethods(provider.requests);
				const published = await git(config.cwd, config.env, ["log", "--format=%H", `${baseline}..HEAD`]);
				expect(published.split("\n").length).toBeGreaterThanOrEqual(1);
				const committedFiles = (
					await git(config.cwd, config.env, ["diff", "--name-only", `${baseline}..HEAD`])
				).split("\n");
				expect(committedFiles).toContain(IMPLEMENTATION_PATH);
				expect(committedFiles).toContain(TEST_PATH);
				expect(committedFiles).not.toContain("user-staged.txt");
				expect(committedFiles).not.toContain("user-new.txt");
				expect(committedFiles).not.toContain("baseline.txt");
				expect(await git(config.cwd, config.env, ["diff", "--cached", "--name-only"])).toBe("user-staged.txt");
				expect(await fs.readFile(path.join(config.cwd, "baseline.txt"), "utf8")).toContain("user unstaged");
				expect(await fs.readFile(path.join(config.cwd, "user-new.txt"), "utf8")).toBe("user untracked\n");
				// Auxiliary task labels quote role input but do not run a reviewer.
				const reviewRequests = provider.requests.filter(
					request =>
						rolePayload(request)?.specDrivenRole === "reviewer" &&
						request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "yield"),
				);
				const reviewerInputs = reviewRequests.map(rolePayload);
				for (const kind of ["requirements", "plan", "task", "overall"]) {
					const inputs = reviewerInputs.filter(payload => payload?.input.kind === kind);
					expect(inputs.length).toBeGreaterThan(0);
					// Multiple HTTP rounds are tool continuations, not additional review seats.
					const initial = reviewRequests.filter(
						request =>
							rolePayload(request)?.input.kind === kind &&
							request.messages.every(message => message.role !== "tool"),
					);
					expect(initial).toHaveLength(kind === "task" ? 3 : 1);
				}
				const taskReview = reviewerInputs.find(payload => payload?.input.kind === "task")!;
				const taskEvidence = JSON.stringify(taskReview.input);
				expect(taskEvidence).toContain("Hello, Ada!");
				expect(taskEvidence).toContain("3 pass");
				expect(taskEvidence).toMatch(/3 fail|Expected:|expect\\?\(received/u);
				expect(taskEvidence).toContain("toolCallId");
				expect(taskEvidence).toContain("base");
				expect(taskEvidence).toContain("head");
				expect(taskEvidence).toContain("review");
				const ranges = taskReview.input.commits;
				expect(Array.isArray(ranges)).toBe(true);
				if (!Array.isArray(ranges) || !ranges.length) throw new Error("Task review has no actual commit range");
				for (const range of ranges) {
					if (
						!isRecord(range) ||
						typeof range.base !== "string" ||
						typeof range.head !== "string" ||
						typeof range.reviewPackage !== "string"
					)
						throw new Error("Invalid actual review-package binding");
					expect(range.base).toMatch(/^[a-f0-9]{40}$/u);
					expect(range.head).toMatch(/^[a-f0-9]{40}$/u);
					expect(range.head).not.toBe(range.base);
					const packageContent = range.reviewPackage;
					expect(packageContent).toContain(IMPLEMENTATION_PATH);
					expect(packageContent).toContain(TEST_PATH);
					expect(packageContent).toContain("export function greet");
					expect(packageContent).not.toContain("user-staged.txt");
					expect(packageContent).not.toContain("user-new.txt");
				}
				const overall = reviewerInputs.find(payload => payload?.input.kind === "overall")!;
				expect(JSON.stringify(overall.input)).toContain("real-bun-entry");
				expect(JSON.stringify(overall.input)).toContain("3 pass");
				// A separate observation through the approved executable entry, not a model claim.
				const actual = await run(config.cwd, config.env, [process.execPath, "test", TEST_PATH]);
				expect(actual.exitCode).toBe(0);
				expect(`${actual.stdout}\n${actual.stderr}`).toContain("3 pass");
				for (const file of ["test/greeting-empty.test.ts", "test/greeting-spacing.test.ts"]) {
					const result = await run(config.cwd, config.env, [process.execPath, "test", file]);
					expect(result.exitCode).toBe(0);
					expect(`${result.stdout}\n${result.stderr}`).toContain("3 pass");
				}
				const verificationPath = path.join(config.cwd, `openspec/changes/${CHANGE_ID}/verification.md`);
				const verification = await fs.readFile(verificationPath, "utf8");
				const evidenceLinks = [...verification.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]!);
				expect(evidenceLinks.length).toBeGreaterThan(0);
				for (const link of evidenceLinks) {
					expect(path.isAbsolute(link)).toBe(false);
					expect(link.startsWith("../")).toBe(false);
					expect(
						(await fs.readFile(path.resolve(path.dirname(verificationPath), link), "utf8")).length,
					).toBeGreaterThan(0);
				}
				expect(await Bun.file(path.join(config.cwd, `openspec/changes/${CHANGE_ID}/proposal.md`)).exists()).toBe(
					true,
				);
				if (markdown)
					expect(await fs.readFile(path.join(config.cwd, authorityPath), "utf8")).toBe(originalAuthority);
				await absent(config.cwd, "openspec/changes/archive");
				await absent(config.cwd, "openspec/specs/greeting/spec.md");
				const badAcceptance = await peer.send(session, "/dev accept obsolete-version");
				await peer.phase(session, "awaiting-acceptance", badAcceptance);
				await absent(config.cwd, "openspec/specs/greeting/spec.md");
				let currentAcceptance = acceptance;
				if (executionMode === "normal" && !markdown) {
					// Explicit external input mutation is fault injection, not a fabricated workflow record.
					await fs.appendFile(
						path.join(config.cwd, TEST_PATH),
						'\ntest("external input invalidates acceptance", () => expect(greet?.(" Ada ")).toBe("BROKEN"));\n',
					);
					const staleAccept = await peer.send(session, commandFrom(acceptance.text, "accept"));
					const invalidated = await peer.stopped(session, staleAccept);
					expect(invalidated.state.phase).not.toBe("completed");
					expect(invalidated.state.acceptanceVersion).not.toBe(acceptance.state.acceptanceVersion);
					expect(invalidated.state.specificationVersion).toBe(acceptance.state.specificationVersion);
					expect(invalidated.state.planVersion).toBe(acceptance.state.planVersion);
					await absent(config.cwd, "openspec/specs/greeting/spec.md");
					expect((await fs.readFile(verificationPath, "utf8")).length).toBeGreaterThan(0);
					const ordinary = await peer.create(config.cwd);
					const ordinaryStart = await peer.send(
						ordinary,
						"OMP_SPEC_ORDINARY_CONTROL during invalidated workflow recovery",
					);
					await peer.next(
						frame =>
							isConversation(frame, ordinary) &&
							textValues(frame).some(text => text.includes("OMP_SPEC_ORDINARY_CONTROL_DONE")),
						ordinaryStart,
					);
					const resume = await peer.send(session, "/dev resume");
					currentAcceptance = await peer.phase(session, "awaiting-acceptance", resume);
					expect(currentAcceptance.state.acceptanceVersion).not.toBe(acceptance.state.acceptanceVersion);
					expect(await fs.readFile(path.join(config.cwd, TEST_PATH), "utf8")).toBe(BEHAVIOR_TEST);
					const repairedReport = await fs.readFile(verificationPath, "utf8");
					const rawLinks = [...repairedReport.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]!);
					const actualEvidence = (
						await Promise.all(
							rawLinks.map(link => fs.readFile(path.resolve(path.dirname(verificationPath), link), "utf8")),
						)
					).join("\n");
					expect(actualEvidence).toContain("external input invalidates acceptance");
					expect(actualEvidence).toContain("BROKEN");
					expect(actualEvidence).toContain("3 pass");
					const oldAgain = await peer.send(session, commandFrom(acceptance.text, "accept"));
					await peer.phase(session, "awaiting-acceptance", oldAgain);
					await absent(config.cwd, "openspec/specs/greeting/spec.md");
				}
				const final = await peer.send(session, commandFrom(currentAcceptance.text, "accept"));
				await peer.phase(session, "completed", final);
				if (markdown) {
					const authority = await fs.readFile(path.join(config.cwd, authorityPath), "utf8");
					const releaseOffset = originalAuthority.indexOf("## Release notes");
					expect(authority).toBe(
						originalAuthority.slice(0, releaseOffset).replace(oldBehavior, REQUIREMENT) +
							'\n### Scenario: Outer whitespace\nCalling greet("  Ada  ") returns "Hello, Ada!".\n\n### Scenario: Blank name\nCalling greet("  ") returns "Hello, world!".\n' +
							originalAuthority.slice(releaseOffset),
					);
					expect(authority).toContain(preservedIntro);
					expect(authority).toContain(preservedScenarios);
					expect(authority).toContain(preservedUnrelated);
					expect(await fs.readdir(path.join(config.cwd, "docs/requirements"))).toEqual(["greeting.md"]);
					await absent(config.cwd, "openspec/specs/greeting/spec.md");
				} else {
					expect(await fs.readFile(path.join(config.cwd, "openspec/specs/greeting/spec.md"), "utf8")).toContain(
						"Normalized greeting",
					);
				}
				await absent(config.cwd, `openspec/changes/${CHANGE_ID}/proposal.md`);
				const archive = await fs.readdir(path.join(config.cwd, "openspec/changes/archive"));
				expect(archive.filter(name => name.endsWith(`-${CHANGE_ID}`))).toHaveLength(1);
				const archived = path.join(
					config.cwd,
					"openspec/changes/archive",
					archive.find(name => name.endsWith(`-${CHANGE_ID}`))!,
				);
				for (const file of [
					"plan.md",
					"verification.md",
					"checks/requirements.json",
					"checks/orchestration.json",
					...(markdown ? ["checks/source-approval.json"] : []),
					...["requirements-to-solution", "solution-to-plan", "plan-to-execution"].map(
						name => `handoffs/${name}.md`,
					),
				])
					expect((await fs.readFile(path.join(archived, file), "utf8")).length).toBeGreaterThan(0);
				expect(await fs.readFile(path.join(config.cwd, planPath), "utf8")).toBe(
					await fs.readFile(path.join(archived, "plan.md"), "utf8"),
				);
				const archivedReport = await fs.readFile(path.join(archived, "verification.md"), "utf8");
				expect([...archivedReport.matchAll(/\]\(([^)]+)\)/gu)].length).toBeGreaterThan(0);
				for (const match of archivedReport.matchAll(/\]\(([^)]+)\)/gu)) {
					expect(path.isAbsolute(match[1]!)).toBe(false);
					expect((await fs.readFile(path.resolve(archived, match[1]!), "utf8")).length).toBeGreaterThan(0);
				}
				expect(provider.failures).toEqual([]);
			},
			GATE_BUDGET,
		);

	test(
		"amending confirmed requirements invalidates actual prior approval and Team choice without deleting material",
		async () => {
			await using root = await TempDir.create("@omp-spec-stale-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			const baseline = await git(config.cwd, config.env, ["rev-parse", "HEAD"]);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(config.cwd);
			let since = await peer.send(session, `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
			const original = await peer.phase(session, "awaiting-specification", since);
			since = await peer.send(session, commandFrom(original.text, "confirm-spec"));
			const priorChoice = await peer.phase(session, "awaiting-choice", since);
			const countTeam = () =>
				provider.requests.filter(request => JSON.stringify(request.tools ?? []).includes("noViableProposal"))
					.length;
			const teamCount = countTeam();
			since = await peer.send(
				session,
				`/dev amend ${MARKER}: retain the greeting behavior and explicitly exclude networking, logging and side effects.`,
			);
			const changed = await peer.phase(session, "awaiting-specification", since);
			expect(changed.state.specificationVersion).not.toBe(original.state.specificationVersion);
			expect(changed.state.selection).toBeUndefined();
			expect(changed.state.planVersion).toBeUndefined();
			expect(countTeam()).toBe(teamCount);
			since = await peer.send(session, commandFrom(original.text, "confirm-spec"));
			const stale = await peer.phase(session, "awaiting-specification", since);
			expect(stale.state.specificationVersion).toBe(changed.state.specificationVersion);
			expect(countTeam()).toBe(teamCount);
			expect(stale.state.selection).toBeUndefined();
			expect(stale.state.planVersion).toBeUndefined();
			since = await peer.send(session, commandFrom(priorChoice.text, "choose"));
			await peer.phase(session, "awaiting-specification", since);
			expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "planner")).toBe(false);
			await absent(config.cwd, IMPLEMENTATION_PATH);
			expect(await git(config.cwd, config.env, ["rev-parse", "HEAD"])).toBe(baseline);
			expect(
				await fs.readFile(path.join(config.cwd, `openspec/changes/${CHANGE_ID}/proposal.md`), "utf8"),
			).toContain("exclude networking");
			since = await peer.send(session, "/dev cancel");
			await confirmCancellation(peer, session);
			await peer.phase(session, "cancelled", since);
			expect(provider.failures).toEqual([]);
		},
		GATE_BUDGET,
	);

	test(
		"plan-only revision retains approved specification and candidate, rejects stale plans and model command overrides",
		async () => {
			await using root = await TempDir.create("@omp-spec-plan-revision-");
			await using provider = createProviderFixture({ rejectValidationOverride: true });
			const config = await fixture(root, provider.baseUrl);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(config.cwd);
			let since = await peer.send(session, `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
			const specification = await peer.phase(session, "awaiting-specification", since);
			since = await peer.send(session, commandFrom(specification.text, "confirm-spec"));
			const choice = await peer.phase(session, "awaiting-choice", since);
			since = await peer.send(session, commandFrom(choice.text, "choose"));
			const original = await peer.phase(session, "awaiting-plan", since);
			const teamCount = provider.requests.filter(request =>
				JSON.stringify(request.tools ?? []).includes("noViableProposal"),
			).length;
			const requestsBeforeRejection = provider.requests.length;
			await peer.reject(session, "/dev revise-plan stale-plan keep greeting behavior");
			expect(provider.requests).toHaveLength(requestsBeforeRejection);
			const amendment = "Retain all tasks and behavior; explicitly document the no-network implementation boundary.";
			since = await peer.send(session, `/dev revise-plan ${String(original.state.planVersion)} ${amendment}`);
			const revised = await peer.phase(session, "awaiting-plan", since);
			expect(revised.state.planVersion).not.toBe(original.state.planVersion);
			expect(revised.state.specificationVersion).toBe(specification.state.specificationVersion);
			expect(revised.state.selection).toEqual(original.state.selection);
			expect(revised.state.candidates).toEqual(original.state.candidates);
			expect(
				provider.requests.filter(request => JSON.stringify(request.tools ?? []).includes("noViableProposal"))
					.length,
			).toBe(teamCount);
			expect(
				provider.requests
					.map(rolePayload)
					.some(payload => payload?.specDrivenRole === "planner" && payload.input.amendment === amendment),
			).toBe(true);
			await absent(config.cwd, IMPLEMENTATION_PATH);
			since = await peer.send(session, commandFrom(original.text, "confirm-plan"));
			const stale = await peer.phase(session, "awaiting-plan", since);
			expect(stale.state.planVersion).toBe(revised.state.planVersion);
			await absent(config.cwd, IMPLEMENTATION_PATH);
			since = await peer.send(session, commandFrom(revised.text, "confirm-plan"));
			const acceptance = await peer.phase(session, "awaiting-acceptance", since);
			expect(acceptance.state.acceptanceVersion).toBeString();
			const executor = provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === "executor");
			expect(executor).toBeDefined();
			const attempts = executor!.messages.flatMap(message => message.tool_calls ?? []).filter(isRecord);
			const override = attempts.find(call => {
				if (!isRecord(call.function) || typeof call.function.arguments !== "string") return false;
				const args: unknown = JSON.parse(call.function.arguments);
				return isRecord(args) && args.command !== undefined;
			});
			expect(override).toBeDefined();
			const rejection = executor!.messages.find(
				message => message.role === "tool" && message.tool_call_id === override!.id,
			);
			expect(contentText(rejection?.content)).toMatch(
				/reject|unknown|unexpected|invalid|not allowed|must be removed|error/iu,
			);
			// Actor journals use the run's workspace state directory, not PI_CODING_AGENT_DIR.
			// OpenAI wire messages omit isError, so read the actual native journal for this run.
			const nativeResults: Record<string, unknown>[] = [];
			expect(acceptance.state.runId).toBeString();
			const journalDir = path.join(config.cwd, ".omp", "spec-sessions", String(acceptance.state.runId));
			for (const relative of await fs.readdir(journalDir, { recursive: true })) {
				if (!relative.endsWith(".jsonl")) continue;
				for (const line of (await fs.readFile(path.join(journalDir, relative), "utf8")).split("\n")) {
					if (!line.trim()) continue;
					const entry: unknown = JSON.parse(line);
					if (
						isRecord(entry) &&
						entry.type === "message" &&
						isRecord(entry.message) &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === override!.id
					)
						nativeResults.push(entry.message);
				}
			}
			expect(nativeResults.length).toBeGreaterThan(0);
			for (const result of nativeResults)
				expect(result).toMatchObject({ toolCallId: override!.id, toolName: "spec_verify", isError: true });
			const checks = path.join(config.cwd, `openspec/changes/${CHANGE_ID}/checks`);
			const executedProbeRecords: Record<string, unknown>[] = [];
			const approvedValidationRecords: Record<string, unknown>[] = [];
			const inspectRecord = (value: unknown): void => {
				if (Array.isArray(value)) {
					for (const item of value) inspectRecord(item);
				} else if (isRecord(value)) {
					if (value.tool === "spec_verify" && value.toolCallId === override!.id) executedProbeRecords.push(value);
					if (
						value.tool === "spec_verify" &&
						isRecord(value.obligation) &&
						value.obligation.validationId === "greeting-behavior"
					)
						approvedValidationRecords.push(value);
					for (const item of Object.values(value)) inspectRecord(item);
				}
			};
			for (const relative of await fs.readdir(checks, { recursive: true })) {
				if (relative.endsWith(".json"))
					inspectRecord(JSON.parse(await fs.readFile(path.join(checks, relative), "utf8")));
			}
			expect(executedProbeRecords).toEqual([]);
			for (const stage of ["red", "green"] as const) {
				const record = approvedValidationRecords.find(
					value => isRecord(value.obligation) && value.obligation.stage === stage,
				);
				expect(record).toMatchObject({
					args: { command: VALIDATION_COMMAND },
					obligation: { validationId: "greeting-behavior", approvedCommand: VALIDATION_COMMAND, stage },
					result: { status: "completed", isError: false },
				});
				if (!record || !isRecord(record.result)) throw new Error(`Missing native ${stage} validation result`);
				if (stage === "red") expect(record.result.exitCode).toBeGreaterThan(0);
				else expect(record.result.exitCode).toBe(0);
			}
			const validations = attempts.flatMap(call => {
				if (
					!isRecord(call.function) ||
					typeof call.function.arguments !== "string" ||
					typeof call.function.name !== "string" ||
					call.function.name.replace(/^_/u, "") !== "spec_verify"
				)
					return [];
				const args: unknown = JSON.parse(call.function.arguments);
				return isRecord(args) && args.command === undefined ? [args] : [];
			});
			expect(validations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ validationId: "greeting-behavior", stage: "red" }),
					expect.objectContaining({ validationId: "greeting-behavior", stage: "green" }),
				]),
			);
			expect(provider.failures).toEqual([]);
		},
		GATE_BUDGET,
	);

	for (const kind of ["requirements", "plan", "task"] as const) {
		test(
			`${kind} review retains its blocking seat at two repairs and only an explicit extension permits a third repair`,
			async () => {
				await using root = await TempDir.create("@omp-spec-review-extension-");
				await using provider = createProviderFixture({ reviewFailures: { [kind]: 3 } });
				const config = await fixture(root, provider.baseUrl);
				await using peer = new PublicPeer(config.cwd, config.env, provider);
				await peer.ready();
				const session = await peer.create(config.cwd);
				const stoppedPhases = ["requirements-review", "plan-review", "executing", "blocked", "failed"];
				const extend = async (since: number, target: string) => {
					const blocked = await peer.phase(session, stoppedPhases, since, true, true);
					const command = commandFrom(blocked.text, "extend-review");
					const [, , id, revision, limit] = command.split(" ");
					expect(Number(revision)).toBe(2);
					expect(Number(limit)).toBe(2);
					const reviewRequests = () =>
						provider.requests
							.map(rolePayload)
							.filter(
								payload =>
									payload?.specDrivenRole === "reviewer" &&
									isRecord(payload.input.slot) &&
									payload.input.slot.id === id,
							);
					const before = reviewRequests();
					expect(before.some(payload => isRecord(payload?.input.slot) && payload.input.slot.revision === 2)).toBe(
						true,
					);
					const next = await peer.send(session, command);
					const resumed = await peer.phase(session, target, next);
					const after = reviewRequests();
					expect(
						after.some(
							payload =>
								isRecord(payload?.input.slot) &&
								payload.input.slot.revision === 3 &&
								payload.input.slot.repairLimit === 3,
						),
					).toBe(true);
					const count = after.length;
					await peer.reject(session, command);
					expect(reviewRequests()).toHaveLength(count);
					return resumed;
				};
				let since = await peer.send(session, `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
				const specification =
					kind === "requirements"
						? await extend(since, "awaiting-specification")
						: await peer.phase(session, "awaiting-specification", since);
				since = await peer.send(session, commandFrom(specification.text, "confirm-spec"));
				const choice = await peer.phase(session, "awaiting-choice", since);
				since = await peer.send(session, commandFrom(choice.text, "choose"));
				const plan =
					kind === "plan"
						? await extend(since, "awaiting-plan")
						: await peer.phase(session, "awaiting-plan", since);
				await absent(config.cwd, IMPLEMENTATION_PATH);
				since = await peer.send(session, commandFrom(plan.text, "confirm-plan"));
				if (kind === "task") await extend(since, "awaiting-acceptance");
				else await peer.phase(session, "awaiting-acceptance", since);
				expect(await fs.readFile(path.join(config.cwd, IMPLEMENTATION_PATH), "utf8")).toContain(
					"export function greet",
				);
				if (kind === "task") {
					for (const failure of provider.failures)
						expect(failure).toMatch(
							/^Error: Native spec_task checkpoint failed: task review repair allowance is exhausted$/iu,
						);
				} else expect(provider.failures).toEqual([]);
			},
			GATE_BUDGET,
		);
	}

	test(
		"an extended review that still fails remains blocked and replaying its old extension cannot grant another repair",
		async () => {
			await using root = await TempDir.create("@omp-spec-review-still-blocked-");
			await using provider = createProviderFixture({ reviewFailures: { requirements: 4 } });
			const config = await fixture(root, provider.baseUrl);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(config.cwd);
			let since = await peer.send(session, `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
			const phases = ["requirements-review", "blocked", "failed"];
			const original = await peer.phase(session, phases, since, true, true);
			const command = commandFrom(original.text, "extend-review");
			since = await peer.send(session, command);
			const blocked = await peer.phase(session, phases, since, true, true);
			const nextCommand = commandFrom(blocked.text, "extend-review");
			expect(nextCommand.split(" ").slice(-2)).toEqual(["3", "3"]);
			expect(nextCommand.split(" ")[2]).toBe(command.split(" ")[2]);
			expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(false);
			const count = provider.requests.length;
			await peer.reject(session, command);
			expect(provider.requests).toHaveLength(count);
			await absent(config.cwd, IMPLEMENTATION_PATH);
			expect(provider.failures).toEqual([]);
		},
		GATE_BUDGET,
	);

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
