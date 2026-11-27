import { decodeEmbeddedArchive, hasEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";

export { hasEmbeddedArchive as hasEmbeddedClientArchive };

/** Decode the generated stats archive as a Buffer; return null for absent or malformed text. */
export function decodeEmbeddedClientArchive(txt: string): Buffer | null {
	const archive = decodeEmbeddedArchive(txt);
	if (archive === null || Buffer.isBuffer(archive)) return archive;
	return Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
}
