import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { encodeArchive, openArchive } from "@oh-my-pi/pi-utils/ar";
import reviewerPrompt from "../../../../prompts/agents/reviewer.md" with { type: "text" };
import { buildReviewPrompt } from "../review/prompt";
import { createResolvedReviewTarget } from "../review/target";
import type { ReviewExportResult, ReviewExportSnapshot } from "./types";

const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
type Version = "target" | "base";
interface SourceRecord {
	path: string;
	version: Version;
	kind: "changed";
	reason: string;
	status?: string;
	mode?: string;
	member?: string;
	binary: boolean;
	originalBytes: number;
	originalSha256: string;
	bytes: number;
	sha256?: string;
	lines: number;
	omission?: string;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function safePath(value: string): string {
	const segments = value.split("/");
	if (
		!value ||
		/[\\:\u0000-\u001f\u007f]/.test(value) ||
		segments.some(segment => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment)) ||
		segments.some(segment => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) ||
		[".tmp", ".git"].includes(segments[0]!.toLowerCase())
	) {
		throw new Error(`Unsafe or excluded review-export path: ${JSON.stringify(value)}`);
	}
	return value;
}

function splitRequired(detail: string): never {
	throw new Error(
		`${detail}. Review export cannot omit necessary code; split the review into smaller commit/base ranges.`,
	);
}

/** Byte offsets, not decoded/re-encoded text: preserve CRLF, BOMs and non-UTF-8 source. */
function lineOffsets(bytes: Uint8Array): number[] {
	let width = 1;
	let littleEndian = true;
	let bom = 0;
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		width = bytes[2] === 0 && bytes[3] === 0 ? 4 : 2;
		bom = width;
	} else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		width = 2;
		littleEndian = false;
		bom = 2;
	} else if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) {
		width = 4;
		littleEndian = false;
		bom = 4;
	}
	const offsets = [0];
	for (let index = bom; index + width <= bytes.length; index += width) {
		const lfIndex = littleEndian ? index : index + width - 1;
		if (bytes[lfIndex] !== 10) continue;
		let newline = true;
		for (let byte = index; byte < index + width; byte++) {
			if (byte !== lfIndex && bytes[byte] !== 0) newline = false;
		}
		if (newline) offsets.push(index + width);
	}
	if (offsets[offsets.length - 1] !== bytes.length) offsets.push(bytes.length);
	return offsets;
}

function isBinary(bytes: Uint8Array): boolean {
	if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
	if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) return false;
	return bytes.includes(0);
}

