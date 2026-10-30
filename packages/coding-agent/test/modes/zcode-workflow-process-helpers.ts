import { expect } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { LegacyProtocol, commandAckSchema } from "../../src/modes/zcode/schema";
import "../../src/tools"; // Runtime input of the spawned CLI for Bun --changed.

type Frame = Record<string, unknown>;
const executable = Bun.env.OMP_ZCODE_TEST_EXECUTABLE?.trim();
if (executable && !path.isAbsolute(executable)) throw new Error("OMP_ZCODE_TEST_EXECUTABLE must be absolute");
const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

const activePeers = new Set<WorkflowPeer>();
export async function disposeWorkflowPeers(): Promise<void> {
	// A timed-out test may never unwind its await-using scope. Retain ownership of its child.
	for (const peer of activePeers) await peer[Symbol.asyncDispose]();
}
/** A real stdio peer: no imported server, session manager, compiler or journal substitutes. */
export class WorkflowPeer {
	readonly child: Subprocess<"pipe", "pipe", "pipe">;
	readonly stderr: Promise<string>;
	readonly pending = new Map<string, PromiseWithResolvers<Frame>>();
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
					if (frame.method === "subagents/readRuntimeConfig" && frame.id !== undefined) {
						child.stdin.write(
							`${JSON.stringify({
								id: frame.id,
								error: { code: -32601, message: "Fixture host does not implement subagents/readRuntimeConfig" },
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

export async function fixture(root: TempDir) {
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
	// 常量工作流只验证执行与拒绝边界，禁用技能以免后台描述压缩污染零模型请求断言。
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: workflow-fixture/constant-host\n  smol: workflow-fixture/constant-host\nskills:\n  enabled: false\ntools:\n  xdev: false\n",
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

export function definition(script: string, description = "Real sandbox proof") {
	return `/* zcode-workflow\ndescription: ${description}\nargs:\n  topic:\n    type: string\n    required: true\n*/\n${script}`;
}

export async function create(peer: WorkflowPeer, workspace: { workspacePath: string; workspaceKey: string }) {
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

export async function start(peer: WorkflowPeer, sessionId: string, name: string, args: Record<string, unknown>) {
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

export async function savedRuns(
	peer: WorkflowPeer,
	workspace: { workspacePath: string; workspaceKey: string },
	name: string,
) {
	return LegacyProtocol.zcodeWorkflowsRunsResultSchema.parse(
		await peer.request("workflows/runs", { workspace, name, limit: 10 }),
	);
}

export async function completed(
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
