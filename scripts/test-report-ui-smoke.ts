#!/usr/bin/env bun
// Preserve the real PTY runner and its fixtures. The child records each finished
// TUI scenario; this wrapper retains a failed stage if it cannot finish one.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beginTestRun, endTestRun, recordTestProducer } from "./test-reporting";

const command = ["bun", "scripts/fulltest-ui-smoke.ts", ...process.argv.slice(2)];
const run = await beginTestRun(`dev TUI PTY smoke: ${process.argv.slice(2).join(" ") || "all scenarios"}`);
const startedAt = new Date().toISOString();
const started = performance.now();
let exitCode = 1;
try {
	const child = Bun.spawn(command, { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	exitCode = await child.exited;
	await recordTestProducer({
		producer: "ui-smoke/runner-stage",
		command,
		scope: process.argv.slice(2).join(" ") || "all scenarios",
		concurrency: 1,
		startedAt,
		durationSeconds: (performance.now() - started) / 1000,
		exitCode,
		status: exitCode === 0 ? "stage" : "partial",
		timingBasis: "stage wall time; completed child scenarios have separate JUnit cases",
	});
} catch (error) {
	console.error(`UI smoke reporter could not launch runner: ${String(error)}`);
	if (exitCode === 0) exitCode = 1;
} finally {
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
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
