import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
import {
	buildRequirementSnapshot,
	canonicalJson,
	decodeRequirementPackage,
	digestFiles,
	encodeRequirementPackage,
	sha256,
} from "../../src/aireq-workbench/requirement-package";
import type { AIReqAttachment, AIReqPackageManifest, AIReqRequirementContent } from "../../src/aireq-workbench/workflow-types";

interface PackageFixture {
	content: AIReqRequirementContent;
	manifest: AIReqPackageManifest;
	files: Map<string, Uint8Array>;
}

const prefix = "docs/aireq/requirements/package-ir/";
const encoder = new TextEncoder();
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function outputPath(name = "requirements.zip"): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aireq-package-"));
	roots.push(root);
	return path.join(root, name);
}
function fixture(attachments: AIReqAttachment[] = []): PackageFixture {
	const markdown =
		"# Requirement\n\n## Scope\nPreserve approved material.\n\n## Rules\nReject ambiguous inputs.\n\n## Acceptance\nImported bytes equal exported bytes.\n";
	const content: AIReqRequirementContent = {
		title: "Portable requirement Ω",
		document: { path: `${prefix}ir.md`, content: markdown },
		srs: [
			{
				id: "package-sr",
				title: "Portable system requirement",
				document: { path: `${prefix}sr.md`, content: markdown },
			},
		],
		attachments: [...attachments],
	};
	content.attachments.push({
		path: `${prefix}requirements.json`,
		content: canonicalJson({
			version: 1,
			irId: "package-ir",
			title: content.title,
			documentPath: content.document.path,
			srs: content.srs.map(sr => ({ id: sr.id, title: sr.title, documentPath: sr.document.path })),
		}),
	});
	const snapshot = buildRequirementSnapshot("source-project", "package-ir", content);
	const createdAt = "2026-11-10T00:00:00.000Z";
	const manifest: AIReqPackageManifest = {
		format: "omp-aireq-requirements",
		version: 1,
		packageId: "package-one",
		sourceProjectId: "source-project",
		repositoryId: "https://example.invalid/team/project.git",
		irId: "package-ir",
		releaseId: "release-one",
		createdAt,
		snapshot,
		confirmation: { operationId: "confirm-one", snapshotDigest: snapshot.digest, confirmedAt: createdAt },
		review: {
			id: "review-one",
			snapshotDigest: snapshot.digest,
			passed: true,
			report: "Approved complete requirement and system document.",
			reviewer: { sessionId: "reviewer-one", role: "reviewer" },
			createdAt,
		},
		files: snapshot.files,
	};
	const files = new Map(
		[content.document, ...content.srs.map(sr => sr.document), ...content.attachments].map(doc => [
			doc.path,
			typeof doc.content === "string" ? encoder.encode(doc.content) : doc.content,
		]),
	);
	return { content, manifest, files };
}
/** Model an externally supplied, internally hash-consistent manifest, not an approved local export. */
function replaceMaterial(f: PackageFixture, name: string, bytes: Uint8Array): void {
	f.files.set(name, bytes);
	f.manifest.files = f.manifest.files.map(file =>
		file.path === name ? { path: name, sha256: sha256(bytes), size: bytes.length } : file,
	);
	f.manifest.snapshot.files = f.manifest.files;
	const { digest: _digest, ...basis } = f.manifest.snapshot;
	f.manifest.snapshot.digest = sha256(canonicalJson(basis));
	f.manifest.confirmation.snapshotDigest = f.manifest.snapshot.digest;
	f.manifest.review.snapshotDigest = f.manifest.snapshot.digest;
}
async function rawArchive(
	f: PackageFixture,
	entries: Iterable<readonly [string, Uint8Array]> = f.files,
): Promise<Uint8Array> {
	const target = await outputPath("external.zip");
	await writeArchive(target, "zip", [["manifest.json", canonicalJson(f.manifest)], ...entries]);
	return fs.readFile(target);
}
/** Add central-directory Unicode Path records without changing valid local payloads/CRCs. */
function unicodeNames(bytes: Uint8Array, overrides: ReadonlyMap<string, string>): Uint8Array {
	const input = Buffer.from(bytes);
	const end = input.length - 22;
	const directory = input.readUInt32LE(end + 16);
	const count = input.readUInt16LE(end + 10);
	const members: Buffer[] = [];
	let at = directory;
	for (let index = 0; index < count; index++) {
		const nameLength = input.readUInt16LE(at + 28);
		const extraLength = input.readUInt16LE(at + 30);
		const commentLength = input.readUInt16LE(at + 32);
		const rawName = input.subarray(at + 46, at + 46 + nameLength);
		const next = at + 46 + nameLength + extraLength + commentLength;
		const override = overrides.get(rawName.toString("utf8"));
		if (override === undefined) members.push(input.subarray(at, next));
		else {
			const encoded = encoder.encode(override);
			const extra = Buffer.alloc(9 + encoded.length);
			extra.writeUInt16LE(0x7075, 0);
			extra.writeUInt16LE(5 + encoded.length, 2);
			extra[4] = 1;
			extra.writeUInt32LE(Bun.hash.crc32(rawName) >>> 0, 5);
			extra.set(encoded, 9);
			const header = Buffer.from(input.subarray(at, at + 46));
			header.writeUInt16LE(extraLength + extra.length, 30);
			const extraEnd = at + 46 + nameLength + extraLength;
			members.push(
				Buffer.concat([header, input.subarray(at + 46, extraEnd), extra, input.subarray(extraEnd, next)]),
			);
		}
		at = next;
	}
	const central = Buffer.concat(members);
	const trailer = Buffer.from(input.subarray(end));
	trailer.writeUInt32LE(central.length, 12);
	return Buffer.concat([input.subarray(0, directory), central, trailer]);
}

