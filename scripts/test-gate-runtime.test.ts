import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { GateCommand, GateLevel, GateRun } from "./test-gate-runtime";
import {
	GateCommandError,
	GateEventParser,
	GATE_LIMIT_SECONDS,
	runGate,
	withRustCompilerEvents,
} from "./test-gate-runtime";
import { splitGoCommand } from "./test-gate-go";
import { finalizeTestRun, writeCommandCase, type TestReportRun } from "./test-reporting";

let directory: string;
let stub: string;
const quiet = () => {};
// These are platform-clock/process-tree integration tests: fake timers cannot
// advance clocks inside the independently spawned stub commands.
const sleep = (ms: number) => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};
beforeAll(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gate-runtime-test-"));
	stub = path.join(directory, "stub.ts");
	await fs.writeFile(
		stub,
		`
import * as fs from "node:fs/promises";
const plan = JSON.parse(process.argv[2]);
if (plan.pidFile) await fs.writeFile(plan.pidFile, String(process.pid));
// Publish process readiness before this intentionally isolated clock-loading boundary.
const {gateClockNanoseconds} = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-clock.ts")).href)});
if (plan.cacheFile) {
  let cache = "";
  try { cache = await fs.readFile(plan.cacheFile, "utf8"); } catch {}
  await fs.writeFile(plan.cacheFile, cache + "warm\\n");
}
if (plan.grandchild) {
  const grandchild = Bun.spawn([process.execPath, import.meta.path, JSON.stringify({ms:30000,pidFile:plan.grandchild,output:"ready\\\\n"})], {stdout:"pipe",stderr:"inherit",detached:Boolean(plan.detachedGrandchild) && process.platform !== "win32"});
  const reader = grandchild.stdout.getReader();
  await reader.read();
  reader.releaseLock();
}
if (plan.output) { process.stdout.write(plan.output); process.stderr.write("stderr preserved\\n"); }
if (plan.interrupt) {
  // Load the runtime-selected fixture module inside the isolated process boundary.
  const {runGate} = await import(plan.runtime);
  const before = process.listenerCount("SIGINT");
  const result = await runGate("fastcheck", async gate => {
    process.emit("SIGINT");
    await gate.run({label:"interrupted stub",argv:[process.execPath,import.meta.path,JSON.stringify({ms:30000})]});
  }, {limitSeconds:0.8});
  process.stdout.write("INTERRUPT_RESULT" + JSON.stringify({result,restored:process.listenerCount("SIGINT") === before}));
  process.exit(result.exitCode);
}
if (plan.nested) {
  // The fixture receives the real runtime module URL across the subprocess boundary.
  const {runGate} = await import(plan.runtime);
  const result = await runGate("fulltest", async gate => {
    await gate.run({label:"compiler",argv:[process.execPath, import.meta.path,JSON.stringify({ms:plan.ms})],kind:"compile"});
  }, {print:()=>{}});
  process.exit(result.exitCode);
}
if (plan.nestedCapture) {
  // This intentionally exercises module loading in an independently spawned harness.
  const {GateCommandError,runGate} = await import(plan.runtime);
  const controller = new AbortController();
  let captured;
  let captureError;
  const result = await runGate("fulltest", async gate => {
    const capture = gate.capture({
      label:"capture fixture",
      argv:[process.execPath,import.meta.path,JSON.stringify({
        output:"private fixture bytes\\n",
        barrierReady:plan.barrierReady,
        barrierRelease:plan.barrierRelease,
        trailingBytes:plan.streamOutput && !plan.cancelCapture,
        ms:plan.cancelCapture ? 30000 : 0,
      })],
      streamOutput:plan.streamOutput,
    }).then(value => { captured=value; }, error => {
      captureError={message:error.message,exitCode:error.exitCode,status:error.status};
      throw error;
    });
    if (plan.cancelCapture) await Promise.all([capture,gate.charged(async () => {
      while (!gate.signal.aborted) {
        try { await fs.access(plan.cancelFile); break; } catch (error) { if(error.code !== "ENOENT") throw error; }
        await Bun.sleep(5);
      }
      if (gate.signal.aborted) throw gate.signal.reason;
      controller.abort(new GateCommandError("fixture capture interrupted",130,"INTERRUPTED"));
    })]);
    else await capture;
  }, {signal:controller.signal,limitSeconds:plan.streamOutput ? 2 : undefined,print:()=>{}});
  process.stdout.write("CAPTURE_RESULT" + JSON.stringify(captured ?? null));
  if (plan.streamOutput) process.stdout.write("\\nCAPTURE_STATUS" + JSON.stringify({result,captureError}));
  process.exit(result.exitCode);
}
if (plan.rustCargo) {
  // Exercise accounting across the independently spawned harness's runtime-selected module boundary.
  const {withRustCompilerEvents} = await import(plan.runtime);
  try {
    const exitCode = await withRustCompilerEvents({...process.env}, async env => {
      if (plan.rustCargo === "failure") throw new Error("fixture Cargo failure");
      if (plan.rustCargo === "completed") return 0;
      const compiler = Bun.spawn([process.execPath, plan.dispatcher, "--doctest-compile", process.execPath, import.meta.path, JSON.stringify({ms:900})], {env,stdout:"inherit",stderr:"inherit"});
      // Cargo launches build scripts directly: this child intentionally emits no events.
      const native = Bun.spawn([process.execPath, import.meta.path, JSON.stringify({ms:900})], {env,stdout:"inherit",stderr:"inherit"});
      const codes = await Promise.all([compiler.exited,native.exited]);
      return codes[0] || codes[1];
    });
    if (exitCode) process.exit(exitCode);
  } catch (error) {
    if (plan.rustCargo !== "failure") throw error;
    if (error.message !== "fixture Cargo failure") throw error;
  }
  if (plan.afterRustCompile) {
    const compiler = Bun.spawn([process.execPath, plan.dispatcher, "--doctest-compile", process.execPath, import.meta.path, JSON.stringify({ms:plan.afterRustCompile})], {stdout:"inherit",stderr:"inherit"});
    process.exit(await compiler.exited);
  }
  process.exit(0);
}
if (plan.capturedCompiler) {
  const compiler = Bun.spawn([process.execPath, plan.dispatcher, "--doctest-compile", process.execPath, import.meta.path, JSON.stringify({ms:900})], {stdout:"pipe",stderr:"pipe"});
  const compiled = Promise.all([compiler.exited, new Response(compiler.stdout).text(), new Response(compiler.stderr).text()]);
  const running = plan.mixedTool ? Bun.spawn([process.execPath, plan.dispatcher, ...(plan.goTool ? ["--go"] : []), plan.mixedTool, import.meta.path, JSON.stringify({ms:900}), "--crate-name", "fixture"], {stdout:"pipe",stderr:"pipe"}) : plan.parallelDoctest ? Bun.spawn([process.execPath, plan.dispatcher, "--doctest-run", process.execPath, import.meta.path, JSON.stringify({ms:900})], {stdout:"pipe",stderr:"pipe"}) : undefined;
  const tested = running ? Promise.all([running.exited,new Response(running.stdout).text(),new Response(running.stderr).text()]) : Promise.resolve([0]);
  const [built,ran] = await Promise.all([compiled,tested]);
  if (plan.compilerOutput) await fs.writeFile(plan.compilerOutput, built[2]);
  process.exit(built[0] || ran[0]);
}
if (plan.delayedEvents) {
  const wait = async () => { const pending=Promise.withResolvers(); setTimeout(pending.resolve,100); await pending.promise; };
  const aStart=gateClockNanoseconds(); await wait();
  const bStart=gateClockNanoseconds(); await wait();
  const bEnd=gateClockNanoseconds(); await wait();
  const aEnd=gateClockNanoseconds(); await wait();
  const records=[["b","compile",bStart],["a","compile",aStart],["a","idle",aEnd],["b","idle",bEnd]];
  await fs.appendFile(process.env.OMP_GATE_EVENT_FILE,records.map(([id,kind,at]) => "OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + " " + JSON.stringify({id,kind,at:at.toString(),clock:process.env.OMP_GATE_CLOCK_TOKEN}) + "\\n").join(""));
  process.stdout.write(JSON.stringify({compileMs:Number(aEnd-aStart)/1e6}));
  process.exit(0);
}
if (plan.delayedBoundary) {
  const wait = async ms => { const pending=Promise.withResolvers(); setTimeout(pending.resolve,ms); await pending.promise; };
  const emit = async (kind,at) => fs.appendFile(process.env.OMP_GATE_EVENT_FILE,"OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + " " + JSON.stringify({id:"delayed",kind,at:at.toString(),clock:process.env.OMP_GATE_CLOCK_TOKEN}) + "\\n");
  const start=gateClockNanoseconds();
  if (plan.delayedBoundary === "start") await wait(350);
  await emit("compile",start);
  await wait(plan.delayedBoundary === "start" ? 900 : 100);
  const end=gateClockNanoseconds();
  if (plan.delayedBoundary === "end") await wait(500);
  await emit("idle",end);
  await wait(plan.delayedBoundary === "start" ? 400 : 30000);
  process.exit(0);
}
if (plan.barrierReady) {
  await fs.writeFile(plan.barrierReady, String(process.pid));
  for (;;) {
    try { await fs.access(plan.barrierRelease); break; } catch (error) { if(error.code !== "ENOENT") throw error; }
    await Bun.sleep(5);
  }
}
if (plan.reportFailure) {
  // The parent supplies the runtime module URL across this isolated subprocess boundary.
  const {GateCommandError,reportGateFailure} = await import(plan.runtime);
  reportGateFailure(new GateCommandError("fixture nested check failed",plan.reportFailure));
}
if (plan.nestedFailure) {
  // Exercise a real nested entrypoint's explicit propagation across module/process boundaries.
  const {GateCommandError,runGate} = await import(plan.runtime);
  const result = await runGate("fulltest",async gate => {
    gate.fail(new GateCommandError("fixture real nested gate failure",43));
    await gate.charged(() => Promise.withResolvers().promise);
  },{reportFailure:true,print:()=>{}});
  process.exit(result.exitCode);
}
const phaseStart=gateClockNanoseconds();
if (plan.events) process.stderr.write("OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + " " + JSON.stringify({id:"compiler",kind:"compile",at:phaseStart.toString(),clock:process.env.OMP_GATE_CLOCK_TOKEN}) + "\\n");
const waiting = Promise.withResolvers();
setTimeout(waiting.resolve, plan.ms ?? 0);
await waiting.promise;
const phaseEnd=gateClockNanoseconds();
if (plan.events) process.stderr.write("OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + " " + JSON.stringify({id:"compiler",kind:"idle",at:phaseEnd.toString(),clock:process.env.OMP_GATE_CLOCK_TOKEN}) + "\\n");
if (plan.phaseTiming) process.stdout.write(JSON.stringify({start:phaseStart.toString(),end:phaseEnd.toString()}));
if (plan.trailingBytes) {
  process.stdout.write(new Uint8Array([0xe2]));
  process.stderr.write(new Uint8Array([0xe2]));
}
process.exit(plan.exit ?? 0);
`,
	);
});
afterAll(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});
function command(plan: Record<string, unknown>, extra: Partial<GateCommand> = {}): GateCommand {
	return { label: "isolated stub", argv: [process.execPath, stub, JSON.stringify(plan)], ...extra };
}

