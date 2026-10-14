#!/usr/bin/env bun
// Gate orchestration only. Underlying formatter/linter/compiler definitions
// remain in their existing package scripts and Rust runner.
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GATE_LIMIT_SECONDS, GateCommandError, runGate, type GateCommand, type GateRun } from "./test-gate-runtime";

export const gateRepoRoot = path.resolve(import.meta.dir, "..");

export interface FastcheckOptions {
	limitSeconds?: number;
}

/**
 * Independent gate commands (per-package tsc, per-file `bun test`) are mostly
 * single-process, so a fixed 4-wide pool idles most of a large host. Scale
 * with available cores, bounded against commands that parallelize internally
 * (tsgo and cargo clippy/nextest are multithreaded), clamped so small hosts
 * keep the previous 4 lanes and huge hosts stay memory-bounded.
 */
export function gatePoolWidth(cores: number = os.availableParallelism(), coresPerLane = 2, cap = 16): number {
	return Math.max(4, Math.min(cap, Math.floor(cores / coresPerLane)));
}

export function parseFastcheckArgs(args: readonly string[]): FastcheckOptions | null {
	if (args.length === 0) return {};
	if (args.length !== 1 || !args[0]!.startsWith("--limit-seconds=")) return null;
	const limitSeconds = Number(args[0]!.slice("--limit-seconds=".length));
	return Number.isFinite(limitSeconds) && limitSeconds > 0 && limitSeconds <= GATE_LIMIT_SECONDS.fastcheck
		? { limitSeconds }
		: null;
}

/** Bounded parallelism; the first failure cancels queued and live siblings. */
export async function runGateCommands(
	gate: GateRun,
	commands: readonly GateCommand[],
	// tsgo/clippy lanes are multithreaded; keep this pool narrower than the
	// per-file test pool so static checks do not thrash each other.
	concurrency = gatePoolWidth(undefined, 3, 12),
	// Keep one worker live while a stricter sibling owns the remaining capacity.
	rampUpAfter?: Promise<unknown>,
): Promise<void> {
	const queue = [...commands];
	const failures: unknown[] = [];
	await Promise.all(
		Array.from({ length: Math.min(concurrency, queue.length) }, async (_, worker) => {
			if (worker > 0 && rampUpAfter) {
				try {
					await rampUpAfter;
				} catch (error) {
					failures.push(gate.fail(error));
					return;
				}
			}
			for (;;) {
				if (gate.signal.aborted) break;
				const command = queue.shift();
				if (!command) break;
				try {
					// Explicit charged stages (notably runtime selftests) cannot
					// export simulated compiler intervals into the real gate.
					if (command.kind === "charged") await gate.charged(() => gate.run(command));
					else await gate.run(command);
				} catch (error) {
					failures.push(gate.fail(error));
					console.error(`${command.label}: ${error instanceof Error ? error.message : String(error)}`);
					return;
				}
			}
		}),
	);
	gate.signal.throwIfAborted();
	if (failures.length > 0) throw failures[0];
}

/** Preserve the fork's existing TS/Rust static primitives; execute no tests. */
export async function fastcheckCommands(): Promise<GateCommand[]> {
	const commands: GateCommand[] = [
		{ label: "static/TS lint+format", argv: ["bun", "run", "check:tools"], cwd: gateRepoRoot },
		{
			label: "static/Rust fmt+clippy",
			argv: ["bun", "run", "check:rs"],
			cwd: gateRepoRoot,
			env: { CI: "1", RUSTUP_AUTO_INSTALL: "0" },
		},
	];
	// These no-emit package primitives are independent. Reuse them unchanged
	// through the existing bounded runner rather than serializing the workspace.
	// Multi-config `tsgo ... && tsgo ...` scripts split into one command per
	// config so parallel lanes do not wait on a package-internal serial chain;
	// any other script shape keeps its existing whole-script command.
	const tsgo = path.join(gateRepoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsgo.exe" : "tsgo");
	for await (const manifest of new Bun.Glob("packages/*/package.json").scan({
		cwd: gateRepoRoot,
		onlyFiles: true,
	})) {
		const manifestPath = path.join(gateRepoRoot, manifest);
		const pkg = (await Bun.file(manifestPath).json()) as { name: string; scripts?: Record<string, string> };
		const script = pkg.scripts?.["check:types"];
		if (!script) continue;
		const segments = script
			.split("&&")
			.map(segment => segment.trim())
			.filter(Boolean);
		if (segments.length < 2 || !existsSync(tsgo) || segments.some(segment => !/^tsgo(?:\s|$)/.test(segment))) {
			commands.push({
				label: `static/TS types ${pkg.name}`,
				argv: ["bun", "run", "check:types"],
				cwd: path.dirname(manifestPath),
			});
			continue;
		}
		for (const segment of segments) {
			const args = segment.split(/\s+/).slice(1);
			const flag = args.indexOf("-p");
			const project = flag >= 0 ? args[flag + 1] : undefined;
			commands.push({
				label: `static/TS types ${pkg.name}${project ? ` ${project}` : ""}`,
				argv: [tsgo, ...args],
				cwd: path.dirname(manifestPath),
			});
		}
	}
	return commands;
}

export async function runFastcheck(gate: GateRun, concurrency?: number): Promise<void> {
	console.log("scope=fork-affected; existing TS/Rust static checks; fastcheck runs no tests");
	const commands = await gate.charged(fastcheckCommands);
	await runGateCommands(gate, commands, concurrency);
}

if (import.meta.main) {
	const options = parseFastcheckArgs(process.argv.slice(2));
	const result = await runGate(
		"fastcheck",
		async gate => {
			if (!options)
				throw new GateCommandError(
					`Usage: bun run fastcheck [--limit-seconds=<seconds <= ${GATE_LIMIT_SECONDS.fastcheck}>]`,
					2,
				);
			await runFastcheck(gate);
		},
		{ ...options, reportFailure: true },
	);
	process.exitCode = result.exitCode;
}
