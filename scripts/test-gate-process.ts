import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import { terminateOwnedSubprocess } from "../packages/utils/src/subprocess";

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
					// Freeze the owned group before walking the live subreaper's
					// adopted children; escaped sessions are frozen by stable identity.
					try {
						process.kill(-identity.pid, "SIGSTOP");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
					const registry = new Map<number, LinuxIdentity>();
					const freezeDeadline = performance.now() + 1000;
					try {
						for (;;) {
							const processes = (
								await Promise.all(
									(await fs.readdir("/proc"))
										.filter(name => /^\d+$/.test(name))
										.map(name => linuxIdentity(Number(name))),
								)
							).filter((value): value is LinuxIdentity => value !== undefined);
							const ordered = [identity];
							const owned = new Set([identity.pid]);
							for (let index = 0; index < ordered.length; index++) {
								for (const entry of processes) {
									if (entry.parent !== ordered[index].pid || owned.has(entry.pid)) continue;
									owned.add(entry.pid);
									ordered.push(entry);
								}
							}
							let stopped = 0;
							for (const entry of ordered.slice(1)) {
								registry.set(entry.pid, entry);
								const live = await linuxIdentity(entry.pid);
								if (
									live?.start !== entry.start ||
									live.state === "Z" ||
									live.state === "T" ||
									live.state === "t"
								)
									continue;
								try {
									process.kill(entry.pid, "SIGSTOP");
									stopped++;
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
								}
							}
							if (stopped === 0) break;
							if (performance.now() >= freezeDeadline)
								throw new Error("Owned Linux descendants did not quiesce");
						}
					} finally {
						try {
							for (const entry of [...registry.values()].reverse()) {
								const live = await linuxIdentity(entry.pid);
								if (live?.start !== entry.start || live.state === "Z") continue;
								try {
									process.kill(entry.pid, "SIGKILL");
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
								}
							}
							child.send("cleanup");
							try {
								process.kill(identity.pid, "SIGCONT");
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
							}
							const deadline = performance.now() + 1000;
							for (;;) {
								const present = (
									await Promise.all(
										[...registry.values()].map(async entry => {
											const live = await linuxIdentity(entry.pid);
											return live?.start === entry.start;
										}),
									)
								).some(Boolean);
								if (!present) break;
								if (performance.now() >= deadline)
									throw new Error("Owned Linux descendants survived termination or reaping");
								const waiting = Promise.withResolvers<void>();
								setTimeout(waiting.resolve, 5);
								await waiting.promise;
							}
						} finally {
							await terminateOwnedSubprocess(child, { detached });
						}
					}
				}
			}
			await terminateOwnedSubprocess(child, { detached });
		},
		close() {},
	};
}
