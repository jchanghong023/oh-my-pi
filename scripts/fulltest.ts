#!/usr/bin/env bun
// Fork full local verification, replacing the old `jch-localci`/`jch-dev-ui-test`
// entries: the fastcheck static gate, the fork-maintained green TS test set
// (curated whitelist — the full upstream shard suite is NOT Windows-runnable
// and is covered by the slowtest Linux CI pipeline instead), the Rust core
// crates via `cargo nextest` (fork scope; `pi-builtins` stays out, see
// docs-zh-CN/fork.md), repo script tests, and the dev-TUI PTY smoke. Python
// components (python/omp-rpc, python/robomp — upstream's optional self-hosted
// bot service) are fork-untouched and NOT tested locally. Needs the host
// native addon, so it always builds it first. The verdict is black and white:
// no failure exemptions, no baselines. End-to-end smoke and installer E2E are
// NOT local phases; the slowtest pipeline covers them. Only run on explicit
// user request (AGENTS.md「验证」).

import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");

// Fork scope for local Rust tests: the crates the fork actively maintains and
// that pass on Windows (pi-builtins has ~21 pre-existing upstream Windows
// failures and stays out of local verification by contract).
export const CORE_RUST_CRATES = [
	"pi-natives",
	"pi-shell",
	"pi-edit",
	"pi-ast",
	"pi-iso",
	"pi-vcs",
	"pi-walker",
] as const satisfies readonly string[];

export interface TestGroup {
	label: string;
	cwd: string;
	files: readonly string[];
}

