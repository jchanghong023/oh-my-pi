import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { terminateOwnedSubprocess } from "../packages/utils/src/subprocess";
import { ownGateProcess } from "./test-gate-process";

// Real subprocess IPC, file barriers and /proc reaping cannot be advanced by
// this test runner's fake clock. Polls await observed state; timers only bound
// a broken lifecycle, never stand in for command or cleanup completion.
let directory: string;
let fixture: string;
beforeAll(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gate-process-test-"));
	fixture = path.join(directory, "fixture.ts");
	await fs.writeFile(
		fixture,
		`
import * as fs from "node:fs/promises";
const [role, prefix] = process.argv.slice(2);
const wait = async file => { while (!(await Bun.file(file).exists())) await Bun.sleep(5); };
if (role === "worker") {
  await fs.writeFile(prefix + ".worker", String(process.pid));
  await wait(prefix + ".worker-release");
  process.exit(0);
}
Bun.spawn([process.execPath, import.meta.path, "worker", prefix], {detached:true,stdin:"ignore",stdout:"ignore",stderr:"ignore"});
await wait(prefix + ".worker");
await fs.writeFile(prefix + ".command", String(process.pid));
await wait(prefix + ".command-release");
process.exit(23);
`,
	);
});
afterAll(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

async function within<T>(pending: Promise<T>): Promise<T> {
	let timer: Timer | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Owned supervisor lifecycle did not settle")), 5000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function readPid(file: string): Promise<number> {
	for (;;) {
		try {
			return Number(await fs.readFile(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await Bun.sleep(5);
	}
}
function supervisor(prefix: string) {
	const ready = Promise.withResolvers<void>();
	const outcome = Promise.withResolvers<number>();
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test-gate-supervisor.ts")], {
		env: {
			...process.env,
			OMP_GATE_SUPERVISED_COMMAND: JSON.stringify([process.execPath, fixture, "command", prefix]),
		},
		detached: true,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		ipc(message: unknown) {
			if (!message || typeof message !== "object") return;
			if ("ready" in message && message.ready === true) ready.resolve();
			if ("exitCode" in message && typeof message.exitCode === "number") outcome.resolve(message.exitCode);
		},
	});
	return { child, ready: ready.promise, outcome: outcome.promise };
}
async function emergencyCleanup(child: Bun.Subprocess, prefix: string) {
	// Release the escaped worker even if an assertion fails, keeping the
	// supervisor alive long enough to adopt and reap it before fallback killing.
	await fs.writeFile(`${prefix}.worker-release`, "release");
	await fs.writeFile(`${prefix}.command-release`, "release");
	try {
		await within(
			(async () => {
				let workerPid: number;
				try {
					workerPid = Number(await fs.readFile(`${prefix}.worker`, "utf8"));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				for (;;) {
					try {
						await fs.access(`/proc/${workerPid}`);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
						throw error;
					}
					await Bun.sleep(5);
				}
			})(),
		);
	} finally {
		await terminateOwnedSubprocess(child, { detached: true });
	}
}

it.skipIf(process.platform !== "linux")(
	"does not steal the command exit status when cleanup precedes its exit",
	async () => {
		const prefix = path.join(directory, "graceful");
		const { child, ready, outcome } = supervisor(prefix);
		try {
			await within(ready);
			child.send("start");
			const commandPid = await within(readPid(`${prefix}.command`));
			const workerPid = await within(readPid(`${prefix}.worker`));
			child.send("cleanup");
			await fs.writeFile(`${prefix}.command-release`, "release");
			expect(await within(outcome)).toBe(23);
			// The adopted worker keeps the subreaper alive until it is actually reaped.
			expect(child.exitCode).toBeNull();
			await fs.writeFile(`${prefix}.worker-release`, "release");
			expect(await within(child.exited)).toBe(0);
			expect(() => process.kill(commandPid, 0)).toThrow();
			expect(() => process.kill(workerPid, 0)).toThrow();
		} finally {
			await emergencyCleanup(child, prefix);
		}
	},
);

it.skipIf(process.platform !== "linux")(
	"acknowledges owned cancellation only after escaped descendants are reaped",
	async () => {
		const prefix = path.join(directory, "cancelled");
		const { child, ready, outcome } = supervisor(prefix);
		const owner = await ownGateProcess(child, true);
		try {
			await within(ready);
			child.send("start");
			const commandPid = await within(readPid(`${prefix}.command`));
			const workerPid = await within(readPid(`${prefix}.worker`));
			await within(owner.terminate());
			expect(child.exitCode).toBe(0);
			expect(await within(outcome)).not.toBe(0);
			expect(() => process.kill(commandPid, 0)).toThrow();
			expect(() => process.kill(workerPid, 0)).toThrow();
		} finally {
			owner.close();
			await emergencyCleanup(child, prefix);
		}
	},
);

it.skipIf(process.platform !== "linux")(
	"closes the queued launch boundary before cancellation takes its snapshot",
	async () => {
		for (const queuedStart of [false, true]) {
			const prefix = path.join(directory, `queued-${queuedStart}`);
			const { child, ready } = supervisor(prefix);
			const owner = await ownGateProcess(child, true);
			try {
				await within(ready);
				if (queuedStart) child.send("start");
				await within(owner.terminate());
				expect(child.exitCode).toBe(0);
				for (const role of ["command", "worker"]) {
					let pid: number;
					try {
						pid = Number(await fs.readFile(`${prefix}.${role}`, "utf8"));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw error;
					}
					expect(() => process.kill(pid, 0)).toThrow();
				}
			} finally {
				owner.close();
				await emergencyCleanup(child, prefix);
			}
		}
	},
);
