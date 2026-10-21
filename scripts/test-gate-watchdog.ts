import { dlopen, FFIType, ptr } from "bun:ffi";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { gateClockNanoseconds } from "./test-gate-clock";
import { openGateLibc } from "./test-gate-libc";

interface WatchdogData {
	level: string;
	limitMs: number;
	started: bigint;
	state: SharedArrayBuffer;
	output: SharedArrayBuffer;
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
	failStartup(exitCode: number): void;
	update(charged: number, compile: number, compileOnly: boolean, elapsed: number): void;
	setLimit(totalMs: number): void;
	ownAbortCommand(id: string, command: GateAbortCommand): Promise<void>;
	releaseAbortCommand(id: string): void;
	stop(): void;
}

const outputBuffer: SharedArrayBuffer =
	(!isMainThread && workerData?.output) || new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
const outputState = new Int32Array(outputBuffer);

/** Called only after the independent deadline thread acknowledges readiness. */
export function prepareGateDiagnosticOutput(): void {
	if (process.platform !== "win32") return;
	const kernel = dlopen("kernel32.dll", {
		GetStdHandle: { args: [FFIType.u32], returns: FFIType.ptr },
		GetFileType: { args: [FFIType.ptr], returns: FFIType.u32 },
		SetNamedPipeHandleState: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
	});
	try {
		for (const fd of [1, 2] as const) {
			if (Atomics.load(outputState, fd - 1) !== 0) continue;
			let ready = -1;
			try {
				const handle = kernel.symbols.GetStdHandle(fd === 1 ? 0xfffffff5 : 0xfffffff4);
				if (handle) {
					if (kernel.symbols.GetFileType(handle) === 3) {
						const mode = new Uint32Array([1]); // PIPE_NOWAIT, retained through exit.
						// May block behind inherited writes; never run on the deadline thread.
						if (kernel.symbols.SetNamedPipeHandleState(handle, ptr(mode), null, null)) ready = 1;
					} else ready = 2;
				}
			} finally {
				Atomics.store(outputState, fd - 1, ready);
			}
		}
	} finally {
		kernel.close();
	}
}

/** Fatal writes never change Windows pipe modes or wait for an unprepared sink. */
export function writeGateDiagnostic(fd: 1 | 2, text: string): void {
	try {
		const bytes = Buffer.from(text);
		if (process.platform === "win32") {
			const ready = Atomics.load(outputState, fd - 1);
			// Only confirmed nonblocking pipes are safe on the deadline thread.
			if (ready !== 1 && (!isMainThread || ready !== 2)) return;
			const kernel = dlopen("kernel32.dll", {
				GetStdHandle: { args: [FFIType.u32], returns: FFIType.ptr },
				WriteFile: {
					args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
					returns: FFIType.i32,
				},
			});
			try {
				const handle = kernel.symbols.GetStdHandle(fd === 1 ? 0xfffffff5 : 0xfffffff4);
				if (!handle) return;
				const written = new Uint32Array(1);
				kernel.symbols.WriteFile(handle, ptr(bytes), bytes.byteLength, ptr(written), null);
			} finally {
				kernel.close();
			}
		} else {
			const nonblocking =
				process.platform === "linux"
					? 0x800
					: ["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform)
						? 4
						: 0;
			if (!nonblocking) return;
			const libc = openGateLibc({
				fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
			});
			try {
				const flags = libc.symbols.fcntl(fd, 3, 0);
				if (flags < 0 || libc.symbols.fcntl(fd, 4, flags | nonblocking) < 0) return;
				libc.symbols.write(fd, ptr(bytes), bytes.byteLength);
			} finally {
				libc.close();
			}
		}
	} catch {
		// Broken/full/unsupported sinks must never prevent native failure exit.
	}
}

/** Bypass exit hooks: neither report I/O nor an exit listener may hold a failed gate open. */
export function exitGateProcess(exitCode: number): never {
	if (process.platform === "win32") {
		const kernel = dlopen("kernel32.dll", {
			ExitProcess: { args: [FFIType.u32], returns: FFIType.void },
		});
		kernel.symbols.ExitProcess(exitCode);
	} else {
		const libc = openGateLibc({
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
		writeGateDiagnostic(2, `CLEANUP_FAIL: could not launch owned cross-OS cancellation: ${String(error)}\n`);
	}
}

/** A separate thread enforces the deadline even while the scheduler blocks synchronously. */
export function startGateWatchdog(
	level: string,
	limitMs: number,
	elapsedMs: number,
	onFailure: (error: unknown) => void,
): GateWatchdog {
	// stopped, charged, compile, elapsed, compile-only, wall limit, startup failure code/deadline.
	const state = new BigInt64Array(new SharedArrayBuffer(8 * BigInt64Array.BYTES_PER_ELEMENT));
	Atomics.store(state, 5, BigInt(Math.round(limitMs * 1e6)));
	const ready = Promise.withResolvers<void>();
	const worker = new Worker(new URL(import.meta.url), {
		workerData: {
			level,
			limitMs,
			started: gateClockNanoseconds() - BigInt(Math.round(elapsedMs * 1e6)),
			state: state.buffer,
			output: outputBuffer,
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
		failStartup(exitCode) {
			if (Atomics.compareExchange(state, 6, 0n, BigInt(exitCode)) !== 0n) return;
			// Only startup interruption may wait for readable-sink initialization.
			// Bound it independently, never extending the original wall deadline.
			Atomics.store(state, 7, gateClockNanoseconds() + 100_000_000n);
			worker.postMessage({ kind: "deadline" } satisfies WatchdogMessage);
		},
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
		const wallDeadline = data.started + Atomics.load(state, 5);
		const startupDeadline = Atomics.load(state, 7);
		const deadline = startupDeadline > 0n && startupDeadline < wallDeadline ? startupDeadline : wallDeadline;
		const now = gateClockNanoseconds();
		if (now < deadline) {
			timer = setTimeout(checkDeadline, Math.max(1, Number(deadline - now) / 1e6));
			return;
		}
		const startupFailure = Atomics.load(state, 6);
		if (startupFailure !== 0n) exitGateProcess(Number(startupFailure));
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
				writeGateDiagnostic(
					2,
					`OMP_GATE_EVENT ${token} ${JSON.stringify({ id: "wall-watchdog", kind: "failure", exitCode: 124, status: "TIMEOUT", message: "Total wall-clock deadline exhausted" })}\n`,
				);
			}
			writeGateDiagnostic(
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
