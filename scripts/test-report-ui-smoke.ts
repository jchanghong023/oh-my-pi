#!/usr/bin/env bun
// Preserve the real PTY runner and its fixtures. The child records each finished
// TUI scenario; this wrapper retains a failed stage if it cannot finish one.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { observeGateUnhandledFailures, GateCommandError, reportGateFailure } from "./test-gate-failure-events";
import { beginTestRun, endTestRun, recordTestProducer } from "./test-reporting";

observeGateUnhandledFailures();

const args = process.argv.slice(2);
const command = ["bun", "scripts/fulltest-ui-smoke.ts", ...args];
// Explicit selectors retain the standalone runner's behavior. The normal
// full suite can overlap independent fixtures; team and cancel share a stub.
const parallelSuite = args.every(arg => arg === "--debug");
const phases = parallelSuite ? ["--startup-only", "--team-group-only", "--repo-only"] : [undefined];
const concurrency = Math.min(phases.length, Math.max(1, os.availableParallelism()));
const run = await beginTestRun(`dev TUI PTY smoke: ${args.join(" ") || "all scenarios"}`);
const startedAt = new Date().toISOString();
const started = performance.now();
let exitCode = 0;
let interrupted = false;
const children = new Set<Subprocess<"inherit", "inherit", "inherit">>();
const interrupt = (signal: "SIGINT" | "SIGTERM") => {
	interrupted = true;
	if (exitCode === 0) exitCode = signal === "SIGINT" ? 130 : 143;
	for (const child of children) {
		try {
			child.kill(signal);
		} catch (error) {
			console.error(`Could not signal UI smoke runner: ${String(error)}`);
		}
	}
};
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
let nextPhase = 0;
async function runPhases(): Promise<void> {
	while (!interrupted && nextPhase < phases.length) {
		const phase = phases[nextPhase++];
		const phaseCommand = phase ? [...command, phase] : command;
		try {
			const child = Bun.spawn(phaseCommand, {
				env: process.env,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			children.add(child);
			let code: number;
			try {
				code = await child.exited;
			} finally {
				children.delete(child);
			}
			if (code !== 0 && exitCode === 0) {
				exitCode = code;
				reportGateFailure(new GateCommandError(`UI smoke runner failed (${phase ?? "all scenarios"})`, code));
			}
		} catch (error) {
			if (exitCode === 0) {
				exitCode = 1;
				reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), 1));
			}
			console.error(`UI smoke reporter could not launch runner: ${String(error)}`);
		}
	}
}
try {
	await Promise.all(Array.from({ length: concurrency }, () => runPhases()));
	if (interrupted) reportGateFailure(new GateCommandError("UI smoke runner interrupted", exitCode));
	await recordTestProducer({
		producer: "ui-smoke/runner-stage",
		command: ["bun", "scripts/test-report-ui-smoke.ts", ...args],
		scope: process.argv.slice(2).join(" ") || "all scenarios",
		concurrency,
		startedAt,
		durationSeconds: (performance.now() - started) / 1000,
		exitCode,
		status: exitCode === 0 ? "stage" : "partial",
		timingBasis: "stage wall time; completed child scenarios have separate JUnit cases",
	});
} catch (error) {
	reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), exitCode || 1));
	console.error(`UI smoke reporter could not launch runner: ${String(error)}`);
	if (exitCode === 0) exitCode = 1;
} finally {
	process.off("SIGINT", onSigint);
	process.off("SIGTERM", onSigterm);
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), exitCode || 1));
		console.error(`Could not finalize UI timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
		if (run.owner) {
			try {
				await fs.rm(path.join(run.dir, "run.json"), { force: true });
			} catch (removeError) {
				console.error(`Could not invalidate UI timing metadata: ${String(removeError)}`);
			}
		}
	}
}
process.exitCode = exitCode;
