import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openArchive, writeArchive } from "@oh-my-pi/pi-utils/ar";
import { replaceFileAtomically } from "../utils/atomic-file";
import type {
	DevDecodedPackage,
	DevFileVersion,
	DevPackageManifest,
	DevRequirementContent,
	DevRequirementSnapshot,
} from "./workflow-types";

const LIMIT = 64 * 1024 * 1024;
const MAX_FILES = 1024;
const zipUtf8Decoder = new TextDecoder("utf-8");
const zipLegacyDecoder = new TextDecoder("windows-1252");
const decoder = new TextDecoder("utf-8", { fatal: true });
export function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => compareCanonical(a, b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
			.join(",")}}`;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Unsupported canonical JSON value");
	return encoded;
}
export function stableId(value: string): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
		throw new Error(`Invalid stable ID: ${value}`);
	return value;
}
export function safeMaterialPath(value: string): string {
	if (typeof value !== "string") throw new Error("Material path must be a string");
	if (
		!value ||
		value.length > 512 ||
		/[\\:\x00-\x1f\x7f]/.test(value) ||
		value.startsWith("/") ||
		value
			.split("/")
			.some(
				p =>
					!p ||
					p === "." ||
					p === ".." ||
					/[. ]$/.test(p) ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
			)
	)
		throw new Error(`Unsafe material path: ${value}`);
	if (
		value
			.split("/")
			.some(p => /^(\.git|\.omp|\.env(?:\..*)?|credentials?|secrets?|sessions?|chat|transcript)(?:\.|$)/i.test(p))
	)
		throw new Error(`Private runtime/credential/chat path forbidden: ${value}`);
	return value;
}
export function assertKeys(
	value: unknown,
	keys: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
function text(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`);
}
function publicText(value: string, label: string): void {
	if (
		/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[^\s"']{8,}/i.test(
			value,
		)
	)
		throw new Error(`${label} contains credentials`);
	if (/(?:^|[\s\"'`])(?:[a-z]:[\\/]|\/(?:home|Users|tmp|var|mnt|opt|srv|usr)\/)/im.test(value))
		throw new Error(`${label} contains an absolute machine path`);
}
/** Fixed UTF-16 code-unit order, independent of the host's language/ICU locale. */
function compareCanonical(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
function publicBytes(bytes: Uint8Array, label: string): void {
	let value: string;
	try {
		value = decoder.decode(bytes);
	} catch {
		return;
	}
	// Apply the declared text boundary to UTF-8 attachments without rewriting bytes.
	// Opaque binary data is preserved; this is not a general binary DLP scanner.
	publicText(value, label);
}
export function digestFiles(files: readonly DevFileVersion[]): string {
	return sha256(canonicalJson([...files].sort((a, b) => compareCanonical(a.path, b.path))));
}
export function validateRequirementContent(content: DevRequirementContent): void {
	assertKeys(content, ["title", "document", "srs", "attachments"], "requirement content");
	text(content.title, "IR title");
	if (!Array.isArray(content.srs) || !content.srs.length) throw new Error("An IR requires at least one complete SR");
	if (!Array.isArray(content.attachments)) throw new Error("Attachments must be an array");
	const ids = new Set<string>();
	const paths = new Set<string>();
	const validateDocument = (doc: { path: string; content: string | Uint8Array }, label: string, formal: boolean) => {
		assertKeys(doc, ["path", "content"], label);
		safeMaterialPath(doc.path);
		const folded = doc.path.normalize("NFC").toLowerCase();
		if (paths.has(folded)) throw new Error(`Duplicate material path: ${doc.path}`);
		paths.add(folded);
		if (typeof doc.content === "string") {
			text(doc.content, label);
			publicText(doc.content, label);
		} else if (!(doc.content instanceof Uint8Array) || formal)
			throw new Error(`${label} requires ${formal ? "text" : "bytes or text"}`);
		else publicBytes(doc.content, label);
		if (
			formal &&
			(typeof doc.content !== "string" ||
				!doc.path.endsWith(".md") ||
				!/^#\s+\S/m.test(doc.content) ||
				(doc.content.match(/^##\s+\S/gm)?.length ?? 0) < 3 ||
				!/(验收|acceptance)/i.test(doc.content))
		)
			throw new Error(`${label}: full Markdown document with sections and acceptance criteria required`);
	};
	validateDocument(content.document, "IR document", true);
	for (const sr of content.srs) {
		assertKeys(sr, ["id", "title", "document"], "SR");
		stableId(sr.id);
		text(sr.title, "SR title");
		if (ids.has(sr.id)) throw new Error(`Duplicate SR ID: ${sr.id}`);
		ids.add(sr.id);
		validateDocument(sr.document, `SR ${sr.id}`, true);
	}
	for (const doc of content.attachments) validateDocument(doc, "attachment", false);
}
export function buildRequirementSnapshot(
	projectId: string,
	irId: string,
	content: DevRequirementContent,
): DevRequirementSnapshot {
	stableId(projectId);
	stableId(irId);
	validateRequirementContent(content);
	const prefix = `docs/dev/requirements/${irId}/`;
	const docs = [content.document, ...content.srs.map(sr => sr.document), ...content.attachments];
	for (const doc of docs)
		if (!doc.path.startsWith(prefix)) throw new Error(`Requirement material must be under ${prefix}`);
	const files = docs
		.map(doc => ({ path: doc.path, sha256: sha256(doc.content), size: Buffer.byteLength(doc.content) }))
		.sort((a, b) => compareCanonical(a.path, b.path));
	const basis = {
		version: 1 as const,
		projectId,
		irId,
		title: content.title,
		documentPath: content.document.path,
		srs: content.srs.map(sr => ({ id: sr.id, title: sr.title, documentPath: sr.document.path })),
		files,
	};
	return { ...basis, digest: sha256(canonicalJson(basis)) };
}
function validateFileList(value: unknown): asserts value is DevFileVersion[] {
	if (!Array.isArray(value) || !value.length || value.length > MAX_FILES) throw new Error("Invalid file manifest");
	const seen = new Set<string>();
	for (const file of value) {
		assertKeys(file, ["path", "sha256", "size"], "file");
		safeMaterialPath(file.path as string);
		const folded = (file.path as string).normalize("NFC").toLowerCase();
		if (seen.has(folded)) throw new Error(`Duplicate file: ${file.path}`);
		seen.add(folded);
		if (
			typeof file.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(file.sha256) ||
			!Number.isSafeInteger(file.size) ||
			(file.size as number) < 0 ||
			(file.size as number) > LIMIT
		)
			throw new Error(`Invalid digest/size: ${file.path}`);
	}
}
export function validatePackageManifest(value: unknown, files: Map<string, Uint8Array>): DevPackageManifest {
	assertKeys(
		value,
		[
			"format",
			"version",
			"packageId",
			"sourceProjectId",
			"repositoryId",
			"irId",
			"releaseId",
			"createdAt",
			"snapshot",
			"confirmation",
			"review",
			"files",
		],
		"manifest",
	);
	if (value.format !== "omp-dev-requirements" || value.version !== 1)
		throw new Error("Unsupported requirement package format/version");
	for (const key of ["packageId", "sourceProjectId", "irId", "releaseId"]) stableId(value[key] as string);
	text(value.repositoryId, "repositoryId");
	text(value.createdAt, "createdAt");
	if (
		/^(?:[a-z]:[\\/]|\/|file:)/i.test(value.repositoryId as string) ||
		/:\/\/[^/]*@/.test(value.repositoryId as string)
	)
		throw new Error("Package repository identity must not contain local paths or credentials");
	validateFileList(value.files);
	assertKeys(
		value.snapshot,
		["version", "projectId", "irId", "title", "documentPath", "srs", "files", "digest"],
		"snapshot",
	);
	assertKeys(value.confirmation, ["operationId", "snapshotDigest", "confirmedAt"], "confirmation");
	assertKeys(value.review, ["id", "snapshotDigest", "passed", "report", "reviewer", "createdAt"], "review");
	assertKeys(value.review.reviewer, ["sessionId", "role"], "reviewer");
	if (value.review.passed !== true || value.review.reviewer.role !== "reviewer")
		throw new Error("Package requires a passing independent review");
	for (const [obj, key] of [
		[value.review, "report"],
		[value.review, "id"],
		[value.review, "createdAt"],
		[value.review.reviewer, "sessionId"],
		[value.confirmation, "operationId"],
		[value.confirmation, "confirmedAt"],
	] as const)
		text(obj[key], key);
	const manifest = value as unknown as DevPackageManifest;
	if (
		manifest.snapshot.projectId !== manifest.sourceProjectId ||
		manifest.snapshot.irId !== manifest.irId ||
		manifest.snapshot.version !== 1 ||
		!Array.isArray(manifest.snapshot.srs)
	)
		throw new Error("Snapshot project/IR reference mismatch");
	if (files.size !== manifest.files.length) throw new Error("Package file set does not match manifest");
	if (manifest.files.reduce((sum, file) => sum + file.size, 0) + Buffer.byteLength(canonicalJson(manifest)) > LIMIT)
		throw new Error("Requirement package exceeds 64 MiB");
	for (const entry of manifest.files) {
		const bytes = files.get(entry.path);
		if (!bytes || bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
			throw new Error(`Missing or corrupt material: ${entry.path}`);
	}
	const read = (p: string) => {
		const b = files.get(p);
		if (!b) throw new Error(`Unresolved material reference: ${p}`);
		return { path: p, content: decoder.decode(b) };
	};
	for (const sr of manifest.snapshot.srs) assertKeys(sr, ["id", "title", "documentPath"], "snapshot SR");
	const referenced = new Set([manifest.snapshot.documentPath, ...manifest.snapshot.srs.map(sr => sr.documentPath)]);
	const content: DevRequirementContent = {
		title: manifest.snapshot.title,
		document: read(manifest.snapshot.documentPath),
		srs: manifest.snapshot.srs.map(sr => ({ id: sr.id, title: sr.title, document: read(sr.documentPath) })),
		attachments: manifest.files
			.filter(f => !referenced.has(f.path))
			.map(f => ({ path: f.path, content: files.get(f.path)! })),
	};
	const metadataPath = `docs/dev/requirements/${manifest.irId}/requirements.json`;
	const metadata = files.get(metadataPath);
	const expectedMetadata = {
		version: 1,
		irId: manifest.irId,
		title: manifest.snapshot.title,
		documentPath: manifest.snapshot.documentPath,
		srs: manifest.snapshot.srs,
	};
	if (!metadata || canonicalJson(JSON.parse(decoder.decode(metadata))) !== canonicalJson(expectedMetadata))
		throw new Error("Package lacks exact Git-readable title and IR/SR membership metadata");
	const snapshot = buildRequirementSnapshot(manifest.sourceProjectId, manifest.irId, content);
	if (
		canonicalJson(snapshot) !== canonicalJson(manifest.snapshot) ||
		canonicalJson(snapshot.files) !== canonicalJson(manifest.files) ||
		manifest.confirmation.snapshotDigest !== snapshot.digest ||
		manifest.review.snapshotDigest !== snapshot.digest
	)
		throw new Error("Snapshot/confirmation/review version mismatch");
	publicText(canonicalJson(manifest), "manifest");
	return manifest;
}
/** Inspect effective central names before the archive reader normalizes/upserts them. */
function validateZipNames(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
		if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) {
			end = i;
			break;
		}
	if (end < 0) throw new Error("Invalid ZIP directory");
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	if (
		view.getUint16(end + 4, true) !== 0 ||
		view.getUint16(end + 6, true) !== 0 ||
		count !== view.getUint16(end + 8, true) ||
		count === 65535 ||
		count > MAX_FILES + 1
	)
		throw new Error("Unsupported multipart/ZIP64 or excessive ZIP entries");
	const names = new Set<string>();
	const indexedPaths = new Set<string>();
	for (let n = 0; n < count; n++) {
		if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
			throw new Error("Invalid ZIP member directory");
		const length = view.getUint16(at + 28, true),
			extra = view.getUint16(at + 30, true),
			comment = view.getUint16(at + 32, true);
		const extraStart = at + 46 + length,
			extraEnd = extraStart + extra;
		if (extraEnd + comment > end) throw new Error("Truncated ZIP directory");
		const rawName = bytes.subarray(at + 46, extraStart);
		let name = ((view.getUint16(at + 8, true) & 0x0800) !== 0 ? zipUtf8Decoder : zipLegacyDecoder).decode(rawName);
		// Match pi-utils/ar's version/CRC/UTF-8 rules, including last valid override.
		for (let offset = extraStart; offset < extraEnd;) {
			if (offset + 4 > extraEnd) throw new Error("Truncated ZIP extra field");
			const id = view.getUint16(offset, true),
				size = view.getUint16(offset + 2, true),
				start = offset + 4,
				stop = start + size;
			if (stop > extraEnd) throw new Error("Malformed ZIP extra field");
			if (id === 0x7075) {
				if (size < 5) throw new Error("Invalid ZIP Unicode path extra field");
				if (bytes[start] === 1 && view.getUint32(start + 1, true) === Bun.hash.crc32(rawName) >>> 0) {
					try {
						name = decoder.decode(bytes.subarray(start + 5, stop));
					} catch {
						/* The archive reader ignores invalid optional UTF-8 overrides. */
					}
				}
			}
			offset = stop;
		}
		safeMaterialPath(name);
		const folded = name.normalize("NFC").toLowerCase();
		if (names.has(folded)) throw new Error(`Duplicate ZIP member: ${name}`);
		names.add(folded);
		const mode = view.getUint32(at + 38, true) >>> 16;
		if (((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) || (view.getUint32(at + 38, true) & 0x10) !== 0)
			throw new Error(`ZIP links/directories forbidden: ${name}`);
		indexedPaths.add(name);
		for (let slash = name.indexOf("/"); slash !== -1; slash = name.indexOf("/", slash + 1))
			indexedPaths.add(name.slice(0, slash));
		at = extraEnd + comment;
	}
	if (at !== end || at - view.getUint32(end + 16, true) !== view.getUint32(end + 12, true))
		throw new Error("ZIP directory size mismatch");
	// Only the bounded member set and its validated <=512-character parents count.
	return indexedPaths.size;
}
export async function decodeRequirementPackage(source: string | Uint8Array): Promise<DevDecodedPackage> {
	const bytes = typeof source === "string" ? await fs.readFile(source) : source;
	if (bytes.length > LIMIT) throw new Error("Requirement ZIP exceeds 64 MiB");
	const indexedEntries = validateZipNames(bytes);
	const archive = await openArchive(
		{ bytes, format: "zip" },
		{ limits: { maxInMemorySize: LIMIT, maxMemberSize: LIMIT, maxEntries: indexedEntries } },
	);
	const files = new Map<string, Uint8Array>();
	let manifestBytes: Uint8Array | undefined;
	let total = 0;
	for (const entry of archive.indexEntries()) {
		if (entry.isDirectory) continue;
		if (entry.storage?.type === "link") throw new Error("ZIP links forbidden");
		const { bytes: member } = await archive.readFile(entry.path);
		total += member.length;
		if (total > LIMIT) throw new Error("Inflated package exceeds 64 MiB");
		if (entry.path === "manifest.json") manifestBytes = member;
		else files.set(entry.path, member);
	}
	if (!manifestBytes) throw new Error("Missing manifest.json");
	const manifest = validatePackageManifest(JSON.parse(decoder.decode(manifestBytes)), files);
	return { manifest, files, digest: sha256(canonicalJson(manifest)) };
}
export async function encodeRequirementPackage(
	target: string,
	manifest: DevPackageManifest,
	files: Map<string, Uint8Array>,
): Promise<void> {
	validatePackageManifest(manifest, files);
	const temp = `${target}.${crypto.randomUUID()}.tmp`;
	await fs.mkdir(path.dirname(target), { recursive: true });
	try {
		await writeArchive(temp, "zip", [["manifest.json", canonicalJson(manifest)], ...files.entries()]);
		await replaceFileAtomically(temp, target);
	} finally {
		await fs.rm(temp, { force: true });
	}
}
