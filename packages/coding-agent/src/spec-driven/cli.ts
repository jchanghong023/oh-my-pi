export type ResourceCommandName = "openspec" | "superpowers";

/** Run resource commands outside the framework so downstream tools own their flags. */
export async function runResourceCommand(
	name: ResourceCommandName,
	argv: string[],
	cwd = process.cwd(),
): Promise<void> {
	const script = argv[0];
	if (name === "superpowers" && (!script || script === "--help" || script === "-h")) {
		const usage =
			"Usage: omp superpowers <relative-skill-script> [args...]\n\nExamples:\n  omp superpowers skills/writing-skills/render-graphs.js <skill-directory>\n  omp superpowers skills/subagent-driven-development/scripts/review-package [-C DIR] <plan-file> <base> <head> [output-file]\n\nRuns only trusted bundled Superpowers skill scripts. Run SDD helpers from the working tree being executed; sdd-workspace, task-brief and review-package also accept -C DIR. JavaScript uses OMP's embedded Bun; shell scripts require Bash and POSIX utilities (Git Bash on Windows). Graph rendering also requires Graphviz (dot).\n";
		if (script) {
			process.stdout.write(usage);
			process.exitCode = 0;
		} else {
			process.stderr.write(usage);
			process.exitCode = 2;
		}
		return;
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		const { runOpenSpec, runSuperpowersScript } = await import("./resources");
		const result =
			name === "openspec"
				? await runOpenSpec(
						argv,
						cwd,
						controller.signal,
						process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY ? "terminal" : "capture",
					)
				: await runSuperpowersScript(script, argv.slice(1), cwd, controller.signal);
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		process.exitCode = result.exitCode;
	} catch (error) {
		if (name === "openspec") throw error;
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}
