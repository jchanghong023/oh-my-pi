#!/usr/bin/env bun
import { withRustCompilerEvents } from "./test-gate-runtime";

const args = process.argv.slice(2);
if (args.length === 0) {
	console.error("Usage: test-gate-cargo.ts <existing cargo command and arguments>");
	process.exit(1);
}
try {
	const exitCode = await withRustCompilerEvents(
		{ ...(process.env as Record<string, string>), RUSTUP_AUTO_INSTALL: "0" },
		async env => {
			const child = Bun.spawn(["cargo", ...args], {
				cwd: process.cwd(),
				env,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			return await child.exited;
		},
	);
	process.exit(exitCode);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1);
}
