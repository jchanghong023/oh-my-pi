#!/usr/bin/env bun
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	assertLinuxGateSignals,
	terminateLinuxGateDescendants,
	spawnPersistentBazel,
	requestHostedPersistentBazel,
} from "./test-gate-process";
import type { PersistentBazelClient } from "./test-gate-process";
import { runGate } from "./test-gate-runtime";

const launchedAt = performance.now();
const correlation = Object.fromEntries(
	[
		["run_id", process.env.OMP_GATE_DIAGNOSTIC_RUN_ID],
		["operation_id", process.env.OMP_GATE_DIAGNOSTIC_OPERATION_ID],
		["call_id", process.env.OMP_GATE_DIAGNOSTIC_CALL_ID],
	].filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Za-z0-9-]{1,80}$/.test(entry[1]),
	),
);
const fields = {
	component: "test-gate-supervisor",
	...correlation,
	parent_pid: process.ppid,
	platform: process.platform,
};
logger.info("Supervisor started", {
	...fields,
	event: "gate_supervisor_started",
	stage: "initialize",
	result: "started",
});
process.on("exit", exitCode => {
	logger.info("Supervisor stopping", {
		...fields,
		event: "gate_supervisor_stopped",
		stage: "close",
		result: "closed",
		exit_code: exitCode,
		elapsed_ms: performance.now() - launchedAt,
		peer_pid: commandPid,
	});
});

let aborting = false;
let cleanupRequested = false;
let commandSettled = true;
let commandPid: number | undefined;
const persistentBazel = Boolean(process.env.OMP_GATE_PERSISTENT_BAZEL);
let persistentCommand: Bun.Subprocess | undefined;
let persistentCommandReady = false;
let reapChildren: (() => Promise<boolean>) | undefined;
const nativeClients = new Map<string, { client?: PersistentBazelClient; cancelled: boolean }>();
const nativeOperations = new Set<Promise<void>>();
let nativeAccepting = true;
async function cancelNativeClients() {
	const cancellations = await Promise.allSettled(
		[...nativeClients.values()].map(entry => {
			entry.cancelled = true;
			return entry.client?.cancel();
		}),
	);
	for (const result of cancellations)
		if (result.status === "rejected") console.error("Native Bazel cancellation failed:", result.reason);
	await Promise.all(nativeOperations);
}
// A reference to the driver's object-lifetime lease spans hard parent exits:
// declarations cannot be replaced until the native client acknowledges cancel.
if (persistentBazel && process.platform === "win32") {
	const identity = (
		await fs.realpath(process.env.OMP_GATE_PERSISTENT_BAZEL!.slice(0, -"-output".length))
	).toLowerCase();
	const name = Buffer.from(
		`Global\\omp-gate-bazel-${createHash("sha256").update(identity).digest("hex")}\0`,
		"utf16le",
	);
	const kernel = dlopen("kernel32.dll", {
		CreateMutexExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u64 },
		GetLastError: { args: [], returns: FFIType.u32 },
		SetLastError: { args: [FFIType.u32], returns: FFIType.void },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	});
	kernel.symbols.SetLastError(0);
	const handle = kernel.symbols.CreateMutexExW(null, ptr(name), 0, 0x100000);
	if (!handle || kernel.symbols.GetLastError() !== 183) {
		if (handle) kernel.symbols.CloseHandle(handle);
		kernel.close();
		throw new Error("Persistent Bazel declaration lease lost before supervisor handoff");
	}
	process.on("exit", () => {
		kernel.symbols.CloseHandle(handle);
		kernel.close();
	});
}

