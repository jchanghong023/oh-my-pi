import { describe, expect, it } from "bun:test";
import { createSigintGate, SIGINT_CONFIRM_WINDOW_MS } from "../../src/modes/sigint-gate";

// The gate exists because a Windows console ctrl event reaches the process as
// a real SIGINT regardless of raw mode, and the historical signal path exited
// on the first hit — destroying a live session with in-flight subagents. These
// tests pin the double-press contract without instantiating the TUI stack.

function makeGate(overrides: { shuttingDown?: boolean } = {}) {
	let clock = 0;
	const hints: number[] = [];
	const gate = createSigintGate({
		isShuttingDown: () => overrides.shuttingDown ?? false,
		showHint: () => hints.push(clock),
		now: () => clock,
	});
	return {
		interceptor: gate.interceptor,
		hints,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("interactive SIGINT double-press gate", () => {
	it("consumes the first signal and shows the hint", () => {
		const { interceptor, hints } = makeGate();
		expect(interceptor()).toBe(true);
		expect(hints).toHaveLength(1);
	});

	it("lets a repeat within the confirm window fall through to the signal exit", () => {
		const { interceptor, advance, hints } = makeGate();
		expect(interceptor()).toBe(true);
		advance(SIGINT_CONFIRM_WINDOW_MS - 1);
		expect(interceptor()).toBe(false);
		// The confirm press defers to the postmortem signal teardown: no hint.
		expect(hints).toHaveLength(1);
	});

	it("consumes again after the confirm window elapsed", () => {
		const { interceptor, advance, hints } = makeGate();
		expect(interceptor()).toBe(true);
		advance(SIGINT_CONFIRM_WINDOW_MS + 1);
		expect(interceptor()).toBe(true);
		expect(hints).toHaveLength(2);
	});

	it("never consumes while teardown is in progress", () => {
		let shuttingDown = false;
		const hints: number[] = [];
		const gate = createSigintGate({
			isShuttingDown: () => shuttingDown,
			showHint: () => hints.push(1),
		});
		expect(gate.interceptor()).toBe(true);
		shuttingDown = true;
		expect(gate.interceptor()).toBe(false);
		expect(gate.interceptor()).toBe(false);
		expect(hints).toHaveLength(1);
	});

	it("starts cold: the gate is armed for the very first signal", () => {
		const { interceptor } = makeGate();
		expect(interceptor()).toBe(true);
	});
});
