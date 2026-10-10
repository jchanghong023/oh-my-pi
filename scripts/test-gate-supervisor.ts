#!/usr/bin/env bun
import { dlopen, FFIType } from "bun:ffi";
import * as logger from "@oh-my-pi/pi-utils/logger";

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

let finished = false;
let commandPid: number | undefined;
let reapChildren: (() => Promise<void>) | undefined;

// Mirrors the supported Linux subreaper primitive in utils/ptree, without
// loading the native addon before the gate has had a chance to build it.
if (process.platform === "linux") {
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
		if (finished) {
			while (symbols.waitpid(-1, null, 1) > 0) {
				/* Reap exited adopted children. */
			}
			return;
		}
		// Bun owns the command's exit status. Reap only adopted descendants,
		// even while the command is still checking that its workers are gone.
		const children = await Bun.file(`/proc/self/task/${process.pid}/children`).text();
		for (const value of children.trim().split(/\s+/)) {
			const pid = Number(value);
			if (pid > 0 && pid !== commandPid) symbols.waitpid(pid, null, 1);
		}
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
setInterval(async () => {
	if (!started || reaping || !reapChildren) return;
	reaping = true;
	try {
		await reapChildren();
	} catch (error) {
		logger.error("Owned descendant reaping failed", {
			...fields,
			event: "gate_supervisor_reap_failed",
			stage: "owned-cleanup",
			result: "failed",
			peer_pid: commandPid,
			...logger.diagnosticError(error),
		});
		throw error;
	} finally {
		reaping = false;
	}
}, 5);
process.on("message", async (message: unknown) => {
	if (message === "cleanup") {
		logger.info("Supervisor cleanup received", {
			...fields,
			event: "gate_supervisor_ipc_received",
			stage: "owned-cleanup",
			result: "cleanup",
			peer_pid: commandPid,
			elapsed_ms: performance.now() - launchedAt,
		});
		finished = true;
		return;
	}
	if (started || message !== "start") return;
	started = true;
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
		finished = true;
		(exitCode === 0 || exitCode === 130 ? logger.info : logger.error)("Supervised command exited", {
			...fields,
			event: "gate_command_settled",
			stage: "execute",
			result: exitCode === 0 ? "completed" : exitCode === 130 ? "cancelled" : "failed",
			exit_code: exitCode,
			peer_pid: child.pid,
			elapsed_ms: performance.now() - startedAt,
		});
		process.send?.({ exitCode });
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
		finished = true;
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
		process.send?.({
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
process.send?.({ ready: true });
logger.info("Supervisor ready IPC sent", {
	...fields,
	event: "gate_supervisor_ipc_sent",
	stage: "initialize",
	result: "ready",
	elapsed_ms: performance.now() - launchedAt,
});
