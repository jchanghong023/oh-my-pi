import { describe, expect, it } from "bun:test";
import * as path from "node:path";

import {
	parseFulltestChangedPaths,
	selectRustTestScope,
	type CargoLockPackageForRustScope,
	type CargoMetadataForRustScope,
} from "./rust-test-scope";

const REPO_ROOT = "/repo";
const VENDORED_EXCLUDES = ["brush-core", "brush-parser", "cfg_aliases", "napi"];

function workspace(packages: { name: string; path: string; dependencies?: string[] }[]): CargoMetadataForRustScope {
	const metadataPackages = packages.map(({ name, path, dependencies = [] }) => ({
		id: `${name}@1.0.0`,
		name,
		version: "1.0.0",
		source: null,
		manifest_path: `${REPO_ROOT}/${path}/Cargo.toml`,
		dependencies: dependencies.map(dependency => ({ name: dependency })),
	}));
	return {
		packages: metadataPackages,
		workspace_members: metadataPackages.map(pkg => pkg.id),
	};
}

async function runRustTaskRunner(args: string[], changedPaths: string[] = []) {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "run-rs-task.ts"), ...args], {
		cwd: path.join(import.meta.dir, ".."),
		env: {
			...process.env,
			CI: "1",
			OMP_FULLTEST_CHANGED_PATHS: JSON.stringify(changedPaths),
			PATH: "",
			Path: "",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("Rust affected test scope", () => {
	it("tests source, test, config, build, and manifest changes of the changed crate only", () => {
		const metadata = workspace([
			{ name: "leaf", path: "crates/leaf" },
			{ name: "middle", path: "crates/middle", dependencies: ["leaf"] },
			{ name: "consumer", path: "crates/consumer", dependencies: ["middle"] },
			{ name: "unrelated", path: "crates/unrelated" },
		]);

		for (const changedPath of [
			"crates/leaf/src/lib.rs",
			"crates/leaf/tests/regression.rs",
			"crates/leaf/test/compat.rs",
			"crates/leaf/config.toml",
			"crates/leaf/build.rs",
			"crates/leaf/Cargo.toml",
		]) {
			const scope = selectRustTestScope([changedPath], metadata, REPO_ROOT, VENDORED_EXCLUDES);
			expect(scope).toEqual({ kind: "affected", crates: ["leaf"] });
		}
	});

	it("runs consumers of changed vendored code without adding excluded vendored crates to the gate", () => {
		const metadata = workspace([
			{ name: "brush-core", path: "crates/vendor/brush-core" },
			{ name: "brush-parser", path: "crates/vendor/brush-parser" },
			{ name: "pi-builtins", path: "crates/pi-builtins", dependencies: ["brush-core"] },
			{ name: "pi-shell", path: "crates/pi-shell", dependencies: ["brush-core", "pi-builtins"] },
		]);

		const scope = selectRustTestScope(
			["crates/vendor/brush-core/src/lib.rs"],
			metadata,
			REPO_ROOT,
			VENDORED_EXCLUDES,
		);

		expect(scope).toEqual({ kind: "affected", crates: ["pi-builtins", "pi-shell"] });
	});

	it("falls back to the full workspace when no-deps metadata cannot show a vendor dependency chain", () => {
		const metadata = workspace([
			{ name: "cfg_aliases", path: "crates/vendor/cfg_aliases" },
			{ name: "pi-builtins", path: "crates/pi-builtins", dependencies: ["nix"] },
			{ name: "pi-shell", path: "crates/pi-shell", dependencies: ["pi-builtins"] },
			{ name: "unrelated", path: "crates/unrelated" },
		]);

		const scope = selectRustTestScope(
			["crates/vendor/cfg_aliases/src/lib.rs"],
			metadata,
			REPO_ROOT,
			VENDORED_EXCLUDES,
		);

		expect(scope).toEqual({ kind: "all", crates: ["pi-builtins", "pi-shell", "unrelated"] });
	});

	it("uses Cargo.lock to find workspace consumers through an external dependency", () => {
		const metadata = workspace([
			{ name: "cfg_aliases", path: "crates/vendor/cfg_aliases" },
			{ name: "pi-builtins", path: "crates/pi-builtins", dependencies: ["nix"] },
			{ name: "pi-shell", path: "crates/pi-shell", dependencies: ["pi-builtins"] },
			{ name: "pi-natives", path: "crates/pi-natives", dependencies: ["pi-builtins"] },
			{ name: "unrelated", path: "crates/unrelated" },
		]);
		const lockPackages: CargoLockPackageForRustScope[] = [
			{ name: "cfg_aliases", version: "1.0.0" },
			{
				name: "nix",
				version: "0.28.0",
				source: "registry+https://github.com/rust-lang/crates.io-index",
				dependencies: ["cfg_aliases 1.0.0"],
			},
			{ name: "pi-builtins", version: "1.0.0", dependencies: ["nix 0.28.0"] },
			{ name: "pi-shell", version: "1.0.0", dependencies: ["pi-builtins 1.0.0"] },
			{ name: "pi-natives", version: "1.0.0", dependencies: ["pi-builtins 1.0.0"] },
			{ name: "unrelated", version: "1.0.0" },
		];

		const scope = selectRustTestScope(
			["crates/vendor/cfg_aliases/src/lib.rs"],
			metadata,
			REPO_ROOT,
			VENDORED_EXCLUDES,
			lockPackages,
		);

		expect(scope).toEqual({ kind: "affected", crates: ["pi-builtins", "pi-natives", "pi-shell"] });
	});

	it("uses the complete non-excluded workspace for shared config and an unresolvable deleted crate", () => {
		const metadata = workspace([
			{ name: "alpha", path: "crates/alpha" },
			{ name: "brush-core", path: "crates/vendor/brush-core" },
			{ name: "beta", path: "crates/beta", dependencies: ["alpha"] },
		]);

		for (const changedPath of [
			"Cargo.toml",
			"Cargo.lock",
			"rust-toolchain.toml",
			"clippy.toml",
			".clippy.toml",
			"rustfmt.toml",
			".rustfmt.toml",
			"rust-toolchain",
			".cargo/config.toml",
			".config/nextest.toml",
			"crates",
			"crates/removed/src/lib.rs",
		]) {
			const scope = selectRustTestScope([changedPath], metadata, REPO_ROOT, VENDORED_EXCLUDES);
			expect(scope).toEqual({ kind: "all", crates: ["alpha", "beta"] });
		}
	});

	it("selects a crate for any changed file under it, including compile-time prompt payloads", () => {
		// Documentation filtering belongs to fulltest's isDocumentation, never to
		// the Rust scope: pi-edit embeds prompts/*.md via include_str!, so a
		// generic markdown fallback here would silently skip the Rust gate.
		const metadata = workspace([
			{ name: "leaf", path: "crates/leaf" },
			{ name: "middle", path: "crates/middle", dependencies: ["leaf"] },
			{ name: "consumer", path: "crates/consumer", dependencies: ["middle"] },
		]);

		for (const changedPath of [
			"crates/leaf/prompts/patch.md",
			"crates/leaf/README.md",
			"crates/leaf/docs/usage.md",
		]) {
			expect(selectRustTestScope([changedPath], metadata, REPO_ROOT, VENDORED_EXCLUDES)).toEqual({
				kind: "affected",
				crates: ["leaf"],
			});
		}
	});

	it("fails closed when the fulltest changed-path input is missing or malformed", () => {
		expect(() => parseFulltestChangedPaths(undefined)).toThrow("OMP_FULLTEST_CHANGED_PATHS");
		expect(() => parseFulltestChangedPaths("{not-json}")).toThrow("JSON string array");
		expect(() => parseFulltestChangedPaths('["crates/pi-builtins", 42]')).toThrow("JSON string array");
		expect(parseFulltestChangedPaths("[]")).toEqual([]);
	});
	it("skips empty affected scope under CI without invoking Cargo", async () => {
		const result = await runRustTaskRunner(["test:rs", "--affected", "--dry-run"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Rust affected test crates: none");
		expect(result.stdout).toContain("Rust test commands: none");
	});

	it("falls back to workspace tests when Cargo metadata cannot resolve the affected scope", async () => {
		const result = await runRustTaskRunner(["test:rs", "--affected", "--dry-run"], ["crates/pi-shell/src/lib.rs"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Selecting the full Rust workspace");
		expect(result.stdout).toContain("cargo nextest run --workspace");
		expect(result.stdout).toContain("cargo test --doc --workspace");
		expect(result.stdout).toContain("--exclude brush-core");
		expect(result.stdout).toContain("--exclude napi");
	});

	it("rejects unknown and misplaced Rust runner arguments", async () => {
		const unknown = await runRustTaskRunner(["test:rs", "--unknown"]);
		const misplaced = await runRustTaskRunner(["check:rs", "--affected"]);

		expect(unknown.exitCode).not.toBe(0);
		expect(unknown.stderr).toContain("Unknown or duplicate Rust task argument");
		expect(misplaced.exitCode).not.toBe(0);
		expect(misplaced.stderr).toContain("only valid with test:rs");
	});
});
