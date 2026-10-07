// Unit coverage for RpcSessionDirectoryService (rpc-fork-sessions.ts): the
// per-cwd saved-session listing, guarded rename (title-slot surgery with
// revision checks), and guarded delete, over a real session directory.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
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
		version: 2,
		id,
		timestamp: now,
		cwd,
	};
	await Bun.write(file, `${slot}${JSON.stringify(header)}\n{"type":"user","id":"u1","ts":"${now}","message":"hi"}\n`);
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

	test("rename of a saved session rewrites the title slot with revision guards", async () => {
		const fx = await setup();
		await writeSession(fx.sessionDir, "s-save", fx.cwd, "Old");
		const [entry] = await fx.service.list();
		const renamed = await fx.service.rename("s-save", "New name", entry!.revision);
		expect(renamed).toMatchObject({ sessionId: "s-save", name: "New name", current: false });
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

	test("rename of the hosted session routes through the live session", async () => {
		const fx = await setup();
		await writeSession(fx.sessionDir, "s-live", fx.cwd, "Old");
		const names: string[] = [];
		const liveSession = {
			sessionManager: { getSessionId: () => "s-live", getCwd: () => fx.cwd },
			isDisposed: false,
			isStreaming: false,
			setSessionName: async (name: string) => {
				names.push(name);
				return true;
			},
		};
		const service = new RpcSessionDirectoryService({
			cwd: fx.cwd,
			sessionDir: fx.sessionDir,
			getSession: () => liveSession as never,
		});
		const renamed = await service.rename("s-live", "Renamed live");
		expect(names).toEqual(["Renamed live"]);
		// The listing reflects the header re-read after the live rename attempt.
		expect(renamed.sessionId).toBe("s-live");
		// A streaming session refuses the rename instead of interleaving writes.
		const streaming = { ...liveSession, isStreaming: true };
		const streamingService = new RpcSessionDirectoryService({
			cwd: fx.cwd,
			sessionDir: fx.sessionDir,
			getSession: () => streaming as never,
		});
		await expect(streamingService.rename("s-live", "Nope")).rejects.toMatchObject({ code: "execution_failed" });
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
});
