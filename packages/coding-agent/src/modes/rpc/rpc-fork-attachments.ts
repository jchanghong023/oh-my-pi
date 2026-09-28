/**
 * Fork-extension attachment channel (requirement 5.5, rpc-ui-protocol.md).
 *
 * Resolves `attachments` on the prompt family into message content at send
 * time: images become `ImageContent` (same pipeline as the stock `images`
 * field), PDFs are converted to markdown text via the native `pdfToMarkdown`,
 * and other files ride in as bounded text blocks. `kind:"file"` is read once
 * at send; there are no persistent attachment ids (re-send = re-attach).
 * Everything travels inside the user message, so session persistence and
 * history replay come for free.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pdfToMarkdown } from "@oh-my-pi/pi-natives";
import type { ImageContent } from "@oh-my-pi/pi-ai";

export interface RpcForkAttachmentFile {
	kind: "file";
	path: string;
	mime?: string;
}

export interface RpcForkAttachmentData {
	kind: "data";
	mime: string;
	data: string;
}

export type RpcForkAttachment = RpcForkAttachmentFile | RpcForkAttachmentData;

export class RpcAttachmentError extends Error {
	constructor(
		message: string,
		readonly code: "attachment_too_large" | "attachment_unsupported" | "attachment_unreadable" | "attachment_limit",
	) {
		super(message);
		this.name = "RpcAttachmentError";
	}
}

export const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_CHARS = 256 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".yml",
	".yaml",
	".toml",
	".csv",
	".tsv",
	".log",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".c",
	".h",
	".cpp",
	".hpp",
	".cs",
	".php",
	".sh",
	".bash",
	".zsh",
	".ps1",
	".sql",
	".html",
	".css",
	".scss",
	".xml",
	".ini",
	".cfg",
	".conf",
	".env",
	".diff",
	".patch",
]);

function isImageAttachment(mime: string | undefined, ext: string): boolean {
	return (mime !== undefined && mime.startsWith("image/")) || IMAGE_EXTENSIONS.has(ext);
}

function isPdfAttachment(mime: string | undefined, ext: string): boolean {
	return mime === "application/pdf" || ext === ".pdf";
}

function decodeBase64(data: string): Buffer {
	return Buffer.from(data, "base64");
}

async function readAttachmentBytes(
	attachment: RpcForkAttachment,
	cwd: string,
): Promise<{ bytes: Buffer; label: string }> {
	if (attachment.kind === "data") {
		const bytes = decodeBase64(attachment.data);
		if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
			throw new RpcAttachmentError(
				`Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit (${bytes.byteLength} bytes)`,
				"attachment_too_large",
			);
		}
		return { bytes, label: `inline ${attachment.mime}` };
	}
	const filePath = path.resolve(cwd, attachment.path);
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(filePath);
	} catch (error) {
		throw new RpcAttachmentError(
			`Attachment not readable: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
			"attachment_unreadable",
		);
	}
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
		throw new RpcAttachmentError(
			`Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${filePath} (${bytes.byteLength} bytes)`,
			"attachment_too_large",
		);
	}
	return { bytes, label: filePath };
}

/** Resolves the attachment list into message images plus a text prelude. */
export async function resolveRpcAttachments(
	attachments: RpcForkAttachment[],
	cwd: string,
): Promise<{ images: ImageContent[]; textPrefix: string }> {
	if (attachments.length > MAX_ATTACHMENTS) {
		throw new RpcAttachmentError(
			`Too many attachments: ${attachments.length} (limit ${MAX_ATTACHMENTS})`,
			"attachment_limit",
		);
	}
	const images: ImageContent[] = [];
	const textBlocks: string[] = [];
	for (const attachment of attachments) {
		if (!isRecordShape(attachment) || (attachment.kind !== "file" && attachment.kind !== "data")) {
			throw new RpcAttachmentError(
				'Attachment must be {kind:"file", path} or {kind:"data", mime, data}',
				"attachment_unsupported",
			);
		}
		const declaredMime = typeof attachment.mime === "string" ? attachment.mime : undefined;
		const ext = path.extname(attachment.kind === "file" ? attachment.path : "").toLowerCase();

		if (isImageAttachment(declaredMime, ext)) {
			const { bytes } = await readAttachmentBytes(attachment, cwd);
			images.push({ type: "image", data: bytes.toString("base64"), mimeType: declaredMime ?? mimeFromExt(ext) });
			continue;
		}
		if (isPdfAttachment(declaredMime, ext)) {
			const { bytes, label } = await readAttachmentBytes(attachment, cwd);
			const converted = await pdfToMarkdown(new Uint8Array(bytes));
			textBlocks.push(boundedTextBlock(`Attached PDF: ${label}`, converted.markdown));
			continue;
		}
		if (declaredMime !== undefined && !declaredMime.startsWith("text/") && !TEXT_EXTENSIONS.has(ext)) {
			throw new RpcAttachmentError(
				`Unsupported attachment type: ${declaredMime || ext || "unknown"}`,
				"attachment_unsupported",
			);
		}
		const { bytes, label } = await readAttachmentBytes(attachment, cwd);
		if (bytes.includes(0)) {
			throw new RpcAttachmentError(`Unsupported binary attachment: ${label}`, "attachment_unsupported");
		}
		textBlocks.push(boundedTextBlock(`Attached file: ${label}`, bytes.toString("utf-8")));
	}
	return { images, textPrefix: textBlocks.length > 0 ? `${textBlocks.join("\n\n")}\n\n` : "" };
}

function boundedTextBlock(header: string, text: string): string {
	const clipped =
		text.length > MAX_TEXT_ATTACHMENT_CHARS ? `${text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n…(truncated)` : text;
	return `<attachment title="${header}">\n${clipped}\n</attachment>`;
}

function mimeFromExt(ext: string): string {
	switch (ext) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

function isRecordShape(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
