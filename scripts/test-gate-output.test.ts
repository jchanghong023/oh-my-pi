import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const runtime = pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href;
const reporting = pathToFileURL(path.join(import.meta.dir, "test-reporting.ts")).href;
const failures = pathToFileURL(path.join(import.meta.dir, "test-gate-failure-events.ts")).href;

// These are real nested process/pipe boundaries, not console spies. A successful
// command must disappear only from presentation, never from execution or JUnit.
test.each(["fastcheck", "fulltest", "slowtest"])(
	"%s hides successful commands but retains their structured results",
	async level => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gate-output-"));
		const marker = path.join(directory, "executed");
		try {
			const source = `
import * as fs from "node:fs/promises";
import { runGate } from ${JSON.stringify(runtime)};
import { endTestRun, recordTestProducer, writeCommandCase } from ${JSON.stringify(reporting)};
const dir = ${JSON.stringify(directory)};
const started = performance.now();
const result = await runGate(${JSON.stringify(level)}, async gate => {
  gate.onFinalize(code => endTestRun({id:"presentation",dir,startedAt:new Date().toISOString(),startedMs:started,scope:"presentation fixture",owner:true,sourceRevision:null,dirtyState:null,dirtyStateIdentity:null}, code));
  const command = [process.execPath, "-e", ${JSON.stringify(`await Bun.write(${JSON.stringify(marker)}, "successful work ran"); console.log("SUCCESS_STDOUT_SENTINEL"); console.error("SUCCESS_STDERR_SENTINEL");`)}];
  const before = performance.now();
  await gate.run({label:"SUCCESS_COMMAND_SENTINEL", argv:command});
  const seconds = (performance.now() - before) / 1000;
  const xml = dir + "/executed.xml";
  await writeCommandCase(xml, "presentation", "SUCCESS_CASE_SENTINEL", seconds, "passed");
  await recordTestProducer({producer:"presentation command",command,scope:"presentation",startedAt:new Date().toISOString(),durationSeconds:seconds,exitCode:0,reportPath:xml});
}, {failureOnlyOutput:true});
process.exit(result.exitCode);
`;
			const child = Bun.spawn([process.execPath, "-e", source], {
				env: {
					...process.env,
					OMP_TEST_REPORT_DIR: directory,
					OMP_GATE_EVENT_TOKEN: "",
					OMP_GATE_EVENT_FILE: "",
					OMP_GATE_CLOCK_TOKEN: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stdout + stderr).toBe(0);
			expect(stdout + stderr).not.toContain("SUCCESS_");
			expect(stdout).toMatch(new RegExp(`${level}: PASS total=\\d+\\.\\ds .* exit=0`));
			expect(stdout).toContain(path.join(directory, "run.json"));
			expect(await fs.readFile(marker, "utf8")).toBe("successful work ran");
			const report = await Bun.file(path.join(directory, "run.json")).json();
			expect(report).toMatchObject({
				completion: "complete",
				exitCode: 0,
				reconciliation: { cases: 1, executed: 1, failures: 0 },
			});
			expect(report.producers).toHaveLength(1);
			expect(report.producers[0]).toMatchObject({ status: "passed", report: "available", exitCode: 0 });
			const xml = await fs.readFile(path.join(directory, report.producers[0].reportPath), "utf8");
			expect(xml).toContain('name="SUCCESS_CASE_SENTINEL"');
			expect(xml).toMatch(/time="\d+\.\d{6}"/);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	20_000,
);

// Authenticated failure notification must flush diagnostics while the failing
// command remains blocked, and ordinary failure must not cancel later work.
test("failure-only output reports the first failure before teardown and continues independent commands", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gate-live-output-"));
	const release = path.join(directory, "release");
	const later = path.join(directory, "later");
	const worker = path.join(directory, "worker.ts");
	await fs.writeFile(
		worker,
		`
import { existsSync } from "node:fs";
import { GateCommandError, reportGateFailure } from ${JSON.stringify(failures)};
// A producer writes its public diagnostic separately from the private event
// file, just as the Bun/Nextest reporters do before entering teardown.
console.error("FAILED_CASE_SENTINEL: FAILED_COMMAND_CONTEXT");
reportGateFailure(new GateCommandError("FAILED_CASE_SENTINEL", 23));
const keepAlive = setInterval(() => {}, 1000);
try { while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5); }
finally { clearInterval(keepAlive); }
console.error("FAILED_TEARDOWN_COMPLETE");
process.exit(23);
`,
	);
	const source = `
import {runGate} from ${JSON.stringify(runtime)};
const result = await runGate("fulltest", async gate => {
  try { await gate.run({label:"failing producer",argv:[process.execPath, ${JSON.stringify(worker)}]}); }
  catch (error) { if (error.exitCode !== 23) throw error; }
  await gate.run({label:"LATER_SUCCESS_COMMAND",argv:[process.execPath,"-e",${JSON.stringify(`await Bun.write(${JSON.stringify(later)}, "later work ran"); console.log("LATER_SUCCESS_OUTPUT");`)}]});
}, {failureOnlyOutput:true});
process.exit(result.exitCode);
`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		env: { ...process.env, OMP_GATE_EVENT_TOKEN: "", OMP_GATE_EVENT_FILE: "", OMP_GATE_CLOCK_TOKEN: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	let diagnostics = "";
	const notified = Promise.withResolvers<void>();
	const stderr = (async () => {
		const decoder = new TextDecoder();
		for await (const bytes of child.stderr) {
			diagnostics += decoder.decode(bytes, { stream: true });
			if (diagnostics.includes("FAILED_CASE_SENTINEL") && diagnostics.includes("FAILED_COMMAND_CONTEXT"))
				notified.resolve();
		}
		diagnostics += decoder.decode();
	})();
	const stdout = new Response(child.stdout).text();
	// Only a real pipe/event-loop deadline can bound this cross-process barrier.
	const timer = setTimeout(() => notified.reject(new Error("First failure was buffered until teardown")), 5000);
	try {
		await Promise.race([
			notified.promise,
			child.exited.then(code => {
				throw new Error(`Gate exited ${code} before its failure notification: ${diagnostics}`);
			}),
		]);
		expect(child.exitCode).toBeNull();
		expect(diagnostics).not.toContain("FAILED_TEARDOWN_COMPLETE");
		await fs.writeFile(release, "release");
		expect(await child.exited).toBe(23);
		await stderr;
		const output = await stdout;
		expect(diagnostics).toContain("FAILED_TEARDOWN_COMPLETE");
		expect(output + diagnostics).not.toContain("LATER_SUCCESS_");
		expect(output).toMatch(/fulltest: FAIL total=\d+\.\ds .* exit=23/);
		expect(await fs.readFile(later, "utf8")).toBe("later work ran");
	} finally {
		clearTimeout(timer);
		await fs.writeFile(release, "release");
		if (child.exitCode === null) child.kill("SIGKILL");
		await Promise.all([child.exited, stdout, stderr]);
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 15_000);
