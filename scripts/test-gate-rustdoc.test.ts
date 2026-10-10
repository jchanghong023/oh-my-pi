import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withRustCompilerEvents } from "./test-gate-runtime";

let directory: string;
let capture: string;
const windows = process.platform === "win32";
beforeAll(async () => {
	if (!windows) return;
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rustdoc-argv-"));
	capture = path.join(directory, "capture args.ts");
	await fs.writeFile(
		capture,
		"console.log(JSON.stringify({args: process.argv.slice(2), run: process.env.OMP_GATE_ORIGINAL_DOCTEST_RUN})); process.exit(Number(process.env.OMP_ARGV_EXIT || 0));",
	);
});
afterAll(async () => {
	if (directory) await fs.rm(directory, { recursive: true, force: true });
});

// Longer than cmd.exe's 8191-character ceiling, but within CreateProcessW's limit.
const argumentsToPreserve = [
	"x".repeat(12_000),
	"",
	"spaces and Unicode \u6d4b\u8bd5",
	'embedded "quotes"',
	"C:\\path with spaces\\trailing\\",
	"& | < > ^ % !",
];
async function invoke(executable: string, args: string[], env: Record<string, string>) {
	const child = Bun.spawn([executable, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

it.skipIf(!windows)(
	"preserves long rustdoc argv, original runtool and nonzero exits through native entries",
	async () => {
		await withRustCompilerEvents(
			{
				...(process.env as Record<string, string>),
				OMP_GATE_EVENT_TOKEN: "rustdoc-argv",
				OMP_GATE_EVENT_FILE: path.join(directory, "events"),
				RUSTC_WRAPPER: "",
				RUSTDOC: process.execPath,
			},
			async env => {
				for (const exitCode of [0, 29]) {
					const result = await invoke(env.RUSTDOC, [capture, ...argumentsToPreserve], {
						...env,
						OMP_ARGV_EXIT: String(exitCode),
					});
					expect(result.stderr).toBe("");
					expect(result.exitCode).toBe(exitCode);
					expect(JSON.parse(result.stdout).args).toEqual(argumentsToPreserve);
				}
				const result = await invoke(
					env.RUSTDOC,
					[
						capture,
						...argumentsToPreserve,
						"--test",
						"--test-runtool=original runner",
						"--test-runtool-arg",
						"a b",
					],
					env,
				);
				expect(result.stderr).toBe("");
				expect(result.exitCode).toBe(0);
				const output = JSON.parse(result.stdout);
				expect(output.args).toEqual([
					...argumentsToPreserve,
					"--test",
					"-Zunstable-options",
					"--test-builder-wrapper",
					env.OMP_GATE_DOCTEST_COMPILER,
					"--test-runtool",
					env.OMP_GATE_DOCTEST_RUNNER,
				]);
				expect(JSON.parse(output.run)).toEqual(["original runner", "a b"]);
			},
		);
	},
);

it.skipIf(!windows)("preserves long compiler/doctest argv, exit codes and activity boundaries", async () => {
	const eventFile = path.join(directory, "compiler-events");
	await withRustCompilerEvents(
		{
			...(process.env as Record<string, string>),
			OMP_GATE_EVENT_TOKEN: "compiler-argv",
			OMP_GATE_EVENT_FILE: eventFile,
			RUSTC_WRAPPER: "",
		},
		async env => {
			for (const [executable, activity] of [
				[env.RUSTC_WRAPPER, "charged"],
				[env.OMP_GATE_DOCTEST_COMPILER, "compile"],
				[env.OMP_GATE_DOCTEST_RUNNER, "charged"],
			]) {
				await fs.writeFile(eventFile, "");
				const result = await invoke(executable, [process.execPath, capture, ...argumentsToPreserve], {
					...env,
					OMP_ARGV_EXIT: "29",
				});
				expect(result.stderr).toBe("");
				expect(result.exitCode).toBe(29);
				expect(JSON.parse(result.stdout).args).toEqual(argumentsToPreserve);
				const events = (await fs.readFile(eventFile, "utf8"))
					.trim()
					.split("\n")
					.map(line => JSON.parse(line.slice(line.indexOf("{")).trim()));
				expect(events.map(event => event.kind)).toEqual([activity, "idle"]);
			}
		},
	);
});
