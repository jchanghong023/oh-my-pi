import { describe, expect, test } from "bun:test";
import { buildFastcheckPhases, FASTCHECK_TIMEOUT_MS, FastcheckTimeoutError } from "./fastcheck.ts";

describe("fastcheck phase plan", () => {
	test("always runs both static passes in order", () => {
		const phases = buildFastcheckPhases({ cargoBinary: "cargo" });
		expect(phases.map(phase => phase.label)).toEqual([
			"static/ts (types + lint + format)",
			"static/rs (cargo check)",
		]);
		expect(phases[0]?.argv).toEqual(["bun", "run", "check:ts"]);
		expect(phases[0]?.env).toBeUndefined();
	});

	test("the Rust pass is a whole-workspace cargo check", () => {
		const rust = buildFastcheckPhases({ cargoBinary: "cargo" }).find(
			phase => phase.label === "static/rs (cargo check)",
		);
		expect(rust?.argv).toEqual(["cargo", "check", "--workspace"]);
	});

	test("resolved cargo binary and rust env reach only the Rust phase", () => {
		const phases = buildFastcheckPhases({
			cargoBinary: "C:/toolchain/cargo.exe",
			rustEnv: { RUSTUP_TOOLCHAIN: "nightly-2026-08-12" },
		});
		expect(phases.filter(phase => phase.env !== undefined).map(phase => phase.label)).toEqual([
			"static/rs (cargo check)",
		]);
		const rust = phases.find(phase => phase.label === "static/rs (cargo check)");
		expect(rust?.argv[0]).toBe("C:/toolchain/cargo.exe");
		expect(rust?.env).toEqual({ RUSTUP_TOOLCHAIN: "nightly-2026-08-12" });
	});
});

describe("wall-clock budget", () => {
	test("the budget is the hard 60s cap from the verification contract", () => {
		expect(FASTCHECK_TIMEOUT_MS).toBe(60_000);
	});

	test("timeout failures are distinguishable from ordinary phase failures", () => {
		expect(new FastcheckTimeoutError(61_234)).toBeInstanceOf(FastcheckTimeoutError);
		expect(new Error("static/rs (cargo check) failed with exit code 101")).not.toBeInstanceOf(FastcheckTimeoutError);
	});

	test("the timeout error reports the budget it blew", () => {
		expect(new FastcheckTimeoutError(61_234).message).toContain("60s wall-clock budget");
	});
});
