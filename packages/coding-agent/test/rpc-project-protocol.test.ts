import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

// Requirements §4/§13—§15 (rpc-ui-protocol.md): project-mode E2E against the
// real public entry (`omp --mode rpc-ui --rpc-project`, project root fixed by
// the startup cwd): ready identity, the v3 gate, zero-session catalogs, the
// multi-session lifecycle over one process, prompt text mode, strict
// execute_command and EOF ordered exit. Sessions persist (no --no-session)
// into isolated temp dirs; no model turn is ever awaited — the one accepted
// prompt is aborted immediately and its session closed with cancelRunning.

type RpcFrame = Record<string, unknown>;

interface ProjectRpcServerDirs {
	/** Project root: the spawn cwd; fixed for the process lifetime. */
	readonly cwd: string;
	readonly sessionDir: string;
	readonly agentDir: string;
}

interface ServerControls {
	readonly closeStdin: () => void;
	readonly exited: Promise<number>;
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
			"--no-extensions",
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
	let readerDone = false;
	let readerError: unknown;
	const lines = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>);
	const pump = (async () => {
		try {
			for await (const line of lines) {
				if (isRecord(line)) {
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
	const send = (frame: object): void => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	const next = async (predicate?: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
		const match = predicate ?? (frame => frame.type === "response");
		for (let waited = 0; waited < 300; waited++) {
			const responseIndex = queue.findIndex(match);
			if (responseIndex !== -1) return queue.splice(responseIndex, 1)[0]!;
			queue.length = 0;
			if (readerDone) throw new Error(`RPC stream ended early: ${await stderrPromise} ${String(readerError ?? "")}`);
			await Bun.sleep(100);
		}
		throw new Error("Timed out waiting for RPC frame");
	};
	const controls: ServerControls = {
		closeStdin: () => {
			child.stdin.end();
		},
		exited: child.exited,
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
}

function findSession(data: unknown, sessionId: string): SessionSummaryLike | undefined {
	return (data as { sessions: SessionSummaryLike[] }).sessions.find(summary => summary.sessionId === sessionId);
}

describe("rpc-ui project mode (live --rpc-project server)", () => {
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
			expect(ready.supportedProtocolVersions).toEqual([1, 2, 3]);
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

			send({ id: "skills", type: "list_skills", view: "management" });
			const skills = await responseFor(next, "skills");
			expect(skills).toMatchObject({ id: "skills", command: "list_skills", success: true });
			expect(Array.isArray((skills.data as { items: unknown[] }).items)).toBe(true);

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
});
