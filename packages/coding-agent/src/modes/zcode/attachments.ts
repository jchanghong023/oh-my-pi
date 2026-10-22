import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir } from "@oh-my-pi/pi-utils";
import type { BlobPutResult } from "../../session/blob-store";
import {
	PROTOCOL_V4_LIMITS as limits,
	attachmentRefSchema,
	v4AttachmentBeginParamsSchema,
	v4AttachmentChunkParamsSchema,
	v4AttachmentCommitParamsSchema,
	v4AttachmentAbortParamsSchema,
	v4AttachmentReadParamsSchema,
	v4AttachmentReadResultSchema,
	v4ConversationAttachmentReadParamsSchema,
	v4ConversationAttachmentReadResultSchema,
	v4ConversationAttachmentStatParamsSchema,
	v4ConversationAttachmentStatResultSchema,
	v4AttachmentPreviewSourceParamsSchema,
	type AttachmentRef,
	type ConversationRow,
	type V4AttachmentBeginParams,
	type V4AttachmentBeginResult,
	type V4AttachmentCommitResult,
	type V4AttachmentPreviewSourceResult,
} from "./schema";

export interface ZCodeAttachmentResourcesOptions {
	getSession(
		sessionId: string,
	): Promise<{ session: { sessionManager: { putBlob(data: Buffer): Promise<BlobPutResult> } } }>;
	getRows(sessionId: string): Promise<readonly ConversationRow[]>;
	/** Existing OMP blob owner directory; override only for isolated stores. */
	blobDir?: string;
	/** Only a local desktop transport may expose an authorized video path. */
	allowLocalPreview?: boolean;
}
interface Upload {
	metadata: V4AttachmentBeginParams;
	chunks: Buffer[];
	bytes: number;
	expires: number;
	ref?: string;
	commit?: Promise<V4AttachmentCommitResult>;
}
const hashOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const uploadKey = (p: { connectionId: string; sessionId: string; uploadId: string }) =>
	JSON.stringify([p.connectionId, p.sessionId, p.uploadId]);
function fault(code: string): never {
	throw new Error(`fault.attachment.${code}`);
}
const previewable = (a: AttachmentRef) =>
	a.mime.startsWith("image/") ||
	a.mime.startsWith("video/") ||
	a.mime === "application/pdf" ||
	(a.mime === "text/plain" && (a.sourceKind === "clipboard-text" || a.sourceKind === "topic-history"));

/** Protocol staging only. Committed bytes belong to OMP's existing content-addressed blob store. */
export class ZCodeAttachmentResources {
	readonly #options: ZCodeAttachmentResourcesOptions;
	readonly #uploads = new Map<string, Upload>();
	readonly #owned = new Map<string, Map<string, AttachmentRef[]>>();
	#stagedBytes = 0;
	#disposed = false;
	constructor(options: ZCodeAttachmentResourcesOptions) {
		this.#options = options;
	}

