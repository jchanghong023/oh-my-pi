#!/usr/bin/env bun
import * as path from "node:path";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath } from "./test-reporting";

type LibtestEvent = {
	type: string;
	event: string;
	name?: string;
	exec_time?: number;
	stdout?: string;
	message?: string;
	test_count?: number;
};
type RustCase = { name: string; result: "ok" | "failed" | "ignored"; seconds?: number; output?: string; message?: string };
type Suite = { cases: RustCase[]; count: number; completed: boolean };

if (process.argv.length !== 2) {
	console.error("Usage: bun scripts/sdk-test-rust.ts");
	process.exit(2);
}

// Keep cargo test itself: it runs both ordinary test targets and rustdoc tests.
// libtest's JSON formatter and per-case exec_time require the nightly test flags.
const command = ["cargo", "test", "--", "--format=json", "--report-time", "-Zunstable-options"];
const cwd = path.join(import.meta.dir, "..", "sdk", "rust", "omp-rpc");
const run = await beginTestRun("sdk/rust/omp-rpc unit and doctest");
const reportPath = testReportPath("sdk-rust-omp-rpc-unit-doc");
const startedAt = new Date().toISOString();
const started = performance.now();
const suites: Suite[] = [];
let active: Suite | undefined;
let incomplete = false;
let exitCode = 1;
let reportWritten = false;
let runnerVersion: string | undefined;

function escapeXml(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function accept(line: string): void {
	let event: LibtestEvent;
	try {
		event = JSON.parse(line) as LibtestEvent;
	} catch {
		console.error(`Non-JSON cargo test stdout (case timing cannot be verified): ${line}`);
		incomplete = true;
		return;
	}
	if (!event || typeof event.type !== "string" || typeof event.event !== "string") {
		incomplete = true;
		return;
	}
	if (event.type === "suite") {
		if (event.event === "started") {
			if (active || !Number.isInteger(event.test_count) || event.test_count! < 0) {
				incomplete = true;
				return;
			}
			active = { cases: [], count: event.test_count!, completed: false };
			suites.push(active);
		} else if (event.event === "ok" || event.event === "failed") {
			if (!active || active.completed) {
				incomplete = true;
				return;
			}
			active.completed = true;
			if (active.cases.length !== active.count) incomplete = true;
			console.log(`Rust SDK libtest suite ${suites.length}: ${active.cases.length} cases, ${event.event}`);
			active = undefined;
		} else {
			incomplete = true;
		}
		return;
	}
	if (event.type !== "test") {
		incomplete = true;
		return;
	}
	if (event.event === "started") return;
	if (!active || typeof event.name !== "string") {
		incomplete = true;
		return;
	}
	if (event.event !== "ok" && event.event !== "failed" && event.event !== "ignored") {
		incomplete = true;
		return;
	}
	if (event.event !== "ignored" && (typeof event.exec_time !== "number" || !Number.isFinite(event.exec_time) || event.exec_time < 0)) {
		console.error(`No libtest exec_time for ${event.name}`);
		incomplete = true;
		return;
	}
	active.cases.push({ name: event.name, result: event.event, seconds: event.exec_time, output: event.stdout, message: event.message });
	if (event.event === "failed") {
		console.error(`Rust SDK test failed: ${event.name}${event.message ? `: ${event.message}` : ""}`);
		if (event.stdout) console.error(event.stdout);
	}
}

function xml(): string {
	const chunks = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>'];
	for (const [index, suite] of suites.entries()) {
		// cargo does not attach a target identity to libtest events. Do not guess one.
		const label = `sdk/rust/omp-rpc libtest suite ${index + 1}`;
		const failures = suite.cases.filter(test => test.result === "failed").length;
		const skipped = suite.cases.filter(test => test.result === "ignored").length;
		chunks.push(`  <testsuite name="${label}" tests="${suite.cases.length}" failures="${failures}" skipped="${skipped}">`);
		for (const test of suite.cases) {
			const duration = test.seconds === undefined ? "" : ` time="${test.seconds}"`;
			chunks.push(`    <testcase classname="${label}" name="${escapeXml(test.name)}"${duration}>`);
			if (test.result === "ignored") chunks.push(`      <skipped${test.message ? ` message="${escapeXml(test.message)}"` : ""}/>`);
			if (test.result === "failed") chunks.push(`      <failure message="${escapeXml(test.message ?? "cargo test failed")}">${escapeXml(test.output ?? "")}</failure>`);
			chunks.push("    </testcase>");
		}
		chunks.push("  </testsuite>");
	}
	chunks.push("</testsuites>");
	return `${chunks.join("\n")}\n`;
}

try {
	const version = Bun.spawnSync(["rustc", "--version"], { cwd, stdout: "pipe", stderr: "ignore" });
	if (version.exitCode === 0) runnerVersion = version.stdout.toString().trim();
	const child = Bun.spawn(command, { cwd, env: process.env, stdin: "inherit", stdout: "pipe", stderr: "inherit" });
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
	if (active || suites.length === 0 || suites.some(suite => !suite.completed)) incomplete = true;
	if (suites.some(suite => suite.cases.length > 0)) {
		await Bun.write(reportPath, xml());
		reportWritten = true;
	}
} catch (error) {
	console.error(`Rust SDK test reporting failed: ${String(error)}`);
	exitCode = 1;
} finally {
	if (incomplete) console.error("Rust SDK libtest event stream was incomplete; timing report is partial");
	try {
		await recordTestProducer({
			producer: "rust/sdk/omp-rpc/unit-doc",
			command,
			scope: "cargo test (unit, integration and doctest; ignored smoke remains ignored)",
			startedAt,
			durationSeconds: (performance.now() - started) / 1000,
			exitCode,
			reportPath,
			status: "partial", // Cargo's libtest JSON omits stable target/binary identity across suites.
			timingBasis: reportWritten ? "nightly libtest --report-time per-case exec_time (seconds); ignored cases have no execution duration" : "libtest case timing unavailable",
			runnerVersion,
		});
	} catch (error) {
		console.error(`Could not record Rust SDK producer: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
	try {
		await endTestRun(run, exitCode);
	} catch (error) {
		console.error(`Could not finalize Rust SDK timing metadata: ${String(error)}`);
		if (exitCode === 0) exitCode = 1;
	}
}
process.exitCode = exitCode;
