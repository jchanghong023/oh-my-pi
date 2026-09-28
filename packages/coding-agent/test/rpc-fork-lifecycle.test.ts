import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Requirement 4.4 (rpc-ui-protocol.md): EOF ordered exit + host respawn +
// `open_session` recovery, driven against the real public entry
// (`omp --mode rpc-ui`). No model calls are made; history is seeded through
// the canonical SessionManager APIs.

type RpcFrame = Record<string, unknown>;

interface ServerHandle {
	send: (frame: object) => void;
	next: (predicate?: (frame: RpcFrame) => boolean) => Promise<RpcFrame>;
	closeStdin: () => Promise<void>;
	exited: Promise<number>;
	dispose: () => Promise<void>;
}

async function spawnRpcServer(sessionDir: string, agentDir: string, cwd: string): Promise<ServerHandle> {
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--session-dir",
			sessionDir,
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd,
			env: {
				...Bun.env,
				PI_NO_TITLE: "1",
				PI_CODING_AGENT_DIR: agentDir,
			} as unknown as Record<string, string | undefined>,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();
	const queue: RpcFrame[] = [];
	let readerDone = false;
	let readerError: unknown;
	const lines = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>);
	const pump = (async () => {
		try {
			for await (const line of lines) {
				if (isRecord(line)) queue.push(line);
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
			const index = queue.findIndex(match);
			if (index !== -1) return queue.splice(index, 1)[0]!;
			queue.length = 0;
			if (readerDone) throw new Error(`RPC stream ended early: ${await stderrPromise} ${String(readerError ?? "")}`);
			await Bun.sleep(100);
		}
		throw new Error("Timed out waiting for RPC frame");
	};
	const dispose = async (): Promise<void> => {
		try {
			child.stdin.end();
		} catch {}
		child.kill();
		await child.exited.catch(() => {});
		await pump.catch(() => {});
		await stderrPromise.catch(() => {});
	};
	return {
		send,
		next,
		closeStdin: async () => {
			child.stdin.end();
		},
		exited: child.exited,
		dispose,
	};
}

async function negotiate(handler: ServerHandle): Promise<void> {
	const ready = await handler.next(frame => frame.type === "ready");
	expect(ready.supportedProtocolVersions).toEqual([1, 2, 3]);
	handler.send({ id: "neg", type: "negotiate_protocol", protocolVersion: 3 });
	await expect(handler.next()).resolves.toMatchObject({
		id: "neg",
		command: "negotiate_protocol",
		success: true,
		data: { protocolVersion: 3 },
	});
}

describe("rpc-ui session lifecycle (4.4, live server)", () => {
	test("EOF ordered exit, respawn, and open_session recovery keep history intact", async () => {
		await using cwdDir = await TempDir.create("rpc-lifecycle-cwd-");
		await using sessionsDir = await TempDir.create("rpc-lifecycle-sessions-");
		await using agentDir = await TempDir.create("rpc-lifecycle-agent-");

		// Seed one session with conversational history through the canonical API.
		// TempDir paths can be relative; both processes must agree on absolutes.
		// The seeding cwd must match the server's spawn cwd: `open_session`
		// rejects switches whose recorded cwd differs from the live session.
		const absCwd = path.resolve(cwdDir.path());
		const absSessionsDir = path.resolve(sessionsDir.path());
		const seeded = SessionManager.create(absCwd, absSessionsDir);
		await seeded.ensureOnDisk();
		seeded.appendMessage({
			role: "user",
			content: "seeded history marker for rpc lifecycle e2e",
			timestamp: new Date().toISOString(),
		} as never);
		const seededFile = seeded.getSessionFile();
		expect(seededFile).toBeDefined();
		await seeded.close();

		// Host A: negotiate v3, adopt the seeded session, read it back.
		const hostA = await spawnRpcServer(absSessionsDir, path.resolve(agentDir.path()), absCwd);
		let seededMessageCount = 0;
		try {
			await negotiate(hostA);
			hostA.send({ id: "o1", type: "open_session", sessionDir: absSessionsDir });
			const opened = await hostA.next();
			expect(opened).toMatchObject({ id: "o1", command: "open_session", success: true });
			expect(opened.data).toMatchObject({ cancelled: false, resumed: true });
			expect(path.resolve((opened.data as { sessionFile: string }).sessionFile)).toBe(path.resolve(seededFile!));

			hostA.send({ id: "m1", type: "get_messages" });
			const messagesA = await hostA.next();
			expect(messagesA).toMatchObject({ command: "get_messages", success: true });
			expect(JSON.stringify(messagesA.data)).toContain("seeded history marker for rpc lifecycle e2e");
			seededMessageCount = (messagesA.data as { messages: unknown[] }).messages.length;

			// EOF: client closes stdin → the server drains and exits with code 0.
			await hostA.closeStdin();
			const exitCode = await Promise.race([hostA.exited, Bun.sleep(30_000).then(() => -1)]);
			expect(exitCode).toBe(0);
		} finally {
			await hostA.dispose();
		}

		// Host B (respawn): open_session recovers the same session and history.
		const hostB = await spawnRpcServer(absSessionsDir, path.resolve(agentDir.path()), absCwd);
		try {
			await negotiate(hostB);
			hostB.send({ id: "o2", type: "open_session", sessionDir: absSessionsDir });
			const reopened = await hostB.next();
			expect(reopened.data).toMatchObject({ cancelled: false, resumed: true });
			expect(path.resolve((reopened.data as { sessionFile: string }).sessionFile)).toBe(path.resolve(seededFile!));

			hostB.send({ id: "m2", type: "get_messages" });
			const messagesB = await hostB.next();
			expect(messagesB).toMatchObject({ command: "get_messages", success: true });
			expect(JSON.stringify(messagesB.data)).toContain("seeded history marker for rpc lifecycle e2e");

			// The recovered history is identical in message count.
			expect((messagesB.data as { messages: unknown[] }).messages.length).toBe(seededMessageCount);
		} finally {
			await hostB.dispose();
		}
	}, 120_000);
});
