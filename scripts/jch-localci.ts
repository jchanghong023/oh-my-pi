#!/usr/bin/env bun

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Mode = "default" | "full";

interface Command {
	label: string;
	cwd: string;
	argv: readonly string[];
	env?: Record<string, string>;
}

interface TestGroup {
	label: string;
	cwd: string;
	files: readonly string[];
}

const repoRoot = path.resolve(import.meta.dir, "..");

const CORE_TYPECHECK_PACKAGES = ["agent", "ai", "tui", "natives", "coding-agent"] as const;

const CORE_RUST_CRATES = ["pi-natives", "pi-shell", "pi-edit", "pi-ast", "pi-iso", "pi-vcs", "pi-walker"] as const;

const CORE_TEST_GROUPS: readonly TestGroup[] = [
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
			"test/dirs.test.ts",
			"test/json.test.ts",
			"test/parse-streaming-json-throttled.test.ts",
			"test/path-tree.test.ts",
			"test/path.test.ts",
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
			"test/markdown.test.ts",
			"test/terminal-capabilities.test.ts",
			"test/text.test.ts",
		],
	},
	{
		label: "core/natives",
		cwd: "packages/natives",
		files: ["test/diff.test.ts", "test/native.test.ts", "test/vcs.test.ts"],
	},
];

const CODING_AGENT_TEST_GROUPS: readonly TestGroup[] = [
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
			"test/bash-execution-clamp.test.ts",
			"test/bash-executor.test.ts",
			"test/bash-failure-result.test.ts",
			"test/edit-blackbox.test.ts",
			"test/edit-mode.test.ts",
			"test/read-multi-range.test.ts",
			"test/read-single-pass.test.ts",
			"test/read-summary.test.ts",
			"test/read-tool.test.ts",
			"test/shell-snapshot.test.ts",
			"test/tool-execution-args.test.ts",
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
			"test/status-line-model.test.ts",
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
		label: "coding-agent/jch-commands",
		cwd: "packages/coding-agent",
		files: ["test/slash-commands/jch-git.test.ts", "test/slash-commands/magic-keywords.test.ts"],
	},
];

const NATIVE_REBUILD_PATHS = [
	/^crates\/.*\.rs$/,
	/^crates\/.*\/Cargo\.toml$/,
	/^Cargo\.toml$/,
	/^Cargo\.lock$/,
	/^\.cargo\//,
	/^rust-toolchain/,
	/^packages\/natives\//,
	/^scripts\/bazel-natives\.ts$/,
	/^scripts\/host-detect/,
] as const;

const RUST_TEST_PATHS = [
	/^crates\/.*\.rs$/,
	/^crates\/.*\/Cargo\.toml$/,
	/^Cargo\.toml$/,
	/^Cargo\.lock$/,
	/^\.cargo\//,
	/^rust-toolchain/,
] as const;

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function printUsage(): void {
	console.log("Usage: bun scripts/jch-localci.ts [full]");
	console.log("  default  Windows-x64 / Linux-x64 core regression without native rebuild");
	console.log("  full     Build the host native addon, then run the full localci scope");
}

function parseMode(args: readonly string[]): Mode | null {
	if (args.length === 0) return "default";
	if (args.length === 1 && args[0] === "full") return "full";
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		printUsage();
		return null;
	}
	console.error(`Unknown localci arguments: ${args.map(shellQuote).join(" ")}`);
	printUsage();
	return null;
}

function parseGitStatus(output: Uint8Array): string[] {
	const entries = new TextDecoder().decode(output).split("\0").filter(Boolean);
	const changedPaths: string[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3).replaceAll("\\", "/");
		if (changedPath !== "") changedPaths.push(changedPath);
		if (status.includes("R") || status.includes("C")) {
			const oldPath = entries[index + 1];
			if (oldPath) {
				changedPaths.push(oldPath.replaceAll("\\", "/"));
				index += 1;
			}
		}
	}
	return [...new Set(changedPaths)];
}

async function getChangedPaths(): Promise<string[]> {
	const result = Bun.spawnSync(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const stderr = result.stderr?.toString().trim() || `exit ${result.exitCode}`;
		throw new Error(`git status failed: ${stderr}`);
	}
	return parseGitStatus(result.stdout);
}

function matchesPath(filePath: string, patterns: readonly RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(filePath));
}

function isTypeScriptPath(filePath: string): boolean {
	return /\.(?:ts|tsx|mts|cts)$/.test(filePath);
}

function isNativeRebuildPath(filePath: string): boolean {
	return matchesPath(filePath, NATIVE_REBUILD_PATHS);
}

function isRustTestPath(filePath: string): boolean {
	return matchesPath(filePath, RUST_TEST_PATHS);
}

function commandForGroup(group: TestGroup): Command {
	return {
		label: `${group.label} (${group.files.length} files)`,
		cwd: group.cwd,
		argv: ["bun", "test", ...group.files],
	};
}

function commandText(command: Command): string {
	return `(cd ${shellQuote(command.cwd)} && ${command.argv.map(shellQuote).join(" ")})`;
}

function formatElapsed(milliseconds: number): string {
	return `${(milliseconds / 1000).toFixed(2)}s`;
}

async function runCommand(command: Command): Promise<number> {
	console.log(`\n==> ${command.label}`);
	console.log(`$ ${commandText(command)}`);
	// `bun test` never reads stdin; an inherited pipe whose write end stays open
	// (supervisor/pty-less contexts) would keep tests that wait on stdin EOF —
	// e.g. main-startup-watchdog's runRootCommand — hung until their timeout.
	const child = Bun.spawn([...command.argv], {
		cwd: path.join(repoRoot, command.cwd),
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: command.env ? { ...process.env, ...command.env } : undefined,
	});
	return child.exited;
}

