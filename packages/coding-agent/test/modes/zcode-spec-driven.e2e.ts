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
	type OmpSpecDetails,
	type OmpSpecRunBinding,
} from "../../src/modes/zcode/schema";
import * as Baseline from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/index";
import {
	IMPLEMENTATION,
	IMPLEMENTATION_PATH,
	MARKER,
	REQUIREMENT,
	createProviderFixture,
	contentText,
	rolePayload,
	continuationText,
	teamStage,
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
	#waiting = "startup";
	#boundaries: { operation: string; frameCount: number }[] = [];
	#stderrTail = "";
	trace(operation: string) {
		this.#waiting = operation;
		this.#boundaries.push({ operation, frameCount: this.frames.length });
		if (this.#boundaries.length > 24) this.#boundaries.shift();
	}
	diagnose() {
		console.error(
			"Native Dev stdio diagnostics:",
			JSON.stringify({
				waiting: this.#waiting,
				boundaries: this.#boundaries,
				frames: this.frames.slice(-12).map(frame => {
					const params = isRecord(frame.params) ? frame.params : undefined;
					const payload = params && isRecord(params.payload) ? params.payload : undefined;
					return {
						id: frame.id,
						method: frame.method,
						topic: params?.topic,
						subscriptionId: params?.subscriptionId,
						kind: payload?.kind,
						error: frame.error,
						markers: ["文件已写入。", "RAW_FOLLOWUP_DONE", "READONLY_DONE", "REPAIR_DONE"].filter(marker =>
							strings(frame).some(text => text.includes(marker)),
						),
						dev: nativeDetails(frame).map(spec => ({
							phase: spec.phase,
							state: spec.state,
							recipient: spec.interaction?.recipient?.sessionId,
							available: spec.actions.filter(action => action.available).map(action => action.id),
						})),
					};
				}),
				stderr: this.#stderrTail,
			}),
		);
	}
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
				this.#stderrTail = `${this.#stderrTail}${part}`.slice(-3000);
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
	async next(predicate: (frame: Frame) => boolean, since = 0, waiting = "public frame"): Promise<Frame> {
		this.trace(waiting);
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
		const target = isRecord(params) ? (params.sessionId ?? params.topic ?? "") : "";
		const payload = isRecord(params) && isRecord(params.payload) ? params.payload : undefined;
		const command =
			payload && typeof payload.text === "string"
				? payload.text.startsWith("/dev")
					? payload.text.split(/\s+/).slice(0, 3).join(" ")
					: "native dialogue"
				: "";
		this.write({ id, method, params });
		const response = await this.next(frame => frame.id === id, 0, `${method} ${String(target)} ${command} (${id})`);
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
		predicate: (interaction: OmpSpecDetails["interaction"] | undefined) => boolean,
	) {
		let cursor = this.frames.length;
		for (;;) {
			const result = v4ConversationWorkflowRunsResultSchema.parse(
				await this.request("v4/conversation/workflowRuns", { sessionId, includeSpecDriven: true, limit: 64 }),
			);
			const current = result.dev;
			if (predicate(current)) return current;
			const event = await this.next(
				frame => isRecord(frame.params) && frame.params.topic === `conversation/${sessionId}`,
				cursor,
				`interaction ${sessionId}`,
			);
			cursor = this.frames.indexOf(event) + 1;
		}
	}
	async phase(sessionId: string, phase: OmpSpecDetails["phase"], since = 0) {
		let cursor = since;
		for (;;) {
			const rows = await this.runs(sessionId);
			const row = rows.findLast(run => run.spec?.phase === phase);
			if (
				row?.spec &&
				(row.spec.actions.some(action => action.id === "next" && action.available) || row.spec.state === "terminal")
			)
				return { ...row, spec: row.spec };
			const event = await this.next(
				frame => nativeDetails(frame).some(spec => spec.sessionId === sessionId),
				cursor,
				`phase ${phase} ${sessionId}; observed ${row?.spec?.phase ?? "none"}/${row?.spec?.state ?? "none"}`,
			);
			cursor = this.frames.indexOf(event) + 1;
		}
	}
	async close() {
		if (this.#closed) return;
		this.trace("app-server EOF settlement");
		this.child.stdin.end();
		expect(await this.child.exited).toBe(0);
		await this.pump;
		if (this.#failure) throw this.#failure;
		this.#closed = true;
	}
	async [Symbol.asyncDispose]() {
		if (!this.#closed) this.diagnose();
		peers.delete(this);
		if (!this.#closed && this.child.exitCode === null) this.child.kill("SIGKILL");
		await this.child.exited;
		await this.pump;
	}
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
function teamConfigurationInteraction(frame: Frame) {
	const parsed = conversationTopicFrameSchema.safeParse(frame.params);
	if (!parsed.success || parsed.data.payload.kind !== "snapshot") return undefined;
	return parsed.data.payload.snapshot.pendingInteractions.find(item => {
		const payload = item.payload;
		return (
			payload.kind === "userInput" &&
			!payload.freeText &&
			payload.options?.length === 2 &&
			payload.options.some(option => option.optionId === "开启") &&
			payload.options.some(option => option.optionId === "关闭")
		);
	});
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
		`providers:\n  spec-fixture:\n    baseUrl: ${baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 200000\n      - id: chat-b\n        reasoning: false\n        contextWindow: 200000\n      - id: chat-reasoning\n        reasoning: true\n        thinking:\n          mode: effort\n          efforts: [low, medium, high]\n        contextWindow: 200000\n`,
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
		// Native OpenSpec uses process-local dates; pin this private consumer and its target calculation to UTC.
		TZ: "UTC",
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

const startText = `/dev new ${MARKER}: ${REQUIREMENT} Authorize sync/archive only after explicit final next.`;

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	return isRecord(value) ? Object.values(value).flatMap(strings) : [];
}
async function stageReady(peer: SpecPeer, sessionId: string, phase: OmpSpecDetails["phase"]) {
	const run = await peer.phase(sessionId, phase);
	const id = run.spec.interaction?.recipient?.sessionId;
	if (!id) throw new Error(`No real native session for ${phase}`);
	const subscription = await peer.subscribe(id, crypto.randomUUID(), "desktop-continuous");
	await peer.next(
		frame =>
			isRecord(frame.params) &&
			frame.params.subscriptionId === subscription.subscriptionId &&
			strings(frame).some(text => text.includes("文件已写入。")),
		subscription.since,
		`stageReady ${phase}: native written reply ${id}`,
	);
	return { ...run, stageId: id };
}
async function command(peer: SpecPeer, sessionId: string, text: string) {
	expect(await peer.send(sessionId, text)).toMatchObject({ status: "accepted" });
}
async function rows(peer: SpecPeer, sessionId: string) {
	return v4ConversationRowsRangeResultSchema.parse(
		await peer.request("v4/conversation/rowsRange", { sessionId, limit: 200 }),
	).rows;
}
async function blocked(peer: SpecPeer, sessionId: string, explanation?: RegExp) {
	let cursor = 0;
	for (;;) {
		const run = (await peer.runs(sessionId)).findLast(row => row.spec?.state === "blocked");
		if (run?.spec && (!explanation || explanation.test(run.spec.explanation))) return { ...run, spec: run.spec };
		const event = await peer.next(
			frame => isRecord(frame.params) && frame.params.topic === `conversation/${sessionId}`,
			cursor,
			`blocked workflow ${sessionId}`,
		);
		cursor = peer.frames.indexOf(event) + 1;
	}
}
async function rejectChangedApproval(
	peer: SpecPeer,
	cwd: string,
	sessionId: string,
	phase: OmpSpecDetails["phase"],
	file: string,
	text: string,
	requestCount: () => number,
) {
	const target = path.join(cwd, file);
	const original = await fs.readFile(target);
	const count = requestCount();
	try {
		await fs.appendFile(target, "\nChanged approved bytes without approval.\n");
		expect(await peer.send(sessionId, text)).toMatchObject({ status: "rejected" });
		expect((await blocked(peer, sessionId)).spec.phase).toBe(phase);
		expect(requestCount()).toBe(count);
	} finally {
		await fs.writeFile(target, original);
	}
}

describe("Native Dev public stdio acceptance", () => {
	test(
		"ordinary desktop text rejects stale material bindings without delivery",
		async () => {
			await using root = await TempDir.create("@omp-dev-text-binding-");
			await using provider = createProviderFixture({
				dialogue: request => ({ text: `BINDING_REPLY_${continuationText(request)}` }),
			});
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const session = await peer.create(config.cwd);
			await peer.subscribe(session, "binding-root", "desktop-continuous");
			await command(peer, session, "/dev");
			await command(peer, session, startText);
			const current = await stageReady(peer, session, "requirements");
			const { actionId: _actionId, ...binding } = current.spec.actions[0]!.binding;
			expect(binding.files.length).toBeGreaterThan(0);
			const beforeRows = await rows(peer, current.stageId);
			const beforeRequests = provider.requests.length;
			const staleList = { ...binding, files: binding.files.slice(1) };
			expect(await peer.send(session, "STALE_FILE_LIST", staleList)).toMatchObject({
				status: "rejected",
				reasonCode: "guard.specRun",
			});
			const target = path.join(config.cwd, binding.files[0]!.path);
			const original = await fs.readFile(target);
			try {
				await fs.appendFile(target, "\nUnapproved external material edit.\n");
				expect(await peer.send(session, "STALE_FILE_HASH", binding)).toMatchObject({
					status: "rejected",
					reasonCode: "guard.specRun",
				});
			} finally {
				await fs.writeFile(target, original);
			}
			expect(await rows(peer, current.stageId)).toEqual(beforeRows);
			expect(provider.requests.length).toBe(beforeRequests);
			for (const [text, supplied] of [
				["VALID_BOUND_TEXT", binding],
				["LEGACY_UNBOUND_TEXT", undefined],
			] as const) {
				const since = peer.frames.length;
				expect(await peer.send(session, text, supplied)).toMatchObject({ status: "accepted" });
				await peer.next(
					frame =>
						isRecord(frame.params) &&
						frame.params.topic === `conversation/${current.stageId}` &&
						strings(frame).includes(`BINDING_REPLY_${text}`),
					since,
				);
				expect(provider.requests.some(request => continuationText(request) === text)).toBe(true);
			}
			expect(provider.failures).toEqual([]);
			await peer.close();
		},
		BUDGET,
	);
	test(
		"side selection cannot fork or send until the workspace Dev owner exits successfully",
		async () => {
			await using root = await TempDir.create("@omp-dev-side-selection-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const session = await peer.create(config.cwd);
			await peer.subscribe(session, "side-root", "desktop-continuous");
			await command(peer, session, "/dev");
			await command(peer, session, startText);
			await stageReady(peer, session, "requirements");
			const sessions = async () =>
				LegacyProtocol.zcodeSessionListResultSchema
					.parse(await peer.request("session/list", { workspace: workspace(config.cwd) }))
					.sessions.map(item => item.sessionId)
					.sort();
			const before = await sessions();
			const requestCount = provider.requests.length;
			const side = async (text: string) =>
				commandAckSchema.parse(
					await peer.request("v4/command", {
						commandId: crypto.randomUUID(),
						clientId: "native-spec-consumer",
						sessionId: session,
						type: "createSelectionSideSession",
						payload: { firstInput: { text } },
						issuedAt: Date.now(),
					}),
				);
			const devDir = path.join(config.cwd, ".omp", "dev");
			const statePath = path.join(devDir, "state.json");
			const stateBefore = await fs.readFile(statePath);
			if (process.platform === "win32") {
				const runWindowsTool = async (name: string, args: string[]) => {
					const child = Bun.spawn([path.join(process.env.SystemRoot!, "System32", name), ...args], {
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					});
					const [code, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					if (code !== 0) throw new Error(`${name} failed (${code}): ${stdout}\n${stderr}`);
					return stdout;
				};
				const identity = await runWindowsTool("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
				const sid = identity.match(/S-1-(?:\d+-)+\d+/)?.[0];
				if (!sid) throw new Error("Could not determine current Windows user SID");
				try {
					// Deny adding files only on this owned directory, so the atomic temp file cannot be created.
					await runWindowsTool("icacls.exe", [devDir, "/deny", `*${sid}:(WD)`]);
					const refused = await side("SIDE_REFUSED_INPUT");
					expect(refused.status).toBe("failed");
					expect(refused.result).toBeUndefined();
					expect(provider.requests.length).toBe(requestCount);
				} finally {
					await runWindowsTool("icacls.exe", [devDir, "/remove:d", `*${sid}`]);
				}
			} else {
				// A directory cannot be replaced by the staged state file on Unix.
				const savedState = `${statePath}-saved`;
				await fs.rename(statePath, savedState);
				try {
					await fs.mkdir(statePath);
					await fs.writeFile(path.join(statePath, "obstruction"), "save obstruction");
					const refused = await side("SIDE_REFUSED_INPUT");
					expect(refused.status).toBe("failed");
					expect(refused.result).toBeUndefined();
					expect(provider.requests.length).toBe(requestCount);
				} finally {
					await fs.rm(statePath, { recursive: true, force: true });
					await fs.rename(savedState, statePath);
				}
			}
			expect(await fs.readFile(statePath)).toEqual(stateBefore);
			expect(await sessions()).toEqual(before);
			expect((await peer.interaction(session, current => current?.mode === "dev"))?.mode).toBe("dev");
			const accepted = await side("OMP_SPEC_ORDINARY_CHILD");
			expect(accepted).toMatchObject({ status: "accepted", result: { type: "createSelectionSideSession" } });
			if (accepted.result?.type !== "createSelectionSideSession") throw new Error("Missing side session");
			const child = accepted.result.sessionId;
			expect(child).not.toBe(session);
			await peer.interaction(session, current => !current || current.mode === "chat");
			const subscription = await peer.subscribe(child, "side-child", "desktop-continuous");
			await peer.next(
				frame =>
					isRecord(frame.params) &&
					frame.params.subscriptionId === subscription.subscriptionId &&
					strings(frame).includes("OMP_SPEC_ORDINARY_CHILD_DONE"),
				subscription.since,
			);
			expect(
				provider.requests.some(request => JSON.stringify(request.messages).includes("SIDE_REFUSED_INPUT")),
			).toBe(false);
			expect(provider.failures).toEqual([]);
			await peer.close();
		},
		BUDGET,
	);
	test(
		"root and stage reasoning controls affect only the visible native stage",
		async () => {
			await using root = await TempDir.create("@omp-dev-stage-reasoning-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const session = await peer.create(config.cwd);
			await peer.subscribe(session, "reasoning-root", "desktop-continuous");
			await command(peer, session, "/dev");
			await command(peer, session, startText);
			const { stageId } = await stageReady(peer, session, "requirements");
			const snapshot = async (id: string) =>
				LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(await peer.request("session/read", { sessionId: id }));
			const rootThought = (await snapshot(session)).settings.thoughtLevel.current;
			await peer.request("session/setModel", {
				sessionId: stageId,
				model: { providerId: "spec-fixture", modelId: "chat-reasoning", options: { reasoningLevel: "high" } },
			});
			expect((await snapshot(stageId)).settings.thoughtLevel.available.map(item => item.value)).toContain("low");
			expect((await snapshot(stageId)).settings.thoughtLevel.current).toBe("high");
			await peer.request("session/setThoughtLevel", { sessionId: session, thoughtLevel: "low" });
			expect((await snapshot(stageId)).settings.thoughtLevel.current).toBe("low");
			expect((await snapshot(session)).settings.thoughtLevel.current).toBe(rootThought);
			await peer.request("session/setThoughtLevel", { sessionId: stageId, thoughtLevel: "high" });
			expect((await snapshot(stageId)).settings.thoughtLevel.current).toBe("high");
			await peer.request("session/setThoughtLevel", { sessionId: stageId, thoughtLevel: "low" });
			expect((await snapshot(stageId)).settings.thoughtLevel.current).toBe("low");
			expect((await snapshot(session)).settings.thoughtLevel.current).toBe(rootThought);
			expect(provider.failures).toEqual([]);
			await peer.close();
		},
		BUDGET,
	);
	test(
		"idle controls preserve baseline/replay; one workspace owner restores Team for another ordinary session",
		async () => {
			await using root = await TempDir.create("@omp-dev-owner-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const first = await peer.create(config.cwd);
			const other = await peer.create(config.cwd);
			const baseline = await peer.subscribe(first, "baseline-owner", "desktop-continuous", false);
			await peer.subscribe(first, "desktop-owner", "desktop-continuous");
			const remote = await peer.subscribe(first, "remote-owner", "web-remote-replayable");
			await command(peer, first, "/dev");
			await peer.interaction(first, current => current?.mode === "dev");
			await command(peer, first, "/dev config");
			const configuration = await peer.subscribe(first, "config-selection", "desktop-continuous");
			const pending = await peer.next(
				frame =>
					isRecord(frame.params) &&
					frame.params.subscriptionId === configuration.subscriptionId &&
					!!teamConfigurationInteraction(frame),
				configuration.since,
			);
			const interaction = teamConfigurationInteraction(pending);
			if (!interaction) throw new Error("Missing real configuration interaction");
			expect(
				commandAckSchema.parse(
					await peer.request("v4/command", {
						commandId: crypto.randomUUID(),
						clientId: "native-spec-consumer",
						sessionId: first,
						type: "resolveInteraction",
						payload: { interactionId: interaction.interactionId, answer: { optionId: "开启" } },
						issuedAt: Date.now(),
					}),
				),
			).toMatchObject({ status: "accepted" });
			await peer.interaction(
				first,
				current => !!current?.actions.some(action => action.id === "config" && action.available),
			);
			expect(JSON.parse(await fs.readFile(path.join(config.cwd, ".omp/dev/state.json"), "utf8")).team).toBe(true);
			expect(await peer.send(other, "/dev")).toMatchObject({ status: "rejected" });
			expect(await peer.runs(first)).toEqual([]);
			expect(provider.requests).toEqual([]);
			const initial = await peer.next(
				frame => isRecord(frame.params) && frame.params.subscriptionId === remote.subscriptionId,
				remote.since,
			);
			const snapshot = conversationTopicFrameSchema.parse(initial.params);
			if (snapshot.payload.kind !== "snapshot") throw new Error("Missing replay snapshot");
			const base = { logEpoch: snapshot.payload.snapshot.logEpoch, seq: snapshot.toSeq };
			await command(peer, first, "/dev");
			await peer.interaction(first, current => !current || current.mode === "chat");
			const replay = await peer.subscribe(first, "remote-owner", "web-remote-replayable", true, base);
			expect(replay.mode).toBe("resume");
			await peer.request("v4/conversation/resync", {
				topic: replay.topic,
				connectionId: replay.connectionId,
				subscriptionId: replay.subscriptionId,
				base: null,
				forceSnapshot: true,
			});
			await peer.next(
				frame =>
					isRecord(frame.params) &&
					frame.params.subscriptionId === replay.subscriptionId &&
					conversationTopicFrameSchema.parse(frame.params).payload.kind === "snapshot",
				replay.since,
			);
			await command(peer, other, "/dev");
			await peer.interaction(other, current => current?.mode === "dev");
			expect(JSON.parse(await fs.readFile(path.join(config.cwd, ".omp/dev/state.json"), "utf8")).team).toBe(true);
			await command(peer, other, "/dev");
			for (const frame of peer.frames.filter(
				frame => isRecord(frame.params) && frame.params.subscriptionId === baseline.subscriptionId,
			))
				Baseline.conversationTopicFrameSchema.parse(frame.params);
			expect(provider.requests).toEqual([]);
			await command(peer, other, "/dev");
			await command(peer, other, startText);
			const restoredTeam = await stageReady(peer, other, "requirements");
			expect(restoredTeam.spec.useTeam).toBe(true);
			expect(restoredTeam.spec.teamMutable).toBe(true);
			await command(peer, other, "/dev");
			expect(provider.failures).toEqual([]);
			await peer.close();
		},
		BUDGET,
	);

	test(
		"four native sessions retain raw dialogue and complete materials; final next archives without a model",
		async () => {
			await using root = await TempDir.create("@omp-dev-native-stages-");
			let obstruction = "";
			const obstructionSentinel = "omp-owned-archive-conflict.txt";
			const obstructionContents = "Deliberate native Dev archive conflict fixture\n";
			await using provider = createProviderFixture({
				dialogue: request => {
					const raw = continuationText(request) ?? "";
					const latest = request.messages.findLastIndex(
						message => message.role === "user" && contentText(message.content) === raw,
					);
					const completed = request.messages.slice(latest + 1).some(message => message.role === "tool");
					if (raw.includes("仅修复归档目录阻塞")) {
						if (completed) return { text: "REPAIR_DONE" };
						const name = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "bash")?.function
							?.name;
						if (!name) throw new Error("Native bash unavailable for authorized repair");
						const repair = [
							'const fs = require("node:fs")',
							`const target = ${JSON.stringify(obstruction)}`,
							`const sentinel = target + "/" + ${JSON.stringify(obstructionSentinel)}`,
							`if (fs.readdirSync(target).length !== 1 || fs.readFileSync(sentinel, "utf8") !== ${JSON.stringify(obstructionContents)}) throw new Error("Archive conflict fixture ownership changed")`,
							"fs.unlinkSync(sentinel)",
							"fs.rmdirSync(target)",
						].join(";");
						return {
							tool: {
								name,
								args: {
									i: "Removing owned archive obstruction",
									command: `"${process.execPath}" -e '${repair}'`,
									timeout: 60,
								},
							},
						};
					}
					if (raw.includes("解释收尾失败")) {
						if (completed) return { text: "READONLY_DONE" };
						const name = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === "write")?.function
							?.name;
						if (!name) throw new Error("Native write unavailable for readonly boundary probe");
						return {
							tool: {
								name,
								args: {
									i: "Probing readonly completion boundary",
									path: "forbidden-after-report.txt",
									content: "must not exist",
								},
							},
						};
					}
					return { text: "RAW_FOLLOWUP_DONE" };
				},
			});
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const session = await peer.create(config.cwd);
			await peer.subscribe(session, "root-native", "desktop-continuous");
			const ordinaryBefore = await rows(peer, session);
			await command(peer, session, "/dev");
			await command(peer, session, startText);
			const requirements = await stageReady(peer, session, "requirements");
			expect(requirements.spec.changeId?.length).toBeGreaterThan(0);
			const changeId = requirements.spec.changeId!;
			const beforeRestore = provider.requests.length;
			await command(peer, session, "/dev");
			await command(peer, session, "/dev");
			expect((await peer.phase(session, "requirements")).spec.interaction?.recipient?.sessionId).toBe(
				requirements.stageId,
			);
			expect(provider.requests.length).toBe(beforeRestore);
			const raw = "需求可以，但这只是讨论，不是批准。 保留  内部空格。";
			const since = peer.frames.length;
			await command(peer, session, raw);
			await peer.next(
				frame =>
					isRecord(frame.params) &&
					frame.params.topic === `conversation/${requirements.stageId}` &&
					strings(frame).includes("RAW_FOLLOWUP_DONE"),
				since,
				`native RAW_FOLLOWUP_DONE ${requirements.stageId}`,
			);
			const continuation = provider.requests.at(-1)!;
			expect(continuationText(continuation)).toBe(raw);
			expect(
				continuation.messages.filter(
					message => rolePayload({ ...continuation, messages: [message] }) !== undefined,
				),
			).toHaveLength(1);
			expect((await peer.runs(session))[0]?.spec?.phase).toBe("requirements");
			const original = await materialBytes(peer, session, requirements.runId, requirements.spec);
			await command(peer, session, "/dev next");
			const solution = await stageReady(peer, session, "solution");
			const solutionBytes = await materialBytes(peer, session, solution.runId, solution.spec);
			const countBeforeViews = provider.requests.length;
			await peer.request("session/resume", { sessionId: session });
			expect((await peer.phase(session, "solution")).spec.interaction?.recipient?.sessionId).toBe(solution.stageId);
			await peer.request("session/close", { sessionId: requirements.stageId });
			expect((await peer.phase(session, "solution")).spec.interaction?.recipient?.sessionId).toBe(solution.stageId);
			const mutateQueue = async (id: string, base: { baseRevision?: number; baseLogEpoch?: string } = {}) => {
				await peer.subscribe(id, `native-stage-cas-${id}`, "desktop-continuous");
				const state = v4ConversationRowsRangeResultSchema.parse(
					await peer.request("v4/conversation/rowsRange", { sessionId: id, limit: 1 }),
				);
				return commandAckSchema.parse(
					await peer.request("v4/command", {
						commandId: crypto.randomUUID(),
						clientId: "native-stage-cas",
						issuedAt: Date.now(),
						sessionId: id,
						baseRevision: state.atRevision,
						baseLogEpoch: state.atLogEpoch,
						...base,
						type: "setAutoDrain",
						payload: { autoDrain: true },
					}),
				);
			};
			const rootWatermark = v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId: session, limit: 1 }),
			);
			expect(await mutateQueue(solution.stageId, { baseRevision: Number.MAX_SAFE_INTEGER })).toMatchObject({
				status: "stale",
				reasonCode: "guard.revision",
			});
			expect(await mutateQueue(solution.stageId, { baseLogEpoch: rootWatermark.atLogEpoch })).toMatchObject({
				status: "stale",
				reasonCode: "guard.logEpoch",
			});
			expect(await mutateQueue(solution.stageId)).toMatchObject({ status: "accepted" });
			expect(await mutateQueue(session)).toMatchObject({ status: "accepted" });
			expect(provider.requests.length).toBe(countBeforeViews);
			const beforeBack = provider.requests.length;
			await command(peer, session, "/dev back");
			expect((await peer.phase(session, "requirements")).spec.interaction?.recipient?.sessionId).toBe(
				requirements.stageId,
			);
			expect(provider.requests.length).toBe(beforeBack);
			await command(peer, session, "/dev next");
			await stageReady(peer, session, "solution");
			const beforeCandidateRefusals = provider.requests.length;
			for (const text of ["/dev next", "/dev next no-such-candidate"]) {
				expect(await peer.send(session, text)).toMatchObject({ status: "rejected" });
				expect((await peer.runs(session))[0]?.spec?.phase).toBe("solution");
			}
			expect(provider.requests.length).toBe(beforeCandidateRefusals);
			await rejectChangedApproval(
				peer,
				config.cwd,
				session,
				"solution",
				`openspec/changes/${changeId}/proposal.md`,
				"/dev next pure",
				() => provider.requests.length,
			);
			const decision = "/dev next pure";
			await command(peer, session, decision);
			const plan = await stageReady(peer, session, "planning");
			const input = rolePayload(
				provider.requests.find(request => rolePayload(request)?.specDrivenRole === "planner")!,
			)!.input;
			expect(input.userReply).toBe(decision);
			expect(JSON.stringify(input.files)).toContain(
				JSON.stringify(solutionBytes.get("solution")!.bytes.toString()).slice(1, -1),
			);
			const solutionPath = rolePayload(
				provider.requests.find(request => rolePayload(request)?.specDrivenRole === "solution")!,
			)!.input.outputPaths;
			if (!Array.isArray(solutionPath) || typeof solutionPath[0] !== "string")
				throw new Error("No native solution path");
			await rejectChangedApproval(
				peer,
				config.cwd,
				session,
				"planning",
				solutionPath[0],
				"/dev next",
				() => provider.requests.length,
			);
			await command(peer, session, "/dev next");
			const execution = await stageReady(peer, session, "executing");
			const materials = await materialBytes(peer, session, execution.runId, execution.spec);
			expect(materials.get("report")!.bytes.toString()).toContain("## 验证结果");
			expect(await fs.readFile(path.join(config.cwd, IMPLEMENTATION_PATH), "utf8")).toBe(IMPLEMENTATION);
			const ids = [requirements.stageId, solution.stageId, plan.stageId, execution.stageId];
			expect(new Set(ids).size).toBe(4);
			const listed = strings(await peer.request("session/list", { workspace: workspace(config.cwd) }));
			for (const id of ids) {
				expect(listed).toContain(id);
				const history = await rows(peer, id);
				expect(history.some(row => row.kind === "assistantText")).toBe(true);
				expect(history.some(row => row.kind === "toolCall" && row.status === "success")).toBe(true);
			}
			const planPaths = input.outputPaths;
			if (!Array.isArray(planPaths) || typeof planPaths[0] !== "string") throw new Error("No native plan path");
			await rejectChangedApproval(
				peer,
				config.cwd,
				session,
				"executing",
				planPaths[0],
				"/dev next",
				() => provider.requests.length,
			);
			expect(await rows(peer, session)).toEqual(ordinaryBefore);
			const date = new Date().toISOString().slice(0, 10);
			obstruction = `openspec/changes/archive/${date}-${changeId}`;
			await fs.mkdir(path.join(config.cwd, obstruction), { recursive: true });
			await fs.writeFile(path.join(config.cwd, obstruction, obstructionSentinel), obstructionContents);
			const failedCount = provider.requests.length;
			const approvedBeforeClosing = JSON.parse(
				await fs.readFile(path.join(config.cwd, ".omp/dev/state.json"), "utf8"),
			).run.approvals;
			const historiesBeforeClosing = await Promise.all(
				ids.map(async id => (await rows(peer, id)).map(row => ({ ...row, actions: undefined }))),
			);
			const closingAck = await peer.send(session, "/dev next");
			expect(closingAck).toMatchObject({
				status: "failed",
				reasonCode: "fault.command.execution",
			});
			expect(closingAck.message).toContain("OpenSpec archive failed");
			const failed = await blocked(peer, session, /OpenSpec archive failed/u);
			expect(failed.spec.phase).toBe("executing");
			expect(failed.spec.explanation).toContain("OpenSpec archive failed");
			expect(failed.spec.explanation).toContain(changeId);
			expect(failed.spec.explanation).toContain("already exists");
			expect(await fs.readFile(path.join(config.cwd, obstruction, obstructionSentinel), "utf8")).toBe(
				obstructionContents,
			);
			expect(failed.spec.archivedChangePath).toBeUndefined();
			const approvedAfterClosing = JSON.parse(
				await fs.readFile(path.join(config.cwd, ".omp/dev/state.json"), "utf8"),
			).run.approvals;
			for (const role of ["requirements", "solution", "planner"])
				expect(approvedAfterClosing[role]).toEqual(approvedBeforeClosing[role]);
			expect(approvedAfterClosing.executor.userReply).toBe("/dev next");
			for (const [index, id] of ids.entries())
				expect((await rows(peer, id)).map(row => ({ ...row, actions: undefined }))).toEqual(
					historiesBeforeClosing[index],
				);
			for (const [id, captured] of materials)
				expect(await readMaterial(peer, session, execution.runId, id, captured.version)).toEqual(captured.bytes);
			expect(provider.requests.length).toBe(failedCount);
			let cursor = peer.frames.length;
			await command(peer, session, "解释收尾失败；不要批准，也不要修改任何文件。");
			await peer.next(
				frame =>
					isRecord(frame.params) &&
					frame.params.topic === `conversation/${execution.stageId}` &&
					strings(frame).includes("READONLY_DONE"),
				cursor,
				`native READONLY_DONE ${execution.stageId}`,
			);
			expect(await Bun.file(path.join(config.cwd, "forbidden-after-report.txt")).exists()).toBe(false);
			expect((await peer.runs(session))[0]?.spec?.phase).toBe("executing");
			cursor = peer.frames.length;
			await command(
				peer,
				session,
				"修复：仅修复归档目录阻塞，删除刚才夹具自有的标记文件和目标目录；不修改已验收材料、不执行业务实现、不运行同步归档，等待我 /dev next。",
			);
			await peer.next(
				frame =>
					isRecord(frame.params) &&
					frame.params.topic === `conversation/${execution.stageId}` &&
					strings(frame).includes("REPAIR_DONE"),
				cursor,
				`native REPAIR_DONE ${execution.stageId}`,
			);
			expect(
				await fs.stat(path.join(config.cwd, obstruction)).then(
					() => true,
					() => false,
				),
			).toBe(false);
			for (const [id, captured] of materials)
				expect(await readMaterial(peer, session, execution.runId, id, captured.version)).toEqual(captured.bytes);
			const count = provider.requests.length;
			await command(peer, session, "/dev next");
			const complete = await peer.phase(session, "idle");
			expect(complete.spec.archivedChangePath).toBeString();
			expect(provider.requests.length).toBe(count);
			expect(await fs.readFile(path.join(config.cwd, "openspec/specs/greeting/spec.md"), "utf8")).toContain(
				REQUIREMENT,
			);
			expect(await Bun.file(path.join(config.cwd, `openspec/changes/${changeId}/proposal.md`)).exists()).toBe(false);
			for (const [id, captured] of original)
				expect(await readMaterial(peer, session, complete.runId, id, captured.version)).toEqual(captured.bytes);
			for (const [id, captured] of materials)
				expect(await readMaterial(peer, session, complete.runId, id, captured.version)).toEqual(captured.bytes);
			await command(peer, session, "/dev");
			expect(await mutateQueue(session)).toMatchObject({ status: "accepted" });
			await command(peer, session, "/dev");
			expect(provider.requests.length).toBe(count);
			await peer.close();
			await using cold = new SpecPeer(config.cwd, config.env);
			await cold.ready();
			const sessionsBefore = await cold.request("session/list", { workspace: workspace(config.cwd) });
			const history = (await cold.runs(session, complete.runId))[0]!;
			expect(history.spec).toMatchObject({ live: false, readOnly: true, actions: [], phase: "idle" });
			for (const [id, captured] of materials)
				expect(await readMaterial(cold, session, complete.runId, id, captured.version)).toEqual(captured.bytes);
			for (const id of ids) expect((await rows(cold, id)).length).toBeGreaterThan(0);
			expect(await cold.request("session/list", { workspace: workspace(config.cwd) })).toEqual(sessionsBefore);
			const coldOrdinary = await cold.create(config.cwd);
			await command(cold, coldOrdinary, "/dev");
			await command(cold, coldOrdinary, "/dev");
			expect(provider.requests.length).toBe(count);
			expect(provider.failures).toEqual([]);
		},
		BUDGET,
	);
	test(
		"ordinary public stop settles Team without leaving Dev or replaying the discussion",
		async () => {
			await using root = await TempDir.create("@omp-dev-team-stop-");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const cancellations: Promise<void>[] = [];
			let hold = true;
			await using provider = createProviderFixture({
				delay: async (request, signal) => {
					if (!hold || !teamStage(request)) return;
					const cancelled = Promise.withResolvers<void>();
					cancellations.push(cancelled.promise);
					if (signal.aborted) cancelled.resolve();
					else signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
					entered.resolve();
					await Promise.race([cancelled.promise, release.promise]);
				},
			});
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			try {
				await peer.ready();
				const session = await peer.create(config.cwd);
				await peer.subscribe(session, "team-stop-root", "desktop-continuous");
				await command(peer, session, "/dev");
				await peer.interaction(session, current => current?.mode === "dev");
				await command(peer, session, "/dev config");
				const configuration = await peer.subscribe(session, "team-stop-config", "desktop-continuous");
				const pending = await peer.next(
					frame =>
						isRecord(frame.params) &&
						frame.params.subscriptionId === configuration.subscriptionId &&
						!!teamConfigurationInteraction(frame),
					configuration.since,
				);
				const interaction = teamConfigurationInteraction(pending);
				if (!interaction) throw new Error("Missing real Team configuration interaction");
				expect(
					commandAckSchema.parse(
						await peer.request("v4/command", {
							commandId: crypto.randomUUID(),
							clientId: "native-spec-consumer",
							sessionId: session,
							type: "resolveInteraction",
							payload: { interactionId: interaction.interactionId, answer: { optionId: "开启" } },
							issuedAt: Date.now(),
						}),
					),
				).toMatchObject({ status: "accepted" });
				await peer.interaction(
					session,
					current => !!current?.actions.some(action => action.id === "config" && action.available),
				);
				await command(peer, session, startText);
				const requirements = await stageReady(peer, session, "requirements");
				const captured = await materialBytes(peer, session, requirements.runId, requirements.spec);
				// Dev control completion is not admitted until its awaited handler settles.
				// Keep the public request live while independently interrupting its actual Team work.
				const advancing = peer.send(session, "/dev next");
				void advancing.catch(() => {});
				peer.trace("Team proposal entering before public stop");
				await entered.promise;
				const before = JSON.parse(await fs.readFile(path.join(config.cwd, ".omp/dev/state.json"), "utf8"));
				expect(before.run.phase).toBe("solution");
				expect(
					commandAckSchema.parse(
						await peer.request("v4/command", {
							commandId: crypto.randomUUID(),
							clientId: "native-spec-consumer",
							sessionId: session,
							type: "stop",
							payload: {},
							issuedAt: Date.now(),
						}),
					),
				).toMatchObject({ status: "accepted" });
				expect(await advancing).toMatchObject({
					status: "failed",
					reasonCode: "fault.command.execution",
					message: "Command cancelled",
				});
				peer.trace("Held Team HTTP requests cancelling after public stop");
				await Promise.all(cancellations);
				const stopped = await peer.phase(session, "solution");
				expect(stopped.spec.interaction?.mode).toBe("dev");
				expect(stopped.spec.useTeam).toBe(true);
				const after = JSON.parse(await fs.readFile(path.join(config.cwd, ".omp/dev/state.json"), "utf8"));
				expect(after).toEqual(before);
				for (const [id, material] of captured)
					expect(await readMaterial(peer, session, requirements.runId, id, material.version)).toEqual(
						material.bytes,
					);
				expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(false);
				const count = provider.requests.length;
				const followup = await peer.subscribe(
					stopped.spec.interaction!.recipient!.sessionId,
					"team-stop-followup",
					"desktop-continuous",
				);
				await command(peer, session, "OMP_SPEC_ORDINARY_CHILD：只解释当前阶段，不重新启动讨论。");
				await peer.next(
					frame =>
						isRecord(frame.params) &&
						frame.params.subscriptionId === followup.subscriptionId &&
						strings(frame).some(text => text.includes("OMP_SPEC_ORDINARY_CHILD_DONE")),
					followup.since,
				);
				await peer.phase(session, "solution");
				expect(provider.requests.filter(request => teamStage(request)).length).toBe(cancellations.length);
				expect(provider.requests.length).toBeGreaterThan(count);
				hold = false;
				await command(peer, session, "/dev back");
				await peer.phase(session, "requirements");
				await command(peer, session, "/dev next");
				await stageReady(peer, session, "solution");
				expect(provider.requests.filter(request => teamStage(request)).length).toBeGreaterThan(
					cancellations.length,
				);
				expect(provider.failures).toEqual([]);
				await command(peer, session, "/dev");
				await peer.close();
			} finally {
				release.resolve();
			}
		},
		BUDGET,
	);
	test(
		"exit settles the native request; reentry restores history without a model and drop preserves files",
		async () => {
			await using root = await TempDir.create("@omp-dev-settlement-");
			const entered = Promise.withResolvers<void>();
			let aborted = false;
			await using provider = createProviderFixture({
				delay: async (request, signal) => {
					if (continuationText(request) !== "HOLD_NATIVE_FOLLOWUP") return;
					entered.resolve();
					await new Promise<void>(resolve => {
						const stop = () => {
							aborted = true;
							resolve();
						};
						if (signal.aborted) stop();
						else signal.addEventListener("abort", stop, { once: true });
					});
				},
			});
			const config = await fixture(root, provider.baseUrl);
			await using peer = new SpecPeer(config.cwd, config.env);
			await peer.ready();
			const session = await peer.create(config.cwd);
			await peer.subscribe(session, "settlement-root", "desktop-continuous");
			await command(peer, session, "/dev");
			await command(peer, session, startText);
			const current = await stageReady(peer, session, "requirements");
			const captured = await materialBytes(peer, session, current.runId, current.spec);
			await command(peer, session, "HOLD_NATIVE_FOLLOWUP");
			await entered.promise;
			expect(await peer.send(session, "/dev next")).toMatchObject({
				status: "rejected",
				reasonCode: "fault.command.invalid",
			});
			expect(aborted).toBe(false);
			await peer.request("session/close", { sessionId: current.stageId });
			expect(aborted).toBe(true);
			const count = provider.requests.length;
			// Action affordances derive from live ownership; the native transcript itself must remain identical.
			const history = async () => (await rows(peer, current.stageId)).map(row => ({ ...row, actions: undefined }));
			const nativeHistory = await history();
			await command(peer, session, "/dev");
			const restored = await peer.phase(session, "requirements");
			expect(restored.spec.interaction?.recipient?.sessionId).toBe(current.stageId);
			expect(await history()).toEqual(nativeHistory);
			expect(provider.requests.length).toBe(count);
			await command(peer, session, "/dev drop");
			await peer.interaction(session, state => state?.mode === "dev" && !state.recipient);
			for (const [id, material] of captured)
				expect(await readMaterial(peer, session, current.runId, id, material.version)).toEqual(material.bytes);
			expect(await history()).toEqual(nativeHistory);
			expect(provider.requests.length).toBe(count);
			expect(provider.failures).toEqual([]);
		},
		BUDGET,
	);
});