describe("requirement package consumer boundary", () => {
	test("preserves Unicode names, UTF-8 text, PDF and image bytes across locale-dependent collation", async () => {
		const pdf = new Uint8Array([
			...encoder.encode("%PDF-1.7\n%"),
			0xe2,
			0xe3,
			0xcf,
			0xd3,
			10,
			...encoder.encode("1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"),
		]);
		const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 42]);
		const attachments = [
			{ path: `${prefix}ä.md`, content: "Original approved Unicode notes Ω\n" },
			{ path: `${prefix}z.md`, content: "Original approved plain notes\n" },
			{ path: `${prefix}attachments/图像.png`, content: image },
			{ path: `${prefix}attachments/source.pdf`, content: pdf },
		];
		let collator = new Intl.Collator("en");
		const comparison = spyOn(String.prototype, "localeCompare").mockImplementation(function (
			this: string,
			other: string,
		) {
			return collator.compare(String(this), other);
		});
		try {
			const f = fixture(attachments);
			const target = await outputPath();
			await encodeRequirementPackage(target, f.manifest, f.files);
			collator = new Intl.Collator("sv");
			const decoded = await decodeRequirementPackage(target);
			expect(decoded.manifest).toEqual(f.manifest);
			expect(decoded.digest).toBe(sha256(canonicalJson(f.manifest)));
			expect(decoded.manifest.snapshot.files.map(file => file.path)).toEqual([...f.files.keys()].sort());
			expect(canonicalJson({ ä: 1, z: 2 })).toBe('{"z":2,"ä":1}');
			expect(digestFiles([...f.manifest.files].reverse())).toBe(sha256(canonicalJson(f.manifest.files)));
			expect(buildRequirementSnapshot("source-project", "package-ir", f.content)).toEqual(f.manifest.snapshot);
			for (const [name, bytes] of f.files) expect(decoded.files.get(name)).toEqual(bytes);
		} finally {
			comparison.mockRestore();
		}
	});

	test("imports all 1024 allowed files including more than 2048 synthesized directory entries", async () => {
		const attachments: AIReqAttachment[] = Array.from({ length: 1021 }, (_, index) => ({
			path: `${prefix}attachments/branch-${index}/nested-${index}/evidence.bin`,
			content: new Uint8Array([0, 255, index % 256]),
		}));
		const f = fixture(attachments);
		expect(f.files.size).toBe(1024);
		const target = await outputPath();
		await encodeRequirementPackage(target, f.manifest, f.files);
		const decoded = await decodeRequirementPackage(await fs.readFile(target));
		expect(decoded.manifest).toEqual(f.manifest);
		expect(decoded.files.size).toBe(1024);
		for (const [name, bytes] of f.files) expect(decoded.files.get(name)).toEqual(bytes);
	});

	test("rejects an excessive exported file set without replacing the destination", async () => {
		const f = fixture(
			Array.from({ length: 1022 }, (_, index) => ({
				path: `${prefix}evidence-${index}.bin`,
				content: new Uint8Array([255]),
			})),
		);
		const target = await outputPath();
		await fs.writeFile(target, "existing user material");
		await expect(encodeRequirementPackage(target, f.manifest, f.files)).rejects.toThrow("Invalid file manifest");
		expect(await fs.readFile(target, "utf8")).toBe("existing user material");
		await expect(decodeRequirementPackage(await rawArchive(f))).rejects.toThrow("excessive ZIP entries");
	});

	test.each([
		["API credential", "api_key=private-secret-value", "credentials"],
		["access token", "access_token: private-token-value", "credentials"],
		["private key", "-----BEGIN PRIVATE KEY-----\nprivate data", "credentials"],
		["Unix machine path", "Reference /home/owner/private/material.txt", "absolute machine path"],
		["Windows machine path", "Reference C:\\Users\\owner\\private.txt", "absolute machine path"],
	])("rejects UTF-8 byte %s on both export and external import", async (_label, prohibited, reason) => {
		const name = `${prefix}attachment.bin`;
		const f = fixture([{ path: name, content: new Uint8Array([255, 128, 0]) }]);
		replaceMaterial(f, name, encoder.encode(prohibited));
		const target = await outputPath();
		await fs.writeFile(target, "keep destination");
		await expect(encodeRequirementPackage(target, f.manifest, f.files)).rejects.toThrow(reason);
		expect(await fs.readFile(target, "utf8")).toBe("keep destination");
		await expect(decodeRequirementPackage(await rawArchive(f))).rejects.toThrow(reason);
		expect(f.files.get(name)).toEqual(encoder.encode(prohibited));
	});

	test("accepts a safe Unicode Path override using the archive reader's effective name", async () => {
		const name = `${prefix}附件.txt`;
		const f = fixture([{ path: name, content: "Approved attachment Ω\n" }]);
		const alias = "legacy-attachment.txt";
		const archive = await rawArchive(
			f,
			[...f.files].map(([entry, bytes]) => [entry === name ? alias : entry, bytes] as const),
		);
		const decoded = await decodeRequirementPackage(unicodeNames(archive, new Map([[alias, name]])));
		expect(decoded.manifest).toEqual(f.manifest);
		expect(decoded.files.get(name)).toEqual(f.files.get(name));
	});

	test.each([
		["../escaped.txt", "Unsafe material path"],
		["docs/aireq/requirements/package-ir/../escaped.txt", "Unsafe material path"],
		["manifest.json", "Duplicate ZIP member"],
		[`${prefix}ir.md`, "Duplicate ZIP member"],
		[`${prefix}IR.md`, "Duplicate ZIP member"],
	])("rejects unsafe or colliding effective Unicode ZIP name %s", async (effectiveName, reason) => {
		const name = `${prefix}attachment.txt`;
		const f = fixture([{ path: name, content: "Approved attachment\n" }]);
		const bytes = unicodeNames(await rawArchive(f), new Map([[name, effectiveName]]));
		await expect(decodeRequirementPackage(bytes)).rejects.toThrow(reason);
	});

	test("rejects NFC-equivalent effective ZIP members before the archive can upsert them", async () => {
		const original = `${prefix}ä.txt`;
		const alias = `${prefix}other.txt`;
		const f = fixture([
			{ path: original, content: "Approved first\n" },
			{ path: alias, content: "Approved second\n" },
		]);
		const bytes = unicodeNames(await rawArchive(f), new Map([[alias, `${prefix}a\u0308.txt`]]));
		await expect(decodeRequirementPackage(bytes)).rejects.toThrow("Duplicate ZIP member");
	});

	test("rejects corrupt, missing, unlisted and duplicate members and inconsistent approval digests", async () => {
		const name = `${prefix}evidence.txt`;
		const f = fixture([{ path: name, content: "Approved evidence\n" }]);
		const changed = new Map(f.files).set(name, encoder.encode("Altered evidence!\n"));
		await expect(decodeRequirementPackage(await rawArchive(f, changed))).rejects.toThrow(
			"Missing or corrupt material",
		);
		const missing = new Map(f.files);
		missing.delete(name);
		await expect(decodeRequirementPackage(await rawArchive(f, missing))).rejects.toThrow("file set");
		await expect(
			decodeRequirementPackage(
				await rawArchive(f, [...f.files, [`${prefix}unlisted.txt`, encoder.encode("Not approved")]]),
			),
		).rejects.toThrow("file set");
		await expect(
			decodeRequirementPackage(await rawArchive(f, [...f.files, [name, f.files.get(name)!]])),
		).rejects.toThrow("Duplicate ZIP member");
		f.manifest.confirmation.snapshotDigest = "0".repeat(64);
		await expect(decodeRequirementPackage(await rawArchive(f))).rejects.toThrow(
			"Snapshot/confirmation/review version mismatch",
		);
		const truncated = (await rawArchive(f)).subarray(0, 20);
		await expect(decodeRequirementPackage(truncated)).rejects.toThrow("Invalid ZIP directory");
	});
});
