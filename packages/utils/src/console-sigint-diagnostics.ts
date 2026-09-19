/**
 * Windows console diagnostics recorded when the process-level SIGINT handler
 * fires.
 *
 * On Windows a SIGINT is a console control event: it can originate from the
 * keyboard (Ctrl+C while `ENABLE_PROCESSED_INPUT` is set, Ctrl+Break
 * regardless of raw mode) or from any attached process broadcasting
 * `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` — and it reaches every process
 * sharing the console. The recorded input mode and attached-process list let a
 * post-mortem distinguish those origins (e.g. a sibling process that flipped
 * the shared console back to processed input) instead of guessing.
 *
 * Every failure is contained: diagnostics must never throw inside signal
 * handling. Non-Windows platforms write nothing (their SIGINT sources are not
 * console-wide broadcast events).
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "./dirs";

/** File name (inside the shared logs dir) the diagnostics lines append to. */
export const SIGINT_CONSOLE_DIAGNOSTICS_FILE = "sigint-diagnostics.log";

const STD_INPUT_HANDLE = -10;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** `ENABLE_*` flags of the console input mode that matter for SIGINT origins. */
const INPUT_MODE_FLAGS: ReadonlyArray<[flag: number, name: string]> = [
	[0x0001, "ENABLE_PROCESSED_INPUT"],
	[0x0002, "ENABLE_LINE_INPUT"],
	[0x0004, "ENABLE_ECHO_INPUT"],
	[0x0008, "ENABLE_WINDOW_INPUT"],
	[0x0010, "ENABLE_MOUSE_INPUT"],
	[0x0040, "ENABLE_QUICK_EDIT_MODE"],
	[0x0080, "ENABLE_EXTENDED_FLAGS"],
	[0x0200, "ENABLE_VIRTUAL_TERMINAL_INPUT"],
];

interface ConsoleInputMode {
	mode?: number;
	flags?: string[];
	error?: string;
}

interface ConsoleProcess {
	pid: number;
	name?: string;
	self: boolean;
}

interface SigintConsoleDiagnosticsRecord {
	ts: string;
	platform: string;
	pid: number;
	console: ConsoleInputMode;
	processes?: ConsoleProcess[];
	error?: string;
}

function decodeInputModeFlags(mode: number): string[] {
	return INPUT_MODE_FLAGS.filter(([flag]) => (mode & flag) !== 0).map(([, name]) => name);
}

/**
 * Open kernel32 with the console-probe symbols. A factory function (rather
 * than inline `dlopen` callsites) so `ReturnType` preserves the inferred
 * per-symbol argument signatures for the helpers below.
 */
function openKernel32() {
	return dlopen("kernel32.dll", {
		GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
		GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		QueryFullProcessImageNameW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
}

type Kernel32 = ReturnType<typeof openKernel32>;

/** Read the shared console input mode via kernel32; `{ error }` when unavailable. */
function readConsoleInputMode(kernel32: Kernel32): ConsoleInputMode {
	try {
		const stdinHandle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
		if (!stdinHandle) return { error: "GetStdHandle(STD_INPUT_HANDLE) returned NULL" };
		const mode = new Uint32Array(1);
		if (kernel32.symbols.GetConsoleMode(stdinHandle, mode) === 0) {
			return { error: "GetConsoleMode failed (stdin is not a console handle)" };
		}
		return { mode: mode[0], flags: decodeInputModeFlags(mode[0]) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * List processes attached to the current console with their image names.
 * `GetConsoleProcessList` reports only attached processes, which is exactly the
 * broadcast audience of a console ctrl event.
 */
function listConsoleProcesses(kernel32: Kernel32): ConsoleProcess[] | undefined {
	try {
		const scratch = new Uint32Array(1);
		const needed = kernel32.symbols.GetConsoleProcessList(scratch, 0);
		if (typeof needed !== "number" || needed <= 0) {
			return undefined;
		}
		const pids = new Uint32Array(needed);
		const count = kernel32.symbols.GetConsoleProcessList(pids, needed);
		const result: ConsoleProcess[] = [];
		const bounded = typeof count === "number" && count > 0 ? Math.min(count, needed) : needed;
		for (let i = 0; i < bounded; i++) {
			const pid = pids[i];
			const entry: ConsoleProcess = { pid, self: pid === process.pid };
			const name = queryProcessImageName(kernel32, pid);
			if (name !== undefined) entry.name = name;
			result.push(entry);
		}
		return result;
	} catch {
		return undefined;
	}
}

/** Best-effort image path for a pid; `undefined` when access is denied or the process exited. */
function queryProcessImageName(kernel32: Kernel32, pid: number): string | undefined {
	try {
		// BOOL parameters/returns are 4-byte ints on Win32 — declare them i32.
		const handle = kernel32.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		if (!handle) return undefined;
		try {
			const name = new Uint16Array(1024);
			const size = new Uint32Array(1);
			size[0] = name.length;
			if (kernel32.symbols.QueryFullProcessImageNameW(handle, 0, name, size) === 0) return undefined;
			return new TextDecoder("utf-16le").decode(new Uint8Array(name.buffer, 0, size[0] * 2)).replace(/\0.*$/s, "");
		} finally {
			kernel32.symbols.CloseHandle(handle);
		}
	} catch {
		return undefined;
	}
}

function collectRecord(): SigintConsoleDiagnosticsRecord {
	const record: SigintConsoleDiagnosticsRecord = {
		ts: new Date().toISOString(),
		platform: process.platform,
		pid: process.pid,
		console: {},
	};
	const kernel32 = openKernel32();
	try {
		record.console = readConsoleInputMode(kernel32);
		record.processes = listConsoleProcesses(kernel32);
	} finally {
		kernel32.close();
	}
	return record;
}

/**
 * Append one console-diagnostics line for the current SIGINT to
 * `<logsDir>/sigint-diagnostics.log` (default: the profile logs dir shared
 * with `native-panic-*.log`). Never throws: signal handling must not fail on
 * diagnostics I/O. No-op off Windows.
 */
export function appendSigintConsoleDiagnostics(logsDir?: string): void {
	if (process.platform !== "win32") return;
	try {
		const record = collectRecord();
		const dir = logsDir ?? getLogsDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, SIGINT_CONSOLE_DIAGNOSTICS_FILE), `${JSON.stringify(record)}\n`);
	} catch {
		// Contained by contract: diagnostics must never break signal handling.
	}
}
