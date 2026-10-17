import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { GateCommandError, reportGateFailure } from "./test-gate-runtime";

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
		if (postmortem.isExpectedCleanupError(error)) return;
		reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), 1));
	};
	process.prependListener("uncaughtException", report);
	process.prependListener("unhandledRejection", report);
}