async function reportFixture(label: string): Promise<TestReportRun> {
	const dir = path.join(directory, `report-${label}`);
	await fs.mkdir(dir);
	await writeCommandCase(path.join(dir, "case.xml"), "gate finalization", "completed work", 0.001, "passed");
	await fs.writeFile(
		path.join(dir, "fixture.producer.json"),
		JSON.stringify({
			producer: "gate fixture",
			command: [process.execPath, stub],
			scope: "temporary gate task",
			startedAt: new Date().toISOString(),
			durationSeconds: 0.001,
			exitCode: 0,
			reportPath: "case.xml",
			report: "available",
			status: "passed",
		}),
	);
	return {
		id: label,
		dir,
		startedAt: new Date().toISOString(),
		startedMs: performance.now(),
		scope: "temporary gate task",
		owner: true,
		sourceRevision: null,
		dirtyState: null,
		dirtyStateIdentity: null,
	};
}

async function waitForFiles(files: string[], signal: AbortSignal): Promise<void> {
	while (!signal.aborted) {
		const ready = await Promise.all(
			files.map(async filename => {
				try {
					await fs.access(filename);
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					return false;
				}
			}),
		);
		if (ready.every(Boolean)) return;
		await sleep(5);
	}
	throw signal.reason;
}
async function parallelPhases(gate: GateRun, prefix: string, ms: number, compiler = false) {
	const ready = ["a", "b"].map(id => path.join(directory, `${prefix}-${id}.ready`));
	const release = path.join(directory, `${prefix}.release`);
	const [a, b] = await Promise.all([
		...ready.map(barrierReady =>
			gate.capture(
				command({
					ms,
					events: compiler,
					phaseTiming: true,
					barrierReady,
					barrierRelease: release,
				}),
			),
		),
		gate.charged(async () => {
			await waitForFiles(ready, gate.signal);
			await fs.writeFile(release, "ready");
		}),
	]);
	const timings = [a, b].map(captured => {
		if (!captured) throw new Error("Parallel fixture did not return its output");
		const timing = JSON.parse(captured.stdout) as { start: string; end: string };
		return { start: Number(BigInt(timing.start)) / 1e9, end: Number(BigInt(timing.end)) / 1e9 };
	});
	return [timings[0]!, timings[1]!] as const;
}