// The fork-maintained green TS test set for the current OS. The full upstream
// shard suite assumes POSIX filesystems (control chars in filenames, chmod
// modes, symlinks, locks) and fails broadly on Windows; upstream CI covers it
// on Linux. Keep this list curated: entries must pass on the current OS, and
// `validateTestFiles` guards against upstream renames silently hollowing it.
export const WHITELIST_TEST_GROUPS: readonly TestGroup[] = [
	{
		label: "core/wire",
		cwd: "packages/wire",
		files: ["test/constants.test.ts"],
	},
	{
		label: "core/omptype",
		cwd: "packages/omptype",
		files: ["test/infer.test.ts", "test/json-schema.test.ts", "test/type.test.ts"],
	},
	{
		label: "core/utils",
		cwd: "packages/utils",
		files: [
			"test/console-sigint-diagnostics.test.ts",
			"test/dirs.test.ts",
			"test/json.test.ts",
			"test/parse-streaming-json-throttled.test.ts",
			"test/path-tree.test.ts",
			"test/path.test.ts",
			"test/postmortem-sigint-intercept.test.ts",
			"test/stream.test.ts",
		],
	},
	{
		label: "core/catalog",
		cwd: "packages/catalog",
		files: [
			"test/descriptors.test.ts",
			"test/hosts.test.ts",
			"test/model-id-affixes.test.ts",
			"test/model-thinking.test.ts",
			"test/provider-default-models.test.ts",
		],
	},
	{
		label: "core/ai",
		cwd: "packages/ai",
		files: [
			"test/schema-wire.test.ts",
			"test/thinking-loop.test.ts",
			"test/tool-argument-coercion.test.ts",
			"test/tool-call-loop-guard.test.ts",
			"test/transform-messages-dedup.test.ts",
			"test/transform-messages-redact-sensitive.test.ts",
		],
	},
	{
		label: "core/agent",
		cwd: "packages/agent",
		files: [
			"test/agent-loop.test.ts",
			"test/agent.test.ts",
			"test/compaction-boundary.test.ts",
			"test/context-tokens-orchestration.test.ts",
			"test/prompt-tools-loop.test.ts",
			"test/tool-protection.test.ts",
		],
	},
	{
		label: "core/snapcompact",
		cwd: "packages/snapcompact",
		files: ["test/snapcompact.test.ts"],
	},
	{
		label: "core/tui",
		cwd: "packages/tui",
		files: [
			"test/autocomplete.test.ts",
			"test/editor.test.ts",
			"test/input.test.ts",
			"test/keybindings.test.ts",
			"test/keys.test.ts",
			"test/magic-keywords.test.ts",
			"test/markdown.test.ts",
			"test/status-line-model.test.ts",
			"test/terminal-capabilities.test.ts",
			"test/text.test.ts",
		],
	},
	{
		label: "core/natives",
		cwd: "packages/natives",
		files: ["test/diff.test.ts", "test/native.test.ts", "test/vcs.test.ts"],
	},
	{
		label: "coding-agent/session",
		cwd: "packages/coding-agent",
		files: [
			"test/agent-session-event-order.test.ts",
			"test/agent-session-fresh.test.ts",
			"test/agent-session-model-persistence.test.ts",
			"test/agent-session-retry-fallback.test.ts",
			"test/agent-session-thinking-loop-retry.test.ts",
			"test/agent-session-tool-call-loop-guard.test.ts",
			"test/session/agent-session-error-log.test.ts",
			"test/session/messages.test.ts",
			"test/session/session-context.test.ts",
			"test/session/session-status.test.ts",
			"test/session-manager/create-empty-session-file.test.ts",
			"test/session-manager/file-operations.test.ts",
			"test/session-manager/session-id.test.ts",
			"test/session-manager/tree-traversal.test.ts",
		],
	},
	{
		label: "coding-agent/config",
		cwd: "packages/coding-agent",
		files: [
			"test/cli-argv-routing.test.ts",
			"test/config/models-config-validation.test.ts",
			"test/config/provider-globals.test.ts",
			"test/model-registry-default-config.test.ts",
			"test/model-registry-lazy-loading.test.ts",
			"test/model-resolver.test.ts",
			"test/profile-bootstrap.test.ts",
			"test/profile-cli.test.ts",
			"test/provider-default-selection.test.ts",
			"test/retry-fallback.test.ts",
			"test/settings-group-shadowing.test.ts",
			"test/settings-reload-cwd.test.ts",
		],
	},
	{
		label: "coding-agent/tools",
		cwd: "packages/coding-agent",
		files: [
			"test/bash-executor.test.ts",
			"test/bash-failure-result.test.ts",
			"test/edit-blackbox.test.ts",
			"test/edit-mode.test.ts",
			"test/read-multi-range.test.ts",
			"test/read-single-pass.test.ts",
			"test/read-summary.test.ts",
			"test/read-tool.test.ts",
			"test/shell-snapshot.test.ts",
			"test/tools/edit-renderer.test.ts",
			"test/tools/shell-tokenize.test.ts",
			"test/tools/tool-errors.test.ts",
			"test/tools/tool-timeouts.test.ts",
			"test/write-hashline-header.test.ts",
			"test/write-shebang-chmod.test.ts",
		],
	},
	{
		label: "coding-agent/ui",
		cwd: "packages/coding-agent",
		files: [
			"test/input-controller-escape.test.ts",
			"test/keybindings-display.test.ts",
			"test/main-interactive-input.test.ts",
			"test/main-startup-watchdog.test.ts",
			"test/startup-composer-graph.test.ts",
			"test/status-line-overflow.test.ts",
			"test/status-line-primary-agent.test.ts",
			"test/streaming-output.test.ts",
			"test/terminal-title-state.test.ts",
		],
	},
	{
		label: "coding-agent/task",
		cwd: "packages/coding-agent",
		files: [
			"test/subagent-advisor.test.ts",
			"test/task/commands.test.ts",
			"test/task/discovery.test.ts",
			"test/task/executor-launch-startup.test.ts",
			"test/task/parallel.test.ts",
			"test/task/spawn-policy.test.ts",
			"test/task/structured-subagent.test.ts",
			"test/task/task-batch.test.ts",
			"test/task/task-blocking-split.test.ts",
			"test/task/task-schema.test.ts",
		],
	},
	{
		label: "coding-agent/fork-features",
		cwd: "packages/coding-agent",
		files: [
			"test/modes/fullsend.test.ts",
			"test/modes/sigint-gate.test.ts",
			"test/slash-commands/jch-git.test.ts",
			"test/slash-commands/magic-keywords.test.ts",
			"test/slash-commands/team-command.test.ts",
			"test/team/controller.test.ts",
			"test/team/integration.test.ts",
			"test/team/members.test.ts",
			"test/team/orchestrator.test.ts",
			"test/team/runner.test.ts",
			"test/team/schemas.test.ts",
		],
	},
];

export interface FulltestCommand {
	label: string;
	argv: readonly string[];
	env?: Record<string, string>;
	/** Test-execution phase: hard-bounded by TEST_PHASE_TIMEOUT_MS. Compile and
	 * static phases are untimed (compile time is exempt by contract). */
	timed?: boolean;
}

export interface FulltestOptions {
	debug: boolean;
	cargoBinary: string;
	rustEnv?: Record<string, string>;
}

