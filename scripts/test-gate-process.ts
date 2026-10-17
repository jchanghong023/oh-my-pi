import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import { terminateOwnedSubprocess } from "../packages/utils/src/subprocess";
import { openGateLibc } from "./test-gate-libc";

export interface GateProcessOwner {
	terminate(): Promise<void>;
	close(): void;
}
interface LinuxIdentity {
	pid: number;
	parent: number;
	start: string;
	state: string;
}
async function linuxIdentity(pid: number): Promise<LinuxIdentity | undefined> {
	try {
		const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
		const fields = text
			.slice(text.lastIndexOf(") ") + 2)
			.trim()
			.split(/\s+/);
		return { pid, parent: Number(fields[1]), start: fields[19], state: fields[0] };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH")
			return undefined;
		throw error;
	}
}

interface LinuxSignalLibrary {
	symbols: {
		syscall(number: number, arg1: number, arg2: number, arg3: number, arg4: number): number | bigint;
		close(fd: number): number;
	};
}
function openLinuxSignals(): LinuxSignalLibrary {
	return openGateLibc({
		syscall: {
			args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
			returns: FFIType.i64,
		},
		close: { args: [FFIType.i32], returns: FFIType.i32 },
	});
}
let linuxSignals: LinuxSignalLibrary | undefined;

/** Refuse work before readiness on kernels or sandboxes without safe pidfd ownership. */
export function assertLinuxGateSignals(): void {
	const symbols = (linuxSignals ??= openLinuxSignals()).symbols;
	const required =
		"Safe Linux gate ownership requires pidfd_open and pidfd_send_signal (Linux 5.3+ with pidfd syscalls permitted)";
	const fd = Number(symbols.syscall(434, process.pid, 0, 0, 0));
	if (fd < 0) throw new Error(`${required}: pidfd_open failed`);
	try {
		// Signal 0 checks support and permission without changing process state.
		if (Number(symbols.syscall(424, fd, 0, 0, 0)) !== 0) throw new Error(`${required}: pidfd_send_signal failed`);
	} finally {
		symbols.close(fd);
	}
}
async function signalLinuxIdentity(entry: LinuxIdentity, signal: number): Promise<boolean> {
	const symbols = (linuxSignals ??= openLinuxSignals()).symbols;
	// pidfd_open/pidfd_send_signal use these syscall numbers on Linux's
	// supported x64/arm64 architectures. Pin before checking start time so
	// reuse between the identity check and signal cannot target a stranger.
	const fd = Number(symbols.syscall(434, entry.pid, 0, 0, 0));
	if (fd < 0) {
		const live = await linuxIdentity(entry.pid);
		if (live?.start !== entry.start || live.state === "Z") return false;
		throw new Error(`Cannot pin owned Linux process ${entry.pid}`);
	}
	try {
		const live = await linuxIdentity(entry.pid);
		if (live?.start !== entry.start || live.state === "Z") return false;
		if (Number(symbols.syscall(424, fd, signal, 0, 0)) !== 0) {
			const remaining = await linuxIdentity(entry.pid);
			if (remaining?.start === entry.start && remaining.state !== "Z")
				throw new Error(`Cannot signal owned Linux process ${entry.pid}`);
		}
		return true;
	} finally {
		symbols.close(fd);
	}
}

