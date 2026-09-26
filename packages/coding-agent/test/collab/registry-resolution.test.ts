import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostPublication,
	type CollabHostRegistrySource,
	type CollabHostSnapshot,
	listCollabHosts,
	publishCollabHost,
	resolveCollabHostLink,
} from "@oh-my-pi/pi-coding-agent/collab/registry";

const cleanupDirs: string[] = [];
const openPublications: CollabHostPublication[] = [];
const openServers: { server: net.Server; sockets: Set<net.Socket> }[] = [];

afterEach(async () => {
	for (const pub of openPublications.splice(0)) {
		try {
			await pub.close();
		} catch {
			// best-effort
		}
	}
	for (const { server, sockets } of openServers.splice(0)) {
		// Hung fixture sockets must not keep server.close() waiting forever.
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
	for (const dir of cleanupDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-registry-"));
	cleanupDirs.push(dir);
	return dir;
}

interface Fixture {
	snapshot: CollabHostSnapshot;
	roomKey: string;
	writeToken: string;
	controlUrl: string;
	viewUrl: string;
}

function makeFixture(over: Partial<CollabHostSnapshot> = {}): Fixture {
	const roomKey = `ROOMKEY-${crypto.randomBytes(6).toString("hex")}`;
	const writeToken = `WRITETOKEN-${crypto.randomBytes(6).toString("hex")}`;
	return {
		snapshot: {
			instanceId: crypto.randomBytes(8).toString("hex"),
			generation: 1,
			sessionId: `sess-${crypto.randomBytes(4).toString("hex")}`,
			sessionName: "Fixture Session",
			cwd: "/tmp/fixture-cwd",
			pid: process.pid,
			model: { provider: "test", id: "fixture-model" },
			startedAt: 1_700_000_000_000,
			participants: 3,
			relayConnected: true,
			inputRequired: false,
			busy: false,
			access: "control",
			...over,
		},
		roomKey,
		writeToken,
		controlUrl: `https://collab.example/control/#room=${roomKey}&k=${writeToken}`,
		viewUrl: `https://collab.example/view/#room=${roomKey}`,
	};
}

function sourceFor(f: Fixture): CollabHostRegistrySource {
	return {
		snapshot: () => f.snapshot,
		link: access => (access === "view" ? f.viewUrl : f.snapshot.access === "control" ? f.controlUrl : null),
	};
}

async function publish(dir: string, f: Fixture): Promise<CollabHostPublication> {
	const pub = await publishCollabHost(sourceFor(f), { dir, instanceId: f.snapshot.instanceId });
	openPublications.push(pub);
	return pub;
}

/** Reads the discovery token from the single metadata file in `dir`. */
async function readSoleToken(dir: string): Promise<string> {
	const names = (await fs.readdir(dir)).filter(n => n.endsWith(".json"));
	expect(names).toHaveLength(1);
	const [name] = names;
	if (!name) throw new Error("published registry metadata is missing");
	const meta = await Bun.file(path.join(dir, name)).json();
	return meta.token as string;
}

/** Connects to `endpoint`, sends one JSON request line, returns the raw response line. */
function rawRequest(endpoint: string, request: object): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let buffer = "";
	const socket = net.createConnection({ path: endpoint });
	const done = (fn: () => void): void => {
		socket.destroy();
		fn();
	};
	socket.setEncoding("utf8");
	socket.once("error", err => done(() => reject(err)));
	socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	socket.on("data", chunk => {
		buffer += chunk;
		const nl = buffer.indexOf("\n");
		if (nl >= 0) done(() => resolve(buffer.slice(0, nl)));
	});
	return promise;
}

describe("collab registry", () => {
	it("lists metadata without capabilities and resolves only the requested access by instance ID", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);

		const hosts = await listCollabHosts({ dir });
		expect(hosts.map(host => host.instanceId)).toEqual([f.snapshot.instanceId]);
		expect(hosts[0]).not.toHaveProperty("url");
		expect(JSON.stringify(hosts)).not.toContain(f.roomKey);
		expect(JSON.stringify(hosts)).not.toContain(f.writeToken);

		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toEqual({
			instanceId: f.snapshot.instanceId,
			generation: f.snapshot.generation,
			access: "control",
			url: f.controlUrl,
		});
		const view = await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir });
		expect(view).toEqual({
			instanceId: f.snapshot.instanceId,
			generation: f.snapshot.generation,
			access: "view",
			url: f.viewUrl,
		});
		expect(JSON.stringify(view)).not.toContain(f.controlUrl);
		expect(JSON.stringify(view)).not.toContain(f.writeToken);
	});

	it("returns only the requested URL on the link wire, never the control capability to a view request", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const request = { v: COLLAB_REGISTRY_VERSION, token: await readSoleToken(dir), op: "link", generation: 1 };

		const control = await rawRequest(pub.endpoint, { ...request, access: "control" });
		expect(JSON.parse(control)).toEqual({ ok: true, v: COLLAB_REGISTRY_VERSION, url: f.controlUrl });
		const view = await rawRequest(pub.endpoint, { ...request, access: "view" });
		expect(JSON.parse(view)).toEqual({ ok: true, v: COLLAB_REGISTRY_VERSION, url: f.viewUrl });
		expect(view).not.toContain(f.controlUrl);
		expect(view).not.toContain(f.writeToken);
	});

	it("refuses control access to a view-only host through resolution and the wire", async () => {
		const dir = await tempDir();
		const f = makeFixture({ access: "view" });
		const pub = await publish(dir, f);

		await expect(resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "access_unavailable",
		});
		const line = await rawRequest(pub.endpoint, {
			v: COLLAB_REGISTRY_VERSION,
			token: await readSoleToken(dir),
			op: "link",
			access: "control",
			generation: f.snapshot.generation,
		});
		expect(JSON.parse(line)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "access_unavailable" });
		expect(await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir })).toMatchObject({
			access: "view",
			url: f.viewUrl,
		});
	});

	it("rejects a listed generation after the room rotates without returning its successor's URL", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const [listed] = await listCollabHosts({ dir });
		if (!listed) throw new Error("published host was not discoverable");
		f.snapshot.generation++;

		const line = await rawRequest(pub.endpoint, {
			v: COLLAB_REGISTRY_VERSION,
			token: await readSoleToken(dir),
			op: "link",
			access: "control",
			generation: listed.generation,
		});
		expect(JSON.parse(line)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "stale_generation" });
	});

	it("surfaces stale_generation when the host rotates between resolution's snapshot and link requests", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const source = sourceFor(f);
		let rotate = false;
		source.snapshot = () => {
			const snapshot = { ...f.snapshot };
			if (rotate) {
				f.snapshot.generation++;
				rotate = false;
			}
			return snapshot;
		};
		openPublications.push(await publishCollabHost(source, { dir, instanceId: f.snapshot.instanceId }));
		await listCollabHosts({ dir });
		rotate = true;

		await expect(resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "stale_generation",
		});
	});
});