/** Hard budget for every test-execution phase; compile time is exempt. */
export const TEST_PHASE_TIMEOUT_MS = 3 * 60_000;

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function pinnedRustChannel(): string {
	// Same rationale as fastcheck: rustup shims resolve per-cwd and registry
	// deps compile outside the repo, where the rustup default (stable) would
	// reject .cargo/config.toml's nightly-only [unstable] flags.
	const match = /channel\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(repoRoot, "rust-toolchain.toml"), "utf-8"));
	return match?.[1] ?? "nightly-2026-08-12";
}

export function buildFulltestPhases(options: FulltestOptions): readonly FulltestCommand[] {
	const uiSmokeArgs = ["bun", "scripts/fulltest-ui-smoke.ts", ...(options.debug ? ["--debug"] : [])];
	return [
		{ label: "static/fastcheck", argv: ["bun", "scripts/fastcheck.ts"] },
		{ label: "build/native", argv: ["bun", "run", "build:native"] },
		// The whitelist phase is driven by runWhitelistPhase, not a single argv;
		// the placeholder keeps it visible in the phase plan.
		{ label: "ts/whitelist", argv: ["(fork-green-set)"] },
		{
			// Untimed: compiles the test binaries (also warms everything nextest
			// needs), so the timed nextest phase below is pure test execution.
			label: "rust/compile",
			argv: [options.cargoBinary, "test", "--no-run", ...CORE_RUST_CRATES.flatMap(crate => ["-p", crate])],
			env: options.rustEnv,
		},
		{
			label: "rust/core",
			argv: [options.cargoBinary, "nextest", "run", ...CORE_RUST_CRATES.flatMap(crate => ["-p", crate])],
			env: options.rustEnv,
			timed: true,
		},
		{ label: "scripts", argv: ["bun", "run", "test:scripts"], timed: true },
		{ label: "ui/smoke", argv: uiSmokeArgs, timed: true },
	];
}

function printUsage(): void {
	console.log("Usage: bun run fulltest [--debug]");
	console.log("  --debug  forward to the UI smoke phase (dump raw TUI output)");
}

export function parseFulltestArgs(args: readonly string[]): { debug: boolean } | null {
	if (args.length === 0) return { debug: false };
	if (args.every(arg => arg === "--debug")) return { debug: true };
	printUsage();
	return null;
}

async function resolveCargoBinary(): Promise<string> {
	// Same guard as run-rs-task: on macOS hosts Homebrew's `rustup-init`
	// shadows the rustup proxies, so ask rustup for the toolchain's cargo.
	const result = await $`rustup which cargo`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) {
		const resolved = result.stdout.toString().trim();
		if (resolved !== "") return resolved;
	}
	return "cargo";
}

/**
 * On Windows the workspace forces `CMAKE_GENERATOR = Ninja` (see
 * .cargo/config.toml), so building the core crates needs both `cmake` and
 * `ninja` on PATH. VS Build Tools ships both without exposing them; resolve
 * the VS install via vswhere and prepend its CMake/Ninja dirs. Other
 * platforms return undefined (inherit env).
 */
