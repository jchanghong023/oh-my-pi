import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { generateRoomKey, generateWriteToken, importRoomKey, open, seal } from "../../src/collab/crypto";
import { resolveIntranetUsername } from "../../src/collab/intranet";
import {
	COLLAB_PROTO,
	formatCollabLink,
	generateRoomId,
	packEnvelope,
	parseCollabLink,
	unpackEnvelope,
} from "../../src/collab/protocol";
import { type IntranetRelay, startIntranetRelay } from "../../src/collab/relay-server";

const EVENT_TIMEOUT_MS = 3_000;
let previousOffline: string | undefined;

beforeEach(() => {
	previousOffline = process.env.OMP_OFFLINE;
	process.env.OMP_OFFLINE = "1";
});

afterEach(() => {
	if (previousOffline === undefined) delete process.env.OMP_OFFLINE;
	else process.env.OMP_OFFLINE = previousOffline;
});

class Inbox<T> {
	readonly values: T[] = [];
	readonly listeners = new Set<() => void>();

	push(value: T): void {
		this.values.push(value);
		for (const listener of this.listeners) listener();
	}

	take(predicate: (value: T) => boolean = () => true): Promise<T> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				this.listeners.delete(receive);
			};
			const receive = () => {
				const index = this.values.findIndex(predicate);
				if (index === -1) return;
				const [value] = this.values.splice(index, 1);
				cleanup();
				resolve(value!);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("Timed out waiting for a relay event"));
			}, EVENT_TIMEOUT_MS);
			this.listeners.add(receive);
			receive();
		});
	}
}

class Peer {
	readonly socket: WebSocket;
	readonly opened = new Inbox<Event>();
	readonly closed = new Inbox<CloseEvent>();
	readonly messages = new Inbox<string | ArrayBuffer>();

	constructor(url: string) {
		this.socket = new WebSocket(url);
		this.socket.binaryType = "arraybuffer";
		this.socket.addEventListener("open", event => this.opened.push(event));
		this.socket.addEventListener("close", event => this.closed.push(event));
		this.socket.addEventListener("message", event => this.messages.push(event.data as string | ArrayBuffer));
	}

	async control(): Promise<unknown> {
		const text = await this.messages.take(message => typeof message === "string");
		if (typeof text !== "string") throw new Error("Expected a relay control frame");
		return JSON.parse(text) as unknown;
	}

	async encrypted(key: CryptoKey) {
		const bytes = await this.messages.take(message => message instanceof ArrayBuffer);
		if (!(bytes instanceof ArrayBuffer)) throw new Error("Expected a binary relay frame");
		const envelope = unpackEnvelope(new Uint8Array(bytes));
		if (!envelope) throw new Error("Expected a routed encrypted frame");
		expect(envelope.peerId).toBeGreaterThan(0);
		return open(key, envelope.payload);
	}
}

interface RelayHarness {
	relay: IntranetRelay;
	connect(roomId: string, role: "host" | "guest", wsUrl?: string): Promise<Peer>;
}

async function withRelay(run: (harness: RelayHarness) => Promise<void>, hostname = "127.0.0.1"): Promise<void> {
	const relay = startIntranetRelay({ hostname, port: 0 });
	const peers: Peer[] = [];
	try {
		await run({
			relay,
			async connect(roomId, role, wsUrl = `${relay.url}/r/${roomId}`) {
				const peer = new Peer(`${wsUrl}?role=${role}`);
				peers.push(peer);
				await peer.opened.take();
				return peer;
			},
		});
	} finally {
		for (const peer of peers) peer.socket.close();
		relay.stop();
	}
}

function registration(peer: Peer, username: string, hostname: string, link: string): void {
	peer.socket.send(JSON.stringify({ t: "register", username, hostname, link }));
}

function lookup(relay: IntranetRelay, username: string): Promise<Response> {
	return fetch(`${relay.url.replace(/^ws/, "http")}/collab/users/${encodeURIComponent(username)}`, {
		signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
	});
}

