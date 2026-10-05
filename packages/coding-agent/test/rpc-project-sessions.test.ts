// Unit tests for the fork RPC project-mode multi-session container
// (requirement R3, rpc-ui-protocol.md §5/§14.3): creation, idempotent resume
// with concurrent-load coalescing, the merged directory view, close/delete
// busy guards and rename — driven against a REAL SessionManager writing real
// JSONL files in temp dirs; only the AgentSession shell around the manager is
// faked (the container touches just that handful of members).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	RpcProjectSessionContainer,
	RpcProjectSessionError,
	type RpcProjectCreatedSession,
	type RpcProjectSessionHostLike,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-sessions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface SessionDirs {
	cwd: string;
	sessions: string;
}

/** Everything the fake sessions record about how the container drove them. */
interface FactoryState {
	bundles: RpcProjectCreatedSession[];
	factoryCalls: number;
	setSessionNameCalls: Array<{ name: string; source: string }>;
	switchCalls: string[];
	disposeCalls: number;
	abortCalls: number;
}

interface SessionFixture extends AsyncDisposable {
	container: RpcProjectSessionContainer;
	revisions: string[];
	state: FactoryState;
	/** Seed one real saved session file in the shared sessions dir (create → ensureOnDisk → appendMessage → close). */
	seedSession: (label: string) => Promise<{ sessionId: string; sessionFile: string }>;
}

/** Capture a rejection (or undefined on unexpected success) for code assertions. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		error => error,
	);
}

function makeHost(overrides: Partial<RpcProjectSessionHostLike> = {}): RpcProjectSessionHostLike {
	return {
		isStreaming: false,
		hasPendingAsyncWork: () => false,
		isWaitingInteraction: () => false,
		dispose: () => {},
		...overrides,
	};
}

/**
 * One container wired to a factory that builds the same host-side bundle the
 * rpc project host builds: a fake AgentSession (the surface the container
 * actually calls) backed by a REAL SessionManager, so persistence —
 * ensureOnDisk, JSONL files, title slots — is genuine.
 */
async function createSessionFixture(dirs: SessionDirs): Promise<SessionFixture> {
	const revisions: string[] = [];
	const state: FactoryState = {
		bundles: [],
		factoryCalls: 0,
		setSessionNameCalls: [],
		switchCalls: [],
		disposeCalls: 0,
		abortCalls: 0,
	};
	const createSession = async (): Promise<RpcProjectCreatedSession> => {
		state.factoryCalls++;
		let manager = SessionManager.create(dirs.cwd, dirs.sessions);
		const fake = {
			get sessionId() {
				return manager.getSessionId();
			},
			get sessionFile() {
				return manager.getSessionFile();
			},
			sessionName: undefined as string | undefined,
			get sessionManager() {
				return manager;
			},
			setSessionName: async (name: string, source: string) => {
				state.setSessionNameCalls.push({ name, source });
				fake.sessionName = name;
				await manager.setSessionName(name, source as "user");
				await manager.flush();
				return true;
			},
			switchSession: async (sessionFile: string) => {
				state.switchCalls.push(sessionFile);
				await manager.close();
				manager = await SessionManager.open(sessionFile, dirs.sessions);
				return true;
			},
			dispose: async () => {
				state.disposeCalls++;
				await manager.close();
			},
			abort: async () => {
				state.abortCalls++;
			},
			isStreaming: false,
			hasPendingAsyncWork: () => false,
		};
		const created: RpcProjectCreatedSession = {
			session: fake as unknown as AgentSession,
			setToolUIContext: () => {},
			setHost: () => {},
		};
		state.bundles.push(created);
		return created;
	};
	const container = new RpcProjectSessionContainer({
		cwd: dirs.cwd,
		sessionDir: dirs.sessions,
		createSession,
		onChanged: revision => revisions.push(revision),
	});
	return {
		[Symbol.asyncDispose]: () => container.disposeAll("test fixture cleanup"),
		container,
		revisions,
		state,
		seedSession: async label => {
			const manager = SessionManager.create(dirs.cwd, dirs.sessions);
			await manager.ensureOnDisk();
			manager.appendMessage({
				role: "user",
				content: `seeded history marker for ${label}`,
				timestamp: new Date().toISOString(),
			} as never);
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await manager.close();
			return { sessionId: manager.getSessionId(), sessionFile: sessionFile! };
		},
	};
}