for (const level of ["fastcheck", "fulltest", "slowtest"] satisfies GateLevel[]) {
	describe(`${level} lifecycle`, () => {
		it("prints success with whole-run one-decimal timing", async () => {
			const output: string[] = [];
			const result = await runGate(
				level,
				async gate => {
					await gate.run(command({ ms: 20 }));
				},
				{ print: line => output.push(line) },
			);
			expect(result.status).toBe("PASS");
			expect(result.exitCode).toBe(0);
			expect(result.limitSeconds).toBe(GATE_LIMIT_SECONDS[level]);
			expect(result.budgetedSeconds).toBeGreaterThan(0);
			expect(result.totalSeconds).toBeCloseTo(result.budgetedSeconds + result.compileExcludedSeconds, 5);
			expect(output.at(-1)).toMatch(
				/PASS total=\d+\.\ds compile_excluded=\d+\.\ds budgeted=\d+\.\ds limit=\d+\.\ds exit=0$/,
			);
		});
		it("keeps the failing command exit code", async () => {
			const output: string[] = [];
			const result = await runGate(
				level,
				async gate => {
					await gate.run(command({ exit: 23 }));
				},
				{ print: line => output.push(line) },
			);
			expect(result.status).toBe("FAIL");
			expect(result.exitCode).toBe(23);
			expect(output.at(-1)).toMatch(
				/FAIL total=\d+\.\ds compile_excluded=\d+\.\ds budgeted=\d+\.\ds limit=\d+\.\ds exit=23$/,
			);
		});
		it("never reports a missing executable as success", async () => {
			const output: string[] = [];
			const result = await runGate(
				level,
				async gate => {
					await gate.run({ label: "absent tool", argv: [path.join(directory, "does-not-exist")] });
				},
				{ print: line => output.push(line) },
			);
			expect(result.status).toBe("MISSING_TOOL");
			expect(result.exitCode).toBe(127);
			expect(output.at(-1)).toMatch(
				/MISSING_TOOL total=\d+\.\ds compile_excluded=\d+\.\ds budgeted=\d+\.\ds limit=\d+\.\ds exit=127$/,
			);
		});
		it("terminates and awaits a timed-out command", async () => {
			const output: string[] = [];
			const result = await runGate(
				level,
				async gate => {
					await gate.run(command({ ms: 30000 }));
				},
				{ limitSeconds: 0.8, print: line => output.push(line) },
			);
			expect(result.status).toBe("TIMEOUT");
			expect(result.exitCode).toBe(124);
			expect(result.totalSeconds).toBeLessThan(2);
			expect(output.at(-1)).toMatch(
				/TIMEOUT total=\d+\.\ds compile_excluded=\d+\.\ds budgeted=\d+\.\ds limit=0\.8s exit=124$/,
			);
		});
		it("handles an interrupt and awaits external cleanup", async () => {
			const controller = new AbortController();
			const output: string[] = [];
			let cleaned = false;
			const timer = setTimeout(() => controller.abort(), 150);
			try {
				const result = await runGate(
					level,
					async gate => {
						await gate.run(
							command(
								{ ms: 30000 },
								{
									onAbort: async () => {
										await sleep(30);
										cleaned = true;
									},
								},
							),
						);
					},
					{ signal: controller.signal, limitSeconds: 0.8, print: line => output.push(line) },
				);
				expect(result.status).toBe("INTERRUPTED");
				expect(result.exitCode).toBe(130);
				expect(cleaned).toBe(true);
				expect(output.at(-1)).toMatch(
					/INTERRUPTED total=\d+\.\ds compile_excluded=\d+\.\ds budgeted=\d+\.\ds limit=0\.8s exit=130$/,
				);
			} finally {
				clearTimeout(timer);
			}
		});
	});
}

