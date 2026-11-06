import { intranetCollabEnabled, isIntranetUsername } from "./intranet";
import type { IntranetHostRegistration } from "./intranet";
import { ENVELOPE_HEADER_LENGTH, parseCollabLink, rewriteEnvelopePeer, unpackEnvelope } from "./protocol";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const USER_PATH_RE = /^\/collab\/users\/([^/]+)$/;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	peerId: number;
	username?: string;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

interface Registration extends IntranetHostRegistration {
	roomId: string;
	host: RelaySocket;
}

export interface IntranetRelay {
	url: string;
	stop(): void;
}

export function startIntranetRelay(options: { hostname?: string; port?: number } = {}): IntranetRelay {
	if (!intranetCollabEnabled()) throw new Error("The intranet collaboration relay requires OMP_OFFLINE.");
	const hostname = options.hostname ?? "127.0.0.1";
	const port = options.port ?? 7466;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Relay port must be between 0 and 65535.");
	const rooms = new Map<string, Room>();
	const registrations = new Map<string, Registration>();
	let stopped = false;

	function isLive(registration: Registration): boolean {
		return registration.host.readyState === 1 && rooms.get(registration.roomId)?.host === registration.host;
	}

	function registrationError(ws: RelaySocket, message: string): void {
		ws.send(JSON.stringify({ t: "registration-error", message }));
		ws.close(4010, "username registration failed");
	}

	function register(ws: RelaySocket, value: unknown): void {
		if (
			typeof value !== "object" ||
			value === null ||
			!("username" in value) ||
			typeof value.username !== "string" ||
			!isIntranetUsername(value.username) ||
			!("hostname" in value) ||
			typeof value.hostname !== "string" ||
			!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,252}$/.test(value.hostname) ||
			!("link" in value) ||
			typeof value.link !== "string"
		) {
			registrationError(ws, "Invalid intranet username registration.");
			return;
		}
		const parsed = parseCollabLink(value.link);
		if ("error" in parsed || parsed.roomId !== ws.data.roomId) {
			registrationError(ws, "The registered link must grant access to this room.");
			return;
		}
		if (ws.data.username !== undefined && ws.data.username !== value.username) {
			registrationError(ws, "A host may register only one login username.");
			return;
		}
		const owner = registrations.get(value.username);
		if (owner && owner.host !== ws && isLive(owner)) {
			registrationError(
				ws,
				`User ${value.username} is already sharing on ${owner.hostname}; use /join ${value.username} to join.`,
			);
			return;
		}
		// No await between checking ownership and committing: competing hosts cannot both succeed.
		registrations.set(value.username, {
			username: value.username,
			hostname: value.hostname,
			link: value.link,
			roomId: ws.data.roomId,
			host: ws,
		});
		ws.data.username = value.username;
		ws.send(JSON.stringify({ t: "registered" }));
	}

	const server = Bun.serve<SocketData>({
		hostname,
		port,
		fetch(req, srv): Response | undefined {
			if (stopped || req.method !== "GET") return new Response("not found", { status: 404 });
			const url = new URL(req.url);
			const userMatch = USER_PATH_RE.exec(url.pathname);
			if (userMatch) {
				let username: string;
				try {
					username = decodeURIComponent(userMatch[1]!);
				} catch {
					return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
				}
				const registration = isIntranetUsername(username) ? registrations.get(username) : undefined;
				if (!registration || !isLive(registration)) {
					if (registration) registrations.delete(username);
					return new Response("User is offline or is not sharing.", {
						status: 404,
						headers: { "Cache-Control": "no-store" },
					});
				}
				return Response.json({ link: registration.link }, { headers: { "Cache-Control": "no-store" } });
			}
			const match = ROOM_PATH_RE.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (!match || (role !== "host" && role !== "guest")) return new Response("not found", { status: 404 });
			const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
		websocket: {
			open(ws: RelaySocket): void {
				if (stopped) {
					ws.close(1001, "relay shutting down");
					return;
				}
				const { roomId, role } = ws.data;
				if (role === "host") {
					if (rooms.has(roomId)) {
						ws.close(4009, "a host is already connected for this room");
						return;
					}
					rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					return;
				}
				const room = rooms.get(roomId);
				if (!room || room.host.readyState !== 1) {
					ws.close(4004, "no such room");
					return;
				}
				const peerId = room.nextPeerId++;
				ws.data.peerId = peerId;
				room.guests.set(peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				const room = rooms.get(ws.data.roomId);
				if (!room || stopped || ws.readyState !== 1) return;
				if (ws.data.role === "host") {
					if (room.host !== ws) return;
					if (typeof message === "string") {
						let value: unknown;
						try {
							value = JSON.parse(message);
						} catch {
							registrationError(ws, "Invalid intranet username registration.");
							return;
						}
						if (typeof value === "object" && value !== null && "t" in value && value.t === "register") {
							register(ws, value);
						}
						return;
					}
					const envelope = unpackEnvelope(message);
					if (!envelope) return;
					if (envelope.peerId === 0) {
						for (const guest of room.guests.values()) guest.send(message);
					} else {
						room.guests.get(envelope.peerId)?.send(message);
					}
					return;
				}
				if (room.guests.get(ws.data.peerId) !== ws || typeof message === "string") return;
				if (message.byteLength < ENVELOPE_HEADER_LENGTH || room.host.readyState !== 1) return;
				rewriteEnvelopePeer(message, ws.data.peerId);
				room.host.send(message);
			},
			close(ws: RelaySocket): void {
				const { roomId, role, peerId, username } = ws.data;
				if (username !== undefined && registrations.get(username)?.host === ws) registrations.delete(username);
				const room = rooms.get(roomId);
				if (!room) return;
				if (role === "host") {
					if (room.host !== ws) return;
					rooms.delete(roomId);
					const closure = JSON.stringify({ t: "room-closed" });
					for (const guest of room.guests.values()) {
						guest.send(closure);
						guest.close(4001, "room closed");
					}
					room.guests.clear();
					return;
				}
				if (room.guests.get(peerId) === ws) {
					room.guests.delete(peerId);
					room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
				}
			},
		},
	});

	return {
		url: server.url.origin.replace(/^http/, "ws"),
		stop(): void {
			if (stopped) return;
			stopped = true;
			registrations.clear();
			for (const room of rooms.values()) {
				const closure = JSON.stringify({ t: "room-closed" });
				for (const guest of room.guests.values()) {
					guest.send(closure);
					guest.close(4001, "room closed");
				}
				room.host.close(1001, "relay shutting down");
				room.guests.clear();
			}
			rooms.clear();
			server.stop(true);
		},
	};
}
