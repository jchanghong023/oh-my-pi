#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { windowsTestTempOverride } from "./windows-test-temp";
import { GateCommandError, reportGateFailure } from "./test-gate-failure-events";
import { forwardNextestOutput, withRustCompilerEvents } from "./test-gate-native-events";
import { testConcurrencyLimit } from "./test-gate-scheduler";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath, type TestSelection } from "./test-reporting";

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
			`--test-threads=${testConcurrencyLimit()}`,
			"--no-fail-fast",
			// The plus reporter flushes each classified result before native grace cleanup.
			"--message-format=libtest-json-plus",
			"--message-format-version=0.1",
			"--workspace",
			...VENDORED_FORK_EXCLUDES,
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
		// Nightly libtest JSON reports per-case exec_time only with --report-time;
		// Rust's existing -Zunstable-options also enables the JSON format.
		[
			"cargo",
			"test",
			"--doc",
			"--workspace",
			"--no-fail-fast",
			...VENDORED_FORK_EXCLUDES,
			"--",
			"-Zunstable-options",
			"--format=json",
			"--report-time",
		],
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

const testMode = process.argv[3] ?? "--affected";

if (
	process.argv.length > 4 ||
	(process.argv.length === 4 && (taskName !== "test:rs" || (testMode !== "--collect" && testMode !== "--full")))
) {
	console.error(`Unknown Rust task argument: ${process.argv[3]}`);
	process.exit(1);
}

if (taskName !== "test:rs" && taskName !== "fmt:rs" && !(isCI() || (await hasRustAffectingChanges()))) {
	console.log(`Skipping ${taskName} (not in CI and no Rust-affecting changes were found).`);
	process.exit(0);
}

Object.assign(process.env, windowsTestTempOverride());
prepareWindowsRustEnvironment();
await runCommands(TASK_COMMANDS[taskName], taskName === "test:rs" ? "rust-workspace" : undefined);

async function runCommands(commands: readonly (readonly string[])[], scope?: string): Promise<void> {
	const run = scope ? await beginTestRun(scope) : undefined;
	let exitCode = 0;
	try {
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

function toolVersion(command: string[], env: Record<string, string>): string | undefined {
	try {
		const result = Bun.spawnSync(command, { cwd: repoRoot, env, stdout: "pipe", stderr: "ignore" });
		return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
	} catch {
		return undefined;
	}
}

async function shouldCollectCoverage(
	executable: string,
	env: Record<string, string>,
	reportPath: string,
	args: string[],
	recover: boolean,
): Promise<boolean> {
	// Never anchor coverage to HEAD when the compiled source differs from it.
	const git = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=normal"], {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "ignore",
	});
	if (git.exitCode !== 0 || git.stdout.length !== 0) return false;
	if (recover) return true;
	const statusPath = `${reportPath}.status.json`;
	try {
		const status = Bun.spawnSync([executable, "affected", "status", "--report-json", statusPath, "--", ...args], {
			cwd: repoRoot,
			env,
			stdout: "ignore",
			stderr: "ignore",
		});
		if (status.exitCode !== 0) return false;
		const report = (await Bun.file(statusPath).json()) as { schema_version?: number; cache?: { status?: string } };
		return (
			report.schema_version === 1 &&
			["miss-no-coverage", "miss-fingerprint", "miss-no-reachable-sha"].includes(report.cache?.status ?? "")
		);
	} catch {
		// A status/tool failure is not evidence of missing coverage. Let run report it.
		return false;
	} finally {
		await fs.promises.rm(statusPath, { force: true }).catch(() => {});
	}
}

