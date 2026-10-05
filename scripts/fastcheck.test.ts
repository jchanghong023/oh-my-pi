import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	buildFastcheckPhases,
	fastcheckBudgetMsFromEnv,
	FASTCHECK_TIMEOUT_MS,
	FASTCHECK_TYPE_CHECK_POOL,
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

	test("a corrupt package manifest fails the gate instead of hiding its type check", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fastcheck-corrupt-package-"));
		try {
			mkdirSync(path.join(root, "packages", "broken"), { recursive: true });
			writeFileSync(path.join(root, "packages", "broken", "package.json"), "{");
			expect(() => listTypeCheckPackages(root)).toThrow("Cannot read workspace manifest");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
		// Number("") === 0, so an empty or blank override must fail loudly rather
		// than silently smuggle in the unbounded budget.
		for (const blank of ["", "   "]) {
			process.env.FASTCHECK_BUDGET_MS = blank;
			expect(() => fastcheckBudgetMsFromEnv()).toThrow("FASTCHECK_BUDGET_MS");
		}
	});
});

describe.skipIf(process.platform === "win32")("fastcheck CLI timeout", () => {
	test.each(["rustup", "types"])(
		"kills a stalled %s stage and never starts later work",
		async stage => {
			const root = mkdtempSync(path.join(tmpdir(), "fastcheck-timeout-"));
			try {
				const scripts = path.join(root, "scripts");
				const bin = path.join(root, "bin");
				const log = path.join(root, "commands.log");
				mkdirSync(scripts);
				mkdirSync(bin);
				copyFileSync(path.join(import.meta.dir, "fastcheck.ts"), path.join(scripts, "fastcheck.ts"));
				writeFileSync(path.join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "fixture"\n');
				writeFileSync(log, "");
				for (let i = 0; i < 8; i++) {
					const dir = path.join(root, "packages", `p${i}`);
					mkdirSync(dir, { recursive: true });
					writeFileSync(
						path.join(dir, "package.json"),
						JSON.stringify({ name: `p${i}`, scripts: { "check:types": "fixture" } }),
					);
				}
				const fixtures = {
					rustup:
						stage === "rustup"
							? '#!/bin/sh\nprintf "rustup\\n" >> "$TEST_LOG"\nexec sleep 60\n'
							: "#!/bin/sh\necho cargo\n",
					bun: '#!/bin/sh\nif [ "$2" = "check:types" ]; then printf "types\\n" >> "$TEST_LOG"; exec sleep 60; fi\n',
					cargo: '#!/bin/sh\nprintf "cargo\\n" >> "$TEST_LOG"\n',
				};
				for (const [name, content] of Object.entries(fixtures)) {
					writeFileSync(path.join(bin, name), content);
					chmodSync(path.join(bin, name), 0o755);
				}
				const child = Bun.spawn([process.execPath, path.join(scripts, "fastcheck.ts")], {
					env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TEST_LOG: log, FASTCHECK_BUDGET_MS: "1000" },
					stdout: "pipe",
					stderr: "pipe",
				});
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(exitCode, stdout + stderr).toBe(1);
				expect(stderr).toContain("fastcheck: TIMEOUT");
				const started = readFileSync(log, "utf-8").trim().split("\n");
				expect(started).toEqual(stage === "rustup" ? ["rustup"] : ["types", "types", "types", "types"]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		10_000,
	);
});
