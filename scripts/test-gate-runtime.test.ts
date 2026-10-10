import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { GateCommand, GateLevel, GateRun } from "./test-gate-runtime";
import { GateEventParser, GATE_LIMIT_SECONDS, runGate, withRustCompilerEvents } from "./test-gate-runtime";
import { splitGoCommand } from "./test-gate-go";

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
const {gateClockNanoseconds} = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-clock.ts")).href)});
const plan = JSON.parse(process.argv[2]);
if (plan.pidFile) await fs.writeFile(plan.pidFile, String(process.pid));
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
  const {runGate} = await import(plan.runtime);
  let captured;
  const result = await runGate("fulltest", async gate => {
    captured = await gate.capture({label:"capture fixture",argv:[process.execPath,import.meta.path,JSON.stringify({output:"private fixture bytes\\n"})]});
  }, {print:()=>{}});
  process.stdout.write("CAPTURE_RESULT" + JSON.stringify(captured));
  process.exit(result.exitCode);
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
const phaseStart=gateClockNanoseconds();
if (plan.events) process.stderr.write("OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + " " + JSON.stringify({id:"compiler",kind:"compile",at:phaseStart.toString(),clock:process.env.OMP_GATE_CLOCK_TOKEN}) + "\\n");
const waiting = Promise.withResolvers();
setTimeout(waiting.resolve, plan.ms ?? 0);
await waiting.promise;
const phaseEnd=gateClockNanoseconds();
if (plan.events) process.stderr.write("OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + " " + JSON.stringify({id:"compiler",kind:"idle",at:phaseEnd.toString(),clock:process.env.OMP_GATE_CLOCK_TOKEN}) + "\\n");
if (plan.phaseTiming) process.stdout.write(JSON.stringify({start:phaseStart.toString(),end:phaseEnd.toString()}));
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
	const before = process.listenerCount("SIGINT");
	const output: string[] = [];
	const result = await runGate(
		"fastcheck",
		async gate => {
			process.emit("SIGINT");
			await gate.run(command({ ms: 30000 }));
		},
		{ print: line => output.push(line), limitSeconds: 0.8 },
	);
	expect(result.status).toBe("INTERRUPTED");
	expect(output.at(-1)).toContain("INTERRUPTED");
	expect(process.listenerCount("SIGINT")).toBe(before);
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
it("rejects invalid budgets and reserves with a complete final summary", async () => {
	for (const options of [{ limitSeconds: 0 }, { limitSeconds: Number.NaN }, { cleanupReserveMs: Number.NaN }]) {
		const output: string[] = [];
		const result = await runGate("fastcheck", async () => {}, { ...options, print: line => output.push(line) });
		expect(result.status).toBe("FAIL");
		expect(output.at(-1)).toMatch(/FAIL total=\d+\.\ds compile_excluded=0\.0s budgeted=\d+\.\ds limit=60\.0s exit=1/);
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
			const nested: unknown = JSON.parse(captured.stdout.slice("CAPTURE_RESULT".length));
			expect(nested).toEqual({ exitCode: 0, stdout: "private fixture bytes\n", stderr: "stderr preserved\n" });
		},
		{ limitSeconds: 1.5, print: quiet },
	);
	expect(result.status).toBe("PASS");
});
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
