#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { windowsTestTempOverride } from "./windows-test-temp";
import { GateCommandError, reportGateFailure } from "./test-gate-failure-events";
import { forwardNextestOutput, withRustCompilerEvents } from "./test-gate-native-events";
import { testConcurrencyLimit } from "./test-gate-scheduler";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath } from "./test-reporting";
import type { RustDeltaSelection } from "./test-gate-delta";

const forkPackages = ["pi-wiki", "pi-natives"] as const;
const packageNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const baselinePattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

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
// grep-searcher's upstream ripgrep code predates the workspace clippy policy, but
// the fork's own `search_push` (src/searcher/push.rs, see its README.md) carries
// tests, so it is exempt from the lint gates only and still runs under test:rs.
const LINT_EXEMPT_FORK_EXCLUDES = [
	...VENDORED_FORK_EXCLUDES,
	"--exclude",
	"grep-searcher",
] as const satisfies readonly string[];
const TASK_COMMANDS = {
	"check:rs": [
		["cargo", "fmt", "--all", "--", "--check"],
		["cargo", "clippy", "--workspace", ...LINT_EXEMPT_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"],
	],
	"fix:rs": [
		["cargo", "fmt", "--all"],
		[
			"cargo",
			"clippy",
			"--workspace",
			...LINT_EXEMPT_FORK_EXCLUDES,
			"--fix",
			"--allow-dirty",
			"--no-deps",
			"--allow-staged",
			"--allow-no-vcs",
		],
	],
	"fmt:rs": [["cargo", "fmt", "--all"]],
	"lint:rs": [["cargo", "clippy", "--workspace", ...LINT_EXEMPT_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"]],
	"test:rs": [],
} as const satisfies Record<string, readonly (readonly string[])[]>;
const FULL_TEST_COMMANDS = [
	[
		"cargo",
		"nextest",
		"run",
		"--workspace",
		`--test-threads=${testConcurrencyLimit()}`,
		"--no-fail-fast",
		"--message-format=libtest-json-plus",
		"--message-format-version=0.1",
		"--status-level=fail",
		"--final-status-level=fail",
	],
	["cargo", "test", "--workspace", "--doc", "--no-fail-fast"],
] as const satisfies readonly (readonly string[])[];

type RustTaskName = keyof typeof TASK_COMMANDS;

const repoRoot = path.join(import.meta.dir, "..");
const taskName = process.argv[2];
let cargoBinary: string | undefined;

if (!isRustTaskName(taskName)) {
	console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
	process.exit(1);
}

const full = taskName === "test:rs" && process.argv.length === 4 && process.argv[3] === "--full";
if (process.argv.length > 3 && !full) {
	console.error(`Unknown Rust task argument: ${process.argv[3]}`);
	process.exit(1);
}

if (taskName !== "test:rs" && taskName !== "fmt:rs" && !(isCI() || (await hasRustAffectingChanges()))) {
	console.log(`Skipping ${taskName} (not in CI and no Rust-affecting changes were found).`);
	process.exit(0);
}

const selection = taskName === "test:rs" && !full ? readDeltaSelection() : undefined;
const selectedPackages =
	selection?.mode === "affected" ? forkPackages.filter(name => selection.packages.includes(name)) : [...forkPackages];
Object.assign(process.env, windowsTestTempOverride());
prepareWindowsRustEnvironment();
const commands =
	taskName !== "test:rs" ? TASK_COMMANDS[taskName] : full ? FULL_TEST_COMMANDS : forkTestCommands(selectedPackages);
await runCommands(commands, taskName === "test:rs" ? (full ? "rust-workspace" : "rust-fork-features") : undefined);

function readDeltaSelection(): RustDeltaSelection | undefined {
	const raw = process.env.OMP_RUST_DELTA_SELECTION;
	if (raw === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		const item = value as Record<string, unknown>;
		if (
			item.tool !== "cargo-delta" ||
			!["affected", "full"].includes(item.mode as string) ||
			!Array.isArray(item.packages) ||
			!item.packages.every(name => typeof name === "string" && packageNamePattern.test(name)) ||
			new Set(item.packages).size !== item.packages.length ||
			typeof item.reason !== "string" ||
			!item.reason.trim() ||
			(item.baseline !== undefined && (typeof item.baseline !== "string" || !baselinePattern.test(item.baseline))) ||
			(item.mode === "affected" && (typeof item.baseline !== "string" || !baselinePattern.test(item.baseline)))
		)
			throw new Error("invalid selection");
		if (item.mode === "affected" && !validChangedPaths()) throw new Error("missing changed-path evidence");
		return item as unknown as RustDeltaSelection;
	} catch {
		console.warn("Warning: invalid Rust delta selection or evidence; running full fork tests.");
		return undefined;
	}
}

function validChangedPaths(): string[] | undefined {
	try {
		const paths: unknown = JSON.parse(process.env.OMP_FULLTEST_CHANGED_PATHS ?? "null");
		if (
			!Array.isArray(paths) ||
			!paths.every(
				value =>
					typeof value === "string" &&
					value.length > 0 &&
					!value.includes("\\") &&
					!value.startsWith("/") &&
					!/^[a-z]:/i.test(value) &&
					value.split("/").every(part => part !== "" && part !== "." && part !== ".."),
			)
		)
			return undefined;
		return paths;
	} catch {
		return undefined;
	}
}

function forkTestCommands(packages: readonly string[]): readonly (readonly string[])[] {
	if (!packages.length) return [];
	const wiki = packages.includes("pi-wiki");
	const native = packages.includes("pi-natives");
	const expression = [
		wiki && "package(pi-wiki)",
		native && "(package(pi-natives) & (test(/^wiki::/) | test(/^python_symbols::/)))",
	]
		.filter(Boolean)
		.join(" | ");
	return [
		[
			"cargo",
			"nextest",
			"run",
			`--test-threads=${testConcurrencyLimit()}`,
			"--no-fail-fast",
			"--message-format=libtest-json-plus",
			"--message-format-version=0.1",
			...packages.flatMap(name => ["-p", name]),
			"-E",
			expression,
			"--status-level=fail",
			"--final-status-level=fail",
		],
		...(wiki ? [["cargo", "test", "-p", "pi-wiki", "--doc", "--no-fail-fast"]] : []),
	];
}

async function runCommands(commands: readonly (readonly string[])[], scope?: string): Promise<void> {
	const run = scope ? await beginTestRun(scope) : undefined;
	let exitCode = 0;
	try {
		if (selection?.mode === "affected") {
			const skipped = !selectedPackages.length
				? ([
						["cargo nextest run", ["cargo", "nextest", "run"]],
						["cargo test --doc", ["cargo", "test", "--doc"]],
					] as const)
				: !selectedPackages.includes("pi-wiki")
					? ([["cargo test --doc", ["cargo", "test", "-p", "pi-wiki", "--doc"]]] as const)
					: [];
			for (const [producer, command] of skipped) {
				await recordTestProducer({
					producer,
					command: [...command],
					scope: scope!,
					startedAt: new Date().toISOString(),
					durationSeconds: 0,
					exitCode: 0,
					status: "not-selected",
					selection: {
						tool: "cargo-delta",
						mode: "affected",
						baseline: selection.baseline,
						packages: [],
						selected: 0,
						changedPaths: validChangedPaths()!,
						reason: producer === "cargo test --doc" ? "pi-wiki is not affected" : "no fork packages are affected",
					},
				});
			}
		}
		for (const command of commands) {
			let commandExitCode: number;
			try {
				commandExitCode = await runCommand(command, scope);
			} catch (error) {
				commandExitCode = 1;
				reportGateFailure(new GateCommandError(`${command.join(" ")} failed: ${String(error)}`, commandExitCode));
			}
			if (exitCode === 0) exitCode = commandExitCode;
			if (commandExitCode !== 0 && !scope) break;
		}
	} catch (error) {
		exitCode = 1;
		throw error;
	} finally {
		if (run) {
			try {
				await endTestRun(run, exitCode);
			} catch (error) {
				console.warn(
					`Warning: unable to finalize Rust test timing: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	if (exitCode !== 0) process.exit(exitCode);
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
	env.PATH = [toolchainBin, currentPath].join(pathSep);
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

function toolVersion(command: string[], env: Record<string, string>): string | undefined {
	try {
		const result = Bun.spawnSync(command, { cwd: repoRoot, env, stdout: "pipe", stderr: "ignore" });
		return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
	} catch {
		return undefined;
	}
}

async function runCommand(command: readonly string[], scope?: string): Promise<number> {
	const [head, ...rest] = command;
	const isCargo = head === "cargo";
	const isNextest = isCargo && rest[0] === "nextest" && rest[1] === "run";
	const isDoctest = isCargo && rest[0] === "test" && rest.includes("--doc");
	const executable = isCargo ? await ensureCargoBinary() : head;
	const argv = [executable, ...rest];
	const env = isCargo ? cargoEnvironment(executable) : { ...(process.env as Record<string, string>) };
	if (isNextest) env.NEXTEST_EXPERIMENTAL_LIBTEST_JSON = "1";
	const reportPath = scope && isNextest ? testReportPath("rust-nextest") : undefined;
	let nextestStore: string | undefined;
	if (reportPath && isNextest) {
		// Nextest's JUnit path is relative to store.dir/<profile>. A lower-priority
		// tool config isolates the store for this invocation while leaving Cargo's
		// stable target directory, build profile and workspace config untouched.
		nextestStore = `${reportPath}.nextest`;
		const toolConfigPath = `${reportPath}.nextest.toml`;
		await Bun.write(toolConfigPath, `[store]\ndir = ${JSON.stringify(nextestStore)}\n`);
		argv.push("--tool-config-file", `omp-test-report:${toolConfigPath}`);
	}
	const startedAt = new Date().toISOString();
	const startedMs = performance.now();
	const exitCode = await withRustCompilerEvents(env, async compilerEnv => {
		const proc = Bun.spawn(argv, {
			cwd: repoRoot,
			env: compilerEnv,
			stdin: "inherit",
			stdout: isNextest ? "pipe" : "inherit",
			stderr: "inherit",
		});
		let reportedFailure = false;
		const writeOutput = (bytes: Uint8Array) =>
			new Promise<void>((resolve, reject) => {
				process.stdout.write(bytes, error => (error ? reject(error) : resolve()));
			});
		const output = isNextest
			? forwardNextestOutput(proc.stdout as ReadableStream<Uint8Array>, writeOutput, error => {
					reportedFailure = true;
					reportGateFailure(error);
				})
			: Promise.resolve();
		const [code] = await Promise.all([proc.exited, output]);
		if (code !== 0 && !reportedFailure) reportGateFailure(new GateCommandError(`${command.join(" ")} failed`, code));
		return code;
	});
	if (reportPath && scope) {
		let partial = false;
		if (nextestStore) {
			const profile = process.env.NEXTEST_PROFILE || "default";
			const source = path.join(nextestStore, profile, "junit.xml");
			try {
				if (path.basename(profile) !== profile || profile === "." || profile === "..")
					throw new Error(`Invalid nextest profile path: ${profile}`);
				await fs.promises.copyFile(source, reportPath);
				const junit = await Bun.file(reportPath).text();
				if (!/<testsuites?(?:\s|>)/.test(junit) || !/<\/testsuites?\s*>/.test(junit))
					throw new Error("Invalid nextest JUnit report");
			} catch (error) {
				partial = true;
				console.warn(
					`Warning: nextest JUnit report unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		try {
			await recordTestProducer({
				producer: "cargo nextest run",
				command: argv,
				scope,
				startedAt,
				durationSeconds: (performance.now() - startedMs) / 1000,
				exitCode,
				reportPath,
				status: partial ? "partial" : undefined,
				selection:
					selection?.mode === "affected"
						? {
								tool: "cargo-delta",
								mode: "affected",
								baseline: selection.baseline,
								packages: selectedPackages,
								reason: selection.reason,
							}
						: {
								tool: "cargo-nextest",
								mode: "full",
								reason: full
									? "all workspace packages and test namespaces"
									: "full pi-wiki package and pi-natives wiki bindings and python_symbols namespaces",
							},
				timingBasis: "nextest native JUnit case time",
				runnerVersion: toolVersion([executable, "nextest", "--version"], env),
			});
		} catch (error) {
			// Reporting must not replace the actual Rust test exit status.
			console.warn(
				`Warning: unable to record Rust timing metadata: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (scope && isDoctest) {
		try {
			await recordTestProducer({
				producer: "cargo test --doc",
				command: argv,
				scope,
				startedAt,
				durationSeconds: (performance.now() - startedMs) / 1000,
				exitCode,
				status: exitCode === 0 ? "stage" : "failed",
				timingBasis: "command wall time; Cargo doctests do not provide standard JUnit reports",
				selection:
					selection?.mode === "affected"
						? {
								tool: "cargo-delta",
								mode: "affected",
								baseline: selection.baseline,
								packages: ["pi-wiki"],
								reason: selection.reason,
							}
						: { tool: "cargo", mode: "full", reason: full ? "workspace doctests" : "pi-wiki doctests" },
				runnerVersion: toolVersion([executable, "--version"], env),
			});
		} catch (error) {
			console.warn(`Warning: unable to record Rust doctest timing metadata: ${String(error)}`);
		}
	}
	return exitCode;
}
