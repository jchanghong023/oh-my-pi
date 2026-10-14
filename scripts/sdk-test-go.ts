#!/usr/bin/env bun
import * as path from "node:path";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath } from "./test-reporting";

type GoEvent = {
	Action: string;
	Package?: string;
	Test?: string;
	Elapsed?: number;
	Output?: string;
};
type GoCase = { name: string; seconds?: number; result: "pass" | "fail" | "skip"; output: string };

const mode = process.argv[2] === "--smoke" && process.argv.length === 3 ? "smoke" : process.argv.length === 2 ? "unit" : null;
if (!mode) {
	console.error("Usage: bun scripts/sdk-test-go.ts [--smoke]");
	process.exit(2);
}

const cwd = path.join(import.meta.dir, "..", "sdk", "go", "omp-rpc");
const run = await beginTestRun(`sdk/go/omp-rpc ${mode}`);
const reportPath = testReportPath(`sdk-go-omp-rpc-${mode}`);
const command = mode === "smoke" ? ["go", "test", "-json", "-run", "TestSmoke", "-v", "./..."] : ["go", "test", "-json", "-race", "./..."];
const startedAt = new Date().toISOString();
const started = performance.now();
const suites = new Map<string, Map<string, GoCase>>();
const logs = new Map<string, string>();
const packages = new Set<string>();
const packageFailures = new Set<string>();
let incomplete = false;
let exitCode = 1;
let reportWritten = false;
let runnerVersion: string | undefined;
const key = (pkg: string, test: string) => `${pkg}\0${test}`;

function escapeXml(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function accept(line: string): void {
	let event: GoEvent;
	try {
		event = JSON.parse(line) as GoEvent;
	} catch {
		console.error(`Non-JSON go test output: ${line}`);
		incomplete = true;
		return;
	}
	if (!event || typeof event.Action !== "string" || typeof event.Package !== "string") {
		incomplete = true;
		return;
	}
	const pkg = event.Package;
	packages.add(pkg);
	if (event.Action === "output" && typeof event.Output === "string") {
		process.stdout.write(event.Output);
		if (event.Test) {
			const id = key(pkg, event.Test);
			logs.set(id, (logs.get(id) ?? "") + event.Output);
		}
	}
	if (event.Test && (event.Action === "pass" || event.Action === "fail" || event.Action === "skip")) {
		const seconds = typeof event.Elapsed === "number" && Number.isFinite(event.Elapsed) && event.Elapsed >= 0
			? event.Elapsed
			: undefined;
		if (event.Action !== "skip" && seconds === undefined) {
			console.error(`No Go-reported case duration for ${pkg}/${event.Test}`);
			incomplete = true;
			return;
		}
		let cases = suites.get(pkg);
		if (!cases) suites.set(pkg, cases = new Map());
		cases.set(event.Test, { name: event.Test, seconds, result: event.Action, output: logs.get(key(pkg, event.Test)) ?? "" });
		logs.delete(key(pkg, event.Test));
	} else if (!event.Test && event.Action === "fail") {
		packageFailures.add(pkg);
	}
}

function xml(): string {
	const chunks = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>'];
	for (const pkg of packages) {
		const cases = [...(suites.get(pkg)?.values() ?? [])];
		const failures = cases.filter(test => test.result === "fail").length;
		const skipped = cases.filter(test => test.result === "skip").length;
		chunks.push(`  <testsuite name="${escapeXml(pkg)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`);
		for (const test of cases) {
			chunks.push(`    <testcase classname="${escapeXml(pkg)}" name="${escapeXml(test.name)}"${test.seconds === undefined ? "" : ` time="${test.seconds}"`}>`);
			if (test.result === "skip") chunks.push("      <skipped/>");
			if (test.result === "fail") chunks.push(`      <failure message="go test failed">${escapeXml(test.output)}</failure>`);
			chunks.push("    </testcase>");
		}
		chunks.push("  </testsuite>");
	}
	chunks.push("</testsuites>");
	return `${chunks.join("\n")}\n`;
}

try {
	const version = Bun.spawnSync(["go", "version"], { cwd, stdout: "pipe", stderr: "ignore" });
	if (version.exitCode === 0) runnerVersion = version.stdout.toString().trim();
	const child = Bun.spawn(command, {
		cwd,
		env: mode === "smoke" ? { ...process.env, OMP_RPC_SMOKE: "1" } : process.env,
		stdin: "inherit",
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });
		let newline: number;
		while ((newline = pending.indexOf("\n")) !== -1) {
			accept(pending.slice(0, newline).trimEnd());
			pending = pending.slice(newline + 1);
		}
	}
	pending += decoder.decode();
	if (pending.trim()) accept(pending.trimEnd());
	exitCode = await child.exited;
	if (packages.size === 0) incomplete = true;
	for (const pkg of packageFailures) {
		if (![...(suites.get(pkg)?.values() ?? [])].some(test => test.result === "fail")) {
			console.error(`Package ${pkg} failed outside a timed test case (build, setup or process failure)`);
			incomplete = true;
		}
	}
	if (suites.size > 0) {
		await Bun.write(reportPath, xml());
		reportWritten = true;
	}
} catch (error) {
	console.error(`Go SDK test reporting failed: ${String(error)}`);
	exitCode = 1;
} finally {
	try {
		await recordTestProducer({
			producer: `go/sdk/omp-rpc/${mode}`,
			command,
			scope: mode === "unit" ? "go test -race ./..." : "OMP_RPC_SMOKE=1 go test -run TestSmoke -v ./...",
			startedAt,
			durationSeconds: (performance.now() - started) / 1000,
			exitCode,
			reportPath,
			status: incomplete || !reportWritten ? "partial" : undefined,
			timingBasis: reportWritten ? "Go test -json per-test Elapsed (seconds)" : "Go case timing unavailable",
			runnerVersion,
		});
	} catch (error) {
		console.error(`Could not record Go SDK producer: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		console.error(`Could not finalize Go SDK timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
}
process.exitCode = exitCode;
