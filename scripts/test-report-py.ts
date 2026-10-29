#!/usr/bin/env bun
// Run supported independent pytest suites and report each result.
import { beginTestRun, endTestRun, recordTestProducer, testReportPath } from "./test-reporting";

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== "integration")) throw new Error("Expected [integration]");
const integration = args.includes("integration");
const windows = process.platform === "win32";
if (windows && integration) {
	console.error("UNSUPPORTED: Robomp integration tests are unsupported on native Windows.");
	process.exit(1);
}
if (windows) console.log("SKIPPED: Robomp tests are unsupported on native Windows.");
const python = windows ? "python" : "python3";
const suites = integration
	? ["python/robomp/tests/test_worker_smoke.py"]
	: windows
		? ["sdk/python/omp-rpc/tests"]
		: ["sdk/python/omp-rpc/tests", "python/robomp/tests"];
const run = await beginTestRun(
	integration ? "robomp opt-in integration" : windows ? "Python RPC SDK" : "Python SDK and robomp unit/integration",
);
let pytestVersion = "unavailable";
try {
	const probe = Bun.spawnSync([python, "-m", "pytest", "--version"], { stdout: "pipe", stderr: "ignore" });
	if (probe.exitCode === 0) pytestVersion = probe.stdout.toString().trim();
} catch {
	// The preflight below reports the unavailable interpreter.
}
let exitCode = 0;
let reportingFailed = false;
try {
	for (const directory of suites) {
		const reportPath = testReportPath(directory);
		const command = [python, "-m", "pytest", directory, `--junitxml=${reportPath}`, `--junit-prefix=${directory}`];
		const startedAt = new Date().toISOString();
		const started = performance.now();
		const env = { ...process.env };
		if (integration) env.ROBOMP_INTEGRATION = "1";
		else delete env.ROBOMP_INTEGRATION;
		try {
			const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
			const suiteExitCode = await child.exited;
			if (exitCode === 0 && suiteExitCode !== 0) exitCode = suiteExitCode;
			await recordTestProducer({
				producer: `pytest/${directory}`,
				command,
				scope: integration ? `${directory} (ROBOMP_INTEGRATION=1)` : directory,
				concurrency: 1,
				startedAt,
				durationSeconds: (performance.now() - started) / 1000,
				exitCode: suiteExitCode,
				reportPath,
				timingBasis: "pytest testcase.time: setup + call + teardown (seconds)",
				runnerVersion: pytestVersion,
			});
		} catch (error) {
			console.error(`Pytest reporting failed for ${directory}: ${String(error)}`);
			reportingFailed = true;
		}
	}
	if (exitCode === 0 && reportingFailed) exitCode = 1;
} finally {
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		console.error(`Could not finalize test timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
}
process.exitCode = exitCode;