async function runCommand(command: readonly string[], scope?: string): Promise<number> {
	const [head, ...rest] = command;
	const isCargo = head === "cargo";
	const isNextest = isCargo && rest[0] === "nextest" && rest[1] === "run";
	const isDoctest = isCargo && rest[0] === "test" && rest.includes("--doc");
	const executable = isCargo ? await ensureCargoBinary() : head;
	let argv = [executable, ...rest];
	const env = isCargo ? cargoEnvironment(executable) : { ...(process.env as Record<string, string>) };
	if (isNextest) env.NEXTEST_EXPERIMENTAL_LIBTEST_JSON = "1";
	const reportPath =
		scope && (isNextest || isDoctest) ? testReportPath(isNextest ? "rust-nextest" : "rust-doctests") : undefined;
	const markerPath = path.join(repoRoot, "target", "affected", "omp-incomplete-run");
	const recoveryRequired = isNextest && fs.existsSync(markerPath);
	const collect =
		isNextest &&
		(testMode === "--collect" ||
			(testMode === "--affected" &&
				reportPath != null &&
				(await shouldCollectCoverage(executable, env, reportPath, rest.slice(2), recoveryRequired))));
	const selectionPath = isNextest && reportPath && !collect ? `${reportPath}.selection.json` : undefined;
	if (isNextest) {
		argv = [
			executable,
			"affected",
			collect ? "collect" : "run",
			...(testMode === "--full" || (recoveryRequired && !collect) ? ["--all"] : []),
			...(selectionPath ? ["--report-json", selectionPath, "--report-detail", "full"] : []),
			"--",
			...rest.slice(2),
		];
	}
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
	if (isNextest) {
		await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
		await Bun.write(markerPath, "Native Rust run incomplete or failed; a clean collection is required.\n");
	}
	const doctests = isDoctest && reportPath ? new DoctestResults() : undefined;
	const exitCode = await withRustCompilerEvents(env, async compilerEnv => {
		const proc = Bun.spawn(argv, {
			cwd: repoRoot,
			env: compilerEnv,
			stdin: "inherit",
			stdout: isNextest || doctests ? "pipe" : "inherit",
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
			: doctests
				? doctests.forward(proc.stdout as ReadableStream<Uint8Array>, writeOutput)
				: Promise.resolve();
		const [code] = await Promise.all([proc.exited, output]);
		if (code !== 0 && !reportedFailure) reportGateFailure(new GateCommandError(`${command.join(" ")} failed`, code));
		return code;
	});
	if (reportPath && scope) {
		let partial = false;
		let selection: TestSelection | undefined;
		if (isNextest) {
			if (selectionPath) {
				try {
					const native = (await Bun.file(selectionPath).json()) as {
						schema_version?: number;
						cache?: { status?: string };
						selection?: { summary?: { mode?: string; selected?: number | null; skipped?: number | null } };
					};
					if (
						native.schema_version !== 1 ||
						typeof native.cache?.status !== "string" ||
						!["selection", "full-suite-no-listing"].includes(native.selection?.summary?.mode ?? "")
					)
						throw new Error("Invalid cargo-affected selection report");
					const summary = native.selection!.summary!;
					if (
						summary.mode === "selection" &&
						(typeof summary.selected !== "number" ||
							!Number.isSafeInteger(summary.selected) ||
							summary.selected < 0 ||
							typeof summary.skipped !== "number" ||
							!Number.isSafeInteger(summary.skipped) ||
							summary.skipped < 0)
					)
						throw new Error("Invalid cargo-affected selection counts");
					selection = {
						tool: "cargo-affected",
						mode: summary.mode === "selection" ? "affected" : "full",
						selected: summary.selected ?? undefined,
						deselected: summary.skipped ?? undefined,
						reason: native.cache.status,
						reportPath: selectionPath,
					};
				} catch (error) {
					partial = true;
					console.warn(`Warning: cargo-affected selection evidence unavailable: ${String(error)}`);
				}
			} else {
				selection = { tool: "cargo-affected", mode: "full", reason: "collect coverage baseline" };
			}
		}
		const notSelected = exitCode === 0 && selection?.mode === "affected" && selection.selected === 0;
		if (nextestStore && !notSelected) {
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
		} else if (doctests) {
			partial = !doctests.complete;
			if (doctests.suites > 0) {
				try {
					await Bun.write(reportPath, doctests.junitXml());
				} catch (error) {
					partial = true;
					console.warn(
						`Warning: rustdoc JUnit report unavailable: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			} else console.warn("Warning: rustdoc emitted no structured libtest JSON suite; doctest timing is partial.");
		}
		if (isNextest && exitCode === 0 && !partial && (!recoveryRequired || collect)) {
			// A failed/interrupted collection can have stored incomplete coverage.
			// Only a successful clean collection can make that baseline trustworthy again.
			await fs.promises.rm(markerPath, { force: true }).catch(error => {
				console.warn(`Warning: unable to clear Rust recovery marker: ${String(error)}`);
			});
		}
		try {
			await recordTestProducer({
				producer: isNextest ? `cargo affected ${collect ? "collect" : "run"}` : "cargo test --doc",
				command: argv,
				scope,
				startedAt,
				durationSeconds: (performance.now() - startedMs) / 1000,
				exitCode,
				reportPath: notSelected ? undefined : reportPath,
				status: partial ? "partial" : notSelected ? "not-selected" : undefined,
				selection,
				timingBasis: isNextest
					? "nextest native JUnit case time"
					: "rustdoc libtest JSON exec_time (--report-time)",
				runnerVersion: toolVersion(
					isNextest ? [executable, "affected", "--version"] : ["rustdoc", "--version"],
					env,
				),
			});
		} catch (error) {
			// Reporting must not replace the actual Rust test exit status.
			console.warn(
				`Warning: unable to record Rust timing metadata: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return exitCode;
}

interface DoctestCase {
	name: string;
	suite: number;
	source?: string;
	event: "ok" | "failed" | "ignored";
	seconds?: number;
	output?: string;
}

/** Only libtest JSON events, never Rust's human-readable test output, become cases. */
class DoctestResults {
	readonly cases: DoctestCase[] = [];
	suites = 0;
	private finishedSuites = 0;
	private incomplete = false;
	private expectedCases = 0;

	get complete(): boolean {
		return (
			!this.incomplete &&
			this.suites > 0 &&
			this.finishedSuites === this.suites &&
			this.cases.length === this.expectedCases
		);
	}

	async forward(stream: ReadableStream<Uint8Array>, writeOutput: (bytes: Uint8Array) => Promise<void>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		let pending = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				await writeOutput(value);
				pending += decoder.decode(value, { stream: true });
				let newline: number;
				while ((newline = pending.indexOf("\n")) !== -1) {
					this.observe(pending.slice(0, newline));
					pending = pending.slice(newline + 1);
				}
			}
			this.observe(pending + decoder.decode());
		} finally {
			reader.releaseLock();
		}
	}

	private observe(line: string): void {
		if (!line.trimStart().startsWith("{")) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (event.type === "suite") {
			if (event.event === "started") {
				this.suites++;
				if (typeof event.test_count === "number") this.expectedCases += event.test_count;
				else this.incomplete = true;
			} else if (event.event === "ok" || event.event === "failed") this.finishedSuites++;
		} else if (event.type === "test") {
			if (event.event === "timeout") this.incomplete = true;
			if (event.event !== "ok" && event.event !== "failed" && event.event !== "ignored") return;
			if (typeof event.name !== "string") {
				this.incomplete = true;
				return;
			}
			const seconds = event.exec_time;
			if (event.event !== "ignored" && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0))
				this.incomplete = true;
			const source = event.name.match(/^(.+\.rs) - /)?.[1];
			if (!source) this.incomplete = true;
			this.cases.push({
				name: event.name,
				suite: this.suites,
				event: event.event,
				...(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? { seconds } : {}),
				...(typeof event.stdout === "string" ? { output: event.stdout } : {}),
				...(source ? { source: source.replaceAll("\\", "/") } : {}),
			});
		}
	}

	junitXml(): string {
		const cases = this.cases.map(test => {
			const suite = `rustdoc/${escapeXml(test.source ?? `unidentified-suite-${test.suite}`)}`;
			const time = test.seconds === undefined ? "" : ` time="${test.seconds}"`;
			const failure =
				test.event === "failed"
					? `<failure message="doctest failed">${escapeXml(test.output ?? "")}</failure>`
					: "";
			const skipped = test.event === "ignored" ? "<skipped/>" : "";
			return `    <testcase classname="${suite}" name="${escapeXml(test.name)}"${time}>${failure}${skipped}</testcase>`;
		});
		const failures = this.cases.filter(test => test.event === "failed").length;
		return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${this.cases.length}" failures="${failures}">\n  <testsuite name="rustdoc-doctests" tests="${this.cases.length}" failures="${failures}">\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
	}
}

function escapeXml(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
