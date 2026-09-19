import { describe, expect, it } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";

// A Windows console ctrl event reaches the process as a real SIGINT regardless
// of raw mode; the historical signal path exited on the first hit. The
// interactive TUI now registers an interceptor that consumes a first signal
// (double-press gate). These tests pin the dispatch contract: a consuming
// interceptor keeps the process alive, everything else runs the signal
// teardown and exits 130. Uses child processes because the non-consumed path
// terminates the calling process.

const exitFlag = "--sigint-child-exit";
const consumeFlag = "--sigint-child-consume";
const throwFlag = "--sigint-child-throw";
const unsubscribeFlag = "--sigint-child-unsubscribe";

if (process.argv.includes(exitFlag)) {
	postmortem.register("sigint-test", reason => {
		process.stdout.write(`${reason}\n`);
	});
	await postmortem.handleSigint({ diagnostics: false });
	process.stdout.write("REACHED-END\n");
} else if (process.argv.includes(consumeFlag)) {
	const unsubscribe = postmortem.interceptSigint(() => true);
	await postmortem.handleSigint({ diagnostics: false });
	unsubscribe();
	process.stdout.write("ALIVE\n");
	process.exit(7);
} else if (process.argv.includes(throwFlag)) {
	postmortem.interceptSigint(() => {
		throw new Error("gate bug");
	});
	await postmortem.handleSigint({ diagnostics: false });
	process.stdout.write("REACHED-END\n");
} else if (process.argv.includes(unsubscribeFlag)) {
	const unsubscribe = postmortem.interceptSigint(() => true);
	unsubscribe();
	await postmortem.handleSigint({ diagnostics: false });
	process.stdout.write("REACHED-END\n");
}

if (![exitFlag, consumeFlag, throwFlag, unsubscribeFlag].some(flag => process.argv.includes(flag))) {
	describe("postmortem SIGINT interceptor dispatch", () => {
		it("exports the interceptor registration and dispatch surface", () => {
			expect(typeof postmortem.interceptSigint).toBe("function");
			expect(typeof postmortem.handleSigint).toBe("function");
		});

		it("runs the signal teardown with reason sigint and exits 130 without an interceptor", async () => {
			const child = Bun.spawn([process.execPath, "run", import.meta.path, exitFlag], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(exitCode).toBe(130);
			expect(stdout).toContain("sigint");
			expect(stdout).not.toContain("REACHED-END");
		});

		it("keeps the process alive when an interceptor consumes the signal", async () => {
			const child = Bun.spawn([process.execPath, "run", import.meta.path, consumeFlag], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(exitCode).toBe(7);
			expect(stdout).toContain("ALIVE");
		});

		it("treats a throwing interceptor as non-consuming (killability is preserved)", async () => {
			const child = Bun.spawn([process.execPath, "run", import.meta.path, throwFlag], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode).toBe(130);
			expect(stdout).not.toContain("REACHED-END");
			expect(stderr).toContain("SIGINT interceptor threw");
		});

		it("an unregistered interceptor no longer consumes the signal", async () => {
			const child = Bun.spawn([process.execPath, "run", import.meta.path, unsubscribeFlag], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(exitCode).toBe(130);
			expect(stdout).not.toContain("REACHED-END");
		});
	});
}
