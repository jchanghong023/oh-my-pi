import { describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { acquireBrowser, getBrowsersMapForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TernFrameReader } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { frame, jsonPayload } from "../tools/tern-fake-daemon";

/** An isolated native protocol peer: open blocks survive failed close replies. */
async function nativeBrowserFixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webgui-browser-release-"));
	const socketPath =
		process.platform === "win32"
			? `\\\\.\\pipe\\webgui-browser-${randomUUID()}`
			: path.join(directory, "browser.sock");
	const sockets = new Set<net.Socket>();
	const open = new Set<number>();
	const closeAttempts = new Map<number, number>();
	const loaded = new Set<number>();
	const held = Promise.withResolvers<{ socket: net.Socket; id: number; block: number }>();
	let nextBlock = 0;
	let holdNextClose = false;
	const send = (socket: net.Socket, message: unknown) => socket.write(frame(jsonPayload(message)));
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		const reader = new TernFrameReader();
		socket.on("data", bytes => {
			if (typeof bytes === "string") throw new Error("Native browser frames must remain binary");
			for (const payload of reader.push(bytes)) {
				const message = JSON.parse(new TextDecoder().decode(payload));
				if (message.hello !== undefined) {
					send(socket, { welcome: { version: 99 } });
					continue;
				}
				const { id, browser: op } = message;
				const block = Number(op.block);
				let value: unknown = {};
				switch (op.op) {
					case "open":
						open.add(++nextBlock);
						value = { block: nextBlock, url: "about:blank" };
						break;
					case "state":
						value = { url: "about:blank", title: "Owned browser", loading: false, width: 800, height: 600 };
						break;
					case "events":
						value = loaded.has(block)
							? { events: [], next: 2, dropped: 0 }
							: {
									events: [
										{ seq: 1, type: "committed", url: "about:blank" },
										{ seq: 2, type: "loaded", url: "about:blank" },
									],
									next: 2,
									dropped: 0,
								};
						loaded.add(block);
						break;
					case "close":
						closeAttempts.set(block, (closeAttempts.get(block) ?? 0) + 1);
						if (holdNextClose) {
							holdNextClose = false;
							held.resolve({ socket, id, block });
							continue;
						}
						open.delete(block);
						break;
				}
				send(socket, { id, browser: { ok: value } });
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, listening.resolve);
	await listening.promise;
	return {
		socketPath,
		open,
		closeAttempts,
		holdNextClose() {
			holdNextClose = true;
		},
		heldClose: held.promise,
		rejectClose(request: { socket: net.Socket; id: number }) {
			send(request.socket, {
				id: request.id,
				browser: { error: { kind: "busy", message: "native close temporarily rejected" } },
			});
		},
		async dispose() {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

describe("WebGUI strict native browser release", () => {
	it("upgrades a pending ordinary close, retains failed ownership, and retries the exact tab after replacement", async () => {
		const fixture = await nativeBrowserFixture();
		const owner = randomUUID();
		const siblingOwner = randomUUID();
		const replacementOwner = randomUUID();
		const name = `native-owned-${randomUUID()}`;
		try {
			const browser = await acquireBrowser(
				{ kind: "tern", socketPath: fixture.socketPath, pane: 3 },
				{ cwd: os.tmpdir() },
			);
			const owned = (await acquireTab(name, browser, { timeoutMs: 5_000, ownerSessionId: owner })).tab;
			const sibling = (
				await acquireTab(`${name}-sibling`, browser, { timeoutMs: 5_000, ownerSessionId: siblingOwner })
			).tab;
			fixture.holdNextClose();
			const ordinary = releaseTab(name).then(
				() => undefined,
				error => error,
			);
			const request = await fixture.heldClose;
			const strict = releaseTabsForOwner(owner, { strict: true, kill: true }).then(
				() => undefined,
				error => error,
			);
			fixture.rejectClose(request);
			expect(await ordinary).toBeInstanceOf(Error);
			expect(await strict).toBeInstanceOf(AggregateError);
			expect(fixture.open.has(Number(owned.targetId))).toBe(true);
			expect(getTabsMapForTest().get(name)).toBe(owned);
			expect(browser.refCount).toBe(2);
			expect(getBrowsersMapForTest().get(browser.key)).toBe(browser);

			const replacement = (
				await acquireTab(`${name}-replacement`, browser, { timeoutMs: 5_000, ownerSessionId: replacementOwner })
			).tab;
			// Model the publication race at the exact registry boundary, with a separately acquired real tab.
			getTabsMapForTest().delete(replacement.name);
			replacement.name = name;
			getTabsMapForTest().set(name, replacement);
			expect(await releaseTabsForOwner(owner, { strict: true, kill: true })).toBe(1);
			expect(fixture.open.has(Number(owned.targetId))).toBe(false);
			expect(fixture.closeAttempts.get(Number(owned.targetId))).toBe(2);
			expect(getTabsMapForTest().get(name)).toBe(replacement);
			expect(fixture.open.has(Number(replacement.targetId))).toBe(true);
			expect(fixture.open.has(Number(sibling.targetId))).toBe(true);
			expect(browser.refCount).toBe(2);
			expect(await releaseTabsForOwner(owner, { strict: true })).toBe(0);
		} finally {
			await releaseTabsForOwner(owner, { strict: true });
			await releaseTabsForOwner(replacementOwner, { strict: true });
			await releaseTabsForOwner(siblingOwner, { strict: true });
			await fixture.dispose();
		}
	});

	it("retries failed native connection cleanup without closing an already-closed page or dropping the last hold twice", async () => {
		const fixture = await nativeBrowserFixture();
		const owner = randomUUID();
		let restore: (() => void) | undefined;
		try {
			const browser = await acquireBrowser(
				{ kind: "tern", socketPath: fixture.socketPath, pane: 4 },
				{ cwd: os.tmpdir() },
			);
			if (!("tern" in browser)) throw new Error("Expected a Tern native connection");
			const owned = (
				await acquireTab(`native-transport-${owner}`, browser, { timeoutMs: 5_000, ownerSessionId: owner })
			).tab;
			const close = browser.tern.close.bind(browser.tern);
			let failOnce = true;
			const controlledClose = spyOn(browser.tern, "close").mockImplementation(() => {
				if (failOnce) {
					failOnce = false;
					throw new Error("native transport cleanup rejected");
				}
				close();
			});
			restore = () => controlledClose.mockRestore();
			let cleanupError: unknown;
			try {
				await releaseTabsForOwner(owner, { strict: true });
			} catch (error) {
				cleanupError = error;
			}
			expect(cleanupError).toBeInstanceOf(AggregateError);
			expect(cleanupError).toMatchObject({ errors: [{ message: "native transport cleanup rejected" }] });
			expect(controlledClose).toHaveBeenCalledTimes(1);
			expect(fixture.open.has(Number(owned.targetId))).toBe(false);
			expect(fixture.closeAttempts.get(Number(owned.targetId))).toBe(1);
			expect(browser.refCount).toBe(1);
			expect(browser.tern.connected).toBe(true);
			expect(getTabsMapForTest().get(owned.name)).toBe(owned);
			expect(getBrowsersMapForTest().get(browser.key)).toBe(browser);
			expect(await releaseTabsForOwner(owner, { strict: true })).toBe(1);
			expect(controlledClose).toHaveBeenCalledTimes(2);
			expect(fixture.closeAttempts.get(Number(owned.targetId))).toBe(1);
			expect(browser.refCount).toBe(0);
			expect(browser.tern.connected).toBe(false);
			expect(getTabsMapForTest().has(owned.name)).toBe(false);
			expect(getBrowsersMapForTest().has(browser.key)).toBe(false);
		} finally {
			restore?.();
			await releaseTabsForOwner(owner, { strict: true });
			await fixture.dispose();
		}
	});
});
