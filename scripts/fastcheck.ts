#!/usr/bin/env bun
// Fork static gate: the full TypeScript static trio (types via `check:ts`:
// oxlint + oxfmt --check + per-package tsc) plus a plain `cargo check
// --workspace`. Always runs both passes — unlike `bun run check:rs` (fmt
// --check + clippy via run-rs-task), which self-skips when no Rust-affecting
// files changed, this gate must never pass silently. The whole run is bounded
// by a hard 60s wall-clock budget: on expiry the live phase children are
// killed and the gate fails with TIMEOUT (a cold Rust cache can legitimately
// blow the budget; the unbounded static pass belongs to fulltest, which reuses
// this gate with FASTCHECK_BUDGET_MS=0).

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");

interface Command {
	label: string;
	argv: readonly string[];
	env?: Record<string, string>;
}

/** Hard wall-clock budget for the whole gate (AGENTS.md「验证」): fastcheck is
 * the agent's quick-feedback loop, so blowing the budget is a failure, never a
 * silent pass. */
export const FASTCHECK_TIMEOUT_MS = 60_000;

/** Raised when the gate exceeds its wall-clock budget; distinct from ordinary
 * phase failures so the CLI reports TIMEOUT instead of FAIL. */
export class FastcheckTimeoutError extends Error {
	constructor(budgetMs: number, elapsedMs: number) {
		super(`exceeded the ${budgetMs / 1000}s wall-clock budget after ${(elapsedMs / 1000).toFixed(2)}s`);
		this.name = "FastcheckTimeoutError";
	}
}

/** Effective wall-clock budget in milliseconds. Defaults to the 60s
 * quick-feedback budget; the FASTCHECK_BUDGET_MS env var overrides it per
 * invocation (fulltest passes 0 to run the same gate unbounded — by contract
 * the unbounded static pass belongs to fulltest, and a cold Rust cache
 * legitimately needs more than 60s). */
export function fastcheckBudgetMsFromEnv(): number {
	const raw = process.env.FASTCHECK_BUDGET_MS;
	if (raw === undefined) return FASTCHECK_TIMEOUT_MS;
	const budgetMs = Number(raw);
	if (!Number.isInteger(budgetMs) || budgetMs < 0) {
		throw new Error(`FASTCHECK_BUDGET_MS must be a non-negative integer of milliseconds, got: ${raw}`);
	}
	return budgetMs;
}

export interface FastcheckOptions {
	cargoBinary: string;
	rustEnv?: Record<string, string>;
}

export function buildFastcheckPhases(options: FastcheckOptions): readonly Command[] {
	return [
		{ label: "static/ts (types + lint + format)", argv: ["bun", "run", "check:ts"] },
		{ label: "static/rs (cargo check)", argv: [options.cargoBinary, "check", "--workspace"], env: options.rustEnv },
	];
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

/** Hard-kill a phase child together with its whole process tree. Bun's
 * kill() has no tree semantics (only the direct child gets the signal), so a
 * timed-out gate would otherwise leave grandchildren running (the per-package
 * toolchain spawns under check:ts, cargo's build helpers). Timeout path only;
 * normally exiting children never go through here. */
function killProcessTree(child: { pid: number }): void {
	if (process.platform === "win32") {
		// taskkill /T walks the spawned tree; a failure (already-dead PID,
		// missing taskkill) is ignored — the timeout verdict already failed
		// the gate.
		Bun.spawnSync(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return;
	}
	try {
		// Phase children spawn detached as process-group leaders, so -pid
		// signals every group member; an ESRCH throw just means the group
		// already exited.
		process.kill(-child.pid, "SIGKILL");
	} catch {}
}

/** Live phase children, so the budget path can kill whatever is running. */
const liveChildren = new Set<ReturnType<typeof Bun.spawn>>();

async function runCommand(command: Command): Promise<void> {
	console.log(`\n==> ${command.label}`);
	console.log(`$ ${command.argv.map(shellQuote).join(" ")}`);
	const child = Bun.spawn([...command.argv], {
		cwd: repoRoot,
		// POSIX: detached makes the child a process-group leader so a timeout
		// can kill its whole tree via killProcessTree; Windows uses taskkill.
		detached: process.platform !== "win32",
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: command.env ? { ...process.env, ...command.env } : undefined,
	});
	liveChildren.add(child);
	try {
		const exitCode = await child.exited;
		if (exitCode !== 0) throw new Error(`${command.label} failed with exit code ${exitCode}`);
	} finally {
		liveChildren.delete(child);
	}
}

/** Race the whole gate against the hard budget; on expiry kill the live phase
 * children and surface a timeout failure. A zero budget runs unbounded. */
async function enforceBudget<T>(startedAtMs: number, budgetMs: number, work: () => Promise<T>): Promise<T> {
	if (budgetMs === 0) return await work();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => {
						for (const child of liveChildren) {
							try {
								killProcessTree(child);
							} catch {}
						}
						reject(new FastcheckTimeoutError(budgetMs, performance.now() - startedAtMs));
					},
					Math.max(0, budgetMs - (performance.now() - startedAtMs)),
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function main(): Promise<void> {
	const phases = buildFastcheckPhases({
		cargoBinary: await resolveCargoBinary(),
		rustEnv: { ...windowsRustBuildEnv(), RUSTUP_TOOLCHAIN: pinnedRustChannel() },
	});
	for (const command of phases) await runCommand(command);
}

if (import.meta.main) {
	if (process.argv.length > 2) {
		console.error("Usage: bun run fastcheck");
		console.error("Static gate only (TS types/lint/format + cargo check); it takes no options.");
		process.exitCode = 2;
	} else {
		const startedAt = performance.now();
		const elapsedSeconds = () => ((performance.now() - startedAt) / 1000).toFixed(2);
		const gate = async (): Promise<void> => {
			await enforceBudget(startedAt, fastcheckBudgetMsFromEnv(), main);
		};
		gate()
			.then(() => {
				console.log(`\nfastcheck: PASS`);
				console.log(`fastcheck: total time ${elapsedSeconds()}s`);
			})
			.catch(error => {
				const timedOut = error instanceof FastcheckTimeoutError;
				console.error(
					`\nfastcheck: ${timedOut ? "TIMEOUT" : "FAIL"} — ${error instanceof Error ? error.message : String(error)}`,
				);
				console.error(`fastcheck: total time ${elapsedSeconds()}s`);
				process.exitCode = 1;
			});
	}
}
