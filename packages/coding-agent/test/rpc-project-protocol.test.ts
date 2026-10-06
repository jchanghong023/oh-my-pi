import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { type } from "@oh-my-pi/omptype";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Requirements §4/§13—§15 (rpc-ui-protocol.md): project-mode E2E against the
// real public entry (`omp --mode rpc-ui --rpc-project`, project root fixed by
// the startup cwd): ready identity, the v3 gate, zero-session catalogs, the
// multi-session lifecycle over one process, prompt text mode, strict
// execute_command and EOF ordered exit. Sessions persist (no --no-session)
// into isolated temp dirs; no model turn is ever awaited — the one accepted
// prompt is aborted immediately and its session closed with cancelRunning.

type RpcFrame = Record<string, unknown>;
const LoadedSummary = type({ sessionId: "string", sessionGeneration: "string", loadState: "string" });
const SessionDirectory = type({ sessions: "unknown[]" });

interface ProjectRpcServerDirs {
	/** Project root: the spawn cwd; fixed for the process lifetime. */
	readonly cwd: string;
	readonly sessionDir: string;
	readonly agentDir: string;
	readonly extensionPath?: string;
}

interface ServerControls {
	readonly closeStdin: () => void;
	readonly exited: Promise<number>;
	readonly sendRaw: (frame: object) => void;
}

async function withProjectRpcServer<T>(
	dirs: ProjectRpcServerDirs,
	run: (
		send: (frame: object) => void,
		next: (predicate?: (frame: RpcFrame) => boolean) => Promise<RpcFrame>,
		seen: readonly RpcFrame[],
		controls: ServerControls,
	) => Promise<T>,
): Promise<T> {
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc-ui",
			"--rpc-project",
			...(dirs.extensionPath ? ["--trusted-extension", dirs.extensionPath] : ["--no-extensions"]),
			"--no-skills",
			"--no-tools",
			"--session-dir",
			dirs.sessionDir,
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: dirs.cwd,
			env: {
				...Bun.env,
				PI_NO_TITLE: "1",
				PI_CODING_AGENT_DIR: dirs.agentDir,
				// Upstream #13689: rebuilding a session fails closed when its saved
				// model cannot be restored. The isolated agent dir has no stored
				// credentials, so give the restore check a configured key.
				ANTHROPIC_API_KEY: "test-key",
			} as unknown as Record<string, string | undefined>,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();
	/** Every parsed frame in arrival order (survives next()'s queue pruning). */
	const seen: RpcFrame[] = [];
	const queue: RpcFrame[] = [];
	const generations = new Map<string, string>();
	let readerDone = false;
	let readerError: unknown;
	const lines = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>);
	const pump = (async () => {
		try {
			for await (const line of lines) {
				if (isRecord(line)) {
					if (
						line.type === "response" &&
						line.success === true &&
						isRecord(line.data) &&
						typeof line.data.sessionId === "string" &&
						typeof line.data.sessionGeneration === "string"
					) {
						generations.set(line.data.sessionId, line.data.sessionGeneration);
					}
					seen.push(line);
					queue.push(line);
				}
			}
		} catch (error) {
			readerError = error;
		} finally {
			readerDone = true;
		}
	})();
	const sendRaw = (frame: object): void => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	const send = (frame: object): void => {
		const fields = frame as RpcFrame;
		const generation = typeof fields.sessionId === "string" ? generations.get(fields.sessionId) : undefined;
		sendRaw(
			generation && !Object.hasOwn(fields, "sessionGeneration")
				? { ...fields, sessionGeneration: generation }
				: fields,
		);
	};
	const next = async (predicate?: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
		const match = predicate ?? (frame => frame.type === "response");
		for (let waited = 0; waited < 300; waited++) {
			const responseIndex = queue.findIndex(match);
			if (responseIndex !== -1) return queue.splice(responseIndex, 1)[0]!;
			if (readerDone) throw new Error(`RPC stream ended early: ${await stderrPromise} ${String(readerError ?? "")}`);
			await Bun.sleep(100);
		}
		throw new Error(`Timed out waiting for RPC frame; last frames: ${JSON.stringify(seen.slice(-8)).slice(0, 1200)}`);
	};
	const controls: ServerControls = {
		closeStdin: () => {
			child.stdin.end();
		},
		exited: child.exited,
		sendRaw,
	};
	try {
		await child.stdin.flush?.();
		return await run(send, next, seen, controls);
	} finally {
		try {
			child.stdin.end();
		} catch {}
		child.kill();
		await child.exited.catch(() => {});
		await pump.catch(() => {});
		await stderrPromise.catch(() => {});
	}
}

