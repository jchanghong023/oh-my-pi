import { afterEach, describe, expect, test } from "bun:test";
import type { AgentUserMessage } from "@oh-my-pi/pi-agent-core";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore } from "../../src/session/blob-store";
import { ZCodeAttachmentResources } from "../../src/modes/zcode/attachments";
import type { ConversationRow } from "../../src/modes/zcode/schema";
import { SessionManager } from "../../src/session/session-manager";
import { loadSessionMessagesReadOnly } from "../../src/session/session-loader";
import { ZCodeProjection } from "../../src/modes/zcode/projection";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zcode-attachments-"));
	roots.push(root);
	const blobs = new BlobStore(root);
	const rows = new Map<string, ConversationRow[]>();
	const options = {
		blobDir: root,
		getSession: async (id: string) => {
			if (id !== "s1" && id !== "s2") throw new Error("Session not found");
			return { session: { sessionManager: { putBlob: blobs.put.bind(blobs) } } };
		},
		getRows: async (id: string) => rows.get(id) ?? [],
	};
	const resources = new ZCodeAttachmentResources(options);
	const bytes = Buffer.from("preserved\0bytes");
	const begin = {
		connectionId: "c1",
		sessionId: "s1",
		uploadId: "u1",
		fileName: "note.txt",
		mime: "text/plain",
		totalBytes: bytes.length,
		totalChunks: 1,
		checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
	};
	return { root, resources, options, rows, bytes, begin };
}
describe("ZCode attachment resources", () => {
	test("preserves bytes, idempotent commits, and cold row authorization", async () => {
		const f = await fixture();
		await f.resources.attachmentBegin(f.begin);
		await f.resources.attachmentChunk({
			...terminal(f.begin),
			chunkIndex: 0,
			dataBase64: f.bytes.toString("base64"),
		});
		const committed = await f.resources.attachmentCommit(terminal(f.begin));
		expect(await f.resources.attachmentCommit(terminal(f.begin))).toEqual(committed);
		const input = await f.resources.resolveInputAttachments("s1", [
			{ ref: committed.ref, fileName: "note.txt", mime: "text/plain", bytes: f.bytes.length },
		]);
		expect(input.text).toContain(committed.ref);
		const journal = SessionManager.create(f.root, path.join(f.root, "sessions"));
		const message: AgentUserMessage = {
			role: "user",
			content: "attached",
			timestamp: 1,
			inputId: "input-1",
			attachments: input.attachments,
		};
		journal.appendMessage(message);
		await journal.ensureOnDisk();
		const sessionFile = journal.getSessionFile();
		if (!sessionFile) throw new Error("Missing persisted session");
		await journal.close();
		const projection = new ZCodeProjection({
			sessionId: "s1",
			cwd: f.root,
			messages: await loadSessionMessagesReadOnly(sessionFile),
		});
		f.rows.set("s1", projection.rows());
		const row = projection.rows().find(candidate => candidate.kind === "userInput");
		if (!row) throw new Error("Missing cold user row");
		const target = { rowId: row.rowId, entityId: row.entityId };
		f.resources.dispose();
		const cold = new ZCodeAttachmentResources(f.options);
		const result = await cold.conversationAttachmentRead({
			sessionId: "s1",
			ref: committed.ref,
			target,
			attachmentIndex: 0,
			offset: 0,
			limit: 512,
		});
		expect(Buffer.from(result.dataBase64, "base64")).toEqual(f.bytes);
		expect(
			(await cold.conversationAttachmentStat({ sessionId: "s1", ref: committed.ref, target, attachmentIndex: 0 }))
				.totalBytes,
		).toBe(f.bytes.length);
		await expect(
			cold.conversationAttachmentRead({
				sessionId: "s2",
				ref: committed.ref,
				target,
				attachmentIndex: 0,
				offset: 0,
				limit: 512,
			}),
		).rejects.toThrow("NotAuthorized");
		await expect(
			cold.conversationAttachmentStat({
				sessionId: "s1",
				ref: committed.ref,
				target: { ...target, entityId: "wrong" },
				attachmentIndex: 0,
			}),
		).rejects.toThrow("NotAuthorized");
		const partial = await cold.conversationAttachmentRead({
			sessionId: "s1",
			ref: committed.ref,
			target,
			attachmentIndex: 0,
			offset: 1,
			limit: 3,
		});
		expect(Buffer.from(partial.dataBase64, "base64")).toEqual(f.bytes.subarray(1, 4));
		expect(partial.nextOffset).toBe(4);
		await expect(
			cold.conversationAttachmentRead({
				sessionId: "s1",
				ref: committed.ref,
				target,
				attachmentIndex: 0,
				offset: f.bytes.length + 1,
				limit: 1,
			}),
		).rejects.toThrow("previewRangeInvalid");
		await expect(
			cold.attachmentRead({ sessionId: "s1", ref: committed.ref, target, attachmentIndex: 0, offset: 0, limit: 1 }),
		).rejects.toThrow("previewRefNotAuthorized");
	});
	test("rejects wrong upload scope, ordering, excess bytes, checksum and paths", async () => {
		const f = await fixture();
		await f.resources.attachmentBegin(f.begin);
		const chunk = { ...terminal(f.begin), chunkIndex: 0, dataBase64: f.bytes.toString("base64") };
		await expect(f.resources.attachmentChunk({ ...chunk, sessionId: "s2" })).rejects.toThrow("uploadNotFound");
		await expect(f.resources.attachmentChunk({ ...chunk, chunkIndex: 1 })).rejects.toThrow("chunkGap");
		await expect(
			f.resources.attachmentChunk({ ...chunk, dataBase64: Buffer.alloc(f.bytes.length + 1).toString("base64") }),
		).rejects.toThrow("totalBytesExceeded");
		await f.resources.attachmentChunk(chunk);
		await expect(
			f.resources.attachmentChunk({ ...chunk, dataBase64: Buffer.alloc(f.bytes.length).toString("base64") }),
		).rejects.toThrow("chunkConflict");
		await expect(
			f.resources.resolveInputAttachments("s2", [
				{ ref: "../../secret", fileName: "x", mime: "text/plain", bytes: 1 },
			]),
		).rejects.toThrow("NotAuthorized");
		const bad = { ...f.begin, uploadId: "bad", checksum: `sha256:${"0".repeat(64)}` };
		await f.resources.attachmentBegin(bad);
		await f.resources.attachmentChunk({ ...chunk, uploadId: "bad" });
		await expect(f.resources.attachmentCommit(terminal(bad))).rejects.toThrow("checksumMismatch");
		expect(await fs.readdir(f.root)).toEqual([]);
	});
	test("accepts zero-byte uploads and rejects oversized chunks before staging", async () => {
		const f = await fixture();
		const zero = {
			...f.begin,
			totalBytes: 0,
			totalChunks: 0,
			checksum: `sha256:${createHash("sha256").digest("hex")}`,
		};
		await f.resources.attachmentBegin(zero);
		const committed = await f.resources.attachmentCommit(terminal(zero));
		expect(await fs.readFile(path.join(f.root, committed.ref.slice("blob:sha256:".length)))).toHaveLength(0);
		await f.resources.attachmentBegin({ ...f.begin, uploadId: "bounded" });
		await expect(
			f.resources.attachmentChunk({
				...terminal(f.begin),
				uploadId: "bounded",
				chunkIndex: 0,
				dataBase64: Buffer.alloc(512 * 1024 + 1).toString("base64"),
			}),
		).rejects.toThrow();
		await expect(f.resources.attachmentCommit({ ...terminal(f.begin), uploadId: "bounded" })).rejects.toThrow(
			"uploadIncomplete",
		);
	});
	test("projects committed image input bytes and authorized bounded previews", async () => {
		const f = await fixture();
		await f.resources.attachmentBegin({ ...f.begin, mime: "image/png" });
		await f.resources.attachmentChunk({
			...terminal(f.begin),
			chunkIndex: 0,
			dataBase64: f.bytes.toString("base64"),
		});
		const { ref } = await f.resources.attachmentCommit(terminal(f.begin));
		const input = await f.resources.resolveInputAttachments("s1", [
			{ ref, fileName: "note.txt", mime: "image/png", bytes: f.bytes.length },
		]);
		expect(Buffer.from(input.images[0].data, "base64")).toEqual(f.bytes);
		const target = { rowId: 1, entityId: "image" };
		f.rows.set("s1", [{ ...target, kind: "userInput", attachments: input.attachments } as ConversationRow]);
		expect(
			await f.resources.attachmentRead({ sessionId: "s1", ref, target, attachmentIndex: 0, offset: 0, limit: 2 }),
		).toEqual({
			dataBase64: f.bytes.subarray(0, 2).toString("base64"),
			mediaType: "image/png",
			totalBytes: f.bytes.length,
			nextOffset: 2,
		});
		expect(
			await f.resources.attachmentPreviewSource({
				sessionId: "s1",
				ref,
				target,
				attachmentIndex: 0,
				clientMode: "web-remote-replayable",
			}),
		).toEqual({ kind: "chunked" });
		await expect(
			f.resources.attachmentRead({ sessionId: "s1", ref, target, attachmentIndex: 1, offset: 0, limit: 2 }),
		).rejects.toThrow("NotAuthorized");
	});
	test("abort and connection cleanup release only owned staging, never committed blobs", async () => {
		const f = await fixture();
		await f.resources.attachmentBegin(f.begin);
		await f.resources.attachmentBegin({ ...f.begin, connectionId: "c2" });
		f.resources.closeConnection("c1");
		await expect(f.resources.attachmentCommit(terminal(f.begin))).rejects.toThrow("uploadNotFound");
		await f.resources.attachmentChunk({
			...terminal(f.begin),
			connectionId: "c2",
			chunkIndex: 0,
			dataBase64: f.bytes.toString("base64"),
		});
		const { ref } = await f.resources.attachmentCommit({ ...terminal(f.begin), connectionId: "c2" });
		await f.resources.attachmentAbort({ ...terminal(f.begin), connectionId: "c2" });
		f.resources.dispose();
		expect(await fs.readFile(path.join(f.root, ref.slice("blob:sha256:".length)))).toEqual(f.bytes);
	});
	test("rejects symlink blob escape after authoritative row authorization", async () => {
		const f = await fixture();
		const hash = "a".repeat(64);
		const ref = `blob:sha256:${hash}`;
		const outside = `${f.root}-private`;
		roots.push(outside);
		await fs.mkdir(outside);
		const secret = path.join(outside, "secret");
		await fs.writeFile(secret, "secret");
		await fs.symlink(
			process.platform === "win32" ? outside : secret,
			path.join(f.root, hash),
			process.platform === "win32" ? "junction" : "file",
		);
		const target = { rowId: 1, entityId: "i" };
		f.rows.set("s1", [
			{
				...target,
				kind: "userInput",
				attachments: [{ ref, mime: "text/plain", bytes: 6, fileName: "x" }],
			} as ConversationRow,
		]);
		await expect(
			f.resources.conversationAttachmentStat({ sessionId: "s1", ref, target, attachmentIndex: 0 }),
		).rejects.toThrow("NotAuthorized");
	});
});
function terminal(begin: { connectionId: string; sessionId: string; uploadId: string }) {
	return { connectionId: begin.connectionId, sessionId: begin.sessionId, uploadId: begin.uploadId };
}
