#!/usr/bin/env bun
// Same four ordered CLI probes as ci:test:smoke; each is one command-level case.
import { beginTestRun, endTestRun, recordTestProducer, testReportPath, writeCommandCase } from "./test-reporting";

const entry = "packages/coding-agent/src/cli.ts";
const probes = [
	{ name: "source version", args: ["--version"] },
	{ name: "source help", args: ["--help"] },
	{ name: "stats help", args: ["stats", "--help"] },
	{ name: "worker smoke", args: ["--smoke-test"] },
];
const run = await beginTestRun("CI source CLI smoke: four ordered command probes");
let exitCode = 0;
try {
	for (const probe of probes) {
		const command = ["bun", entry, ...probe.args];
		const startedAt = new Date().toISOString();
		const started = performance.now();
		let status: "passed" | "failed" | "error" = "passed";
		try {
			const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
			exitCode = await child.exited;
			if (exitCode !== 0) status = "failed";
		} catch (error) {
			status = "error";
			exitCode = 1;
			console.error(`CLI smoke could not run ${probe.name}: ${String(error)}`);
		}
		const durationSeconds = (performance.now() - started) / 1000;
		const reportPath = testReportPath(`smoke-cli-${probe.name}`);
		await writeCommandCase(reportPath, "cli/source", probe.name, durationSeconds, status);
		await recordTestProducer({
			producer: `cli-smoke/${probe.name}`,
			command,
			scope: "source CLI",
			concurrency: 1,
			startedAt,
			durationSeconds,
			exitCode,
			reportPath,
			status,
			timingBasis: "atomic CLI command wall time (seconds), not nested test timing",
		});
		if (exitCode !== 0) break;
	}
} finally {
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		console.error(`Could not finalize smoke timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
}
process.exitCode = exitCode;
