import { expect, test, vi } from "bun:test";
import { Process } from "@oh-my-pi/pi-natives";
import type { Subprocess } from "bun";
import { BiomeClient } from "../src/lsp/clients/biome-client";
import type { ServerConfig } from "../src/lsp/types";

test("Biome abort settles when its exited wrapper leaves stdout open", async () => {
	vi.useFakeTimers();
	const waitingForOutput = Promise.withResolvers<void>();
	const nativeFromPid = Process.fromPid.bind(Process);
	const fromPid = vi.spyOn(Process, "fromPid").mockImplementation(pid => (pid === -1 ? null : nativeFromPid(pid)));
	const signalGroup = vi.spyOn(process, "kill").mockReturnValue(true);
	const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({
		pid: -1,
		exitCode: 0,
		killed: false,
		exited: Promise.resolve(0),
		stdout: new ReadableStream<Uint8Array>({ pull: () => waitingForOutput.resolve() }, { highWaterMark: 0 }),
		stderr: new ReadableStream<Uint8Array>({ start: stream => stream.close() }),
	} as unknown as Subprocess);
	const controller = new AbortController();
	const reason = new Error("cancelled lint");
	const config = {
		command: "biome",
		resolvedCommand: "biome",
	} as ServerConfig;
	const outcome = new BiomeClient(config, process.cwd()).lint("example.ts", controller.signal).then(
		() => undefined,
		error => error,
	);
	const deadline = Promise.withResolvers<symbol>();
	let timer: NodeJS.Timeout | undefined;
	try {
		await waitingForOutput.promise;
		controller.abort(reason);
		timer = setTimeout(() => deadline.resolve(Symbol("lint stayed pending")), 1_000);
		for (let flush = 0; flush < 32; flush++) await Promise.resolve();
		vi.advanceTimersByTime(1_000);
		expect(await Promise.race([outcome, deadline.promise])).toBe(reason);
	} finally {
		clearTimeout(timer);
		controller.abort("test cleanup");
		spawn.mockRestore();
		fromPid.mockRestore();
		signalGroup.mockRestore();
		vi.useRealTimers();
	}
});
