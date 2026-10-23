import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { LegacyProtocol as L, zcodeSessionConfigureResultSchema } from "../../src/modes/zcode/schema";

type Frame = Record<string, unknown>;
const selection = { providerId: "workspace-local", modelId: "helper" };
async function bounded<T>(promise: Promise<T>): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Workspace CLI timed out")), 30_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// 真实 NDJSON app-server，沿用 process fixture 的 owner EOF 与反向请求应答方式。
class Peer {
	readonly child!: Subprocess<"pipe", "pipe", "pipe">;
	readonly stderr: Promise<string>;
	readonly frames: Frame[] = [];
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
				for await (const frame of readJsonl<unknown>(this.child.stdout)) {
					if (!isRecord(frame) || "jsonrpc" in frame || "type" in frame) throw new Error("Invalid CLI frame");
					this.frames.push(frame);
					if (typeof frame.method === "string" && frame.id !== undefined) {
						const result =
							frame.method === "session/requestRuntimePreferences"
								? { nativeSearchEnhancementsEnabled: false, memoryEnabled: false }
								: frame.method === "subagents/readRuntimeConfig"
									? {
											kind: "ready",
											profiles: [],
											builtInModelSelectionOverrides: {},
											pluginAgentModelSelectionOverrides: {},
										}
									: undefined;
						this.write(
							result === undefined
								? { id: frame.id, error: { code: -32601, message: "No fixture handler" } }
								: { id: frame.id, result },
						);
					}
					this.#queue.push(frame);
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
		return bounded(
			(async () => {
				for (;;) {
					if (this.#failure) throw this.#failure;
					const index = this.#queue.findIndex(predicate);
					if (index >= 0) return this.#queue.splice(index, 1)[0]!;
					if (this.#ended) throw new Error(`CLI exited: ${await this.stderr}`);
					await this.#changed.promise;
				}
			})(),
		);
	}
	async reply(method: string, params: unknown): Promise<Frame> {
		const id = `workspace-${++this.#id}`;
		this.write({ id, method, params });
		return this.next(frame => frame.id === id);
	}
	async request(method: string, params: unknown): Promise<unknown> {
		const frame = await this.reply(method, params);
		if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
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
		if (this.#failure) throw this.#failure;
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
	for (const directory of [cwd, home, agentDir]) await fs.mkdir(directory, { recursive: true });
	const requests: Array<{
		model: string;
		messages: unknown[];
		tools?: unknown[];
		max_tokens?: number;
		max_completion_tokens?: number;
	}> = [];
	const entered = new Map<string, PromiseWithResolvers<void>>();
	const releases = new Map<string, PromiseWithResolvers<void>>();
	const waitFor = (marker: string) => {
		let gate = entered.get(marker);
		if (!gate) entered.set(marker, (gate = Promise.withResolvers<void>()));
		return bounded(gate.promise);
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions")
				return new Response("Unexpected endpoint", { status: 500 });
			const body = (await request.json()) as (typeof requests)[number];
			requests.push(body);
			const text = JSON.stringify(body.messages);
			const marker = text.match(/WORKSPACE_[A-Z]+/u)?.[0] ?? "WORKSPACE_COMMIT";
			let gate = entered.get(marker);
			if (!gate) entered.set(marker, (gate = Promise.withResolvers<void>()));
			gate.resolve();
			if (marker.startsWith("WORKSPACE_HOLD") || marker === "WORKSPACE_EOF") {
				const release = Promise.withResolvers<void>();
				releases.set(marker, release);
				await release.promise;
			}
			const chunk = (delta: unknown, finish: string | null = null) =>
				`data: ${JSON.stringify({ id: marker, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			if (marker === "WORKSPACE_TOOLS")
				return new Response(
					chunk({
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "fixture-call",
								type: "function",
								function: { name: "fixture_only", arguments: '{"value":"safe"}' },
							},
						],
					}) +
						chunk({}, "tool_calls") +
						"data: [DONE]\n\n",
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			return new Response(
				chunk({ role: "assistant", content: `${marker} complete` }) + chunk({}, "stop") + "data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  workspace-local:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: apiKey\n    apiKey: fixture-local-only\n    api: openai-completions\n    models:\n      - id: helper\n        reasoning: false\n`,
	);
	const configFile = path.join(agentDir, "config.yml");
	await fs.writeFile(
		configFile,
		"modelRoles:\n  default: workspace-local/helper\n  smol: workspace-local/helper\ntools:\n  xdev: false\n",
	);
	return {
		cwd,
		agentDir,
		configFile,
		requests,
		waitFor,
		workspace: { workspacePath: cwd, workspaceKey: "workspace-helper", workspaceIdentity: "workspace-helper" },
		release: (marker: string) => releases.get(marker)?.resolve(),
		env: {
			PATH: Bun.env.PATH,
			SystemRoot: Bun.env.SystemRoot,
			WINDIR: Bun.env.WINDIR,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: agentDir,
			OMP_CONFIG_ROOT: configRoot,
			XDG_CONFIG_HOME: configRoot,
			PI_NO_TITLE: "1",
			OMP_OFFLINE: "0",
			NO_PROXY: "127.0.0.1,localhost",
			TEMP: root.path(),
			TMP: root.path(),
		},
		async [Symbol.asyncDispose]() {
			for (const release of releases.values()) release.resolve();
			await server.stop(true);
		},
	};
}

test("workspace completion keeps Host commit generation independent, cancellable and EOF-owned", async () => {
	await using root = await TempDir.create("@zcode-workspace-text-");
	await using f = await fixture(root);
	await using peer = new Peer(f.cwd, f.env);
	await peer.ready();
	const params = { workspace: f.workspace, selection, querySource: "git_commit_message" };
	const completed = L.zcodeWorkspaceGenerateTextResultSchema.parse(
		await peer.request("workspace/generateText", { ...params, prompt: "WORKSPACE_COMMIT" }),
	);
	expect(completed).toMatchObject({ text: "WORKSPACE_COMMIT complete", selection, finishReason: "stop" });
	expect(f.requests[0]!.tools).toBeUndefined();
	const sessions = await peer.request("session/list", { workspace: f.workspace });
	expect(sessions).toMatchObject({ sessions: [] });

	const a = peer.reply("workspace/generateText", { ...params, prompt: "WORKSPACE_HOLDA", operationId: "a" });
	const b = peer.reply("workspace/generateText", { ...params, prompt: "WORKSPACE_HOLDB", operationId: "b" });
	await Promise.all([f.waitFor("WORKSPACE_HOLDA"), f.waitFor("WORKSPACE_HOLDB")]);
	expect(
		(await peer.reply("workspace/generateText", { ...params, prompt: "duplicate", operationId: "a" })).error,
	).toMatchObject({ code: -32600 });
	const blocked = await peer.request("omp/profiles/prepareSwitch", { workspace: f.workspace, expectedProfile: null });
	expect(blocked).toMatchObject({
		ready: false,
		blockers: expect.arrayContaining([expect.objectContaining({ code: "inflightDispatch" })]),
	});
	expect(await peer.request("workspace/cancelGenerateText", { operationId: "unknown" })).toEqual({
		operationId: "unknown",
		cancelled: false,
	});
	expect(await peer.request("workspace/cancelGenerateText", { operationId: "a" })).toEqual({
		operationId: "a",
		cancelled: true,
	});
	expect((await a).error).toMatchObject({ code: expect.any(Number) });
	f.release("WORKSPACE_HOLDB");
	expect(L.zcodeWorkspaceGenerateTextResultSchema.parse((await b).result).text).toBe("WORKSPACE_HOLDB complete");
	expect(await peer.request("workspace/cancelGenerateText", { operationId: "a" })).toEqual({
		operationId: "a",
		cancelled: false,
	});
	expect(
		(
			(await peer.request("workspace/generateText", {
				...params,
				messages: [
					{ role: "system", content: "system instruction" },
					{ role: "user", content: "WORKSPACE_MESSAGES" },
				],
				prompt: "ignored",
				operationId: "a",
				maxOutputTokens: 37,
			})) as { text: string }
		).text,
	).toBe("WORKSPACE_MESSAGES complete");
	expect(JSON.stringify(f.requests.at(-1)!.messages)).not.toContain("ignored");
	expect(f.requests.at(-1)!.max_tokens ?? f.requests.at(-1)!.max_completion_tokens).toBe(37);
	const beforeTools = f.requests.length;
	const tools = L.zcodeWorkspaceGenerateTextResultSchema.parse(
		await peer.request("workspace/generateText", {
			...params,
			prompt: "WORKSPACE_TOOLS",
			tools: [
				{
					name: "fixture_only",
					description: "Return only; never execute",
					inputSchema: { type: "object", properties: { value: { type: "string" } } },
				},
			],
		}),
	);
	expect(tools.toolCalls).toEqual([{ id: "fixture-call", name: "fixture_only", input: { value: "safe" } }]);
	expect(f.requests).toHaveLength(beforeTools + 1);

	peer.write({
		id: "eof",
		method: "workspace/generateText",
		params: { ...params, prompt: "WORKSPACE_EOF", operationId: "eof" },
	});
	await f.waitFor("WORKSPACE_EOF");
	expect(await peer.eof()).toBe(0);
	expect(peer.frames.some(frame => frame.id === "eof")).toBe(false);
}, 120_000);

test("Team wire errors preserve distinct revision and invalid-config codes with write receipts", async () => {
	await using root = await TempDir.create("@zcode-team-errors-");
	await using f = await fixture(root);
	await using peer = new Peer(f.cwd, f.env);
	await peer.ready();
	const created = L.zcodeSessionStateSnapshotSchema.parse(
		await peer.request("session/create", { workspace: f.workspace, model: selection, titleGenerationEnabled: false }),
	);
	const sessionId = created.session.sessionId;
	const read = zcodeSessionConfigureResultSchema.parse(
		await peer.request("session/configure", { sessionId, operation: "get_team_config" }),
	);
	if (read.operation !== "get_team_config") throw new Error("Expected Team configuration");
	const save = {
		sessionId,
		operation: "set_team_config",
		scope: "user",
		members: [],
		expectedRevision: read.data.revision,
	};
	await peer.request("session/configure", save);
	const conflict = await peer.reply("session/configure", save);
	expect(conflict.error).toMatchObject({
		code: -32000,
		data: {
			code: "revision_conflict",
			saveState: "failed",
			config: expect.any(Object),
			writes: { active: { status: "not_attempted" }, persistent: { status: "not_attempted" } },
		},
	});
	await fs.writeFile(f.configFile, "team: invalid-parent\n");
	const invalid = await peer.reply("session/configure", save);
	expect(invalid.error).toMatchObject({
		code: -32000,
		data: {
			code: "invalid_config",
			saveState: "failed",
			issues: expect.any(Array),
			writes: { active: { status: "not_attempted" }, persistent: { status: "not_attempted" } },
		},
	});
}, 120_000);
