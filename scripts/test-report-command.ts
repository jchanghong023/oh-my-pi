#!/usr/bin/env bun
// A single pre-existing smoke probe, not a replacement for a test framework.
import { observeGateUnhandledFailures } from "./test-gate-failure-events";
import { GateCommandError, reportGateFailure } from "./test-gate-runtime";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath, writeCommandCase } from "./test-reporting";

observeGateUnhandledFailures();

const separator = process.argv.indexOf("--");
if (separator !== 3 || separator + 1 >= process.argv.length)
	throw new Error("Usage: test-report-command.ts <case-name> -- <command> [args...]");
const name = process.argv[2];
const command = process.argv.slice(separator + 1);
const suite = "install-methods/cli";
const run = await beginTestRun(`atomic smoke: ${name}`);
const startedAt = new Date().toISOString();
const started = performance.now();
let exitCode = 1;
let status: "passed" | "failed" | "error" = "passed";
try {
	try {
		const child = Bun.spawn(command, { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		exitCode = await child.exited;
		if (exitCode !== 0) {
			reportGateFailure(new GateCommandError(`Smoke probe ${name} failed`, exitCode));
			status = "failed";
		}
	} catch (error) {
		reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), 1));
		status = "error";
		console.error(`Smoke probe ${name} could not start: ${String(error)}`);
	}
	const durationSeconds = (performance.now() - started) / 1000;
	const reportPath = testReportPath(name);
	await writeCommandCase(reportPath, suite, name, durationSeconds, status);
	await recordTestProducer({
		producer: `${suite}/${name}`,
		command,
		scope: "atomic command within existing install test",
		concurrency: 1,
		startedAt,
		durationSeconds,
		exitCode,
		reportPath,
		status,
		timingBasis: "atomic command wall time (seconds), includes its own setup/worker calls",
	});
} catch (error) {
	reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), exitCode || 1));
	throw error;
} finally {
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), exitCode || 1));
		throw error;
	}
}
process.exitCode = exitCode;