it("handles SIGINT with a summary and restores signal listeners", async () => {
	// A SIGINT in the Bun test runner interrupts the entire suite. Exercise
	// the gate in its own process, leaving the runner's handlers untouched.
	const child = Bun.spawn(
		[
			process.execPath,
			stub,
			JSON.stringify({
				interrupt: true,
				runtime: pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href,
			}),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const record = JSON.parse(stdout.slice(stdout.indexOf("INTERRUPT_RESULT") + "INTERRUPT_RESULT".length));
	expect(exitCode).toBe(130);
	expect(record.result.status).toBe("INTERRUPTED");
	expect(stdout).toContain("INTERRUPTED");
	expect(record.restored).toBe(true);
});
it("awaits charged finally cleanup after abort before printing the final summary", async () => {
	const controller = new AbortController();
	const events: string[] = [];
	const result = await runGate(
		"slowtest",
		async gate => {
			try {
				controller.abort();
				await gate.run(command({ ms: 30000 }));
			} finally {
				await gate.charged(async () => {
					await sleep(20);
					events.push("cleanup complete");
				});
			}
		},
		{ signal: controller.signal, limitSeconds: 0.8, print: line => events.push(line) },
	);
	expect(result.status).toBe("INTERRUPTED");
	expect(events[0]).toBe("cleanup complete");
	expect(events.at(-1)).toContain("INTERRUPTED");
	expect(result.budgetedSeconds).toBeGreaterThanOrEqual(0.015);
});
it("drains finally cleanup registered after an interrupted child scope settles", async () => {
	const events: string[] = [];
	const result = await runGate(
		"slowtest",
		async gate => {
			try {
				await gate.childGate(
					"fastcheck",
					async nested => {
						nested.fail(new GateCommandError("fixture child failure", 47));
						await Promise.withResolvers<void>().promise;
					},
					{ print: line => events.push(line) },
				);
			} finally {
				await gate.charged(async () => {
					await sleep(20);
					events.push("first cleanup complete");
				});
				await gate.charged(async () => {
					await sleep(20);
					events.push("second cleanup complete");
				});
			}
		},
		{ limitSeconds: 0.8, print: line => events.push(line) },
	);
	expect(result.exitCode).toBe(47);
	expect(events.at(-3)).toBe("second cleanup complete");
	expect(events.at(-1)).toContain("slowtest: FAIL");
	expect(result.budgetedSeconds).toBeGreaterThanOrEqual(0.035);
	expect(result.totalSeconds).toBeCloseTo(result.budgetedSeconds + result.compileExcludedSeconds, 5);
});

it("settles a successful gate only after its charged report finalizer writes complete/0", async () => {
	const run = await reportFixture("pass");
	let finalizerEnded = false;
	const output: string[] = [];
	const result = await runGate(
		"fulltest",
		async gate => {
			finalizeTestRun(gate, run);
			gate.onFinalize(async () => {
				await sleep(20);
				finalizerEnded = true;
			});
			await gate.charged(() => sleep(5));
		},
		{
			limitSeconds: 5,
			print: line => {
				expect(finalizerEnded).toBe(true);
				output.push(line);
			},
		},
	);
	const report = await Bun.file(path.join(run.dir, "run.json")).json();
	expect(result.status).toBe("PASS");
	expect(report.exitCode).toBe(result.exitCode);
	expect(report.completion).toBe("complete");
	expect(report.reconciliation.status).toBe("validated");
	expect(output.at(-1)).toContain("fulltest: PASS");
	expect(result.budgetedSeconds).toBeGreaterThanOrEqual(0.02);
});

it("awaits report finalization after its own budget expires and records partial/nonzero", async () => {
	const run = await reportFixture("timeout");
	let finalizerEnded = false;
	const result = await runGate(
		"slowtest",
		async gate => {
			gate.onFinalize(async () => {
				if (!gate.signal.aborted) {
					await new Promise<void>(resolve =>
						gate.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
					await sleep(20);
				}
				finalizerEnded = true;
			});
			finalizeTestRun(gate, run);
			await gate.charged(() => sleep(5));
		},
		{
			limitSeconds: 0.1,
			cleanupReserveMs: 0,
			print: () => expect(finalizerEnded).toBe(true),
		},
	);
	const report = await Bun.file(path.join(run.dir, "run.json")).json();
	expect(result.status).toBe("TIMEOUT");
	expect(result.exitCode).toBe(124);
	expect(report.exitCode).toBe(result.exitCode);
	expect(report.completion).toBe("partial");
	expect(result.budgetedSeconds).toBeGreaterThanOrEqual(0.1);
});

it("republishes a complete report when interrupted next to its last write, before closing the scope", async () => {
	const run = await reportFixture("interrupt-after-write");
	const controller = new AbortController();
	let finalizerEnded = false;
	const result = await runGate(
		"fulltest",
		async gate => {
			finalizeTestRun(gate, run);
			gate.onFinalize(async exitCode => {
				if (exitCode === 0) {
					const provisional = await Bun.file(path.join(run.dir, "run.json")).json();
					expect(provisional.completion).toBe("complete");
					expect(provisional.exitCode).toBe(0);
					controller.abort();
					await sleep(20);
				}
				finalizerEnded = true;
			});
		},
		{
			signal: controller.signal,
			limitSeconds: 5,
			print: () => expect(finalizerEnded).toBe(true),
		},
	);
	const report = await Bun.file(path.join(run.dir, "run.json")).json();
	expect(result.status).toBe("INTERRUPTED");
	expect(result.exitCode).toBe(130);
	expect(report.exitCode).toBe(result.exitCode);
	expect(report.completion).toBe("partial");
	expect(result.budgetedSeconds).toBeGreaterThanOrEqual(0.02);
});

it("republishes a successful report if the remaining charged budget expires after its last write", async () => {
	const run = await reportFixture("timeout-after-write");
	let finalizerEnded = false;
	const result = await runGate(
		"fulltest",
		async gate => {
			finalizeTestRun(gate, run);
			gate.onFinalize(async exitCode => {
				if (exitCode === 0) {
					const provisional = await Bun.file(path.join(run.dir, "run.json")).json();
					expect(provisional.completion).toBe("complete");
					expect(provisional.exitCode).toBe(0);
					if (!gate.signal.aborted)
						await new Promise<void>(resolve =>
							gate.signal.addEventListener("abort", () => resolve(), { once: true }),
						);
					await sleep(20);
				}
				finalizerEnded = true;
			});
		},
		{ limitSeconds: 2, print: () => expect(finalizerEnded).toBe(true) },
	);
	const report = await Bun.file(path.join(run.dir, "run.json")).json();
	expect(result.status).toBe("TIMEOUT");
	expect(result.exitCode).toBe(124);
	expect(report.exitCode).toBe(result.exitCode);
	expect(report.completion).toBe("partial");
});

it("preserves the first gate failure in finalized partial metadata", async () => {
	const run = await reportFixture("first-failure");
	const result = await runGate(
		"fulltest",
		async gate => {
			finalizeTestRun(gate, run);
			throw new GateCommandError("temporary task failed", 47);
		},
		{ limitSeconds: 5, print: quiet },
	);
	const report = await Bun.file(path.join(run.dir, "run.json")).json();
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(47);
	expect(report.exitCode).toBe(result.exitCode);
	expect(report.completion).toBe("partial");
});

it("keeps a missing producer report partial without treating unreported cases as passed", async () => {
	const run = await reportFixture("missing-report");
	const producerPath = path.join(run.dir, "fixture.producer.json");
	const producer = await Bun.file(producerPath).json();
	producer.report = "missing";
	producer.status = "partial";
	await fs.writeFile(producerPath, JSON.stringify(producer));
	await fs.unlink(path.join(run.dir, "case.xml"));
	const result = await runGate("fulltest", async gate => finalizeTestRun(gate, run), {
		limitSeconds: 5,
		print: quiet,
	});
	const report = await Bun.file(path.join(run.dir, "run.json")).json();
	expect(result.status).toBe("PASS");
	expect(report.exitCode).toBe(0);
	expect(report.completion).toBe("partial");
	expect(report.reconciliation.status).toBe("unavailable");
});

it("fails explicitly instead of passing when gate metadata cannot be recorded", async () => {
	const run = await reportFixture("unwritable");
	await fs.mkdir(path.join(run.dir, "run.json"));
	const output: string[] = [];
	const result = await runGate(
		"fulltest",
		async gate => {
			finalizeTestRun(gate, run);
		},
		{ limitSeconds: 5, print: line => output.push(line) },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).not.toBe(0);
	expect(output.some(line => line.includes("FINALIZE_FAIL"))).toBe(true);
	expect(output.at(-1)).toContain("fulltest: FAIL");
});

it("rejects late charged finally work from an untracked continuation after the failed summary", async () => {
	const resume = Promise.withResolvers<void>();
	const failure = new GateCommandError("fixture original failure", 47);
	const events: string[] = [];
	let lateWork: Promise<void> | undefined;
	const result = await runGate(
		"slowtest",
		async gate => {
			lateWork = (async () => {
				try {
					gate.fail(failure);
					await resume.promise;
				} finally {
					await gate.charged(async () => {
						events.push("late cleanup ran");
					});
				}
			})();
			await lateWork;
		},
		{ limitSeconds: 0.8, print: line => events.push(line) },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(47);
	expect(events.at(-1)).toContain("slowtest: FAIL");
	const summaryEvents = [...events];
	expect(lateWork).toBeDefined();
	resume.resolve();
	await expect(lateWork).rejects.toBe(failure);
	expect(events).toEqual(summaryEvents);
});

it("charges root entry setup and does not start work after its budget is already exhausted", async () => {
	let ran = false;
	const result = await runGate(
		"fastcheck",
		async () => {
			ran = true;
		},
		{
			get limitSeconds() {
				const until = performance.now() + 30;
				while (performance.now() < until) {
					// Model synchronous entry/setup work before the scope exists.
				}
				return 0.02;
			},
			cleanupReserveMs: 0,
			print: quiet,
		},
	);
	expect(ran).toBe(false);
	expect(result.status).toBe("TIMEOUT");
	expect(result.budgetedSeconds).toBeGreaterThanOrEqual(0.03);
	expect(result.totalSeconds).toBeCloseTo(result.budgetedSeconds + result.compileExcludedSeconds, 5);
});

it("cannot swallow a failed child gate to produce outer success", async () => {
	const result = await runGate(
		"slowtest",
		async gate => {
			try {
				await gate.childGate(
					"fulltest",
					async child => {
						await child.run(command({ exit: 19 }));
					},
					{ print: quiet },
				);
			} catch {
				/* Exercise a caller that attempts to suppress failure. */
			}
		},
		{ print: quiet, limitSeconds: 0.8 },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(19);
});
it("cancels parallel commands at the failing reply and preserves it through failing cleanup", async () => {
	const output: string[] = [];
	const hooks: string[] = [];
	const siblingCancelled = Promise.withResolvers<void>();
	const ready = ["failure", "sibling"].map(id => path.join(directory, `first-failure-${id}.ready`));
	const release = path.join(directory, "first-failure.release");
	const nextPid = path.join(directory, "first-failure-next.pid");
	const result = await runGate(
		"fulltest",
		async gate => {
			await Promise.allSettled([
				gate.run(
					command(
						{ barrierReady: ready[0], barrierRelease: release, exit: 23 },
						{
							onAbort: async () => {
								hooks.push("failing stage cleanup");
								await siblingCancelled.promise;
								throw new Error("fixture failing stage cleanup failed");
							},
						},
					),
				),
				gate.run(
					command(
						{ barrierReady: ready[1], barrierRelease: release, ms: 30000 },
						{
							onAbort: async () => {
								hooks.push("sibling cancelled");
								siblingCancelled.resolve();
							},
						},
					),
				),
				gate.charged(async () => {
					await waitForFiles(ready, gate.signal);
					await fs.writeFile(release, "ready");
				}),
			]);
			await gate.run(command({ pidFile: nextPid }));
		},
		{ limitSeconds: 2, print: line => output.push(line) },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(23);
	expect(hooks).toContain("failing stage cleanup");
	expect(hooks).toContain("sibling cancelled");
	expect(await Bun.file(nextPid).exists()).toBe(false);
	expect(
		output.some(line => line.includes("CLEANUP_FAIL") && line.includes("fixture failing stage cleanup failed")),
	).toBe(true);
	expect(output.at(-1)).toMatch(/FAIL total=\d+\.\ds compile_excluded=\d+\.\ds budgeted=\d+\.\ds limit=2\.0s exit=23/);
	expect(result.totalSeconds).toBeCloseTo(result.budgetedSeconds + result.compileExcludedSeconds, 5);
});

it("honors explicit nested failure events without waiting for their enclosing command to exit", async () => {
	for (const allowFailure of [false, true]) {
		const pidFile = path.join(directory, `nested-failure-${allowFailure}.pid`);
		const result = await runGate(
			"slowtest",
			async gate => {
				await gate.capture(
					command(
						{
							reportFailure: 29,
							runtime: pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href,
							pidFile,
							ms: 30000,
						},
						{ allowFailure },
					),
				);
			},
			{ limitSeconds: 2, print: quiet },
		);
		expect(result.status).toBe("FAIL");
		expect(result.exitCode).toBe(29);
		const pid = Number(await fs.readFile(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	}
});

it("relays a real nested gate failure before that gate finishes its tracked cleanup", async () => {
	const pidFile = path.join(directory, "real-nested-failure.pid");
	const result = await runGate(
		"slowtest",
		async gate => {
			await gate.capture(
				command({
					nestedFailure: true,
					runtime: pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href,
					pidFile,
				}),
			);
		},
		{ limitSeconds: 2, print: quiet },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(43);
	const pid = Number(await fs.readFile(pidFile, "utf8"));
	expect(() => process.kill(pid, 0)).toThrow();
});

it("never invokes queued child work after its parent has observed a failure", async () => {
	let started = false;
	const result = await runGate(
		"slowtest",
		async gate => {
			const child = gate.childGate(
				"fastcheck",
				async () => {
					started = true;
				},
				{ print: quiet },
			);
			void child.catch(() => {});
			gate.fail(new GateCommandError("fixture parent failure", 33));
		},
		{ limitSeconds: 2, print: quiet },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(33);
	expect(started).toBe(false);
});

it("stops a live command on stream-decoding failure instead of waiting for its charged timeout", async () => {
	const pidFile = path.join(directory, "decoder-failure.pid");
	const output: string[] = [];
	const result = await runGate(
		"fulltest",
		async gate => {
			await gate.capture(
				command(
					{ output: "decode this", pidFile, ms: 30000 },
					{
						decodeOutput: () => {
							throw new Error("fixture decoder failed");
						},
					},
				),
			);
		},
		{ limitSeconds: 2, print: line => output.push(line) },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(1);
	expect(output.some(line => line.includes("fixture decoder failed"))).toBe(true);
	const pid = Number(await fs.readFile(pidFile, "utf8"));
	expect(() => process.kill(pid, 0)).toThrow();
});

it("keeps the first failure in child scopes when an abort listener raises another error", async () => {
	const ready = Promise.withResolvers<GateRun>();
	const output: string[] = [];
	let childRun: GateRun | undefined;
	const result = await runGate(
		"slowtest",
		async gate => {
			const child = gate.childGate(
				"fastcheck",
				async nested => {
					ready.resolve(nested);
					await Promise.withResolvers<void>().promise;
				},
				{ print: line => output.push(line) },
			);
			void child.catch(() => {});
			childRun = await ready.promise;
			gate.signal.addEventListener("abort", () => childRun!.fail(new GateCommandError("secondary failure", 41)), {
				once: true,
			});
			gate.fail(new GateCommandError("first failure", 39));
		},
		{ limitSeconds: 2, print: line => output.push(line) },
	);
	expect(result.exitCode).toBe(39);
	expect((childRun!.signal.reason as GateCommandError).exitCode).toBe(39);
	expect(output.some(line => line.startsWith("fastcheck: FAIL") && line.endsWith("exit=39"))).toBe(true);
});

it("settles interrupted child scopes before the outer summary even with blocked untracked work", async () => {
	const output: string[] = [];
	const result = await runGate(
		"slowtest",
		async gate => {
			const child = gate.childGate(
				"fastcheck",
				async nested => {
					nested.fail(new GateCommandError("fixture first child failure", 31));
					await Promise.withResolvers<void>().promise;
				},
				{ print: line => output.push(line) },
			);
			void child.catch(() => {});
			await Promise.withResolvers<void>().promise;
		},
		{ limitSeconds: 2, print: line => output.push(line) },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(31);
	expect(output.at(-2)).toContain("slowtest: fixture first child failure");
	expect(output.at(-1)).toContain("slowtest: FAIL");
	expect(output.findIndex(line => line.startsWith("fastcheck: FAIL"))).toBeLessThan(
		output.findIndex(line => line.startsWith("slowtest: FAIL")),
	);
});

it("rejects malformed and foreign failure events while keeping the authenticated failure intact", () => {
	const failures: GateCommandError[] = [];
	const parser = new GateEventParser("owned", quiet, undefined, failure => failures.push(failure));
	parser.push(
		'OMP_GATE_EVENT foreign {"id":"a","kind":"failure","exitCode":37,"status":"FAIL","message":"foreign"}\n',
	);
	parser.push('OMP_GATE_EVENT owned {"id":"a","kind":"failure","exitCode":0,"status":"FAIL","message":"invalid"}\n');
	parser.push('OMP_GATE_EVENT owned {"id":"a","kind":"failure","exitCode":37,"status":"PASS","message":"invalid"}\n');
	parser.push(
		'OMP_GATE_EVENT owned {"id":"a","kind":"failure","exitCode":37,"status":"FAIL","message":"first failure"}\n',
	);
	expect(failures).toHaveLength(1);
	expect(failures[0]?.exitCode).toBe(37);
	expect(failures[0]?.message).toBe("first failure");
});
it("rejects invalid budgets and reserves with a complete final summary", async () => {
	for (const options of [{ limitSeconds: 0 }, { limitSeconds: Number.NaN }, { cleanupReserveMs: Number.NaN }]) {
		const output: string[] = [];
		const result = await runGate("fastcheck", async () => {}, { ...options, print: line => output.push(line) });
		expect(result.status).toBe("FAIL");
		expect(output.at(-1)).toMatch(/FAIL total=\d+\.\ds compile_excluded=0\.0s budgeted=\d+\.\ds limit=90\.0s exit=1/);
	}
});
it("keeps one cumulative clock across successive stages", async () => {
	const result = await runGate(
		"fulltest",
		async gate => {
			for (let count = 0; count < 3; count++) await gate.run(command({ ms: 350 }));
		},
		{ limitSeconds: 0.8, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
});
it("allows only downward tier overrides", async () => {
	for (const level of ["fastcheck", "fulltest", "slowtest"] satisfies GateLevel[]) {
		const result = await runGate(level, async () => {}, {
			limitSeconds: GATE_LIMIT_SECONDS[level] + 100,
			print: quiet,
		});
		expect(result.limitSeconds).toBe(GATE_LIMIT_SECONDS[level]);
	}
});
it("shares the outer clock across child scopes without resetting it", async () => {
	const result = await runGate(
		"slowtest",
		async gate => {
			await gate.childGate(
				"fulltest",
				async child => {
					await child.run(command({ ms: 350 }));
				},
				{ limitSeconds: 0.8, print: quiet },
			);
			await gate.childGate(
				"fulltest",
				async child => {
					await child.run(command({ ms: 350 }));
				},
				{ limitSeconds: 0.8, print: quiet },
			);
		},
		{ limitSeconds: 0.8, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
});
it("preserves a stricter child budget inside a larger outer gate", async () => {
	const result = await runGate(
		"slowtest",
		async gate => {
			await gate.childGate(
				"fastcheck",
				async child => {
					await child.run(command({ ms: 1000 }));
				},
				{ limitSeconds: 0.4, print: quiet },
			);
		},
		{ limitSeconds: 2, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
	expect(result.totalSeconds).toBeLessThan(1);
});
it(
	"allows compilation longer than the charged ceiling",
	async () => {
		const result = await runGate(
			"fastcheck",
			async gate => {
				await gate.run(command({ ms: 3000 }, { kind: "compile" }));
			},
			{ limitSeconds: 1.5, print: quiet },
		);
		expect(result.status).toBe("PASS");
		expect(result.totalSeconds).toBeGreaterThan(result.limitSeconds);
		expect(result.compileExcludedSeconds).toBeGreaterThan(result.limitSeconds);
		expect(result.budgetedSeconds).toBeLessThan(result.limitSeconds);
	},
	GATE_LIMIT_SECONDS.fastcheck * 1000,
);
it("does not swallow compiler failure", async () => {
	const result = await runGate(
		"fastcheck",
		async gate => {
			await gate.run(command({ exit: 31 }, { kind: "compile" }));
		},
		{ print: quiet },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(31);
});
it("counts overlapping compilers as a wall-clock union", async () => {
	let overlap = 0;
	let union = 0;
	const result = await runGate(
		"fastcheck",
		async gate => {
			const [a, b] = await parallelPhases(gate, "compiler-union", 900, true);
			overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
			union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
		},
		{ print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(overlap).toBeGreaterThan(0);
	expect(result.compileExcludedSeconds).toBeGreaterThanOrEqual(overlap - 0.025);
	expect(result.compileExcludedSeconds).toBeLessThanOrEqual(union + 0.025);
});
it("charges noncompile work even when a compiler is running", async () => {
	const result = await runGate(
		"fastcheck",
		async gate => {
			await Promise.all([gate.run(command({ ms: 30000 }, { kind: "compile" })), gate.run(command({ ms: 30000 }))]);
		},
		{ limitSeconds: 0.8, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
	expect(result.compileExcludedSeconds).toBeLessThan(0.15);
});
it("charges asynchronous filesystem/setup work overlapping compilation", async () => {
	const result = await runGate(
		"fastcheck",
		async gate => {
			await Promise.all([
				gate.run(command({ ms: 900 }, { kind: "compile" })),
				gate.charged(async () => {
					await sleep(900);
				}),
			]);
		},
		{ limitSeconds: 0.5, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
});
it("runs independent charged stages concurrently rather than summing durations", async () => {
	let overlap = 0;
	let union = 0;
	let sum = 0;
	const result = await runGate(
		"fulltest",
		async gate => {
			const [a, b] = await parallelPhases(gate, "charged-parallel", 250);
			overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
			union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
			sum = a.end - a.start + b.end - b.start;
		},
		{ print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(overlap).toBeGreaterThan(0);
	expect(union).toBeLessThan(sum);
	expect(result.compileExcludedSeconds).toBe(0);
});
it("preserves stub cache artifacts on consecutive invocations", async () => {
	const cacheFile = path.join(directory, "compiler-cache");
	for (let count = 0; count < 2; count++) {
		const result = await runGate(
			"fastcheck",
			async gate => {
				await gate.run(command({ cacheFile }, { kind: "compile" }));
			},
			{ print: quiet },
		);
		expect(result.status).toBe("PASS");
	}
	expect(await fs.readFile(cacheFile, "utf8")).toBe("warm\nwarm\n");
});
it("keeps stable compiler wrapper paths, flags and the original cache wrapper", async () => {
	const env = {
		OMP_GATE_EVENT_TOKEN: "test",
		RUSTC_WRAPPER: "original-cache-wrapper",
		RUSTFLAGS: "unchanged",
		CARGO_TARGET_DIR: "unchanged-target",
	};
	let wrapper: string | undefined;
	for (let count = 0; count < 2; count++)
		await withRustCompilerEvents(env, async compilerEnv => {
			if (wrapper) expect(compilerEnv.RUSTC_WRAPPER).toBe(wrapper);
			wrapper = compilerEnv.RUSTC_WRAPPER;
			expect(compilerEnv.RUSTFLAGS).toBe(env.RUSTFLAGS);
			expect(compilerEnv.CARGO_TARGET_DIR).toBe(env.CARGO_TARGET_DIR);
			expect(compilerEnv.OMP_GATE_ORIGINAL_RUSTC_WRAPPER).toBe(env.RUSTC_WRAPPER);
			expect(compilerEnv.RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
		});
});
it("charges unwrapped Cargo build-script work overlapping observed compiler events", async () => {
	const result = await runGate(
		"fastcheck",
		async gate => {
			await gate.run(
				command({
					rustCargo: "mixed",
					runtime: pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href,
					dispatcher: path.join(import.meta.dir, "test-gate-compiler.ts"),
				}),
			);
		},
		{ limitSeconds: 0.8, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
	expect(result.compileExcludedSeconds).toBe(0);
});
it.each(["completed", "failure"])(
	"releases mixed Cargo accounting after %s before later pure compilation",
	async rustCargo => {
		// Include native-launcher preparation in charged time. The compiler
		// stub still exceeds the injected budget, so PASS proves exclusion.
		const result = await runGate(
			"fastcheck",
			async gate => {
				await gate.run(
					command({
						rustCargo,
						afterRustCompile: 3_000,
						runtime: pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href,
						dispatcher: path.join(import.meta.dir, "test-gate-compiler.ts"),
					}),
				);
			},
			{ limitSeconds: 2, print: quiet },
		);
		expect(result.status).toBe("PASS");
		expect(result.totalSeconds).toBeGreaterThan(result.limitSeconds);
		expect(result.compileExcludedSeconds).toBeGreaterThan(result.limitSeconds);
	},
);
it("parses split token events conservatively and excludes their union", () => {
	const observed: string[] = [];
	const parser = new GateEventParser("owned", value => observed.push(value));
	parser.push('OMP_GATE_EVENT foreign {"id":"a","kind":"compile"}\n');
	parser.push('OMP_GATE_EVENT owned {"id":"a","kind":"com');
	parser.push('pile"}\nOMP_GATE_EVENT owned {"id":"b","kind":"compile"}\n');
	parser.push('OMP_GATE_EVENT owned {"id":"c","kind":"charged"}\n');
	parser.push('OMP_GATE_EVENT owned {"id":"c","kind":"idle"}\n');
	parser.push('OMP_GATE_EVENT owned {"id":"a","kind":"idle"}\nOMP_GATE_EVENT owned {"id":"b","kind":"idle"}\n');
	parser.push("OMP_GATE_EVENT owned not-json\n");
	expect(observed).toEqual(["compile", "compile", "charged", "compile", "compile", "charged"]);
});
it("observes real child compiler events while preserving captured streams", async () => {
	const result = await runGate(
		"fastcheck",
		async gate => {
			const captured = await gate.capture(command({ ms: 900, events: true, output: "stdout preserved\n" }));
			expect(captured.stdout).toContain("stdout preserved");
			expect(captured.stderr).toContain("stderr preserved");
			expect(captured.stderr).toContain("OMP_GATE_EVENT");
		},
		{ print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(result.compileExcludedSeconds).toBeGreaterThan(0.8);
});
it("propagates nested gate aggregate events to the outer charged clock", async () => {
	const result = await runGate(
		"slowtest",
		async gate => {
			await gate.run(
				command({
					nested: true,
					ms: 900,
					runtime: pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href,
				}),
			);
		},
		{ print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(result.compileExcludedSeconds).toBeGreaterThan(0.8);
});
it("kills owned grandchildren on timeout without touching an unrelated process", async () => {
	const grandchildFile = path.join(directory, "grandchild.pid");
	const unrelated = Bun.spawn([process.execPath, stub, JSON.stringify({ ms: 30000 })], {
		stdout: "ignore",
		stderr: "ignore",
	});
	let pid: number | undefined;
	try {
		const result = await runGate(
			"fulltest",
			async gate => {
				await Promise.all([
					gate.run(command({ ms: 30000, grandchild: grandchildFile })),
					(async () => {
						await waitForFiles([grandchildFile], gate.signal);
						await gate.childGate(
							"fastcheck",
							async () => {
								await sleep(1000);
							},
							{ limitSeconds: 0.2, print: quiet },
						);
					})(),
				]);
			},
			{ print: quiet },
		);
		expect(result.status).toBe("TIMEOUT");
		pid = Number(await fs.readFile(grandchildFile, "utf8"));
		let alive = true;
		for (let attempt = 0; attempt < 20 && alive; attempt++) {
			try {
				process.kill(pid, 0);
				await sleep(20);
			} catch {
				alive = false;
			}
		}
		expect(alive).toBe(false);
		expect(unrelated.exitCode).toBeNull();
	} finally {
		unrelated.kill("SIGKILL");
		await unrelated.exited;
		if (pid) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* Already cleaned. */
			}
		}
	}
});
it("cleans descendants after their actual command leader already exited", async () => {
	for (const detachedGrandchild of [false, true]) {
		const grandchildFile = path.join(directory, `orphan-${detachedGrandchild}.pid`);
		const result = await runGate(
			"fulltest",
			async gate => {
				await gate.run(command({ ms: 0, grandchild: grandchildFile, detachedGrandchild }));
			},
			{ limitSeconds: 1.5, print: quiet },
		);
		expect(result.status).toBe("PASS");
		const pid = Number(await fs.readFile(grandchildFile, "utf8"));
		let alive = true;
		for (let attempt = 0; attempt < 20 && alive; attempt++) {
			try {
				process.kill(pid, 0);
				await sleep(20);
			} catch {
				alive = false;
			}
		}
		try {
			expect(alive).toBe(false);
		} finally {
			if (alive) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already cleaned. */
				}
			}
		}
	}
});
it("only allows explicit read-only discovery failures without hiding check failures", async () => {
	const result = await runGate(
		"slowtest",
		async gate => {
			const discovery = await gate.capture(command({ exit: 7 }, { allowFailure: true }));
			expect(discovery.exitCode).toBe(7);
			await gate.run(command({ exit: 13 }));
		},
		{ print: quiet },
	);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(13);
});
it("matches Go quoted flags without changing Windows paths or quoted arguments", () => {
	const cachePath = String.raw`C:\tool path\cache.exe`;
	expect(splitGoCommand(`-mod=readonly '-toolexec="${cachePath}" --cached'`)).toEqual([
		"-mod=readonly",
		`-toolexec="${cachePath}" --cached`,
	]);
	expect(splitGoCommand(`"${cachePath}" --cached`)).toEqual([cachePath, "--cached"]);
	expect(() => splitGoCommand('"unterminated')).toThrow("Unterminated");
});
it("exempts Go compiler/link tools but charges vet and preserves actual tool failures", async () => {
	const compiler = path.join(directory, process.platform === "win32" ? "compile.exe" : "compile");
	try {
		await fs.link(process.execPath, compiler);
	} catch {
		await fs.copyFile(process.execPath, compiler);
	}
	const vet = path.join(directory, process.platform === "win32" ? "vet.exe" : "vet");
	await fs.link(compiler, vet);
	const dispatcher = path.join(import.meta.dir, "test-gate-compiler.ts");
	const compile = await runGate(
		"fastcheck",
		async gate => {
			await gate.run({
				label: "stub Go compiler",
				argv: [process.execPath, dispatcher, "--go", compiler, stub, JSON.stringify({ ms: 900 })],
				env: { BUN_BE_BUN: "1" },
			});
		},
		{ print: quiet },
	);
	expect(compile.status).toBe("PASS");
	expect(compile.compileExcludedSeconds).toBeGreaterThan(0.8);
	const linker = path.join(directory, process.platform === "win32" ? "link.exe" : "link");
	await fs.link(compiler, linker);
	const linked = await runGate(
		"fastcheck",
		async gate => {
			await gate.run({
				label: "stub Go linker",
				argv: [process.execPath, dispatcher, "--go", linker, stub, JSON.stringify({ ms: 50 })],
				env: { BUN_BE_BUN: "1" },
			});
		},
		{ print: quiet },
	);
	expect(linked.status).toBe("PASS");
	expect(linked.compileExcludedSeconds).toBeGreaterThan(0.04);
	const checked = await runGate(
		"fastcheck",
		async gate => {
			await gate.run({
				label: "stub Go vet",
				argv: [process.execPath, dispatcher, "--go", vet, stub, JSON.stringify({ ms: 30000 })],
				env: { BUN_BE_BUN: "1" },
			});
		},
		{ limitSeconds: 0.8, print: quiet },
	);
	expect(checked.status).toBe("TIMEOUT");
	expect(checked.compileExcludedSeconds).toBe(0);
	const failed = await runGate(
		"fastcheck",
		async gate => {
			await gate.run({
				label: "stub failed Go compiler",
				argv: [process.execPath, dispatcher, "--go", compiler, stub, JSON.stringify({ exit: 29 })],
				env: { BUN_BE_BUN: "1" },
			});
		},
		{ print: quiet },
	);
	expect(failed.exitCode).toBe(29);
	const overlapped = await runGate(
		"fastcheck",
		async gate => {
			await gate.run(
				command({ capturedCompiler: true, mixedTool: vet, goTool: true, dispatcher }, { env: { BUN_BE_BUN: "1" } }),
			);
		},
		{ limitSeconds: 0.8, print: quiet },
	);
	expect(overlapped.status).toBe("TIMEOUT");
	expect(overlapped.compileExcludedSeconds).toBeLessThan(0.2);
});
it("observes compiler intervals even when a doctest harness captures stderr", async () => {
	const compilerOutput = path.join(directory, "captured-compiler-stderr");
	const result = await runGate(
		"fulltest",
		async gate => {
			await gate.run(
				command({
					capturedCompiler: true,
					compilerOutput,
					dispatcher: path.join(import.meta.dir, "test-gate-compiler.ts"),
				}),
			);
		},
		{ print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(result.compileExcludedSeconds).toBeGreaterThan(0.8);
	expect(await fs.readFile(compilerOutput, "utf8")).not.toContain("OMP_GATE_EVENT");
});
it("charges a doctest executable that overlaps another doctest compiler", async () => {
	const result = await runGate(
		"fulltest",
		async gate => {
			await gate.run(
				command({
					capturedCompiler: true,
					parallelDoctest: true,
					dispatcher: path.join(import.meta.dir, "test-gate-compiler.ts"),
				}),
			);
		},
		{ limitSeconds: 0.8, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
	expect(result.compileExcludedSeconds).toBeLessThan(0.2);
});
it("returns captured bytes without echoing them into the surrounding stream", async () => {
	const result = await runGate(
		"slowtest",
		async gate => {
			const captured = await gate.capture(
				command({
					nestedCapture: true,
					runtime: pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href,
				}),
			);
			expect(captured.stdout.startsWith("CAPTURE_RESULT")).toBe(true);
			expect(captured.stderr).toBe("");
			const nested: unknown = JSON.parse(captured.stdout.slice("CAPTURE_RESULT".length));
			expect(nested).toEqual({ exitCode: 0, stdout: "private fixture bytes\n", stderr: "stderr preserved\n" });
		},
		{ limitSeconds: 1.5, print: quiet },
	);
	expect(result.status).toBe("PASS");
});
for (const cancelCapture of [false, true]) {
	it(
		cancelCapture
			? "preserves streamed diagnostics once when capture is cancelled"
			: "streams capture before completion and returns every byte including decoder tails",
		async () => {
			const prefix = cancelCapture ? "stream-cancel" : "stream-complete";
			const ready = path.join(directory, `${prefix}.ready`);
			const release = path.join(directory, `${prefix}.release`);
			const cancelFile = path.join(directory, `${prefix}.cancel`);
			const child = Bun.spawn(
				[
					process.execPath,
					stub,
					JSON.stringify({
						nestedCapture: true,
						streamOutput: true,
						cancelCapture,
						cancelFile,
						barrierReady: ready,
						barrierRelease: release,
						runtime: pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href,
					}),
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			let stdout = "";
			let stderr = "";
			let exited = false;
			const visible = Promise.withResolvers<void>();
			const pump = async (stream: ReadableStream<Uint8Array>, output: "stdout" | "stderr") => {
				const decoder = new TextDecoder();
				for await (const bytes of stream) {
					const chunk = decoder.decode(bytes, { stream: true });
					if (output === "stdout") stdout += chunk;
					else stderr += chunk;
					if (stdout.includes("private fixture bytes\n") && stderr.includes("stderr preserved\n"))
						visible.resolve();
				}
				if (output === "stdout") stdout += decoder.decode();
				else stderr += decoder.decode();
			};
			const pumps = Promise.all([pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]);
			const exit = child.exited.then(code => {
				exited = true;
				return code;
			});
			try {
				await Promise.race([visible.promise, exit]);
				expect(exited).toBe(false);
				expect(stdout).toBe("private fixture bytes\n");
				expect(stderr).toBe("stderr preserved\n");
				expect(stdout).not.toContain("CAPTURE_RESULT");
				await fs.writeFile(cancelCapture ? cancelFile : release, "ready");
				const exitCode = await exit;
				await pumps;
				expect(exitCode).toBe(cancelCapture ? 130 : 0);
				const [captured, status] = stdout.split("CAPTURE_RESULT")[1]!.split("\nCAPTURE_STATUS");
				expect(stdout.split("CAPTURE_RESULT")[0]).toBe(`private fixture bytes\n${cancelCapture ? "" : "\uFFFD"}`);
				expect(stderr).toBe(`stderr preserved\n${cancelCapture ? "" : "\uFFFD"}`);
				expect(JSON.parse(captured!)).toEqual(
					cancelCapture
						? null
						: { exitCode: 0, stdout: "private fixture bytes\n\uFFFD", stderr: "stderr preserved\n\uFFFD" },
				);
				const record = JSON.parse(status!);
				expect(record.result.status).toBe(cancelCapture ? "INTERRUPTED" : "PASS");
				expect(record.result.exitCode).toBe(cancelCapture ? 130 : 0);
				if (cancelCapture)
					expect(record.captureError).toEqual({
						message: "fixture capture interrupted",
						exitCode: 130,
						status: "INTERRUPTED",
					});
			} finally {
				await Promise.all([fs.writeFile(release, "ready"), fs.writeFile(cancelFile, "ready")]);
				await Promise.all([exit, pumps]);
			}
		},
		15000,
	);
}
it("computes timestamped compiler union despite delayed out-of-order event delivery", async () => {
	let observed = 0;
	const result = await runGate(
		"fulltest",
		async gate => {
			const captured = await gate.capture(command({ delayedEvents: true }));
			const timing: unknown = JSON.parse(captured.stdout);
			if (!timing || typeof timing !== "object" || !("compileMs" in timing) || typeof timing.compileMs !== "number")
				throw new Error("Stub did not report its observed compiler interval");
			observed = timing.compileMs / 1000;
		},
		{ limitSeconds: 1.5, print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(result.compileExcludedSeconds).toBeCloseTo(observed, 2);
	expect(result.budgetedSeconds).toBeGreaterThan(0.09);
});
it("does not exempt clippy-driver lint overlapping a real compiler interval", async () => {
	const clippy = path.join(directory, process.platform === "win32" ? "clippy-driver.exe" : "clippy-driver");
	try {
		await fs.link(process.execPath, clippy);
	} catch {
		await fs.copyFile(process.execPath, clippy);
	}
	const result = await runGate(
		"fastcheck",
		async gate => {
			await gate.run(
				command(
					{
						capturedCompiler: true,
						mixedTool: clippy,
						dispatcher: path.join(import.meta.dir, "test-gate-compiler.ts"),
					},
					{ env: { BUN_BE_BUN: "1" } },
				),
			);
		},
		{ limitSeconds: 0.8, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
	expect(result.compileExcludedSeconds).toBeLessThan(0.2);
});
it("reconciles delayed compiler-start timestamps before enforcing the remaining budget", async () => {
	const result = await runGate(
		"fulltest",
		async gate => {
			await gate.run(command({ delayedBoundary: "start" }));
		},
		{ limitSeconds: 1.5, print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(result.compileExcludedSeconds).toBeGreaterThan(1.2);
	expect(result.budgetedSeconds).toBeLessThan(result.limitSeconds);
});
it("immediately enforces already-charged time when a delayed compiler-end timestamp arrives", async () => {
	const result = await runGate(
		"fulltest",
		async gate => {
			await gate.run(command({ delayedBoundary: "end" }));
		},
		{ limitSeconds: 0.5, print: quiet },
	);
	expect(result.status).toBe("TIMEOUT");
	expect(result.compileExcludedSeconds).toBeLessThan(0.2);
	expect(result.totalSeconds).toBeLessThan(1);
});
it("returns a bounded discovery timeout without cancelling the enclosing gate", async () => {
	const pidFile = path.join(directory, "bounded-probe.pid");
	let aborted = false;
	const result = await runGate(
		"slowtest",
		async gate => {
			const probe = await gate.capture(
				command(
					{ ms: 30000, pidFile },
					{
						allowFailure: true,
						wallTimeoutSeconds: 0.3,
						onAbort: async () => {
							aborted = true;
						},
					},
				),
			);
			expect(probe.exitCode).toBe(124);
			expect(gate.signal.aborted).toBe(false);
			await gate.run(command({ exit: 0 }));
		},
		{ limitSeconds: 1.5, print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(aborted).toBe(true);
	const pid = Number(await fs.readFile(pidFile, "utf8"));
	expect(() => process.kill(pid, 0)).toThrow();
});
it("rejects independent wall guards on required checks and compiler stages", async () => {
	for (const options of [
		{ wallTimeoutSeconds: 0.1 },
		{ wallTimeoutSeconds: 0.1, allowFailure: true, kind: "compile" as const },
		{ wallTimeoutSeconds: Number.NaN, allowFailure: true },
	]) {
		const result = await runGate(
			"fastcheck",
			async gate => {
				await gate.run(command({ ms: 30000 }, options));
			},
			{ limitSeconds: 0.8, print: quiet },
		);
		expect(result.status).toBe("FAIL");
		expect(result.exitCode).toBe(1);
	}
});
it("awaits tree cleanup despite a failing cancellation hook and reports cleanup diagnostics", async () => {
	const controller = new AbortController();
	const output: string[] = [];
	const pidFile = path.join(directory, "failed-cleanup-hook.pid");
	const abortWhenReady = (async () => {
		while (!controller.signal.aborted) {
			try {
				if (Number(await fs.readFile(pidFile, "utf8")) > 0) {
					controller.abort();
					break;
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await Bun.sleep(5);
		}
	})();
	try {
		const result = await runGate(
			"slowtest",
			async gate => {
				await gate.run(
					command(
						{ ms: 30000, pidFile },
						{
							onAbort: async () => {
								throw new Error("fixture cleanup hook failed");
							},
						},
					),
				);
			},
			{ signal: controller.signal, limitSeconds: 1.5, print: line => output.push(line) },
		);
		expect(result.status).toBe("INTERRUPTED");
		expect(result.exitCode).toBe(130);
		expect(output.some(line => line.includes("CLEANUP_FAIL") && line.includes("fixture cleanup hook failed"))).toBe(
			true,
		);
		const pid = Number(await fs.readFile(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		controller.abort();
		await abortWhenReady;
	}
});
it("summarizes an expired gate without waiting forever for untracked blocked work", async () => {
	const lines: string[] = [];
	const result = await runGate(
		"fastcheck",
		async () => {
			await new Promise<void>(() => {});
		},
		{ limitSeconds: 0.05, print: line => lines.push(line) },
	);
	expect(result.status).toBe("TIMEOUT");
	expect(result.exitCode).toBe(124);
	expect(lines.at(-1)).toContain("TIMEOUT total=");
});
