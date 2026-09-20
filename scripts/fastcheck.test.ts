import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	buildFastcheckPhases,
	fastcheckBudgetMsFromEnv,
	FASTCHECK_TIMEOUT_MS,
	FASTCHECK_TYPE_CHECK_POOL,
	FastcheckTimeoutError,
	listTypeCheckPackages,
} from "./fastcheck.ts";

describe("fastcheck phase plan", () => {
	test("always runs the three static passes in order", () => {
		const phases = buildFastcheckPhases({ cargoBinary: "cargo" });
		expect(phases.map(phase => phase.label)).toEqual([
			"static/ts (lint + format)",
			"static/ts (types)",
			"static/rs (cargo check)",
		]);
		const [lint, types, rust] = phases;
		expect(lint).toMatchObject({ kind: "command", argv: ["bun", "run", "check:tools"] });
		expect(types).toMatchObject({ kind: "type-checks", pool: FASTCHECK_TYPE_CHECK_POOL });
		expect(rust).toMatchObject({ kind: "command", argv: ["cargo", "check", "--workspace"] });
	});

	test("resolved cargo binary and rust env reach only the Rust phase", () => {
		const phases = buildFastcheckPhases({
			cargoBinary: "C:/toolchain/cargo.exe",
			rustEnv: { RUSTUP_TOOLCHAIN: "nightly-2026-08-12" },
		});
		expect(
			phases.filter(phase => phase.kind === "command" && phase.env !== undefined).map(phase => phase.label),
		).toEqual(["static/rs (cargo check)"]);
		const rust = phases.find(phase => phase.label === "static/rs (cargo check)");
		if (rust?.kind !== "command") throw new Error("the Rust pass must be a command phase");
		expect(rust.argv[0]).toBe("C:/toolchain/cargo.exe");
		expect(rust.env).toEqual({ RUSTUP_TOOLCHAIN: "nightly-2026-08-12" });
	});
});

describe("type-check package discovery", () => {
	test("selects only packages with a check:types script, sorted by name", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fastcheck-packages-"));
		try {
			const fixtures: ReadonlyArray<readonly [string, object]> = [
				["beta", { name: "@scope/beta", scripts: { "check:types": "tsgo -p tsconfig.json --noEmit" } }],
				["alpha", { name: "@scope/alpha", scripts: { "check:types": "tsgo -p tsconfig.json --noEmit" } }],
				["no-types", { name: "@scope/no-types", scripts: { test: "bun test" } }],
			];
			for (const [dir, manifest] of fixtures) {
				mkdirSync(path.join(root, "packages", dir), { recursive: true });
				writeFileSync(path.join(root, "packages", dir, "package.json"), JSON.stringify(manifest));
			}
			// A package without a check:types script or manifest is skipped, not fatal.
			mkdirSync(path.join(root, "packages", "no-manifest"), { recursive: true });
			expect(listTypeCheckPackages(root).map(pkg => pkg.label)).toEqual(["@scope/alpha", "@scope/beta"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("wall-clock budget", () => {
	test("the budget is the hard 60s cap from the verification contract", () => {
		expect(FASTCHECK_TIMEOUT_MS).toBe(60_000);
	});

	test("timeout failures are distinguishable from ordinary phase failures", () => {
		expect(new FastcheckTimeoutError(FASTCHECK_TIMEOUT_MS, 61_234)).toBeInstanceOf(FastcheckTimeoutError);
		expect(new Error("static/rs (cargo check) failed with exit code 101")).not.toBeInstanceOf(FastcheckTimeoutError);
	});

	test("the timeout error reports the budget it blew", () => {
		expect(new FastcheckTimeoutError(60_000, 61_234).message).toContain("60s wall-clock budget");
	});
});

describe("budget override", () => {
	const original = process.env.FASTCHECK_BUDGET_MS;

	afterEach(() => {
		if (original === undefined) delete process.env.FASTCHECK_BUDGET_MS;
		else process.env.FASTCHECK_BUDGET_MS = original;
	});

	test("defaults to the 60s quick-feedback budget", () => {
		delete process.env.FASTCHECK_BUDGET_MS;
		expect(fastcheckBudgetMsFromEnv()).toBe(FASTCHECK_TIMEOUT_MS);
	});

	test("fulltest's zero budget runs the gate unbounded", () => {
		process.env.FASTCHECK_BUDGET_MS = "0";
		expect(fastcheckBudgetMsFromEnv()).toBe(0);
	});

	test("explicit budgets are honored", () => {
		process.env.FASTCHECK_BUDGET_MS = "90000";
		expect(fastcheckBudgetMsFromEnv()).toBe(90_000);
	});

	test("malformed values fail loudly instead of silently re-budgeting", () => {
		process.env.FASTCHECK_BUDGET_MS = "60s";
		expect(() => fastcheckBudgetMsFromEnv()).toThrow("FASTCHECK_BUDGET_MS");
	});
});
