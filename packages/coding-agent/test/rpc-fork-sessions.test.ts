import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcForkHost, type RpcForkContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-host";
import { RpcForkSessionController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-sessions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RpcForkCommandBase } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-types";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const makeContext = (emitted: object[]): RpcForkContext => ({
	session: {} as RpcForkContext["session"],
	emit: frame => emitted.push(frame),
	success: (id, command, data) => ({ id, type: "response", command, success: true, data }) as RpcResponse,
	error: (id, command, message, code) =>
		({ id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) }) as RpcResponse,
});

interface Fixture {
	host: RpcForkHost;
	emitted: object[];
	sessionFiles: string[];
	activeFile: string;
	session: AgentSession;
	run: (command: object) => Promise<RpcResponse>;
}

async function createFixture(sessionCount = 3): Promise<Fixture> {
	const emitted: object[] = [];
	const host = new RpcForkHost(makeContext(emitted));
	host.activate();
	const cwdDir = await TempDir.create("rpc-fork-sessions-cwd-");
	const sessionsDir = await TempDir.create("rpc-fork-sessions-store-");
	const agentDir = await TempDir.create("rpc-fork-sessions-agent-");
	const sessionFiles: string[] = [];
	for (let index = 0; index < sessionCount; index++) {
		const manager = SessionManager.create(cwdDir.path(), sessionsDir.path());
		await manager.ensureOnDisk();
		manager.appendCustomEntry("step", { n: index });
		const file = manager.getSessionFile();
		if (file) sessionFiles.push(file);
		await manager.close();
	}
	// Newest session first (modified desc); make the middle file the active one.
	const activeFile = sessionFiles[sessionCount - 1]!;
	const session = {
		sessionFile: activeFile,
		setSessionName: async () => true,
	} as unknown as AgentSession;
	const controller = new RpcForkSessionController(host, session, { agentDir: agentDir.path() });
	void controller;
	return {
		host,
		emitted,
		sessionFiles,
		activeFile,
		session,
		run: command => host.handleCommand(command as { type: string }) as Promise<RpcResponse>,
	};
}

