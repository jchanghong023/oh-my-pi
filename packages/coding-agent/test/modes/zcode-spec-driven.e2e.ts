import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import {
	COMMANDS_REQUIRING_BASE_REVISION,
	LegacyProtocol,
	TopicWireFrameAssembler,
	commandAckSchema,
	conversationTopicFrameSchema,
	conversationTopicWireCandidateSchema,
	v4ConversationRowsRangeResultSchema,
	v4ConversationSubscribeResultSchema,
	v4ConversationWorkflowRunsResultSchema,
	v4ConversationWorkflowRunArtifactsResultSchema,
	v4ConversationWorkflowRunArtifactReadResultSchema,
	zcodeWorkflowsRunsResultSchema,
	type OmpSpecAction,
	type OmpSpecDetails,
	type OmpSpecRunBinding,
} from "../../src/modes/zcode/schema";
import * as Baseline from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/index";
import {
	CHANGE_ID,
	HANDOFF_MARKER,
	IMPLEMENTATION_PATH,
	MARKER,
	REQUIREMENT,
	createProviderFixture,
	contentText,
	rolePayload,
	respond,
	type ModelRequest,
} from "../spec-driven/provider-fixture";

// The scenario owns one budget including startup, real native actors, Git and cleanup.
const BUDGET = 600_000;
const executable = Bun.env.OMP_ZCODE_TEST_EXECUTABLE?.trim() ?? Bun.env.OMP_SPEC_TEST_EXECUTABLE?.trim();
if (executable && !path.isAbsolute(executable)) throw new Error("Acceptance executable must be absolute");
const launch = executable ? [executable] : [process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts")];
type Frame = Record<string, unknown>;
const peers = new Set<SpecPeer>();
afterEach(async () => {
	for (const peer of peers) await peer[Symbol.asyncDispose]();
});

/** Public stdio only: no server imports, patched methods, or reconstructed workflow engine. */
class SpecPeer {
	readonly child: Subprocess<"pipe", "pipe", "pipe">;
	readonly frames: Frame[] = [];
	readonly stderr: Promise<string>;
	readonly pump: Promise<void>;
	#changed = Promise.withResolvers<void>();
	#assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
	#failure?: unknown;
	#ended = false;
	#closed = false;
	#id = 0;
	constructor(cwd: string, env: NodeJS.ProcessEnv) {
		const child = (this.child = Bun.spawn(
			[...launch, "app-server", "--stdio", "--surface", "desktop", "--cwd", cwd],
			{
				cwd,
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		));
		peers.add(this);
		this.stderr = (async () => {
			const decoder = new TextDecoder();
			let text = "";
			for await (const chunk of child.stderr) {
				const part = decoder.decode(chunk, { stream: true });
				text += part;
			}
			const part = decoder.decode();
			return text + part;
		})();
		this.pump = (async () => {
			try {
				for await (const frame of readJsonl<unknown>(child.stdout)) {
					if (!isRecord(frame) || "jsonrpc" in frame || "type" in frame || !("method" in frame || "id" in frame))
						throw new Error(`Non-public stdout: ${JSON.stringify(frame)}`);
					if (frame.id !== undefined && frame.method === "session/requestRuntimePreferences")
						this.write({
							id: frame.id,
							result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
						});
					if (frame.id !== undefined && frame.method === "subagents/readRuntimeConfig")
						this.write({ id: frame.id, error: { code: -32601, message: "Use native fixture subagent config" } });
					if (frame.method === "v4/conversation/frame") {
						for (const event of this.#assembler.accept(
							conversationTopicWireCandidateSchema.parse(frame.params),
						)) {
							if (event.kind === "fault") throw new Error(`Conversation assembly: ${event.fault.reasonCode}`);
							this.frames.push({ method: frame.method, params: event.frame });
						}
					} else this.frames.push(frame);
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
	async next(predicate: (frame: Frame) => boolean, since = 0): Promise<Frame> {
		let cursor = since;
		for (;;) {
			if (this.#failure) throw this.#failure;
			for (; cursor < this.frames.length; cursor++) if (predicate(this.frames[cursor]!)) return this.frames[cursor]!;
			if (this.#ended) throw new Error(`App-server EOF before expected output: ${(await this.stderr).slice(-8000)}`);
			await this.#changed.promise;
		}
	}
	async request(method: string, params: unknown): Promise<unknown> {
		const id = `native-spec-${++this.#id}`;
		this.write({ id, method, params });
		const response = await this.next(frame => frame.id === id);
		if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
		return response.result;
	}
	async ready() {
		await this.next(frame => {
			if (frame.method !== "startup/storageState" || !isRecord(frame.params)) return false;
			if (frame.params.phase === "failed") throw new Error(`Storage failed: ${JSON.stringify(frame.params)}`);
			return frame.params.phase === "ready";
		});
	}
	async create(cwd: string) {
		const result = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await this.request("session/create", {
				workspace: workspace(cwd),
				model: { providerId: "spec-fixture", modelId: "chat-a" },
				titleGenerationEnabled: false,
			}),
		);
		return result.session.sessionId;
	}
	async subscribe(
		sessionId: string,
		connectionId: string,
		clientMode: "desktop-continuous" | "web-remote-replayable",
		includeSpecDriven = true,
		base?: { logEpoch: string; seq: number },
	) {
		const since = this.frames.length;
		const result = v4ConversationSubscribeResultSchema.parse(
			await this.request("v4/conversation/subscribe", {
				topic: `conversation/${sessionId}`,
				connectionId,
				clientMode,
				...(includeSpecDriven ? { includeSpecDriven: true } : {}),
				...(base ? { base } : {}),
			}),
		);
		return {
			topic: `conversation/${sessionId}`,
			connectionId,
			subscriptionId: result.ack.subscriptionId,
			since,
			mode: result.ack.mode,
		};
	}
	async send(sessionId: string, text: string, specRun?: OmpSpecRunBinding) {
		const rows = COMMANDS_REQUIRING_BASE_REVISION.has("sendText")
			? v4ConversationRowsRangeResultSchema.parse(
					await this.request("v4/conversation/rowsRange", { sessionId, limit: 1 }),
				)
			: undefined;
		return commandAckSchema.parse(
			await this.request("v4/command", {
				commandId: crypto.randomUUID(),
				clientId: "native-spec-consumer",
				sessionId,
				type: "sendText",
				payload: { text, ...(specRun ? { specRun } : {}) },
				issuedAt: Date.now(),
				...(rows ? { baseRevision: rows.atRevision } : {}),
			}),
		);
	}
	async runs(sessionId: string, runId?: string) {
		return v4ConversationWorkflowRunsResultSchema.parse(
			await this.request("v4/conversation/workflowRuns", {
				sessionId,
				includeSpecDriven: true,
				limit: 64,
				...(runId ? { runId } : {}),
			}),
		).runs;
	}
	async interaction(
		sessionId: string,
		predicate: (interaction: NonNullable<OmpSpecDetails["interaction"]>) => boolean,
	) {
		let cursor = this.frames.length;
		for (;;) {
			const result = v4ConversationWorkflowRunsResultSchema.parse(
				await this.request("v4/conversation/workflowRuns", { sessionId, includeSpecDriven: true, limit: 64 }),
			);
			const current = result.dev;
			if (current && predicate(current)) return current;
			const event = await this.next(
				frame => isRecord(frame.params) && frame.params.topic === `conversation/${sessionId}`,
				cursor,
			);
			cursor = this.frames.indexOf(event) + 1;
		}
	}
	async phase(sessionId: string, phase: OmpSpecDetails["phase"], since = 0) {
		let cursor = since;
		for (;;) {
			const rows = await this.runs(sessionId);
			const row = rows.findLast(run => run.spec?.phase === phase);
			if (row?.spec) return { ...row, spec: row.spec };
			const stopped = rows.findLast(run => run.spec?.state === "blocked" || run.spec?.state === "paused");
			if (stopped) throw new Error(`Native run stopped before ${phase}: ${JSON.stringify(stopped)}`);
			const event = await this.next(
				frame => nativeDetails(frame).some(spec => spec.sessionId === sessionId),
				cursor,
			);
			cursor = this.frames.indexOf(event) + 1;
		}
	}
	async close() {
		if (this.#closed) return;
		this.child.stdin.end();
		expect(await this.child.exited).toBe(0);
		await this.pump;
		if (this.#failure) throw this.#failure;
		this.#closed = true;
	}
	async [Symbol.asyncDispose]() {
		peers.delete(this);
		if (!this.#closed && this.child.exitCode === null) this.child.kill("SIGKILL");
		await this.child.exited;
		await this.pump;
	}
}

async function expectRequestError(request: Promise<unknown>, message?: string) {
	// Bun 1.4.3's async rejection matcher stalls subprocess streams; await I/O before synchronous assertions.
	const error: unknown = await request.then(
		() => undefined,
		error => error,
	);
	expect(error).toBeInstanceOf(Error);
	if (message) expect((error as Error).message).toContain(message);
}

function workspace(cwd: string) {
	return { workspacePath: cwd, workspaceKey: cwd };
}
function nativeDetails(value: unknown): OmpSpecDetails[] {
	if (Array.isArray(value)) return value.flatMap(nativeDetails);
	if (!isRecord(value)) return [];
	const own = isRecord(value.spec) ? [value.spec as OmpSpecDetails] : [];
	return [
		...own,
		...Object.entries(value)
			.filter(([key]) => key !== "spec")
			.flatMap(([, item]) => nativeDetails(item)),
	];
}
function action(spec: OmpSpecDetails, verb: string): OmpSpecAction {
	const found = spec.actions.find(item => (item.command ?? item.commandPrefix ?? "").startsWith(`/dev ${verb}`));
	if (!found) throw new Error(`No native ${verb} action in ${JSON.stringify(spec)}`);
	return found;
}
async function execute(peer: SpecPeer, sessionId: string, spec: OmpSpecDetails, verb: string, suffix = "") {
	const item = action(spec, verb);
	const command = `${item.command ?? item.commandPrefix}${suffix}`;
	const selected = spec.actions.find(candidate => candidate.command === command) ?? item;
	expect(await peer.send(sessionId, command, selected.binding)).toMatchObject({ status: "accepted" });
	if (verb === "cancel") await confirmCancellation(peer, sessionId);
}
async function confirmCancellation(peer: SpecPeer, sessionId: string) {
	// Command admission precedes the native UI decision; answer the actual pending confirmation.
	const confirmation = await peer.subscribe(
		sessionId,
		`cancel-confirmation-${crypto.randomUUID()}`,
		"desktop-continuous",
	);
	const frame = await peer.next(
		frame =>
			isRecord(frame.params) &&
			frame.params.subscriptionId === confirmation.subscriptionId &&
			conversationTopicFrameSchema.parse(frame.params).payload.kind === "snapshot",
		confirmation.since,
	);
	const payload = conversationTopicFrameSchema.parse(frame.params).payload;
	if (payload.kind !== "snapshot") throw new Error("Native confirmation snapshot missing");
	const pendingConfirmation = payload.snapshot.pendingInteractions.find(
		interaction =>
			interaction.payload.kind === "userInput" && interaction.payload.prompt.startsWith("取消协同开发流程\n"),
	);
	expect(pendingConfirmation).toBeDefined();
	expect(
		commandAckSchema.parse(
			await peer.request("v4/command", {
				commandId: crypto.randomUUID(),
				clientId: "native-spec-consumer",
				sessionId,
				type: "resolveInteraction",
				payload: { interactionId: pendingConfirmation!.interactionId, answer: { optionId: "yes" } },
				issuedAt: Date.now(),
			}),
		),
	).toMatchObject({ status: "accepted" });
}
async function discuss(peer: SpecPeer, sessionId: string, spec: OmpSpecDetails, text: string) {
	const recipient = spec.interaction?.recipient;
	expect(recipient).toBeDefined();
	const before = new Set(spec.interaction?.messages.map(message => message.id));
	const binding = { runId: spec.actions[0]!.binding.runId, generation: spec.generation };
	expect(await peer.send(sessionId, text, { ...binding, generation: binding.generation + 1 })).toMatchObject({
		status: "rejected",
	});
	expect(await peer.send(sessionId, text, { ...binding, runId: crypto.randomUUID() })).toMatchObject({
		status: "rejected",
	});
	expect(await peer.send(sessionId, text, spec.actions[0]!.binding)).toMatchObject({ status: "rejected" });
	expect(await peer.send(sessionId, text, binding)).toMatchObject({ status: "accepted" });
	const interaction = await peer.interaction(sessionId, current =>
		current.messages.some(
			message => !before.has(message.id) && message.text === text && message.status === "completed",
		),
	);
	const message = interaction.messages.findLast(item => !before.has(item.id) && item.text === text)!;
	expect(message).toMatchObject({
		role: recipient!.role,
		actorId: recipient!.actorId,
		sessionId: recipient!.sessionId,
		runId: spec.actions[0]!.binding.runId,
		phase: spec.phase,
		status: "completed",
	});
	expect(message.reply?.length).toBeGreaterThan(0);
	const row = (await peer.runs(sessionId, message.runId))[0]!;
	if (!row.spec) throw new Error("Completed dialogue lost its native run");
	return { ...row, spec: row.spec };
}
async function fixture(root: TempDir, baseUrl: string) {
	const cwd = root.join("project"),
		home = root.join("home"),
		configRoot = root.join("config"),
		temp = root.join("tmp");
	const agentDir = path.join(configRoot, "agent");
	for (const directory of [cwd, home, agentDir, temp]) await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  spec-fixture:\n    baseUrl: ${baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 200000\n      - id: chat-b\n        reasoning: false\n        contextWindow: 200000\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"skillful: false\nmodelRoles:\n  default: spec-fixture/chat-a\n  smol: spec-fixture/chat-a\ntools:\n  xdev: false\nasync:\n  enabled: false\ntask:\n  batch: true\n  isolation:\n    enabled: true\nteam:\n  members:\n    - spec-fixture/chat-a\n    - spec-fixture/chat-b\n",
	);
	const env: NodeJS.ProcessEnv = {
		PATH: Bun.env.PATH,
		SystemRoot: Bun.env.SystemRoot,
		WINDIR: Bun.env.WINDIR,
		ProgramFiles: Bun.env.ProgramFiles,
		HOME: home,
		USERPROFILE: home,
		LOCALAPPDATA: home,
		TEMP: temp,
		TMP: temp,
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
		GIT_AUTHOR_EMAIL: "omp@example.invalid",
		GIT_COMMITTER_NAME: "OMP Acceptance",
		GIT_COMMITTER_EMAIL: "omp@example.invalid",
		OPENSPEC_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
	};
	await fs.writeFile(env.GIT_CONFIG_GLOBAL!, "");
	async function git(args: string[]) {
		const child = Bun.spawn(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [code, error] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		if (code !== 0) throw new Error(`Fixture Git ${args.join(" ")}: ${error}`);
	}
	await git(["init", "--initial-branch=main"]);
	await fs.writeFile(path.join(cwd, "baseline.txt"), "Native spec desktop fixture\n");
	await git(["add", "baseline.txt"]);
	await git(["-c", "core.hooksPath=", "commit", "-m", "Fixture baseline"]);
	return { cwd, env };
}

async function readMaterial(
	peer: SpecPeer,
	sessionId: string,
	runId: string,
	artifactId: string,
	version: number,
): Promise<Buffer<ArrayBuffer>> {
	let offset = 0;
	const chunks: Buffer[] = [];
	for (;;) {
		const result = v4ConversationWorkflowRunArtifactReadResultSchema.parse(
			await peer.request("v4/conversation/workflowRunArtifactRead", {
				sessionId,
				runId,
				artifactId,
				version,
				offset,
				limit: 4096,
			}),
		);
		chunks.push(Buffer.from(result.dataBase64, "base64"));
		if (result.nextOffset === null) {
			const bytes = Buffer.concat(chunks);
			expect(bytes.byteLength).toBe(result.totalBytes);
			return bytes;
		}
		expect(result.nextOffset).toBeGreaterThan(offset);
		offset = result.nextOffset;
	}
}
async function materialBytes(peer: SpecPeer, sessionId: string, runId: string, spec: OmpSpecDetails) {
	const listed = v4ConversationWorkflowRunArtifactsResultSchema.parse(
		await peer.request("v4/conversation/workflowRunArtifacts", { sessionId, runId }),
	);
	const result = new Map<string, { version: number; bytes: Buffer<ArrayBuffer> }>();
	for (const material of spec.materials.filter(item => item.readiness === "present")) {
		expect(material.artifactId).toBeString();
		expect(material.version).toBeNumber();
		expect(listed.artifacts).toContainEqual(
			expect.objectContaining({ id: material.artifactId, version: material.version }),
		);
		const bytes = await readMaterial(peer, sessionId, runId, material.artifactId!, material.version!);
		expect(bytes.length).toBeGreaterThan(0);
		result.set(material.artifactId!, { version: material.version!, bytes });
	}
	return result;
}

const startText = `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT} Authorize specification sync and archive only after my final acceptance.`;

describe("Native spec desktop public-entry acceptance", () => {
	test(
		"mode/help and drafts create neither a workflow row nor a model call and reject file rewind",
		async () => {
			await using root = await TempDir.create("@omp-dev-idle-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const sessionId = await peer.create(config.cwd);
			const legacy = await peer.subscribe(sessionId, "legacy-idle", "desktop-continuous", false);
			for (const profile of ["desktop-continuous", "web-remote-replayable"] as const)
				await peer.subscribe(sessionId, `idle-${profile}`, profile);
			expect(await peer.send(sessionId, "/dev")).toMatchObject({ status: "accepted" });
			await peer.interaction(sessionId, interaction => interaction.mode === "dev");
			const rows = v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId, limit: 1 }),
			);
			const rewind = commandAckSchema.parse(
				await peer.request("v4/command", {
					commandId: crypto.randomUUID(),
					clientId: "native-spec-consumer",
					sessionId,
					type: "applyFileRewind",
					payload: { target: { rowId: 0, entityId: "unavailable-rewind-target" } },
					baseRevision: rows.atRevision,
					baseLogEpoch: rows.atLogEpoch,
					issuedAt: Date.now(),
				}),
			);
			expect(rewind).toMatchObject({
				status: "rejected",
				reasonCode: "fault.command.invalid",
				message: expect.stringContaining("协同开发模式不能执行 /applyFileRewind"),
			});
			expect(await peer.send(sessionId, "/spec status")).toMatchObject({ status: "rejected" });
			expect(await peer.send(sessionId, "/dev help")).toMatchObject({ status: "accepted" });
			expect(await peer.send(sessionId, "Draft only; do not start any actors.")).toMatchObject({
				status: "accepted",
			});
			const draft = await peer.interaction(sessionId, interaction => interaction.draft.includes("Draft only"));
			expect(draft).toMatchObject({ mode: "dev", messages: [] });
			expect(draft.recipient).toBeUndefined();
			expect(await peer.runs(sessionId)).toEqual([]);
			expect(provider.requests).toEqual([]);
			expect(await peer.send(sessionId, "/dev")).toMatchObject({ status: "accepted" });
			await peer.interaction(sessionId, interaction => interaction.mode === "chat");
			const other = await peer.create(config.cwd);
			const initial = v4ConversationWorkflowRunsResultSchema.parse(
				await peer.request("v4/conversation/workflowRuns", { sessionId: other, includeSpecDriven: true }),
			);
			expect(initial.dev).toBeUndefined();
			for (const frame of peer.frames.filter(
				frame => isRecord(frame.params) && frame.params.subscriptionId === legacy.subscriptionId,
			))
				Baseline.conversationTopicFrameSchema.parse(frame.params);
			expect(provider.requests).toEqual([]);
			await peer.close();
		},
		BUDGET,
	);
	test(
		"actor-bound queued and processing cancellation isolate late replies and preserve paused drafts",
		async () => {
			await using root = await TempDir.create("@omp-dev-message-");
			const entered = Promise.withResolvers<ModelRequest>();
			const aborted = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			await using provider = createProviderFixture({
				async dialogue(request, input, signal) {
					if (input.text === "Hold this retained requirements conversation.") {
						if (request.messages.at(-1)?.role !== "tool") {
							const read = request.tools?.find(
								tool => tool.function?.name.replace(/^_/u, "") === "read",
							)?.function;
							if (!read) throw new Error("Retained requirements actor lost its read tool");
							return {
								tool: { name: read.name, args: { i: "Inspecting isolated baseline", path: "baseline.txt" } },
							};
						}
						entered.resolve(request);
						if (signal.aborted) aborted.resolve();
						else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
						await release.promise;
					}
					return respond(request);
				},
			});
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			try {
				await peer.ready();
				const sessionId = await peer.create(config.cwd);
				const subscriptions = await Promise.all([
					peer.subscribe(sessionId, "messages-desktop", "desktop-continuous"),
					peer.subscribe(sessionId, "messages-remote", "web-remote-replayable"),
				]);
				expect(await peer.send(sessionId, startText)).toMatchObject({ status: "accepted" });
				const pending = await peer.phase(sessionId, "awaiting-specification");
				expect(await peer.send(sessionId, "/dev")).toMatchObject({ status: "accepted" });
				expect(await peer.send(sessionId, "Hold this retained requirements conversation.")).toMatchObject({
					status: "accepted",
				});
				const actual = await entered.promise;
				expect(rolePayload(actual)?.specDrivenRole).toBe("requirements");
				expect(contentText(actual.messages.at(-1)?.content)).toContain("Native spec desktop fixture");
				const processing = await peer.interaction(sessionId, current =>
					current.messages.some(message => message.status === "processing"),
				);
				const first = processing.messages.find(message => message.status === "processing")!;
				expect(first).toMatchObject({ runId: pending.runId, ...processing.recipient });
				const queuedText = "This queued text must never reach the Provider.";
				expect(await peer.send(sessionId, queuedText)).toMatchObject({ status: "accepted" });
				const queue = await peer.interaction(sessionId, current =>
					current.messages.some(message => message.text === queuedText && message.status === "queued"),
				);
				const second = queue.messages.find(message => message.text === queuedText)!;
				const confirm = action(pending.spec, "confirm-spec");
				expect(await peer.send(sessionId, confirm.command!, confirm.binding)).toMatchObject({ status: "rejected" });
				expect(await peer.send(sessionId, "/dev cancel-message nonexistent-message")).toMatchObject({
					status: "rejected",
				});
				const other = await peer.create(config.cwd);
				expect(await peer.send(other, `/dev cancel-message ${first.id}`)).toMatchObject({ status: "rejected" });
				expect(await peer.send(sessionId, `/dev cancel-message ${second.id}`)).toMatchObject({
					status: "accepted",
				});
				await peer.interaction(sessionId, current =>
					current.messages.some(message => message.id === second.id && message.status === "cancelled"),
				);
				expect(await peer.send(sessionId, `/dev cancel-message ${first.id}`)).toMatchObject({ status: "accepted" });
				await peer.interaction(sessionId, current =>
					current.messages.some(message => message.id === first.id && message.status === "cancelled"),
				);
				await aborted.promise;
				release.resolve();
				expect(await peer.send(sessionId, "/dev status")).toMatchObject({ status: "accepted" });
				const cancelled = await peer.interaction(
					sessionId,
					current => current.messages.filter(message => message.status === "cancelled").length === 2,
				);
				expect(cancelled.messages.every(message => message.reply === undefined)).toBe(true);
				expect(provider.requests.some(request => rolePayload(request)?.input.text === queuedText)).toBe(false);
				expect((await peer.runs(sessionId, pending.runId))[0]?.spec?.phase).toBe("awaiting-specification");
				for (const subscription of subscriptions) {
					await peer.next(
						frame =>
							isRecord(frame.params) &&
							frame.params.subscriptionId === subscription.subscriptionId &&
							nativeDetails(frame).some(
								spec =>
									spec.interaction?.messages.some(
										message => message.id === first.id && message.status === "cancelling",
									) === true,
							),
					);
				}
				expect(await peer.send(sessionId, "/dev pause")).toMatchObject({ status: "accepted" });
				const beforeDraft = provider.requests.length;
				expect(await peer.send(sessionId, "Paused draft must remain unsent.")).toMatchObject({
					status: "accepted",
				});
				await peer.interaction(sessionId, current => current.draft.includes("Paused draft"));
				expect(await peer.send(sessionId, "/dev resume")).toMatchObject({ status: "accepted" });
				await peer.phase(sessionId, "awaiting-specification");
				expect(provider.requests.length).toBe(beforeDraft);
				expect(await peer.send(sessionId, "/dev cancel")).toMatchObject({ status: "accepted" });
				await confirmCancellation(peer, sessionId);
				await peer.phase(sessionId, "cancelled");
				const endedInput = v4ConversationWorkflowRunsResultSchema.parse(
					await peer.request("v4/conversation/workflowRuns", { sessionId, includeSpecDriven: true }),
				).dev;
				expect(endedInput).toMatchObject({ mode: "dev", draft: "Paused draft must remain unsent." });
				expect(endedInput?.recipient).toBeUndefined();
				expect(provider.failures).toEqual([]);
				await peer.close();
			} finally {
				release.resolve();
			}
		},
		BUDGET,
	);
	for (const mode of ["normal", "goal"] as const)
		test(
			`${mode}: native actions, real task progress, versioned evidence and readonly cold history`,
			async () => {
				await using root = await TempDir.create("@omp-zcode-spec-");
				const question = "Should blank names use world?";
				await using provider = createProviderFixture({ requirementsQuestion: question });
				const config = await fixture(root, provider.baseUrl);
				await using peer = new SpecPeer(config.cwd, config.env);
				await peer.ready();
				expect(await peer.request("runtime/capabilities", {})).toMatchObject({ ompSpecDriven: true });
				const sessionId = await peer.create(config.cwd);
				const old = await peer.subscribe(sessionId, "old", "desktop-continuous", false);
				const continuous = await peer.subscribe(sessionId, "native", "desktop-continuous");
				const replayable = await peer.subscribe(sessionId, "remote", "web-remote-replayable");
				expect(await peer.send(sessionId, startText)).toMatchObject({ status: "accepted" });
				expect(await peer.send(sessionId, "/dev")).toMatchObject({ status: "accepted" });
				const answers = await peer.phase(sessionId, "awaiting-answers");
				expect(answers.spec.questions).toContain(question);
				expect(answers.spec.progress).toEqual({ completed: 0, total: 0 });
				await execute(peer, sessionId, answers.spec, "answer", " Yes; blank names use world.");
				let specification = await peer.phase(sessionId, "awaiting-specification");
				const runId = specification.runId;
				const original = await materialBytes(peer, sessionId, runId, specification.spec);
				expect([...original.values()].some(item => item.bytes.toString("utf8").includes(REQUIREMENT))).toBe(true);
				const oldSpecificationAction = action(specification.spec, "confirm-spec");
				specification = await discuss(
					peer,
					sessionId,
					specification.spec,
					"OMP_DEV_REVISE Clarify the unchanged greeting scope.",
				);
				expect(specification.spec.phase).toBe("awaiting-specification");
				expect(specification.spec.versions.specification).not.toBe(
					oldSpecificationAction.command?.split(" ").at(-1),
				);
				expect(
					await peer.send(sessionId, oldSpecificationAction.command!, oldSpecificationAction.binding),
				).toMatchObject({ status: "rejected" });
				const revised = await materialBytes(peer, sessionId, runId, specification.spec);
				expect(
					[...revised.values()].some(item => item.bytes.toString("utf8").includes("Revision discussion")),
				).toBe(true);
				const requestsBeforeStale = provider.requests.length;
				expect(
					await peer.send(
						sessionId,
						"/dev confirm-spec obsolete-version",
						action(specification.spec, "confirm-spec").binding,
					),
				).toMatchObject({ status: "rejected" });
				expect((await peer.runs(sessionId, runId))[0]?.spec?.versions).toEqual(specification.spec.versions);
				expect(provider.requests.length).toBe(requestsBeforeStale);
				await execute(peer, sessionId, specification.spec, "confirm-spec");
				const choice = await peer.phase(sessionId, "awaiting-choice");
				expect(
					choice.spec.candidates.some(
						candidate => candidate.adoptable && candidate.reviewSucceeded && candidate.recheckSucceeded,
					),
				).toBe(true);
				const explainedChoice = await discuss(
					peer,
					sessionId,
					choice.spec,
					"Continue; explain the actual reviewed alternatives before I choose.",
				);
				expect(explainedChoice.spec.phase).toBe("awaiting-choice");
				expect(explainedChoice.spec.candidates).toEqual(choice.spec.candidates);
				const candidates = await materialBytes(peer, sessionId, runId, choice.spec);
				for (const candidate of choice.spec.candidates) {
					expect(candidate.proposal.length).toBeGreaterThan(0);
					expect(
						[...candidates.values()].some(item => {
							try {
								return JSON.stringify(JSON.parse(item.bytes.toString("utf8"))).includes(candidate.id);
							} catch {
								return false;
							}
						}),
					).toBe(true);
				}
				await execute(peer, sessionId, choice.spec, "choose");
				let plan = await peer.phase(sessionId, "awaiting-plan");
				expect(plan.spec.selectedCandidate).not.toBeNull();
				const oldPlanAction = action(plan.spec, "confirm-plan");
				plan = await discuss(
					peer,
					sessionId,
					plan.spec,
					"OMP_DEV_REVISE Clarify task ordering without changing approved scope.",
				);
				expect(plan.spec.phase).toBe("awaiting-plan");
				expect(await peer.send(sessionId, oldPlanAction.command!, oldPlanAction.binding)).toMatchObject({
					status: "rejected",
				});
				const state = JSON.parse(
					await fs.readFile(path.join(config.cwd, ".omp/spec-sessions", runId, "state.json"), "utf8"),
				);
				expect(plan.spec.versions.specification).toBe(state.status.specification.version);
				expect(plan.spec.selectedCandidate).toEqual({
					id: state.solution.candidateId,
					version: state.status.selection.candidateVersion,
				});
				expect(
					choice.spec.candidates.map(candidate => ({
						id: candidate.id,
						version: candidate.version,
						proposal: candidate.proposal,
					})),
				).toEqual(
					state.teamResult.candidates.map((candidate: { id: string; version: string; proposal: string }) => ({
						id: candidate.id,
						version: candidate.version,
						proposal: candidate.proposal,
					})),
				);
				expect(
					plan.spec.tasks.map(task => ({ id: task.id, title: task.title, dependencies: task.dependencies })),
				).toEqual(
					state.plan.tasks.map((task: { id: string; title: string; dependencies?: string[] }) => ({
						id: task.id,
						title: task.title,
						dependencies: task.dependencies ?? [],
					})),
				);
				expect(plan.spec.progress.total).toBe(state.plan.tasks.length);
				expect(plan.spec.progress.total).toBeGreaterThan(0);
				expect(plan.spec.progress.completed).toBe(0);
				await execute(peer, sessionId, plan.spec, "confirm-plan", mode === "goal" ? " --goal" : "");
				const acceptance = await peer.phase(sessionId, "awaiting-acceptance");
				expect(acceptance.spec.progress.completed).toBe(acceptance.spec.progress.total);
				const runtime = JSON.parse(
					await fs.readFile(path.join(config.cwd, ".omp/spec-sessions", runId, "state.json"), "utf8"),
				);
				expect(runtime.status.executionMode).toBe(mode);
				expect(acceptance.spec.progress.completed).toBe(
					runtime.status.tasks.filter((task: { status: string }) => task.status === "completed").length,
				);
				expect(await fs.readFile(path.join(config.cwd, IMPLEMENTATION_PATH), "utf8")).toContain("name.trim()");
				const evidence = await materialBytes(peer, sessionId, runId, acceptance.spec);
				for (const relative of [
					"handoffs/requirements-to-solution.md",
					"handoffs/solution-to-plan.md",
					"handoffs/plan-to-execution.md",
					"verification.md",
				]) {
					const bytes = await fs.readFile(path.join(config.cwd, "openspec/changes", CHANGE_ID, relative));
					expect([...evidence.values()].some(item => item.bytes.equals(bytes))).toBe(true);
					if (relative.startsWith("handoffs/")) expect(bytes.toString("utf8")).toContain(HANDOFF_MARKER);
				}
				expect([...evidence.values()].some(item => item.bytes.toString("utf8").includes("exitCode"))).toBe(true);
				for (const [id, captured] of original)
					expect(await readMaterial(peer, sessionId, runId, id, captured.version)).toEqual(captured.bytes);
				const workspaceRuns = zcodeWorkflowsRunsResultSchema.parse(
					await peer.request("workflows/runs", {
						workspace: workspace(config.cwd),
						includeSpecDriven: true,
						limit: 50,
					}),
				);
				expect(workspaceRuns.runs).toContainEqual(
					expect.objectContaining({ runId, spec: expect.objectContaining({ changeId: CHANGE_ID }) }),
				);
				expect(
					LegacyProtocol.zcodeWorkflowsRunsResultSchema.parse(
						await peer.request("workflows/runs", { workspace: workspace(config.cwd), limit: 50 }),
					).runs,
				).toEqual([]);
				expect(
					Baseline.v4ConversationWorkflowRunsResultSchema.parse(
						await peer.request("v4/conversation/workflowRuns", { sessionId, limit: 64 }),
					).runs,
				).toEqual([]);
				for (const subscription of [continuous, replayable]) {
					const event = await peer.next(
						frame =>
							isRecord(frame.params) &&
							frame.params.subscriptionId === subscription.subscriptionId &&
							nativeDetails(frame).some(spec => spec.phase === "awaiting-acceptance"),
					);
					const observed = nativeDetails(event).find(spec => spec.phase === "awaiting-acceptance")!;
					expect(observed.progress).toEqual(acceptance.spec.progress);
					expect(observed.tasks).toEqual(acceptance.spec.tasks);
				}
				const baselineFrames = peer.frames.filter(
					frame => isRecord(frame.params) && frame.params.subscriptionId === old.subscriptionId,
				);
				expect(baselineFrames.length).toBeGreaterThan(0);
				for (const frame of baselineFrames) {
					Baseline.conversationTopicFrameSchema.parse(frame.params);
					expect(nativeDetails(frame)).toEqual([]);
				}
				const delivered = await fs.readFile(path.join(config.cwd, IMPLEMENTATION_PATH));
				const feedback = await discuss(
					peer,
					sessionId,
					acceptance.spec,
					"Please inspect the delivered greeting and explain whether repair is needed. Do not change code.",
				);
				expect(feedback.spec.phase).toBe("awaiting-acceptance");
				expect(await fs.readFile(path.join(config.cwd, IMPLEMENTATION_PATH))).toEqual(delivered);
				const dialogueRequests = provider.requests.filter(
					request => rolePayload(request)?.input.kind === "conversation",
				);
				expect(new Set(dialogueRequests.map(request => rolePayload(request)?.specDrivenRole))).toEqual(
					new Set(["requirements", "solution", "planner", "executor"]),
				);
				const solutionDiscussion = dialogueRequests.find(
					request => rolePayload(request)?.specDrivenRole === "solution",
				)!;
				expect(JSON.stringify(rolePayload(solutionDiscussion)?.input)).toContain(choice.spec.candidates[0]!.id);
				const executorInspection = dialogueRequests.findLast(
					request =>
						rolePayload(request)?.specDrivenRole === "executor" && request.messages.at(-1)?.role === "tool",
				);
				expect(executorInspection).toBeDefined();
				expect(contentText(executorInspection!.messages.at(-1)?.content)).toContain("name.trim()");
				const messages = feedback.spec.interaction!.messages.filter(message => message.status === "completed");
				expect(new Set(messages.map(message => message.actorId)).size).toBe(4);
				expect(new Set(messages.map(message => message.sessionId)).size).toBe(4);
				const beforeRepair = provider.requests.length;
				expect(
					await peer.send(sessionId, "/dev repair obsolete-version Recheck the existing behavior.", {
						runId,
						generation: feedback.spec.generation,
					}),
				).toMatchObject({ status: "rejected" });
				expect(provider.requests.length).toBe(beforeRepair);
				const repairing = action(feedback.spec, "repair");
				expect(
					await peer.send(
						sessionId,
						`${repairing.command ?? repairing.commandPrefix} Recheck the existing greeting behavior within its approved scope.`,
						repairing.binding,
					),
				).toMatchObject({ status: "accepted" });
				expect(
					await peer.send(
						sessionId,
						action(acceptance.spec, "accept").command!,
						action(acceptance.spec, "accept").binding,
					),
				).toMatchObject({ status: "rejected" });
				await peer.interaction(sessionId, current =>
					current.actions.some(
						item =>
							item.command.startsWith("/dev accept ") &&
							item.command !== action(acceptance.spec, "accept").command &&
							item.available,
					),
				);
				const repaired = await peer.phase(sessionId, "awaiting-acceptance");
				expect(repaired.spec.versions.acceptance).not.toBe(acceptance.spec.versions.acceptance);
				expect(repaired.spec.versions.specification).toBe(acceptance.spec.versions.specification);
				expect(repaired.spec.versions.plan).toBe(acceptance.spec.versions.plan);
				expect(provider.requests.some(request => rolePayload(request)?.input.kind === "repair-scope")).toBe(true);
				expect(await fs.readFile(path.join(config.cwd, IMPLEMENTATION_PATH), "utf8")).toContain(
					"explicit version-bound repair",
				);
				await execute(peer, sessionId, repaired.spec, "accept");
				const completed = await peer.phase(sessionId, "completed");
				expect(completed.spec.stage).toBe("closure");
				expect(completed.spec.actions).toEqual([]);
				expect(completed.spec.materials.find(material => material.id === "proposal")?.readiness).toBe("present");
				expect(completed.spec.materials.find(material => material.id === "verification")?.readiness).toBe(
					"present",
				);
				expect(
					completed.spec.materials.some(
						material => material.id.startsWith("review:") && material.readiness === "present",
					),
				).toBe(true);
				expect(peer.frames.some(frame => nativeDetails(frame).some(spec => spec.phase === "closing"))).toBe(true);
				const count = provider.requests.length;
				await peer.close();
				await using cold = new SpecPeer(config.cwd, config.env);
				await cold.ready();
				const history = (await cold.runs(sessionId, runId)).find(run => run.runId === runId)!;
				expect(history.spec).toMatchObject({ live: false, readOnly: true, actions: [], phase: "completed" });
				expect(history.spec?.interaction?.actions ?? []).toEqual([]);
				expect(history.spec?.interaction?.recipient).toBeUndefined();
				expect(history.spec?.interaction?.messages).toEqual(repaired.spec.interaction?.messages);
				for (const [id, captured] of evidence)
					expect(await readMaterial(cold, sessionId, runId, id, captured.version)).toEqual(captured.bytes);
				expect(provider.requests.length).toBe(count);
				expect(provider.failures).toEqual([]);
				await cold.close();
			},
			BUDGET,
		);
	test(
		"ownership, late observation, replay/resync, lifecycle replacement and cold material diagnostics",
		async () => {
			await using root = await TempDir.create("@omp-zcode-spec-lifecycle-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const sessionId = await peer.create(config.cwd);
			const observer = await peer.subscribe(sessionId, "lifecycle", "desktop-continuous");
			expect(await peer.send(sessionId, startText)).toMatchObject({ status: "accepted" });
			const first = await peer.phase(sessionId, "awaiting-specification");
			const approve = action(first.spec, "confirm-spec");
			const captured = await materialBytes(peer, sessionId, first.runId, first.spec);
			expect(captured.size).toBeGreaterThan(0);
			const countBeforeRefusal = provider.requests.length;
			for (const binding of [
				{ ...approve.binding, runId: "not-this-run" },
				{ ...approve.binding, generation: approve.binding.generation + 1 },
			])
				expect(await peer.send(sessionId, approve.command!, binding)).toMatchObject({ status: "rejected" });
			const otherSession = await peer.create(config.cwd);
			expect(await peer.send(otherSession, approve.command!, approve.binding)).toMatchObject({ status: "rejected" });
			const otherCwd = root.join("another-workspace");
			await fs.mkdir(otherCwd);
			const otherWorkspaceSession = await peer.create(otherCwd);
			expect(await peer.send(otherWorkspaceSession, approve.command!, approve.binding)).toMatchObject({
				status: "rejected",
			});
			await expectRequestError(
				peer.request("v4/conversation/workflowRunArtifacts", { sessionId: otherSession, runId: first.runId }),
				"does not belong",
			);
			await expectRequestError(
				peer.request("v4/conversation/workflowRunArtifacts", {
					sessionId: otherWorkspaceSession,
					runId: first.runId,
				}),
				"does not belong",
			);
			expect(provider.requests.length).toBe(countBeforeRefusal);
			expect((await peer.runs(sessionId, first.runId))[0]?.spec?.phase).toBe("awaiting-specification");
			const wrongWorkspace = zcodeWorkflowsRunsResultSchema.parse(
				await peer.request("workflows/runs", {
					workspace: workspace(otherCwd),
					includeSpecDriven: true,
					limit: 50,
				}),
			);
			expect(wrongWorkspace.runs.some(run => run.runId === first.runId)).toBe(false);

			const late = await peer.subscribe(sessionId, "late", "web-remote-replayable");
			const initial = await peer.next(
				frame => isRecord(frame.params) && frame.params.subscriptionId === late.subscriptionId,
				late.since,
			);
			const snapshotFrame = conversationTopicFrameSchema.parse(initial.params);
			if (snapshotFrame.payload.kind !== "snapshot") throw new Error("Late subscriber did not receive a snapshot");
			expect(
				nativeDetails(snapshotFrame).some(
					spec => spec.versions.specification === first.spec.versions.specification,
				),
			).toBe(true);
			const base = { logEpoch: snapshotFrame.payload.snapshot.logEpoch, seq: snapshotFrame.toSeq };
			const sincePause = peer.frames.length;
			await execute(peer, sessionId, first.spec, "pause");
			await peer.next(
				frame => nativeDetails(frame).some(spec => spec.sessionId === sessionId && spec.state === "paused"),
				sincePause,
			);
			const paused = (await peer.runs(sessionId, first.runId))[0]!;
			expect(paused.spec?.state).toBe("paused");
			expect(provider.requests.length).toBe(countBeforeRefusal);
			const resumed = await peer.subscribe(sessionId, "late", "web-remote-replayable", true, base);
			expect(resumed.mode).toBe("resume");
			await peer.next(
				frame =>
					isRecord(frame.params) &&
					frame.params.subscriptionId === resumed.subscriptionId &&
					nativeDetails(frame).some(spec => spec.state === "paused"),
				resumed.since,
			);
			const resyncSince = peer.frames.length;
			await peer.request("v4/conversation/resync", {
				topic: resumed.topic,
				connectionId: resumed.connectionId,
				subscriptionId: resumed.subscriptionId,
				base: null,
				forceSnapshot: true,
			});
			const recovered = await peer.next(
				frame =>
					isRecord(frame.params) &&
					frame.params.subscriptionId === resumed.subscriptionId &&
					conversationTopicFrameSchema.parse(frame.params).payload.kind === "snapshot",
				resyncSince,
			);
			expect(nativeDetails(recovered).some(spec => spec.sessionId === sessionId && spec.state === "paused")).toBe(
				true,
			);
			await peer.request("v4/conversation/unsubscribe", {
				topic: resumed.topic,
				connectionId: resumed.connectionId,
				subscriptionId: resumed.subscriptionId,
			});
			const unsubscribeCursor = peer.frames.length;
			const resumeSince = peer.frames.length;
			await execute(peer, sessionId, paused.spec!, "resume");
			await peer.next(
				frame => nativeDetails(frame).some(spec => spec.sessionId === sessionId && spec.state === "waiting"),
				resumeSince,
			);
			const running = (await peer.runs(sessionId, first.runId))[0]!;
			expect(running.spec?.phase).toBe("awaiting-specification");
			expect(
				peer.frames
					.slice(unsubscribeCursor)
					.some(frame => isRecord(frame.params) && frame.params.subscriptionId === resumed.subscriptionId),
			).toBe(false);
			const cancelling = peer.frames.length;
			await execute(peer, sessionId, running.spec!, "cancel");
			await peer.phase(sessionId, "cancelled", cancelling);
			expect((await peer.runs(sessionId, first.runId))[0]?.spec?.actions).toEqual([]);
			expect(await peer.send(sessionId, approve.command!, approve.binding)).toMatchObject({ status: "rejected" });
			const replacing = peer.frames.length;
			expect(await peer.send(sessionId, startText)).toMatchObject({ status: "accepted" });
			const replacement = await peer.phase(sessionId, "awaiting-specification", replacing);
			expect(replacement.runId).not.toBe(first.runId);
			expect(replacement.spec.changeId).toBe(first.spec.changeId);
			const retained = await peer.runs(sessionId);
			expect(retained.some(run => run.runId === first.runId && run.spec?.phase === "cancelled")).toBe(true);
			for (const [id, item] of captured)
				expect(await readMaterial(peer, sessionId, first.runId, id, item.version)).toEqual(item.bytes);
			expect(await peer.send(sessionId, approve.command!, approve.binding)).toMatchObject({ status: "rejected" });
			const replacementApproval = action(replacement.spec, "confirm-spec");
			const replacementBytes = await materialBytes(peer, sessionId, replacement.runId, replacement.spec);
			const sourceStatePath = path.join(config.cwd, ".omp/spec-sessions", replacement.runId, "state.json");
			await peer.request("v4/conversation/unsubscribe", {
				topic: observer.topic,
				connectionId: observer.connectionId,
				subscriptionId: observer.subscriptionId,
			});
			const beforeRestart = provider.requests.length;
			await peer.close();
			// Live-owner shutdown can persist cancellation; only subsequent cold reads must be inert.
			const sourceState = await fs.readFile(sourceStatePath);
			await using cold = new SpecPeer(config.cwd, config.env);
			await cold.ready();
			const sessionsBefore = await cold.request("session/list", { workspace: workspace(config.cwd) });
			const history = (await cold.runs(sessionId, replacement.runId))[0]!;
			expect(history.spec).toMatchObject({
				phase: "awaiting-specification",
				live: false,
				readOnly: true,
				actions: [],
			});
			for (const [id, item] of replacementBytes)
				expect(await readMaterial(cold, sessionId, replacement.runId, id, item.version)).toEqual(item.bytes);
			expect(await fs.readFile(sourceStatePath)).toEqual(sourceState);
			expect(await cold.request("session/list", { workspace: workspace(config.cwd) })).toEqual(sessionsBefore);
			expect(provider.requests.length).toBe(beforeRestart);
			expect(await cold.send(sessionId, replacementApproval.command!, replacementApproval.binding)).toMatchObject({
				status: "rejected",
			});
			expect(provider.requests.length).toBe(beforeRestart);
			expect((await cold.runs(sessionId, replacement.runId))[0]?.spec?.actions).toEqual([]);
			await cold.close();

			// Remove only observed evidence bytes in this temporary fixture. Historical queries must
			// diagnose lost/unreadable material, not silently replace it with current source content.
			const runDirectory = path.join(config.cwd, ".omp/spec-sessions", replacement.runId);
			const saved = JSON.parse(await fs.readFile(path.join(runDirectory, "zcode.json"), "utf8")) as {
				artifacts: Array<{ id: string; versions: Array<{ version: number; digest: string }> }>;
			};
			const capturedEntry = replacementBytes.entries().next().value;
			if (!capturedEntry) throw new Error("No captured replacement material to diagnose");
			const [artifactId, capturedVersion] = capturedEntry;
			const recordedVersion = saved.artifacts
				.find(artifact => artifact.id === artifactId)
				?.versions.find(version => version.version === capturedVersion.version);
			if (!recordedVersion || !/^[a-f0-9]{64}$/u.test(recordedVersion.digest))
				throw new Error("Captured material has no valid persisted version record");
			const victim = path.join(runDirectory, "zcode-artifacts", recordedVersion.digest);
			const victimBytes = await fs.readFile(victim);
			expect(victimBytes).toEqual(capturedVersion.bytes);
			await fs.unlink(victim);
			await using missing = new SpecPeer(config.cwd, config.env);
			await missing.ready();
			const missingRun = (await missing.runs(sessionId, replacement.runId))[0]!;
			expect(missingRun.spec?.materials.some(material => material.readiness === "missing")).toBe(true);
			const absent = missingRun.spec!.materials.find(material => material.readiness === "missing")!;
			if (absent.artifactId && absent.version)
				await expectRequestError(
					readMaterial(missing, sessionId, replacement.runId, absent.artifactId, absent.version),
				);
			await missing.close();
			await fs.mkdir(victim);
			await using unreadable = new SpecPeer(config.cwd, config.env);
			await unreadable.ready();
			const unreadableRun = (await unreadable.runs(sessionId, replacement.runId))[0]!;
			expect(unreadableRun.spec?.materials.some(material => material.readiness === "unreadable")).toBe(true);
			expect(provider.requests.length).toBe(beforeRestart);
			expect(provider.failures).toEqual([]);
			await unreadable.close();
			await fs.rmdir(victim);
			await fs.writeFile(victim, victimBytes);
		},
		BUDGET,
	);
	test(
		"bounds native labels, retains readonly runs on session resume and reads history without its workspace",
		async () => {
			await using root = await TempDir.create("@omp-spec-boundaries-");
			await using provider = createProviderFixture({ requirementsQuestion: "Confirm the greeting scope?" });
			const config = await fixture(root, provider.baseUrl);
			const changeId = `long-${"a".repeat(165)}`;
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const sessionId = await peer.create(config.cwd);
			expect(await peer.send(sessionId, `/dev start ${changeId} ${MARKER}: ${REQUIREMENT}`)).toMatchObject({
				status: "accepted",
			});
			const pending = await peer.phase(sessionId, "awaiting-answers");
			expect(pending.spec.changeId).toBe(changeId);
			expect(pending.label).toBe(changeId.slice(0, 160));
			await peer.close();
			const requests = provider.requests.length;
			await using resumed = new SpecPeer(config.cwd, config.env);
			await resumed.ready();
			await resumed.request("session/resume", { sessionId });
			const subscription = await resumed.subscribe(sessionId, "resumed-history", "desktop-continuous");
			const snapshot = await resumed.next(
				frame => isRecord(frame.params) && frame.params.subscriptionId === subscription.subscriptionId,
				subscription.since,
			);
			expect(nativeDetails(snapshot)).toContainEqual(
				expect.objectContaining({ changeId, live: false, readOnly: true, actions: [] }),
			);
			const history = v4ConversationRowsRangeResultSchema.parse(
				await resumed.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
			);
			expect(provider.requests.length).toBe(requests);
			await resumed.close();
			const moved = root.join("moved-project");
			await fs.rename(config.cwd, moved);
			try {
				await using missing = new SpecPeer(root.join("."), config.env);
				await missing.ready();
				expect(
					LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
						await missing.request("session/read", { sessionId }),
					).session.sessionId,
				).toBe(sessionId);
				expect(
					v4ConversationRowsRangeResultSchema.parse(
						await missing.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
					).rows,
				).toEqual(history.rows);
				expect(await missing.runs(sessionId)).toEqual([]);
				expect(provider.requests.length).toBe(requests);
				await missing.close();
			} finally {
				await fs.rename(moved, config.cwd);
			}
			expect(provider.failures).toEqual([]);
		},
		BUDGET,
	);
});
