#!/usr/bin/env bun
// Gate orchestration only. Underlying formatter/linter/compiler definitions
// remain in their existing package scripts and Rust runner.
import * as os from "node:os";
import * as path from "node:path";
import { GateCommandError, runGate, type GateCommand, type GateRun } from "./test-gate-runtime";

export const gateRepoRoot = path.resolve(import.meta.dir, "..");

export interface FastcheckOptions {
	limitSeconds?: number;
}

export function parseFastcheckArgs(args: readonly string[]): FastcheckOptions | null {
	if (args.length === 0) return {};
	if (args.length !== 1 || !args[0]!.startsWith("--limit-seconds=")) return null;
	const limitSeconds = Number(args[0]!.slice("--limit-seconds=".length));
	return Number.isFinite(limitSeconds) && limitSeconds > 0 && limitSeconds <= 60 ? { limitSeconds } : null;
}

/** Bounded parallelism without swallowing errors or abandoning live siblings. */
export async function runGateCommands(
	gate: GateRun,
	commands: readonly GateCommand[],
	concurrency = Math.min(4, Math.max(1, os.availableParallelism())),
): Promise<void> {
	const queue = [...commands];
	const failures: unknown[] = [];
	await Promise.all(
		Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
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
					failures.push(error);
					console.error(`${command.label}: ${error instanceof Error ? error.message : String(error)}`);
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
	for await (const manifest of new Bun.Glob("packages/*/package.json").scan({
		cwd: gateRepoRoot,
		onlyFiles: true,
	})) {
		const manifestPath = path.join(gateRepoRoot, manifest);
		const pkg = (await Bun.file(manifestPath).json()) as { name: string; scripts?: Record<string, string> };
		if (!pkg.scripts?.["check:types"]) continue;
		commands.push({
			label: `static/TS types ${pkg.name}`,
			argv: ["bun", "run", "check:types"],
			cwd: path.dirname(manifestPath),
		});
	}
	return commands;
}

export async function runFastcheck(gate: GateRun): Promise<void> {
	console.log("scope=fork-affected; existing TS/Rust static checks; fastcheck runs no tests");
	const commands = await gate.charged(fastcheckCommands);
	await runGateCommands(gate, commands);
}

if (import.meta.main) {
	const options = parseFastcheckArgs(process.argv.slice(2));
	const result = await runGate(
		"fastcheck",
		async gate => {
			if (!options) throw new GateCommandError("Usage: bun run fastcheck [--limit-seconds=<seconds <= 60>]", 2);
			await runFastcheck(gate);
		},
		options ?? {},
	);
	process.exitCode = result.exitCode;
}
