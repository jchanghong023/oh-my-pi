import { describe, expect, it } from "bun:test";
import { appendSigintConsoleDiagnostics, SIGINT_CONSOLE_DIAGNOSTICS_FILE } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The diagnostics record exists so a SIGINT received without a keyboard
// Ctrl+C can be attributed post-mortem: console input mode (was processed
// input on?) and the list of processes sharing the console (who could have
// broadcast a ctrl event?). It must never throw inside signal handling and
// must stay hermetic (write to a caller-provided dir in tests).

function readLastRecord(dir: string): Record<string, unknown> {
	const file = path.join(dir, SIGINT_CONSOLE_DIAGNOSTICS_FILE);
	const lines = fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter(line => line.trim() !== "");
	expect(lines.length).toBeGreaterThan(0);
	return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

async function writeChildDiagnostics(dir: string, attachConsole: boolean): Promise<number> {
	const source = `
		import { dlopen } from "bun:ffi";
		import { appendSigintConsoleDiagnostics } from "@oh-my-pi/pi-utils";
		const kernel32 = dlopen("kernel32.dll", {
			FreeConsole: { args: [], returns: "i32" },
			AllocConsole: { args: [], returns: "i32" },
		});
		try {
			kernel32.symbols.FreeConsole();
			if (${attachConsole} && !kernel32.symbols.AllocConsole()) {
				throw new Error("AllocConsole failed for diagnostics fixture");
			}
			appendSigintConsoleDiagnostics(${JSON.stringify(dir)});
		} finally {
			kernel32.symbols.FreeConsole();
			kernel32.close();
		}
	`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
		windowsHide: true,
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(code, stderr).toBe(0);
	return child.pid;
}

describe("SIGINT console diagnostics", () => {
	it.skipIf(process.platform !== "win32")("records processes in an explicitly attached child console", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sigint-diag-"));
		try {
			const childPid = await writeChildDiagnostics(dir, true);
			const record = readLastRecord(dir);
			expect(record.pid).toBe(childPid);
			expect(record.platform).toBe("win32");
			expect(typeof record.ts).toBe("string");
			expect(record.console).toBeDefined();
			expect(record.processes).toEqual(
				expect.arrayContaining([expect.objectContaining({ pid: childPid, self: true })]),
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "win32")("contains console-probe failure in a detached child", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sigint-diag-detached-"));
		try {
			const childPid = await writeChildDiagnostics(dir, false);
			const record = readLastRecord(dir);
			expect(record.pid).toBe(childPid);
			expect(record.console).toEqual({ error: expect.any(String) });
			expect(record.processes).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("writes nothing off Windows", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sigint-diag-"));
		try {
			appendSigintConsoleDiagnostics(dir);
			expect(fs.existsSync(path.join(dir, SIGINT_CONSOLE_DIAGNOSTICS_FILE))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
