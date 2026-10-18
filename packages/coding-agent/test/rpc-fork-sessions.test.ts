// Unit coverage for RpcSessionDirectoryService (rpc-fork-sessions.ts): the
// per-cwd saved-session listing, guarded rename (title-slot surgery with
// revision checks), and guarded delete, over a real session directory.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionPaths from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { TempDir } from "@oh-my-pi/pi-utils";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { FileSessionStorage, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { invalidateSessionScan } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	RpcSessionDirectoryError,
	RpcSessionDirectoryService,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-sessions";

const temporaryDirectories: TempDir[] = [];
afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await directory.remove();
});

interface Fixture {
	service: RpcSessionDirectoryService;
	cwd: string;
	sessionDir: string;
}

async function writeSession(sessionDir: string, id: string, cwd: string, title?: string): Promise<string> {
	const file = path.join(sessionDir, `${id}.jsonl`);
	const now = new Date().toISOString();
	// Real session files reserve a fixed-width title slot line before the header.
	const slot = serializeTitleSlot({ title, source: "user", updatedAt: now });
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: now,
		cwd,
	};
	const message = {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: now,
		message: { role: "user", content: "hi", timestamp: Date.now() },
	};
	await Bun.write(file, `${slot}${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
	return file;
}

async function setup(): Promise<Fixture> {
	const root = await TempDir.create("@rpc-fork-sessions-");
	temporaryDirectories.push(root);
	const cwd = path.resolve(root.join("project"));
	const sessionDir = path.resolve(root.join("sessions"));
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(sessionDir, { recursive: true });
	const service = new RpcSessionDirectoryService({ cwd, sessionDir });
	return { service, cwd, sessionDir };
}

describe("RpcSessionDirectoryService", () => {
	test("an idle resumed AgentSession blocks external rename and delete until close", async () => {
		const fx = await setup();
		const sessionId = `s-idle-${crypto.randomUUID()}`;
		const file = await writeSession(fx.sessionDir, sessionId, fx.cwd, "Idle history");
		const original = await Bun.file(file).text();
		const manager = await SessionManager.open(file, fx.sessionDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		const authStorage = await AuthStorage.create(":memory:");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled fixture model");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		try {
			expect(session.isStreaming).toBe(false);
			const [entry] = await fx.service.list();
			await expect(fx.service.rename(sessionId, "External rename", entry!.revision)).rejects.toMatchObject({
				code: "execution_failed",
			});
			await expect(fx.service.delete(sessionId, entry!.revision)).rejects.toMatchObject({ code: "unsupported" });
			expect(await Bun.file(file).text()).toBe(original);
		} finally {
			await session.dispose();
		}
		expect(await fx.service.rename(sessionId, "Closed history")).toMatchObject({ name: "Closed history" });
		await fx.service.delete(sessionId);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	test("a read-only SessionManager inspector never blocks directory mutations", async () => {
		const fx = await setup();
		const sessionId = `s-inspector-${crypto.randomUUID()}`;
		const file = await writeSession(fx.sessionDir, sessionId, fx.cwd, "Inspectable");
		const inspector = await SessionManager.open(file, fx.sessionDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(await fx.service.rename(sessionId, "Inspected")).toMatchObject({ name: "Inspected" });
			await fx.service.delete(sessionId);
			expect(await Bun.file(file).exists()).toBe(false);
		} finally {
			await inspector.close();
		}
	});

	test("runtime ownership follows history switches, rollback and a new session without leaking leases", async () => {
		const fx = await setup();
		const firstId = `s-first-${crypto.randomUUID()}`;
		const secondId = `s-second-${crypto.randomUUID()}`;
		const first = await writeSession(fx.sessionDir, firstId, fx.cwd);
		const second = await writeSession(fx.sessionDir, secondId, fx.cwd);
		const manager = await SessionManager.open(first, fx.sessionDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		manager.acquireRuntimeOwnership();
		try {
			const previous = manager.captureState();
			await manager.setSessionFile(second);
			await expect(fx.service.delete(secondId)).rejects.toMatchObject({ code: "unsupported" });
			expect(await fx.service.rename(firstId, "Released first")).toMatchObject({ name: "Released first" });
			manager.restoreState(previous);
			await expect(fx.service.rename(firstId, "Blocked again")).rejects.toMatchObject({ code: "execution_failed" });
			await fx.service.delete(secondId);
			expect(await Bun.file(second).exists()).toBe(false);
			await manager.newSession();
			await fx.service.delete(firstId);
			await expect(fx.service.delete(manager.getSessionId())).rejects.toMatchObject({ code: "unsupported" });
		} finally {
			await manager.close();
		}
		await fx.service.delete(manager.getSessionId());
		expect(await fx.service.list()).toEqual([]);
	});

	test("runtime takeover refuses another owner and a failed switch retains the old lease", async () => {
		const fx = await setup();
		const firstId = `s-retained-${crypto.randomUUID()}`;
		const ownedId = `s-owned-${crypto.randomUUID()}`;
		const first = await writeSession(fx.sessionDir, firstId, fx.cwd);
		const owned = await writeSession(fx.sessionDir, ownedId, fx.cwd);
		const original = await Bun.file(owned).text();
		const manager = await SessionManager.open(first, fx.sessionDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		manager.acquireRuntimeOwnership();
		// 独立进程走真实运行接管入口；同进程 storage 共享租约，不能模拟外部 owner。
		const script = [
			`import { SessionManager } from ${JSON.stringify(path.join(import.meta.dir, "../src/session/session-manager.ts"))};`,
			`const manager = await SessionManager.open(${JSON.stringify(owned)}, undefined, undefined, { suppressBreadcrumb: true });`,
			"manager.acquireRuntimeOwnership();",
			'process.stdout.write("ready\\n");',
			"for await (const line of console) break;",
			"await manager.close();",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		const output = child.stdout.getReader();
		let contender: SessionManager | undefined;
		try {
			let ready = "";
			while (!ready.endsWith("\n")) {
				const chunk = await output.read();
				if (chunk.done) throw new Error(await new Response(child.stderr).text());
				ready += new TextDecoder().decode(chunk.value);
			}
			expect(ready).toBe("ready\n");
			contender = await SessionManager.open(owned, fx.sessionDir, new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			expect(() => contender!.acquireRuntimeOwnership()).toThrow("another live omp process owns it");
			await expect(manager.setSessionFile(owned)).rejects.toThrow("another live omp process owns it");
			expect(manager.getSessionId()).toBe(firstId);
			expect(manager.getSessionFile()).toBe(first);
			await expect(fx.service.rename(firstId, "Must stay protected")).rejects.toMatchObject({
				code: "execution_failed",
			});
			await expect(fx.service.delete(firstId)).rejects.toMatchObject({ code: "unsupported" });
			expect(await Bun.file(owned).text()).toBe(original);
			child.stdin.end();
			expect(await child.exited).toBe(0);
			contender.acquireRuntimeOwnership();
			await expect(fx.service.delete(ownedId)).rejects.toMatchObject({ code: "unsupported" });
			await contender.close();
			contender = undefined;
			await manager.setSessionFile(owned);
			await fx.service.delete(firstId);
			await expect(fx.service.delete(ownedId)).rejects.toMatchObject({ code: "unsupported" });
		} finally {
			if (child.exitCode === null) child.stdin.end();
			await child.exited;
			output.releaseLock();
			await contender?.close();
			await manager.close();
		}
		await fx.service.delete(ownedId);
	}, 30_000);

	test("runtime ownership leaves in-memory and lazy persistent sessions off disk", async () => {
		const fx = await setup();
		const memoryStorage = new FileSessionStorage();
		const claim = spyOn(memoryStorage, "claimSession");
		const memory = SessionManager.inMemory(fx.cwd, memoryStorage);
		// create 的 breadcrumb 与本回归无关，不让临时 lazy fixture 写入用户运行目录。
		const breadcrumb = spyOn(sessionPaths, "writeTerminalBreadcrumb").mockImplementation(() => {});
		let lazy: SessionManager;
		try {
			lazy = SessionManager.create(fx.cwd, fx.sessionDir);
		} finally {
			breadcrumb.mockRestore();
		}
		try {
			memory.acquireRuntimeOwnership();
			expect(claim).not.toHaveBeenCalled();
			expect(memory.getSessionFile()).toBeUndefined();
			lazy.acquireRuntimeOwnership();
			expect(await Bun.file(lazy.getSessionFile()!).exists()).toBe(false);
			expect(await fx.service.list()).toEqual([]);
		} finally {
			claim.mockRestore();
			await memory.close();
			await lazy.close();
		}
		expect(await fs.readdir(fx.sessionDir)).toEqual([]);
	});

	test("lists only this project's sessions and marks the live one current", async () => {
		const fx = await setup();
		await writeSession(fx.sessionDir, "s-own-1", fx.cwd, "Mine");
		await writeSession(fx.sessionDir, "s-own-2", fx.cwd);
		await writeSession(fx.sessionDir, "s-other", path.resolve(fx.cwd, "..", "elsewhere"));
		const liveSession = {
			sessionManager: { getSessionId: () => "s-own-1", getCwd: () => fx.cwd },
			isDisposed: false,
			isStreaming: false,
			setSessionName: async () => true,
		};
		const service = new RpcSessionDirectoryService({
			cwd: fx.cwd,
			sessionDir: fx.sessionDir,
			getSession: () => liveSession as never,
		});
		const sessions = await service.list();
		expect(sessions.map(session => session.sessionId).sort()).toEqual(["s-own-1", "s-own-2"]);
		expect(sessions.find(session => session.sessionId === "s-own-1")).toMatchObject({
			current: true,
			name: "Mine",
		});
		expect(sessions.find(session => session.sessionId === "s-own-2")?.current).toBe(false);
	});

	test("a saved header without a timestamp does not prevent listing other sessions", async () => {
		const fx = await setup();
		await writeSession(fx.sessionDir, "s-valid", fx.cwd, "Valid");
		const header = { type: "session", version: 2, id: "s-no-date", cwd: fx.cwd, title: "No date" };
		await Bun.write(path.join(fx.sessionDir, "s-no-date.jsonl"), `${JSON.stringify(header)}\n`);

		const sessions = await fx.service.list();
		expect(sessions.map(session => session.sessionId).sort()).toEqual(["s-no-date", "s-valid"]);
		const withoutDate = sessions.find(session => session.sessionId === "s-no-date")!;
		expect(withoutDate.createdAt).toBeUndefined();
		expect(sessions.find(session => session.sessionId === "s-valid")!.createdAt).toBeDefined();
	});

	test("listing retries metadata whose file changes during its asynchronous read", async () => {
		const fx = await setup();
		const file = await writeSession(fx.sessionDir, "s-read-race", fx.cwd, "Original");
		const storage = new FileSessionStorage();
		const service = new RpcSessionDirectoryService({ cwd: fx.cwd, sessionDir: fx.sessionDir, storage });
		const original = await Bun.file(file).text();
		const updated =
			serializeTitleSlot({ title: "Concurrent", source: "user", updatedAt: new Date().toISOString() }) +
			original.slice(original.indexOf("\n") + 1) +
			"\n";
		const read = storage.readTextSlices.bind(storage);
		let changed = false;
		const slices = spyOn(storage, "readTextSlices").mockImplementation(async (...args) => {
			const result = await read(...args);
			if (!changed && args[0] === file) {
				changed = true;
				storage.writeTextSync(file, updated);
			}
			return result;
		});
		try {
			const [entry] = await service.list();
			expect(changed).toBe(true);
			expect(entry?.name).toBe("Concurrent");
			expect(entry?.revision).toBe((await service.list())[0]?.revision);
			await expect(service.rename("s-read-race", "Accepted", entry!.revision)).resolves.toMatchObject({
				name: "Accepted",
			});
		} finally {
			slices.mockRestore();
		}
	});

	for (const operation of ["list", "rename"] as const) {
		test(`${operation} summaries keep the revision of their metadata when a later scan updates the file`, async () => {
			const fx = await setup();
			const first = await writeSession(fx.sessionDir, "a-snapshot", fx.cwd, "Original");
			const second = await writeSession(fx.sessionDir, "b-trigger", fx.cwd, "Trigger");
			const assistant = `${JSON.stringify({
				type: "message",
				id: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
			})}\n`;
			await fs.appendFile(first, assistant);
			await fs.appendFile(second, assistant);
			const storage = new FileSessionStorage();
			const service = new RpcSessionDirectoryService({ cwd: fx.cwd, sessionDir: fx.sessionDir, storage });
			const original = await Bun.file(first).text();
			const concurrent =
				serializeTitleSlot({ title: "Concurrent", source: "user", updatedAt: new Date().toISOString() }) +
				original.slice(original.indexOf("\n") + 1) +
				"\n";
			let armed = operation === "list";
			let changed = false;
			const list = storage.listFilesSync.bind(storage);
			const files = spyOn(storage, "listFilesSync").mockImplementation((...args) => list(...args).sort());
			const read = storage.readTextSlices.bind(storage);
			const slices = spyOn(storage, "readTextSlices").mockImplementation(async (...args) => {
				const result = await read(...args);
				if (armed && args[0] === second) {
					armed = false;
					changed = true;
					storage.writeTextSync(first, concurrent);
				}
				return result;
			});
			const write = storage.writeTextAtomic.bind(storage);
			const atomic = spyOn(storage, "writeTextAtomic").mockImplementation(async (...args) => {
				await write(...args);
				armed = true;
				invalidateSessionScan(second, storage);
			});
			try {
				const summary =
					operation === "list"
						? (await service.list()).find(entry => entry.sessionId === "a-snapshot")!
						: await service.rename("a-snapshot", "Renamed");
				expect(changed).toBe(true);
				expect(summary.name).toBe(operation === "list" ? "Original" : "Renamed");
				const latest = (await service.list()).find(entry => entry.sessionId === "a-snapshot")!;
				expect(latest.name).toBe("Concurrent");
				expect(summary.revision).not.toBe(latest.revision);
				await expect(service.rename("a-snapshot", "Stale", summary.revision)).rejects.toMatchObject({
					code: "revision_conflict",
				});
				await expect(service.delete("a-snapshot", summary.revision)).rejects.toMatchObject({
					code: "revision_conflict",
				});
			} finally {
				atomic.mockRestore();
				slices.mockRestore();
				files.mockRestore();
			}
		});
	}

	test("rename survives an EPERM replacement and guards stale revisions", async () => {
		const fx = await setup();
		await writeSession(fx.sessionDir, "s-save", fx.cwd, "Old");
		const storage = new FileSessionStorage();
		const service = new RpcSessionDirectoryService({ cwd: fx.cwd, sessionDir: fx.sessionDir, storage });
		const renameSync = storage.renameSync.bind(storage);
		let blocked = false;
		const replacement = spyOn(storage, "renameSync").mockImplementation((source, target) => {
			if (!blocked && source.endsWith(".tmp")) {
				blocked = true;
				throw Object.assign(new Error("replacement blocked"), { code: "EPERM" });
			}
			renameSync(source, target);
		});
		const [entry] = await fx.service.list();
		try {
			const renamed = await service.rename("s-save", "New name", entry!.revision);
			expect(renamed).toMatchObject({ sessionId: "s-save", name: "New name", current: false });
		} finally {
			replacement.mockRestore();
		}
		expect(blocked).toBe(true);
		expect((await fx.service.list())[0]!.name).toBe("New name");

		await expect(fx.service.rename("s-save", "Stale", entry!.revision)).rejects.toMatchObject({
			code: "revision_conflict",
		});
		await expect(fx.service.rename("s-missing", "Whatever")).rejects.toMatchObject({ code: "not_found" });
		await expect(fx.service.rename("s-save", "   ")).rejects.toMatchObject({ code: "invalid_params" });
		// The session header identity is preserved.
		const content = await Bun.file(path.join(fx.sessionDir, "s-save.jsonl")).text();
		expect(content).toContain('"id":"s-save"');
	});

	test("rename refuses an externally owned session without changing it and succeeds after release", async () => {
		const fx = await setup();
		const sessionId = `s-rename-leased-${crypto.randomUUID()}`;
		const file = await writeSession(fx.sessionDir, sessionId, fx.cwd, "Original owner title");
		const original = await Bun.file(file).text();
		const [entry] = await fx.service.list();
		const lease = tryAcquireSessionLease(sessionId);
		expect(lease).not.toBeNull();
		try {
			await expect(fx.service.rename(sessionId, "Renamed externally", entry!.revision)).rejects.toMatchObject({
				code: "execution_failed",
				message: expect.stringContaining("another process"),
			});
			expect(await Bun.file(file).text()).toBe(original);
			expect((await fx.service.list())[0]!.name).toBe("Original owner title");
		} finally {
			lease!.release();
		}
		expect(await fx.service.rename(sessionId, "Renamed after closing", entry!.revision)).toMatchObject({
			name: "Renamed after closing",
			current: false,
		});
		const released = tryAcquireSessionLease(sessionId);
		try {
			expect(released).not.toBeNull();
		} finally {
			released?.release();
		}
	});

	test("rename of the hosted session routes through the live session", async () => {
		const fx = await setup();
		const sessionFile = await writeSession(fx.sessionDir, "s-live", fx.cwd, "Old");
		const names: string[] = [];
		const liveSession = {
			sessionManager: {
				getSessionId: () => "s-live",
				getCwd: () => fx.cwd,
				getSessionFile: () => sessionFile,
			},
			isDisposed: false,
			isStreaming: false,
			setSessionName: async (name: string) => {
				names.push(name);
				// Make the hosted file revision change as a successful live rename would.
				await fs.appendFile(sessionFile, "\n");
				return true;
			},
		};
		const service = new RpcSessionDirectoryService({
			cwd: fx.cwd,
			sessionDir: fx.sessionDir,
			getSession: () => liveSession as never,
		});
		const lease = tryAcquireSessionLease("s-live");
		expect(lease).not.toBeNull();
		try {
			const [entry] = await service.list();
			const renamed = await service.rename("s-live", "Renamed live", entry!.revision);
			expect(names).toEqual(["Renamed live"]);
			// The listing reflects the header re-read after the live rename attempt.
			expect(renamed.sessionId).toBe("s-live");
			await expect(service.rename("s-live", "Stale live", entry!.revision)).rejects.toMatchObject({
				code: "revision_conflict",
			});
			expect(names).toEqual(["Renamed live"]);
			// A streaming session refuses the rename instead of interleaving writes.
			const streaming = { ...liveSession, isStreaming: true };
			const streamingService = new RpcSessionDirectoryService({
				cwd: fx.cwd,
				sessionDir: fx.sessionDir,
				getSession: () => streaming as never,
			});
			await expect(streamingService.rename("s-live", "Nope")).rejects.toMatchObject({ code: "execution_failed" });
		} finally {
			lease!.release();
		}
	});

	test("delete refuses the hosted session and guards revisions", async () => {
		const fx = await setup();
		await writeSession(fx.sessionDir, "s-gone", fx.cwd);
		const [entry] = await fx.service.list();
		await fx.service.delete("s-gone", entry!.revision);
		expect((await fx.service.list()).map(session => session.sessionId)).toEqual([]);

		await writeSession(fx.sessionDir, "s-live", fx.cwd);
		const liveSession = {
			sessionManager: { getSessionId: () => "s-live", getCwd: () => fx.cwd },
			isDisposed: false,
			isStreaming: false,
			setSessionName: async () => true,
		};
		const service = new RpcSessionDirectoryService({
			cwd: fx.cwd,
			sessionDir: fx.sessionDir,
			getSession: () => liveSession as never,
		});
		await expect(service.delete("s-live")).rejects.toMatchObject({ code: "unsupported" });
		await expect(fx.service.delete("s-never")).rejects.toMatchObject({ code: "not_found" });
	});

	test("rename across projects is refused", async () => {
		const fx = await setup();
		const otherCwd = path.resolve(fx.cwd, "..", "elsewhere");
		await writeSession(fx.sessionDir, "s-foreign", otherCwd);
		await expect(fx.service.rename("s-foreign", "Nope")).rejects.toMatchObject({ code: "scope_not_allowed" });
		await expect(fx.service.delete("s-foreign")).rejects.toMatchObject({ code: "scope_not_allowed" });
		expect(RpcSessionDirectoryError.name).toBe("RpcSessionDirectoryError");
	});

	test("rename of a legacy file without a title slot prepends the slot and preserves every byte", async () => {
		const fx = await setup();
		// Sessions written before the title-slot format start with the header
		// line; an in-place 256-byte overlay would destroy it.
		const now = new Date().toISOString();
		const header = { type: "session", version: 2, id: "s-legacy", timestamp: now, cwd: fx.cwd };
		const body = `${JSON.stringify(header)}\n{"type":"user","id":"u1","ts":"${now}","message":"hi"}\n`;
		const file = path.join(fx.sessionDir, "s-legacy.jsonl");
		await Bun.write(file, body);

		const renamed = await fx.service.rename("s-legacy", "Migrated");
		expect(renamed).toMatchObject({ sessionId: "s-legacy", name: "Migrated", current: false });

		const updated = await Bun.file(file).text();
		// The original body survives byte-for-byte after the prepended slot.
		expect(updated.slice(256)).toBe(body);
		const slotLine = updated.slice(0, updated.indexOf("\n"));
		expect(slotLine).toContain('"title":"Migrated"');
		// The header is still parseable and identity-intact.
		const headerLine = updated.split("\n")[1]!;
		expect(JSON.parse(headerLine)).toMatchObject({ type: "session", id: "s-legacy", cwd: fx.cwd });
		expect((await fx.service.list())[0]!.name).toBe("Migrated");
	});

	test("delete refuses a session whose ownership lease another holder keeps", async () => {
		const fx = await setup();
		await writeSession(fx.sessionDir, "s-leased", fx.cwd);
		const [entry] = await fx.service.list();
		const lease = tryAcquireSessionLease("s-leased");
		expect(lease).not.toBeNull();
		try {
			await expect(fx.service.delete("s-leased", entry!.revision)).rejects.toMatchObject({
				code: "unsupported",
				message: expect.stringContaining("another process"),
			});
			// The file is untouched while the lease is held.
			expect(await Bun.file(path.join(fx.sessionDir, "s-leased.jsonl")).exists()).toBe(true);
		} finally {
			lease!.release();
		}
		// With the lease released the same revision deletes cleanly.
		await fx.service.delete("s-leased", entry!.revision);
		expect((await fx.service.list()).map(session => session.sessionId)).toEqual([]);
	});

	test("rename of a hosted session that has not flushed to disk returns its in-memory summary", async () => {
		const fx = await setup();
		const liveSession = {
			sessionManager: {
				getSessionId: () => "s-unflushed",
				getSessionName: () => "Fresh name",
				getCwd: () => fx.cwd,
			},
			isDisposed: false,
			isStreaming: false,
			setSessionName: async () => true,
		};
		const service = new RpcSessionDirectoryService({
			cwd: fx.cwd,
			sessionDir: fx.sessionDir,
			getSession: () => liveSession as never,
		});
		const renamed = await service.rename("s-unflushed", "Fresh name");
		expect(renamed).toMatchObject({ sessionId: "s-unflushed", name: "Fresh name", current: true });
		expect(renamed.sessionFile).toBeUndefined();
		expect(typeof renamed.revision).toBe("string");
	});
});