/** Wait for the very first frame on the wire (the ready handshake). */
async function waitFirstFrame(seen: readonly RpcFrame[]): Promise<RpcFrame> {
	for (let waited = 0; waited < 300; waited++) {
		const first = seen[0];
		if (first) return first;
		await Bun.sleep(100);
	}
	throw new Error("Timed out waiting for the first RPC frame");
}

/** Wait for ready, then negotiate protocol version 3 (project commands' gate). */
async function negotiateV3(
	send: (frame: object) => void,
	next: (predicate?: (frame: RpcFrame) => boolean) => Promise<RpcFrame>,
): Promise<void> {
	await next(frame => frame.type === "ready");
	send({ id: "neg", type: "negotiate_protocol", protocolVersion: 3 });
	await expect(next(frame => frame.type === "response" && frame.id === "neg")).resolves.toMatchObject({
		id: "neg",
		command: "negotiate_protocol",
		success: true,
		data: { protocolVersion: 3 },
	});
}

/** Await the response frame for one request id. */
function responseFor(
	next: (predicate?: (frame: RpcFrame) => boolean) => Promise<RpcFrame>,
	id: string,
): Promise<RpcFrame> {
	return next(frame => frame.type === "response" && frame.id === id);
}

interface SessionSummaryLike {
	readonly sessionId: string;
	readonly name?: string;
	readonly loadState: string;
	readonly sessionGeneration?: string;
	readonly revision?: string;
}

function findSession(data: unknown, sessionId: string): SessionSummaryLike | undefined {
	return (data as { sessions: SessionSummaryLike[] }).sessions.find(summary => summary.sessionId === sessionId);
}

