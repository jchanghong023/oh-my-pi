#!/usr/bin/env bun
// Used by package-level tests and the script suite. The chunked TS driver
// handles its own child reporter paths instead of adding a process per chunk.
import * as path from "node:path";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath } from "./test-reporting";

const args = process.argv.slice(2);
const scope =
	path.relative(path.join(import.meta.dir, ".."), process.cwd()).replaceAll(path.sep, "/") || "repository scripts";
const run = await beginTestRun(`bun test: ${scope}`);
const reportPath = testReportPath(`bun-${scope}`);
const command = ["bun", "test", ...args, "--reporter=junit", `--reporter-outfile=${reportPath}`];
const startedAt = new Date().toISOString();
const started = performance.now();
let exitCode = 1;
try {
	const child = Bun.spawn(command, {
		cwd: process.cwd(),
		env: process.env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	exitCode = await child.exited;
	await recordTestProducer({
		producer: `bun/${scope}`,
		command,
		scope: args.join(" "),
		concurrency: args.find(arg => arg.startsWith("--parallel")) ?? "Bun default",
		startedAt,
		durationSeconds: (performance.now() - started) / 1000,
		exitCode,
		reportPath,
		timingBasis: "Bun testcase execution time (seconds)",
		runnerVersion: Bun.version,
	});
} catch (error) {
	console.error(`Test reporting failed: ${String(error)}`);
	if (exitCode === 0) exitCode = 1;
} finally {
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		console.error(`Could not finalize test timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
}
process.exitCode = exitCode;
