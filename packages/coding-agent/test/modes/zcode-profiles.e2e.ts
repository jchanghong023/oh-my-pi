import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { LegacyProtocol } from "../../src/modes/zcode/schema";

type Frame = Record<string, unknown>;
const model = { providerId: "profiles-local", modelId: "profile-chat" };
async function bounded<T>(promise: Promise<T>): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Profile CLI timed out")), 30_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// 仅启动隔离配置的真实 CLI；provider 使用本机 HTTP，不替换原生 session/runtime。
class ProfilePeer {
	readonly child!: Subprocess<"pipe", "pipe", "pipe">;
	readonly stderr: Promise<string>;
	#queue: Frame[] = [];
	#changed = Promise.withResolvers<void>();
	#ended = false;
	#failure: unknown;
	#pump: Promise<void>;
	#id = 0;
	constructor(
		cwd: string,
		env: NodeJS.ProcessEnv,
		profile: string,
		readonly holdPreferences = false,
	) {
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
				"--profile",
				profile,
			],
			{ cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		this.stderr = new Response(this.child.stderr).text();
		this.#pump = (async () => {
			try {
				for await (const frame of readJsonl<unknown>(this.child.stdout)) {
					if (!isRecord(frame)) throw new Error("Invalid CLI frame");
					if (typeof frame.method === "string" && frame.id !== undefined) {
						if (!(holdPreferences && frame.method === "session/requestRuntimePreferences")) {
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
		const id = `profile-${++this.#id}`;
		this.write({ id, method, params });
		return this.next(frame => frame.id === id);
	}
	async request(method: string, params: unknown): Promise<unknown> {
		const reply = await this.reply(method, params);
		if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
		return reply.result;
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
	for (const directory of [cwd, home, configRoot]) await fs.mkdir(directory, { recursive: true });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const requests: string[] = [];
	const authorizations: Array<string | null> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model: string; messages: unknown[] };
			requests.push(body.model);
			authorizations.push(request.headers.get("authorization"));
			if (JSON.stringify(body.messages).includes("PROFILE_HOLD")) {
				entered.resolve();
				await release.promise;
			}
			const chunk = (delta: unknown, finish: string | null = null) =>
				`data: ${JSON.stringify({ id: "profile-request", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			return new Response(
				chunk({ role: "assistant", content: "profile complete" }) + chunk({}, "stop") + "data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	for (const name of ["alpha", "beta"]) {
		const agent = path.join(configRoot, "profiles", name, "agent");
		await fs.mkdir(agent, { recursive: true });
		await fs.writeFile(
			path.join(agent, "models.yml"),
			`providers:\n  profiles-local:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: apiKey\n    apiKey: fixture-${name}-local-only\n    api: openai-completions\n    models:\n      - id: profile-chat\n        reasoning: false\n      - id: profile-other\n        reasoning: false\n`,
		);
		await fs.writeFile(
			path.join(agent, "config.yml"),
			"modelRoles:\n  default: profiles-local/profile-chat\n  smol: profiles-local/profile-chat\ntools:\n  xdev: false\n",
		);
	}
	return {
		cwd,
		configRoot,
		workspace: { workspacePath: cwd, workspaceKey: "profile-workspace", workspaceIdentity: "profile-workspace" },
		entered,
		release,
		requests,
		authorizations,
		env: {
			PATH: Bun.env.PATH,
			SystemRoot: Bun.env.SystemRoot,
			WINDIR: Bun.env.WINDIR,
			HOME: home,
			USERPROFILE: home,
			TEMP: root.path(),
			TMP: root.path(),
			OMP_CONFIG_ROOT: configRoot,
			OMP_PROFILE: "beta",
			PI_PROFILE: "beta",
			OMP_OFFLINE: "0",
			PI_NO_TITLE: "1",
			NO_PROXY: "127.0.0.1,localhost",
		},
		async [Symbol.asyncDispose]() {
			release.resolve();
			await server.stop(true);
		},
	};
}
async function create(peer: ProfilePeer, workspace: object) {
	return LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
		await peer.request("session/create", { workspace, model, titleGenerationEnabled: false }),
	).session.sessionId;
}
async function roles(peer: ProfilePeer, sessionId: string) {
	const value = await peer.request("session/configure", { sessionId, operation: "get_model_roles" });
	if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.roles))
		throw new Error("Missing native roles");
	return value.data.roles as Array<{ roleId: string; revision: string; userValue?: string }>;
}
async function idle(peer: ProfilePeer, sessionId: string) {
	await bounded(
		(async () => {
			for (;;) {
				const state = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
					await peer.request("session/read", { sessionId }),
				);
				if (state.projection.status === "idle") return;
				await Bun.sleep(10);
			}
		})(),
	);
}

async function profileIdentity(peer: ProfilePeer, workspace: object) {
	const value = await peer.request("omp/profiles/list", { workspace });
	if (
		!isRecord(value) ||
		typeof value.configRoot !== "string" ||
		!value.configRoot ||
		typeof value.storageScope !== "string" ||
		!value.storageScope ||
		(value.activeProfile !== null && typeof value.activeProfile !== "string")
	)
		throw new Error("Missing native profile storage identity");
	return { configRoot: value.configRoot, storageScope: value.storageScope, activeProfile: value.activeProfile };
}

test("native CLI profile precedence, read-only discovery and strict canonical validation", async () => {
	await using root = await TempDir.create("@zcode-profiles-list-");
	await using fx = await fixture(root);
	await using peer = new ProfilePeer(fx.cwd, fx.env, "alpha");
	await peer.ready();
	expect(await peer.request("runtime/capabilities", {})).toMatchObject({ ompProfiles: true });
	const before = await fs.readdir(path.join(fx.configRoot, "profiles"));
	expect(
		await peer.request("omp/profiles/list", { workspace: fx.workspace, candidate: " new-profile " }),
	).toMatchObject({
		activeProfile: "alpha",
		configRoot: fx.configRoot,
		profiles: [
			{ name: null, active: false },
			{ name: "alpha", active: true },
			{ name: "beta", active: false },
		],
		candidate: "new-profile",
	});
	expect(await fs.readdir(path.join(fx.configRoot, "profiles"))).toEqual(before);
	expect(before).not.toContain("new-profile");
	for (const candidate of ["CAPS", "../escape", "con", "trailing.", "a".repeat(65)])
		expect((await peer.reply("omp/profiles/list", { workspace: fx.workspace, candidate })).error).toBeDefined();
	expect(await peer.request("omp/profiles/list", { workspace: fx.workspace, candidate: "default" })).toMatchObject({
		candidate: null,
	});
	expect((await peer.reply("omp/profiles/list", { workspace: fx.workspace, unexpected: true })).error).toBeDefined();
	expect(
		(await peer.reply("omp/profiles/list", { workspace: { ...fx.workspace, workspacePath: root.join("other") } }))
			.error,
	).toBeDefined();
}, 90_000);

test("default profile scope follows the effective agent data root and survives restart", async () => {
	await using root = await TempDir.create("@zcode-profiles-agent-root-");
	await using fx = await fixture(root);
	const firstRoot = root.join("first-agent");
	const secondRoot = root.join("second-agent");
	for (const agent of [firstRoot, secondRoot])
		await fs.cp(path.join(fx.configRoot, "profiles", "alpha", "agent"), agent, { recursive: true });
	let firstScope: string;
	let firstSession: string;
	{
		await using first = new ProfilePeer(fx.cwd, { ...fx.env, PI_CODING_AGENT_DIR: firstRoot }, "default");
		await first.ready();
		const identity = await profileIdentity(first, fx.workspace);
		expect(identity).toMatchObject({ configRoot: fx.configRoot, activeProfile: null });
		firstScope = identity.storageScope;
		firstSession = await create(first, fx.workspace);
		await first.request("session/send", { sessionId: firstSession, content: "DEFAULT_ROOT_PERSISTENCE" });
		await idle(first, firstSession);
	}
	{
		await using second = new ProfilePeer(fx.cwd, { ...fx.env, PI_CODING_AGENT_DIR: secondRoot }, "default");
		await second.ready();
		const identity = await profileIdentity(second, fx.workspace);
		expect(identity).toMatchObject({ configRoot: fx.configRoot, activeProfile: null });
		expect(identity.storageScope).not.toBe(firstScope);
		expect((await second.reply("session/read", { sessionId: firstSession })).error).toBeDefined();
	}
	{
		await using restarted = new ProfilePeer(fx.cwd, { ...fx.env, PI_CODING_AGENT_DIR: firstRoot }, "default");
		await restarted.ready();
		expect((await profileIdentity(restarted, fx.workspace)).storageScope).toBe(firstScope);
		expect((await restarted.reply("session/read", { sessionId: firstSession })).error).toBeUndefined();
	}
}, 90_000);

test.skipIf(process.platform !== "linux")(
	"offline profile scope matches its persistent storage domain",
	async () => {
		await using root = await TempDir.create("@zcode-profiles-offline-scope-");
		await using fx = await fixture(root);
		const offlineEnv = { ...fx.env, OMP_OFFLINE: "1" };
		const offline = getOfflineShmState(offlineEnv);
		if (!offline) throw new Error("Missing Linux offline runtime");
		try {
			for (const profile of ["default", "alpha"]) {
				let scope: string;
				{
					await using persistent = new ProfilePeer(fx.cwd, fx.env, profile);
					await persistent.ready();
					scope = (await profileIdentity(persistent, fx.workspace)).storageScope;
				}
				for (let restart = 0; restart < 2; restart++) {
					await using peer = new ProfilePeer(fx.cwd, offlineEnv, profile);
					await peer.ready();
					expect(await profileIdentity(peer, fx.workspace)).toEqual({
						configRoot: fx.configRoot,
						activeProfile: profile === "default" ? null : profile,
						storageScope: scope,
					});
				}
			}
		} finally {
			await fs.rm(path.dirname(offline.runtimeRoot), { recursive: true, force: true });
		}
	},
	90_000,
);

test("two real profile processes isolate role persistence and session discovery across restart", async () => {
	await using root = await TempDir.create("@zcode-profiles-isolation-");
	await using fx = await fixture(root);
	let alphaId: string;
	let alphaScope: string;
	{
		await using alpha = new ProfilePeer(fx.cwd, fx.env, "alpha");
		await alpha.ready();
		const identity = await profileIdentity(alpha, fx.workspace);
		expect(identity).toMatchObject({ configRoot: fx.configRoot, activeProfile: "alpha" });
		alphaScope = identity.storageScope;
		alphaId = await create(alpha, fx.workspace);
		const role = (await roles(alpha, alphaId)).find(value => value.roleId === "default")!;
		await alpha.request("session/configure", {
			sessionId: alphaId,
			operation: "set_model_role",
			roleId: "default",
			scope: "user",
			expectedRevision: role.revision,
			selection: { kind: "model", model: { provider: "profiles-local", modelId: "profile-other" } },
		});
		expect((await roles(alpha, alphaId)).find(value => value.roleId === "default")?.userValue).toBe(
			"profiles-local/profile-other",
		);
		await alpha.request("session/send", { sessionId: alphaId, content: "PROFILE_PERSISTED_ALPHA" });
		await idle(alpha, alphaId);
		expect(fx.authorizations.at(-1)).toBe("Bearer fixture-alpha-local-only");
	}
	{
		await using beta = new ProfilePeer(fx.cwd, fx.env, "beta");
		await beta.ready();
		const identity = await profileIdentity(beta, fx.workspace);
		expect(identity).toMatchObject({ configRoot: fx.configRoot, activeProfile: "beta" });
		expect(identity.storageScope).not.toBe(alphaScope);
		const betaId = await create(beta, fx.workspace);
		expect((await roles(beta, betaId)).find(value => value.roleId === "default")?.userValue).toBe(
			"profiles-local/profile-chat",
		);
		expect((await beta.reply("session/read", { sessionId: alphaId })).error).toBeDefined();
		await beta.request("session/send", { sessionId: betaId, content: "PROFILE_PERSISTED_BETA" });
		await idle(beta, betaId);
		expect(fx.authorizations.at(-1)).toBe("Bearer fixture-beta-local-only");
	}
	{
		await using alpha = new ProfilePeer(fx.cwd, fx.env, "alpha");
		await alpha.ready();
		const identity = await profileIdentity(alpha, fx.workspace);
		expect(identity).toMatchObject({ configRoot: fx.configRoot, activeProfile: "alpha" });
		expect(identity.storageScope).toBe(alphaScope);
		const id = await create(alpha, fx.workspace);
		expect((await roles(alpha, id)).find(value => value.roleId === "default")?.userValue).toBe(
			"profiles-local/profile-other",
		);
		expect((await alpha.reply("session/read", { sessionId: alphaId })).error).toBeUndefined();
	}
}, 90_000);

test("successful session deletion leaves no permanent profile preparation blocker", async () => {
	await using root = await TempDir.create("@zcode-profiles-deleted-");
	await using fx = await fixture(root);
	await using peer = new ProfilePeer(fx.cwd, fx.env, "alpha");
	await peer.ready();
	const sessionId = await create(peer, fx.workspace);
	expect(
		await peer.request("v4/command", {
			commandId: crypto.randomUUID(),
			clientId: "profile-delete-host",
			sessionId,
			type: "deleteSession",
			payload: {},
			issuedAt: Date.now(),
		}),
	).toMatchObject({ status: "accepted" });
	expect((await peer.reply("session/read", { sessionId })).error).toBeDefined();
	expect(
		await peer.request("omp/profiles/prepareSwitch", {
			workspace: fx.workspace,
			expectedProfile: "alpha",
		}),
	).toMatchObject({ ready: true });
}, 90_000);

test("inflight/native execution blocks preparation; atomic barrier rejects races, stale tokens and releases on EOF", async () => {
	await using root = await TempDir.create("@zcode-profiles-barrier-");
	await using fx = await fixture(root);
	{
		await using peer = new ProfilePeer(fx.cwd, fx.env, "alpha", true);
		await peer.ready();
		const creating = create(peer, fx.workspace);
		const preference = await peer.next(frame => frame.method === "session/requestRuntimePreferences");
		const busy = await peer.request("omp/profiles/prepareSwitch", {
			workspace: fx.workspace,
			expectedProfile: "alpha",
		});
		expect(busy).toMatchObject({
			ready: false,
			blockers: expect.arrayContaining([expect.objectContaining({ code: "inflightDispatch" })]),
		});
		peer.write({ id: preference.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false } });
		const id = await creating;
		await peer.request("session/send", { sessionId: id, content: "PROFILE_HOLD" });
		await bounded(fx.entered.promise);
		expect(
			await peer.request("omp/profiles/prepareSwitch", { workspace: fx.workspace, expectedProfile: "alpha" }),
		).toMatchObject({ ready: false });
		await peer.request("session/send", { sessionId: id, inputId: "queued-profile-input", content: "PROFILE_QUEUED" });
		expect(
			await peer.request("omp/profiles/prepareSwitch", { workspace: fx.workspace, expectedProfile: "alpha" }),
		).toMatchObject({
			ready: false,
			blockers: expect.arrayContaining([expect.objectContaining({ code: "queuedInput" })]),
		});
		fx.release.resolve();
		await idle(peer, id);
		// 不用 close 探测 idle；业务完成并原生关闭后才准备真正切换。
		await peer.request("session/close", { sessionId: id });
		const prepared = await peer.request("omp/profiles/prepareSwitch", {
			workspace: fx.workspace,
			expectedProfile: "alpha",
		});
		if (!isRecord(prepared) || prepared.ready !== true || typeof prepared.token !== "string")
			throw new Error(`Not prepared: ${JSON.stringify(prepared)}`);
		const raced = await Promise.all([
			peer.reply("session/create", { workspace: fx.workspace, model }),
			peer.reply("omp/profiles/prepareSwitch", { workspace: fx.workspace, expectedProfile: "alpha" }),
		]);
		expect(raced[0]!.error).toMatchObject({ data: { kind: "omp.profileSwitchPrepared" } });
		expect(raced[1]!.result).toMatchObject({ ready: false });
		expect(await peer.request("omp/profiles/cancelSwitch", { workspace: fx.workspace, token: "wrong" })).toEqual({
			cancelled: false,
		});
		expect(
			await peer.request("omp/profiles/cancelSwitch", {
				workspace: { ...fx.workspace, workspaceIdentity: "other-owner" },
				token: prepared.token,
			}),
		).toEqual({ cancelled: false });
		expect((await peer.reply("session/create", { workspace: fx.workspace, model })).error).toBeDefined();
		expect(await peer.request("omp/profiles/list", { workspace: fx.workspace })).toMatchObject({
			activeProfile: "alpha",
		});
		expect(
			await peer.request("omp/profiles/cancelSwitch", { workspace: fx.workspace, token: prepared.token }),
		).toEqual({ cancelled: true });
		expect(
			(await peer.reply("omp/profiles/prepareSwitch", { workspace: fx.workspace, expectedProfile: "beta" })).error,
		).toBeDefined();
		expect(
			await peer.request("omp/profiles/prepareSwitch", { workspace: fx.workspace, expectedProfile: "alpha" }),
		).toMatchObject({ ready: true });
		expect(await peer.eof()).toBe(0);
	}
	await using restarted = new ProfilePeer(fx.cwd, fx.env, "beta");
	await restarted.ready();
	expect(
		await restarted.request("omp/profiles/prepareSwitch", { workspace: fx.workspace, expectedProfile: "beta" }),
	).toMatchObject({ ready: true });
	expect(await restarted.eof()).toBe(0);
}, 90_000);