	async attachmentBegin(raw: unknown): Promise<V4AttachmentBeginResult> {
		this.#assertOpen();
		const p = v4AttachmentBeginParamsSchema.parse(raw);
		this.#prune();
		await this.#options.getSession(p.sessionId);
		this.#assertOpen();
		const key = uploadKey(p);
		const existing = this.#uploads.get(key);
		if (existing) {
			if (JSON.stringify(existing.metadata) !== JSON.stringify(p)) fault("beginConflict");
			existing.expires = Date.now() + limits.attachmentUploadTtlMs;
			return existing.ref
				? { uploadId: p.uploadId, state: "committed", nextChunkIndex: p.totalChunks, ref: existing.ref }
				: { uploadId: p.uploadId, state: "staging", nextChunkIndex: existing.chunks.length };
		}
		if ([...this.#uploads.values()].filter(u => !u.ref).length >= limits.attachmentUploadMaxConcurrent)
			fault("tooManyUploads");
		if (p.totalBytes > p.totalChunks * limits.attachmentChunkMaxBytes) fault("chunkCountInsufficient");
		this.#uploads.set(key, { metadata: p, chunks: [], bytes: 0, expires: Date.now() + limits.attachmentUploadTtlMs });
		return { uploadId: p.uploadId, state: "staging", nextChunkIndex: 0 };
	}

	async attachmentChunk(raw: unknown): Promise<{ uploadId: string; nextChunkIndex: number }> {
		this.#assertOpen();
		const p = v4AttachmentChunkParamsSchema.parse(raw);
		this.#prune();
		const u = this.#uploads.get(uploadKey(p));
		if (!u || u.ref) fault("uploadNotFound");
		if (u.commit) fault("commitInProgress");
		const bytes = Buffer.from(p.dataBase64, "base64");
		if (bytes.toString("base64") !== p.dataBase64) fault("invalidBase64");
		if (p.chunkIndex < u.chunks.length) {
			if (!u.chunks[p.chunkIndex].equals(bytes)) fault("chunkConflict");
		} else {
			if (p.chunkIndex > u.chunks.length) fault("chunkGap");
			if (p.chunkIndex >= u.metadata.totalChunks) fault("tooManyChunks");
			if (!bytes.length) fault("emptyChunk");
			if (u.bytes + bytes.length > u.metadata.totalBytes) fault("totalBytesExceeded");
			if (this.#stagedBytes + bytes.length > limits.attachmentUploadMaxStagedBytes) fault("stagingCapacityExceeded");
			u.chunks.push(bytes);
			u.bytes += bytes.length;
			this.#stagedBytes += bytes.length;
		}
		u.expires = Date.now() + limits.attachmentUploadTtlMs;
		return { uploadId: p.uploadId, nextChunkIndex: u.chunks.length };
	}

	async attachmentCommit(raw: unknown): Promise<V4AttachmentCommitResult> {
		this.#assertOpen();
		const p = v4AttachmentCommitParamsSchema.parse(raw);
		this.#prune();
		const key = uploadKey(p);
		const u = this.#uploads.get(key);
		if (!u) fault("uploadNotFound");
		if (u.ref) return { ref: u.ref };
		if (u.commit) return u.commit;
		if (u.chunks.length !== u.metadata.totalChunks || u.bytes !== u.metadata.totalBytes) fault("uploadIncomplete");
		const bytes = Buffer.concat(u.chunks, u.bytes);
		if (`sha256:${hashOf(bytes)}` !== u.metadata.checksum) fault("checksumMismatch");
		u.commit = (async () => {
			const record = await this.#options.getSession(p.sessionId);
			if (this.#disposed || this.#uploads.get(key) !== u) fault("uploadNotFound");
			const stored = await record.session.sessionManager.putBlob(bytes);
			// EOF/abort must never remove a published (possibly shared) blob.
			if (this.#disposed || this.#uploads.get(key) !== u) fault("uploadNotFound");
			this.#stagedBytes -= u.bytes;
			u.bytes = 0;
			u.chunks = [];
			u.ref = stored.ref;
			const owned = this.#owned.get(p.sessionId) ?? new Map<string, AttachmentRef[]>();
			this.#owned.set(p.sessionId, owned);
			const refs = owned.get(stored.ref) ?? [];
			owned.set(stored.ref, refs);
			refs.push({ ref: stored.ref, fileName: u.metadata.fileName, mime: u.metadata.mime, bytes: bytes.length });
			return { ref: stored.ref };
		})();
		try {
			return await u.commit;
		} finally {
			u.commit = undefined;
		}
	}

	async attachmentAbort(raw: unknown): Promise<Record<string, never>> {
		this.#assertOpen();
		const p = v4AttachmentAbortParamsSchema.parse(raw);
		const key = uploadKey(p);
		const u = this.#uploads.get(key);
		if (u && !u.ref) this.#delete(key, u);
		return {};
	}

	async resolveInputAttachments(
		sessionId: string,
		raw: readonly unknown[] = [],
	): Promise<{
		attachments: AttachmentRef[];
		images: { type: "image"; data: string; mimeType: string }[];
		text: string;
	}> {
		this.#assertOpen();
		await this.#options.getSession(sessionId);
		const attachments: AttachmentRef[] = [];
		const images: { type: "image"; data: string; mimeType: string }[] = [];
		const text: string[] = [];
		const rows = await this.#options.getRows(sessionId);
		for (const value of raw) {
			const a = attachmentRefSchema.parse(value);
			const candidates = [
				...(this.#owned.get(sessionId)?.get(a.ref) ?? []),
				...rows.flatMap(row => (row.kind === "userInput" ? (row.attachments ?? []) : [])),
			];
			const owner = candidates.find(
				item =>
					item.ref === a.ref && item.mime === a.mime && item.bytes === a.bytes && item.fileName === a.fileName,
			);
			if (!owner) fault("inputRefNotAuthorized");
			const file = await this.#file(a.ref);
			const bytes = await this.#bytes(file.path, a.ref, limits.attachmentMaxBytes);
			if (bytes.length !== a.bytes) fault("inputRefNotAuthorized");
			attachments.push({
				...owner,
				...(a.sourceKind ? { sourceKind: a.sourceKind } : {}),
				...(a.messageCount !== undefined ? { messageCount: a.messageCount } : {}),
			});
			if (a.mime.startsWith("image/"))
				images.push({ type: "image", data: bytes.toString("base64"), mimeType: a.mime });
			else
				text.push(
					a.mime === "text/plain"
						? `Attachment ${a.fileName} (${a.ref}):\n${bytes.toString("utf8")}`
						: `Attachment ${a.fileName} (${a.mime}): ${file.path}`,
				);
		}
		return { attachments, images, text: text.join("\n\n") };
	}

	async attachmentRead(raw: unknown) {
		this.#assertOpen();
		const p = v4AttachmentReadParamsSchema.parse(raw);
		const a = await this.#authorize(p, "previewRefNotAuthorized");
		if (!previewable(a)) fault("previewRefNotAuthorized");
		return v4AttachmentReadResultSchema.parse(await this.#read(p, a));
	}
	async conversationAttachmentRead(raw: unknown) {
		this.#assertOpen();
		const p = v4ConversationAttachmentReadParamsSchema.parse(raw);
		return v4ConversationAttachmentReadResultSchema.parse(
			await this.#read(p, await this.#authorize(p, "shareReadNotAuthorized")),
		);
	}
	async conversationAttachmentStat(raw: unknown) {
		this.#assertOpen();
		const p = v4ConversationAttachmentStatParamsSchema.parse(raw);
		const a = await this.#authorize(p, "shareStatNotAuthorized");
		const f = await this.#file(p.ref);
		if (f.stat.size > limits.attachmentStatMaxBytes) fault("shareStatTooLarge");
		return v4ConversationAttachmentStatResultSchema.parse({
			mediaType: a.mime,
			totalBytes: f.stat.size,
			mtimeMs: f.stat.mtimeMs,
		});
	}
	async attachmentPreviewSource(raw: unknown): Promise<V4AttachmentPreviewSourceResult> {
		this.#assertOpen();
		const p = v4AttachmentPreviewSourceParamsSchema.parse(raw);
		const a = await this.#authorize(p, "previewRefNotAuthorized");
		if (!previewable(a)) fault("previewRefNotAuthorized");
		const f = await this.#file(p.ref);
		if (this.#options.allowLocalPreview && p.clientMode === "desktop-continuous" && a.mime.startsWith("video/"))
			return { kind: "local_path", path: f.path, mediaType: a.mime };
		return { kind: "chunked" };
	}
	async #authorize(
		p: { sessionId: string; ref: string; target?: { rowId: number; entityId: string }; attachmentIndex?: number },
		code: string,
	): Promise<AttachmentRef> {
		const rows = await this.#options.getRows(p.sessionId);
		for (const row of rows) {
			if (
				row.kind !== "userInput" ||
				(p.target && (p.target.rowId !== row.rowId || p.target.entityId !== row.entityId))
			)
				continue;
			const candidates =
				p.attachmentIndex === undefined ? (row.attachments ?? []) : [row.attachments?.[p.attachmentIndex]];
			const a = candidates.find(item => item && (item.ref === p.ref || item.previewRef === p.ref));
			if (a) return a;
		}
		return fault(code);
	}
	async #file(ref: string) {
		if (!/^blob:sha256:[a-f0-9]{64}$/.test(ref)) fault("previewRefNotAuthorized");
		const root = await fs.realpath(this.#options.blobDir ?? getBlobsDir());
		const file = path.join(root, ref.slice("blob:sha256:".length));
		try {
			const stat = await fs.lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || (await fs.realpath(file)) !== file)
				fault("previewRefNotAuthorized");
			return { path: file, stat };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") fault("shareStatNotFound");
			throw error;
		}
	}
	async #bytes(file: string, ref: string, max: number) {
		const handle = await fs.open(file, "r");
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > max) fault("previewTooLarge");
			// Verify the opened inode and bytes as well as the lexical path (replacement race).
			const current = await fs.lstat(file);
			if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino)
				fault("previewRefNotAuthorized");
			const bytes = Buffer.allocUnsafe(stat.size + 1);
			let length = 0;
			while (length < bytes.length) {
				const read = await handle.read(bytes, length, bytes.length - length, length);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			const content = bytes.subarray(0, length);
			if (length !== stat.size || hashOf(content) !== ref.slice("blob:sha256:".length))
				fault("previewRefNotAuthorized");
			return content;
		} finally {
			await handle.close();
		}
	}
	async #read(p: { ref: string; offset: number; limit: number }, a: AttachmentRef) {
		const f = await this.#file(p.ref);
		const bytes = await this.#bytes(f.path, p.ref, limits.attachmentPreviewMaxBytes);
		if (p.offset > bytes.length) fault("previewRangeInvalid");
		const end = Math.min(bytes.length, p.offset + p.limit);
		return {
			dataBase64: bytes.subarray(p.offset, end).toString("base64"),
			mediaType: a.mime,
			totalBytes: bytes.length,
			nextOffset: end < bytes.length ? end : null,
		};
	}
	#delete(key: string, u: Upload) {
		if (this.#uploads.get(key) !== u) return;
		this.#uploads.delete(key);
		this.#stagedBytes -= u.bytes;
	}
	#prune() {
		for (const [key, u] of this.#uploads) if (!u.commit && u.expires <= Date.now()) this.#delete(key, u);
	}
	#assertOpen() {
		if (this.#disposed) throw new Error("Attachment resources disposed");
	}
	closeConnection(connectionId: string): void {
		for (const [key, u] of this.#uploads) if (u.metadata.connectionId === connectionId) this.#delete(key, u);
	}
	disposeSession(sessionId: string): void {
		for (const [key, u] of this.#uploads) if (u.metadata.sessionId === sessionId) this.#delete(key, u);
		this.#owned.delete(sessionId);
	}
	dispose(): void {
		this.#disposed = true;
		this.#uploads.clear();
		this.#owned.clear();
		this.#stagedBytes = 0;
	}
}