/** Build and byte-validate in owned staging; the previous ZIP is touched only by the final rename. */
export async function writeReviewBundle(
	snapshot: ReviewExportSnapshot,
	options: { args: string[]; instructions?: string },
	signal?: AbortSignal,
): Promise<ReviewExportResult> {
	signal?.throwIfAborted();
	const members = new Map<string, Uint8Array>();
	const sources: SourceRecord[] = [];
	const limitations = [...new Set(snapshot.limitations)];
	if (snapshot.changes.length === 0)
		limitations.push("No changes in the selected scope; only review instructions and metadata were exported.");
	const omissions: Array<{ path: string; version: Version; reason: string; kind: string }> = [];
	let totalBytes = 0;
	let sourceLines = 0;
	const add = (name: string, bytes: Uint8Array) => {
		if (members.has(name)) throw new Error(`Duplicate review-export archive member: ${name}`);
		if (bytes.length > MAX_MEMBER_BYTES) splitRequired(`${name} exceeds the ${MAX_MEMBER_BYTES}-byte member limit`);
		if (totalBytes + bytes.length > MAX_BUNDLE_BYTES)
			splitRequired(`Bundle exceeds the ${MAX_BUNDLE_BYTES}-byte uncompressed limit`);
		members.set(name, bytes);
		totalBytes += bytes.length;
	};
	const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
	const addSource = async (request: {
		path: string;
		version: Version;
		reason: string;
		member: string;
		status?: string;
		mode?: string;
	}) => {
		signal?.throwIfAborted();
		safePath(request.path);
		if (request.mode && !["100644", "100755"].includes(request.mode)) {
			throw new Error(`Unsupported ${request.version} mode ${request.mode} for ${request.path}`);
		}
		const existing = sources.find(source => source.path === request.path && source.version === request.version);
		if (existing) {
			existing.reason += `; ${request.reason}`;
			return;
		}
		const original = await snapshot.readFile(request.path, request.version);
		if (original === undefined) throw new Error(`Missing ${request.version} changed content: ${request.path}`);
		const binary = isBinary(original);
		const record: SourceRecord = {
			path: request.path,
			version: request.version,
			kind: "changed",
			reason: request.reason,
			status: request.status,
			mode: request.mode,
			binary,
			originalBytes: original.length,
			originalSha256: sha256(original),
			bytes: 0,
			lines: 0,
		};
		if (binary) {
			record.omission = "Binary payload omitted by default; size and SHA-256 describe the exact frozen bytes.";
			omissions.push({ path: request.path, version: request.version, reason: record.omission, kind: "changed" });
		} else {
			add(request.member, original);
			record.member = request.member;
			record.bytes = original.length;
			record.sha256 = record.originalSha256;
			record.lines = lineOffsets(original).length - 1;
			sourceLines += record.lines;
		}
		sources.push(record);
	};

	for (const change of snapshot.changes) {
		safePath(change.path);
		if (change.previousPath) safePath(change.previousPath);
		if (!/^[ADMRCT](?:\d+)?$/.test(change.status))
			throw new Error(`Unsupported review-export status ${change.status}: ${change.path}`);
		const status = change.status[0];
		if (status !== "A") {
			const beforePath = change.previousPath ?? change.path;
			await addSource({
				path: beforePath,
				version: "base",
				reason: "Original version of changed file",
				member: `changed-files/before/${beforePath}`,
				status: change.status,
				mode: change.beforeMode,
			});
		}
		if (status !== "D") {
			await addSource({
				path: change.path,
				version: "target",
				reason: "Final version of changed file",
				member: `changed-files/after/${change.path}`,
				status: change.status,
				mode: change.afterMode,
			});
		}
	}

	add("diff.patch", encoder.encode(snapshot.diff));
	add(
		"instructions/review.md",
		encoder.encode(
			buildReviewPrompt(
				createResolvedReviewTarget(
					snapshot.scope.kind,
					snapshot.mode,
					snapshot.diff,
					"No changes in the selected scope",
				),
				options.instructions,
				{ baseCommit: snapshot.baseCommit ?? undefined, targetCommit: snapshot.targetCommit },
			),
		),
	);
	add("instructions/reviewer.md", encoder.encode(reviewerPrompt));
	add("metadata/changes.json", json(snapshot.changes));
	add("metadata/omissions.json", json(omissions));
	const readme = `# Code review export

This ZIP is a local, manual hand-off for the user to give to another agent or reviewer. No model was called, nothing was uploaded and no review was run.

- [Built-in /review instructions for this scope](instructions/review.md)
- [Complete built-in reviewer agent definition](instructions/reviewer.md)
- [Manifest, hashes, provenance and statistics](manifest.json)
- [Full diff](diff.patch)
- [Changed-file statuses](metadata/changes.json)
- [Explicit omissions](metadata/omissions.json)

Mode: ${snapshot.mode}
Base: ${snapshot.baseCommit ?? "empty tree"}
Target: ${snapshot.targetCommit}

Source payloads retain their original bytes, encodings and line endings. **No secrets were masked or redacted.** Inspect before sharing. Binary payloads are omitted by default; their exact size and hash are recorded. Changed textual files are complete. Before/after versions use repository-relative paths. Source-line counts include each exported version, not the diff or instruction files. Supplemental unchanged context is not collected or analyzed; the receiving reviewer investigates dependencies and requests additional source as needed.

The included prompts come from the running OMP builtins, not from the reviewed repository version. The /review instructions bind patch and source acquisition to this ZIP's frozen members, overriding only those acquisition steps in the otherwise complete reviewer definition. Their task/yield references remain native OMP agent conventions; an external/web reviewer must adapt unavailable tools without changing the frozen source boundary. The native /review prompt can summarize large diffs; **diff.patch and the manifest's frozen before/after members are authoritative and must be read in full as needed**. User instructions are included for that later review, not interpreted during export.

The manifest inventories every other member; it cannot hash itself. ZIP compressed size is reported by the command after encoding (embedding it would be self-referential). No completeness claim overrides the following limitations:
${limitations.length ? limitations.map(value => `- ${value}`).join("\n") : "- None reported."}
`;
	add("README.md", encoder.encode(readme));
	const inventory = [...members].map(([member, bytes]) => ({ member, bytes: bytes.length, sha256: sha256(bytes) }));
	const manifest = {
		formatVersion: 2,
		createdAt: new Date().toISOString(),
		scope: snapshot.scope,
		mode: snapshot.mode,
		args: options.args,
		instructions: options.instructions ?? "",
		baseCommit: snapshot.baseCommit,
		targetCommit: snapshot.targetCommit,
		redaction: "none; source bytes preserved",
		changes: snapshot.changes,
		sources,
		omissions,
		limitations,
		instructionProvenance: [
			{
				member: "instructions/review.md",
				source: "packages/coding-agent/src/prompts/review-request.md",
				origin: "running OMP builtin",
				renderedFor: snapshot.scope,
			},
			{
				member: "instructions/reviewer.md",
				source: "packages/coding-agent/src/prompts/agents/reviewer.md",
				origin: "running OMP builtin",
				representation: "complete static definition, including frontmatter",
			},
		],
		members: inventory,
		statistics: {
			fileCount: members.size + 1,
			sourceFileCount: sources.filter(source => source.member).length,
			sourceLines,
			uncompressedBytes: 0,
			compressedBytes: null,
			compressedBytesNote: "Reported after ZIP encoding by the command; not embedded self-referentially.",
		},
		limits: { memberBytes: MAX_MEMBER_BYTES, uncompressedBytes: MAX_BUNDLE_BYTES },
	};
	let manifestBytes = json(manifest);
	for (;;) {
		const size = totalBytes + manifestBytes.length;
		if (manifest.statistics.uncompressedBytes === size) break;
		manifest.statistics.uncompressedBytes = size;
		manifestBytes = json(manifest);
	}
	add("manifest.json", manifestBytes);
	signal?.throwIfAborted();
	const encoded = await encodeArchive("zip", members);
	signal?.throwIfAborted();
	const tmpRoot = path.join(snapshot.root, ".tmp");
	await fs.mkdir(tmpRoot, { recursive: true });
	const tmpStat = await fs.lstat(tmpRoot);
	if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink())
		throw new Error("Review export requires a real repository-root .tmp directory, not a symlink");
	const staging = await fs.mkdtemp(path.join(tmpRoot, "review-export-"));
	const stagedPath = path.join(staging, "review-bundle.zip");
	const finalPath = path.join(tmpRoot, "review-bundle.zip");
	try {
		await fs.writeFile(stagedPath, encoded, { flag: "wx" });
		const archive = await openArchive(stagedPath);
		const archivedFiles = [...archive.indexEntries()].filter(entry => !entry.isDirectory);
		if (archivedFiles.length !== members.size) throw new Error("Review ZIP member count failed validation");
		for (const entry of archivedFiles) {
			signal?.throwIfAborted();
			const expected = members.get(entry.path);
			if (!expected || !Buffer.from((await archive.readFile(entry.path)).bytes).equals(expected)) {
				throw new Error(`Review ZIP member bytes failed validation: ${entry.path}`);
			}
		}
		signal?.throwIfAborted();
		await snapshot.assertUnchanged();
		signal?.throwIfAborted();
		await fs.rename(stagedPath, finalPath);
		return {
			path: finalPath,
			fileCount: members.size,
			sourceLines,
			uncompressedBytes: totalBytes,
			compressedBytes: encoded.length,
			mode: snapshot.mode,
			baseCommit: snapshot.baseCommit,
			targetCommit: snapshot.targetCommit,
			limitations,
		};
	} finally {
		// Never remove another export's staging or unrelated .tmp content. Cleanup cannot turn a published ZIP into failure.
		await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}
