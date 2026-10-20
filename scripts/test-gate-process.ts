import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { terminateOwnedSubprocess } from "../packages/utils/src/subprocess";
import { openGateLibc } from "./test-gate-libc";

export interface PersistentBazelClient {
	pid: number;
	exited: Promise<number>;
	cancel(): Promise<void>;
}

/** Only the native client sees this environment; payloads recover runtime
 * capabilities from context.json after hosted request validation. */
export function nativeBazelEnvironment(
	env: Record<string, string | undefined>,
	host: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const cacheKeys =
		platform === "win32" ? /^(?:HOME|USERPROFILE|XDG_CACHE_HOME)$/i : /^(?:HOME|USERPROFILE|XDG_CACHE_HOME)$/;
	// Keep system/tool/cache/proxy settings, not provider credentials or runtime
	// capabilities: Bazel records the client's environment in the raw BEP.
	const credentials =
		/(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTH|COOKIE|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|EXTRAHEADER|CONNECTION[_-]?STRING)/i;
	const runtime = /^(?:OMP_GATE_|OMP_TEST_(?:RUN|REPORT)|BUN_TEST_REPORT)/i;
	const entries = Object.entries(env).filter(
		(entry): entry is [string, string] =>
			entry[1] !== undefined &&
			(platform === "win32" ? entry[0].toUpperCase() : entry[0]) !== "TEST_TMPDIR" &&
			!cacheKeys.test(entry[0]) &&
			!credentials.test(entry[0]) &&
			!runtime.test(entry[0]),
	);
	for (const [key, value] of Object.entries(host)) {
		if (value !== undefined && cacheKeys.test(key)) entries.push([key, value]);
	}
	return Object.fromEntries(entries);
}

/** One native client owns its CancelRequest; never signal a shared JVM.
 * Bazel 9.2 blaze.cc CancelThread/SendCancelMessage; Windows
 * blaze_util_windows.cc ConsoleCtrlHandler handles CTRL_BREAK identically. */