// The live subreaper is the ownership anchor. Never stop it: after its parent
// exits it must still receive disconnect, kill escaped sessions, and reap them.
export async function terminateLinuxGateDescendants(): Promise<void> {
	const root = process.pid;
	const registry = new Map<number, LinuxIdentity>();
	const freezeDeadline = performance.now() + 1000;
	try {
		for (;;) {
			const processes = (
				await Promise.all(
					(await fs.readdir("/proc")).filter(name => /^\d+$/.test(name)).map(name => linuxIdentity(Number(name))),
				)
			).filter((value): value is LinuxIdentity => value !== undefined);
			const ordered = [root];
			const owned = new Set(ordered);
			let stopped = 0;
			for (let index = 0; index < ordered.length; index++) {
				for (const entry of processes) {
					if (entry.parent !== ordered[index] || owned.has(entry.pid)) continue;
					owned.add(entry.pid);
					registry.set(entry.pid, entry);
					let live = await linuxIdentity(entry.pid);
					if (live?.start !== entry.start || live.state === "Z") continue;
					if (live.state !== "T" && live.state !== "t") {
						if (!(await signalLinuxIdentity(entry, 19))) continue;
						stopped++;
					}
					// Only use a stopped, identity-checked ancestor to establish
					// ownership of the next generation. It cannot reap a child
					// whose reused PID would otherwise make a stale /proc edge lie.
					while (live?.start === entry.start && live.state !== "Z" && live.state !== "T" && live.state !== "t") {
						if (performance.now() >= freezeDeadline) throw new Error("Owned Linux descendants did not quiesce");
						await Bun.sleep(1);
						live = await linuxIdentity(entry.pid);
					}
					if (live?.start === entry.start && (live.state === "T" || live.state === "t")) ordered.push(entry.pid);
				}
			}
			if (stopped === 0) break;
			if (performance.now() >= freezeDeadline) throw new Error("Owned Linux descendants did not quiesce");
		}
	} finally {
		for (const entry of [...registry.values()].reverse()) {
			const live = await linuxIdentity(entry.pid);
			if (live?.start !== entry.start || live.state === "Z") continue;
			await signalLinuxIdentity(entry, 9);
		}
	}
}
export async function ownGateProcess(child: Bun.Subprocess, detached: boolean): Promise<GateProcessOwner> {
	if (process.platform === "win32") {
		// Windows HANDLEs are opaque integer values, not FFI pointers.
		const kernel = dlopen("kernel32.dll", {
			CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
			SetInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
			AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
			TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
			QueryInformationJobObject: {
				args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
			CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
		});
		const job = kernel.symbols.CreateJobObjectW(null, null);
		if (!job) {
			kernel.close();
			throw new Error("Cannot create gate-owned Windows Job Object");
		}
		const processHandle = kernel.symbols.OpenProcess(0x101, 0, child.pid);
		let closed = false;
		try {
			// JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows x64/arm64 ABI.
			const limits = new Uint8Array(144);
			new DataView(limits.buffer).setUint32(16, 0x2000, true); // KILL_ON_JOB_CLOSE
			if (
				!kernel.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength) ||
				!processHandle ||
				!kernel.symbols.AssignProcessToJobObject(job, processHandle)
			) {
				throw new Error(
					`Cannot assign gate supervisor to owned Windows Job Object (error ${kernel.symbols.GetLastError()})`,
				);
			}
		} catch (error) {
			if (processHandle) kernel.symbols.CloseHandle(processHandle);
			kernel.symbols.CloseHandle(job);
			kernel.close();
			throw error;
		}
		if (processHandle) kernel.symbols.CloseHandle(processHandle);
		return {
			async terminate() {
				if (closed) return;
				if (!kernel.symbols.TerminateJobObject(job, 1))
					throw new Error(`Cannot terminate owned Windows Job Object (error ${kernel.symbols.GetLastError()})`);
				const accounting = new Uint8Array(48);
				const deadline = performance.now() + 1000;
				for (;;) {
					if (!kernel.symbols.QueryInformationJobObject(job, 1, ptr(accounting), accounting.byteLength, null))
						throw new Error("Cannot query owned Windows Job Object cleanup");
					if (new DataView(accounting.buffer).getUint32(40, true) === 0) break;
					if (performance.now() >= deadline)
						throw new Error("Owned Windows processes survived Job Object termination");
					const waiting = Promise.withResolvers<void>();
					setTimeout(waiting.resolve, 5);
					await waiting.promise;
				}
				await child.exited;
			},
			close() {
				if (closed) return;
				closed = true;
				kernel.symbols.CloseHandle(job);
				kernel.close();
			},
		};
	}
	const identity = process.platform === "linux" ? await linuxIdentity(child.pid) : undefined;
	return {
		async terminate() {
			if (identity) {
				const root = await linuxIdentity(identity.pid);
				if (root?.start === identity.start) {
					// Cleanup runs in the subreaper itself, so parent process.exit()
					// cannot strand a SIGSTOPped supervisor waiting for quiescence.
					try {
						child.send("abort");
					} catch (error) {
						const live = await linuxIdentity(identity.pid);
						if (live?.start === identity.start) throw error;
					}
					const exitCode = await child.exited;
					if (exitCode !== 0)
						throw new Error(`Owned Linux supervisor exited before acknowledging cleanup (exit ${exitCode})`);
					return;
				}
			}
			if (process.platform === "linux") {
				// No live ownership anchor remains. Never signal a numeric PID or
				// group that may already have been reused while Bun consumes exit.
				await child.exited;
				return;
			}
			await terminateOwnedSubprocess(child, { detached });
		},
		close() {},
	};
}
