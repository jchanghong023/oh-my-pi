import * as os from "node:os";
import type { GateCommand, GateRun } from "./test-gate-runtime";

/** Share a test-worker ceiling bounded by the available CPU allocation. */
export function testConcurrencyLimit(
	cores: number = os.availableParallelism(),
	_platform: NodeJS.Platform = process.platform,
): number {
	return Math.min(28, Math.max(1, Math.floor(cores)));
}

/** Run independent commands with bounded concurrency, continuing after ordinary failures. */
export async function runGateCommands(
	gate: GateRun,
	commands: readonly GateCommand[],
	options: { concurrency?: number; onCommandSettled?: (command: GateCommand) => void } = {},
): Promise<void> {
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
	let next = 0;
	let firstFailure: unknown;
	let failed = false;
	function recordFailure(error: unknown): void {
		if (!failed) {
			failed = true;
			firstFailure = error;
		}
	}
	async function worker(): Promise<void> {
		while (!gate.signal.aborted && next < commands.length) {
			const command = commands[next++]!;
			try {
				await gate.run(command);
			} catch (error) {
				recordFailure(error);
			} finally {
				try {
					options.onCommandSettled?.(command);
				} catch (error) {
					recordFailure(error);
				}
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, commands.length) }, () => worker()));
	if (gate.signal.aborted) throw gate.signal.reason;
	if (failed) throw firstFailure;
}
