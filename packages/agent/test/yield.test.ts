import { afterEach, describe, expect, it, vi } from "bun:test";
import { ExponentialYield, YieldGate } from "@oh-my-pi/pi-agent-core/utils/yield";

const YIELD_INTERVAL_MS = 50;

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Build a gate over an injected clock and a counting sleep so the test drives
 * the gate logic without spying on process-global `Date.now`/`scheduler.wait`.
 * Those globals are shared across files, so under concurrent `bun test` a
 * sibling file's `vi.restoreAllMocks()` could wipe the spies mid-run — the
 * exact race that made the previous singleton-based test flake.
 */
function makeGate(): { gate: YieldGate; advanceBy: (ms: number) => void; sleeps: () => number } {
	let now = 1_000_000;
	const sleep = vi.fn(async () => {});
	const gate = new YieldGate({ now: () => now, sleep });
	return {
		gate,
		advanceBy: (ms: number) => {
			now += ms;
		},
		sleeps: () => sleep.mock.calls.length,
	};
}

describe("YieldGate.yieldIfDue", () => {
	it("sleeps on the first call and gates immediate callers", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);

		advanceBy(YIELD_INTERVAL_MS - 1);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);
	});

	it("sleeps again once the gate window elapses", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);

		advanceBy(YIELD_INTERVAL_MS);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(2);
	});

	it("treats a backward clock jump as due instead of gating forever", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);

		// NTP correction / fake timers can move the wall clock backward; the next
		// call must still yield rather than wait for an interval that never comes.
		advanceBy(-YIELD_INTERVAL_MS * 4);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(2);
	});
});

describe("ExponentialYield.race", () => {
	it("returns the racer's value and cancels the losing sleep", async () => {
		const sleepStarted = Promise.withResolvers<AbortSignal>();
		const sleep = (_ms: number, signal?: AbortSignal) => {
			if (!signal) throw new Error("Expected cancellable sleep");
			sleepStarted.resolve(signal);
			const cancelled = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
			return cancelled.promise;
		};
		const ey = new ExponentialYield({ minMs: 2_000, maxMs: 2_000, sleep });

		const result = await ey.race([Promise.resolve(42)]);
		const losingSignal = await sleepStarted.promise;

		expect(result).toBe(42);
		expect(losingSignal.aborted).toBeTrue();
	});
});
