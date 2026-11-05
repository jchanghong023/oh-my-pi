import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Process } from "@oh-my-pi/pi-natives";
import { type ChildProcess, spawn } from "@oh-my-pi/pi-utils/ptree";

// Ignores SIGTERM, so only an escalation to SIGKILL ends it.
const STUBBORN_CHILD = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';

describe("ptree kill without a usable native process handle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.skipIf(process.platform === "win32").each([
		[
			"the handle lookup throws",
			() => {
				throw new Error("Value is not an instance of class `Process`");
			},
		],
		[
			"native termination rejects",
			() => ({ terminate: () => Promise.reject(new Error("terminate failed")) }) as unknown as Process,
		],
	])("still ends a SIGTERM-ignoring child when %s", async (_name, fromPid) => {
		const child = spawn([process.execPath, "-e", STUBBORN_CHILD]);
		const reader = child.stdout.getReader();
		await reader.read(); // "ready": the SIGTERM handler is installed
		reader.releaseLock();
		spyOn(Process, "fromPid").mockImplementation(fromPid);

		child.kill(undefined, 50);

		// A kill that never signals the child leaves `exited` pending until the test times out.
		await child.exited;
		expect(child.proc.signalCode).toBe("SIGKILL");
	});

	it.skipIf(process.platform === "win32")("falls back to the child when the group signal fails", async () => {
		const child = spawn([process.execPath, "-e", STUBBORN_CHILD], { detached: true });
		const reader = child.stdout.getReader();
		await reader.read();
		reader.releaseLock();
		spyOn(Process, "fromPid").mockReturnValue(null);
		const kill = process.kill.bind(process);
		const groupKill = spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === -child.pid) throw new Error("group unavailable");
			return kill(pid, signal);
		});

		child.kill(undefined, 50);
		await child.exited;
		expect(groupKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
		expect(child.proc.signalCode).toBe("SIGKILL");
	});
});

it.skipIf(process.platform === "win32")(
	"does not signal group members twice or hit TERM cleanup children",
	async () => {
		const script = `
		let terms = 0;
		process.on("SIGTERM", () => {
			console.log("root-term", ++terms);
			if (terms !== 1) return;
			Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
				process.on("SIGTERM", () => console.log("cleanup-term"));
				setTimeout(() => { console.log("cleanup-ok"); process.exit(0); }, 200);
			`)}], { stdout: "inherit", stderr: "inherit" });
			setTimeout(() => process.exit(0), 400);
		});
		console.log("ready");
		setInterval(() => {}, 1000);
	`;
		const child = spawn([process.execPath, "-e", script], { detached: true });
		const reader = child.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain("ready");
		reader.releaseLock();

		child.kill(undefined, 1000);
		const output = await new Response(child.stdout).text();
		await child.exited;
		expect(output).toContain("root-term 1");
		expect(output).not.toContain("root-term 2");
		expect(output).toContain("cleanup-ok");
		expect(output).not.toContain("cleanup-term");
	},
);

describe.skipIf(process.platform !== "linux")("ptree subreaper kill without a usable native process handle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Exits on its own, so a command the fallback cannot reach ends without a leak.
	const SHORT_CHILD = 'console.log("ready"); setTimeout(() => {}, 2000);';

	it.each([
		[
			"the handle lookup throws",
			() => {
				throw new Error("Value is not an instance of class `Process`");
			},
		],
		[
			"the handle cannot list its children",
			() =>
				({
					children: () => {
						throw new Error("Value is not an instance of class `Process`");
					},
				}) as unknown as Process,
		],
	])("signals the subreaper directly when %s", async (_name, fromPid) => {
		for (const [stop, signalCode] of [
			[(child: ChildProcess) => child.kill(undefined, 50), "SIGTERM"],
			[(child: ChildProcess) => child.kill(undefined, -1), "SIGKILL"],
			[(child: ChildProcess) => child[Symbol.dispose](), "SIGTERM"],
		] as const) {
			const child = spawn([process.execPath, "-e", SHORT_CHILD], { subreaper: true });
			const reader = child.stdout.getReader();
			await reader.read(); // "ready": the subreaper has launched the command
			reader.releaseLock();
			const lookup = spyOn(Process, "fromPid").mockImplementation(fromPid);

			// The stop must neither throw nor report success without signalling:
			// a kill that never signals leaves `exited` pending until the test times out.
			stop(child);
			await child.exited.catch(() => {});
			lookup.mockRestore();
			expect(child.proc.signalCode).toBe(signalCode);
		}
	});

	it("never leaves the subreaper or its command stopped when the stop fails while they are frozen", async () => {
		// The first children() read reports nothing, so the stop freezes the tree and
		// reads again; that read throws. The resume must still run, so the fallback's
		// SIGTERM ends the subreaper (a stopped one would only die at the SIGKILL)
		// and the command is not left stopped for ever.
		for (const [gracefulMs, signalCode] of [
			[50, "SIGTERM"],
			[-1, "SIGKILL"],
		] as const) {
			const child = spawn([process.execPath, "-e", SHORT_CHILD], { subreaper: true });
			const reader = child.stdout.getReader();
			await reader.read(); // "ready": the subreaper has launched the command
			reader.releaseLock();
			const root = Process.fromPid(child.pid);
			const command = root?.children()[0];
			if (!root || !command) throw new Error("failed to capture the subreaper process tree");
			try {
				let reads = 0;
				const failingSecondRead = {
					children: (): Process[] => {
						if (++reads === 1) return [];
						throw new Error("Value is not an instance of class `Process`");
					},
					killTree: (signal?: number) => root.killTree(signal),
				} as unknown as Process;
				const lookup = spyOn(Process, "fromPid").mockImplementation(pid =>
					pid === child.pid ? failingSecondRead : null,
				);

				child.kill(undefined, gracefulMs);
				await child.exited.catch(() => {});
				lookup.mockRestore();

				expect(reads).toBe(2);
				expect(child.proc.signalCode).toBe(signalCode);
				// procfs reports size 0, so read it with readFile rather than a sized Bun.file read.
				const state = (await fs.readFile(`/proc/${command.pid}/stat`, "utf8")).split(") ")[1]?.[0];
				expect(state, `command ${command.pid} left stopped`).not.toBe("T");
			} finally {
				command.killTree(9);
			}
		}
	});
});