async function runRequired(command: Command): Promise<void> {
	const exitCode = await runCommand(command);
	if (exitCode !== 0) throw new Error(`${command.label} failed with exit code ${exitCode}`);
}

async function runCommandPool(commands: readonly Command[], width: number): Promise<void> {
	const queue = [...commands];
	const failures: Array<{ command: Command; exitCode: number }> = [];

	async function worker(): Promise<void> {
		for (;;) {
			const command = queue.shift();
			if (!command) return;
			const exitCode = await runCommand(command);
			if (exitCode !== 0) failures.push({ command, exitCode });
		}
	}

	await Promise.all(Array.from({ length: Math.min(width, commands.length) }, () => worker()));
	if (failures.length > 0) {
		const details = failures.map(({ command, exitCode }) => `  - ${command.label}: exit ${exitCode}`).join("\n");
		throw new Error(`${failures.length} localci command(s) failed:\n${details}`);
	}
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
			`localci whitelist contains missing test file(s):\n${missing.map(file => `  - ${file}`).join("\n")}`,
		);
	}
}

async function runTypechecks(): Promise<void> {
	for (const packageName of CORE_TYPECHECK_PACKAGES) {
		await runRequired({
			label: `types/${packageName}`,
			cwd: `packages/${packageName}`,
			argv: ["bun", "run", "check:types"],
		});
	}
}

/**
 * On Windows the workspace forces `CMAKE_GENERATOR = Ninja` (see
 * .cargo/config.toml), so building audiopus_sys's bundled Opus needs both
 * `cmake` and `ninja` on PATH. VS Build Tools ships both without exposing
 * them; resolve the VS install via vswhere and prepend its CMake/Ninja dirs —
 * the same augmentation packages/natives/scripts/build-bindings.ts applies
 * for the addon build. Other platforms return undefined (inherit env).
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

async function runRustTests(): Promise<void> {
	const argv = ["cargo", "nextest", "run", ...CORE_RUST_CRATES.flatMap(crate => ["-p", crate])];
	await runRequired({ label: "rust/core", cwd: ".", argv, env: windowsRustBuildEnv() });
}

async function runCliSmoke(): Promise<void> {
	const cli = "packages/coding-agent/src/cli.ts";
	for (const [label, args] of [
		["cli/version", ["--version"]],
		["cli/help", ["--help"]],
		["cli/stats-help", ["stats", "--help"]],
	] as const) {
		await runRequired({ label, cwd: ".", argv: ["bun", cli, ...args] });
	}
}

async function main(mode: Mode): Promise<void> {
	const platformSupported = (process.platform === "linux" || process.platform === "win32") && process.arch === "x64";
	if (!platformSupported) {
		throw new Error(`jch-localci supports Windows x64 and Linux x64 (found ${process.platform}-${process.arch})`);
	}

	const changedPaths = await getChangedPaths();
	const typeScriptChanged = changedPaths.some(isTypeScriptPath);
	const nativeChanged = changedPaths.some(isNativeRebuildPath);
	const rustChanged = changedPaths.some(isRustTestPath);
	console.log(`localci: ${mode} mode; ${changedPaths.length} changed path(s)`);
	if (changedPaths.length > 0) {
		for (const changedPath of changedPaths.sort()) console.log(`  ${changedPath}`);
	}

	if (mode === "full") {
		await runRequired({ label: "build/native", cwd: ".", argv: ["bun", "run", "build:native"] });
	} else if (nativeChanged) {
		console.log("localci: native changes detected; default mode skips native rebuild (use explicit full mode)");
	}

	if (mode === "full" || typeScriptChanged) {
		await runRequired({ label: "fastcheck", cwd: ".", argv: ["bun", "run", "fastcheck"] });
	} else {
		console.log("localci: no locally modified TypeScript files; skipping fastcheck");
	}

	const testGroups = [...CORE_TEST_GROUPS, ...CODING_AGENT_TEST_GROUPS];
	await validateTestFiles(testGroups);
	await runTypechecks();
	const testCommands = testGroups.map(commandForGroup);
	const concurrency = Math.max(1, Math.min(4, os.availableParallelism()));
	console.log(`localci: running ${testCommands.length} core test groups with ${concurrency} workers`);
	await runCommandPool(testCommands, concurrency);

	if (mode === "full" || rustChanged) {
		await runRustTests();
	} else {
		console.log("localci: no Rust-affecting changes; skipping Rust core tests");
	}

	await runCliSmoke();
}

if (import.meta.main) {
	const mode = parseMode(process.argv.slice(2));
	if (mode === null) {
		process.exitCode = process.argv.length > 2 && (process.argv[2] === "--help" || process.argv[2] === "-h") ? 0 : 2;
	} else {
		const startedAt = performance.now();
		main(mode)
			.then(() => {
				console.log(`\nlocalci: PASS (${mode})`);
				console.log(`localci: total time ${formatElapsed(performance.now() - startedAt)}`);
			})
			.catch(error => {
				console.error(`\nlocalci: FAIL — ${error instanceof Error ? error.message : String(error)}`);
				console.error(`localci: total time ${formatElapsed(performance.now() - startedAt)}`);
				process.exitCode = 1;
			});
	}
}
