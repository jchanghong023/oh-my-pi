import { describe, expect, it, spyOn } from "bun:test";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const SESSION_DIR = "/sessions/project";

function writeSession(storage: MemorySessionStorage, file: string, firstPrompt: string): void {
	storage.writeTextSync(
		file,
		[
			JSON.stringify({
				type: "session",
				id: "cache-id",
				cwd: "/repo",
				title: "Cached Title",
				timestamp: "2026-06-27T00:00:00.000Z",
			}),
			JSON.stringify({ type: "message", message: { role: "user", content: firstPrompt } }),
			"",
		].join("\n"),
	);
}

describe("session listing scan cache", () => {
	it("serves an unchanged file from cache without re-reading it", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/cached.jsonl`;
		writeSession(storage, file, "first prompt");
		const readSpy = spyOn(storage, "readTextSlices");

		const first = await listSessions(SESSION_DIR, storage);
		expect(first.map(s => s.id)).toEqual(["cache-id"]);
		expect(readSpy).toHaveBeenCalledTimes(1);

		const second = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it("invalidates when the file's size changes", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/grows.jsonl`;
		writeSession(storage, file, "short");
		const readSpy = spyOn(storage, "readTextSlices");

		await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);

		// Simulate the active session growing during streaming.
		writeSession(storage, file, "a much longer replacement prompt");
		const after = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(2);
		expect(after[0]?.firstMessage).toBe("a much longer replacement prompt");
	});

	it("invalidates when mtime changes even at identical size", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/retitle.jsonl`;
		writeSession(storage, file, "same-length");
		const readSpy = spyOn(storage, "readTextSlices");

		await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);

		// Simulate updateSessionTitle's in-place slot rewrite: same byte length,
		// newer mtime (MemorySessionStorage stamps Date.now on write). Advance
		// the clock deterministically instead of sleeping.
		const nowSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 10);
		try {
			writeSession(storage, file, "SAME-LENGTH");
		} finally {
			nowSpy.mockRestore();
		}
		const after = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(2);
		expect(after[0]?.firstMessage).toBe("SAME-LENGTH");
	});

	it("invalidates when only ctime changes after a same-size replacement", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/peer-replacement.jsonl`;
		const statSync = storage.statSync.bind(storage);
		let ctimeMs = 1;
		const mtime = new Date(0);
		const stat = spyOn(storage, "statSync").mockImplementation(filePath => ({
			...statSync(filePath),
			mtimeMs: mtime.getTime(),
			mtime,
			ctimeMs,
		}));
		try {
			writeSession(storage, file, "before");
			const size = statSync(file).size;
			expect((await listSessions(SESSION_DIR, storage))[0]?.firstMessage).toBe("before");

			writeSession(storage, file, "AFTER!");
			expect(statSync(file).size).toBe(size);
			ctimeMs++;
			expect((await listSessions(SESSION_DIR, storage))[0]?.firstMessage).toBe("AFTER!");
		} finally {
			stat.mockRestore();
		}
	});

	it("keeps an actively growing session in the list while reading its preview", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/streaming.jsonl`;
		writeSession(storage, file, "running prompt");
		const readTextSlices = storage.readTextSlices.bind(storage);
		const read = spyOn(storage, "readTextSlices").mockImplementation(async (...args) => {
			const slices = await readTextSlices(...args);
			storage.appendSync(file, '{"type":"message","message":{"role":"assistant","content":"streaming"}}\n');
			return slices;
		});
		try {
			expect((await listSessions(SESSION_DIR, storage))[0]?.firstMessage).toBe("running prompt");
		} finally {
			read.mockRestore();
		}
	});

	it("caches negative results for unparseable files", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/garbage.jsonl`;
		storage.writeTextSync(file, "not json at all\n");
		const readSpy = spyOn(storage, "readTextSlices");

		expect(await listSessions(SESSION_DIR, storage)).toEqual([]);
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(await listSessions(SESSION_DIR, storage)).toEqual([]);
		expect(readSpy).toHaveBeenCalledTimes(1);
	});
});
