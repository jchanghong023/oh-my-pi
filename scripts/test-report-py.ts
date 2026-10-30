#!/usr/bin/env bun
// Run supported independent pytest suites and report each result.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath } from "./test-reporting";

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== "integration" && arg !== "--full"))
	throw new Error("Expected [integration|--full]");
const integration = args.includes("integration");
const full = args.includes("--full");
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
const testmonDir = path.resolve("runs", "testmon", `${process.platform}-${process.arch}`);
try {
	for (const directory of suites) {
		if (!integration && !full) await fs.mkdir(testmonDir, { recursive: true });
		const reportPath = testReportPath(directory);
		const command = [python, "-m", "pytest", directory, `--junitxml=${reportPath}`, `--junit-prefix=${directory}`];
		if (!integration) command.push(...(full ? ["-p", "no:testmon", "-vv"] : ["--testmon", "-vv"]));
		const startedAt = new Date().toISOString();
		const started = performance.now();
		const env = { ...process.env };
		if (full) delete env.PYTEST_ADDOPTS;
		if (integration) env.ROBOMP_INTEGRATION = "1";
		else {
			delete env.ROBOMP_INTEGRATION;
			if (!full) env.TESTMON_DATAFILE = path.join(testmonDir, `${directory.replaceAll("/", "-")}.sqlite`);
		}
		try {
			const child = Bun.spawn(command, {
				env,
				stdin: "inherit",
				stdout: integration ? "inherit" : "pipe",
				stderr: "inherit",
			});
			let output = "";
			if (!integration && child.stdout !== undefined && child.stdout !== null && typeof child.stdout !== "number") {
				const decoder = new TextDecoder();
				for await (const chunk of child.stdout) {
					process.stdout.write(chunk);
					output = (output + decoder.decode(chunk, { stream: true })).slice(-65536);
				}
				output += decoder.decode();
			}
			const suiteExitCode = await child.exited;
			// Testmon reports its actual saved/total cases only in its verbose
			// summary; JUnit independently describes this invocation's cases.
			const summary = /Testmon savings \(deselected\/no testmon\)[\s\S]*?this run:\s*(\d+)\/(\d+)\s*\(/.exec(output);
			let selected: number | undefined;
			let deselected: number | undefined;
			if (summary) {
				const xml = Bun.spawnSync(
					[
						python,
						"-c",
						"import sys, xml.etree.ElementTree as E; r=E.parse(sys.argv[1]).getroot(); assert r.tag.rsplit('}',1)[-1] in ('testsuite','testsuites'); print(sum(1 for e in r.iter() if e.tag.rsplit('}',1)[-1]=='testcase'))",
						reportPath,
					],
					{ stdout: "pipe", stderr: "ignore" },
				);
				if (xml.exitCode === 0 && /^\d+\s*$/.test(xml.stdout.toString())) {
					selected = Number(xml.stdout.toString().trim());
					deselected = Number(summary[1]);
				}
			}
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
				status:
					!integration && !full && (selected === undefined || (selected === 0 && !deselected))
						? "partial"
						: !integration && suiteExitCode === 0 && selected === 0 && deselected
							? "not-selected"
							: undefined,
				selection: integration
					? undefined
					: full
						? { tool: "pytest", mode: "full", reason: "all ordinary tests in suite; integration is opt-in" }
						: {
								tool: "pytest-testmon",
								mode: "affected",
								selected,
								deselected,
								baseline: env.TESTMON_DATAFILE,
							},
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
