/**
 * Terminal stderr guard: keeps unmanaged fd-2 writes off the terminal while a
 * TUI owns the viewport.
 *
 * Native runtimes and libraries can write directly to file descriptor 2 at
 * arbitrary times. Examples include macOS libmalloc diagnostics and Bun HTTP
 * decompression diagnostics on Linux. Those bytes bypass the renderer and
 * paint straight into the viewport.
 *
 * While the TUI owns the terminal, dup fd 2 aside and dup2 a redirect target
 * over it; restore the saved fd whenever terminal ownership is released
 * (external editor, Ctrl+Z suspend, shutdown, crash restore). This mirrors
 * openai/codex#24459, but redirects to the omp log file instead of /dev/null
 * so diagnostics stay greppable and Bun native-crash reports (which abort
 * before any JS cleanup can restore fd 2) are preserved.
 *
 * Only dup2 goes through bun:ffi. The saved copy of fd 2 comes from opening
 * `/dev/fd/2` instead of `dup(2)`, because Bun opens files close-on-exec: a
 * plain dup would leak the terminal into every child spawned without explicit
 * fd handling (Rust `Command`, gitoxide filter drivers), which could then read
 * the user's keystrokes and terminal replies. fcntl is deliberately avoided:
 * it is variadic, and the arm64-darwin ABI passes variadic arguments on the
 * stack, so a fixed-arity FFI signature would read garbage for the third
 * argument.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { prepareLogDirectory } from "./dirs";
import { prepareStderrLog, setLogFileObserver } from "./logger";

const STDOUT_FILENO = 1;
const STDERR_FILENO = 2;

interface LibcFdOps {
	dup2(oldFd: number, newFd: number): number;
}

let libcFdOpsCache: LibcFdOps | null | undefined;

function libcFdOps(): LibcFdOps | null {
	if (libcFdOpsCache !== undefined) return libcFdOpsCache;
	libcFdOpsCache = null;
	if (process.platform === "win32") return null;
	// Darwin: dyld resolves libSystem from the shared cache. Linux: glibc
	// first, then the generic soname for musl-style layouts.
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		try {
			const libc = dlopen(candidate, {
				dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			});
			libcFdOpsCache = libc.symbols;
			return libcFdOpsCache;
		} catch {
			// Try the next candidate; the guard stays inert if none load.
		}
	}
	return libcFdOpsCache;
}

/**
 * True when fd 2 writes would land on the same terminal the TUI paints to:
 * both stdout and stderr are ttys backed by the same device file. A stderr
 * the user already redirected (`2>file`, `2>/dev/null`, a different tty) must
 * keep flowing untouched.
 */
function stderrSharesStdoutTerminal(): boolean {
	if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
	try {
		const stdoutStat = fs.fstatSync(STDOUT_FILENO);
		const stderrStat = fs.fstatSync(STDERR_FILENO);
		return stdoutStat.dev === stderrStat.dev && stdoutStat.ino === stderrStat.ino;
	} catch {
		return false;
	}
}

/** Saved dup of the real stderr while suppression is active, else null. */
let savedStderrFd: number | null = null;

/** Destination of a non-default sink that explicitly reported its active file. */
let redirectTarget: string | null = null;

function openStderrLog(filePath: string, create = false): number {
	const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (create ? fs.constants.O_CREAT : 0);
	if (!prepareLogDirectory(path.dirname(filePath))) return fs.openSync(filePath, flags);
	const fd = fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
			throw new Error("Shared cache stderr log is not private");
		}
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

export interface SuppressTerminalStderrOptions {
	/**
	 * Redirect target path; defaults to the rotating sink's active file, then
	 * /dev/null if the sink cannot provide a file.
	 */
	redirectPath?: string;
	/** Bypass the same-terminal gate. Tests only. */
	force?: boolean;
}

/**
 * Redirect fd 2 away from the terminal while the TUI owns the viewport.
 * Returns true when suppression is (already) active. No-op — returning
 * false — when stderr does not target the stdout terminal or when libc fd
 * operations are unavailable.
 */
export function suppressTerminalStderr(options?: SuppressTerminalStderrOptions): boolean {
	if (savedStderrFd !== null) return true;
	if (!options?.force && !stderrSharesStdoutTerminal()) return false;
	const libc = libcFdOps();
	if (!libc) return false;

	// First, so a fd 2 that cannot be reopened (a socket: Linux refuses
	// `/dev/fd/N` for those) leaves the guard inert with no redirect file made.
	let saved: number;
	try {
		saved = fs.openSync(`/dev/fd/${STDERR_FILENO}`, fs.constants.O_WRONLY);
	} catch {
		return false;
	}

	let redirectFd: number | undefined;
	try {
		const redirectPath = options?.redirectPath ?? redirectTarget ?? prepareStderrLog();
		if (redirectPath !== undefined) {
			redirectFd = openStderrLog(redirectPath, options?.redirectPath !== undefined);
		}
	} catch {
		// The log destination could not be opened; keep native writes off the TUI.
	}
	if (redirectFd === undefined) {
		try {
			redirectFd = fs.openSync("/dev/null", "w");
		} catch {
			fs.closeSync(saved);
			return false;
		}
	}

	if (libc.dup2(redirectFd, STDERR_FILENO) === -1) {
		fs.closeSync(redirectFd);
		fs.closeSync(saved);
		return false;
	}
	fs.closeSync(redirectFd);
	savedStderrFd = saved;
	return true;
}

/**
 * Report the active file of a non-default rotating sink and point fd 2 at it.
 *
 * The sink calls this on every rotation. Without it fd 2 keeps the
 * descriptor opened at TUI start, so after local midnight raw stderr — this
 * process's and every child that inherited fd 2 — keeps landing in the
 * previous day's file, which the sink eventually prunes out from under it.
 *
 * The path is recorded even while suppression is inactive, so a later
 * {@link suppressTerminalStderr} redirects to the live file instead of
 * re-deriving a dated name. Best-effort: if the new file cannot be opened,
 * fd 2 keeps its current target.
 */
export function setStderrRedirectTarget(logPath: string): void {
	redirectTarget = logPath;
	redirectStderrToLog(logPath);
}

function redirectStderrToLog(logPath: string): void {
	if (savedStderrFd === null) return;
	const libc = libcFdOps();
	if (!libc) return;
	let redirectFd: number;
	try {
		redirectFd = openStderrLog(logPath);
	} catch {
		return;
	}
	libc.dup2(redirectFd, STDERR_FILENO);
	fs.closeSync(redirectFd);
}

setLogFileObserver(redirectStderrToLog);

/**
 * Re-point fd 2 at the saved terminal stderr. Safe to call unconditionally:
 * no-op when suppression is not active. Called at every terminal-ownership
 * release and by the postmortem fatal handlers before they print, so crash
 * reports reach the real terminal.
 */
export function restoreTerminalStderr(): void {
	if (savedStderrFd === null) return;
	const saved = savedStderrFd;
	savedStderrFd = null;
	libcFdOps()?.dup2(saved, STDERR_FILENO);
	try {
		fs.closeSync(saved);
	} catch {
		// The dup'ed fd is process-owned; a close failure leaves nothing to recover.
	}
}

/** Whether fd 2 is currently redirected away from the terminal. */
export function isTerminalStderrSuppressed(): boolean {
	return savedStderrFd !== null;
}