export function spawnPersistentBazel(
	argv: string[],
	options: { cwd: string; env: Record<string, string | undefined> } = { cwd: process.cwd(), env: process.env },
): PersistentBazelClient {
	// Only the final native host selects tool caches. A broker request carries
	// the application's isolated HOME, not the host's installation/download root.
	// Tests still receive their own HOME and the explicit --test_tmpdir.
	const environmentEntries = Object.entries(nativeBazelEnvironment(options.env));
	if (process.platform !== "win32") {
		const child = Bun.spawn(argv, {
			...options,
			env: Object.fromEntries(environmentEntries),
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			detached: true,
		});
		let cancelled = false;
		return {
			pid: child.pid,
			exited: child.exited,
			async cancel() {
				if (!cancelled && child.exitCode === null) {
					cancelled = true;
					// The native client sends its invocation's CancelRequest. Do not
					// signal a process group that could contain unrelated descendants.
					process.kill(child.pid, "SIGINT");
				}
				await child.exited;
			},
		};
	}
	const kernel = dlopen("kernel32.dll", {
		CreateProcessW: {
			args: [
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.i32,
				FFIType.u32,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
			],
			returns: FFIType.i32,
		},
		GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },
		SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
		GetConsoleCP: { args: [], returns: FFIType.u32 },
		AllocConsole: { args: [], returns: FFIType.i32 },
		GenerateConsoleCtrlEvent: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
		GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
		IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
		ResumeThread: { args: [FFIType.u64], returns: FFIType.u32 },
		TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
	const stdHandles = [-10, -11, -12].map(value => Number(kernel.symbols.GetStdHandle(value >>> 0)));
	for (const handle of stdHandles) {
		if (handle && handle !== -1 && !kernel.symbols.SetHandleInformation(handle, 1, 1)) {
			kernel.close();
			throw new Error("Cannot inherit native Bazel output handles");
		}
	}
	// A hidden Bun supervisor may have no console. Give this runner its own
	// console, never attach to another agent's console or broadcast Ctrl-C.
	if (!kernel.symbols.GetConsoleCP() && !kernel.symbols.AllocConsole()) {
		kernel.close();
		throw new Error("Cannot establish native Bazel cancellation console");
	}
	const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`;
	const executable = Bun.which(argv[0]!) ?? argv[0]!;
	const image = Buffer.from(`${executable}\0`, "utf16le");
	const command = Buffer.from(`${[executable, ...argv.slice(1)].map(quote).join(" ")}\0`, "utf16le");
	const directory = Buffer.from(`${options.cwd}\0`, "utf16le");
	const environment = Buffer.from(
		`${environmentEntries
			.sort(([left], [right]) => left.toUpperCase().localeCompare(right.toUpperCase()))
			.map(([key, value]) => `${key}=${value}`)
			.join("\0")}\0\0`,
		"utf16le",
	);
	const startup = new Uint8Array(104);
	const startupView = new DataView(startup.buffer);
	startupView.setUint32(0, 104, true);
	startupView.setUint32(60, 0x101, true); // USESTDHANDLES | USESHOWWINDOW (hidden)
	for (const [index, offset] of [80, 88, 96].entries())
		startupView.setBigUint64(offset, BigInt(stdHandles[index]!), true);
	const information = new Uint8Array(24);
	if (
		!kernel.symbols.CreateProcessW(
			ptr(image),
			ptr(command),
			null,
			null,
			1,
			0x01000000 | 0x4 | 0x200 | 0x400, // BREAKAWAY_FROM_JOB | SUSPENDED | NEW_PROCESS_GROUP | UNICODE_ENVIRONMENT
			ptr(environment),
			ptr(directory),
			ptr(startup),
			ptr(information),
		)
	) {
		const error = kernel.symbols.GetLastError();
		kernel.close();
		throw new Error(`Cannot launch cancellable native Bazel client (Windows error ${error})`);
	}
	const info = new DataView(information.buffer);
	const handle = Number(info.getBigUint64(0, true));
	const thread = Number(info.getBigUint64(8, true));
	// BREAKAWAY can succeed yet stop at a non-breakaway ancestor (Windows
	// nested-jobs contract). Bazel 9.2 WaitableProcess creates precisely such
	// a KILL_ON_JOB_CLOSE Job; DETACHED_PROCESS in ExecuteDaemon does not escape it.
	// Nested tests must use the authenticated outer host, not weaken this proof.
	// https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs
	const inJob = new Uint8Array(4);
	const queried = kernel.symbols.IsProcessInJob(handle, 0, ptr(inJob));
	const queryError = queried ? undefined : kernel.symbols.GetLastError();
	const retainedJob = queried && new DataView(inJob.buffer).getUint32(0, true) !== 0;
	const resumeFailed = queried && !retainedJob && kernel.symbols.ResumeThread(thread) === 0xffffffff;
	const resumeError = resumeFailed ? kernel.symbols.GetLastError() : undefined;
	if (!queried || retainedJob || resumeFailed) {
		kernel.symbols.TerminateProcess(handle, 1);
		kernel.symbols.CloseHandle(thread);
		kernel.symbols.CloseHandle(handle);
		kernel.close();
		throw new Error(
			!queried
				? `Cannot query native Bazel Job membership (Windows error ${queryError})`
				: retainedJob
					? "Native Bazel retained an ancestor Windows Job; an authenticated outer gate host is required"
					: `Cannot resume native Bazel client (Windows error ${resumeError})`,
		);
	}
	kernel.symbols.CloseHandle(thread);
	const pid = info.getUint32(16, true);
	let settled = false;
	let cancelled = false;
	const exited = (async () => {
		const code = new Uint8Array(4);
		try {
			for (;;) {
				if (!kernel.symbols.GetExitCodeProcess(handle, ptr(code)))
					throw new Error("Cannot await native Bazel client");
				const value = new DataView(code.buffer).getUint32(0, true);
				if (value !== 259) return value;
				await Bun.sleep(5);
			}
		} finally {
			settled = true;
			kernel.symbols.CloseHandle(handle);
			kernel.close();
		}
	})();
	return {
		pid,
		exited,
		async cancel() {
			if (!settled && !cancelled) {
				cancelled = true;
				if (!kernel.symbols.GenerateConsoleCtrlEvent(1, pid))
					throw new Error(
						`Cannot cancel native Bazel invocation (Windows error ${kernel.symbols.GetLastError()})`,
					);
			}
			await exited;
		},
	};
}

/** The supervisor, not a fallible reporting runner, owns every native client. */
export async function requestPersistentBazel(
	argv: string[],
	payload?: { charged: boolean },
	options: { cwd: string; env: Record<string, string | undefined> } = { cwd: process.cwd(), env: { ...process.env } },
): Promise<PersistentBazelClient> {
	const id = randomUUID();
	let resolveStarted!: (pid: number) => void;
	let rejectStarted!: (error: Error) => void;
	const started = new Promise<number>((resolve, reject) => {
		resolveStarted = resolve;
		rejectStarted = reject;
	});
	let resolveExited!: (code: number) => void;
	const exited = new Promise<number>(resolve => {
		resolveExited = resolve;
	});
	const receive = (message: unknown) => {
		if (!message || typeof message !== "object" || !("id" in message) || message.id !== id || !("type" in message))
			return;
		if (message.type === "native-bazel-started" && "pid" in message && typeof message.pid === "number")
			resolveStarted(message.pid);
		if (message.type === "native-bazel-exited" && "exitCode" in message && typeof message.exitCode === "number") {
			rejectStarted(new Error("Native Bazel launch failed"));
			resolveExited(message.exitCode);
			process.off("message", receive);
			process.off("disconnect", disconnected);
		}
	};
	const disconnected = () => {
		rejectStarted(new Error("Native Bazel owner disconnected"));
		resolveExited(130);
		process.off("message", receive);
	};
	process.on("message", receive);
	process.once("disconnect", disconnected);
	if (!process.connected) disconnected();
	else process.send?.({ type: "native-bazel-start", id, argv, ...options, payload });
	const pid = await started;
	return {
		pid,
		exited,
		async cancel() {
			if (process.connected) process.send?.({ type: "native-bazel-cancel", id });
			await exited;
		},
	};
}

/** Reuse the enclosing gate host across Bazel's non-breakaway test Job. */
export async function requestHostedPersistentBazel(
	broker: { url: string; token: string },
	argv: string[],
	options: { cwd: string; env: Record<string, string | undefined> },
): Promise<PersistentBazelClient> {
	const id = randomUUID();
	const headers = { authorization: `Bearer ${broker.token}`, "content-type": "application/json" };
	const response = await fetch(new URL("native", broker.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ id, argv, ...options }),
	});
	if (!response.ok || !response.body)
		throw new Error(`Outer native Bazel host rejected launch (${response.status}): ${await response.text()}`);
	const started = Promise.withResolvers<number>();
	const exited = (async () => {
		let text = "";
		const decoder = new TextDecoder();
		for await (const chunk of response.body!) {
			text += decoder.decode(chunk, { stream: true });
			let newline: number;
			while ((newline = text.indexOf("\n")) !== -1) {
				const event = JSON.parse(text.slice(0, newline)) as { pid?: number; exitCode?: number; error?: string };
				text = text.slice(newline + 1);
				if (event.error) throw new Error(event.error);
				if (Number.isSafeInteger(event.pid) && event.pid! > 0) started.resolve(event.pid!);
				if (Number.isInteger(event.exitCode)) {
					started.reject(new Error(`Outer native Bazel launch ended before readiness (exit ${event.exitCode})`));
					return event.exitCode!;
				}
			}
		}
		throw new Error("Outer native Bazel host disconnected before native exit");
	})();
	void exited.catch(error => started.reject(error));
	let pid: number;
	try {
		pid = await started.promise;
	} catch (error) {
		await exited.catch(() => {});
		throw error;
	}
	return {
		pid,
		exited,
		async cancel() {
			const cancelled = await fetch(new URL("native/cancel", broker.url), {
				method: "POST",
				headers,
				body: JSON.stringify({ id }),
			});
			if (!cancelled.ok) throw new Error(`Outer native Bazel host rejected cancellation (${cancelled.status})`);
			await exited;
		},
	};
}

export interface PersistentBazelRelay {
	(message: unknown): boolean;
	disconnect(): void;
}

/** Relay nested discovery clients to the same supervisor ownership registry. */
export function relayPersistentBazel(child: Bun.Subprocess): PersistentBazelRelay {
	const ids = new Set<string>();
	const receive = (message: unknown) => {
		if (
			!message ||
			typeof message !== "object" ||
			!("id" in message) ||
			typeof message.id !== "string" ||
			!ids.has(message.id)
		)
			return;
		if (!("type" in message) || (message.type !== "native-bazel-started" && message.type !== "native-bazel-exited"))
			return;
		try {
			child.send(message);
		} catch {}
		if (message.type === "native-bazel-exited") ids.delete(message.id);
	};
	process.on("message", receive);
	const disconnect = () => {
		for (const id of ids) if (process.connected) process.send?.({ type: "native-bazel-cancel", id });
		ids.clear();
		process.off("message", receive);
	};
	void child.exited.then(disconnect, disconnect);
	return Object.assign(
		(message: unknown) => {
			if (
				!message ||
				typeof message !== "object" ||
				!("type" in message) ||
				!("id" in message) ||
				typeof message.id !== "string"
			)
				return false;
			if (message.type !== "native-bazel-start" && message.type !== "native-bazel-cancel") return false;
			if (message.type === "native-bazel-start") ids.add(message.id);
			if (ids.has(message.id) && process.connected) process.send?.(message);
			return true;
		},
		{ disconnect },
	);
}

export interface GateProcessOwner {
	terminate(): Promise<void>;
	release(): Promise<void>;
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

async function linuxChildren(pid: number): Promise<number[]> {
	let tasks: string[];
	try {
		tasks = await fs.readdir(`/proc/${pid}/task`);
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
		throw error;
	}
	const children = new Set<number>();
	for (const task of tasks) {
		let text: string;
		try {
			text = await fs.readFile(`/proc/${pid}/task/${task}/children`, "utf8");
		} catch (error) {
			if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
			throw error;
		}
		for (const value of text.trim().split(/\s+/)) {
			const child = Number(value);
			if (child > 0) children.add(child);
		}
	}
	return [...children];
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

/** Refuse work before readiness without safe pidfd ownership and child enumeration. */
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
	// The main task cannot exit while this synchronous probe runs. ENOENT here
	// means the kernel lacks the interface, not the normal disappearing-task race
	// that descendant traversal must tolerate after readiness.
	try {
		readFileSync(`/proc/self/task/${process.pid}/children`, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw Object.assign(
				new Error("MISSING_TOOL: Safe Linux gate ownership requires proc task children (CONFIG_PROC_CHILDREN)", {
					cause: error,
				}),
				{ code: "ENOENT" },
			);
		throw error;
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
			// Traverse only children of this subreaper and stopped owned ancestors.
			// Unrelated procfs entries may be unreadable under hidepid; an owned
			// task/identity read failure must still reject cleanup.
			const ordered = [root];
			const owned = new Set(ordered);
			let stopped = 0;
			for (let index = 0; index < ordered.length; index++) {
				const parent = ordered[index];
				const ancestor = registry.get(parent);
				if (ancestor) {
					const live = await linuxIdentity(parent);
					if (live?.start !== ancestor.start || (live.state !== "T" && live.state !== "t")) continue;
				}
				for (const pid of await linuxChildren(parent)) {
					const entry = await linuxIdentity(pid);
					if (!entry || entry.parent !== ordered[index] || owned.has(entry.pid)) continue;
					if (ancestor) {
						// A stopped ancestor can still be killed externally. Do not
						// trust numeric child edges after that ancestor was replaced.
						const live = await linuxIdentity(parent);
						if (live?.start !== ancestor.start || (live.state !== "T" && live.state !== "t")) break;
					}
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
export async function ownGateProcess(
	child: Bun.Subprocess,
	detached: boolean,
	persistentBazel = false,
): Promise<GateProcessOwner> {
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
			// Only native clients explicitly request breakaway. Ordinary payload
			// Jobs keep both breakaway flags disabled, including nested payloads.
			new DataView(limits.buffer).setUint32(16, persistentBazel ? 0x800 : 0x2000, true);
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
				if (persistentBazel) {
					child.send("abort");
					await child.exited;
					return;
				}
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
			async release() {
				if (closed) return;
				const limits = new Uint8Array(144);
				if (!kernel.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength))
					throw new Error(`Cannot disarm persistent Bazel Job Object (error ${kernel.symbols.GetLastError()})`);
				child.send("release");
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
			if (persistentBazel) {
				child.send("abort");
				await child.exited;
				return;
			}
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
		async release() {
			child.send("release");
			await child.exited;
		},
		close() {},
	};
}
