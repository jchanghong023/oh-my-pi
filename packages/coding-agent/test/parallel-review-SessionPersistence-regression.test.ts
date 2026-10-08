import { afterEach, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { listSessionsReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

test("saved-session listings refresh a peer's same-size retitle when only change time differs", async () => {
	using dir = TempDir.createSync("omp-peer-session-retitle-");
	const file = path.join(dir.path(), "session.jsonl");
	const reader = new FileSessionStorage();
	const peer = new FileSessionStorage();
	const timestamp = "2026-01-01T00:00:00.000Z";
	const header = `${JSON.stringify({ type: "session", version: 3, id: "peer-retitle", timestamp, cwd: dir.path() })}\n`;
	const body = (title: string) => serializeTitleSlot({ title, source: "user", updatedAt: timestamp }) + header;
	peer.writeTextSync(file, body("Before"));

	// Model a filesystem retaining/coarsening mtime across a temp-file rename.
	// Only the listing reader gets this metadata seam; the peer writes the real
	// replacement without calling this process's cache invalidation helper.
	const statSync = reader.statSync.bind(reader);
	let ctimeMs = 1;
	vi.spyOn(reader, "statSync").mockImplementation(filePath => ({
		...statSync(filePath),
		mtimeMs: 0,
		mtime: new Date(0),
		ctimeMs,
	}));
	const beforeSize = reader.statSync(file).size;
	expect((await listSessionsReadOnly(dir.path(), reader)).map(info => info.title)).toEqual(["Before"]);

	peer.writeTextSync(file, body("After"));
	ctimeMs = 2;
	expect(reader.statSync(file).size).toBe(beforeSize);
	expect((await listSessionsReadOnly(dir.path(), reader)).map(info => info.title)).toEqual(["After"]);
});
