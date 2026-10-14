#!/usr/bin/env bun
// Keep the existing install script as the sole test executor; its probe commands
// emit case-level XML through test-report-command.ts in the inherited run dir.
import { beginTestRun, endTestRun, recordTestProducer } from "./test-reporting";

const run = await beginTestRun("binary and tarball install-method smoke (build plus CLI probes)");
const command = ["bash", "scripts/install-tests/run-ci.sh"];
const startedAt = new Date().toISOString();
const started = performance.now();
let exitCode = 1;
try {
	const child = Bun.spawn(command, { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	exitCode = await child.exited;
	await recordTestProducer({
		producer: "install-methods/build-and-tarball-stage",
		command,
		scope: "build, package, install and tarball integrity assertions; nested CLI probes have separate cases",
		concurrency: 1,
		startedAt,
		durationSeconds: (performance.now() - started) / 1000,
		exitCode,
		status: "partial",
		timingBasis: "stage wall time; not a per-test duration",
	});
} catch (error) {
	console.error(`Installer test path failed: ${String(error)}`);
	if (exitCode === 0) exitCode = 1;
} finally {
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		console.error(`Could not finalize installer timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
}
process.exitCode = exitCode;