function windowsRustBuildEnv(): Record<string, string> | undefined {
	if (process.platform !== "win32" || (Bun.which("cmake") && Bun.which("ninja"))) return undefined;
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
	const probe = Bun.spawnSync(
		[vswhere, "-latest", "-products", "*", "-requires", vcToolsComponent, "-property", "installationPath"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const vsRoot = probe.exitCode === 0 ? probe.stdout.toString("utf-8").trim() : "";
	if (!vsRoot) return undefined;
	const cmakeExt = path.join(vsRoot, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake");
	const extraDirs = [path.join(cmakeExt, "CMake", "bin"), path.join(cmakeExt, "Ninja")].filter(dir => existsSync(dir));
	if (extraDirs.length === 0) return undefined;
	return { PATH: [...extraDirs, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
}

/** Race a phase promise against the test budget; on expiry kill the children
 * and fail the phase. Untimed phases (compile/static) pass straight through. */
async function withTestTimeout<T>(label: string, exited: Promise<T>, kill: () => void, timed: boolean): Promise<T> {
	if (!timed) return exited;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			exited,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					try {
						kill();
					} catch {}
					reject(new Error(`${label} exceeded the ${TEST_PHASE_TIMEOUT_MS / 60_000}-minute test timeout`));
				}, TEST_PHASE_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function runPhase(command: FulltestCommand): Promise<void> {
	console.log(`\n==> ${command.label}`);
	console.log(`$ ${command.argv.map(shellQuote).join(" ")}`);
	const child = Bun.spawn([...command.argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: command.env ? { ...process.env, ...command.env } : undefined,
	});
	const exitCode = await withTestTimeout(command.label, child.exited, () => child.kill(), command.timed === true);
	if (exitCode !== 0) throw new Error(`${command.label} failed with exit code ${exitCode}`);
}

async function validateTestFiles(groups: readonly TestGroup[]): Promise<void> {
	const missing: string[] = [];
	await Promise.all(
		groups.flatMap(group =>
			group.files.map(async file => {
				const relativePath = path.join(group.cwd, file);
				if (!(await Bun.file(path.join(repoRoot, relativePath)).exists())) missing.push(relativePath);
			}),
		),
	);
	if (missing.length > 0) {
		missing.sort();
		throw new Error(
			`fulltest whitelist contains missing test file(s):\n${missing.map(file => `  - ${file}`).join("\n")}`,
		);
	}
}

/** Run the fork green test groups in a bounded parallel pool; every group is a
 * plain black-and-white gate — any failure fails fulltest. The whole phase is
 * bounded by the test timeout; on expiry all live group children are killed. */
async function runWhitelistPhase(): Promise<void> {
	console.log(`\n==> ts/whitelist`);
	await validateTestFiles(WHITELIST_TEST_GROUPS);
	const queue = WHITELIST_TEST_GROUPS.map(group => ({
		label: `${group.label} (${group.files.length} files)`,
		cwd: group.cwd,
		argv: ["bun", "test", ...group.files] as const,
	}));
	const failures: Array<{ label: string; exitCode: number }> = [];
	const concurrency = Math.max(1, Math.min(4, os.availableParallelism()));
	const active = new Set<ReturnType<typeof Bun.spawn>>();
	console.log(`ts/whitelist: running ${queue.length} green-set groups with ${concurrency} workers`);

	async function worker(): Promise<void> {
		for (;;) {
			const entry = queue.shift();
			if (!entry) return;
			console.log(`\n==> ${entry.label}`);
			console.log(`(cd ${entry.cwd} && ${entry.argv.map(shellQuote).join(" ")})`);
			// `bun test` never reads stdin; an inherited pipe whose write end stays
			// open would keep stdin-EOF-waiting tests hung until their timeout.
			const child = Bun.spawn([...entry.argv], {
				cwd: path.join(repoRoot, entry.cwd),
				stdin: "ignore",
				stdout: "inherit",
				stderr: "inherit",
			});
			active.add(child);
			try {
				const exitCode = await child.exited;
				if (exitCode !== 0) failures.push({ label: entry.label, exitCode });
			} finally {
				active.delete(child);
			}
		}
	}

	const pool = Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
	await withTestTimeout(
		"ts/whitelist",
		pool,
		() => {
			for (const child of active) {
				try {
					child.kill();
				} catch {}
			}
		},
		true,
	);
	if (failures.length > 0) {
		const details = failures.map(({ label, exitCode }) => `  - ${label}: exit ${exitCode}`).join("\n");
		throw new Error(`ts/whitelist group(s) failed:\n${details}`);
	}
}

async function main(debug: boolean): Promise<void> {
	const platformSupported = (process.platform === "linux" || process.platform === "win32") && process.arch === "x64";
	if (!platformSupported) {
		throw new Error(`fulltest supports Windows x64 and Linux x64 (found ${process.platform}-${process.arch})`);
	}

	const phases = buildFulltestPhases({
		debug,
		cargoBinary: await resolveCargoBinary(),
		rustEnv: { ...windowsRustBuildEnv(), RUSTUP_TOOLCHAIN: pinnedRustChannel() },
	});
	console.log(`fulltest: ${phases.length} phases${debug ? " (ui-smoke debug dump on)" : ""}`);
	for (const phase of phases) {
		if (phase.label === "ts/whitelist") await runWhitelistPhase();
		else await runPhase(phase);
	}
}

if (import.meta.main) {
	const parsed = parseFulltestArgs(process.argv.slice(2));
	if (parsed === null) {
		process.exitCode = 2;
	} else {
		const startedAt = performance.now();
		main(parsed.debug)
			.then(() => {
				console.log(`\nfulltest: PASS`);
				console.log(`fulltest: total time ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
			})
			.catch(error => {
				console.error(`\nfulltest: FAIL — ${error instanceof Error ? error.message : String(error)}`);
				console.error(`fulltest: total time ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
				process.exitCode = 1;
			});
	}
}
