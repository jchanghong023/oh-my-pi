#!/usr/bin/env bun
// Used by package-level tests and the script suite. The chunked TS driver
// handles its own child reporter paths instead of adding a process per chunk.
import * as path from "node:path";
import {
	BunTestFailureObserver,
	observeGateUnhandledFailures,
	GateCommandError,
	reportGateFailure,
} from "./test-gate-failure-events";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath } from "./test-reporting";
import { bunNoTestsSelected, bunTestSelection, type BunSelection } from "./ci-test-ts";

observeGateUnhandledFailures();

const args = process.argv.slice(2);
const changed = args.filter(arg => arg === "--changed" || arg.startsWith("--changed="));
if (changed.length > 1 || changed.some(arg => arg === "--changed="))
	throw new Error("Expected at most one --changed or --changed=<ref> option");
const selection: BunSelection = changed.length
	? {
			tool: "bun",
			mode: "affected",
			baseline: changed[0]!.slice("--changed=".length) || undefined,
			reason: "explicit affected selection",
		}
	: await bunTestSelection();
if (selection.mode === "affected" && !changed.length) args.push(`--changed=${selection.baseline}`);
console.log(
	selection.mode === "affected"
		? `selection=affected-tests-only tool=bun baseline=${selection.baseline ?? "working-tree"}; not full coverage`
		: `selection=full tool=bun reason=${selection.reason}`,
);
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
		env: { ...process.env, ...(process.stderr.isTTY ? { FORCE_COLOR: process.env.FORCE_COLOR ?? "1" } : {}) },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "pipe",
	});
	const observer = new BunTestFailureObserver(reportGateFailure);
	let stderrText = "";
	const decoder = new TextDecoder();
	const output = (async () => {
		for await (const bytes of child.stderr) {
			observer.push(bytes);
			stderrText += decoder.decode(bytes, { stream: true });
			process.stderr.write(bytes);
		}
		observer.end();
	})();
	await Promise.all([
		child.exited.then(code => {
			exitCode = code;
			if (code !== 0) reportGateFailure(new GateCommandError(`Bun tests failed: ${scope}`, code));
		}),
		output,
	]);
	const notSelected = selection.mode === "affected" && exitCode === 0 && bunNoTestsSelected(stderrText);
	await recordTestProducer({
		producer: `bun/${scope}`,
		command,
		scope: args.join(" "),
		concurrency: args.find(arg => arg.startsWith("--parallel")) ?? "Bun default",
		startedAt,
		durationSeconds: (performance.now() - started) / 1000,
		exitCode,
		reportPath: notSelected ? undefined : reportPath,
		status: notSelected ? "not-selected" : undefined,
		selection: notSelected ? { ...selection, selected: 0, reason: "Bun reported no affected test files" } : selection,
		timingBasis: "Bun testcase execution time (seconds)",
		runnerVersion: Bun.version,
	});
} catch (error) {
	reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), exitCode || 1));
	console.error(`Test reporting failed: ${String(error)}`);
	if (exitCode === 0) exitCode = 1;
} finally {
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), exitCode || 1));
		console.error(`Could not finalize test timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
}
process.exitCode = exitCode;
