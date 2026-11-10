import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { BINARY_SNIFF_BYTES, isProbablyBinaryHeader, isRecord, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { Emitter, type Event } from "../../../../../packages/dev-frontend/packages/rpc/src/foundation";
import type { PromptAttachmentTransferProgress } from "../../../../../packages/dev-frontend/packages/services/src/prompt-attachment-transfer/promptAttachmentTransfer";
import { PROTOCOL_V4_LIMITS } from "../../../../../packages/dev-frontend/packages/shared/src/zcode-protocol-v4/core";
import { loadImageInput, loadSvgImageInput, loadHeifImageInput } from "../../utils/image-loading";
import { CONVERTIBLE_EXTENSIONS, convertBufferWithMarkit } from "../../utils/markit";
import { resolveNativeReadPath, nativeReadContext } from "./native-read-context";
import { resolveWebGuiSession } from "./native-session-host";
import type { WebGuiMethod, WebGuiServiceContext } from "./rpc-contract";

const MAX_ATTACHMENT_BYTES = PROTOCOL_V4_LIMITS.attachmentMaxBytes;
interface NativeAttachment {
	operationId: string;
	connectionId: string;
	projectId: string;
	sessionId: string;
	workspacePath: string;
	ref: string;
	fileName: string;
	mime: string;
	bytes: number;
	directory?: string;
	filePath?: string;
	adopted: boolean;
	canceled: boolean;
	progress: Emitter<PromptAttachmentTransferProgress>;
}
export interface ResolvedAttachments {
	text: string;
	images: ImageContent[];
}
const transfers = new Map<string, NativeAttachment>();
const pending = new Set<Promise<unknown>>();
const closingProjects = new Set<string>();

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a nonempty string`);
	return value;
}
function track<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise);
	void promise.finally(() => pending.delete(promise)).catch(() => {});
	return promise;
}
async function removeTransfer(transfer: NativeAttachment): Promise<void> {
	if (transfer.adopted) return;
	transfer.canceled = true;
	if (transfer.directory) await fs.rm(transfer.directory, { recursive: true, force: true });
	transfers.delete(transfer.ref);
	transfer.progress.dispose();
}
function assertTransfer(context: WebGuiServiceContext, transfer: NativeAttachment) {
	context.signal.throwIfAborted();
	if (
		closingProjects.has(context.projectId ?? "") ||
		transfer.canceled ||
		transfer.connectionId !== context.connectionId ||
		transfer.projectId !== context.projectId
	)
		throw new Error("Attachment transfer is canceled or belongs to another connection/project");
}
function progress(transfer: NativeAttachment, phase: PromptAttachmentTransferProgress["phase"], uploadedBytes: number) {
	transfer.progress.fire({ operationId: transfer.operationId, phase, uploadedBytes, totalBytes: transfer.bytes });
}

export function createNativeAttachmentMethods(context: WebGuiServiceContext) {
	const operations = new Map<string, NativeAttachment>();
	const staging = new Set<string>();
	const canceled = new Set<string>();
	const events = new Map<string, Emitter<PromptAttachmentTransferProgress>>();
	const emitter = (id: string) => {
		let value = events.get(id);
		if (!value) {
			value = new Emitter<PromptAttachmentTransferProgress>();
			events.set(id, value);
		}
		return value;
	};
	const owned = (value: unknown) => {
		const id = requiredString(value, "operationId");
		const transfer = operations.get(id);
		if (!transfer) throw new Error("Attachment transfer does not exist on this connection");
		assertTransfer(context, transfer);
		return transfer;
	};
	const dispose = () => {
		for (const transfer of operations.values()) {
			if (!transfer.adopted) {
				transfer.canceled = true;
				void track(removeTransfer(transfer)).catch(() => {});
			}
		}
		for (const event of events.values()) event.dispose();
		events.clear();
		context.signal.removeEventListener("abort", dispose);
	};
	context.signal.addEventListener("abort", dispose, { once: true });
	const methods: Readonly<Record<string, WebGuiMethod>> = {
		stage(value: unknown) {
			if (!isRecord(value)) throw new TypeError("Attachment parameters must be an object");
			const operationId = requiredString(value.operationId, "operationId");
			if (operations.has(operationId) || staging.has(operationId))
				throw new Error("Attachment operation already exists");
			staging.add(operationId);
			return track(
				(async () => {
					context.signal.throwIfAborted();
					if (closingProjects.has(context.projectId ?? "")) throw new Error("Attachment service is closing");
					const sessionId = requiredString(value.sessionId, "sessionId");
					const read = await nativeReadContext(context, sessionId);
					if (canceled.has(operationId)) throw new Error("Attachment upload was canceled");
					const workspacePath = requiredString(value.workspacePath, "workspacePath");
					if (normalizePathForComparison(workspacePath) !== normalizePathForComparison(read.cwd))
						throw new Error("Attachment workspace does not match its native session");
					const fileName = requiredString(value.fileName, "fileName");
					const mime = typeof value.mime === "string" && value.mime ? value.mime : "application/octet-stream";
					if (typeof value.bytesBase64 !== "string")
						throw new TypeError("Browser attachments require bytesBase64");
					const base64 = value.bytesBase64;
					if (
						base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
						base64.length % 4 !== 0 ||
						!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
					)
						throw new Error("Attachment is invalid base64 or exceeds the 20 MiB limit");
					const bytes = Buffer.from(base64, "base64");
					if (
						bytes.length > MAX_ATTACHMENT_BYTES ||
						(value.sizeBytes !== undefined && value.sizeBytes !== bytes.length)
					)
						throw new Error("Attachment byte size does not match upload metadata");
					if (operations.has(operationId)) throw new Error("Attachment operation already exists");
					const transfer: NativeAttachment = {
						operationId,
						connectionId: context.connectionId,
						projectId: requiredString(context.projectId, "projectId"),
						sessionId,
						workspacePath: read.cwd,
						ref: `webgui-attachment:${crypto.randomUUID()}`,
						fileName,
						mime,
						bytes: bytes.length,
						adopted: false,
						canceled: false,
						progress: emitter(operationId),
					};
					operations.set(operationId, transfer);
					transfers.set(transfer.ref, transfer);
					try {
						progress(transfer, "uploading", 0);
						transfer.directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-webgui-attachment-"));
						await fs.chmod(transfer.directory, 0o700);
						assertTransfer(context, transfer);
						const extension = path.extname(path.basename(fileName)).replace(/[^.a-zA-Z0-9]/g, "");
						transfer.filePath = path.join(transfer.directory, `input${extension}`);
						progress(transfer, "committing", bytes.length);
						await fs.writeFile(transfer.filePath, bytes, { flag: "wx", mode: 0o600 });
						read.assertCurrent();
						assertTransfer(context, transfer);
						progress(transfer, "complete", bytes.length);
						return { operationId, ref: transfer.ref, bytes: bytes.length, staged: true };
					} catch (error) {
						await removeTransfer(transfer);
						throw error;
					}
				})().finally(() => staging.delete(operationId)),
			);
		},
		async adopt(value: unknown) {
			const transfer = owned(value);
			const session = await resolveWebGuiSession(context, transfer.sessionId);
			assertTransfer(context, transfer);
			if (
				!transfer.filePath ||
				normalizePathForComparison(session.sessionManager.getCwd()) !==
					normalizePathForComparison(transfer.workspacePath)
			)
				throw new Error("Attachment is incomplete or its native workspace changed");
			transfer.adopted = true;
		},
		cancel(value: unknown) {
			context.signal.throwIfAborted();
			const id = requiredString(value, "operationId");
			canceled.add(id);
			const transfer = operations.get(id);
			if (!transfer) {
				if (staging.has(id)) return;
				throw new Error("Attachment transfer does not exist on this connection");
			}
			progress(transfer, "canceled", 0);
			return track(removeTransfer(transfer));
		},
		cleanup(value: unknown) {
			context.signal.throwIfAborted();
			const id = requiredString(value, "operationId");
			const transfer = operations.get(id);
			if (!transfer) {
				if (staging.has(id)) {
					canceled.add(id);
					return;
				}
				throw new Error("Attachment transfer does not exist on this connection");
			}
			return track(removeTransfer(transfer));
		},
	};
	return {
		methods,
		dynamicEvents: {
			onDynamicProgress: (value: unknown): Event<PromptAttachmentTransferProgress> =>
				emitter(requiredString(value, "operationId")).event,
		},
		dispose,
	};
}

async function loadInput(
	filePath: string,
	fileName: string,
	mime: string,
	size: number,
	context: WebGuiServiceContext,
	sessionId?: string,
): Promise<ResolvedAttachments> {
	const session = await resolveWebGuiSession(context, sessionId);
	const options = {
		path: filePath,
		resolvedPath: filePath,
		cwd: session.sessionManager.getCwd(),
		autoResize: true,
		maxBytes: MAX_ATTACHMENT_BYTES,
	};
	let image = await loadImageInput(options);
	if (!image && /\.svgz?$/i.test(fileName)) image = await loadSvgImageInput(options);
	if (!image && /\.hei[cf]$/i.test(fileName)) image = await loadHeifImageInput(options, context.signal);
	context.signal.throwIfAborted();
	const metadata = JSON.stringify({ fileName, mime, bytes: size });
	if (image) {
		if (!session.model?.input.includes("image"))
			throw new Error(`The selected model does not support image input: ${fileName}`);
		return {
			text: `Attachment ${metadata}\n${image.textNote}`,
			images: [{ type: "image", data: image.data, mimeType: image.mimeType }],
		};
	}
	if (mime.startsWith("image/")) throw new Error(`The uploaded image could not be decoded: ${fileName}`);
	const bytes = await fs.readFile(filePath);
	if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds the 20 MiB limit");
	const extension = path.extname(fileName).toLowerCase();
	if (CONVERTIBLE_EXTENSIONS.has(extension)) {
		const converted = await convertBufferWithMarkit(bytes, extension, context.signal);
		if (!converted.ok)
			throw new Error(`Could not read attachment ${fileName}: ${converted.error ?? "native conversion failed"}`);
		return { text: `Attachment ${metadata}\n${converted.content}`, images: [] };
	}
	if (isProbablyBinaryHeader(bytes.subarray(0, BINARY_SNIFF_BYTES)))
		throw new Error(`Attachment is not readable text or a supported image: ${fileName}`);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	return { text: `Attachment ${metadata}\n${text}`, images: [] };
}

export function resolveNativeAttachments(
	context: WebGuiServiceContext,
	attachments: unknown,
	sessionId?: string,
): Promise<ResolvedAttachments> {
	if (closingProjects.has(context.projectId ?? "")) return Promise.reject(new Error("Attachment service is closing"));
	return track(resolveAttachments(context, attachments, sessionId));
}

async function resolveAttachments(
	context: WebGuiServiceContext,
	attachments: unknown,
	sessionId?: string,
): Promise<ResolvedAttachments> {
	if (attachments === undefined) return { text: "", images: [] };
	if (!Array.isArray(attachments)) throw new TypeError("Attachments must be an array");
	const read = await nativeReadContext(context, sessionId);
	const session = read.session;
	const blocks: string[] = [];
	const images: ImageContent[] = [];
	for (const attachment of attachments) {
		if (!isRecord(attachment)) throw new TypeError("Attachment reference must be an object");
		const ref = requiredString(attachment.ref, "attachment.ref");
		const transfer = transfers.get(ref);
		if (
			!transfer ||
			transfer.canceled ||
			!transfer.filePath ||
			transfer.projectId !== context.projectId ||
			transfer.sessionId !== session.sessionId ||
			(!transfer.adopted && transfer.connectionId !== context.connectionId)
		)
			throw new Error("Attachment is unavailable or belongs to another project/session");
		if (
			normalizePathForComparison(transfer.workspacePath) !==
			normalizePathForComparison(session.sessionManager.getCwd())
		)
			throw new Error("Attachment workspace changed before submission");
		if (
			attachment.fileName !== transfer.fileName ||
			attachment.mime !== transfer.mime ||
			attachment.bytes !== transfer.bytes
		)
			throw new Error("Attachment metadata does not match staged bytes");
		// Admission materializes all bytes; later page cleanup must never remove accepted input.
		transfer.adopted = true;
		const resolved = await loadInput(
			transfer.filePath,
			transfer.fileName,
			transfer.mime,
			transfer.bytes,
			context,
			session.sessionId,
		);
		blocks.push(resolved.text);
		images.push(...resolved.images);
		read.assertCurrent();
	}
	return { text: blocks.join("\n\n"), images };
}

export function resolveNativeFileContexts(
	context: WebGuiServiceContext,
	text: string,
	sessionId?: string,
): Promise<ResolvedAttachments> {
	if (closingProjects.has(context.projectId ?? "")) return Promise.reject(new Error("Attachment service is closing"));
	return track(resolveFileContexts(context, text, sessionId));
}

async function resolveFileContexts(
	context: WebGuiServiceContext,
	text: string,
	sessionId?: string,
): Promise<ResolvedAttachments> {
	const paths = new Set<string>();
	for (const match of text.matchAll(/\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*)>|((?:\\.|[^)])*))\)/g)) {
		if (match[1]?.startsWith("$")) continue;
		const destination = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
		if (/^(?:\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(destination)) paths.add(destination);
	}
	for (const match of text.matchAll(/(?:^|[\s([{<"'`])@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s@]+))/g)) {
		const destination = (match[1] ?? match[2] ?? match[3])?.replace(/[)\]}>.,;:!?"'`]+$/, "");
		if (destination) paths.add(destination);
	}
	const blocks: string[] = [];
	const images: ImageContent[] = [];
	for (const requested of paths) {
		const read = await resolveNativeReadPath(context, requested, { sessionId });
		const stat = await fs.stat(read.path);
		read.assertCurrent();
		if (stat.isDirectory()) {
			const entries = await fs.readdir(read.path, { withFileTypes: true });
			read.assertCurrent();
			blocks.push(
				`Referenced directory ${JSON.stringify(requested)}\n${entries.map(entry => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n")}`,
			);
		} else {
			if (!stat.isFile()) throw new Error(`File reference is not a regular file: ${requested}`);
			if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`File reference exceeds the 20 MiB limit: ${requested}`);
			const resolved = await loadInput(
				read.path,
				requested,
				"application/octet-stream",
				stat.size,
				context,
				sessionId,
			);
			read.assertCurrent();
			blocks.push(resolved.text);
			images.push(...resolved.images);
		}
	}
	return { text: blocks.join("\n\n"), images };
}

/** Called only after native work has settled, never on a page disconnect. */
export async function settleDevNativeAttachments(projectIds: ReadonlySet<string>): Promise<void> {
	for (const id of projectIds) closingProjects.add(id);
	try {
		await Promise.allSettled(pending);
		for (const transfer of transfers.values())
			if (projectIds.has(transfer.projectId)) {
				transfer.adopted = false;
				await removeTransfer(transfer);
			}
	} finally {
		for (const id of projectIds) closingProjects.delete(id);
	}
}
