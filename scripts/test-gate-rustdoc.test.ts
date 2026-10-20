import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { forwardNextestOutput } from "./test-gate-native-events";
import { withRustCompilerEvents } from "./test-gate-runtime";
import type { GateCommandError } from "./test-gate-failure-events";

let directory: string;
let capture: string;
const windows = process.platform === "win32";
beforeAll(async () => {
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
	const compilerArgs = [...argumentsToPreserve, "--error-format=json"];
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
				const result = await invoke(executable, [process.execPath, capture, ...compilerArgs], {
					...env,
					OMP_ARGV_EXIT: "29",
				});
				expect(result.stderr).toBe("");
				expect(result.exitCode).toBe(29);
				expect(JSON.parse(result.stdout).args).toEqual(compilerArgs);
				const events = (await fs.readFile(eventFile, "utf8"))
					.trim()
					.split("\n")
					.map(line => JSON.parse(line.slice(line.indexOf("{")).trim()));
				expect(events.map(event => event.kind)).toEqual(
					executable === env.RUSTC_WRAPPER ? [activity, "failure", "idle"] : [activity, "idle"],
				);
			}
		},
	);
});

it("restores merged doctest process isolation without relaying expected nonzero exits", async () => {
	const runner = path.join(directory, "merged-doctest-boundary.ts");
	const eventFile = path.join(directory, "merged-doctest-events");
	await fs.writeFile(
		runner,
		`if (process.env.RUSTDOC_DOCTEST_BIN_PATH !== process.execPath) process.exit(31);
process.exit(29);`,
	);
	const result = await invoke(
		process.execPath,
		[path.join(import.meta.dir, "test-gate-compiler.ts"), "--doctest-run", process.execPath, runner],
		{
			...(process.env as Record<string, string>),
			OMP_GATE_EVENT_TOKEN: "merged-doctest-boundary",
			OMP_GATE_EVENT_FILE: eventFile,
			OMP_GATE_ORIGINAL_DOCTEST_RUN: "[]",
			RUSTDOC_DOCTEST_BIN_PATH: "incorrect inherited binary",
		},
	);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(29);
	const events = (await fs.readFile(eventFile, "utf8"))
		.trim()
		.split("\n")
		.map(line => JSON.parse(line.slice(line.indexOf("{")).trim()));
	expect(events.map(event => event.kind)).toEqual(["charged", "idle"]);
});

it("relays the first classified native failure before runner output closes and preserves all bytes", async () => {
	const first = `${JSON.stringify({ type: "test", event: "failed", name: "crate::lib$first_测试", exec_time: 0.01 })}\r\n`;
	const second = JSON.stringify({ type: "test", event: "failed", name: "crate::lib$second", exec_time: 0.02 });
	const bytes = new TextEncoder().encode(first + second);
	const failures: GateCommandError[] = [];
	const forwarded: Uint8Array[] = [];
	let observed!: () => void;
	const failure = new Promise<void>(resolve => {
		observed = resolve;
	});
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	let settled = false;
	const completion = forwardNextestOutput(
		stream,
		chunk => {
			forwarded.push(chunk);
		},
		error => {
			failures.push(error);
			observed();
		},
	).then(() => {
		settled = true;
	});
	const boundary = new TextEncoder().encode(first).length;
	controller.enqueue(bytes.subarray(0, boundary - 7));
	controller.enqueue(bytes.subarray(boundary - 7, boundary));
	await failure;
	expect(settled).toBe(false);
	expect(failures).toHaveLength(1);
	expect(failures[0].exitCode).toBe(100);
	expect(failures[0].message).toContain("first_测试");
	controller.enqueue(bytes.subarray(boundary));
	controller.close();
	await completion;
	expect(failures).toHaveLength(1);
	expect(Buffer.concat(forwarded)).toEqual(Buffer.from(bytes));
});

it("does not mistake expected panics, captured output or suite summaries for native failures", async () => {
	const lines = [
		JSON.stringify({
			type: "test",
			event: "ok",
			name: "crate::lib$expected_panic",
			stdout: '{"type":"test","event":"failed","name":"spoof"}\n',
		}),
		JSON.stringify({ type: "suite", event: "failed", failed: 1 }),
		"FAIL [0.001s] test output",
		'{"type":"test","event":"failed",',
	];
	const bytes = new TextEncoder().encode(lines.join("\n"));
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	const failures: GateCommandError[] = [];
	const forwarded: Uint8Array[] = [];
	await forwardNextestOutput(
		stream,
		chunk => {
			forwarded.push(chunk);
		},
		error => {
			failures.push(error);
		},
	);
	expect(failures).toEqual([]);
	expect(Buffer.concat(forwarded)).toEqual(Buffer.from(bytes));
});
