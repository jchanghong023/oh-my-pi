import { afterEach, describe, expect, it, vi } from "bun:test";
import { terminateOwnedSubprocess } from "../src/subprocess";

afterEach(() => {
	vi.restoreAllMocks();
});

function ownedChild(exitCode: number | null, exited: Promise<number> = Promise.resolve(137)) {
	const kill = vi.fn();
	const child = { pid: 12345, exitCode, exited, kill } as unknown as Bun.Subprocess;
	return { child, kill };
}

describe("native-free owned subprocess termination", () => {
	it("never targets a recycled PID or group after the child has exited", async () => {
		const { child, kill } = ownedChild(0, Promise.resolve(0));
		const spawn = vi.spyOn(Bun, "spawn");
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		await terminateOwnedSubprocess(child, { detached: true });
		expect(spawn).not.toHaveBeenCalled();
		expect(signal).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("kills only the owned root when it has no detached group", async () => {
		const { child, kill } = ownedChild(null);
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		await terminateOwnedSubprocess(child, { detached: false });
		expect(kill).toHaveBeenCalledWith("SIGKILL");
		expect(signal).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("kills the owned detached group and waits for root exit", async () => {
		const exited = Promise.withResolvers<number>();
		const { child, kill } = ownedChild(null, exited.promise);
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		let completed = false;
		const cleanup = terminateOwnedSubprocess(child, { detached: true }).then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(signal).toHaveBeenCalledWith(-child.pid, "SIGKILL");
		expect(kill).not.toHaveBeenCalled();
		expect(completed).toBe(false);
		exited.resolve(137);
		await cleanup;
		expect(completed).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"surfaces a group termination failure instead of claiming cleanup",
		async () => {
			const { child } = ownedChild(null);
			vi.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error("group permission denied"), { code: "EPERM" });
			});
			await expect(terminateOwnedSubprocess(child, { detached: true })).rejects.toThrow("group permission denied");
		},
	);

	it.skipIf(process.platform !== "win32")("targets the Windows child tree and surfaces taskkill failure", async () => {
		const { child } = ownedChild(null);
		const terminator = {
			exited: Promise.resolve(1),
			stderr: new Response("Access is denied").body,
		} as unknown as Bun.Subprocess;
		const spawn = vi.spyOn(Bun, "spawn").mockReturnValue(terminator);
		await expect(terminateOwnedSubprocess(child, { detached: false })).rejects.toThrow("Access is denied");
		expect(spawn).toHaveBeenCalledWith(
			["taskkill.exe", "/PID", String(child.pid), "/T", "/F"],
			expect.objectContaining({ stdin: "ignore", stdout: "ignore", stderr: "pipe" }),
		);
	});

	it("terminates a real owned child without depending on a native addon", async () => {
		const detached = process.platform !== "win32";
		const child = Bun.spawn(
			[process.execPath, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"],
			{
				detached,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		try {
			await terminateOwnedSubprocess(child, { detached });
			expect(await child.exited).not.toBe(0);
			expect(child.exitCode).not.toBeNull();
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
	});
});
