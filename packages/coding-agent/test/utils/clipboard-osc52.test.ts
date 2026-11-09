import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Buffer } from "node:buffer";
import { copyToClipboard, requestOfflineBrowserUrlCopy } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as natives from "@oh-my-pi/pi-natives/clipboard";
import { type ActiveTerminalHarness, startActiveTerminal } from "../helpers/active-terminal";
import { startSketchServer } from "../../src/sketch/server";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function osc52(text: string): string {
	return `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
}

/**
 * A copy's OSC 52 must not tear a TUI frame: while a terminal owns stdout it
 * takes the terminal's ordered write path, and it goes straight to stdout only
 * when no terminal owns it.
 */
describe("copyToClipboard OSC 52 routing", () => {
	let harness: ActiveTerminalHarness | undefined;
	let savedOffline: string | undefined;
	let savedSsh: string | undefined;

	beforeEach(() => {
		savedOffline = process.env.OMP_OFFLINE;
		savedSsh = process.env.SSH_CONNECTION;
		delete process.env.OMP_OFFLINE;
		// Linux keeps macOS runs off the real pbcopy; the native write is stubbed.
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {});
	});

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		if (savedOffline === undefined) delete process.env.OMP_OFFLINE;
		else process.env.OMP_OFFLINE = savedOffline;
		if (savedSsh === undefined) delete process.env.SSH_CONNECTION;
		else process.env.SSH_CONNECTION = savedSsh;
		vi.restoreAllMocks();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	});

	it.each([
		["linux", undefined],
		["win32", "1"],
	] as const)("does not overwrite the clipboard outside offline Linux (%s, %s)", (platform, offline) => {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		if (offline !== undefined) process.env.OMP_OFFLINE = offline;
		harness = startActiveTerminal();

		expect(requestOfflineBrowserUrlCopy("http://127.0.0.1:1234/private/")).toBe(false);
		expect(harness.routed).toEqual([]);
		expect(natives.copyToClipboard).not.toHaveBeenCalled();
	});

	it("copies a usable complete capability URL over SSH even when the native clipboard fails", async () => {
		process.env.OMP_OFFLINE = " TRUE ";
		process.env.SSH_CONNECTION = "10.0.0.2 50000 10.0.0.1 22";
		vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {
			throw new Error("X11 clipboard unavailable");
		});
		harness = startActiveTerminal();
		const server = startSketchServer();
		try {
			expect(requestOfflineBrowserUrlCopy(server.url)).toBe(true);
			const payload = /^\x1b\]52;c;([A-Za-z0-9+/=]+)\x07$/.exec(harness.routed[0] ?? "")?.[1];
			if (!payload) throw new Error("No terminal clipboard payload");
			const pasted = Buffer.from(payload, "base64").toString("utf8");
			expect(new URL(pasted).hostname).toBe("127.0.0.1");
			const response = await fetch(pasted);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/html");
			await response.arrayBuffer();
		} finally {
			server.close();
		}
	});

	it("writes OSC 52 through the active terminal, never straight to stdout", async () => {
		harness = startActiveTerminal();

		await copyToClipboard("probe");

		expect(harness.routed).toEqual([osc52("probe")]);
		expect(harness.direct.join("")).not.toContain("\x1b]52;");
	});

	it("writes OSC 52 straight to stdout once the terminal has stopped", async () => {
		harness = startActiveTerminal();
		harness.stop();

		await copyToClipboard("probe");

		expect(harness.direct).toEqual([osc52("probe")]);
		expect(harness.routed).toEqual([]);
	});

	// The computer tool copies from a Bun Worker, which has no route to the
	// main thread's terminal; its OSC 52 would hit fd 1 around the pump.
	it("skips OSC 52 in a worker thread and still makes the native copy", async () => {
		const worker = new Worker(new URL("../fixtures/clipboard-worker-copy.ts", import.meta.url).href, {
			type: "module",
		});
		const report = Promise.withResolvers<{ stdout: string[]; nativeCopies: string[] }>();
		worker.addEventListener("message", event => report.resolve(event.data));
		worker.addEventListener("error", event => report.reject(event.error ?? new Error(event.message)));
		try {
			const { stdout, nativeCopies } = await report.promise;
			expect(stdout.join("")).not.toContain("\x1b]52;");
			expect(nativeCopies).toEqual(["worker probe"]);
		} finally {
			worker.terminate();
		}
	});
});