describe("RpcProjectSessionContainer (R3, rpc-ui-protocol.md §5/§14.3)", () => {
	test("create adopts the factory session, persists it on disk and bumps the revision", async () => {
		await using cwdDir = await TempDir.create("rpc-project-sessions-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-store-");
		await using fx = await createSessionFixture({
			cwd: path.resolve(cwdDir.path()),
			sessions: path.resolve(sessionsDir.path()),
		});
		const before = fx.container.revision;

		const record = await fx.container.create();

		expect(record.state).toBe("loaded");
		expect(record.sessionId).toBeTypeOf("string");
		expect(record.sessionGeneration).toBeTypeOf("string");
		expect(record.sessionGeneration).not.toBe(record.sessionId);
		expect(fx.container.get(record.sessionId)).toBe(record);

		const summary = fx.container.buildSummary(record);
		expect(summary.sessionId).toBe(record.sessionId);
		expect(summary.sessionGeneration).toBe(record.sessionGeneration);
		expect(summary.loadState).toBe("loaded");
		expect(summary.runState).toBe("idle");
		expect(summary.sessionFile).toBe(record.session.sessionFile);
		expect(existsSync(summary.sessionFile!)).toBe(true); // ensureOnDisk really wrote the JSONL

		expect(fx.container.revision).not.toBe(before);
		expect(fx.revisions).toEqual([fx.container.revision]); // onChanged fired once with the bumped revision
		expect(fx.state.factoryCalls).toBe(1);
	}, 10_000);

	test("create with a name applies setSessionName(user); blank names are rejected", async () => {
		await using cwdDir = await TempDir.create("rpc-project-sessions-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-store-");
		await using fx = await createSessionFixture({
			cwd: path.resolve(cwdDir.path()),
			sessions: path.resolve(sessionsDir.path()),
		});

		const record = await fx.container.create({ name: "Named probe" });

		expect(fx.state.setSessionNameCalls).toEqual([{ name: "Named probe", source: "user" }]);
		expect(fx.container.buildSummary(record).name).toBe("Named probe");

		const blank = await failure(fx.container.create({ name: "   " }));
		expect(blank).toBeInstanceOf(RpcProjectSessionError);
		expect((blank as RpcProjectSessionError).code).toBe("invalid_params");
		expect(fx.container.listRecords()).toHaveLength(1); // the rejected bundle was never adopted
	}, 10_000);

	test("resume loads a saved session by id, coalesces concurrent loads and is idempotent", async () => {
		await using cwdDir = await TempDir.create("rpc-project-sessions-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-store-");
		await using fx = await createSessionFixture({
			cwd: path.resolve(cwdDir.path()),
			sessions: path.resolve(sessionsDir.path()),
		});
		const savedA = await fx.seedSession("resume-a");
		const savedB = await fx.seedSession("resume-b");

		// Two concurrent resumes of the same id share one factory load (requirement O04).
		const [first, second] = await Promise.all([
			fx.container.resume(savedA.sessionId),
			fx.container.resume(savedA.sessionId),
		]);
		expect(second).toBe(first);
		expect(first.sessionId).toBe(savedA.sessionId);
		expect(first.state).toBe("loaded");
		expect(fx.state.factoryCalls).toBe(1);
		expect(fx.state.switchCalls).toEqual([savedA.sessionFile]); // switchSession targeted the saved file

		// A later resume of a known record returns the same instance without reloading.
		const again = await fx.container.resume(savedA.sessionId);
		expect(again).toBe(first);
		expect(fx.state.factoryCalls).toBe(1);

		// A different saved id loads through its own factory call.
		const other = await fx.container.resume(savedB.sessionId);
		expect(other.sessionId).toBe(savedB.sessionId);
		expect(fx.state.factoryCalls).toBe(2);
		expect(fx.state.switchCalls).toEqual([savedA.sessionFile, savedB.sessionFile]);
		expect(fx.container.getLoaded(savedB.sessionId)).toBe(other);
	}, 15_000);

	test("resume of an unknown session id rejects with not_found", async () => {
		await using cwdDir = await TempDir.create("rpc-project-sessions-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-store-");
		await using fx = await createSessionFixture({
			cwd: path.resolve(cwdDir.path()),
			sessions: path.resolve(sessionsDir.path()),
		});

		const err = await failure(fx.container.resume("no-such-session-id"));

		expect(err).toBeInstanceOf(RpcProjectSessionError);
		expect((err as RpcProjectSessionError).code).toBe("not_found");
		expect(fx.state.factoryCalls).toBe(0); // the directory scan rejects before any session is built
		expect(fx.revisions).toHaveLength(0);
	}, 10_000);

	test("list merges disk and loaded sessions (in-memory wins) and validates pagination limits", async () => {
		await using cwdDir = await TempDir.create("rpc-project-sessions-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-store-");
		await using fx = await createSessionFixture({
			cwd: path.resolve(cwdDir.path()),
			sessions: path.resolve(sessionsDir.path()),
		});
		const savedOne = await fx.seedSession("merge-one");
		const savedTwo = await fx.seedSession("merge-two");
		const created = await fx.container.create();

		const all = await fx.container.list();
		expect(all.sessions).toHaveLength(3); // dedup by id: the created session's own file counts once
		expect(all.sessions.map(summary => summary.sessionId).sort()).toEqual(
			[savedOne.sessionId, savedTwo.sessionId, created.sessionId].sort(),
		);
		expect(all.revision).toBe(fx.container.revision);

		// The created session's disk row is overlaid with its live record.
		const merged = all.sessions.find(summary => summary.sessionId === created.sessionId)!;
		expect(merged.loadState).toBe("loaded");
		expect(merged.runState).toBe("idle");
		expect(merged.sessionGeneration).toBe(created.sessionGeneration);

		// Saved-only rows come from the disk scan.
		const savedRows = all.sessions.filter(summary => summary.loadState === "not_loaded");
		expect(savedRows.map(summary => summary.sessionId).sort()).toEqual(
			[savedOne.sessionId, savedTwo.sessionId].sort(),
		);
		expect(savedRows.every(summary => summary.messageCount === 1)).toBe(true);

		// loadState filters slice the merged directory.
		const loadedOnly = await fx.container.list({ loadState: "loaded" });
		expect(loadedOnly.sessions.map(summary => summary.sessionId)).toEqual([created.sessionId]);
		const notLoadedOnly = await fx.container.list({ loadState: "not_loaded" });
		expect(notLoadedOnly.sessions.map(summary => summary.sessionId).sort()).toEqual(
			[savedOne.sessionId, savedTwo.sessionId].sort(),
		);

		// Offset pagination walks every session exactly once.
		const pageOne = await fx.container.list({ limit: 2 });
		expect(pageOne.sessions).toHaveLength(2);
		expect(typeof pageOne.nextCursor).toBe("string");
		const pageTwo = await fx.container.list({ cursor: pageOne.nextCursor, limit: 2 });
		expect(pageTwo.sessions).toHaveLength(1);
		expect(pageTwo.nextCursor).toBeUndefined();
		expect([...pageOne.sessions, ...pageTwo.sessions].map(summary => summary.sessionId).sort()).toEqual(
			[savedOne.sessionId, savedTwo.sessionId, created.sessionId].sort(),
		);

		// Out-of-range and fractional limits are invalid_params.
		for (const badLimit of [0, 201, 1.5]) {
			const err = await failure(fx.container.list({ limit: badLimit }));
			expect(err).toBeInstanceOf(RpcProjectSessionError);
			expect((err as RpcProjectSessionError).code).toBe("invalid_params");
		}
	}, 15_000);

	test("close rejects a busy session and unloads it when cancelRunning is set", async () => {
		await using cwdDir = await TempDir.create("rpc-project-sessions-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-store-");
		await using fx = await createSessionFixture({
			cwd: path.resolve(cwdDir.path()),
			sessions: path.resolve(sessionsDir.path()),
		});
		const record = await fx.container.create();
		const bundle = fx.state.bundles.at(-1)!;
		bundle.setHost!(makeHost({ isStreaming: true }));

		// The attached host feeds the run state shown in the directory.
		const streaming = await fx.container.list({ loadState: "loaded" });
		expect(streaming.sessions.find(summary => summary.sessionId === record.sessionId)?.runState).toBe("streaming");

		// Streaming work blocks close; nothing is torn down and no revision is bumped.
		const revisionsBefore = fx.revisions.length;
		const busy = await failure(fx.container.close(record.sessionId));
		expect(busy).toBeInstanceOf(RpcProjectSessionError);
		expect((busy as RpcProjectSessionError).code).toBe("busy");
		expect(fx.container.get(record.sessionId)).toBe(record);
		expect(fx.revisions).toHaveLength(revisionsBefore);

		// cancelRunning aborts first, releases the host, disposes the session and bumps once.
		const result = await fx.container.close(record.sessionId, { cancelRunning: true });
		expect(result.state).toBe("unloaded");
		expect(fx.state.abortCalls).toBe(1);
		expect(fx.state.disposeCalls).toBe(1);
		expect(fx.container.get(record.sessionId)).toBeUndefined();
		const after = await fx.container.list({ loadState: "not_loaded" });
		expect(after.sessions.map(summary => summary.sessionId)).toContain(record.sessionId); // history stays on disk
		expect(fx.revisions).toHaveLength(revisionsBefore + 1);
		expect(fx.revisions.at(-1)).toBe(result.revision);

		// Closing an unloaded session is not_found, never a second teardown.
		const second = await failure(fx.container.close(record.sessionId));
		expect(second).toBeInstanceOf(RpcProjectSessionError);
		expect((second as RpcProjectSessionError).code).toBe("not_found");
	}, 15_000);

	test("delete removes loaded and saved-only sessions together with their files", async () => {
		await using cwdDir = await TempDir.create("rpc-project-sessions-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-store-");
		await using fx = await createSessionFixture({
			cwd: path.resolve(cwdDir.path()),
			sessions: path.resolve(sessionsDir.path()),
		});
		const saved = await fx.seedSession("delete-saved");
		const created = await fx.container.create();
		const createdFile = created.session.sessionFile!;

		// Saved-only: resolved by a directory scan, file removed from disk.
		const savedResult = await fx.container.delete(saved.sessionId);
		expect(savedResult.revision).toBe(fx.container.revision);
		expect(existsSync(saved.sessionFile)).toBe(false);

		// Loaded: the instance is closed first, then the file (and artifacts) go.
		const loadedResult = await fx.container.delete(created.sessionId);
		expect(loadedResult.revision).toBe(fx.container.revision);
		expect(existsSync(createdFile)).toBe(false);
		expect(fx.container.get(created.sessionId)).toBeUndefined();
		expect(fx.state.disposeCalls).toBe(1);

		const err = await failure(fx.container.delete("missing-session-id"));
		expect(err).toBeInstanceOf(RpcProjectSessionError);
		expect((err as RpcProjectSessionError).code).toBe("not_found");
	}, 15_000);

	test("rename of a not-loaded session rewrites the saved title and re-lists under the new name", async () => {
		await using cwdDir = await TempDir.create("rpc-project-sessions-cwd-");
		await using sessionsDir = await TempDir.create("rpc-project-sessions-store-");
		await using fx = await createSessionFixture({
			cwd: path.resolve(cwdDir.path()),
			sessions: path.resolve(sessionsDir.path()),
		});
		const saved = await fx.seedSession("rename-me");
		const revisionsBefore = fx.revisions.length;

		const result = await fx.container.rename(saved.sessionId, "  Renamed probe  ");

		expect(result.summary).toMatchObject({
			sessionId: saved.sessionId,
			name: "Renamed probe",
			loadState: "not_loaded",
		});
		expect(result.revision).toBe(fx.container.revision);
		expect(fx.revisions).toHaveLength(revisionsBefore + 1);

		const listed = await fx.container.list();
		const row = listed.sessions.find(summary => summary.sessionId === saved.sessionId);
		expect(row?.name).toBe("Renamed probe");
		expect(row?.loadState).toBe("not_loaded");

		const blank = await failure(fx.container.rename(saved.sessionId, "   "));
		expect(blank).toBeInstanceOf(RpcProjectSessionError);
		expect((blank as RpcProjectSessionError).code).toBe("invalid_params");
	}, 15_000);
});
