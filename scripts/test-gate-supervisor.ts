#!/usr/bin/env bun
import { dlopen, FFIType } from "bun:ffi";

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
		} catch {
			/* Try the installed platform libc soname. */
		}
	}
	if (!libc || libc.symbols.prctl(36, 1, 0, 0, 0) !== 0)
		throw new Error("Cannot establish owned Linux child subreaper");
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

let started = false;
// Stay alive after the real leader exits, so the parent's ownership reference
// remains valid until descendants are gone and command output reaches EOF.
let reaping = false;
setInterval(async () => {
	if (!started || reaping || !reapChildren) return;
	reaping = true;
	try {
		await reapChildren();
	} finally {
		reaping = false;
	}
}, 5);
process.on("message", async (message: unknown) => {
	if (message === "cleanup") {
		finished = true;
		return;
	}
	if (started || message !== "start") return;
	started = true;
	try {
		const argv: unknown = JSON.parse(process.env.OMP_GATE_SUPERVISED_COMMAND ?? "null");
		if (!Array.isArray(argv) || !argv.every(arg => typeof arg === "string"))
			throw new Error("Invalid supervised command");
		delete process.env.OMP_GATE_SUPERVISED_COMMAND;
		const child = Bun.spawn(argv, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env: process.env,
			windowsHide: true,
		});
		commandPid = child.pid;
		const exitCode = await child.exited;
		finished = true;
		process.send?.({ exitCode });
	} catch (error) {
		finished = true;
		process.send?.({
			exitCode: (error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1,
			error: error instanceof Error ? error.message : String(error),
			missing: (error as NodeJS.ErrnoException).code === "ENOENT",
		});
	}
});
process.send?.({ ready: true });
