import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { extractArchive } from "../src/ar/open";
import { AbortError, ChildProcess } from "../src/ptree";
import { arFixture } from "./ar/fixtures";

test("aborting after root exit closes inherited stdout without rediscovering the dead PID", async () => {
	vi.useFakeTimers();
	const nativeFromPid = Process.fromPid.bind(Process);
	const fromPid = vi.spyOn(Process, "fromPid").mockImplementation(pid => (pid === -1 ? null : nativeFromPid(pid)));
	const controller = new AbortController();
	const proc = {
		pid: -1,
		exitCode: 0,
		killed: false,
		exited: Promise.resolve(0),
		stdout: new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue(new TextEncoder().encode("partial output"));
			},
		}),
		stderr: new ReadableStream<Uint8Array>({ start: stream => stream.close() }),
	} as unknown as Subprocess<"ignore", "pipe", "pipe">;
	const deadline = Promise.withResolvers<symbol>();
	let timer: NodeJS.Timeout | undefined;
	try {
		using child = new ChildProcess(proc, false);
		fromPid.mockClear();
		child.attachSignal(controller.signal);
		const reader = child.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("partial output");
		const output = reader.read();
		await child.exited;
		controller.abort("cancelled after root exit");
		timer = setTimeout(() => deadline.resolve(Symbol("stdout stayed open")), 1_000);
		for (let flush = 0; flush < 32; flush++) await Promise.resolve();
		vi.advanceTimersByTime(1_000);
		expect(await Promise.race([output, deadline.promise])).toMatchObject({ done: true });
		expect(child.exitReason).toBeInstanceOf(AbortError);
		expect(fromPid).not.toHaveBeenCalled();
		reader.releaseLock();
	} finally {
		controller.abort("test cleanup");
		clearTimeout(timer);
		fromPid.mockRestore();
		vi.useRealTimers();
	}
});

test.skipIf(process.platform !== "win32")(
	"Windows symlink-copy fallback rejects an occupied destination without overwriting its bytes",
	async () => {
		using root = TempDir.createSync("@pi-archive-copy-collision-");
		const bytes = await arFixture("zip-symlink-mode.zip");
		const occupied = path.join(root.path(), "current");
		await Bun.write(occupied, "existing user content");
		const symlink = vi
			.spyOn(fs, "symlink")
			.mockRejectedValue(Object.assign(new Error("Symlink privilege denied"), { code: "EPERM" }));
		try {
			await expect(extractArchive({ bytes, format: "zip" }, root.path())).rejects.toMatchObject({ code: "EEXIST" });
			expect(await Bun.file(occupied).text()).toBe("existing user content");
		} finally {
			symlink.mockRestore();
		}
	},
);