describe("rpc-ui project mode (live --rpc-project server)", () => {
	test("bash responds, permits cross-session queries and abort, and exits on EOF", async () => {
		await using temp = await TempDir.create("rpc-project-bash-");
		const cwd = path.resolve(temp.path());
		await withProjectRpcServer(
			{ cwd, sessionDir: path.join(cwd, "sessions"), agentDir: path.join(cwd, "agent") },
			async (send, next, _seen, controls) => {
				await negotiateV3(send, next);
				send({ id: "a", type: "create_session" });
				const a = (await responseFor(next, "a")).data as SessionSummaryLike;
				send({ id: "b", type: "create_session" });
				const b = (await responseFor(next, "b")).data as SessionSummaryLike;
				send({ id: "echo", type: "bash", sessionId: a.sessionId, command: "echo rpc-bash-result" });
				const echo = await responseFor(next, "echo");
				expect(echo.success).toBe(true);
				expect(JSON.stringify(echo.data)).toContain("rpc-bash-result");
				const waitForMarker = async (name: string): Promise<void> => {
					for (let i = 0; i < 100; i++) {
						if (await Bun.file(path.join(cwd, name)).exists()) return;
						await Bun.sleep(50);
					}
					throw new Error(`Bash never reached ${name}`);
				};
				send({ id: "long", type: "bash", sessionId: a.sessionId, command: "echo ready > long.ready; sleep 30" });
				await waitForMarker("long.ready");
				send({ id: "state-b", type: "get_state", sessionId: b.sessionId });
				expect(await Promise.race([responseFor(next, "state-b"), Bun.sleep(5_000).then(() => null)])).toMatchObject(
					{ success: true },
				);
				send({ id: "cancel", type: "abort_bash", sessionId: a.sessionId });
				expect((await responseFor(next, "cancel")).success).toBe(true);
				await responseFor(next, "long");
				send({ id: "eof-bash", type: "bash", sessionId: a.sessionId, command: "echo ready > eof.ready; sleep 30" });
				await waitForMarker("eof.ready");
				send({ id: "barrier", type: "get_state", sessionId: b.sessionId });
				await responseFor(next, "barrier");
				controls.closeStdin();
				expect(await Promise.race([controls.exited, Bun.sleep(10_000).then(() => -1)])).toBe(0);
			},
		);
	}, 60_000);

	test("rejects legacy replacement, stale execution and invalid role scopes", async () => {
		await using temp = await TempDir.create("rpc-project-guards-");
		const cwd = path.resolve(temp.path());
		await withProjectRpcServer(
			{ cwd, sessionDir: path.join(cwd, "sessions"), agentDir: path.join(cwd, "agent") },
			async (send, next) => {
				await negotiateV3(send, next);
				send({ id: "create", type: "create_session" });
				const a = (await responseFor(next, "create")).data as SessionSummaryLike;
				for (const type of ["new_session", "switch_session", "open_session", "set_session_name"]) {
					send({
						id: type,
						type,
						sessionId: a.sessionId,
						sessionPath: "unrelated.jsonl",
						sessionDir: cwd,
						entryId: "missing",
					});
					expect(await responseFor(next, type)).toMatchObject({ success: false, code: "unsupported" });
				}
				send({ id: "invalid-branch", type: "branch", sessionId: a.sessionId, entryId: "missing" });
				expect(await responseFor(next, "invalid-branch")).toMatchObject({ success: false, code: "invalid_params" });
				send({ id: "close", type: "close_session", sessionId: a.sessionId });
				await responseFor(next, "close");
				send({ id: "resume", type: "resume_session", sessionId: a.sessionId });
				const b = (await responseFor(next, "resume")).data as SessionSummaryLike;
				expect(b.sessionGeneration).not.toBe(a.sessionGeneration);
				send({
					id: "old",
					type: "execute_command",
					sessionId: a.sessionId,
					sessionGeneration: a.sessionGeneration,
					text: "/plan",
				});
				expect(await responseFor(next, "old")).toMatchObject({ success: false, code: "stale_session" });
				send({ id: "roles-before", type: "get_model_roles" });
				const before = (await responseFor(next, "roles-before")).data;
				for (const scope of ["project", "invalid"]) {
					send({ id: scope, type: "set_model_role", scope, roleId: "default", selection: { kind: "auto" } });
					expect(await responseFor(next, scope)).toMatchObject({ success: false, code: "scope_not_allowed" });
				}
				send({ id: "roles-after", type: "get_model_roles" });
				expect((await responseFor(next, "roles-after")).data).toEqual(before);
			},
		);
	}, 60_000);
	test("ready announces project mode identity and capabilities", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (_send, _next, seen) => {
			const ready = await waitFirstFrame(seen);
			expect(ready.type).toBe("ready");
			expect(ready.mode).toBe("rpc-ui-project");
			expect(path.resolve(String((ready.projectIdentity as { projectRoot: string }).projectRoot))).toBe(
				path.resolve(dirs.cwd),
			);
			expect(typeof ready.processInstanceId).toBe("string");
			expect(String(ready.processInstanceId).length).toBeGreaterThan(0);
			expect((ready.capabilities as Record<string, unknown>).multiSession).toBe(true);
			expect(ready.protocolVersion).toBe(1);
			expect(ready.supportedProtocolVersions).toEqual([3]);
		});
	}, 60_000);

	test("v3 negotiation gates project commands", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next) => {
			await next(frame => frame.type === "ready");

			// Project commands before negotiation: the gate throws and the
			// dispatcher reports it as an "unsupported" error frame.
			send({ id: "premature", type: "create_session", name: "too-early" });
			const gated = await responseFor(next, "premature");
			expect(gated).toMatchObject({ id: "premature", command: "create_session", success: false });
			expect(String(gated.error)).toMatch(/negotiate/i);
			expect(gated.code).toBe("unsupported");

			// Negotiate v3, then the same command succeeds.
			send({ id: "neg", type: "negotiate_protocol", protocolVersion: 3 });
			await expect(responseFor(next, "neg")).resolves.toMatchObject({
				id: "neg",
				command: "negotiate_protocol",
				success: true,
				data: { protocolVersion: 3 },
			});

			send({ id: "create-ok", type: "create_session", name: "after-negotiation" });
			const created = await responseFor(next, "create-ok");
			expect(created).toMatchObject({ id: "create-ok", command: "create_session", success: true });
			expect(typeof (created.data as SessionSummaryLike).sessionId).toBe("string");
			expect((created.data as SessionSummaryLike).loadState).toBe("loaded");
		});
	}, 60_000);

	test("zero-session catalog queries answer without creating sessions", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next) => {
			await negotiateV3(send, next);

			send({ id: "catalog", type: "get_available_commands" });
			const catalog = await responseFor(next, "catalog");
			expect(catalog).toMatchObject({ id: "catalog", command: "get_available_commands", success: true });
			const commands = (catalog.data as { commands: unknown[] }).commands;
			expect(Array.isArray(commands)).toBe(true);
			expect(commands.length).toBeGreaterThan(0);
			expect(typeof (catalog.data as { revision: unknown }).revision).toBe("string");

			send({ id: "roles", type: "get_model_roles" });
			const roles = await responseFor(next, "roles");
			expect(roles).toMatchObject({ id: "roles", command: "get_model_roles", success: true });
			expect((roles.data as { roles: { roleId: string }[] }).roles.some(role => role.roleId === "default")).toBe(
				true,
			);

			// None of the queries above created a session.
			send({ id: "list-empty", type: "list_sessions" });
			const listed = await responseFor(next, "list-empty");
			expect(listed).toMatchObject({ id: "list-empty", command: "list_sessions", success: true });
			expect((listed.data as { sessions: unknown[] }).sessions).toHaveLength(0);
		});
	}, 60_000);

	test("create/list/resume/close lifecycle over one process", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next) => {
			await negotiateV3(send, next);

			send({ id: "c-alpha", type: "create_session", name: "alpha" });
			const alpha = await responseFor(next, "c-alpha");
			expect(alpha).toMatchObject({ id: "c-alpha", command: "create_session", success: true });
			const alphaData = alpha.data as SessionSummaryLike;
			expect(typeof alphaData.sessionId).toBe("string");
			expect(alphaData.sessionId!.length).toBeGreaterThan(0);
			expect(typeof alphaData.sessionGeneration).toBe("string");
			expect(alphaData.loadState).toBe("loaded");
			expect(alphaData.name).toBe("alpha");

			send({ id: "c-beta", type: "create_session", name: "beta" });
			const beta = await responseFor(next, "c-beta");
			expect(beta).toMatchObject({ id: "c-beta", command: "create_session", success: true });
			const betaId = (beta.data as SessionSummaryLike).sessionId!;
			expect(betaId).not.toBe(alphaData.sessionId);

			send({ id: "l-both", type: "list_sessions" });
			const both = await responseFor(next, "l-both");
			expect(both).toMatchObject({ id: "l-both", command: "list_sessions", success: true });
			const alphaListed = findSession(both.data, alphaData.sessionId!);
			const betaListed = findSession(both.data, betaId);
			expect(alphaListed?.loadState).toBe("loaded");
			expect(betaListed?.loadState).toBe("loaded");

			// Resume of a loaded session is an idempotent reuse: same generation.
			send({ id: "r-same", type: "resume_session", sessionId: alphaData.sessionId });
			const resumedSame = await responseFor(next, "r-same");
			expect(resumedSame).toMatchObject({ id: "r-same", command: "resume_session", success: true });
			expect((resumedSame.data as SessionSummaryLike).sessionGeneration).toBe(alphaData.sessionGeneration);

			// Close unloads the instance; history stays listed as not_loaded.
			send({ id: "close-alpha", type: "close_session", sessionId: alphaData.sessionId });
			const closed = await responseFor(next, "close-alpha");
			expect(closed).toMatchObject({
				id: "close-alpha",
				command: "close_session",
				success: true,
				data: { sessionId: alphaData.sessionId, state: "unloaded" },
			});

			send({ id: "l-after-close", type: "list_sessions" });
			const afterClose = await responseFor(next, "l-after-close");
			const alphaAfterClose = findSession(afterClose.data, alphaData.sessionId!);
			expect(alphaAfterClose).toBeDefined();
			expect(alphaAfterClose?.loadState).toBe("not_loaded");
			expect(findSession(afterClose.data, betaId)?.loadState).toBe("loaded");

			// Resume of the closed session rebuilds the instance: NEW generation.
			send({ id: "r-new", type: "resume_session", sessionId: alphaData.sessionId });
			const resumedNew = await responseFor(next, "r-new");
			expect(resumedNew).toMatchObject({ id: "r-new", command: "resume_session", success: true });
			const resumedNewData = resumedNew.data as SessionSummaryLike;
			expect(resumedNewData.loadState).toBe("loaded");
			expect(typeof resumedNewData.sessionGeneration).toBe("string");
			expect(resumedNewData.sessionGeneration).not.toBe(alphaData.sessionGeneration);
		});
	}, 60_000);

	test("session-scoped stock command rejects without sessionId", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next) => {
			await negotiateV3(send, next);

			send({ id: "gs-no-session", type: "get_state" });
			const rejected = await responseFor(next, "gs-no-session");
			expect(rejected).toMatchObject({
				id: "gs-no-session",
				command: "get_state",
				success: false,
				code: "invalid_params",
			});
			expect(String(rejected.error)).toContain("sessionId");
			// Not the unknown-command path: the command name is echoed back.
			expect(String(rejected.error)).not.toContain("Unknown command");
		});
	}, 60_000);

	test("unknown command rejected", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next) => {
			await next(frame => frame.type === "ready");

			send({ id: "u-1", type: "definitely_not_a_command" });
			const unknown = await responseFor(next, "u-1");
			expect(unknown).toMatchObject({
				id: "u-1",
				command: "definitely_not_a_command",
				success: false,
			});
			expect(String(unknown.error)).toContain("Unknown command");
		});
	}, 60_000);

	test("prompt text mode preserves slash text", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next) => {
			await negotiateV3(send, next);

			send({ id: "c-text", type: "create_session", name: "text-mode" });
			const created = await responseFor(next, "c-text");
			expect(created.success).toBe(true);
			const createdData = created.data as SessionSummaryLike;

			// inputMode "text": the leading "/" is preserved as plain model
			// input (no strict command dispatch). The accept response is
			// emitted before the model turn; the doomed turn is never awaited.
			send({
				id: "p-text",
				type: "prompt",
				sessionId: createdData.sessionId,
				sessionGeneration: createdData.sessionGeneration,
				message: "/nosuchslash hello",
				inputMode: "text",
			});
			const accepted = await responseFor(next, "p-text");
			expect(accepted).toMatchObject({ id: "p-text", command: "prompt", success: true });

			// Abort the doomed model turn, then close with cancelRunning.
			send({
				id: "ab-text",
				type: "abort",
				sessionId: createdData.sessionId,
				sessionGeneration: createdData.sessionGeneration,
			});
			const aborted = await responseFor(next, "ab-text");
			expect(aborted).toMatchObject({ id: "ab-text", command: "abort", success: true });

			send({
				id: "close-text",
				type: "close_session",
				sessionId: createdData.sessionId,
				cancelRunning: true,
			});
			const closed = await responseFor(next, "close-text");
			expect(closed).toMatchObject({
				id: "close-text",
				command: "close_session",
				success: true,
				data: { sessionId: createdData.sessionId, state: "unloaded" },
			});
		});
	}, 60_000);

	test("execute_command rejects unknown commands without a model turn", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next, seen) => {
			await negotiateV3(send, next);

			send({ id: "c-exec", type: "create_session", name: "exec" });
			const created = await responseFor(next, "c-exec");
			expect(created.success).toBe(true);
			const createdData = created.data as SessionSummaryLike;

			send({
				id: "ex-unknown",
				type: "execute_command",
				sessionId: createdData.sessionId,
				sessionGeneration: createdData.sessionGeneration,
				text: "/nosuchcommand",
			});
			const rejected = await responseFor(next, "ex-unknown");
			expect(rejected).toMatchObject({
				id: "ex-unknown",
				command: "execute_command",
				success: false,
				code: "invalid_params",
			});
			expect(String(rejected.error)).toContain("Unknown command");

			// Strict dispatch never started a model turn for that request id.
			await Bun.sleep(1500);
			expect(seen.some(frame => frame.type === "prompt_result" && frame.id === "ex-unknown")).toBe(false);
		});
	}, 60_000);

	// Regression (2026-10-02 merge): project-mode routing used to rebuild the
	// frame object before handing it to the session host, so the user-input
	// gate never recognized it and every ordered input was cancelled as stale.
	// These two cases pin the positive paths: a routed prompt reaches the real
	// dispatch chain (a prompt_result that is not the gate's "aborted"), and
	// execute_command's synthetic prompt actually runs the builtin.
	test("execute_command runs a local builtin through the shared prompt pipeline", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next, seen) => {
			await negotiateV3(send, next);

			send({ id: "c-model", type: "create_session", name: "exec-builtin" });
			const created = await responseFor(next, "c-model");
			expect(created.success).toBe(true);
			const createdData = created.data as SessionSummaryLike;

			send({
				id: "ex-model",
				type: "execute_command",
				sessionId: createdData.sessionId,
				sessionGeneration: createdData.sessionGeneration,
				text: "/model",
			});
			const executed = await responseFor(next, "ex-model");
			// A cancelled (stale) input answers bare success with no data; a
			// locally completed builtin reports agentInvoked: false.
			expect(executed).toMatchObject({
				id: "ex-model",
				command: "execute_command",
				success: true,
				data: { agentInvoked: false },
			});
			// The builtin really ran: its headless output reached the client.
			await Bun.sleep(1500);
			expect(
				seen.some(
					frame =>
						frame.type === "command_output" &&
						(typeof frame.text === "string"
							? frame.text.includes("Current model") || frame.text.includes("No model is currently selected")
							: false),
				),
			).toBe(true);
		});
	}, 60_000);

	test("project prompt reaches the real dispatch chain (not gate-cancelled)", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next) => {
			await negotiateV3(send, next);

			send({ id: "c-prompt", type: "create_session", name: "prompt-direct" });
			const created = await responseFor(next, "c-prompt");
			expect(created.success).toBe(true);
			const createdData = created.data as SessionSummaryLike;

			// A local builtin proves real prompt admission without awaiting or
			// depending on any external provider response. Strict command
			// dispatch requires inputMode "auto" (§14.4: project-mode prompt
			// defaults to plain text).
			send({
				id: "p-direct",
				type: "prompt",
				sessionId: createdData.sessionId,
				sessionGeneration: createdData.sessionGeneration,
				message: "/model",
				inputMode: "auto",
			});
			expect(await responseFor(next, "p-direct")).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
		});
	}, 60_000);

	test("EOF ordered exit", async () => {
		await using cwdDir = await TempDir.create("rpc-project-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-");
		await using agentDir = await TempDir.create("rpc-project-agent-");
		const dirs: ProjectRpcServerDirs = {
			cwd: path.resolve(cwdDir.path()),
			sessionDir: path.resolve(sessionsDir.path()),
			agentDir: path.resolve(agentDir.path()),
		};
		await withProjectRpcServer(dirs, async (send, next, _seen, controls) => {
			await negotiateV3(send, next);

			// stdin EOF: the server drains its queue, disposes, exits with 0.
			controls.closeStdin();
			const exitCode = await Promise.race([controls.exited, Bun.sleep(30_000).then(() => -1)]);
			expect(exitCode).toBe(0);
		});
	}, 60_000);

	for (const termination of ["close", "eof"] as const) {
		test(`${termination} cancels a real paused extension-input admission without invoking the agent`, async () => {
			await using temp = await TempDir.create("rpc-project-paused-input-");
			const cwd = path.resolve(temp.path());
			const extensionPath = path.join(cwd, "pause.ts");
			await Bun.write(
				extensionPath,
				`export default function(omp) {
				omp.on("input", async (event, ctx) => {
					if (event.text === "paused input") await ctx.ui.confirm("Paused admission", "Continue?");
					return { action: "continue" };
				});
			}`,
			);
			await withProjectRpcServer(
				{ cwd, sessionDir: path.join(cwd, "sessions"), agentDir: path.join(cwd, "agent"), extensionPath },
				async (send, next, seen, controls) => {
					await negotiateV3(send, next);
					send({ id: "create-paused", type: "create_session" });
					const response = await responseFor(next, "create-paused");
					expect(response.success).toBe(true);
					const session = response.data as SessionSummaryLike;
					send({
						id: "held-input",
						type: "prompt",
						sessionId: session.sessionId,
						message: "paused input",
						inputMode: "text",
					});
					await next(
						frame =>
							frame.type === "extension_ui_request" &&
							frame.method === "confirm" &&
							frame.title === "Paused admission",
					);
					if (termination === "close") {
						send({
							id: "close-paused",
							type: "close_session",
							sessionId: session.sessionId,
							cancelRunning: true,
						});
						expect(await responseFor(next, "close-paused")).toMatchObject({
							success: true,
							data: { state: "unloaded" },
						});
					} else {
						controls.closeStdin();
					}
					expect(await responseFor(next, "held-input")).toMatchObject({ success: true });
					expect(await next(frame => frame.type === "prompt_result" && frame.id === "held-input")).toMatchObject({
						status: "aborted",
						sessionId: session.sessionId,
						sessionGeneration: session.sessionGeneration,
					});
					expect(seen.some(frame => frame.type === "agent_start" && frame.sessionId === session.sessionId)).toBe(
						false,
					);
					if (termination === "eof") expect(await controls.exited).toBe(0);
				},
			);
		}, 60_000);
	}

	test("failed final closes can be retried through close_session and delete_session", async () => {
		await using temp = await TempDir.create("rpc-project-close-retry-");
		const cwd = path.resolve(temp.path());
		const extensionPath = path.join(cwd, "fail-close-once.ts");
		const managerModule = path.resolve(import.meta.dir, "../src/session/session-manager.ts");
		await Bun.write(
			extensionPath,
			`import { SessionManager } from ${JSON.stringify(managerModule)};
export default function() {
	const marker = Symbol.for("rpc-project-test.fail-close-once");
	if (SessionManager.prototype[marker]) return;
	SessionManager.prototype[marker] = true;
	const close = SessionManager.prototype.close;
	const failed = new WeakSet();
	SessionManager.prototype.close = async function() {
		if (!failed.has(this)) {
			failed.add(this);
			throw new Error("temporary transcript close failure");
		}
		return close.call(this);
	};
}`,
		);
		await withProjectRpcServer(
			{ cwd, sessionDir: path.join(cwd, "sessions"), agentDir: path.join(cwd, "agent"), extensionPath },
			async (send, next, _seen, controls) => {
				await negotiateV3(send, next);
				for (const action of ["close_session", "delete_session"] as const) {
					send({ id: `create-${action}`, type: "create_session", name: `retry-${action}` });
					const created = await responseFor(next, `create-${action}`);
					expect(created.success).toBe(true);
					const session = LoadedSummary.assert(created.data);
					send({ id: `fail-${action}`, type: "close_session", sessionId: session.sessionId });
					expect(await responseFor(next, `fail-${action}`)).toMatchObject({ success: false });
					send({ id: `list-${action}`, type: "list_sessions" });
					const directory = (await responseFor(next, `list-${action}`)).data as {
						sessions: SessionSummaryLike[];
						revision: string;
					};
					// delete_session's expectedRevision is the per-session resource
					// revision (rpc-ui-protocol.md: 目录修订不替代对象修订), not the
					// directory revision.
					const listed = findSession(directory, session.sessionId);
					expect(listed?.loadState).toBe("closing");
					const resourceRevision = listed?.revision;
					expect(resourceRevision).toBeTruthy();
					controls.sendRaw({
						id: `stale-${action}`,
						type: action,
						sessionId: session.sessionId,
						sessionGeneration: "stale-generation",
						expectedRevision: resourceRevision,
					});
					expect(await responseFor(next, `stale-${action}`)).toMatchObject({
						success: false,
						code: "stale_session",
					});
					send({
						id: `retry-${action}`,
						type: action,
						sessionId: session.sessionId,
						expectedRevision: resourceRevision,
					});
					expect(await responseFor(next, `retry-${action}`)).toMatchObject({
						success: true,
						data: action === "close_session" ? { state: "unloaded" } : { deleted: true },
					});
					send({ id: `after-${action}`, type: "list_sessions" });
					const after = (await responseFor(next, `after-${action}`)).data;
					if (action === "close_session") {
						expect(findSession(after, session.sessionId)?.loadState).toBe("not_loaded");
					} else {
						expect(findSession(after, session.sessionId)).toBeUndefined();
					}
				}
			},
		);
	}, 60_000);

	test("generation is mandatory and pure management-panel actions do not create an actor", async () => {
		await using temp = await TempDir.create("rpc-project-generation-");
		const cwd = path.resolve(temp.path());
		await withProjectRpcServer(
			{ cwd, sessionDir: path.join(cwd, "sessions"), agentDir: path.join(cwd, "agent") },
			async (send, next, _seen, controls) => {
				await negotiateV3(send, next);
				send({ id: "panel", type: "execute_command", text: "/skills" });
				expect(await responseFor(next, "panel")).toMatchObject({
					success: true,
					data: { hostAction: { kind: "open_panel", payload: { panel: "skills" } } },
				});
				send({ id: "empty", type: "list_sessions" });
				expect(await responseFor(next, "empty")).toMatchObject({ success: true, data: { sessions: [] } });
				send({ id: "create-gen", type: "create_session" });
				const created = (await responseFor(next, "create-gen")).data as SessionSummaryLike;
				controls.sendRaw({ id: "missing-generation", type: "get_state", sessionId: created.sessionId });
				expect(await responseFor(next, "missing-generation")).toMatchObject({
					success: false,
					code: "invalid_params",
				});
			},
		);
	}, 60_000);

	test("branch, partial fork, and full fork create independent roots without changing the original transcript", async () => {
		await using temp = await TempDir.create("rpc-project-branch-");
		const cwd = path.resolve(temp.path());
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		await manager.ensureOnDisk();
		manager.appendModelChange("anthropic/claude-sonnet-4-5");
		manager.appendMessage({ role: "user", content: "before branch", timestamp: Date.now() });
		const selectedEntry = manager.appendMessage({ role: "user", content: "branch origin", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "original continues", timestamp: Date.now() });
		const originalId = manager.getSessionId();
		const originalFile = manager.getSessionFile()!;
		await manager.close();
		await withProjectRpcServer({ cwd, sessionDir, agentDir: path.join(cwd, "agent") }, async (send, next) => {
			await negotiateV3(send, next);
			send({ id: "original", type: "resume_session", sessionId: originalId });
			const original = await responseFor(next, "original");
			expect(original.success).toBe(true);
			const originalData = LoadedSummary.assert(original.data);
			const generation = originalData.sessionGeneration;
			const originalBytes = await Bun.file(originalFile).text();
			for (const [id, commandType, entryId] of [
				["branch-copy", "branch", selectedEntry],
				["partial-copy", "fork", selectedEntry],
				["full-copy", "fork", undefined],
			] as const) {
				send({ id, type: commandType, entryId, sessionId: originalId, sessionGeneration: generation });
				const response = await responseFor(next, id);
				expect(response.success).toBe(true);
				const child = LoadedSummary.assert(response.data);
				expect(child.sessionId).not.toBe(originalId);
				expect(child.loadState).toBe("loaded");
				expect(child.sessionGeneration).not.toBe(generation);
				send({ id: `${id}-history`, type: "get_messages_page", sessionId: child.sessionId });
				const history = JSON.stringify((await responseFor(next, `${id}-history`)).data);
				expect(history).toContain("before branch");
				expect(history.includes("branch origin")).toBe(commandType === "fork");
				expect(history.includes("original continues")).toBe(entryId === undefined);
				expect(await Bun.file(originalFile).text()).toBe(originalBytes);
			}
			send({ id: "original-state", type: "get_state", sessionId: originalId, sessionGeneration: generation });
			expect(await responseFor(next, "original-state")).toMatchObject({ success: true });
			send({ id: "directory", type: "list_sessions", loadState: "loaded" });
			const directoryResponse = await responseFor(next, "directory");
			const directoryData = SessionDirectory.assert(directoryResponse.data);
			expect(directoryData.sessions).toHaveLength(4);
		});
	}, 60_000);
});
