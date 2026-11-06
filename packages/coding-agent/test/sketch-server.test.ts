import { afterEach, describe, expect, it } from "bun:test";
import { MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-tui/chat/image-loading";
import { type SketchServer, startSketchServer } from "../src/sketch/server";
import { encodeRawPng } from "../src/utils/png-encode";

const PNG = encodeRawPng(Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255), 2, 1, 4);
const servers: SketchServer[] = [];

function start(): SketchServer {
	const server = startSketchServer();
	servers.push(server);
	return server;
}

function post(server: SketchServer, action: string, body = "", origin = new URL(server.url).origin): Promise<Response> {
	return fetch(`${server.url}${action}`, {
		method: "POST",
		headers: { origin, "content-type": "text/plain", connection: "close" },
		body,
	});
}

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

describe("native sketch server", () => {
	it("listens immediately and delivers the exact PNG without losing its HTTP acknowledgement", async () => {
		const server = start();
		const url = new URL(server.url);
		expect(url.protocol).toBe("http:");
		expect(url.hostname).toBe("127.0.0.1");
		expect(Number(url.port)).toBeGreaterThan(0);
		const page = await fetch(server.url);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(page.headers.get("access-control-allow-origin")).toBeNull();
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		await page.arrayBuffer();

		// The TUI consumer closes immediately when result resolves. That must
		// never abort the browser's still-pending success response.
		const result = server.result.then(value => {
			server.close();
			return value;
		});
		const response = await post(server, "submit", PNG.toString("base64"));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
		expect(await result).toEqual(PNG);
		await expect(fetch(server.url)).rejects.toThrow();
	});

	it("acknowledges browser cancellation and stops the listener", async () => {
		const server = start();
		const result = server.result.then(value => {
			server.close();
			return value;
		});
		const response = await post(server, "cancel");
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
		expect(await result).toBeNull();
		await expect(fetch(server.url)).rejects.toThrow();
	});

	it("settles and stops on terminal close, idempotently", async () => {
		const server = start();
		server.close();
		server.close();
		expect(await server.result).toBeNull();
		await expect(fetch(server.url)).rejects.toThrow();
	});

	it("rejects missing/wrong capabilities and foreign origins without ending the session", async () => {
		const server = start();
		const origin = new URL(server.url).origin;
		let settled = false;
		void server.result.then(() => {
			settled = true;
		});
		for (const pathname of ["/", "/submit", `/sketch/${crypto.randomUUID()}/submit`]) {
			const response = await fetch(`${origin}${pathname}`, {
				method: "POST",
				headers: { origin },
				body: PNG.toString("base64"),
			});
			expect(response.status).toBe(404);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
			await response.arrayBuffer();
			expect(settled).toBe(false);
		}
		for (const foreignOrigin of ["https://example.com", "null", "http://127.0.0.1:1"]) {
			const response = await post(server, "submit", PNG.toString("base64"), foreignOrigin);
			expect(response.status).toBe(403);
			await response.arrayBuffer();
			expect(settled).toBe(false);
		}
		const foreignCancel = await post(server, "cancel", "", "https://example.com");
		expect(foreignCancel.status).toBe(403);
		await foreignCancel.arrayBuffer();
		expect(settled).toBe(false);
		const preflight = await fetch(`${server.url}submit`, { method: "OPTIONS", headers: { origin } });
		expect(preflight.status).toBe(405);
		expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
		await preflight.arrayBuffer();
		const valid = await post(server, "submit", PNG.toString("base64"));
		expect(valid.status).toBe(200);
		await valid.arrayBuffer();
		expect(await server.result).toEqual(PNG);
	});

	it("rejects malformed base64, non-PNG and undecodable PNG, then accepts a valid drawing", async () => {
		const server = start();
		const invalidBodies = [
			"",
			"not base64!",
			`data:image/png;base64,${PNG.toString("base64")}`,
			"R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
			PNG.subarray(0, 40).toString("base64"),
		];
		let settled = false;
		void server.result.then(() => {
			settled = true;
		});
		for (const body of invalidBodies) {
			const response = await post(server, "submit", body);
			expect(response.status).toBe(400);
			await response.arrayBuffer();
			expect(settled).toBe(false);
		}
		const valid = await post(server, "submit", PNG.toString("base64"));
		expect(valid.status).toBe(200);
		await valid.arrayBuffer();
		expect(await server.result).toEqual(PNG);
	});

	it("bounds both encoded HTTP bodies and decoded bytes without settling the session", async () => {
		const server = start();
		let settled = false;
		void server.result.then(() => {
			settled = true;
		});
		// MAX_IMAGE_INPUT_BYTES + 1 still fits the ceiling's last base64 group.
		const decodedTooLarge = Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1).toString("base64");
		const decodedResponse = await post(server, "submit", decodedTooLarge);
		expect(decodedResponse.status).toBe(413);
		await decodedResponse.arrayBuffer();
		expect(settled).toBe(false);
		const encodedTooLarge = "A".repeat(4 * Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) + 4);
		// Bun can reject oversized requests before the handler runs by resetting
		// the connection instead of returning its 413 response.
		const encodedResponse = await post(server, "submit", encodedTooLarge).catch(() => null);
		if (encodedResponse !== null) {
			expect(encodedResponse.status).toBe(413);
			await encodedResponse.arrayBuffer();
		}
		expect(settled).toBe(false);
		const valid = await post(server, "submit", PNG.toString("base64"));
		expect(valid.status).toBe(200);
		await valid.arrayBuffer();
		expect(await server.result).toEqual(PNG);
	});
});
