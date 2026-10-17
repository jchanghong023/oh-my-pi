#!/usr/bin/env bun
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { assertLinuxGateSignals, terminateLinuxGateDescendants } from "./test-gate-process";

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
let reapChildren: (() => Promise<boolean>) | undefined;

// Mirrors the supported Linux subreaper primitive in utils/ptree, without
// loading the native addon before the gate has had a chance to build it.
if (process.platform === "linux") {
	assertLinuxGateSignals();
	let libc;
	for (const name of ["libc.so.6", "libc.so"]) {
		try {
			libc = dlopen(name, {
				prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
				waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
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
	if (process.platform === "linux") {
		void cleanupAndReap();
	} else if (process.platform === "win32") {
		// No Job may have been assigned if the parent died before launch.
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
		});
		commandPid = child.pid;
		logger.info("Supervised command spawned", {
			...fields,
			event: "gate_command_spawn_settled",
			stage: "launch",
			result: "completed",
			peer_pid: child.pid,
			elapsed_ms: performance.now() - startedAt,
		});
		const exitCode = await child.exited;
		commandSettled = true;
		(exitCode === 0 || exitCode === 130 ? logger.info : logger.error)("Supervised command exited", {
			...fields,
			event: "gate_command_settled",
			stage: "execute",
			result: exitCode === 0 ? "completed" : exitCode === 130 ? "cancelled" : "failed",
			exit_code: exitCode,
			peer_pid: child.pid,
			elapsed_ms: performance.now() - startedAt,
		});
		sendReply({ exitCode });
		logger.info("Supervisor IPC reply sent", {
			...fields,
			event: "gate_supervisor_ipc_sent",
			stage: "reply",
			result: "reply",
			exit_code: exitCode,
			peer_pid: child.pid,
			elapsed_ms: performance.now() - startedAt,
		});
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
