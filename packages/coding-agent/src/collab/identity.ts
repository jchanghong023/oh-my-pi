/**
 * Persistent collab room identity.
 *
 * A room's id and secrets normally rotate with every session, so a shared link
 * dies at the next `/new`, `/resume`, `/fork`, or `/collab stop`. Keeping them
 * in one file under the config root makes a single link usable for the lifetime
 * of the installation: rotations still rebuild the room (peers reconnect,
 * `generation` advances), but the link itself never changes.
 *
 * The file holds the write token, so it is created `0600` on POSIX. On Windows
 * the config root's ACL is the boundary, exactly as for the guest replica.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";
import { generateRoomKey, generateWriteToken } from "./crypto";
import { generateRoomId } from "./protocol";

export interface CollabRoomIdentity {
	roomId: string;
	key: Uint8Array;
	writeToken: Uint8Array;
}

const IDENTITY_VERSION = 1;
/** Same shape the relay accepts as a room id (see `protocol.ts` `ROOM_PATH_RE`). */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** `collab/identity.json` under the config root, beside the guest replicas. */
export function collabIdentityPath(): string {
	return path.join(getConfigRootDir(), "collab", "identity.json");
}

/**
 * The room identity for this config root: read it, create it if absent, and
 * replace it when it is missing or corrupt.
 *
 * Never throws — a config root that cannot be written (or an identity file
 * that cannot be read) degrades to a fresh per-process identity (today's
 * behavior: a link that does not survive a restart) rather than failing
 * `/collab`. An unreadable-but-present file is never overwritten: the read
 * may have failed transiently (Windows sharing violation, backup lock), and
 * replacing it would invalidate every link ever shared.
 */
export async function loadOrCreateCollabIdentity(): Promise<CollabRoomIdentity> {
	const file = collabIdentityPath();
	const first = await readIdentity(file);
	if (first.status === "ok") return first.identity;
	// Unreadable does not mean invalid — keep the file and its links intact.
	if (first.status === "unreadable") return freshIdentity();
	const identity = freshIdentity();
	// Missing or corrupt: (re)create it.
	try {
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		// Exclusive create: a second omp racing this one loses with EEXIST and
		// adopts the winner's identity instead of overwriting it.
		await fs.writeFile(file, serializeIdentity(identity), { flag: "wx", mode: 0o600 });
		return identity;
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
			logger.warn("collab identity could not be persisted", { error: String(error) });
			return identity;
		}
	}
	const second = await readIdentity(file);
	if (second.status === "ok") return second.identity;
	// Same rule as above: a file we cannot read may still be valid.
	if (second.status === "unreadable") return identity;
	// The file exists but does not parse as an identity (truncated write, hand
	// edit, version bump): replace it atomically so a reader never sees a
	// half-written file.
	await writeIdentityAtomically(file, identity);
	return identity;
}

function freshIdentity(): CollabRoomIdentity {
	return {
		roomId: generateRoomId(),
		key: generateRoomKey(),
		writeToken: generateWriteToken(),
	};
}

function serializeIdentity(identity: CollabRoomIdentity): string {
	const payload = {
		version: IDENTITY_VERSION,
		roomId: identity.roomId,
		key: Buffer.from(identity.key).toString("base64url"),
		writeToken: Buffer.from(identity.writeToken).toString("base64url"),
	};
	return `${JSON.stringify(payload, null, "\t")}\n`;
}

/** Parse `raw`, or `null` when it is not a valid v1 identity. */
function parseIdentity(raw: string): CollabRoomIdentity | null {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof payload !== "object" || payload === null) return null;
	const { version, roomId, key, writeToken } = payload as Record<string, unknown>;
	if (version !== IDENTITY_VERSION) return null;
	if (typeof roomId !== "string" || !ROOM_ID_RE.test(roomId)) return null;
	const keyBytes = decodeSecret(key, ROOM_KEY_BYTES);
	const tokenBytes = decodeSecret(writeToken, WRITE_TOKEN_BYTES);
	if (!keyBytes || !tokenBytes) return null;
	return { roomId, key: keyBytes, writeToken: tokenBytes };
}

/**
 * base64url text for exactly `length` bytes. The decoded length is the
 * authority (Node's decoder is lenient about padding bits), the regex only
 * rejects characters the encoder never emits.
 */
function decodeSecret(value: unknown, length: number): Uint8Array | null {
	if (typeof value !== "string" || !value || !B64URL_RE.test(value)) return null;
	const bytes = Buffer.from(value, "base64url");
	return bytes.byteLength === length ? new Uint8Array(bytes) : null;
}

type IdentityRead =
	| { status: "ok"; identity: CollabRoomIdentity }
	| { status: "missing" }
	| { status: "corrupt" }
	| { status: "unreadable" };

/** Read and validate the identity file. `unreadable` (present but the read
 * itself failed — sharing violation, EMFILE, permissions) is deliberately
 * distinct from `missing`/`corrupt`: only the latter two may be rebuilt. */
async function readIdentity(file: string): Promise<IdentityRead> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("collab identity unreadable; keeping the file intact", { error: String(error) });
			return { status: "unreadable" };
		}
		return { status: "missing" };
	}
	const identity = parseIdentity(raw);
	if (!identity) {
		logger.debug("collab identity invalid; regenerating", { file });
		return { status: "corrupt" };
	}
	return { status: "ok", identity };
}

/** Best-effort tmp+rename replacement of a corrupt identity file. */
async function writeIdentityAtomically(file: string, identity: CollabRoomIdentity): Promise<void> {
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		await fs.writeFile(tmp, serializeIdentity(identity), { mode: 0o600 });
		await fs.rename(tmp, file);
	} catch (error) {
		logger.warn("collab identity could not be replaced", { error: String(error) });
		await fs.rm(tmp, { force: true }).catch(() => {});
	}
}
