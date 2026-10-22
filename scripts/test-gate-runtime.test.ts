import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { GateCommand, GateLevel, GateRun } from "./test-gate-runtime";
import { GateCommandError } from "./test-gate-failure-events";
import {
	GateEventParser,
	GATE_LIMIT_SECONDS,
	runBazelTask,
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
  const {runGate} = await import(plan.runtime);
  // Fixture readiness must precede loading failure-events and its clock dependency.
  const {GateCommandError} = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-failure-events.ts")).href)});
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
  const handshake = plan.rustCargoHandshake;
  if (handshake && !plan.prepareRustCargo) {
    // Forward this consumer's real relay identity, never the outer test's token.
    await fs.writeFile(handshake.request + ".tmp", JSON.stringify({
      OMP_GATE_EVENT_TOKEN:process.env.OMP_GATE_EVENT_TOKEN,
      OMP_GATE_EVENT_FILE:process.env.OMP_GATE_EVENT_FILE,
      OMP_GATE_CLOCK_TOKEN:process.env.OMP_GATE_CLOCK_TOKEN,
    }));
    await fs.rename(handshake.request + ".tmp", handshake.request);
    // Poll real cross-process file readiness; fake timers cannot advance the worker.
    for (;;) {
      try { await fs.access(handshake.released); break; } catch (error) { if(error.code !== "ENOENT") throw error; }
      await Bun.sleep(5);
    }
  } else {
    // Load at this isolated module boundary; consumer stubs must not import the runtime.
    const {withRustCompilerEvents} = await import(plan.runtime);
    let cargoEnv = {...process.env};
    if (plan.prepareRustCargo) {
      await withRustCompilerEvents({
        ...cargoEnv,
        OMP_GATE_EVENT_TOKEN:"rust-cargo-preparation",
        OMP_GATE_CLOCK_TOKEN:"rust-cargo-preparation",
        OMP_GATE_EVENT_FILE:handshake.events,
      }, async () => 0);
      await fs.writeFile(handshake.ready, "prepared");
      // The consumer is an independent process, so readiness uses its real file handshake.
      for (;;) {
        try { await fs.access(handshake.stop); process.exit(0); } catch (error) { if(error.code !== "ENOENT") throw error; }
        try {
          cargoEnv = {...cargoEnv, ...JSON.parse(await fs.readFile(handshake.request, "utf8"))};
          break;
        } catch (error) { if(error.code !== "ENOENT") throw error; }
        await Bun.sleep(5);
      }
    }
    try {
      const exitCode = await withRustCompilerEvents(cargoEnv, async env => {
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
    // withRustCompilerEvents has run its real finally before compilation can start.
    if (plan.prepareRustCargo) await fs.writeFile(handshake.released, "released");
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
  // Load this module only after the fixture's process-readiness/clock handshake.
  const {GateCommandError,reportGateFailure} = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-failure-events.ts")).href)});
  reportGateFailure(new GateCommandError("fixture nested check failed",plan.reportFailure));
}
if (plan.nestedFailure) {
  // Exercise a real nested entrypoint's explicit propagation across module/process boundaries.
  const {runGate} = await import(plan.runtime);
  // Fixture readiness must precede loading failure-events and its clock dependency.
  const {GateCommandError} = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-failure-events.ts")).href)});
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

it("settles an unbounded standalone lifecycle with finalizers under strict process ownership", async () => {
	const source = `
import {runBazelTask} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href)};
let finalized = false;
const result = await runBazelTask(async gate => {
  gate.onFinalize(async exitCode => { finalized = exitCode === 0; });
  await gate.run({label:"standalone fixture",argv:[process.execPath,"-e","void 0;"]});
}, {exitOnFailure:true,print:()=>{}});
process.stdout.write(JSON.stringify({level:result.level,status:result.status,unbounded:result.limitSeconds === Infinity,finalized}));
`;
	const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(stdout)).toEqual({ level: "bazel", status: "PASS", unbounded: true, finalized: true });
});

it("preserves standalone first failure and finishes owned process cleanup before finalization", async () => {
	const pidFile = path.join(directory, "standalone-failure.pid");
	let finalizedExitCode: number | undefined;
	let cleanedAtFinalization = false;
	const result = await runBazelTask(
		async gate => {
			gate.onFinalize(async exitCode => {
				finalizedExitCode = exitCode;
				const pid = Number(await fs.readFile(pidFile, "utf8"));
				try {
					process.kill(pid, 0);
				} catch {
					cleanedAtFinalization = true;
				}
			});
			await Promise.all([
				gate.run(command({ ms: 30000, pidFile })),
				gate.charged(async () => {
					await waitForFiles([pidFile], gate.signal);
					throw gate.fail(new GateCommandError("standalone first failure", 23));
				}),
			]);
		},
		{ print: quiet },
	);
	expect(result.level).toBe("bazel");
	expect(result.limitSeconds).toBe(Infinity);
	expect(result.status).toBe("FAIL");
	expect(result.exitCode).toBe(23);
	expect(finalizedExitCode).toBe(23);
	expect(cleanedAtFinalization).toBe(true);
});

it("keeps a finite child tier deadline within an unbounded standalone lifecycle", async () => {
	const result = await runBazelTask(
		async gate => {
			// The real lifecycle clock must expire while work waits for its cancellation signal.
			await gate.childGate(
				"fulltest",
				async child =>
					new Promise<void>(resolve => {
						child.signal.addEventListener("abort", () => resolve(), { once: true });
					}),
				{
					limitSeconds: 0.3,
					cleanupReserveMs: 0,
					print: quiet,
				},
			);
		},
		{ print: quiet },
	);
	expect(result.level).toBe("bazel");
	expect(result.limitSeconds).toBe(Infinity);
	expect(result.status).toBe("TIMEOUT");
	expect(result.exitCode).toBe(124);
});

it.each(["fastcheck", "fulltest", "slowtest"] as const)(
	"does not allow %s to adopt the standalone unbounded limit",
	async level => {
		let started = false;
		const result = await runGate(
			level,
			async () => {
				started = true;
			},
			{ limitSeconds: Infinity, print: quiet },
		);
		expect(started).toBe(false);
		expect(result.level).toBe(level);
		expect(result.limitSeconds).toBe(GATE_LIMIT_SECONDS[level]);
		expect(result.status).toBe("FAIL");
		expect(result.exitCode).toBe(1);
	},
);

it.each(["libc.so.6", "libc.so"])("resolves %s for both the gate clock and native watchdog exit", async soname => {
	const source = `
import { mock } from "bun:test";
import * as ffi from "bun:ffi";
Object.defineProperty(process, "platform", { value: "linux" });
const names = [];
mock.module("bun:ffi", () => ({
  ...ffi,
  ptr: value => value,
  dlopen(name) {
    names.push(name);
    if (name !== ${JSON.stringify(soname)}) throw new Error("soname not installed");
    return { symbols: {
      clock_gettime(clock, sample) { sample[0] = 12n; sample[1] = 34n; return 0; },
      _exit(code) { process.stdout.write(JSON.stringify({ names, code })); process.exit(code); },
    }, close() {} };
  },
}));
// These imports must follow mock installation to exercise the isolated native-loading boundary.
const { gateClockNanoseconds } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-clock.ts")).href)});
process.stdout.write(gateClockNanoseconds().toString() + "\\n");
const { exitGateProcess } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-watchdog.ts")).href)});
exitGateProcess(23);
`;
	const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(23);
	const [clock, nativeExit] = stdout.split("\n");
	expect(clock).toBe("12000000034");
	expect(JSON.parse(nativeExit)).toEqual({
		names: soname === "libc.so.6" ? ["libc.so.6", "libc.so.6"] : ["libc.so.6", "libc.so", "libc.so.6", "libc.so"],
		code: 23,
	});
});

async function windowsLauncherFixture() {
	const root = await fs.mkdtemp(path.join(directory, "rust-launcher-"));
	const scripts = path.join(root, "scripts");
	await fs.mkdir(scripts);
	await fs.mkdir(path.join(root, "node_modules"));
	// Resolve workspace imports without sharing the fixture's writable .cache.
	await fs.symlink(
		path.resolve(import.meta.dir, "../node_modules/@oh-my-pi"),
		path.join(root, "node_modules", "@oh-my-pi"),
		"junction",
	);
	await fs.mkdir(path.join(root, "packages/utils/src"), { recursive: true });
	await fs.copyFile(
		path.resolve(import.meta.dir, "../packages/utils/src/subprocess.ts"),
		path.join(root, "packages/utils/src/subprocess.ts"),
	);
	for (const name of [
		"runtime.ts",
		"watchdog.ts",
		"events.ts",
		"failure-events.ts",
		"clock.ts",
		"libc.ts",
		"process.ts",
		"compiler.ts",
		"rustdoc.ts",
		"compiler-launcher.rs",
	])
		await fs.copyFile(path.join(import.meta.dir, `test-gate-${name}`), path.join(scripts, `test-gate-${name}`));
	const compiler = Bun.which(process.env.RUSTC || "rustc");
	if (!compiler) throw new Error("Rust launcher integration requires the installed rustc");
	const proxy = path.join(root, "compiler-proxy.exe");
	const source = path.join(root, "compiler-proxy.rs");
	await fs.writeFile(
		source,
		String.raw`
use std::{env, fs, path::Path, process::{self, Command}, thread, time::{Duration, Instant}};
use std::os::windows::fs::OpenOptionsExt;
fn wait(path: &Path) {
    let started = Instant::now();
    while !path.exists() {
        assert!(started.elapsed() < Duration::from_secs(25), "barrier timed out: {}", path.display());
        thread::sleep(Duration::from_millis(5));
    }
}
fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let root = env::var_os("LAUNCHER_FIXTURE_ROOT").unwrap();
    let root = Path::new(&root);
    if args.first().is_some_and(|arg| arg == "--consumer") {
        let id = args[1].to_str().unwrap();
        // Loader sharing varies; explicitly hold the real image without delete sharing.
        let _image = if env::var("LAUNCHER_FIXTURE_LOCK_IMAGE").unwrap_or_default() == "1" {
            Some(fs::OpenOptions::new().read(true).share_mode(1)
                .open(env::var_os("OMP_GATE_DOCTEST_RUNNER").unwrap()).unwrap())
        } else { None };
        fs::write(root.join(format!("ready-{id}")), b"running native consumer").unwrap();
        if id != "warm" { wait(&root.join("consumers-release")); }
        fs::write(root.join(format!("completed-{id}")), b"native consumer completed").unwrap();
        return;
    }
    let id = env::var("LAUNCHER_FIXTURE_ID").unwrap();
    let version = args.first().is_some_and(|arg| arg == "--version");
    if !version {
        fs::write(root.join(format!("compile-{id}")), b"real rustc invocation").unwrap();
        if id == "a" { wait(&root.join("compile-release")); }
    }
    let status = Command::new(env::var_os("LAUNCHER_FIXTURE_RUSTC").unwrap()).args(&args).status().unwrap();
    if version && id != "warm" {
        fs::write(root.join(format!("version-{id}")), b"compiler discovered").unwrap();
        wait(&root.join(format!("version-release-{id}")));
        fs::write(root.join(format!("version-done-{id}")), b"compiler discovery released").unwrap();
    }
    // The old publisher must attempt replacement while the first launcher is running.
    if !version && id == "b" { wait(&root.join("ready-a")); }
    process::exit(status.code().unwrap_or(1));
}
`,
	);
	const compiled = Bun.spawn([compiler, "--edition=2021", "-o", proxy, source], {
		env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [compiledExit, diagnostics] = await Promise.all([compiled.exited, new Response(compiled.stderr).text()]);
	if (compiledExit !== 0) throw new Error(`Cannot compile real launcher fixture: ${diagnostics}`);
	const harness = path.join(scripts, "launcher-harness.ts");
	await fs.writeFile(
		harness,
		`
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {runGate,withRustCompilerEvents} from "./test-gate-runtime";
import {GateCommandError} from "./test-gate-failure-events";
const result = await runGate("fulltest", async gate => {
  await gate.charged(() => withRustCompilerEvents({...process.env}, async env => {
    const child = Bun.spawn([env.OMP_GATE_DOCTEST_RUNNER, process.env.RUSTC, "--consumer", process.env.LAUNCHER_FIXTURE_ID], {env,stdout:"inherit",stderr:"inherit"});
    const code = await child.exited;
    if (code) throw new GateCommandError("native launcher consumer failed",code);
  }));
}, {print:()=>{}});
await fs.writeFile(path.join(process.env.LAUNCHER_FIXTURE_ROOT,"result-"+process.env.LAUNCHER_FIXTURE_ID),JSON.stringify(result));
process.exit(result.exitCode);
`,
	);
	const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
	const start = (id: string, lockImage = false) => {
		const child = Bun.spawn([process.execPath, harness], {
			env: {
				...process.env,
				OMP_GATE_EVENT_TOKEN: "isolated-rust-launchers",
				OMP_GATE_EVENT_FILE: "",
				RUSTC: proxy,
				LAUNCHER_FIXTURE_RUSTC: compiler,
				LAUNCHER_FIXTURE_ROOT: root,
				LAUNCHER_FIXTURE_ID: id,
				LAUNCHER_FIXTURE_LOCK_IMAGE: lockImage ? "1" : "",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.push(child);
		const output = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return {
			child,
			output,
			async ready(filename: string) {
				const controller = new AbortController();
				try {
					await Promise.race([
						// Real child-process barriers cannot be advanced by fake timers.
						waitForFiles(
							[path.join(root, filename)],
							AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
						),
						output.then(([code, stdout, stderr]) => {
							throw new Error(`Launcher gate exited before ${filename}: ${code}\n${stdout}\n${stderr}`);
						}),
					]);
				} finally {
					controller.abort(new Error("Launcher barrier settled"));
				}
			},
		};
	};
	return {
		root,
		start,
		cache: path.join(root, "node_modules/.cache/omp-gate-wrappers", `${process.platform}-${process.arch}`),
		launcherSource: path.join(scripts, "test-gate-compiler-launcher.rs"),
		async close() {
			await Promise.all(
				["consumers-release", "compile-release", "version-release-a", "version-release-b"].map(name =>
					fs.writeFile(path.join(root, name), "released"),
				),
			);
			await Promise.all(children.map(child => child.exited));
		},
	};
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

it("isolates overlapping public GateRun consumers when one task is cancelled", async () => {
	const cancelledReady = path.join(directory, "isolated-cancelled.ready");
	const survivorReady = path.join(directory, "isolated-survivor.ready");
	const release = path.join(directory, "isolated-survivor.release");
	const controller = new AbortController();
	const cancelled = runGate(
		"fulltest",
		async gate => {
			await gate.run(command({ barrierReady: cancelledReady, barrierRelease: release, ms: 30000 }));
		},
		{ signal: controller.signal, print: quiet },
	);
	const survivor = runGate(
		"fulltest",
		async gate => {
			const captured = await gate.capture(
				command({ barrierReady: survivorReady, barrierRelease: release, output: "survivor bytes" }),
			);
			expect(captured.stdout).toBe("survivor bytes");
			expect(gate.signal.aborted).toBe(false);
		},
		{ print: quiet },
	);
	try {
		await waitForFiles([cancelledReady, survivorReady], AbortSignal.timeout(30_000));
		const cancelledPid = Number(await fs.readFile(cancelledReady, "utf8"));
		const survivorPid = Number(await fs.readFile(survivorReady, "utf8"));
		controller.abort();
		expect((await cancelled).status).toBe("INTERRUPTED");
		expect(() => process.kill(cancelledPid, 0)).toThrow();
		expect(() => process.kill(survivorPid, 0)).not.toThrow();
		await fs.writeFile(release, "released");
		expect((await survivor).status).toBe("PASS");
	} finally {
		controller.abort();
		await fs.writeFile(release, "released");
		await Promise.all([cancelled, survivor]);
	}
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

it.each(["root", "nested", "event"] as const)(
	"normalizes zero-code failure at the %s runtime boundary without starting siblings",
	async boundary => {
		const runtime = pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href;
		const failures = pathToFileURL(path.join(import.meta.dir, "test-gate-failure-events.ts")).href;
		const script = `
import {runGate} from ${JSON.stringify(runtime)};
import {GateCommandError} from ${JSON.stringify(failures)};
let siblingStarted = false;
const result = await runGate("slowtest", async gate => {
  const boundary = ${JSON.stringify(boundary)};
  if (boundary === "root") gate.fail(new GateCommandError("zero-code root failure",0));
  else if (boundary === "nested") {
    await gate.childGate("fastcheck",async nested => {
      nested.fail(new GateCommandError("zero-code nested failure",0));
    },{print:()=>{}});
  } else {
    await gate.capture({
      label:"zero-code authenticated event fixture",
      eventToken:"owned-zero",
      argv:[process.execPath,"-e",'process.stderr.write(\\'OMP_GATE_EVENT owned-zero {"id":"fixture","kind":"failure","exitCode":0,"status":"FAIL","message":"zero-code public event"}\\\\n\\');'],
    });
  }
  await gate.childGate("fastcheck",async () => { siblingStarted = true; },{print:()=>{}});
},{print:()=>{}});
process.stdout.write(JSON.stringify({result,siblingStarted}));
process.exit(result.exitCode);`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OMP_GATE_EVENT_TOKEN: "", OMP_GATE_EVENT_FILE: "", OMP_GATE_CLOCK_TOKEN: "" },
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		const guard = Promise.withResolvers<never>();
		// Real subprocess deadlock protection cannot use this process's fake timers.
		const timer = setTimeout(() => guard.reject(new Error("zero-code fixture did not exit")), 3500);
		try {
			const code = await Promise.race([child.exited, guard.promise]);
			expect(code).toBe(1);
			const output = JSON.parse(await stdout);
			expect(output.result.status).toBe("FAIL");
			expect(output.result.exitCode).toBe(1);
			expect(output.siblingStarted).toBe(false);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
			await Promise.all([stdout, stderr]);
		}
	},
);

it("rejects malformed and foreign failure events while keeping the authenticated failure intact", () => {
	const failures: GateCommandError[] = [];
	const parser = new GateEventParser("owned", quiet, undefined, failure => failures.push(failure));
	parser.push(
		'OMP_GATE_EVENT foreign {"id":"a","kind":"failure","exitCode":37,"status":"FAIL","message":"foreign"}\n',
	);
	parser.push('OMP_GATE_EVENT owned {"id":"a","kind":"failure","exitCode":"0","status":"FAIL","message":"invalid"}\n');
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
		expect(output.at(-1)).toMatch(
			new RegExp(
				`FAIL total=\\d+\\.\\ds compile_excluded=0\\.0s budgeted=\\d+\\.\\ds limit=${GATE_LIMIT_SECONDS.fastcheck}\\.0s exit=1`,
			),
		);
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
it.skipIf(process.platform !== "win32").each(["cold", "invalid-signature"])(
	"serializes real Windows launcher publication across independent gates with %s cache",
	async state => {
		const fixture = await windowsLauncherFixture();
		try {
			if (state === "invalid-signature") {
				const [code, stdout, stderr] = await fixture.start("warm").output;
				expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
				await fs.writeFile(path.join(fixture.cache, "launcher.sha256"), "invalid-signature");
			}
			const a = fixture.start("a");
			const b = fixture.start("b");
			await Promise.all([a.ready("version-a"), b.ready("version-b")]);
			await fs.writeFile(path.join(fixture.root, "version-release-a"), "released");
			await a.ready("compile-a");
			await fs.writeFile(path.join(fixture.root, "version-release-b"), "released");
			await b.ready("version-done-b");
			await fs.writeFile(path.join(fixture.root, "compile-release"), "released");
			await a.ready("ready-a");
			const runningImage = await fs.stat(path.join(fixture.cache, "test-gate-launcher.exe"));
			await b.ready("ready-b");
			const sharedImage = await fs.stat(path.join(fixture.cache, "test-gate-launcher.exe"));
			expect(sharedImage.ino).toBe(runningImage.ino);
			expect(sharedImage.mtimeMs).toBe(runningImage.mtimeMs);
			await expect(fs.access(path.join(fixture.root, "compile-b"))).rejects.toMatchObject({ code: "ENOENT" });
			for (const name of ["rustc", "rustdoc", "doctest-compile", "doctest-run"])
				expect((await fs.stat(path.join(fixture.cache, `test-gate-${name}.exe`))).ino).toBe(sharedImage.ino);
			expect(await fs.readFile(path.join(fixture.cache, "launcher.sha256"), "utf8")).toMatch(/^[a-f0-9]{64}$/);
			await fs.writeFile(path.join(fixture.root, "consumers-release"), "released");
			for (const process of [a, b]) {
				const [code, stdout, stderr] = await process.output;
				expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
			}
			for (const id of ["a", "b"]) {
				expect(await fs.readFile(path.join(fixture.root, `completed-${id}`), "utf8")).toBe(
					"native consumer completed",
				);
				expect(JSON.parse(await fs.readFile(path.join(fixture.root, `result-${id}`), "utf8"))).toMatchObject({
					status: "PASS",
					exitCode: 0,
				});
			}
		} finally {
			await fixture.close();
		}
	},
	60_000,
);
it.skipIf(process.platform !== "win32")(
	"fails real Windows launcher compilation errors and releases the publication lease for retry",
	async () => {
		const fixture = await windowsLauncherFixture();
		try {
			const source = await fs.readFile(fixture.launcherSource);
			await fs.writeFile(fixture.launcherSource, "fn main() { this is not valid Rust; }");
			const [code, , stderr] = await fixture.start("warm").output;
			expect(code).not.toBe(0);
			expect(stderr).toContain("error:");
			expect(JSON.parse(await fs.readFile(path.join(fixture.root, "result-warm"), "utf8"))).toMatchObject({
				status: "FAIL",
			});
			await expect(fs.access(path.join(fixture.cache, "launcher.sha256"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.access(path.join(fixture.cache, "test-gate-launcher.exe"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			await fs.writeFile(fixture.launcherSource, source);
			const [retryCode, stdout, retryStderr] = await fixture.start("warm").output;
			expect({ code: retryCode, stdout, stderr: retryStderr }).toMatchObject({ code: 0 });
			expect(await fs.readFile(path.join(fixture.root, "completed-warm"), "utf8")).toBe("native consumer completed");
		} finally {
			await fixture.close();
		}
	},
	60_000,
);
it.skipIf(process.platform !== "win32")(
	"preserves a real in-use Windows launcher replacement failure without clearing the cached executable",
	async () => {
		const fixture = await windowsLauncherFixture();
		try {
			expect((await fixture.start("warm").output)[0]).toBe(0);
			const a = fixture.start("a", true);
			await a.ready("version-a");
			await fs.writeFile(path.join(fixture.root, "version-release-a"), "released");
			await a.ready("ready-a");
			const image = path.join(fixture.cache, "test-gate-launcher.exe");
			const runningLauncher = path.join(fixture.cache, "test-gate-doctest-run.exe");
			const runningImage = await fs.stat(runningLauncher);
			const stamp = path.join(fixture.cache, "launcher.sha256");
			await fs.writeFile(stamp, "invalid-signature");
			expect((await fixture.start("warm").output)[0]).not.toBe(0);
			expect(JSON.parse(await fs.readFile(path.join(fixture.root, "result-warm"), "utf8"))).toMatchObject({
				status: "FAIL",
			});
			// Windows may replace the canonical image before rejecting the running
			// entry-point hardlink. Only the consumer's mapped entry must survive.
			expect((await fs.stat(runningLauncher)).ino).toBe(runningImage.ino);
			expect((await fs.stat(image)).size).toBeGreaterThan(0);
			expect(await fs.readFile(stamp, "utf8")).toBe("invalid-signature");
			await fs.writeFile(path.join(fixture.root, "consumers-release"), "released");
			expect((await a.output)[0]).toBe(0);
			expect(await fs.readFile(path.join(fixture.root, "completed-a"), "utf8")).toBe("native consumer completed");
			expect((await fixture.start("warm").output)[0]).toBe(0);
			expect(await fs.readFile(stamp, "utf8")).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			await fixture.close();
		}
	},
	60_000,
);
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
		const root = await fs.mkdtemp(path.join(directory, `cargo-release-${rustCargo}-`));
		const rustCargoHandshake = {
			ready: path.join(root, "ready"),
			request: path.join(root, "request.json"),
			released: path.join(root, "released"),
			stop: path.join(root, "stop"),
			events: path.join(root, "preparation.jsonl"),
		};
		const runtime = pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href;
		const prepared = Bun.spawn(
			[...command({ rustCargo, runtime, rustCargoHandshake, prepareRustCargo: true }).argv],
			{
				env: {
					...process.env,
					OMP_GATE_EVENT_TOKEN: "",
					OMP_GATE_EVENT_FILE: "",
					OMP_GATE_CLOCK_TOKEN: "",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const output = Promise.all([
			prepared.exited,
			new Response(prepared.stdout).text(),
			new Response(prepared.stderr).text(),
		]);
		const controller = new AbortController();
		try {
			// Preparation remains inside fulltest's real wall clock, outside only
			// this injected accounting budget. The consumer handshake stays charged.
			await Promise.race([
				waitForFiles([rustCargoHandshake.ready], controller.signal),
				output.then(([code, stdout, stderr]) => {
					throw new Error(`Cargo preparation exited before readiness: ${code}\n${stdout}\n${stderr}`);
				}),
			]);
			const result = await runGate(
				"fastcheck",
				async gate => {
					await gate.run(
						command({
							rustCargo,
							rustCargoHandshake,
							afterRustCompile: 3_000,
							dispatcher: path.join(import.meta.dir, "test-gate-compiler.ts"),
						}),
					);
				},
				{ limitSeconds: 2, print: quiet },
			);
			expect(result.status).toBe("PASS");
			expect(result.totalSeconds).toBeGreaterThan(result.limitSeconds);
			expect(result.compileExcludedSeconds).toBeGreaterThan(result.limitSeconds);
		} finally {
			controller.abort(new Error("Cargo fixture settled"));
			await fs.writeFile(rustCargoHandshake.stop, "released");
			const [code, stdout, stderr] = await output;
			if (code !== 0) throw new Error(`Prepared Cargo callback failed: ${code}\n${stdout}\n${stderr}`);
		}
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
it.skipIf(process.platform !== "win32").each(["running", "initializing", "replied"])(
	"stops an owned Windows Job on IPC disconnect while its parent stays alive (%s)",
	async phase => {
		const prefix = path.join(directory, `windows-ipc-disconnect-${phase}`);
		const unrelatedPrefix = `${prefix}-unrelated`;
		const harness = `${prefix}.ts`;
		await fs.writeFile(
			harness,
			`
import * as fs from "node:fs/promises";
import { spyOn } from "bun:test";
import { runGate } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href)};
const [role, prefix] = process.argv.slice(2);
const phase = ${JSON.stringify(phase)};
// Cross-process file barriers observe real execution; a fake test clock cannot
// advance the independently spawned command or the native Job's termination.
const wait = async file => { while (!(await Bun.file(file).exists())) await Bun.sleep(5); };
if (role === "worker") {
  await fs.writeFile(prefix + ".worker", String(process.pid));
  await wait(prefix + ".worker-release");
  process.exit(0);
}
if (role === "command") {
  Bun.spawn([process.execPath, import.meta.path, "worker", prefix], {stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  await wait(prefix + ".worker");
  await fs.writeFile(prefix + ".command", String(process.pid));
  if (phase !== "replied") await wait(prefix + ".command-release");
  process.exit(0);
}
const spawn = Bun.spawn.bind(Bun);
let supervisor;
const spawned = Promise.withResolvers();
const observedSpawn = spyOn(Bun, "spawn").mockImplementation((argv, options) => {
  let child;
  child = spawn(argv, options?.env?.OMP_GATE_SUPERVISED_COMMAND ? {
    ...options,
    ipc(message) {
      options.ipc(message);
      if (phase === "replied" && typeof message?.exitCode === "number") child.disconnect();
    },
  } : options);
  if (options?.env?.OMP_GATE_SUPERVISED_COMMAND) {
    supervisor = child;
    // Disconnect before runGate has published its ownership promise.
    if (phase === "initializing") child.disconnect();
    spawned.resolve();
  }
  return child;
});
try {
  const running = runGate("fulltest", gate => gate.run({
    label:"disconnect command", argv:[process.execPath, import.meta.path, "command", prefix],
  }), {limitSeconds:30, print:()=>{}});
  if (phase === "initializing") {
    await spawned.promise;
  } else {
    await wait(prefix + ".command");
    if (phase === "running") supervisor.disconnect();
  }
  await fs.writeFile(prefix + ".disconnected", String(process.pid));
  const result = await running;
  await fs.writeFile(prefix + ".result", JSON.stringify(result));
  // Keep both this parent and its Job handle owner alive until assertions finish.
  await wait(prefix + ".parent-release");
} finally {
  observedSpawn.mockRestore();
}
`,
		);
		const unrelated = Bun.spawn([process.execPath, harness, "worker", unrelatedPrefix], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const parent = Bun.spawn([process.execPath, harness, "parent", prefix], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = Promise.all([new Response(parent.stdout).text(), new Response(parent.stderr).text()]);
		try {
			await waitForFiles([`${prefix}.disconnected`, `${unrelatedPrefix}.worker`], AbortSignal.timeout(5000));
			expect(parent.exitCode).toBeNull();
			expect(Number(await fs.readFile(`${prefix}.disconnected`, "utf8"))).toBe(parent.pid);
			// This bound is deliberately far below the 30-second gate budget.
			// Await completion, not a guessed sleep before checking for survivors.
			await waitForFiles([`${prefix}.result`], AbortSignal.timeout(5000));
			const result = JSON.parse(await fs.readFile(`${prefix}.result`, "utf8"));
			expect(result.status).toBe(phase === "replied" ? "PASS" : "FAIL");
			if (phase === "replied") expect(result.exitCode).toBe(0);
			else expect(result.exitCode).not.toBe(0);
			expect(parent.exitCode).toBeNull();
			for (const role of phase === "initializing" ? [] : ["command", "worker"]) {
				const pid = Number(await fs.readFile(`${prefix}.${role}`, "utf8"));
				expect(() => process.kill(pid, 0)).toThrow();
			}
			if (phase === "initializing") expect(await Bun.file(`${prefix}.command`).exists()).toBe(false);
			expect(unrelated.exitCode).toBeNull();
			expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
		} finally {
			await Promise.all(
				[
					`${prefix}.command-release`,
					`${prefix}.worker-release`,
					`${prefix}.parent-release`,
					`${unrelatedPrefix}.worker-release`,
				].map(file => fs.writeFile(file, "release")),
			);
			// Closing this real parent's handles is the fallback even on the
			// unfixed disconnect path; never kill a numeric descendant PID.
			if (parent.exitCode === null) parent.kill("SIGKILL");
			if (unrelated.exitCode === null) unrelated.kill("SIGKILL");
			await Promise.all([parent.exited, unrelated.exited, output]);
		}
	},
	20_000,
);
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
it("settles cross-stage cancellation bounded even when a spawn-churn stage resists the freeze sweep", async () => {
	const churn = path.join(directory, "churn-stage.ts");
	const churnLeaf = path.join(directory, "churn-leaf.ts");
	await fs.writeFile(
		churnLeaf,
		`
const leaf = Bun.spawn(["sleep", "2"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await leaf.exited;
`,
	);
	await fs.writeFile(
		churn,
		`
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
	const child = Bun.spawn([process.execPath, ${JSON.stringify(churnLeaf)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	await child.exited;
}
`,
	);
	const started = Date.now();
	const result = await runGate(
		"fulltest",
		async gate => {
			await Promise.all([
				gate.run({ label: "churn stage", argv: [process.execPath, churn] }),
				gate.run(command({ ms: 250, exit: 1 })),
			]);
		},
		{ print: quiet },
	);
	const elapsed = Date.now() - started;
	expect(result.status).toBe("FAIL");
	// The supervisor's exit wait is bounded by a group kill: a churn stage
	// cancelled mid-spawn must never wedge the gate past that bound.
	expect(elapsed).toBeLessThan(25_000);
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
describe("Go tool accounting", () => {
	let compiler: string;
	let linker: string;
	let vet: string;
	const dispatcher = path.join(import.meta.dir, "test-gate-compiler.ts");
	beforeAll(async () => {
		compiler = path.join(directory, process.platform === "win32" ? "compile.exe" : "compile");
		try {
			await fs.link(process.execPath, compiler);
		} catch {
			await fs.copyFile(process.execPath, compiler);
		}
		linker = path.join(directory, process.platform === "win32" ? "link.exe" : "link");
		vet = path.join(directory, process.platform === "win32" ? "vet.exe" : "vet");
		await fs.link(compiler, linker);
		await fs.link(compiler, vet);
	});
	// Each invariant owns a complete real gate lifecycle and the default five-second
	// test deadline; unrelated process startups must not share one cumulative timer.
	it("exempts Go compiler tools", async () => {
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
	});
	it("exempts Go linker tools", async () => {
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
	});
	it("charges Go vet tools", async () => {
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
	});
	it("preserves actual Go tool failures even when the caller ignores their exit", async () => {
		const failedCaller = path.join(directory, "go-tool-caller.ts");
		await fs.writeFile(
			failedCaller,
			`
const tool = Bun.spawn([process.execPath, ${JSON.stringify(dispatcher)}, "--go", ${JSON.stringify(compiler)}, ${JSON.stringify(stub)}, JSON.stringify({ exit: 29 })], { env: process.env, stdout: "inherit", stderr: "inherit" });
// Ignore the tool's exit so only its failure event can fail the outer gate.
await tool.exited;
`,
		);
		const failed = await runGate(
			"fastcheck",
			async gate => {
				await gate.run({
					label: "stub failed Go compiler",
					argv: [process.execPath, failedCaller],
					env: { BUN_BE_BUN: "1" },
				});
			},
			{ print: quiet },
		);
		expect(failed.exitCode).toBe(29);
	});
	it("charges Go vet execution overlapping a compiler", async () => {
		const overlapped = await runGate(
			"fastcheck",
			async gate => {
				await gate.run(
					command(
						{ capturedCompiler: true, mixedTool: vet, goTool: true, dispatcher },
						{ env: { BUN_BE_BUN: "1" } },
					),
				);
			},
			{ limitSeconds: 0.8, print: quiet },
		);
		expect(overlapped.status).toBe("TIMEOUT");
		expect(overlapped.compileExcludedSeconds).toBeLessThan(0.2);
	});
});
it("keeps build-script probe answers from failing the gate while preserving real rustc failures", async () => {
	const rustc = path.join(directory, process.platform === "win32" ? "rustc.exe" : "rustc");
	try {
		await fs.link(process.execPath, rustc);
	} catch {
		await fs.copyFile(process.execPath, rustc);
	}
	const caller = path.join(directory, "build-script-probe-caller.ts");
	await fs.writeFile(
		caller,
		`
const [crateName, shaped] = process.argv.slice(2);
const marker = ${JSON.stringify(directory)} + "/" + crateName;
const argv = [${JSON.stringify(path.join(import.meta.dir, "test-gate-compiler.ts"))}, ${JSON.stringify(rustc)}, ${JSON.stringify(stub)}, JSON.stringify({ exit: 23, cacheFile: marker + ".ran" }), "--crate-name", crateName, "--emit=llvm-ir"];
if (shaped === "cargo") argv.push("--error-format=json");
const probe = Bun.spawn([process.execPath, ...argv], { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
// Build scripts read the probe's answer and continue; its non-zero exit is expected.
await Bun.write(marker + ".exit", String(await probe.exited));
`,
	);
	// autocfg probes: `autocfg_<16-hex uuid>_<probe id>` with --emit=llvm-ir.
	const autocfg = await runGate(
		"fastcheck",
		async gate => {
			await gate.run({
				label: "stub autocfg probe",
				argv: [process.execPath, caller, "autocfg_0123456789abcdef_0"],
				env: { BUN_BE_BUN: "1" },
			});
		},
		{ print: quiet },
	);
	expect(autocfg.status).toBe("PASS");
	expect(await fs.readFile(path.join(directory, "autocfg_0123456789abcdef_0.ran"), "utf8")).toBe("warm\n");
	expect(await fs.readFile(path.join(directory, "autocfg_0123456789abcdef_0.exit"), "utf8")).toBe("23");
	// A cargo-shaped compilation unit failing still fails the gate early.
	const failed = await runGate(
		"fastcheck",
		async gate => {
			await gate.run({
				label: "stub failing rustc",
				argv: [process.execPath, caller, "probe_target_crate", "cargo"],
				env: { BUN_BE_BUN: "1" },
			});
		},
		{ print: quiet },
	);
	expect(failed.status).toBe("FAIL");
	expect(failed.exitCode).toBe(23);
	expect(await fs.readFile(path.join(directory, "probe_target_crate.ran"), "utf8")).toBe("warm\n");
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
	// This checks bytes across real nested processes, not their startup latency.
	// Use the normal tier budget, as other non-timing command regressions do.
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
		{ print: quiet },
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
			// Check cleanup as continued gate work, without timing an unrelated second process startup.
			await gate.charged(async () => {
				const pid = Number(await fs.readFile(pidFile, "utf8"));
				expect(() => process.kill(pid, 0)).toThrow();
			});
		},
		{ limitSeconds: 1.5, print: quiet },
	);
	expect(result.status).toBe("PASS");
	expect(aborted).toBe(true);
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

it.each(["fulltest", "slowtest"] satisfies GateLevel[])(
	"persists successful %s cleanup and supervisor terminal logs before immediate native exit",
	async level => {
		const configRoot = await fs.mkdtemp(path.join(directory, `native-success-${level}-`));
		const exitMarker = path.join(configRoot, "exit-hook");
		const runtime = pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href;
		const watchdog = pathToFileURL(path.join(import.meta.dir, "test-gate-watchdog.ts")).href;
		const logger = pathToFileURL(path.join(import.meta.dir, "../packages/utils/src/logger.ts")).href;
		const script = `import {writeFileSync,writeSync} from "node:fs";
import * as logger from ${JSON.stringify(logger)};
import {runGate} from ${JSON.stringify(runtime)};
import {exitGateProcess} from ${JSON.stringify(watchdog)};
logger.setTransports({file:${JSON.stringify(path.join(configRoot, "logs"))}});
process.on("exit", () => {
  writeFileSync(${JSON.stringify(exitMarker)}, "exit hook ran");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
const result = await runGate(${JSON.stringify(level)}, async gate => {
  gate.onFinalize(async () => {
    logger.info("Fixture cleanup completed", {event:"fixture_cleanup_settled",result:"completed"});
  });
  await gate.run({label:"short successful command",argv:[process.execPath,"-e","void 0;"]});
}, {limitSeconds:3,exitOnFailure:true,print:()=>{}});
writeSync(1, logger.getCurrentLogPath());
exitGateProcess(result.exitCode);`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5000,
			env: {
				...process.env,
				OMP_CONFIG_ROOT: configRoot,
				OMP_OFFLINE: "",
				OMP_LOG_LEVEL: "info",
				OMP_GATE_EVENT_TOKEN: "",
				OMP_GATE_EVENT_FILE: "",
				OMP_GATE_CLOCK_TOKEN: "",
			},
		});
		try {
			const [code, logPath, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(0);
			expect(stderr).toBe("");
			expect(await Bun.file(exitMarker).exists()).toBe(false);
			const text = await fs.readFile(logPath, "utf8");
			const records = text
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			const events = records.map(record => record.event);
			for (const event of [
				"gate_stage_started",
				"gate_stage_settled",
				"gate_cleanup_started",
				"gate_cleanup_settled",
				"fixture_cleanup_settled",
				"gate_settled",
			])
				expect(events).toContain(event);
			expect(events.indexOf("gate_cleanup_settled")).toBeLessThan(events.indexOf("gate_settled"));
			expect(events.indexOf("fixture_cleanup_settled")).toBeLessThan(events.indexOf("gate_settled"));
			expect(records.at(-1)).toMatchObject({ event: "gate_settled", status: "PASS", exit_code: 0 });
			expect(records.every(record => record.level === "info")).toBe(true);
			const supervisorPid = records.find(record => record.event === "gate_supervisor_spawn_settled")?.peer_pid;
			expect(supervisorPid).toBeNumber();
			const logsDir = path.dirname(logPath);
			const supervisorFiles = (await fs.readdir(logsDir)).filter(file => file.includes(`.${supervisorPid}.log`));
			expect(supervisorFiles.length).toBeGreaterThan(0);
			const supervisorText = (
				await Promise.all(supervisorFiles.map(file => fs.readFile(path.join(logsDir, file), "utf8")))
			).join("\n");
			const supervisorRecords = supervisorText
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line));
			expect(supervisorRecords).toContainEqual(
				expect.objectContaining({
					event: "gate_command_settled",
					result: "completed",
					exit_code: 0,
				}),
			);
			expect(supervisorRecords).toContainEqual(
				expect.objectContaining({
					event: "gate_supervisor_ipc_sending",
					stage: "reply",
					exit_code: 0,
				}),
			);
			expect(supervisorRecords.every(record => record.level === "info")).toBe(true);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	},
	10_000,
);

it.each(["fastcheck", "fulltest", "slowtest"] satisfies GateLevel[])(
	"summarizes %s interrupts during watchdog startup before invoking gate work",
	async level => {
		const runtime = pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href;
		const script = `import {runGate} from ${JSON.stringify(runtime)};
const pending = runGate(${JSON.stringify(level)}, async () => {
  process.stdout.write("UNEXPECTED_WORK_STARTED");
  await Promise.withResolvers().promise;
}, {limitSeconds:0.4,exitOnFailure:true});
// runGate has started the worker but cannot have received its ready message
// in this same JavaScript turn. Keep the interrupt inside an isolated process.
process.emit("SIGINT");
await pending;
process.exit(99);`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 3000,
			env: { ...process.env, OMP_GATE_EVENT_TOKEN: "", OMP_GATE_EVENT_FILE: "", OMP_GATE_CLOCK_TOKEN: "" },
		});
		try {
			const [code, stdout] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(130);
			expect(stdout).not.toContain("UNEXPECTED_WORK_STARTED");
			expect(stdout).toMatch(
				new RegExp(
					`${level}: INTERRUPTED total=\\d+\\.\\ds compile_excluded=\\d+\\.\\ds budgeted=\\d+\\.\\ds limit=0\\.4s exit=130`,
				),
			);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	},
	5000,
);

it.each([
	{ name: "first-failure", exitCode: 23 },
	{ name: "watchdog-deadline", exitCode: 124 },
	{ name: "startup-interrupt", exitCode: 130 },
])(
	"exits with full unconsumed stdout and stderr at $name",
	async ({ name, exitCode }) => {
		const runtime = pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href;
		const failures = pathToFileURL(path.join(import.meta.dir, "test-gate-failure-events.ts")).href;
		const marker = path.join(directory, `blocked-output-${name}.markers`);
		await fs.writeFile(marker, "");
		const script = `
import {Worker} from "node:worker_threads";
import {appendFileSync} from "node:fs";
const mark = phase => appendFileSync(${JSON.stringify(marker)}, phase+"\\n");
import {runGate} from ${JSON.stringify(runtime)};
import {GateCommandError} from ${JSON.stringify(failures)};
async function saturate() {
const state = new Int32Array(new SharedArrayBuffer(8));
// Only fixture workers fill the inherited pipes; no gate command/business work runs.
for (let index = 0; index < 2; index++) {
  new Worker(\`const {workerData}=require("node:worker_threads");
const {writeSync}=require("node:fs");
const state=new Int32Array(workerData.state);
const bytes=Buffer.alloc(4096,120);
for (;;) {
  try { const written=writeSync(workerData.fd,bytes); if(written>0){if (Atomics.add(state,workerData.index,1) >= 2048) throw new Error("fixture pipe unexpectedly drained beyond 8MiB");}else Atomics.wait(state,workerData.index,Atomics.load(state,workerData.index),5); }
  catch (error) { if (error.code !== "EAGAIN") throw error; Atomics.wait(state,workerData.index,Atomics.load(state,workerData.index),5); }
}\`,{eval:true,workerData:{state:state.buffer,index,fd:index+1}});
}
// Observe positive progress followed by stable saturation on BOTH actual pipes.
// These independent native pipes/threads use the real OS clock, not fake timers.
let previous = [-1,-1];
for (;;) {
  await Bun.sleep(100);
  const current = [Atomics.load(state,0),Atomics.load(state,1)];
  if (current.every((count,index) => count > 0 && count === previous[index])) break;
  previous = current;
}
mark("saturated");
}
${name !== "first-failure" ? 'await saturate(); mark("runtime-start");' : ""}
const pending=runGate("fulltest",async gate => {
  ${name === "first-failure" ? "await saturate();" : ""}
  mark("gate-start");
  ${name === "first-failure" ? 'gate.fail(new GateCommandError("blocked-output original failure",23));' : "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);"}
},{${name !== "first-failure" ? "limitSeconds:0.4," : ""}exitOnFailure:true,reportFailure:true});
${name === "startup-interrupt" ? 'process.emit("SIGINT");' : ""}
await pending;
process.exit(99);`;
		// Bun eagerly drains captured subprocess pipes. An actual Node process owns
		// these paused child streams so the OS pipes really fill, with bounded data.
		const harness = `
import {spawn} from "node:child_process";
import {watch,readFileSync} from "node:fs";
const marker=${JSON.stringify(marker)};
let gateStarted;
let guarded=false;
const child=spawn(${JSON.stringify(process.execPath)},["-e",${JSON.stringify(script)}],{
  stdio:["ignore","pipe","pipe"],
  env:{...process.env,OMP_GATE_EVENT_TOKEN:"blocked-output-fixture",OMP_GATE_EVENT_FILE:"",OMP_GATE_CLOCK_TOKEN:""}
});
// Do not attach data listeners or resume either stream.
const guard=()=>{guarded=true;child.kill("SIGKILL");};
let timer=setTimeout(guard,20000);
const inspect=()=>{
  if(gateStarted===undefined && readFileSync(marker,"utf8").includes(${JSON.stringify(name === "first-failure" ? "gate-start\n" : "runtime-start\n")})){
    gateStarted=performance.now();clearTimeout(timer);timer=setTimeout(guard,3500);
  }
};
const watcher=watch(marker,inspect);
process.on("SIGTERM",guard);
child.on("error",error=>{console.error(error);process.exitCode=1;});
child.on("exit",async(code,signal)=>{
  inspect();
  const elapsed=gateStarted===undefined?null:performance.now()-gateStarted;
  clearTimeout(timer);watcher.close();
  const markers=readFileSync(marker,"utf8");
  // Only after native exit: drain our own finite pipes, retaining bounded diagnostics.
  const drain=async stream=>{
    let text="";
    for await(const bytes of stream) text=(text+bytes.toString()).slice(-16384);
    return text;
  };
  const [stdout,stderr]=await Promise.all([drain(child.stdout),drain(child.stderr)]);
  console.log(JSON.stringify({code,signal,guarded,elapsed,markers,stdout,stderr}));
});
`;
		const child = Bun.spawn(["node", "--input-type=module", "-e", harness], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		try {
			const code = await child.exited;
			expect(code).toBe(0);
			const result = JSON.parse(await stdout);
			if (!result.markers.includes("saturated\n")) {
				throw new Error(`Pipe fixture exited before saturation: ${JSON.stringify(result)}`);
			}
			expect(result.markers).toContain("saturated\n");
			expect(result.markers).toContain(name === "first-failure" ? "gate-start\n" : "runtime-start\n");
			expect(result.guarded).toBe(false);
			expect(result.code).toBe(exitCode);
			if (name === "startup-interrupt") expect(result.markers).not.toContain("gate-start\n");
			expect(result.elapsed).toBeLessThan(2000);
		} finally {
			if (child.exitCode === null) child.kill("SIGTERM");
			await child.exited;
			await Promise.all([stdout, stderr]);
		}
	},
	25_000,
);

// The native watchdog runs on another thread against the OS clock; fake timers
// cannot terminate an independently spawned, synchronously blocked scheduler.
it.each([
	{
		name: "first failure does not wait for report finalizers",
		work: `gate.onFinalize(() => Promise.withResolvers().promise); throw new GateCommandError("original failure", 23);`,
		exitCode: 23,
		status: "FAIL",
	},
	{
		name: "a blocked report finalizer cannot hold a timed-out gate open",
		work: `gate.onFinalize(() => Promise.withResolvers().promise);`,
		exitCode: 124,
		status: "TIMEOUT",
	},
	{
		name: "the total deadline terminates a synchronously blocked scheduler",
		work: `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
		exitCode: 124,
		status: "TIMEOUT",
	},
	{
		name: "compiler-only work cannot extend the total deadline",
		work: `await gate.run({label:"fixture compiler", argv:[process.execPath,"-e","setInterval(() => {}, 1000)"], kind:"compile"});`,
		exitCode: 124,
		status: "TIMEOUT",
	},
	{
		name: "an unhandled background failure terminates blocked gate work",
		work: `setImmediate(() => { throw new Error("background failure"); }); await gate.charged(() => Promise.withResolvers().promise);`,
		exitCode: 1,
		status: "FAIL",
	},
])(
	"$name",
	async ({ work, exitCode, status }) => {
		const runtime = pathToFileURL(path.join(import.meta.dir, "test-gate-runtime.ts")).href;
		const script = `import {runGate} from ${JSON.stringify(runtime)};
import {GateCommandError} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-failure-events.ts")).href)};
await runGate("fulltest", async gate => { ${work} }, {limitSeconds:0.4,exitOnFailure:true});
process.exit(99);`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
			// Expected failures belong to this subprocess, not to the enclosing real gate.
			env: { ...process.env, OMP_GATE_EVENT_TOKEN: "", OMP_GATE_EVENT_FILE: "", OMP_GATE_CLOCK_TOKEN: "" },
		});
		try {
			const [code, stdout] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(exitCode);
			const summary = stdout.match(/fulltest: (\w+) total=([\d.]+)s .* exit=(\d+)/);
			expect(summary?.[1]).toBe(status);
			expect(Number(summary?.[2])).toBeLessThan(2);
			expect(Number(summary?.[3])).toBe(exitCode);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	},
	5000,
);
