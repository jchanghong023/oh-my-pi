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

	it("keeps the full first prompt when the 4 KB prefix window cuts its line (default title)", async () => {
		// 缺陷回归(automation 首条输入默认标题截断): 无标题会话的默认标题取
		// firstMessage。首条用户消息行被前缀窗口按字节截断时,旧行为把窗口碎片
		// (如 "E2E_AUTOMA")当完整文本写进默认标题。窗口必须扩读到该行完整,
		// 默认标题保持完整首条输入。
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/window-cut.jsonl`;
		const header =
			JSON.stringify({
				type: "session",
				id: "window-cut-id",
				cwd: "/repo",
				timestamp: "2026-10-21T23:45:37.186Z",
			}) + "\n";
		const userLine =
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "E2E_AUTOMATION_TITLE_STABLE 随机介绍一位红楼梦人物" }],
				},
			}) + "\n";
		// 用一条大 custom 前缀条目把用户消息行推到 4096 字节边界中间。
		const prefixOverhead = Buffer.byteLength(header, "utf8");
		const padLine =
			JSON.stringify({
				type: "custom",
				customType: "session_input",
				data: { pad: "x".repeat(4096 - prefixOverhead - 120) },
			}) + "\n";
		if (Buffer.byteLength(header + padLine, "utf8") <= 4096 - Buffer.byteLength(userLine, "utf8")) {
			throw new Error("fixture padding must push the user line across the 4096-byte window");
		}
		if (Buffer.byteLength(header + padLine, "utf8") >= 4096) {
			throw new Error("fixture padding must keep the user line starting inside the window");
		}
		storage.writeTextSync(file, header + padLine + userLine);

		const sessions = await listSessions(SESSION_DIR, storage);
		expect(sessions[0]?.title).toBeUndefined();
		expect(sessions[0]?.firstMessage).toBe("E2E_AUTOMATION_TITLE_STABLE 随机介绍一位红楼梦人物");
	});
});
