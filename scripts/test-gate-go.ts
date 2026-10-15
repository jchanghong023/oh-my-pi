#!/usr/bin/env bun
import * as path from "node:path";

/** Match Go's cmd/internal/quoted.Split: quotes only at the field start, no unescaping. */
export function splitGoCommand(value: string): string[] {
	const fields: string[] = [];
	let offset = 0;
	while (offset < value.length) {
		while (/[ \t\n\r]/.test(value[offset] ?? "")) offset++;
		if (offset >= value.length) break;
		const quote = value[offset];
		if (quote === '"' || quote === "'") {
			const end = value.indexOf(quote, offset + 1);
			if (end < 0) throw new Error("Unterminated Go quoted command");
			fields.push(value.slice(offset + 1, end));
			offset = end + 1;
		} else {
			const start = offset;
			while (offset < value.length && !/[ \t\n\r]/.test(value[offset])) offset++;
			fields.push(value.slice(start, offset));
		}
	}
	return fields;
}

if (import.meta.main) {
	const [command, ...args] = process.argv.slice(2);
	if (command !== "build" && command !== "test") {
		console.error("Usage: test-gate-go.ts <build|test> <existing Go arguments>");
		process.exit(1);
	}
	try {
		const wrapper = [process.execPath, path.join(import.meta.dir, "test-gate-compiler.ts"), "--go"]
			.map(arg => {
				if (arg.includes("'") && arg.includes('"'))
					throw new Error("Go cannot quote a wrapper path containing both quote characters");
				return arg.includes("'") ? `"${arg}"` : `'${arg}'`;
			})
			.join(" ");
		const existing = splitGoCommand(process.env.GOFLAGS ?? "").findLast(flag => flag.startsWith("-toolexec="));
		const priorWrapper = existing ? splitGoCommand(existing.slice("-toolexec=".length)) : [];
		const child = Bun.spawn(["go", command, `-toolexec=${wrapper}`, ...args], {
			cwd: process.cwd(),
			env: {
				...process.env,
				GOTOOLCHAIN: "local",
				OMP_GATE_BUN_BINARY: process.execPath,
				OMP_GATE_COMPILER_SCRIPT: path.join(import.meta.dir, "test-gate-compiler.ts"),
				OMP_GATE_ORIGINAL_GO_TOOLEXEC: JSON.stringify(priorWrapper),
			},
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		process.exit(await child.exited);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1);
	}
}
