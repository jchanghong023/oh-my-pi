import { sha256 } from "@noble/hashes/sha256";

/** Preserve SHA-256 wire values on HTTP origins where WebCrypto subtle is unavailable. */
export async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const bytes = Uint8Array.from(input);
  if (globalThis.crypto?.subtle) {
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer));
  }
  return sha256(bytes);
}
