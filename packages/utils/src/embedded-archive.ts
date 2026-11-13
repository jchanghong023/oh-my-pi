/**
 * Shared build-time embedding for browser bundles in OMP binaries and npm packs.
 *
 * The generated artifact is the base64 of a gzip-compressed tar of a file tree:
 * the format the stats dashboard has shipped since before the fork. Callers keep
 * the text in a generated `.txt` module so importing it costs only the cheap
 * magic-byte sniff; the archive is decoded and extracted lazily on first use.
 */

const TAR_BLOCK_SIZE = 512;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_MTIME_OFFSET = 136;
const TAR_MTIME_LENGTH = 12;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_LENGTH = 8;

function readTarOctal(bytes: Uint8Array, offset: number, length: number): number {
	const value = Buffer.from(bytes.subarray(offset, offset + length))
		.toString("ascii")
		.replace(/\0.*$/, "")
		.trim();
	return value ? Number.parseInt(value, 8) : 0;
}

function writeTarOctal(bytes: Uint8Array, offset: number, length: number, value: number): void {
	const octal = value.toString(8);
	if (octal.length >= length) throw new Error(`Tar value ${value} does not fit in ${length} bytes`);
	bytes.fill(0x30, offset, offset + length - 1);
	bytes.set(Buffer.from(octal), offset + length - 1 - octal.length);
	bytes[offset + length - 1] = 0;
}

/**
 * Zero timestamps and recompute checksums so identical inputs produce identical
 * archive bytes regardless of when the build ran.
 */
export function normalizeEmbeddedTarMetadata(bytes: Uint8Array): void {
	for (let offset = 0; offset + TAR_BLOCK_SIZE <= bytes.length;) {
		const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (header.every(byte => byte === 0)) return;

		const size = readTarOctal(header, TAR_SIZE_OFFSET, TAR_SIZE_LENGTH);
		writeTarOctal(header, TAR_MTIME_OFFSET, TAR_MTIME_LENGTH, 0);
		header.fill(0x20, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH);

		let checksum = 0;
		for (const byte of header) checksum += byte;
		const checksumOctal = checksum.toString(8).padStart(6, "0");
		if (checksumOctal.length > 6) throw new Error(`Tar checksum ${checksum} exceeds the header field`);
		header.set(Buffer.from(checksumOctal), TAR_CHECKSUM_OFFSET);
		header[TAR_CHECKSUM_OFFSET + 6] = 0;
		header[TAR_CHECKSUM_OFFSET + 7] = 0x20;

		offset += TAR_BLOCK_SIZE * (1 + Math.ceil(size / TAR_BLOCK_SIZE));
		if (offset > bytes.length) throw new Error("Tar entry extends beyond the archive");
	}
}

/** Build the byte-stable base64 archive text shared by every embedded frontend. */
export async function buildEmbeddedArchive(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
	const sorted: Record<string, Uint8Array> = {};
	for (const name of [...files.keys()].sort()) sorted[name] = files.get(name)!;
	const tar = new Uint8Array(await new Bun.Archive(sorted).bytes());
	normalizeEmbeddedTarMetadata(tar);
	return Buffer.from(Bun.gzipSync(tar, { level: 9 })).toString("base64");
}

/** True when the generated text carries a gzip archive, without decoding it. */
export function hasEmbeddedArchive(text: string): boolean {
	return /^\s*H4s/.test(text);
}

/** Decode the generated text; `null` for blank, placeholder or malformed content. */
export function decodeEmbeddedArchive(text: string): Uint8Array | null {
	if (!hasEmbeddedArchive(text)) return null;
	const normalized = text.replaceAll(/\s+/g, "");
	if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
	const archive = Buffer.from(normalized, "base64");
	if (archive[0] !== 0x1f || archive[1] !== 0x8b) return null;
	return archive;
}

/** Extract an embedded archive into an in-memory path map with inferred MIME types. */
export async function extractEmbeddedArchive(archive: Uint8Array): Promise<Map<string, File>> {
	const files = await new Bun.Archive(archive).files();
	for (const [name, blob] of files) {
		files.set(name, new File([blob], name, { type: Bun.file(name).type }));
	}
	return files;
}
