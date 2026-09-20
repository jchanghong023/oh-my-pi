/**
 * Contract: `collab/identity.json` under the config root is the room identity
 * every room of one installation reuses, so a shared link keeps working across
 * session rotation and restarts. It is created once, adopted verbatim while it
 * is valid, and regenerated when it is corrupt — without ever failing the
 * caller (a config root that cannot be written degrades to an in-memory
 * identity instead of breaking `/collab`).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collabIdentityPath, loadOrCreateCollabIdentity } from "@oh-my-pi/pi-coding-agent/collab/identity";
import * as utils from "@oh-my-pi/pi-utils";

const ROOM_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

interface StoredIdentity {
	version: number;
	roomId: string;
	key: string;
	writeToken: string;
}

async function readStoredIdentity(): Promise<StoredIdentity> {
	return JSON.parse(await fs.readFile(collabIdentityPath(), "utf8")) as StoredIdentity;
}

/** Persisted form of a known identity, as another process would have written it. */
function storedIdentity(roomId: string, key: Uint8Array, writeToken: Uint8Array): string {
	return JSON.stringify({
		version: 1,
		roomId,
		key: Buffer.from(key).toString("base64url"),
		writeToken: Buffer.from(writeToken).toString("base64url"),
	});
}

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-identity-"));
	spyOn(utils, "getConfigRootDir").mockReturnValue(tmp);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("collab room identity", () => {
	it("creates a usable identity on first use and keeps it for later starts", async () => {
		const first = await loadOrCreateCollabIdentity();

		expect(first.roomId).toMatch(ROOM_ID_RE);
		expect(first.key.byteLength).toBe(32);
		expect(first.writeToken.byteLength).toBe(16);

		const stored = await readStoredIdentity();
		expect(stored.version).toBe(1);
		expect(stored.roomId).toBe(first.roomId);
		expect(Buffer.from(stored.key, "base64url").equals(Buffer.from(first.key))).toBe(true);
		expect(Buffer.from(stored.writeToken, "base64url").equals(Buffer.from(first.writeToken))).toBe(true);

		// A later room (next session, next omp run) reads the same identity back.
		const second = await loadOrCreateCollabIdentity();
		expect(second.roomId).toBe(first.roomId);
		expect(Buffer.from(second.key).equals(Buffer.from(first.key))).toBe(true);
		expect(Buffer.from(second.writeToken).equals(Buffer.from(first.writeToken))).toBe(true);
	});

	it("adopts an existing valid identity verbatim", async () => {
		const roomId = "AbCdEfGhIjKlMnOpQrStUv";
		const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
		const writeToken = Buffer.from(Array.from({ length: 16 }, (_, index) => 200 + index));
		await fs.mkdir(path.dirname(collabIdentityPath()), { recursive: true });
		await fs.writeFile(collabIdentityPath(), storedIdentity(roomId, key, writeToken));

		const identity = await loadOrCreateCollabIdentity();

		expect(identity.roomId).toBe(roomId);
		expect(Buffer.from(identity.key).equals(key)).toBe(true);
		expect(Buffer.from(identity.writeToken).equals(writeToken)).toBe(true);
		// Untouched: no rewrite, no temp file left behind.
		expect((await fs.readdir(path.dirname(collabIdentityPath()))).sort()).toEqual(["identity.json"]);
	});

	it("replaces a corrupt identity and keeps serving the replacement", async () => {
		await fs.mkdir(path.dirname(collabIdentityPath()), { recursive: true });
		await fs.writeFile(collabIdentityPath(), '{"version":1,"roomId":"short","key":"AAAA"}');

		const identity = await loadOrCreateCollabIdentity();

		expect(identity.roomId).toMatch(ROOM_ID_RE);
		const stored = await readStoredIdentity();
		expect(stored.roomId).toBe(identity.roomId);
		expect((await fs.readdir(path.dirname(collabIdentityPath()))).sort()).toEqual(["identity.json"]);
		expect((await loadOrCreateCollabIdentity()).roomId).toBe(identity.roomId);
	});

	it("still returns a usable identity when the path is not a file", async () => {
		// A directory in place of the file defeats both the exclusive create and
		// the atomic replace; collab must still start with a fresh in-memory room.
		await fs.mkdir(collabIdentityPath(), { recursive: true });

		const identity = await loadOrCreateCollabIdentity();

		expect(identity.roomId).toMatch(ROOM_ID_RE);
		expect(identity.key.byteLength).toBe(32);
		expect(identity.writeToken.byteLength).toBe(16);
	});
});
