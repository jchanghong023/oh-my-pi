#!/usr/bin/env bun
// Fork static gate: the full TypeScript static trio (types via `check:ts`:
// oxlint + oxfmt --check + per-package tsc) plus a plain `cargo check
// --workspace`. Always runs both passes — unlike `bun run check:rs` (fmt
// --check + clippy via run-rs-task), which self-skips when no Rust-affecting
// files changed, this gate must never pass silently.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");

interface Command {
	label: string;
	argv: readonly string[];
	env?: Record<string, string>;
}

function pinnedRustChannel(): string {
	// rustup shims resolve the toolchain from the rustc process's cwd, and cargo
	// compiles registry dependencies with cwd inside ~/.cargo/registry — outside
	// this repo, so no rust-toolchain.toml applies and the shim falls back to the
	// rustup default (stable here). .cargo/config.toml's [unstable] flags then
	// hit "-Z is only accepted on the nightly compiler", and stable-built
	// artifacts poison the cache (E0514). RUSTUP_TOOLCHAIN pins every rustc
	// spawn to the workspace toolchain regardless of cwd.
	const match = /channel\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(repoRoot, "rust-toolchain.toml"), "utf-8"));
	return match?.[1] ?? "nightly-2026-08-12";
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function resolveCargoBinary(): Promise<string> {
	// On macOS hosts Homebrew's `rustup-init` shadows the rustup proxies, so ask
	// rustup for the toolchain's cargo directly (same guard as run-rs-task).
	const result = await $`rustup which cargo`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) {
		const resolved = result.stdout.toString().trim();
		if (resolved !== "") return resolved;
	}
	return "cargo";
}

/**
 * On Windows the workspace forces `CMAKE_GENERATOR = Ninja` (see
 * .cargo/config.toml), so `cargo check` still executes audiopus_sys's build
 * script and needs both `cmake` and `ninja` on PATH. VS Build Tools ships both
 * without exposing them; resolve the VS install via vswhere and prepend its
 * CMake/Ninja dirs — the same augmentation packages/natives scripts apply.
 * Other platforms return undefined (inherit env).
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

async function runCommand(command: Command): Promise<void> {
	console.log(`\n==> ${command.label}`);
	console.log(`$ ${command.argv.map(shellQuote).join(" ")}`);
	const child = Bun.spawn([...command.argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: command.env ? { ...process.env, ...command.env } : undefined,
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${command.label} failed with exit code ${exitCode}`);
}

async function main(): Promise<void> {
	const cargoBinary = await resolveCargoBinary();
	await runCommand({ label: "static/ts (types + lint + format)", argv: ["bun", "run", "check:ts"] });
	await runCommand({
		label: "static/rs (cargo check)",
		argv: [cargoBinary, "check", "--workspace"],
		env: { ...windowsRustBuildEnv(), RUSTUP_TOOLCHAIN: pinnedRustChannel() },
	});
}

if (import.meta.main) {
	if (process.argv.length > 2) {
		console.error("Usage: bun run fastcheck");
		console.error("Static gate only (TS types/lint/format + cargo check); it takes no options.");
		process.exitCode = 2;
	} else {
		const startedAt = performance.now();
		main()
			.then(() => {
				console.log(`\nfastcheck: PASS`);
				console.log(`fastcheck: total time ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
			})
			.catch(error => {
				console.error(`\nfastcheck: FAIL — ${error instanceof Error ? error.message : String(error)}`);
				process.exitCode = 1;
			});
	}
}
