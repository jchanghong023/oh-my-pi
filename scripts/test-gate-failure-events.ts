import { hasExpectedCleanupMarker } from "@oh-my-pi/pi-utils/expected-cleanup";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { GATE_EVENT_PREFIX } from "./test-gate-events";
import type { GateStatus } from "./test-gate-runtime";

export class GateCommandError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
		readonly status: GateStatus = "FAIL",
	) {
		super(message);
	}
}
export function gateFailure(error: unknown): GateCommandError {
	return error instanceof GateCommandError
		? error
		: new GateCommandError(error instanceof Error ? error.message : String(error), 1);
}

/** Relay the first concrete nested check/compiler failure before waiting for its other work. */
export function reportGateFailure(error: unknown): void {
	const token = process.env.OMP_GATE_EVENT_TOKEN;
	if (!token) return;
	const failure = gateFailure(error);
	const line = `${GATE_EVENT_PREFIX}${token} ${JSON.stringify({
		id: randomUUID(),
		kind: "failure",
		exitCode: failure.exitCode,
		status: failure.status,
		message: failure.message,
	})}\n`;
	if (process.env.OMP_GATE_EVENT_FILE) appendFileSync(process.env.OMP_GATE_EVENT_FILE, line);
	else process.stderr.write(line);
}

/** Observe Bun's per-case failure marker, not diagnostic text or suite totals. */
export class BunTestFailureObserver {
	readonly #decoder = new TextDecoder();
	#pending = "";
	#reported = false;

	constructor(private readonly onFailure: (error: GateCommandError) => void) {}

	push(bytes: Uint8Array): void {
		this.#observe(this.#decoder.decode(bytes, { stream: true }));
	}

	end(): void {
		this.#observe(`${this.#decoder.decode()}\n`);
	}

	#observe(text: string): void {
		if (this.#reported) return;
		this.#pending += text;
		let start = 0;
		for (;;) {
			const end = this.#pending.indexOf("\n", start);
			if (end === -1) break;
			const line = this.#pending
				.slice(start, end)
				.replace(/\x1b\[[0-9;]*m/g, "")
				.replace(/\r$/, "");
			// Bun's stderr case result includes a duration. Requiring the full
			// marker avoids ordinary error messages and quoted/indented examples.
			const failed = /^\(fail\) (.+?) \[\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s)\]$/.exec(line);
			if (failed) {
				this.#reported = true;
				this.#pending = "";
				this.onFailure(new GateCommandError(`Bun test failed: ${failed[1]}`, 1));
				return;
			}
			start = end + 1;
		}
		this.#pending = this.#pending.slice(start);
	}
}

/** Notify before existing fatal handlers report or clean up; leave their exit policy intact. */
export function observeGateUnhandledFailures(): void {
	const report = (error: unknown): void => {
		if (hasExpectedCleanupMarker(error)) return;
		reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), 1));
	};
	process.prependListener("uncaughtException", report);
	process.prependListener("unhandledRejection", report);
}