describe("RpcForkSessionController (4.2)", () => {
	test("list_sessions cwd scope returns summaries with pinned flags and pagination cursors", async () => {
		const fx = await createFixture(3);
		const first = (await fx.run({ id: "l1", type: "list_sessions", scope: "cwd", limit: 2 })) as Extract<
			RpcResponse,
			{ command: "list_sessions"; success: true }
		>;
		expect(first.success).toBe(true);
		const page1 = first.data!;
		expect(page1.sessions).toHaveLength(2);
		for (const entry of page1.sessions) {
			expect(entry.sessionId).toBeTypeOf("string");
			expect(entry.sessionFile).toMatch(/\.jsonl$/);
			expect(entry.cwd).toBeTypeOf("string");
			expect(entry.created).toBeTypeOf("string");
			expect(entry.modified).toBeTypeOf("string");
			expect(entry.messageCount).toBeTypeOf("number");
			expect(entry.pinned).toBe(false);
		}
		expect(page1.nextCursor).toBeTypeOf("string");

		const second = (await fx.run({
			id: "l2",
			type: "list_sessions",
			scope: "cwd",
			limit: 2,
			cursor: page1.nextCursor,
		})) as Extract<RpcResponse, { command: "list_sessions"; success: true }>;
		expect(second.data!.sessions).toHaveLength(1);
		expect(second.data!.nextCursor).toBeUndefined();

		// Walked pages cover every session exactly once.
		const seen = [...page1.sessions, ...second.data!.sessions].map(entry => entry.sessionFile).sort();
		expect(seen).toEqual([...fx.sessionFiles].sort());
	});

	test("list_sessions rejects invalid scope; v3 gating keeps inactive host silent", async () => {
		const fx = await createFixture(1);
		const bad = await fx.run({ id: "l3", type: "list_sessions", scope: "galaxy" } as Record<string, unknown>);
		expect(bad).toMatchObject({ success: false });

		const emitted: object[] = [];
		const dormantHost = new RpcForkHost(makeContext(emitted));
		new RpcForkSessionController(dormantHost, fx.session);
		await expect(
			dormantHost.handleCommand({ type: "list_sessions", scope: "cwd" } as RpcForkCommandBase),
		).resolves.toBeUndefined();
		expect(emitted).toHaveLength(0);
	});

	test("rename_session rewrites a non-active title, emits sessions_changed, and is reflected in listings", async () => {
		const fx = await createFixture(2);
		const target = fx.sessionFiles[0]!;
		const renamed = await fx.run({ id: "r1", type: "rename_session", sessionFile: target, name: "  Renamed task  " });
		expect(renamed).toMatchObject({ command: "rename_session", success: true });
		expect(fx.emitted).toContainEqual({ type: "sessions_changed" });

		const list = (await fx.run({ id: "r2", type: "list_sessions", scope: "cwd" })) as Extract<
			RpcResponse,
			{ command: "list_sessions"; success: true }
		>;
		const renamedEntry = list.data!.sessions.find(entry => entry.sessionFile === target);
		expect(renamedEntry?.title).toBe("Renamed task");
	});

	test("rename_session on the active session rides setSessionName; empty names rejected", async () => {
		const fx = await createFixture(1);
		let setCalled: string | undefined;
		(fx.session as { setSessionName: (name: string, source: string) => Promise<boolean> }).setSessionName =
			async name => {
				setCalled = name;
				return true;
			};
		const renamed = await fx.run({ id: "r3", type: "rename_session", sessionFile: fx.activeFile, name: "Active" });
		expect(renamed).toMatchObject({ success: true });
		expect(setCalled).toBe("Active");

		const empty = await fx.run({ id: "r4", type: "rename_session", sessionFile: fx.activeFile, name: "   " });
		expect(empty).toMatchObject({ success: false, error: "Session name cannot be empty" });
	});

	test("delete_session removes artifacts for non-active sessions and refuses the active one", async () => {
		const fx = await createFixture(2);
		const victim = fx.sessionFiles[0]!;

		const activeAttempt = await fx.run({ id: "d1", type: "delete_session", sessionFile: fx.activeFile });
		expect(activeAttempt).toMatchObject({ success: false, code: "active_session" });

		const removed = await fx.run({ id: "d2", type: "delete_session", sessionFile: victim });
		expect(removed).toMatchObject({ success: true });
		expect(await Bun.file(victim).exists()).toBe(false);
		expect(fx.emitted.filter(frame => (frame as { type: string }).type === "sessions_changed")).toHaveLength(1);

		const list = (await fx.run({ id: "d3", type: "list_sessions", scope: "cwd" })) as Extract<
			RpcResponse,
			{ command: "list_sessions"; success: true }
		>;
		expect(list.data!.sessions.map(entry => entry.sessionFile)).not.toContain(victim);
	});

	test("pin_session/unpin_session toggle the global pin store and surface in listings", async () => {
		const fx = await createFixture(2);
		const target = fx.sessionFiles[0]!;
		const pinned = (await fx.run({ id: "p1", type: "pin_session", sessionId: "does-not-exist" })) as Extract<
			RpcResponse,
			{ command: "pin_session"; success: true }
		>;
		// Unknown ids are stored harmlessly (stale pins never disturb listings).
		expect(pinned).toMatchObject({ success: true, data: { pinned: true } });

		const realId = (await fx.run({ id: "p2", type: "list_sessions", scope: "cwd" })) as Extract<
			RpcResponse,
			{ command: "list_sessions"; success: true }
		>;
		const summary = realId.data!.sessions.find(entry => entry.sessionFile === target)!;
		const pin = await fx.run({ id: "p3", type: "pin_session", sessionId: summary.sessionId });
		expect(pin).toMatchObject({ success: true, data: { pinned: true } });

		const afterPin = (await fx.run({ id: "p4", type: "list_sessions", scope: "cwd" })) as Extract<
			RpcResponse,
			{ command: "list_sessions"; success: true }
		>;
		expect(afterPin.data!.sessions.find(entry => entry.sessionId === summary.sessionId)?.pinned).toBe(true);

		const unpin = await fx.run({ id: "p5", type: "unpin_session", sessionId: summary.sessionId });
		expect(unpin).toMatchObject({ success: true, data: { pinned: false } });
		const afterUnpin = (await fx.run({ id: "p6", type: "list_sessions", scope: "cwd" })) as Extract<
			RpcResponse,
			{ command: "list_sessions"; success: true }
		>;
		expect(afterUnpin.data!.sessions.find(entry => entry.sessionId === summary.sessionId)?.pinned).toBe(false);
	});
});
