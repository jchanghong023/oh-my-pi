import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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
const [role, prefix, mode] = process.argv.slice(2);
const wait = async file => { while (!(await Bun.file(file).exists())) await Bun.sleep(5); };
if (role === "parent") {
  const ready = Promise.withResolvers();
  const child = Bun.spawn([process.execPath, ${JSON.stringify(path.join(import.meta.dir, "test-gate-supervisor.ts"))}], {
    env: {...process.env, OMP_GATE_SUPERVISED_COMMAND: JSON.stringify([process.execPath, import.meta.path, "command", prefix])},
    detached:true, stdin:"ignore", stdout:"ignore", stderr:"ignore",
    ipc(message) { if (message?.ready) ready.resolve(); },
  });
  await ready.promise;
  await fs.writeFile(prefix + ".supervisor", String(child.pid));
  child.send("start");
  await wait(prefix + ".command");
  await wait(prefix + ".parent-release");
  if (mode === "abort") child.send("abort");
  process.exit(0);
}
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

for (const mode of ["abort", "disconnect"]) {
	it.skipIf(process.platform !== "linux")(
		`reaps escaped descendants after its real parent exits (${mode})`,
		async () => {
			const prefix = path.join(directory, `parent-${mode}`);
			const unrelatedPrefix = `${prefix}-unrelated`;
			const unrelated = Bun.spawn([process.execPath, fixture, "worker", unrelatedPrefix], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			const parent = Bun.spawn([process.execPath, fixture, "parent", prefix, mode], {
				detached: true,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			let supervisorPid: number | undefined;
			let supervisorStart: string | undefined;
			try {
				await within(readPid(`${unrelatedPrefix}.worker`));
				supervisorPid = await within(readPid(`${prefix}.supervisor`));
				const stat = await fs.readFile(`/proc/${supervisorPid}/stat`, "utf8");
				supervisorStart = stat
					.slice(stat.lastIndexOf(") ") + 2)
					.trim()
					.split(/\s+/)[19];
				const commandPid = await within(readPid(`${prefix}.command`));
				const workerPid = await within(readPid(`${prefix}.worker`));
				await fs.writeFile(`${prefix}.parent-release`, "release");
				expect(await within(parent.exited)).toBe(0);
				await within(
					(async () => {
						for (;;) {
							const remaining = await Promise.all(
								[commandPid, workerPid, supervisorPid!].map(async pid => {
									try {
										const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
										// The supervisor itself is now owned by init, whose
										// zombie reaping latency is outside this gate's control.
										return pid !== supervisorPid || text.slice(text.lastIndexOf(") ") + 2)[0] !== "Z";
									} catch (error) {
										if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
										throw error;
									}
								}),
							);
							if (!remaining.some(Boolean)) return;
							await Bun.sleep(5);
						}
					})(),
				);
				expect(unrelated.exitCode).toBeNull();
				expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
			} finally {
				await fs.writeFile(`${prefix}.worker-release`, "release");
				await fs.writeFile(`${prefix}.command-release`, "release");
				await fs.writeFile(`${prefix}.parent-release`, "release");
				await fs.writeFile(`${unrelatedPrefix}.worker-release`, "release");
				await terminateOwnedSubprocess(parent, { detached: true });
				await terminateOwnedSubprocess(unrelated, { detached: false });
				if (supervisorPid !== undefined && supervisorStart !== undefined) {
					try {
						const text = await fs.readFile(`/proc/${supervisorPid}/stat`, "utf8");
						const start = text
							.slice(text.lastIndexOf(") ") + 2)
							.trim()
							.split(/\s+/)[19];
						if (start === supervisorStart) process.kill(supervisorPid, "SIGKILL");
					} catch (error) {
						if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
					}
				}
			}
		},
	);
}

it.skipIf(process.platform !== "linux")("rejects a queued start after abort without a quiesce handshake", async () => {
	const prefix = path.join(directory, "aborted-before-start");
	const { child, ready } = supervisor(prefix);
	try {
		await within(ready);
		child.send("abort");
		child.send("start");
		expect(await within(child.exited)).toBe(0);
		expect(await Bun.file(`${prefix}.command`).exists()).toBe(false);
		expect(await Bun.file(`${prefix}.worker`).exists()).toBe(false);
	} finally {
		await emergencyCleanup(child, prefix);
	}
});

it.each(["pidfd_open", "pidfd_send_signal"])(
	"refuses supervisor readiness when %s is unavailable",
	async unavailable => {
		const trace = path.join(directory, `${unavailable}.jsonl`);
		const source = `
import { mock } from "bun:test";
import * as ffi from "bun:ffi";
import { appendFileSync } from "node:fs";
Object.defineProperty(process, "platform", { value: "linux" });
mock.module("bun:ffi", () => ({
  ...ffi,
  dlopen() {
    return { symbols: {
      syscall(number, first, signal) {
        const target = number === 434 && first === process.pid ? "self" : first;
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ number, target, signal }) + "\\n");
        if (number === 434) return ${unavailable === "pidfd_open" ? -1 : 73};
        if (number === 424) return -1;
        throw new Error("Unexpected syscall " + number);
      },
      close(fd) { appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ close: fd }) + "\\n"); return 0; },
      prctl() { return 0; },
      waitpid() { return 0; },
    }, close() {} };
  },
}));
// Install the unavailable-kernel FFI boundary before evaluating the real supervisor.
await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-supervisor.ts")).href)});
`;
		let ready = false;
		const child = Bun.spawn([process.execPath, "--eval", source], {
			stdout: "pipe",
			stderr: "pipe",
			ipc(message: unknown) {
				if (message && typeof message === "object" && "ready" in message && message.ready === true) ready = true;
			},
		});
		const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		try {
			expect(await within(child.exited)).not.toBe(0);
			const [, stderr] = await output;
			expect(stderr).toContain("Safe Linux gate ownership requires pidfd_open and pidfd_send_signal");
			expect(stderr).toContain(`${unavailable} failed`);
			expect(ready).toBe(false);
			const calls = (await fs.readFile(trace, "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(calls).toEqual(
				unavailable === "pidfd_open"
					? [{ number: 434, target: "self", signal: 0 }]
					: [{ number: 434, target: "self", signal: 0 }, { number: 424, target: 73, signal: 0 }, { close: 73 }],
			);
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			await output;
		}
	},
);
