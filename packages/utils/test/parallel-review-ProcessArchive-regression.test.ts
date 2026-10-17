import { expect, test, vi } from "bun:test";
import { Process } from "@oh-my-pi/pi-natives";
import type { Subprocess } from "bun";
import { AbortError, ChildProcess } from "../src/ptree";

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
