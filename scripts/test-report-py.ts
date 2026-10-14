#!/usr/bin/env bun
// Keep the two independent pytest invocations and their -x stop rule.
import { beginTestRun, endTestRun, recordTestProducer, testReportPath } from "./test-reporting";

const integration = process.argv[2] === "integration";
if (process.argv.length > 3 || (process.argv[2] && !integration))
	throw new Error("Expected integration or no arguments");
const python = process.platform === "win32" ? "python" : "python3";
const directories = integration
	? ["python/robomp/tests/test_worker_smoke.py"]
	: ["sdk/python/omp-rpc/tests", "python/robomp/tests"];
const run = await beginTestRun(integration ? "robomp opt-in integration" : "Python SDK and robomp unit/integration");
const probe = Bun.spawnSync([python, "-m", "pytest", "--version"], { stdout: "pipe", stderr: "ignore" });
const pytestVersion = probe.exitCode === 0 ? probe.stdout.toString().trim() : "unavailable";
let exitCode = 0;
try {
	for (const directory of directories) {
		const reportPath = testReportPath(directory);
		const command = [
			python,
			"-m",
			"pytest",
			"-x",
			directory,
			`--junitxml=${reportPath}`,
			`--junit-prefix=${directory}`,
		];
		const startedAt = new Date().toISOString();
		const started = performance.now();
		const env = integration ? { ...process.env, ROBOMP_INTEGRATION: "1" } : process.env;
		try {
			const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
			exitCode = await child.exited;
			await recordTestProducer({
				producer: `pytest/${directory}`,
				command,
				scope: integration ? `${directory} (ROBOMP_INTEGRATION=1)` : directory,
				concurrency: 1,
				startedAt,
				durationSeconds: (performance.now() - started) / 1000,
				exitCode,
				reportPath,
				timingBasis: "pytest testcase.time: setup + call + teardown (seconds)",
				runnerVersion: pytestVersion,
			});
		} catch (error) {
			console.error(`Pytest reporting failed for ${directory}: ${String(error)}`);
			if (exitCode === 0) exitCode = 1;
		}
		if (exitCode !== 0) break;
	}
} finally {
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		console.error(`Could not finalize test timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
}
process.exitCode = exitCode;