function parsedLink(link: string) {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

describe("offline intranet relay", () => {
	it("resolves independent usernames and routes encrypted prompts only to their current hosts", async () => {
		await withRelay(async ({ relay, connect }) => {
			const roomA = generateRoomId();
			const roomB = generateRoomId();
			const rawKeyA = generateRoomKey();
			const rawKeyB = generateRoomKey();
			const keyA = await importRoomKey(rawKeyA);
			const keyB = await importRoomKey(rawKeyB);
			const hostA = await connect(roomA, "host");
			const hostB = await connect(roomB, "host");
			registration(
				hostA,
				"relay_alice",
				"alice-workstation",
				formatCollabLink(relay.url, roomA, rawKeyA, generateWriteToken()),
			);
			registration(
				hostB,
				"relay_bob",
				"bob-workstation",
				formatCollabLink(relay.url, roomB, rawKeyB, generateWriteToken()),
			);
			expect(await hostA.control()).toEqual({ t: "registered" });
			expect(await hostB.control()).toEqual({ t: "registered" });

			const response = await lookup(relay, "relay_alice");
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			const resolvedA = parsedLink(await resolveIntranetUsername(relay.url, "relay_alice"));
			const resolvedB = parsedLink(await resolveIntranetUsername(relay.url, "relay_bob"));
			const guestA = await connect(resolvedA.roomId, "guest");
			guestA.socket.send(
				packEnvelope(
					0,
					await seal(await importRoomKey(resolvedA.key), { t: "prompt", text: "private alice prompt" }),
				),
			);
			expect(await hostA.encrypted(keyA)).toEqual({ t: "prompt", text: "private alice prompt" });

			// Send only after A was delivered: cross-room leakage would precede B's own frame.
			const guestB = await connect(resolvedB.roomId, "guest");
			guestB.socket.send(
				packEnvelope(
					0,
					await seal(await importRoomKey(resolvedB.key), { t: "prompt", text: "private bob prompt" }),
				),
			);
			expect(await hostB.encrypted(keyB)).toEqual({ t: "prompt", text: "private bob prompt" });
			guestA.socket.send(packEnvelope(0, await seal(keyA, { t: "prompt", text: "alice ordering barrier" })));
			expect(await hostA.encrypted(keyA)).toEqual({ t: "prompt", text: "alice ordering barrier" });
		});
	}, 10_000);

	it("registers over remote plain WS, looks up over HTTP, and routes guests without relaxing online link policy", async () => {
		const address = Object.values(os.networkInterfaces())
			.flat()
			.find(entry => entry?.family === "IPv4" && !entry.internal)?.address;
		if (!address) throw new Error("Remote WS regression requires a non-loopback IPv4 network interface.");
		await withRelay(async ({ relay, connect }) => {
			const roomA = generateRoomId();
			const roomB = generateRoomId();
			const rawKeyA = generateRoomKey();
			const rawKeyB = generateRoomKey();
			const keyA = await importRoomKey(rawKeyA);
			const keyB = await importRoomKey(rawKeyB);
			const hostA = await connect(roomA, "host");
			const hostB = await connect(roomB, "host");
			const linkA = formatCollabLink(relay.url, roomA, rawKeyA, generateWriteToken());
			const linkB = formatCollabLink(relay.url, roomB, rawKeyB, generateWriteToken());
			registration(hostA, "remote_alice", "alice-workstation", linkA);
			registration(hostB, "remote_bob", "bob-workstation", linkB);
			expect(await hostA.control()).toEqual({ t: "registered" });
			expect(await hostB.control()).toEqual({ t: "registered" });

			const httpOrigin = relay.url.replace(/^ws/, "http");
			const response = await lookup(relay, "remote_alice");
			expect(response.url).toBe(`${httpOrigin}/collab/users/remote_alice`);
			expect(response.status).toBe(200);
			const resolvedA = parsedLink(await resolveIntranetUsername(httpOrigin, "remote_alice"));
			const resolvedB = parsedLink(await resolveIntranetUsername(relay.url, "remote_bob"));
			const guestA = await connect(resolvedA.roomId, "guest", resolvedA.wsUrl);
			guestA.socket.send(
				packEnvelope(
					0,
					await seal(await importRoomKey(resolvedA.key), { t: "prompt", text: "remote alice prompt" }),
				),
			);
			expect(await hostA.encrypted(keyA)).toEqual({ t: "prompt", text: "remote alice prompt" });
			const guestB = await connect(resolvedB.roomId, "guest", resolvedB.wsUrl);
			guestB.socket.send(
				packEnvelope(0, await seal(await importRoomKey(resolvedB.key), { t: "prompt", text: "remote bob prompt" })),
			);
			expect(await hostB.encrypted(keyB)).toEqual({ t: "prompt", text: "remote bob prompt" });
			guestA.socket.send(packEnvelope(0, await seal(keyA, { t: "prompt", text: "remote ordering barrier" })));
			expect(await hostA.encrypted(keyA)).toEqual({ t: "prompt", text: "remote ordering barrier" });

			delete process.env.OMP_OFFLINE;
			const error = "relay link must be wss:// (plain ws:// is only allowed for localhost)";
			expect(parseCollabLink(linkA)).toEqual({ error });
			expect(() => formatCollabLink(relay.url, roomA, rawKeyA)).toThrow(error);
			expect(() => formatCollabLink(httpOrigin, roomA, rawKeyA)).toThrow(error);
		}, address);
	}, 10_000);

	it("admits one competing host, preserves that host on conflict, and releases its username on disconnect", async () => {
		await withRelay(async ({ relay, connect }) => {
			const contenders = await Promise.all(
				["first-host", "second-host"].map(async hostname => {
					const roomId = generateRoomId();
					const rawKey = generateRoomKey();
					return {
						hostname,
						roomId,
						key: await importRoomKey(rawKey),
						link: formatCollabLink(relay.url, roomId, rawKey, generateWriteToken()),
						peer: await connect(roomId, "host"),
					};
				}),
			);
			for (const contender of contenders)
				registration(contender.peer, "relay_owner", contender.hostname, contender.link);
			const replies = await Promise.all(contenders.map(contender => contender.peer.control()));
			const winnerIndex = replies.findIndex(
				reply => typeof reply === "object" && reply !== null && "t" in reply && reply.t === "registered",
			);
			expect(winnerIndex).toBeGreaterThanOrEqual(0);
			const winner = contenders[winnerIndex]!;
			const loserIndex = 1 - winnerIndex;
			const loser = contenders[loserIndex]!;
			expect(replies[winnerIndex]).toEqual({ t: "registered" });
			expect(replies[loserIndex]).toEqual({
				t: "registration-error",
				message: expect.stringContaining(winner.hostname),
			});
			expect(replies[loserIndex]).toMatchObject({ message: expect.stringContaining("/join relay_owner") });
			expect((await loser.peer.closed.take()).code).toBe(4010);
			expect(await resolveIntranetUsername(relay.url, "relay_owner")).toBe(winner.link);

			const guest = await connect(winner.roomId, "guest");
			guest.socket.send(
				packEnvelope(0, await seal(winner.key, { t: "prompt", text: "original host remains usable" })),
			);
			expect(await winner.peer.encrypted(winner.key)).toEqual({ t: "prompt", text: "original host remains usable" });
			winner.peer.socket.close();
			await winner.peer.closed.take();
			const missing = await lookup(relay, "relay_owner");
			expect(missing.status).toBe(404);
			await expect(resolveIntranetUsername(relay.url, "relay_owner")).rejects.toThrow(/offline|not sharing/i);

			const replacementRoom = generateRoomId();
			const replacement = await connect(replacementRoom, "host");
			const replacementLink = formatCollabLink(relay.url, replacementRoom, generateRoomKey(), generateWriteToken());
			registration(replacement, "relay_owner", "replacement-host", replacementLink);
			expect(await replacement.control()).toEqual({ t: "registered" });
			expect(await resolveIntranetUsername(relay.url, "relay_owner")).toBe(replacementLink);
		});
	}, 10_000);

	it("does not upgrade a published view-only capability during username lookup", async () => {
		await withRelay(async ({ relay, connect }) => {
			const roomId = generateRoomId();
			const rawKey = generateRoomKey();
			const host = await connect(roomId, "host");
			registration(host, "relay_viewer", "view-host", formatCollabLink(relay.url, roomId, rawKey));
			expect(await host.control()).toEqual({ t: "registered" });

			const response = await lookup(relay, "relay_viewer");
			expect(response.status).toBe(200);
			const resolved = parsedLink(await resolveIntranetUsername(relay.url, "relay_viewer"));
			expect(resolved.writeToken).toBeUndefined();
			const viewer = await connect(resolved.roomId, "guest");
			viewer.socket.send(
				packEnvelope(
					0,
					await seal(await importRoomKey(resolved.key), { t: "hello", proto: COLLAB_PROTO, name: "viewer" }),
				),
			);
			expect(await host.encrypted(await importRoomKey(rawKey))).toEqual({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "viewer",
			});
		});
	}, 10_000);

	it("rejects relay startup and username resolution outside offline mode before contacting an endpoint", async () => {
		let requests = 0;
		const endpoint = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return Response.json({ link: "must not be requested" });
			},
		});
		try {
			delete process.env.OMP_OFFLINE;
			expect(() => {
				const unexpectedRelay = startIntranetRelay({ port: 0 });
				unexpectedRelay.stop();
			}).toThrow(/OMP_OFFLINE/);
			await expect(
				resolveIntranetUsername(endpoint.url.origin.replace(/^http/, "ws"), "relay_owner"),
			).rejects.toThrow(/OMP_OFFLINE/);
			expect(requests).toBe(0);
		} finally {
			endpoint.stop(true);
		}
	});
});
