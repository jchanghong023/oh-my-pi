#!/usr/bin/env bun
import { withChargedActivity, withCompilerActivity } from "./test-gate-runtime";

const [command, ...args] = process.argv.slice(2);
if (command !== "build") {
	console.error("Usage: test-gate-bun.ts build <existing Bun build arguments>");
	process.exit(1);
}
try {
	const compilerOnly =
		!args.includes("--compile") || !args.some(arg => arg === "--target" || arg.startsWith("--target="));
	if (!compilerOnly && process.env.OMP_GATE_EVENT_TOKEN) {
		console.warn("UNVERIFIED_COMPILATION_ACCOUNTING: cross-target Bun runtime preparation remains charged");
	}
	const invoke = async () => {
		const child = Bun.spawn([process.execPath, command, ...args], {
			cwd: process.cwd(),
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		return await child.exited;
	};
	const exitCode = compilerOnly ? await withCompilerActivity(invoke) : await withChargedActivity(invoke);
	process.exit(exitCode);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1);
}
