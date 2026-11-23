import { request } from "node:http";
import { isIP } from "node:net";
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";
import type { ParsedCollabLink } from "./protocol";

const PORT = 9333;
const REQUEST_TIMEOUT_MS = 5_000;

function validId(value: string, min: number): boolean {
	return value.length >= min && value.length <= 64 && !/[^A-Za-z0-9_-]/.test(value);
}

export class NumberedRoomError extends Error {}

export function isCollab2RoomNumber(value: string): boolean {
	return validId(value, 1) && value !== "join" && value !== "stop";
}

export class NumberedRoomClient {
	readonly #ip: string;
	readonly #authority: string;

	constructor() {
		const ip = Bun.env.OMP_COLLAB2_IP ?? (Bun.env.OMP_OFFLINE === undefined ? "127.0.0.1" : "10.239.93.104");
		const family = isIP(ip);
		if (family === 0 || ip.includes("%")) throw new NumberedRoomError("OMP_COLLAB2_IP must be an IP literal");
		this.#ip = ip;
		this.#authority = `${family === 6 ? `[${ip}]` : ip}:${PORT}`;
	}

	socketUrl(roomId: string): string {
		return `ws://${this.#authority}/r/${roomId}`;
	}

	async register(
		roomNumber: string,
		roomId: string,
		key: Uint8Array,
		token: Uint8Array,
		signal: AbortSignal,
	): Promise<void> {
		const secret = Buffer.concat([key, token]).toString("base64url");
		const { status } = await this.#post("rooms", { roomNumber, roomId, secret }, signal);
		if (status === 201) return;
		if (status === 409) throw new NumberedRoomError("Collab2 room number is already in use");
		if (status === 404) throw new NumberedRoomError("Collab2 room is unavailable");
		throw new NumberedRoomError("Collab2 registration was rejected");
	}

	async lookup(roomNumber: string, signal: AbortSignal): Promise<ParsedCollabLink> {
		const { status, body } = await this.#post("lookup", { roomNumber }, signal);
		if (status === 404) throw new NumberedRoomError("Collab2 room is unavailable");
		if (status !== 200) throw new NumberedRoomError("Collab2 lookup was rejected");
		try {
			const data = JSON.parse(body) as { roomId?: unknown; secret?: unknown };
			if (
				typeof data.roomId === "string" &&
				validId(data.roomId, 10) &&
				typeof data.secret === "string" &&
				validId(data.secret, 64)
			) {
				const secret = Buffer.from(data.secret, "base64url");
				return {
					roomId: data.roomId,
					wsUrl: this.socketUrl(data.roomId),
					key: secret.subarray(0, ROOM_KEY_BYTES),
					writeToken: secret.subarray(ROOM_KEY_BYTES, ROOM_KEY_BYTES + WRITE_TOKEN_BYTES),
				};
			}
		} catch {
			// Never report response content, even in a parser error.
		}
		throw new NumberedRoomError("Invalid Collab2 lookup response");
	}

	// Bun fetch honors environment proxies even with an empty proxy option.
	// A one-shot node:http request with no agent bypasses the proxy-aware global agent.
	async #post(
		route: "rooms" | "lookup",
		payload: Record<string, string>,
		signal: AbortSignal,
	): Promise<{ status: number; body: string }> {
		const body = JSON.stringify(payload);
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
		const outgoing = request(
			{
				hostname: this.#ip,
				port: PORT,
				path: `/api/collab2/${route}`,
				method: "POST",
				agent: false,
				signal: AbortSignal.any([signal, timeout]),
				headers: {
					host: this.#authority,
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
				},
			},
			async incoming => {
				const status = incoming.statusCode ?? 0;
				if (route !== "lookup" || status !== 200) {
					incoming.resume();
					resolve({ status, body: "" });
					return;
				}
				try {
					incoming.setEncoding("utf8");
					let text = "";
					for await (const chunk of incoming) {
						text += chunk;
						if (text.length > 8192) throw new NumberedRoomError("Invalid Collab2 lookup response");
					}
					resolve({ status, body: text });
				} catch (error) {
					reject(error);
				}
			},
		);
		outgoing.once("error", reject);
		outgoing.end(body);
		try {
			return await promise;
		} catch (error) {
			if (error instanceof NumberedRoomError) throw error;
			if (signal.aborted) throw new NumberedRoomError("Collab2 request cancelled");
			if (timeout.aborted) throw new NumberedRoomError("Collab2 request timed out");
			throw new NumberedRoomError("Collab2 server did not return a valid response");
		}
	}
}
