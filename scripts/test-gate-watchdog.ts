import { dlopen, FFIType } from "bun:ffi";
import { writeSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { gateClockNanoseconds } from "./test-gate-clock";

interface WatchdogData {
	level: string;
	limitMs: number;
	started: bigint;
	state: SharedArrayBuffer;
}
export interface GateAbortCommand {
	argv: readonly string[];
}
type WatchdogMessage =
	| { kind: "own"; id: string; command: GateAbortCommand }
	| { kind: "release"; id: string }
	| { kind: "deadline" | "stop" };
export interface GateWatchdog {
	ready: Promise<void>;
	update(charged: number, compile: number, compileOnly: boolean, elapsed: number): void;
	setLimit(totalMs: number): void;
	ownAbortCommand(id: string, command: GateAbortCommand): Promise<void>;
	releaseAbortCommand(id: string): void;
	stop(): void;
}

/** Bypass exit hooks: neither report I/O nor an exit listener may hold a failed gate open. */
export function exitGateProcess(exitCode: number): never {
	if (process.platform === "win32") {
		const kernel = dlopen("kernel32.dll", {
			ExitProcess: { args: [FFIType.u32], returns: FFIType.void },
		});
		kernel.symbols.ExitProcess(exitCode);
	} else {
		const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
			_exit: { args: [FFIType.i32], returns: FFIType.void },
		});
		libc.symbols._exit(exitCode);
	}
	throw new Error("Native gate exit returned unexpectedly");
}
/** Cross-OS cleanup must survive the gate itself; launch it without joining its lifetime. */
// Carry cancellation in argv: an asynchronous stdin pipe can be lost at native exit.
export function spawnGateAbortCommand(command: GateAbortCommand): void {
	try {
		Bun.spawn([...command.argv], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
	} catch (error) {
		writeSync(2, `CLEANUP_FAIL: could not launch owned cross-OS cancellation: ${String(error)}\n`);
	}
}

/** A separate thread enforces the deadline even while the scheduler blocks synchronously. */
export function startGateWatchdog(
	level: string,
	limitMs: number,
	elapsedMs: number,
	onFailure: (error: unknown) => void,
): GateWatchdog {
	// stopped, charged ns, compile ns, last elapsed ns, compile-only, effective wall limit ns.
	const state = new BigInt64Array(new SharedArrayBuffer(6 * BigInt64Array.BYTES_PER_ELEMENT));
	Atomics.store(state, 5, BigInt(Math.round(limitMs * 1e6)));
	const ready = Promise.withResolvers<void>();
	const worker = new Worker(new URL(import.meta.url), {
		workerData: {
			level,
			limitMs,
			started: gateClockNanoseconds() - BigInt(Math.round(elapsedMs * 1e6)),
			state: state.buffer,
		} satisfies WatchdogData,
	});
	const registrations = new Map<string, { resolve: () => void }>();
	worker.on("message", (message: unknown) => {
		if (message === "ready") ready.resolve();
		else if (typeof message === "string") {
			registrations.get(message)?.resolve();
			registrations.delete(message);
		}
	});
	worker.once("error", error => {
		ready.reject(error);
		onFailure(error);
	});
	worker.once("exit", code => {
		if (Atomics.load(state, 0) !== 0n) return;
		const error = new Error(`Gate watchdog exited unexpectedly (${code})`);
		ready.reject(error);
		onFailure(error);
	});
	return {
		async ownAbortCommand(id, command) {
			const registered = Promise.withResolvers<void>();
			registrations.set(id, registered);
			worker.postMessage({ kind: "own", id, command } satisfies WatchdogMessage);
			await registered.promise;
		},
		releaseAbortCommand(id) {
			worker.postMessage({ kind: "release", id } satisfies WatchdogMessage);
		},
		setLimit(totalMs) {
			Atomics.store(state, 5, BigInt(Math.round(totalMs * 1e6)));
			worker.postMessage({ kind: "deadline" } satisfies WatchdogMessage);
		},
		ready: ready.promise,
		update(charged, compile, compileOnly, elapsed) {
			Atomics.store(state, 1, BigInt(Math.round(charged * 1e6)));
			Atomics.store(state, 2, BigInt(Math.round(compile * 1e6)));
			Atomics.store(state, 4, compileOnly ? 1n : 0n);
			Atomics.store(state, 3, BigInt(Math.round(elapsed * 1e6)));
		},
		stop() {
			Atomics.store(state, 0, 1n);
			worker.postMessage({ kind: "stop" } satisfies WatchdogMessage);
		},
	};
}

if (!isMainThread) {
	const data = workerData as WatchdogData;
	const state = new BigInt64Array(data.state);
	const abortCommands = new Map<string, GateAbortCommand>();
	let timer: Timer | undefined;
	const checkDeadline = () => {
		clearTimeout(timer);
		if (Atomics.load(state, 0) !== 0n) return;
		const deadline = data.started + Atomics.load(state, 5);
		const now = gateClockNanoseconds();
		if (now < deadline) {
			timer = setTimeout(checkDeadline, Math.max(1, Number(deadline - now) / 1e6));
			return;
		}
		const elapsed = now - data.started;
		const unobserved = elapsed - Atomics.load(state, 3);
		const compileOnly = Atomics.load(state, 4) === 1n;
		const compile = Atomics.load(state, 2) + (compileOnly ? unobserved : 0n);
		const charged = Atomics.load(state, 1) + (compileOnly ? 0n : unobserved);
		const seconds = (value: bigint) => (Number(value) / 1e9).toFixed(1);
		try {
			for (const command of abortCommands.values()) spawnGateAbortCommand(command);
			const token = process.env.OMP_GATE_EVENT_TOKEN;
			if (token) {
				writeSync(
					2,
					`OMP_GATE_EVENT ${token} ${JSON.stringify({ id: "wall-watchdog", kind: "failure", exitCode: 124, status: "TIMEOUT", message: "Total wall-clock deadline exhausted" })}\n`,
				);
			}
			writeSync(
				1,
				`${data.level}: TIMEOUT total=${seconds(elapsed)}s compile_excluded=${seconds(compile)}s budgeted=${seconds(charged)}s limit=${(data.limitMs / 1000).toFixed(1)}s exit=124 (total wall-clock deadline, including nested limits)\n`,
			);
		} finally {
			exitGateProcess(124);
		}
	};
	parentPort!.on("message", (message: WatchdogMessage) => {
		if (message.kind === "own") {
			abortCommands.set(message.id, message.command);
			parentPort!.postMessage(message.id);
		} else if (message.kind === "release") abortCommands.delete(message.id);
		else if (message.kind === "stop") {
			clearTimeout(timer);
			parentPort!.close();
		} else checkDeadline();
	});
	checkDeadline();
	parentPort!.postMessage("ready");
}