// Mirrors the supported Linux subreaper primitive in utils/ptree, without
// loading the native addon before the gate has had a chance to build it.
if (process.platform === "linux") {
	try {
		assertLinuxGateSignals();
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		sendReply({
			exitCode: missing ? 127 : 1,
			error: error instanceof Error ? error.message : String(error),
			missing,
		});
		throw error;
	}
	let libc;
	for (const name of ["libc.so.6", "libc.so"]) {
		try {
			libc = dlopen(name, {
				prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
				waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			});
			break;
		} catch (error) {
			logger.debug("Subreaper libc unavailable", {
				...fields,
				event: "gate_supervisor_libc_probe",
				stage: "initialize",
				result: "unavailable",
				...logger.diagnosticError(error),
			});
			/* Try the installed platform libc soname. */
		}
	}
	if (!libc || libc.symbols.prctl(36, 1, 0, 0, 0) !== 0) {
		logger.error("Subreaper initialization failed", {
			...fields,
			event: "gate_supervisor_initialize_settled",
			stage: "initialize",
			result: "failed",
			elapsed_ms: performance.now() - launchedAt,
		});
		throw new Error("Cannot establish owned Linux child subreaper");
	}
	const symbols = libc.symbols;
	if (persistentBazel) {
		const expected = await fs.realpath(
			path.join(process.env.OMP_GATE_PERSISTENT_BAZEL!.slice(0, -"-output".length), "declarations.lock"),
		);
		const inherited = await fs.realpath("/proc/self/fd/3");
		if (inherited !== expected || symbols.flock(3, 2 | 4) !== 0)
			throw new Error("Persistent Bazel declaration lease was not inherited");
		if (symbols.fcntl(3, 2, 1) !== 0)
			throw new Error("Cannot prevent declaration lease inheritance by the persistent server");
		// flock belongs to this shared open-file description. Parent death closes
		// only its duplicate; this supervisor retains the lock through cancel.
	}
	reapChildren = async () => {
		// Bun owns the command's exit status until child.exited settles,
		// including during cancellation. Never use waitpid(-1) in that window.
		// Children belong to the task that forked them, not necessarily the
		// main thread, so collect every task's adopted children.
		const tasks = await fs.readdir(`/proc/self/task`);
		const children = await Promise.all(
			tasks.map(async task => {
				try {
					return await fs.readFile(`/proc/self/task/${task}/children`, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
					throw error;
				}
			}),
		);
		let present = false;
		for (const value of children.join(" ").trim().split(/\s+/)) {
			const pid = Number(value);
			if (pid <= 0) continue;
			present = true;
			if (commandSettled || pid !== commandPid) symbols.waitpid(pid, null, 1);
		}
		return present;
	};
}
logger.info("Supervisor initialized", {
	...fields,
	event: "gate_supervisor_initialize_settled",
	stage: "initialize",
	result: "completed",
	elapsed_ms: performance.now() - launchedAt,
});

let started = false;
// Stay alive after the real leader exits, so the parent's ownership reference
// remains valid until descendants are gone and command output reaches EOF.
let reaping = false;
async function cleanupAndReap() {
	if ((!started && !cleanupRequested) || reaping || !reapChildren) return;
	reaping = true;
	try {
		if (persistentBazel) {
			if (cleanupRequested && commandSettled && nativeOperations.size === 0) process.exit(0);
			return;
		}
		if (aborting) await terminateLinuxGateDescendants();
		const present = await reapChildren();
		if (cleanupRequested && commandSettled && !present) {
			// Exiting is the ownership acknowledgment: the parent may release
			// this subreaper only after Bun's command wait and adopted-child reaping.
			process.exit(0);
		}
	} catch (error) {
		logger.error("Owned descendant reaping failed", {
			...fields,
			event: "gate_supervisor_reap_failed",
			stage: "owned-cleanup",
			result: "failed",
			peer_pid: commandPid,
			...logger.diagnosticError(error),
		});
		// Once orphaned, this supervisor is the only remaining owner. Retry
		// cleanup rather than abandoning escaped descendants on an I/O race.
		if (!aborting) throw error;
	} finally {
		reaping = false;
	}
}
setInterval(cleanupAndReap, 5);
function requestAbort() {
	if (aborting) return;
	aborting = true;
	cleanupRequested = true;
	if (persistentBazel) {
		void cancelNativeClients().then(() => {
			if (commandSettled) process.exit(0);
		});
		if (persistentCommand) {
			if (persistentCommandReady) {
				try {
					persistentCommand.send("abort");
				} catch {}
			}
		} else process.exit(0);
		return;
	}
	if (process.platform === "linux") {
		void cleanupAndReap();
	} else if (process.platform === "win32") {
		// Before launch there may be no Job yet. Once launched, the parent
		// runtime's onDisconnect terminates the owned Job even if it stays alive.
		if (commandPid === undefined) process.exit(0);
	} else {
		// The supervisor leads the owned detached group.
		process.kill(-process.pid, "SIGKILL");
	}
}
process.on("disconnect", requestAbort);
if (!process.connected) requestAbort();
function sendReply(message: object) {
	if (!process.connected) return;
	try {
		process.send?.(message);
	} catch (error) {
		if (!aborting) throw error;
	}
}
process.on("message", async (message: unknown) => {
	if (message === "abort") {
		requestAbort();
		return;
	}
	if (message === "release" && persistentBazel && commandSettled && !aborting) {
		process.exit(0);
	}
	if (message === "cleanup") {
		logger.info("Supervisor cleanup received", {
			...fields,
			event: "gate_supervisor_ipc_received",
			stage: "owned-cleanup",
			result: "cleanup",
			peer_pid: commandPid,
			elapsed_ms: performance.now() - launchedAt,
		});
		cleanupRequested = true;
		return;
	}
	if (started || aborting || cleanupRequested || message !== "start") return;
	started = true;
	commandSettled = false;
	logger.info("Supervisor start received", {
		...fields,
		event: "gate_supervisor_ipc_received",
		stage: "launch",
		result: "start",
		elapsed_ms: performance.now() - launchedAt,
	});
	const startedAt = performance.now();
	try {
		const argv: unknown = JSON.parse(process.env.OMP_GATE_SUPERVISED_COMMAND ?? "null");
		if (!Array.isArray(argv) || !argv.every(arg => typeof arg === "string"))
			throw new Error("Invalid supervised command");
		delete process.env.OMP_GATE_SUPERVISED_COMMAND;
		logger.info("Supervised command spawn started", {
			...fields,
			event: "gate_command_spawn_started",
			stage: "launch",
			result: "started",
		});
		const child = Bun.spawn(argv, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env: process.env,
			windowsHide: true,
			...(persistentBazel
				? {
						onDisconnect() {
							nativeAccepting = false;
							void cancelNativeClients();
						},
						ipc(message: unknown) {
							if (
								message &&
								typeof message === "object" &&
								"type" in message &&
								"id" in message &&
								typeof message.id === "string"
							) {
								const id = message.id;
								if (message.type === "native-bazel-cancel") {
									const entry = nativeClients.get(id);
									if (entry) {
										entry.cancelled = true;
										void entry.client
											?.cancel()
											.catch(error => console.error("Native Bazel cancellation failed:", error));
									}
									return;
								}
								if (message.type === "native-bazel-start") {
									// Hosted readiness can arrive after cancellation; keep ownership from receipt through exit.
									const entry: { client?: PersistentBazelClient; cancelled: boolean } = { cancelled: false };
									nativeClients.set(id, entry);
									const operation = (async () => {
										let exitCode = 1;
										try {
											if (aborting || !nativeAccepting) {
												exitCode = 130;
												return;
											}
											if (
												!("argv" in message) ||
												!Array.isArray(message.argv) ||
												!message.argv.every(arg => typeof arg === "string") ||
												!("cwd" in message) ||
												typeof message.cwd !== "string" ||
												!("env" in message) ||
												!message.env ||
												typeof message.env !== "object"
											)
												throw new Error("Invalid native Bazel invocation");
											let client: PersistentBazelClient;
											if ("payload" in message && message.payload && typeof message.payload === "object") {
												const controller = new AbortController();
												const argv = message.argv;
												const cwd = message.cwd;
												const env = message.env as Record<string, string>;
												const charged = "charged" in message.payload && message.payload.charged === true;
												const exited = runGate(
													"fulltest",
													async gate => {
														await gate.run({
															label: "build/Bazel run payload",
															argv,
															cwd,
															env,
															kind: charged ? "charged" : undefined,
														});
													},
													{ signal: controller.signal, print: () => {} },
												).then(result => result.exitCode);
												client = {
													pid: process.pid,
													exited,
													async cancel() {
														controller.abort();
														await exited;
													},
												};
											} else {
												const options = { cwd: message.cwd, env: message.env as Record<string, string> };
												const broker = process.env.OMP_GATE_NATIVE_BROKER;
												client = broker
													? await requestHostedPersistentBazel(JSON.parse(broker), message.argv, options)
													: spawnPersistentBazel(message.argv, options);
											}
											entry.client = client;
											if (entry.cancelled || aborting || !nativeAccepting) await client.cancel();
											try {
												persistentCommand?.send({ type: "native-bazel-started", id, pid: client.pid });
											} catch {}
											exitCode = await client.exited;
										} catch (error) {
											console.error(error);
										} finally {
											nativeClients.delete(id);
											try {
												persistentCommand?.send({ type: "native-bazel-exited", id, exitCode });
											} catch {}
										}
									})();
									nativeOperations.add(operation);
									void operation.finally(() => nativeOperations.delete(operation));
									return;
								}
							}
							if (
								message &&
								typeof message === "object" &&
								"type" in message &&
								message.type === "persistent-bazel-ready"
							) {
								persistentCommandReady = true;
								if (aborting) {
									try {
										persistentCommand?.send("abort");
									} catch {}
								}
							}
						},
					}
				: {}),
		});
		commandPid = child.pid;
		if (persistentBazel) persistentCommand = child;
		logger.info("Supervised command spawned", {
			...fields,
			event: "gate_command_spawn_settled",
			stage: "launch",
			result: "completed",
			peer_pid: child.pid,
			elapsed_ms: performance.now() - startedAt,
		});
		const exitCode = await child.exited;
		nativeAccepting = false;
		if (persistentBazel) await cancelNativeClients();
		commandSettled = true;
		if (persistentBazel && aborting) process.exit(0);
		(exitCode === 0 || exitCode === 130 ? logger.info : logger.error)("Supervised command exited", {
			...fields,
			event: "gate_command_settled",
			stage: "execute",
			result: exitCode === 0 ? "completed" : exitCode === 130 ? "cancelled" : "failed",
			exit_code: exitCode,
			peer_pid: child.pid,
			elapsed_ms: performance.now() - startedAt,
		});
		logger.info("Supervisor IPC reply sending", {
			...fields,
			event: "gate_supervisor_ipc_sending",
			stage: "reply",
			result: "reply",
			exit_code: exitCode,
			peer_pid: child.pid,
			elapsed_ms: performance.now() - startedAt,
		});
		// The parent may immediately terminate this supervisor's Windows Job
		// after the reply. Flush successful command/IPC diagnostics before handing
		// ownership back, while the parent's gate deadline is still enforced.
		// Never add a log-I/O wait to a failure or cancellation reply.
		if (exitCode === 0 && !aborting) logger.flush();
		sendReply({ exitCode });
	} catch (error) {
		commandSettled = true;
		logger.error("Supervised command failed", {
			...fields,
			event: "gate_command_settled",
			stage: commandPid === undefined ? "launch" : "execute",
			result: "failed",
			missing_tool: (error as NodeJS.ErrnoException).code === "ENOENT",
			exit_code: (error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1,
			peer_pid: commandPid,
			elapsed_ms: performance.now() - startedAt,
			...logger.diagnosticError(error),
		});
		sendReply({
			exitCode: (error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1,
			error: error instanceof Error ? error.message : String(error),
			missing: (error as NodeJS.ErrnoException).code === "ENOENT",
		});
		logger.info("Supervisor failure IPC reply sent", {
			...fields,
			event: "gate_supervisor_ipc_sent",
			stage: "reply",
			result: "reply",
			exit_code: (error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1,
			elapsed_ms: performance.now() - startedAt,
		});
	}
});
sendReply({ ready: true });
logger.info("Supervisor ready IPC sent", {
	...fields,
	event: "gate_supervisor_ipc_sent",
	stage: "initialize",
	result: "ready",
	elapsed_ms: performance.now() - launchedAt,
});
