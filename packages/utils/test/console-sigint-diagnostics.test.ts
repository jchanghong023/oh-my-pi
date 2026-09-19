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

describe("SIGINT console diagnostics", () => {
	it("appends a JSON line with identity fields (Windows)", () => {
		if (process.platform !== "win32") return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sigint-diag-"));
		try {
			expect(() => appendSigintConsoleDiagnostics(dir)).not.toThrow();
			const record = readLastRecord(dir);
			expect(record.pid).toBe(process.pid);
			expect(record.platform).toBe("win32");
			expect(typeof record.ts).toBe("string");
			// Without a console attached (test runner stdin is a pipe) the mode
			// probe reports a contained error instead of throwing.
			expect(record.console).toBeDefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes nothing off Windows", () => {
		if (process.platform === "win32") return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sigint-diag-"));
		try {
			appendSigintConsoleDiagnostics(dir);
			expect(fs.existsSync(path.join(dir, SIGINT_CONSOLE_DIAGNOSTICS_FILE))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
