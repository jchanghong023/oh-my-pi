import { describe, expect, test } from "bun:test";
import { conclusionExitCode, parseSlowtestArgs, pickTriggeredRun, type GhRunSummary } from "./slowtest.ts";

const TRIGGERED_AT = Date.parse("2026-09-18T10:00:00Z");

function run(overrides: Partial<GhRunSummary>): GhRunSummary {
	return {
		databaseId: 1,
		status: "queued",
		conclusion: null,
		headSha: "a".repeat(40),
		createdAt: new Date(TRIGGERED_AT + 5_000).toISOString(),
		url: "https://github.com/example/example/actions/runs/1",
		...overrides,
	};
}

describe("pickTriggeredRun", () => {
	test("matches the run for the pushed head sha", () => {
		const match = run({ databaseId: 7 });
		expect(pickTriggeredRun([run({ headSha: "b".repeat(40) }), match], "a".repeat(40), TRIGGERED_AT)).toBe(match);
	});

	test("prefers the newest matching run", () => {
		const older = run({ databaseId: 7, createdAt: new Date(TRIGGERED_AT + 5_000).toISOString() });
		const newer = run({ databaseId: 8, createdAt: new Date(TRIGGERED_AT + 60_000).toISOString() });
		expect(pickTriggeredRun([older, newer], "a".repeat(40), TRIGGERED_AT)?.databaseId).toBe(8);
	});

	test("rejects runs created before the trigger moment beyond clock-skew slack", () => {
		const stale = run({ databaseId: 9, createdAt: new Date(TRIGGERED_AT - 10 * 60_000).toISOString() });
		expect(pickTriggeredRun([stale], "a".repeat(40), TRIGGERED_AT)).toBeUndefined();
	});

	test("ignores runs with unparseable creation timestamps", () => {
		const invalid = run({ createdAt: "not-a-date" });
		expect(pickTriggeredRun([invalid], "a".repeat(40), TRIGGERED_AT)).toBeUndefined();
	});

	test("returns undefined when nothing matches", () => {
		expect(pickTriggeredRun([], "a".repeat(40), TRIGGERED_AT)).toBeUndefined();
	});
});

describe("conclusionExitCode", () => {
	test("success is the only green conclusion", () => {
		expect(conclusionExitCode("success")).toBe(0);
		expect(conclusionExitCode("failure")).toBe(1);
		expect(conclusionExitCode("cancelled")).toBe(1);
		expect(conclusionExitCode(null)).toBe(1);
	});
});

describe("parseSlowtestArgs", () => {
	test("no arguments defaults to a non-debug run", () => {
		expect(parseSlowtestArgs([])).toEqual({ debug: false });
	});

	test("--debug forwards to fulltest", () => {
		expect(parseSlowtestArgs(["--debug"])).toEqual({ debug: true });
	});

	test("unknown arguments are rejected", () => {
		expect(parseSlowtestArgs(["--release"])).toBeNull();
		expect(parseSlowtestArgs(["--debug", "extra"])).toBeNull();
	});
});
