import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	compileWorkflowScript,
	InMemoryJournalStore,
	lowerWorkflowScript,
	type WorkflowDriver,
} from "../../src/modes/zcode/workflows/vendor/dynamic-workflow/index.js";
import { runWorkflowScript } from "../../src/modes/zcode/workflows/runtime.js";

function noActorDriver(journal: InMemoryJournalStore): WorkflowDriver {
	return {
		journal,
		emit() {},
		createActorSession() {
			throw new Error("Unexpected actor creation");
		},
		startAsk() {
			throw new Error("Unexpected model request");
		},
		respondToSubmit() {
			throw new Error("Unexpected submission");
		},
		cancelAsk() {},
		executeWorldRead() {
			throw new Error("Unexpected world read");
		},
	};
}

describe("ZCode extracted workflow runtime", () => {
	it("preserves author line and argument type diagnostics", () => {
		const result = compileWorkflowScript('const count: number = "not a number";\nreturn count;');
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 2322, line: 1, column: 7 }));
		const forbidden = compileWorkflowScript("return process.cwd();");
		expect(forbidden.ok).toBe(false);
		expect(forbidden.diagnostics.some(diagnostic => diagnostic.message.includes("process"))).toBe(true);
		const wrongArgument = compileWorkflowScript("return await files.read(42);");
		expect(wrongArgument.ok).toBe(false);
		expect(wrongArgument.diagnostics).toContainEqual(expect.objectContaining({ code: 2345, line: 1 }));
	});

	it("lowers and runs arguments through the real same-OMP sandbox child", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omp-dwf-"));
		try {
			const scriptText = "return [typeof process, typeof require, typeof fetch];";
			// process is deliberately probed only in lowered sandbox JS; source compilation forbids it.
			const validSource = "return [String(args.target), Number(args.depth), Object.isFrozen(args)];";
			const compiled = lowerWorkflowScript(validSource);
			expect(compiled.ok).toBe(true);
			expect(compiled.lowered).toBeDefined();
			const journal = new InMemoryJournalStore();
			const result = await runWorkflowScript({
				scriptText: validSource,
				lowered: compiled.lowered!.code,
				cwd,
				runId: "args-source-child",
				args: { target: "packages/core", depth: 3 },
				caps: { maxConcurrency: 1 },
				askSpecs: new Map(),
				validate: () => [],
				makeDriver: () => noActorDriver(journal),
			});
			expect(result).toEqual({ status: "completed", artifact: ["packages/core", 3, true] });
			expect(journal.getRun("args-source-child")?.args).toEqual({ target: "packages/core", depth: 3 });
			const isolated = await runWorkflowScript({
				lowered: scriptText,
				cwd,
				runId: "isolation-source-child",
				args: { target: "isolated", depth: 1 },
				caps: { maxConcurrency: 1 },
				askSpecs: new Map(),
				validate: () => [],
				makeDriver: () => noActorDriver(new InMemoryJournalStore()),
			});
			expect(isolated).toEqual({ status: "completed", artifact: ["undefined", "undefined", "undefined"] });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	for (const outcome of ["completed", "failed", "cancelled", "pre-aborted", "spawn-error"] as const) {
		it(`waits for owned process and stdio close after ${outcome} settlement`, async () => {
			const cwd = await mkdtemp(join(tmpdir(), "omp-dwf-close-"));
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			// Only model the runner's process/stdio boundary. Bun's real ChildProcess
			// exposes readonly pipe properties; no process is executed by this fixture.
			const child = Object.assign(new EventEmitter(), {
				stdin,
				stdout,
				stderr,
				exitCode: null as number | null,
				signalCode: null as NodeJS.Signals | null,
				kill: () => true,
			});
			const killed = Promise.withResolvers<void>();
			const kill = spyOn(child, "kill").mockImplementation(() => {
				killed.resolve();
				return true;
			});
			const spawn = spyOn(childProcess, "spawn").mockReturnValue(child as unknown as childProcess.ChildProcess);
			const controller = new AbortController();
			if (outcome === "pre-aborted") controller.abort("interrupted");
			let returned = false;
			try {
				const running = runWorkflowScript({
					lowered: "return 1;",
					cwd,
					runId: `close-${outcome}`,
					caps: { maxConcurrency: 1 },
					askSpecs: new Map(),
					validate: () => [],
					signal: controller.signal,
					makeDriver: () => noActorDriver(new InMemoryJournalStore()),
				}).then(result => {
					returned = true;
					return result;
				});
				if (outcome === "completed") {
					stdout.write('{"kind":"complete","ok":true,"value":1}\n');
				} else if (outcome === "failed") {
					stdout.write('{"kind":"complete","ok":false,"error":{"message":"script failed"}}\n');
				} else if (outcome === "cancelled") {
					// App-server EOF/close uses this same owner interruption signal.
					controller.abort("interrupted");
				} else if (outcome === "spawn-error") {
					child.emit("error", new Error("sandbox could not spawn"));
				}
				await killed.promise;
				// An exit notification is insufficient: stdout/stderr may still own handles.
				child.exitCode = 0;
				child.emit("exit", 0, null);
				await new Promise<void>(resolve => setImmediate(resolve));
				expect(kill).toHaveBeenCalledTimes(1);
				expect(stdin.writableEnded).toBe(true);
				expect(returned).toBe(false);
				stdin.destroy();
				stdout.destroy();
				stderr.destroy();
				child.emit("close", 0, null);
				const result = await running;
				expect(returned).toBe(true);
				if (outcome === "completed") {
					expect(result).toEqual({ status: "completed", artifact: 1 });
				} else if (outcome === "failed") {
					expect(result.status).toBe("errored");
				} else {
					expect(result).toMatchObject({ status: "stopped", reason: "interrupted" });
				}
			} finally {
				spawn.mockRestore();
				kill.mockRestore();
				stdin.destroy();
				stdout.destroy();
				stderr.destroy();
				await rm(cwd, { recursive: true, force: true });
			}
		});
	}
});
