import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSlowtestArgs, runSlowtest, type SlowtestDependencies } from "./slowtest";
import type { WslSelection, WslStageResult } from "./slowtest-wsl-stage";
import { runGate } from "./test-gate-runtime";
import { GateCommandError } from "./test-gate-failure-events";

let temporary: string;
let stub: string;
beforeAll(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slowtest-mechanism-"));
	stub = path.join(temporary, "stub.ts");
	await fs.writeFile(
		stub,
		`
import * as fs from "node:fs/promises";
import { watch } from "node:fs";
import * as path from "node:path";
const [record, barrier, role, code] = process.argv.slice(2);
if (barrier !== "none") {
 const peer = role === "current" ? "linux" : "current";
 const ready = Promise.withResolvers();
 const watcher = watch(barrier, (_event, name) => { if (String(name) === peer) ready.resolve(); });
 try {
  await fs.writeFile(path.join(barrier, role), "");
  try { await fs.access(path.join(barrier, peer)); } catch { await ready.promise; }
 } finally { watcher.close(); }
}
await fs.appendFile(record, JSON.stringify({role})+"\\n");
if (code === "hold") {
 const watcher = watch(path.dirname(record), () => {});
 try { await Promise.withResolvers().promise; } finally { watcher.close(); }
 await fs.writeFile(record + ".completed", "unexpected");
}
process.exit(Number(code));
`,
	);
});
afterAll(async () => {
	await fs.rm(temporary, { recursive: true, force: true });
});
async function fixture(selection: WslSelection, dirty = false) {
	const directory = await fs.mkdtemp(path.join(temporary, "case-"));
	const root = path.join(directory, "source");
	await fs.mkdir(root);
	await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
	const localRecord = path.join(directory, "current.jsonl");
	const linuxRecord = path.join(directory, "linux.jsonl");
	const deps: SlowtestDependencies = {
		discover: async () => selection,
		identity: async () => ({
			head: "a".repeat(40),
			digest: await fs.readFile(path.join(root, "source.ts"), "utf8"),
			dirty,
			status: dirty ? " M source.ts\n?? new.ts\n" : "",
			files: [],
		}),
		fulltest: async gate => {
			await gate.run({
				label: "isolated fulltest stub",
				argv: [process.execPath, stub, localRecord, "none", "current", "0"],
			});
		},
		bazelIntegration: async gate => {
			await gate.run({
				label: "isolated host Bazel integration stub",
				argv: [process.execPath, stub, `${localRecord}.bazel`, "none", "bazel", "0"],
			});
		},
		wsl: async (gate, options) => {
			if (selection.status !== "AVAILABLE") return selection;
			await gate.run({
				label: "isolated Linux stub",
				argv: [process.execPath, stub, linuxRecord, "none", "linux", "0"],
			});
			return { status: "PASS", distro: selection.distro, head: options.identity!.head };
		},
	};
	const execute = () =>
		runGate("slowtest", gate => runSlowtest(gate, { root, debug: false }, deps), {
			limitSeconds: 20,
			print: () => {},
		});
	const records = async (file: string): Promise<Array<{ role: string }>> =>
		(await fs.readFile(file, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
	return { root, deps, execute, records, localRecord, linuxRecord };
}

function holdCurrentValidation(f: { deps: SlowtestDependencies }) {
	const started = Promise.withResolvers<void>();
	const state = { started: started.promise, cancelled: false };
	f.deps.fulltest = async gate => {
		started.resolve();
		await new Promise<void>(resolve => {
			const abort = () => {
				state.cancelled = true;
				resolve();
			};
			if (gate.signal.aborted) abort();
			else gate.signal.addEventListener("abort", abort, { once: true });
		});
		throw new GateCommandError("local work cancelled after original failure", 23, "INTERRUPTED");
	};
	return state;
}

describe("slowtest isolated mechanism", () => {
	test.each([
		{ status: "SKIPPED_WSL_UNAVAILABLE", reason: "no compatible WSL" },
		{ status: "SKIPPED_NOT_APPLICABLE", reason: "no project need" },
	] as WslSelection[])(
		"executes current validation once when extension is $status, including dirty source",
		async selection => {
			const f = await fixture(selection, true);
			expect((await f.execute()).status).toBe("PASS");
			expect(await f.records(f.localRecord)).toHaveLength(1);
			await expect(fs.stat(f.linuxRecord)).rejects.toMatchObject({ code: "ENOENT" });
		},
		20000,
	);

	test("dirty available source cancels local validation without transferring it", async () => {
		const selection = { status: "AVAILABLE", distro: "Ubuntu-24.04" } as const;
		const f = await fixture(selection, true);
		const local = holdCurrentValidation(f);
		f.deps.discover = async () => {
			await local.started;
			return selection;
		};
		let wslStarted = false;
		f.deps.wsl = async () => {
			wslStarted = true;
			throw new Error("dirty source must never enter WSL stage");
		};
		const result = await f.execute();
		expect(result.status).toBe("FAIL");
		expect(result.exitCode).toBe(1);
		expect(local.cancelled).toBe(true);
		expect(wslStarted).toBe(false);
	}, 20000);

	test("clean fixed-commit independent platform processes overlap", async () => {
		const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
		const barrier = await fs.mkdtemp(path.join(temporary, "concurrency-"));
		f.deps.fulltest = async gate => {
			await gate.run({
				label: "current stub",
				argv: [process.execPath, stub, f.localRecord, barrier, "current", "0"],
			});
		};
		f.deps.wsl = async (gate, options) => {
			await gate.run({ label: "Linux stub", argv: [process.execPath, stub, f.linuxRecord, barrier, "linux", "0"] });
			return { status: "PASS", distro: "Ubuntu-24.04", head: options.identity!.head };
		};
		expect((await f.execute()).status).toBe("PASS");
		expect(await f.records(f.localRecord)).toEqual([{ role: "current" }]);
		expect(await f.records(f.linuxRecord)).toEqual([{ role: "linux" }]);
	}, 20000);

	test.each(["BLOCKED", "UNVERIFIED", "FAIL", "TIMEOUT", "CANCELLED"] as const)(
		"executed WSL $0 aborts a live local fulltest and preserves the triggering exit",
		async status => {
			const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
			const barrier = await fs.mkdtemp(path.join(temporary, "failure-barrier-"));
			const exitCode = status === "TIMEOUT" ? 124 : status === "CANCELLED" ? 130 : 17;
			f.deps.fulltest = async gate => {
				await gate.run({
					label: "live current stub",
					argv: [process.execPath, stub, f.localRecord, barrier, "current", "hold"],
				});
			};
			f.deps.wsl = async gate => {
				await gate.capture({
					label: "executed Linux failure",
					argv: [process.execPath, stub, f.linuxRecord, barrier, "linux", String(exitCode)],
					allowFailure: true,
				});
				return { status, reason: "original executed failure", exitCode };
			};
			const result = await f.execute();
			expect(result.status).toBe(status === "CANCELLED" ? "INTERRUPTED" : status === "TIMEOUT" ? "TIMEOUT" : "FAIL");
			expect(result.exitCode).toBe(exitCode);
			expect(await f.records(f.linuxRecord)).toEqual([{ role: "linux" }]);
			expect(await Bun.file(`${f.localRecord}.completed`).exists()).toBe(false);
		},
		20000,
	);

	test.each([new Error("WSL service probe blocked"), new GateCommandError("WSL discovery exited", 19)])(
		"discovery exception cancels current validation and preserves its exit: %s",
		async error => {
			const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
			const local = holdCurrentValidation(f);
			let wslStarted = false;
			f.deps.discover = async () => {
				await local.started;
				throw error;
			};
			f.deps.wsl = async () => {
				wslStarted = true;
				throw new Error("discovery failure must not start WSL execution");
			};
			const result = await f.execute();
			expect(result.status).toBe("FAIL");
			expect(result.exitCode).toBe(error instanceof GateCommandError ? error.exitCode : 1);
			expect(local.cancelled).toBe(true);
			expect(wslStarted).toBe(false);
		},
		20000,
	);

	test.each([new Error("WSL evidence inspection failed"), new GateCommandError("WSL execution exited", 29)])(
		"WSL exception cancels current validation and preserves its exit: %s",
		async error => {
			const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
			const local = holdCurrentValidation(f);
			f.deps.wsl = async () => {
				await local.started;
				throw error;
			};
			const result = await f.execute();
			expect(result.status).toBe("FAIL");
			expect(result.exitCode).toBe(error instanceof GateCommandError ? error.exitCode : 1);
			expect(local.cancelled).toBe(true);
		},
		20000,
	);

	test("zero-code failure status becomes exit one and cancels local validation", async () => {
		const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
		const local = holdCurrentValidation(f);
		f.deps.wsl = async () => {
			await local.started;
			return { status: "UNVERIFIED", reason: "missing evidence", exitCode: 0 };
		};
		const result = await f.execute();
		expect(result.status).toBe("FAIL");
		expect(result.exitCode).toBe(1);
		expect(local.cancelled).toBe(true);
	}, 20000);

	test.each(["before", "after"] as const)("source identity exception %s validation fails the gate", async phase => {
		const f = await fixture({ status: "SKIPPED_NOT_APPLICABLE", reason: "fixture" });
		const identity = f.deps.identity;
		let observations = 0;
		let currentStarted = false;
		f.deps.identity = async (gate, root) => {
			observations++;
			if (observations === (phase === "before" ? 1 : 2))
				throw new GateCommandError("source evidence unavailable", 31);
			return identity(gate, root);
		};
		f.deps.fulltest = async () => {
			currentStarted = true;
		};
		const result = await f.execute();
		expect(result.status).toBe("FAIL");
		expect(result.exitCode).toBe(31);
		expect(currentStarted).toBe(phase === "after");
	});

	test("source changes during current validation cannot verify one identity", async () => {
		const f = await fixture({ status: "SKIPPED_NOT_APPLICABLE", reason: "fixture" });
		const original = f.deps.fulltest;
		f.deps.fulltest = async (gate, options) => {
			await original(gate, options);
			await gate.charged(() => fs.writeFile(path.join(f.root, "source.ts"), "changed during validation\n"));
		};
		expect((await f.execute()).status).toBe("FAIL");
	}, 20000);

	test("mismatching Linux fixed commit immediately cancels current validation", async () => {
		const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
		const local = holdCurrentValidation(f);
		f.deps.wsl = async (): Promise<WslStageResult> => {
			await local.started;
			return { status: "PASS", distro: "Ubuntu-24.04", head: "b".repeat(40) };
		};
		const result = await f.execute();
		expect(result.status).toBe("FAIL");
		expect(result.exitCode).toBe(1);
		expect(local.cancelled).toBe(true);
	}, 20000);
});

test("slowtest rejects budget relaxation and ambiguous options", () => {
	expect(parseSlowtestArgs(["--limit-seconds=15", "--debug"])).toEqual({ debug: true, limitSeconds: 15 });
	for (const args of [
		["--release"],
		["--limit-seconds"],
		["--limit-seconds", "15"],
		["--limit-seconds=1501"],
		["--limit-seconds=0"],
		["--limit-seconds=NaN"],
		["--limit-seconds=15", "--limit-seconds=14"],
	])
		expect(parseSlowtestArgs(args)).toBeNull();
});
test("invalid slowtest CLI arguments still print the whole-run summary", async () => {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slowtest.ts"), "--invalid-gate-option"], {
		stdout: "pipe",
		stderr: "pipe",
		// This intentionally invalid nested CLI is fixture evidence, not a
		// failure of the enclosing fulltest gate running these mechanism tests.
		env: { ...process.env, OMP_GATE_EVENT_TOKEN: "", OMP_GATE_EVENT_FILE: "", OMP_GATE_CLOCK_TOKEN: "" },
	});
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode).toBe(2);
	expect(stdout).toMatch(
		/slowtest: FAIL total=[\d.]+s compile_excluded=[\d.]+s budgeted=[\d.]+s limit=1500\.0s exit=2/,
	);
});
