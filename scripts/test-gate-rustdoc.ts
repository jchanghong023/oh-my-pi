#!/usr/bin/env bun
import * as path from "node:path";

const incoming = process.argv.slice(2);
const executable = process.env.OMP_GATE_ORIGINAL_RUSTDOC || "rustdoc";
let args = incoming;
let originalRun: string[] = [];
if (incoming.includes("--test")) {
	args = [];
	let runtool: string | undefined;
	const runArgs: string[] = [];
	for (let index = 0; index < incoming.length; index++) {
		const arg = incoming[index];
		if (arg === "--test-runtool") runtool = incoming[++index];
		else if (arg.startsWith("--test-runtool=")) runtool = arg.slice("--test-runtool=".length);
		else if (arg === "--test-runtool-arg") runArgs.push(incoming[++index]);
		else if (arg.startsWith("--test-runtool-arg=")) runArgs.push(arg.slice("--test-runtool-arg=".length));
		else args.push(arg);
	}
	originalRun = runtool ? [runtool, ...runArgs] : [];
	const extension = process.platform === "win32" ? ".cmd" : ".sh";
	args.push(
		"-Zunstable-options",
		"--test-builder-wrapper",
		process.env.OMP_GATE_DOCTEST_COMPILER || path.join(import.meta.dir, `test-gate-doctest-compile${extension}`),
		"--test-runtool",
		process.env.OMP_GATE_DOCTEST_RUNNER || path.join(import.meta.dir, `test-gate-doctest-run${extension}`),
	);
}
try {
	const child = Bun.spawn([executable, ...args], {
		env: { ...process.env, OMP_GATE_ORIGINAL_DOCTEST_RUN: JSON.stringify(originalRun), RUSTUP_AUTO_INSTALL: "0" },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(await child.exited);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1);
}
