#!/usr/bin/env bun
// Fork-local: PTY smoke test for the interactive TUI started by `bun run dev`.
// Spawns packages/coding-agent/src/cli.ts in a real PTY (ConPTY on Windows,
// openpty on POSIX) through the locally built pi-natives addon, waits for the
// full-screen interface to render, probes that the input loop is live, then
// exits the app cleanly. No network access, no auto-downloaded addons.

import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";

const repoRoot = path.resolve(import.meta.dir, "..");

interface Outcome {
	exitCode?: number;
	cancelled: boolean;
	timedOut: boolean;
}

const debugDump = process.argv.includes("--debug");

const session = new PtySession();
let output = "";
let totalBytes = 0;
let exited: ((outcome: Outcome) => void) | undefined;
const exitPromise = new Promise<Outcome>(resolve => {
	exited = resolve;
});
const result = session.startArgv(
	{
		application: process.execPath,
		args: ["--cwd=packages/coding-agent", "src/cli.ts", "--offline", "--profile", "localci-ui"],
		cwd: repoRoot,
		cols: 120,
		rows: 30,
		env: {
			...process.env,
			TERM: "xterm-256color",
			NO_UPDATE_CHECK: "1",
		} as Record<string, string>,
	},
	(error, chunk) => {
		if (error) return;
		output += chunk;
		totalBytes += chunk.length;
		if (debugDump) process.stdout.write(chunk);
	},
	(error, pid) => {
		if (error) console.error(`dev-ui-test: failed to start PTY child: ${error.message}`);
		else console.log(`dev-ui-test: child pid ${pid}`);
	},
);
result.then(
	outcome => exited?.(outcome as Outcome),
	error => fail(`PTY session failed: ${error instanceof Error ? error.message : String(error)}`),
);

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await sleep(200);
	}
	return condition();
}

function fail(message: string): never {
	console.error(`dev-ui-test: FAIL — ${message}`);
	// The ConPTY/openpty handle dying with this process does not guarantee the
	// child dies with it; kill the dev TUI so failed runs leave no orphan. The
	// non-zero-exit path gets here after the child already tore the session
	// down, where kill() rejects — nothing left to clean up then.
	try {
		session.kill();
	} catch {}
	process.exit(1);
}

// ── 1. Startup render ────────────────────────────────────────────────────────
console.log("dev-ui-test: waiting for the full-screen interface to render…");
const rendered = await waitFor(() => {
	// The TUI repaints in place: hides the cursor, positions it absolutely,
	// and paints the status line (which always names the active primary
	// agent "Main" under fork defaults). It does not use the alternate screen.
	const cursorControl = output.includes("\x1b[?25l") || output.includes("\x1b[H") || /\x1b\[\d+;\d+H/.test(output);
	return cursorControl && output.includes("Main") && totalBytes > 4_000;
}, 120_000);
if (!rendered) {
	fail(
		`interface did not render within 120 s (bytes=${totalBytes}, cursorControl=${/\x1b\[\?25l|\x1b\[H|\x1b\[\d+;\d+H/.test(output)}, mainMarker=${output.includes("Main")})`,
	);
}
console.log(`dev-ui-test: interface rendered (${totalBytes} bytes captured)`);

// ── 2. Liveness probe: a keypress must trigger a repaint ────────────────────
const bytesBefore = totalBytes;
session.write("\x1b[Z"); // Shift-Tab (plan mode toggle): always handled by the composer
await sleep(1_500);
session.write("\x1b[Z"); // toggle back
await sleep(1_500);
if (totalBytes <= bytesBefore) {
	fail("no repaint after keypress; the input loop looks dead");
}
console.log(`dev-ui-test: input loop alive (+${totalBytes - bytesBefore} bytes after keypress)`);

// ── 3. Clean exit ───────────────────────────────────────────────────────────
// Ctrl+D is the `app.exit` keybinding in both the startup composer and the
// main session: one press runs the graceful shutdown path (exit code 0).
// Ctrl+C needs a <500 ms double-press and exits 130 mid-teardown, so it is
// deliberately not used here.
console.log("dev-ui-test: sending Ctrl+D to exit…");
session.write("\x04");
const outcome = await Promise.race([exitPromise, sleep(20_000).then(() => undefined)]);
if (!outcome) {
	session.kill();
	fail("TUI did not exit within 20 s after Ctrl+D");
}
if (outcome.exitCode !== 0) {
	fail(`TUI exited with code ${outcome.exitCode} (expected 0)`);
}
console.log("dev-ui-test: PASS — dev TUI renders, reacts, and exits cleanly");
