import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import {
	LegacyProtocol,
	commandAckSchema,
	v4ConversationRowsRangeResultSchema,
	v4ConversationWorkflowRunsResultSchema,
	v4ConversationWorkflowRunArtifactsResultSchema,
	v4ConversationWorkflowRunArtifactReadResultSchema,
} from "../../src/modes/zcode/schema";

type Frame = Record<string, unknown>;
const executable = Bun.env.OMP_ZCODE_TEST_EXECUTABLE?.trim();
if (executable && !path.isAbsolute(executable)) throw new Error("OMP_ZCODE_TEST_EXECUTABLE must be absolute");
const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

const activePeers = new Set<WorkflowPeer>();
afterEach(async () => {
	// A timed-out test may never unwind its await-using scope. Retain ownership of its child.
	for (const peer of activePeers) await peer[Symbol.asyncDispose]();
});
/** A real stdio peer: no imported server, session manager, compiler or journal substitutes. */
class WorkflowPeer {
	readonly child: Subprocess<"pipe", "pipe", "pipe">;
	readonly stderr: Promise<string>;
	readonly pending = new Map<string, ReturnType<typeof Promise.withResolvers<Frame>>>();
	readonly ready = Promise.withResolvers<void>();
	readonly pump: Promise<void>;
	readonly #methods = new Map<string, string>();
	readonly #redactions: string[];
	#stderrTail = "";
	#storagePhase = "unobserved";
	#lastFrames: string[] = [];
	#failure?: Error;
	#closing = false;
	#closed = false;
	#id = 0;
	constructor(cwd: string, env: NodeJS.ProcessEnv) {
		this.#redactions = [cwd, env.HOME, env.OMP_CONFIG_ROOT, env.TEMP].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		const child = Bun.spawn(
			[
				...(executable ? [executable] : [process.execPath, cli]),
				"app-server",
				"--stdio",
				"--surface",
				"desktop",
				"--cwd",
				cwd,
			],
			{ cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		this.child = child;
		activePeers.add(this);
		this.stderr = (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of child.stderr) {
				this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-8192);
			}
			this.#stderrTail = (this.#stderrTail + decoder.decode()).slice(-8192);
			return this.#stderrTail;
		})();
		void this.ready.promise.catch(() => {});
		void child.exited.then(
			code => {
				if (!this.#closing || this.pending.size) this.#fail(`App-server exited (${code})`);
			},
			error => this.#fail(`App-server exit failed: ${String(error)}`),
		);
		this.pump = (async () => {
			try {
				for await (const frame of readJsonl<unknown>(child.stdout)) {
					if (!isRecord(frame) || "jsonrpc" in frame || !("id" in frame || "method" in frame)) {
						throw new Error("Invalid app-server stdout frame");
					}
					this.#lastFrames.push(
						typeof frame.method === "string" ? frame.method : `response:${String(frame.id).slice(0, 80)}`,
					);
					if (this.#lastFrames.length > 12) this.#lastFrames.shift();
					if (frame.method === "startup/storageState" && isRecord(frame.params)) {
						this.#storagePhase = String(frame.params.phase).slice(0, 80);
						if (frame.params.phase === "ready") this.ready.resolve();
						if (frame.params.phase === "failed") {
							throw new Error(`Storage startup failed: ${String(frame.params.errorCode).slice(0, 80)}`);
						}
					}
					if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined) {
						child.stdin.write(
							`${JSON.stringify({
								id: frame.id,
								result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
							})}\n`,
						);
					}
					if (typeof frame.id === "string") this.pending.get(frame.id)?.resolve(frame);
				}
				if (!this.#closing || this.pending.size) this.#fail("Unexpected app-server stdout EOF");
			} catch (error) {
				this.#fail(error instanceof Error ? error.message : String(error));
			}
		})();
	}
	#diagnostic() {
		let stderr = this.#stderrTail;
		for (const value of this.#redactions) stderr = stderr.replaceAll(value, "<fixture>");
		stderr = stderr
			.replace(/(Bearer\s+)[^\s"']+/giu, "$1<redacted>")
			.replace(/((?:api[-_]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/giu, "$1<redacted>");
		return JSON.stringify({
			stage: this.#closing ? "closing" : this.#storagePhase === "ready" ? "requests" : "startup",
			storagePhase: this.#storagePhase,
			exitCode: this.child.exitCode,
			pending: [...this.#methods],
			lastFrames: this.#lastFrames,
			stderr,
		});
	}
	#fail(message: string) {
		if (this.#failure) return;
		this.#failure = new Error(`${message}: ${this.#diagnostic()}`);
		this.ready.reject(this.#failure);
		for (const pending of this.pending.values()) pending.reject(this.#failure);
	}
	async request(method: string, params: unknown): Promise<unknown> {
		if (this.#failure) throw this.#failure;
		const id = `workflow-${++this.#id}`;
		const pending = Promise.withResolvers<Frame>();
		this.pending.set(id, pending);
		this.#methods.set(id, method);
		try {
			this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
			const frame = await pending.promise;
			if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
			expect(frame).toHaveProperty("result");
			return frame.result;
		} finally {
			this.pending.delete(id);
			this.#methods.delete(id);
		}
	}
	async close() {
		this.#closing = true;
		this.child.stdin.end();
		expect(await this.child.exited).toBe(0);
		await this.pump;
		await this.stderr;
		if (this.#failure) throw this.#failure;
		this.#closed = true;
	}
	async [Symbol.asyncDispose]() {
		activePeers.delete(this);
		if (!this.#closed) console.error(`Workflow process failure: ${this.#diagnostic()}`);
		this.#closing = true;
		if (this.child.exitCode === null) {
			this.child.kill();
			await this.child.exited;
		}
		await this.pump;
	}
}

async function fixture(root: TempDir) {
	const cwd = root.join("workspace");
	const home = root.join("home");
	const configRoot = root.join("config");
	const agentDir = path.join(configRoot, "agent");
	const projectDir = path.join(cwd, ".zcode", "workflows");
	const globalDir = path.join(home, ".zcode", "workflows");
	for (const dir of [cwd, home, agentDir, projectDir, globalDir]) await fs.mkdir(dir, { recursive: true });
	const requests: string[] = [];
	// Constants must never ask a model. An unexpected real HTTP request fails the evidence,
	// rather than receiving a canned assistant answer that could conceal an actor fallback.
	const endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(`${request.method} ${request.url} ${await request.text()}`);
			return new Response("Constant workflow unexpectedly requested a model", { status: 500 });
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  workflow-fixture:\n    baseUrl: http://127.0.0.1:${endpoint.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: constant-host\n        reasoning: false\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: workflow-fixture/constant-host\n  smol: workflow-fixture/constant-host\ntools:\n  xdev: false\n",
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
		cwd,
		home,
		configRoot,
		projectDir,
		globalDir,
		env,
		requests,
		workspace: { workspacePath: cwd, workspaceKey: cwd },
		[Symbol.asyncDispose]: async () => {
			endpoint.stop(true);
		},
	};
}

function definition(script: string, description = "Real sandbox proof") {
	return `/* zcode-workflow\ndescription: ${description}\nargs:\n  topic:\n    type: string\n    required: true\n*/\n${script}`;
}

async function create(peer: WorkflowPeer, workspace: { workspacePath: string; workspaceKey: string }) {
	const ack = commandAckSchema.parse(
		await peer.request("v4/command", {
			commandId: crypto.randomUUID(),
			clientId: "workflow-process",
			sessionId: null,
			type: "createSession",
			payload: { workspaceId: workspace.workspaceKey },
			issuedAt: Date.now(),
		}),
	);
	expect(ack).toMatchObject({ status: "accepted", result: { type: "createSession" } });
	if (ack.result?.type !== "createSession") throw new Error("Missing workflow launch target");
	return ack.result.sessionId;
}

async function start(peer: WorkflowPeer, sessionId: string, name: string, args: Record<string, unknown>) {
	return commandAckSchema.parse(
		await peer.request("v4/command", {
			commandId: crypto.randomUUID(),
			clientId: "workflow-process",
			sessionId,
			type: "startSavedWorkflow",
			payload: { name, args },
			issuedAt: Date.now(),
		}),
	);
}

async function savedRuns(peer: WorkflowPeer, workspace: { workspacePath: string; workspaceKey: string }, name: string) {
	return LegacyProtocol.zcodeWorkflowsRunsResultSchema.parse(
		await peer.request("workflows/runs", { workspace, name, limit: 10 }),
	);
}

async function completed(
	peer: WorkflowPeer,
	workspace: { workspacePath: string; workspaceKey: string },
	name: string,
	runId: string,
) {
	for (;;) {
		const page = await savedRuns(peer, workspace, name);
		const run = page.runs.find(run => run.runId === runId);
		if (run?.status === "completed") return run;
		if (run?.status === "errored" || run?.status === "stopped")
			throw new Error(`Sandbox did not complete: ${JSON.stringify(run)}`);
		await Bun.sleep(20);
	}
}

describe("ZCode saved workflows through actual app-server process", () => {
	test("definition file operations preserve script bytes and move without overwriting", async () => {
		await using root = TempDir.createSync("@zcode-workflow-files-");
		await using config = await fixture(root);
		const script = 'return { text: "逐字节", n: 7 };\n';
		const globalFile = path.join(config.globalDir, "move-proof.dwf.ts");
		const projectFile = path.join(config.projectDir, "move-proof.dwf.ts");
		await fs.writeFile(globalFile, definition(script));
		await using peer = new WorkflowPeer(config.cwd, config.env);
		await peer.ready.promise;
		const workspace = config.workspace;
		const before = await peer.request("session/list", { workspace });
		const listed = LegacyProtocol.zcodeWorkflowsListResultSchema.parse(
			await peer.request("workflows/list", { workspace, scope: "global" }),
		);
		expect(listed.invalid).toEqual([]);
		expect(listed.workflows).toContainEqual(
			expect.objectContaining({ name: "move-proof", scope: "global", path: globalFile }),
		);
		const meta = {
			description: "Edited only metadata",
			whenToUse: "Before release",
			args: { topic: { type: "string", required: true } },
		};
		expect(
			LegacyProtocol.zcodeWorkflowsUpdateMetaResultSchema.parse(
				await peer.request("workflows/updateMeta", { workspace, scope: "global", name: "move-proof", meta }),
			),
		).toEqual({ ok: true, path: globalFile });
		const updated = LegacyProtocol.zcodeWorkflowsGetResultSchema.parse(
			await peer.request("workflows/get", { workspace, scope: "global", name: "move-proof" }),
		);
		expect(updated).toMatchObject({ ok: true, script, meta });
		const bytes = await fs.readFile(globalFile);
		await fs.writeFile(projectFile, "existing target\n");
		expect(await peer.request("workflows/move", { workspace, name: "move-proof" })).toMatchObject({
			ok: false,
			reason: "target_exists",
		});
		expect(await fs.readFile(globalFile)).toEqual(bytes);
		expect(await fs.readFile(projectFile, "utf8")).toBe("existing target\n");
		await fs.unlink(projectFile);
		expect(
			LegacyProtocol.zcodeWorkflowsMoveResultSchema.parse(
				await peer.request("workflows/move", { workspace, name: "move-proof" }),
			),
		).toEqual({ ok: true, from: globalFile, to: projectFile });
		expect(await fs.readFile(projectFile)).toEqual(bytes);
		await expect(fs.access(globalFile)).rejects.toMatchObject({ code: "ENOENT" });
		expect(
			LegacyProtocol.zcodeWorkflowsDeleteResultSchema.parse(
				await peer.request("workflows/delete", { workspace, name: "move-proof" }),
			),
		).toEqual({ ok: true, path: projectFile });
		await expect(fs.access(projectFile)).rejects.toMatchObject({ code: "ENOENT" });
		expect(
			LegacyProtocol.zcodeWorkflowsListResultSchema.parse(await peer.request("workflows/list", { workspace }))
				.workflows,
		).toEqual([]);
		expect(await peer.request("session/list", { workspace })).toEqual(before);
		expect(config.requests).toEqual([]);
		await peer.close();
	}, 120_000);
	test("compile, arguments and unavailable named models reject without orphaning the Hub launch session", async () => {
		await using root = TempDir.createSync("@zcode-workflow-preflight-");
		await using config = await fixture(root);
		for (const [name, script] of [
			["bad-types", 'const value: number = "not a number";\nreturn value;\n'],
			["bad-model", 'agent("judge", { model: "no-such-workflow-model" });\nreturn 1;\n'],
			["required-args", "return args.topic;\n"],
		])
			await fs.writeFile(path.join(config.projectDir, `${name}.dwf.ts`), definition(script!));
		await using peer = new WorkflowPeer(config.cwd, config.env);
		await peer.ready.promise;
		const workspace = config.workspace;
		const before = await peer.request("session/list", { workspace });
		for (const [name, args, reason] of [
			["bad-types", { topic: "types" }, "compile_failed"],
			["bad-model", { topic: "models" }, "compile_failed"],
			["required-args", {}, "invalid_args"],
		] as const) {
			const sessionId = await create(peer, workspace);
			const ack = await start(peer, sessionId, name, args);
			expect(ack).toMatchObject({
				status: "rejected",
				reasonCode: `fault.command.savedWorkflowStartRejected.${reason}`,
			});
			if (name === "bad-model") {
				expect(JSON.stringify(ack)).toContain("9011");
				expect(JSON.stringify(ack)).toContain("no-such-workflow-model");
			}
			expect((await savedRuns(peer, workspace, name)).runs).toEqual([]);
			// Match the actual Hub launcher: a rejected start reclaims its newly created target.
			expect(
				commandAckSchema.parse(
					await peer.request("v4/command", {
						commandId: crypto.randomUUID(),
						clientId: "workflow-process",
						sessionId,
						type: "deleteSession",
						payload: {},
						issuedAt: Date.now(),
					}),
				),
			).toMatchObject({ status: "accepted" });
			expect(await peer.request("session/list", { workspace })).toEqual(before);
		}
		expect(config.requests).toEqual([]);
		await peer.close();
	}, 120_000);

	test("real sandbox publishes markdown, launch rows and durable history survive app-server reopen", async () => {
		await using root = TempDir.createSync("@zcode-workflow-sandbox-");
		await using config = await fixture(root);
		const name = "constant-artifact";
		const markdown = "# Real workflow\n\n持久化产物。\n";
		const script = `await artifact.markdown("proof", ${JSON.stringify(markdown)});\nreturn { ok: true, topic: args.topic };\n`;
		const file = path.join(config.projectDir, `${name}.dwf.ts`);
		await fs.writeFile(file, definition(script));
		let sessionId: string;
		let runId: string;
		let toolCallId: string;
		{
			await using peer = new WorkflowPeer(config.cwd, config.env);
			await peer.ready.promise;
			sessionId = await create(peer, config.workspace);
			const ack = await start(peer, sessionId, name, { topic: "sandbox proof" });
			if (ack.result?.type !== "startSavedWorkflow") {
				throw new Error(`Missing canonical launch references: ${JSON.stringify(ack)}`);
			}
			// Bun's nested asymmetric matcher replaces these ACK fields in place.
			// Retain the actual wire references before asserting the complete ACK shape.
			runId = ack.result.runId;
			toolCallId = ack.result.toolCallId;
			expect(ack).toMatchObject({
				status: "accepted",
				result: { type: "startSavedWorkflow", runId: expect.any(String), toolCallId: expect.any(String) },
			});
			const run = await completed(peer, config.workspace, name, runId);
			expect(run).toMatchObject({
				parentSessionId: sessionId,
				toolCallId,
				cwd: config.cwd,
				args: { topic: "sandbox proof" },
			});
			const rows = v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
			);
			expect(JSON.stringify(rows)).toContain(runId);
			expect(JSON.stringify(rows)).toContain(toolCallId);
			expect(rows.rows.filter(row => row.kind === "userInput" && row.origin === "realUser")).toEqual([]);
			expect(rows.rows).toContainEqual(
				expect.objectContaining({
					kind: "userInput",
					origin: "workflowLaunch",
					workflowLaunch: expect.objectContaining({ runId }),
				}),
			);
			await peer.close();
		}
		await using cold = new WorkflowPeer(config.cwd, config.env);
		await cold.ready.promise;
		expect(JSON.stringify(await cold.request("session/list", { workspace: config.workspace }))).toContain(sessionId);
		const runs = await savedRuns(cold, config.workspace, name);
		expect(runs.runs).toContainEqual(
			expect.objectContaining({ runId, status: "completed", parentSessionId: sessionId }),
		);
		const sessionRuns = v4ConversationWorkflowRunsResultSchema.parse(
			await cold.request("v4/conversation/workflowRuns", { sessionId, limit: 10 }),
		);
		expect(sessionRuns.runs).toContainEqual(expect.objectContaining({ runId, status: "completed" }));
		const artifacts = v4ConversationWorkflowRunArtifactsResultSchema.parse(
			await cold.request("v4/conversation/workflowRunArtifacts", { sessionId, runId }),
		);
		expect(artifacts.artifacts).toContainEqual(
			expect.objectContaining({ id: "proof", kind: "markdown", version: 1 }),
		);
		const content = v4ConversationWorkflowRunArtifactReadResultSchema.parse(
			await cold.request("v4/conversation/workflowRunArtifactRead", {
				sessionId,
				runId,
				artifactId: "proof",
				version: 1,
				offset: 0,
				limit: 4096,
			}),
		);
		expect(Buffer.from(content.dataBase64, "base64").toString("utf8")).toBe(markdown);
		expect(content.totalBytes).toBe(Buffer.byteLength(markdown));
		expect(content.nextOffset).toBeNull();
		await cold.request("workflows/delete", { workspace: config.workspace, name });
		expect(
			LegacyProtocol.zcodeWorkflowsForRunResultSchema.parse(
				await cold.request("workflows/forRun", { workspace: config.workspace, runId }),
			).entry,
		).toBeUndefined();
		expect(
			LegacyProtocol.zcodeWorkflowsSaveResultSchema.parse(
				await cold.request("workflows/save", {
					workspace: config.workspace,
					runId,
					name,
					meta: { description: "Saved actual run" },
				}),
			),
		).toMatchObject({ ok: true, path: file, overwritten: false });
		const saved = LegacyProtocol.zcodeWorkflowsGetResultSchema.parse(
			await cold.request("workflows/get", { workspace: config.workspace, name }),
		);
		expect(saved).toMatchObject({ ok: true, script });
		expect((await fs.readFile(file, "utf8")).endsWith(`*/\n${script}`)).toBe(true);
		const reopened = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await cold.request("session/resume", { sessionId }),
		);
		expect(reopened.session.sessionId).toBe(sessionId);
		const rows = v4ConversationRowsRangeResultSchema.parse(
			await cold.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
		);
		expect(JSON.stringify(rows)).toContain(runId);
		expect(config.requests).toEqual([]);
		await cold.close();
	}, 120_000);
});
