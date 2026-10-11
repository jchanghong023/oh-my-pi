#!/usr/bin/env bun
import * as path from "node:path";
import { GateCommandError, reportGateFailure, withChargedActivity, withCompilerActivity } from "./test-gate-runtime";

// Cargo supplies its workspace wrapper (e.g. clippy-driver) before rustc. Never
// exempt that mixed lint command; only the real compiler's crate invocations.
const incoming = process.argv.slice(2);
const go = incoming[0] === "--go";
const doctestCompile = incoming[0] === "--doctest-compile";
const doctestRun = incoming[0] === "--doctest-run";
const [compiler, ...args] = go || doctestCompile || doctestRun ? incoming.slice(1) : incoming;
if (!compiler) process.exit(1);
const originalWrapper = go || doctestCompile || doctestRun ? undefined : process.env.OMP_GATE_ORIGINAL_RUSTC_WRAPPER;
const commandPrefix: unknown = go
	? JSON.parse(process.env.OMP_GATE_ORIGINAL_GO_TOOLEXEC ?? "[]")
	: doctestRun
		? JSON.parse(process.env.OMP_GATE_ORIGINAL_DOCTEST_RUN ?? "[]")
		: [];
if (!Array.isArray(commandPrefix) || !commandPrefix.every(arg => typeof arg === "string"))
	throw new Error("Invalid original compiler/test wrapper");
const argv = originalWrapper ? [originalWrapper, compiler, ...args] : [...commandPrefix, compiler, ...args];
const compileOnly =
	doctestCompile ||
	(go
		? /^(?:compile|link)(?:\.exe)?$/i.test(path.basename(compiler)) &&
			!args.some(arg => arg === "-V" || arg.startsWith("-V=") || arg === "-h" || arg === "--help")
		: /^rustc(?:\.exe)?$/i.test(path.basename(compiler)) &&
			!/^clippy-driver(?:\.exe)?$/i.test(path.basename(originalWrapper ?? "")) &&
			args.includes("--crate-name") &&
			!args.some(arg => arg === "--print" || arg.startsWith("--print=") || arg === "-V" || arg === "--version"));
const invoke = async () => {
	try {
		const child = Bun.spawn(argv, {
			// Supplying --test-runtool prevents rustdoc from setting this itself.
			// The merged harness needs it to preserve per-doctest process isolation.
			env: doctestRun ? { ...process.env, RUSTDOC_DOCTEST_BIN_PATH: path.resolve(compiler) } : process.env,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			windowsHide: true,
		});
		const exitCode = await child.exited;
		// Rustdoc owns compile_fail/should_panic expectations; only its aggregate
		// result can classify a doctest compiler or executable exit as a failure.
		if (exitCode !== 0 && !doctestCompile && !doctestRun)
			reportGateFailure(new GateCommandError(`${path.basename(compiler)} failed`, exitCode));
		return exitCode;
	} catch (error) {
		reportGateFailure(
			new GateCommandError(
				error instanceof Error ? error.message : String(error),
				(error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1,
			),
		);
		throw error;
	}
};
process.exit(compileOnly && !doctestRun ? await withCompilerActivity(invoke) : await withChargedActivity(invoke));
