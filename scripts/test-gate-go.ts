#!/usr/bin/env bun
import * as path from "node:path";
import { withChargedActivity } from "./test-gate-events";

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

// Match cmd/go's work.AddBuildFlags/AddCoverFlags and test flag registrations.
// Boolean flags (including buildvcs and test.v) never consume the next argument.
const goValueFlags: Record<string, true> = {
	"-C": true,
	"-asmflags": true,
	"-buildmode": true,
	"-compiler": true,
	"-covermode": true,
	"-coverpkg": true,
	"-debug-actiongraph": true,
	"-debug-runtime-trace": true,
	"-debug-trace": true,
	"-exec": true,
	"-gccgoflags": true,
	"-gcflags": true,
	"-installsuffix": true,
	"-ldflags": true,
	"-mod": true,
	"-modfile": true,
	"-o": true,
	"-overlay": true,
	"-p": true,
	"-pgo": true,
	"-pkgdir": true,
	"-tags": true,
	"-vet": true,
};
const goTestValueFlags: Record<string, true> = {
	"-bench": true,
	"-benchtime": true,
	"-blockprofile": true,
	"-blockprofilerate": true,
	"-count": true,
	"-coverprofile": true,
	"-cpu": true,
	"-cpuprofile": true,
	"-fuzz": true,
	"-fuzzminimizetime": true,
	"-fuzztime": true,
	"-list": true,
	"-memprofile": true,
	"-memprofilerate": true,
	"-mutexprofile": true,
	"-mutexprofilefraction": true,
	"-outputdir": true,
	"-parallel": true,
	"-run": true,
	"-shuffle": true,
	"-skip": true,
	"-timeout": true,
	"-trace": true,
};

/** Explicit flags override GOFLAGS; leave test-binary arguments after -args/-- untouched. */
export function extractGoToolExec(args: string[], goFlags: string): { args: string[]; originalWrapper: string[] } {
	const environmentFlag = splitGoCommand(goFlags).findLast(flag => /^--?toolexec=/.test(flag));
	let wrapper = environmentFlag?.slice(environmentFlag.indexOf("=") + 1);
	const remaining: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const flag = arg.startsWith("--") ? arg.slice(1) : arg;
		if (flag === "-args" || arg === "--") {
			remaining.push(...args.slice(index));
			break;
		}
		if (flag === "-toolexec") {
			if (index + 1 === args.length) throw new Error("Missing value for Go -toolexec");
			wrapper = args[++index];
		} else if (flag.startsWith("-toolexec=")) {
			wrapper = flag.slice("-toolexec=".length);
		} else {
			remaining.push(arg);
			const testFlag = flag.startsWith("-test.") ? `-${flag.slice("-test.".length)}` : flag;
			if ((goValueFlags[flag] === true || goTestValueFlags[testFlag] === true) && index + 1 < args.length) {
				// Go consumes a separate value even when it looks like another flag
				// or a test-binary separator. Equal forms are not in either table.
				remaining.push(args[++index]);
			}
		}
	}
	return { args: remaining, originalWrapper: splitGoCommand(wrapper ?? "") };
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
		const { args: goArgs, originalWrapper } = extractGoToolExec(args, process.env.GOFLAGS ?? "");
		// Go accepts -C only as the first flag; keep its operand ahead of ours.
		const chdir = goArgs.splice(
			0,
			goArgs[0] === "-C" || goArgs[0] === "--C" ? 2 : /^--?C=/.test(goArgs[0] ?? "") ? 1 : 0,
		);
		const invoke = () => {
			const child = Bun.spawn(["go", command, ...chdir, `-toolexec=${wrapper}`, ...goArgs], {
				cwd: process.cwd(),
				env: {
					...process.env,
					GOTOOLCHAIN: "local",
					OMP_GATE_BUN_BINARY: process.execPath,
					OMP_GATE_COMPILER_SCRIPT: path.join(import.meta.dir, "test-gate-compiler.ts"),
					OMP_GATE_ORIGINAL_GO_TOOLEXEC: JSON.stringify(originalWrapper),
				},
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			return child.exited;
		};
		// toolexec cannot observe test binaries, so a parallel package may be
		// testing throughout another package's compilation. Conservatively charge
		// the whole test command rather than exempting unproven pure compilation.
		process.exit(await (command === "test" ? withChargedActivity(invoke) : invoke()));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1);
	}
}
