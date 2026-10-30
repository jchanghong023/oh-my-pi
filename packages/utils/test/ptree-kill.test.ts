import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Process } from "@oh-my-pi/pi-natives";
import { spawn } from "@oh-my-pi/pi-utils/ptree";

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
