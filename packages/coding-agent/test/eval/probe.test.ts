// Integration test: runBoundedProbe spawns and kills a real subprocess, so the
// timeout/abort teardown is inherently wall-clock bound. Fake timers cannot
// advance a child process's execution or resolve its `exited` promise, so the
// real-timer exception in ts-no-test-timers applies here.
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import * as runtimeProbe from "../../src/eval/probe";
import { checkPythonKernelAvailability, PythonKernel } from "../../src/eval/py/kernel";
import { probeCandidates, runBoundedProbe } from "../../src/eval/probe";
import * as runnerCache from "../../src/eval/runner-cache";

// A cross-platform "hangs forever" command: re-invoke the running Bun to sleep.
const bun = process.execPath;
const HANG = [bun, "-e", "await Bun.sleep(60_000)"];
const IGNORE_TERM = [bun, "-e", 'process.on("SIGTERM", () => {}); await Bun.sleep(60_000)'];
const baseEnv = (): Record<string, string | undefined> => ({ ...process.env });

describe("runBoundedProbe", () => {
	test("a hung probe is bounded by its timeout instead of hanging (regression: #9466)", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, { cwd: process.cwd(), env: baseEnv(), timeoutMs: 300 });
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("force-kills a probe that ignores SIGTERM when its timeout expires", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(IGNORE_TERM, {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 300,
		});
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("kills descendants spawned by an interpreter shim", async () => {
		const pidFile = join(tmpdir(), `omp-probe-grandchild-${process.pid}-${Date.now()}.pid`);
		let grandchildPid: number | undefined;
		const wrapper = [
			bun,
			"-e",
			`const child=Bun.spawn([process.execPath,"-e","await Bun.sleep(60_000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});await Bun.write(${JSON.stringify(pidFile)},String(child.pid));await child.exited`,
		];
		try {
			const result = await runBoundedProbe(wrapper, {
				cwd: process.cwd(),
				env: baseEnv(),
				timeoutMs: 1_000,
			});
			expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
			grandchildPid = Number(await Bun.file(pidFile).text());
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline) {
				try {
					process.kill(grandchildPid, 0);
					await Bun.sleep(25);
				} catch {
					break;
				}
			}
			expect(() => process.kill(grandchildPid!, 0)).toThrow();
		} finally {
			if (grandchildPid !== undefined) {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {
					// Expected when the process-tree teardown succeeded.
				}
			}
			await rm(pidFile, { force: true });
		}
	});

	test("an already-aborted signal short-circuits without spawning", async () => {
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.abort(),
		});
		expect(result).toEqual({ exitCode: null, timedOut: false, aborted: true });
	});

	test("an in-flight probe is killed when its signal aborts", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.timeout(100),
		});
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("a fast probe reports its real exit code", async () => {
		const ok = await runBoundedProbe([bun, "-e", "process.exit(0)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(ok).toEqual({ exitCode: 0, timedOut: false, aborted: false });

		const failing = await runBoundedProbe([bun, "-e", "process.exit(3)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(failing).toEqual({ exitCode: 3, timedOut: false, aborted: false });
	});
});

describe("probeCandidates", () => {
	test("shares one discovery deadline across hung candidates instead of paying it per candidate", async () => {
		const start = Date.now();
		const result = await probeCandidates(
			[
				{ command: HANG, env: baseEnv(), label: "cand-a" },
				{ command: HANG, env: baseEnv(), label: "cand-b" },
				{ command: HANG, env: baseEnv(), label: "cand-c" },
			],
			{ cwd: process.cwd(), timeoutMs: 300 },
		);
		const elapsed = Date.now() - start;
		expect(result).toEqual({ ok: false, aborted: false, failures: expect.any(Array) });
		// The wider Windows teardown allowance must not admit spending a fresh
		// budget on each candidate: only the first hangs, the next is not probed.
		expect(result).toMatchObject({
			failures: ["cand-a (probe timed out)", "cand-b (probe budget exhausted)"],
		});
		// One 300ms budget total, not 3×: the whole discovery stays well under the
		// combined per-candidate cost it would incur without a shared deadline.
		// Windows child-process spawn/teardown overhead needs a wider bound.
		expect(elapsed).toBeLessThan(process.platform === "win32" ? 4_000 : 900);
	});

	test("returns the first candidate that exits 0 and skips the rest", async () => {
		const result = await probeCandidates(
			[
				{ command: [bun, "-e", "process.exit(1)"], env: baseEnv(), label: "bad" },
				{ command: [bun, "-e", "process.exit(0)"], env: baseEnv(), label: "good" },
				{ command: HANG, env: baseEnv(), label: "would-hang" },
			],
			{ cwd: process.cwd(), timeoutMs: 5_000 },
		);
		expect(result).toEqual({ ok: true, index: 1 });
	});
});

describe("P2-21 Python Eval runtime scope", () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	const offlinePython = "/software/public/python/3.11.4/bin/python3.11";
	const systemPython = path.join(path.sep, "usr", "bin", "python3");
	let cwd: string;
	let activeDir: string;
	let activePython: string;
	let env: Record<string, string>;

	beforeEach(() => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
		// Successful availability checks are memoized by cwd, so each case owns
		// a distinct cache key without mutating production cache state.
		cwd = path.join(tmpdir(), `omp-eval-scope-${randomUUID()}`);
		activeDir = path.join(cwd, ".venv");
		activePython = path.join(activeDir, "bin", "python");
		env = {
			OMP_OFFLINE: "1",
			PATH: "/business/.venv/bin:/usr/bin",
			VIRTUAL_ENV: activeDir,
			CONDA_PREFIX: "/business/conda",
			CONDA_DEFAULT_ENV: "business",
			PYTHONPATH: "/business/python36/site-packages",
			LD_LIBRARY_PATH: "/software/lib",
		};
		const settings = Settings.isolated();
		const shellConfig = settings.getShellConfig();
		vi.spyOn(Settings, "init").mockResolvedValue(settings);
		vi.spyOn(settings, "getShellConfig").mockReturnValue({ ...shellConfig, env });
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(path.join(cwd, "missing-managed"));
		vi.spyOn(piUtils, "$which").mockReturnValue(systemPython);
		vi.spyOn(fs, "existsSync").mockImplementation(candidate =>
			[offlinePython, activePython].includes(String(candidate)),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(process, "platform", platformDescriptor);
	});

	test("probes the fixed interpreter first only for Eval and isolates its child environment", async () => {
		const originalEnv = { ...env };
		const probe = vi.spyOn(runtimeProbe, "probeCandidates").mockResolvedValue({ ok: true, index: 0 });

		const result = await checkPythonKernelAvailability(cwd, undefined, { forceProbe: true });

		expect(result).toMatchObject({ ok: true, pythonPath: offlinePython });
		expect(probe).toHaveBeenCalledTimes(1);
		const candidates = probe.mock.calls[0][0];
		expect(candidates.map(candidate => candidate.command[0])).toEqual([offlinePython, activePython, systemPython]);
		expect(candidates[0].env).toEqual({
			OMP_OFFLINE: "1",
			PATH: env.PATH,
			LD_LIBRARY_PATH: env.LD_LIBRARY_PATH,
		});
		expect(candidates[1].env).toMatchObject({
			VIRTUAL_ENV: activeDir,
			PYTHONPATH: env.PYTHONPATH,
		});
		expect(result.runtime?.env).toEqual(candidates[0].env);
		expect(env).toEqual(originalEnv);
	});

	test.each(["automatic", "explicit"] as const)(
		"keeps %s runtime selection when kernel startup bypasses availability probing",
		async selection => {
			const originalEnv = { ...env };
			const interpreter = selection === "explicit" ? path.join(cwd, "explicit-python") : undefined;
			const scriptPath = path.join(cwd, "runner.py");
			const stoppedBeforeSpawn = new Error("Captured kernel spawn");
			vi.spyOn(piUtils, "isBunTestRuntime").mockReturnValue(true);
			const probe = vi.spyOn(runtimeProbe, "probeCandidates");
			vi.spyOn(runnerCache, "stageRunnerScript").mockResolvedValue(scriptPath);
			const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
				throw stoppedBeforeSpawn;
			});

			await expect(PythonKernel.start({ cwd, interpreter })).rejects.toBe(stoppedBeforeSpawn);

			expect(probe).not.toHaveBeenCalled();
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(spawn).toHaveBeenCalledWith(
				[interpreter ?? offlinePython, "-u", scriptPath],
				expect.objectContaining({
					env: {
						...(selection === "explicit"
							? env
							: { OMP_OFFLINE: "1", PATH: env.PATH, LD_LIBRARY_PATH: env.LD_LIBRARY_PATH }),
						PYTHONUNBUFFERED: "1",
						PYTHONIOENCODING: "utf-8",
					},
				}),
			);
			expect(env).toEqual(originalEnv);
		},
	);

	test.each(["missing", "incompatible"] as const)(
		"retains automatic fallback when the fixed Eval interpreter is %s",
		async fixed => {
			if (fixed === "missing") {
				vi.spyOn(fs, "existsSync").mockImplementation(candidate => String(candidate) === activePython);
			}
			const probe = vi
				.spyOn(runtimeProbe, "probeCandidates")
				.mockResolvedValue({ ok: true, index: fixed === "missing" ? 0 : 1 });

			const result = await checkPythonKernelAvailability(cwd, undefined, { forceProbe: true });

			expect(result).toMatchObject({ ok: true, pythonPath: activePython });
			expect(probe).toHaveBeenCalledTimes(1);
			expect(probe.mock.calls[0][0].map(candidate => candidate.command[0])).toEqual(
				fixed === "missing" ? [activePython, systemPython] : [offlinePython, activePython, systemPython],
			);
			expect(result.runtime?.env).toMatchObject({
				VIRTUAL_ENV: activeDir,
				PYTHONPATH: env.PYTHONPATH,
			});
		},
	);

	test.each(["missing", "incompatible"] as const)(
		"does not fall back from a %s explicit interpreter to working offline candidates",
		async failure => {
			const explicitPython = path.join(cwd, "explicit-python");
			const probe = vi.spyOn(runtimeProbe, "probeCandidates").mockResolvedValue({
				ok: false,
				aborted: false,
				failures: [`${explicitPython} (${failure === "missing" ? "ENOENT" : "exit code 1"})`],
			});

			const result = await checkPythonKernelAvailability(cwd, explicitPython, { forceProbe: true });

			expect(result).toMatchObject({ ok: false, pythonPath: explicitPython });
			expect(probe).toHaveBeenCalledTimes(1);
			const candidates = probe.mock.calls[0][0];
			expect(candidates.map(candidate => candidate.command[0])).toEqual([explicitPython]);
			expect(candidates[0].env).toEqual(env);
		},
	);

	test.each([
		["linux", undefined],
		["linux", "0"],
		["linux", "true"],
		["darwin", "1"],
		["win32", "1"],
	] as const)("does not add the Eval fixed candidate on %s with OMP_OFFLINE=%s", async (platform, offline) => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
		if (offline === undefined) delete env.OMP_OFFLINE;
		else env.OMP_OFFLINE = offline;
		const probe = vi.spyOn(runtimeProbe, "probeCandidates").mockResolvedValue({ ok: true, index: 0 });

		const result = await checkPythonKernelAvailability(cwd, undefined, { forceProbe: true });

		expect(result.ok).toBe(true);
		expect(probe).toHaveBeenCalledTimes(1);
		const candidates = probe.mock.calls[0][0];
		expect(candidates.map(candidate => candidate.command[0])).not.toContain(offlinePython);
		expect(candidates[0].env.PYTHONPATH).toBe(env.PYTHONPATH);
	});
});
