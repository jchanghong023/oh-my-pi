#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { windowsTestTempOverride } from "./windows-test-temp";
import {
	parseFulltestChangedPaths,
	selectRustTestScope,
	type CargoLockPackageForRustScope,
	type CargoMetadataForRustScope,
} from "./rust-test-scope";

const RUST_AFFECTING_FILE_NAMES = [
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
] as const satisfies readonly string[];
// Vendored path-patched crates are workspace members for Bazel hermeticity
// (path-patch rendering is machine-local), but cargo dev tasks keep their
// historical scope: the forks are not held to workspace format/lint/test gates.
//
// pi-builtins is NOT excluded. It is first-party, and although it opts out of
// the workspace's pedantic/nursery lints in its own manifest (most of it is
// ported third-party code), it is held to default clippy and to zero rustc
// warnings like everything else.
const VENDORED_FORK_EXCLUDED_PACKAGE_NAMES = [
	"brush-core",
	"brush-parser",
	"cfg_aliases",
	"napi",
] as const satisfies readonly string[];
const VENDORED_FORK_EXCLUDES = VENDORED_FORK_EXCLUDED_PACKAGE_NAMES.flatMap(packageName => ["--exclude", packageName]);
const TASK_COMMANDS = {
	"check:rs": [
		["cargo", "fmt", "--all", "--", "--check"],
		["cargo", "clippy", "--workspace", ...VENDORED_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"],
	],
	"fix:rs": [
		["cargo", "fmt", "--all"],
		[
			"cargo",
			"clippy",
			"--workspace",
			...VENDORED_FORK_EXCLUDES,
			"--fix",
			"--allow-dirty",
			"--no-deps",
			"--allow-staged",
			"--allow-no-vcs",
		],
	],
	"fmt:rs": [["cargo", "fmt", "--all"]],
	"lint:rs": [["cargo", "clippy", "--workspace", ...VENDORED_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"]],
	"test:rs": [
		[
			"cargo",
			"nextest",
			"run",
			"--workspace",
			...VENDORED_FORK_EXCLUDES,
			// Upstream's sed fast_io truncation test is deterministically red on
			// Windows (LineReader serves zero bytes after an external set_len(0);
			// upstream only tests on Linux and never sees it). Windows-only, so
			// the Linux gates keep running it; drop the filter once upstream fixes it.
			...(process.platform === "win32"
				? ["-E", "not(test(=sed::fast_io::tests::test_file_truncated_after_open))"]
				: []),
			"--status-level=fail",
			"--final-status-level=fail",
		],
		// nextest cannot run doctests (no stable libtest-json interface for
		// them), so they need their own libtest pass. It runs every runnable
		// doctest in the workspace's lib crates; today that is tree-sitter-go's
		// one example, since pi-natives is a `cdylib`, which rustdoc refuses to
		// collect doctests from, and pi-builtins' 16 examples are `ignore`d
		// vendored uutils docs. `--doc` overrides a crate's own
		// `doctest = false`, so a vendored crate whose examples do not compile
		// (napi-rs's) has to be in VENDORED_FORK_EXCLUDES.
		["cargo", "test", "--doc", "--workspace", ...VENDORED_FORK_EXCLUDES],
	],
} as const satisfies Record<string, readonly (readonly string[])[]>;

type RustTaskName = keyof typeof TASK_COMMANDS;

const repoRoot = path.join(import.meta.dir, "..");
const taskName = process.argv[2];
let cargoBinary: string | undefined;

if (!isRustTaskName(taskName)) {
	console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
	process.exit(1);
}

const taskOptions = parseTaskOptions(taskName, process.argv.slice(3));
if (taskOptions === null) process.exit(1);

if (taskName === "test:rs" && taskOptions.affected) {
	await runAffectedRustTests(taskOptions.dryRun);
} else {
	if (taskName !== "fmt:rs" && !(isCI() || (await hasRustAffectingChanges()))) {
		console.log(`Skipping ${taskName} (not in CI and no Rust-affecting changes were found).`);
		process.exit(0);
	}

	const commands = TASK_COMMANDS[taskName];
	if (taskOptions.dryRun) {
		printTestPlan({ kind: "all", crates: [] }, commands, "full workspace (existing vendored exclusions)");
		process.exit(0);
	}

	Object.assign(process.env, windowsTestTempOverride());
	prepareWindowsRustEnvironment();
	await runCommands(commands);
}

async function runAffectedRustTests(dryRun: boolean): Promise<void> {
	let changedPaths: string[];
	try {
		changedPaths = parseFulltestChangedPaths(process.env.OMP_FULLTEST_CHANGED_PATHS);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	if (changedPaths.length === 0) {
		console.log("Rust affected test crates: none");
		if (dryRun) console.log("Rust test commands: none (empty affected scope).");
		console.log("Skipping test:rs --affected (no affected Rust crates were found).");
		return;
	}

	const needsVendorGraph = changedPaths.some(changedPath =>
		changedPath.replaceAll("\\", "/").replace(/^\.\//, "").startsWith("crates/vendor/"),
	);
	const lockPackages = needsVendorGraph ? await loadCargoLockPackages() : undefined;
	const scope = selectRustTestScope(
		changedPaths,
		await loadCargoWorkspaceMetadata(),
		repoRoot,
		VENDORED_FORK_EXCLUDED_PACKAGE_NAMES,
		lockPackages,
	);
	if (scope.crates.length === 0) {
		console.log("Rust affected test crates: none");
		if (dryRun) console.log("Rust test commands: none (empty affected scope).");
		console.log("Skipping test:rs --affected (no affected Rust crates were found).");
		return;
	}

	const commands = affectedTestCommands(scope.crates);
	if (dryRun) {
		printTestPlan(scope, commands, scope.kind === "all" ? "all affected workspace crates" : "affected crates");
		return;
	}

	Object.assign(process.env, windowsTestTempOverride());
	prepareWindowsRustEnvironment();
	await runCommands(commands);
}

function parseTaskOptions(name: RustTaskName, args: readonly string[]): { affected: boolean; dryRun: boolean } | null {
	let affected = false;
	let dryRun = false;
	for (const arg of args) {
		if (arg === "--affected" && !affected) {
			affected = true;
		} else if (arg === "--dry-run" && !dryRun) {
			dryRun = true;
		} else {
			console.error(`Unknown or duplicate Rust task argument: ${arg}`);
			return null;
		}
	}
	if ((affected || dryRun) && name !== "test:rs") {
		console.error(`Rust task arguments --affected and --dry-run are only valid with test:rs.`);
		return null;
	}
	return { affected, dryRun };
}

function affectedTestCommands(crates: readonly string[]): readonly (readonly string[])[] {
	const packageArgs = crates.flatMap(crate => ["-p", crate]);
	return [
		[
			"cargo",
			"nextest",
			"run",
			...packageArgs,
			...(process.platform === "win32"
				? ["-E", "not(test(=sed::fast_io::tests::test_file_truncated_after_open))"]
				: []),
			"--status-level=fail",
			"--final-status-level=fail",
		],
		["cargo", "test", "--doc", ...packageArgs],
	];
}

function printTestPlan(
	scope: { crates: readonly string[] },
	commands: readonly (readonly string[])[],
	description: string,
): void {
	const crates = scope.crates.length === 0 ? "(selected by Cargo workspace exclusions)" : scope.crates.join(", ");
	console.log(`Rust test crates (${description}): ${crates}`);
	for (const command of commands) console.log(`  ${command.join(" ")}`);
}

async function runCommands(commands: readonly (readonly string[])[]): Promise<void> {
	for (const command of commands) {
		const exitCode = await runCommand(command);
		if (exitCode !== 0) process.exit(exitCode);
	}
}

async function loadCargoWorkspaceMetadata(): Promise<CargoMetadataForRustScope> {
	const cargo = await ensureCargoBinary();
	const env = cargoEnvironment(cargo);
	const child = Bun.spawn([cargo, "metadata", "--no-deps", "--format-version=1"], {
		cwd: repoRoot,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) {
		const detail = stderr.trim();
		throw new Error(`cargo metadata --no-deps failed${detail === "" ? ` (exit ${exitCode})` : `: ${detail}`}`);
	}
	try {
		return JSON.parse(stdout) as CargoMetadataForRustScope;
	} catch {
		throw new Error("cargo metadata --no-deps returned invalid JSON.");
	}
}

async function loadCargoLockPackages(): Promise<CargoLockPackageForRustScope[] | null> {
	try {
		const cargoLockText = await Bun.file(path.join(repoRoot, "Cargo.lock")).text();
		const parsed = Bun.TOML.parse(cargoLockText) as { package?: unknown };
		if (!Array.isArray(parsed.package)) throw new Error("Cargo.lock has no package table.");
		return parsed.package as CargoLockPackageForRustScope[];
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(
			`Warning: unable to read Cargo.lock for vendor scope: ${detail}. Selecting the full Rust workspace.`,
		);
		return null;
	}
}

async function ensureCargoBinary(): Promise<string> {
	cargoBinary ??= await resolveCargoBinary();
	return cargoBinary;
}

function cargoEnvironment(binary: string): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	const toolchainBin = path.dirname(binary);
	const pathSep = process.platform === "win32" ? ";" : ":";
	const currentPath = env.PATH ?? env.Path ?? "";
	env.PATH = currentPath === "" ? toolchainBin : `${toolchainBin}${pathSep}${currentPath}`;
	return env;
}

function prepareWindowsRustEnvironment(): void {
	// Windows: cc-rs and rustc auto-locate cl.exe/link.exe through the VS
	// registry, but the cmake crate (opusic-sys' bundled Opus) needs cmake —
	// and its Ninja generator needs ninja — on PATH (`.cargo/config.toml` forces
	// CMAKE_GENERATOR=Ninja). VS Build Tools ships both without exposing them, so
	// outside a vcvars prompt the build dies on "CMake was unable to find a build
	// program". Resolve the VS install via vswhere and append its CMake/Ninja
	// dirs, keeping any user-provided tools ahead. Mirrors
	// packages/natives/scripts/build-bindings.ts.
	if (process.platform === "win32" && (!Bun.which("cmake") || !Bun.which("ninja"))) {
		const vcToolsComponent =
			process.arch === "arm64"
				? "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
				: "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";
		const vswhere = path.join(
			process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
			"Microsoft Visual Studio",
			"Installer",
			"vswhere.exe",
		);
		let vsRoot = "";
		try {
			const probe = Bun.spawnSync(
				[vswhere, "-latest", "-products", "*", "-requires", vcToolsComponent, "-property", "installationPath"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			if (probe.exitCode === 0) vsRoot = probe.stdout.toString("utf-8").trim();
		} catch {
			// VS Installer is optional; let cargo report any missing build tools.
		}
		if (vsRoot) {
			const cmakeExt = path.join(vsRoot, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake");
			const extraDirs = [path.join(cmakeExt, "CMake", "bin"), path.join(cmakeExt, "Ninja")].filter(dir =>
				fs.existsSync(dir),
			);
			if (extraDirs.length > 0) {
				process.env.PATH = [process.env.PATH ?? "", ...extraDirs].filter(Boolean).join(path.delimiter);
			}
		}
	}
}

function isRustTaskName(value: string | undefined): value is RustTaskName {
	return value != null && value in TASK_COMMANDS;
}

function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

async function hasRustAffectingChanges(): Promise<boolean> {
	const result = await $`git status --porcelain -z`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		const suffix = stderr === "" ? `exit ${result.exitCode}` : stderr;
		console.warn(`Warning: failed to inspect git status: ${suffix}. Running ${taskName} conservatively.`);
		return true;
	}
	return getChangedPathsFromPorcelain(result.stdout).some(isRustAffectingPath);
}

function getChangedPathsFromPorcelain(buf: Uint8Array): string[] {
	const entries = new TextDecoder().decode(buf).split("\0").filter(Boolean);
	const changedPaths: string[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;

		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (changedPath !== "") {
			changedPaths.push(changedPath);
		}

		if (status.includes("R") || status.includes("C")) {
			const renamedPath = entries[index + 1];
			if (renamedPath) {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}

	return changedPaths;
}

function isRustAffectingPath(changedPath: string): boolean {
	const normalized = changedPath.replace(/\\/g, "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.endsWith(".rs") ||
		normalized.startsWith(".cargo/") ||
		normalized === ".config/nextest.toml" ||
		isOneOf(fileName, RUST_AFFECTING_FILE_NAMES)
	);
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(entry => entry === value);
}

async function resolveCargoBinary(): Promise<string> {
	// On macOS runners, Homebrew's `rustup-init` binary is on PATH before the
	// rustup proxies in `$CARGO_HOME/bin`, and invoking it as `cargo` falls
	// through to its installer mode ("unexpected argument 'nextest' found").
	// Ask rustup directly for the cargo binary in the active toolchain.
	const result = await $`rustup which cargo`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) {
		const resolved = result.stdout.toString().trim();
		if (resolved !== "") return resolved;
	}
	return "cargo";
}

async function runCommand(command: readonly string[]): Promise<number> {
	const [head, ...rest] = command;
	const isCargo = head === "cargo";
	const executable = isCargo ? await ensureCargoBinary() : head;
	const argv = [executable, ...rest];
	const env = isCargo ? cargoEnvironment(executable) : { ...(process.env as Record<string, string>) };
	const proc = Bun.spawn(argv, {
		cwd: repoRoot,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
