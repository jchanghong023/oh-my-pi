import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setProcessName } from "@oh-my-pi/pi-utils";
import { probeDaemon } from "../../src/daemon/client";
import { GLOBAL_SCOPE, type DaemonClient, type ProcSpec } from "../../src/daemon/protocol";
import { startDaemonFromEnvironment } from "../../src/daemon/server";
import * as terminalOutput from "../../src/launch/terminal-output";
import { IsolatedDaemon, waitFor } from "../fixtures/daemon-harness";

function processSpec(cwd: string, script: string, fields: Partial<ProcSpec> = {}): ProcSpec {
	return { application: process.execPath, args: ["-e", script], env: {}, cwd, pty: false, ...fields };
}

async function withDaemon(run: (client: DaemonClient, cwd: string) => Promise<void>): Promise<void> {
	const harness = await IsolatedDaemon.create();
	const title = process.title;
	const finished = startDaemonFromEnvironment();
	void finished.catch(() => undefined);
	let client: DaemonClient | undefined;
	try {
		client = await waitFor(probeDaemon, "embedded daemon");
		await run(client, harness.dir);
	} finally {
		await client?.request({ op: "shutdown" }).catch(() => undefined);
		client?.close();
		try {
			await finished;
		} finally {
			setProcessName(title);
			await harness.dispose();
		}
	}
}

function open(client: DaemonClient, key: string, proc: ProcSpec, replace = false) {
	return client.open({ kind: "proc", scope: GLOBAL_SCOPE, key, proc, replace });
}

function logs(client: DaemonClient, unit: string, cursor?: number) {
	return client.request({
		op: "logs",
		unit,
		lines: 20,
		head: false,
		follow: cursor !== undefined,
		cursor,
		timeoutMs: 2_000,
	});
}

describe("daemon service output", () => {
	it.each([false, true])(
		"matches anchored readiness after startup output (PTY: %s)",
		async pty => {
			await withDaemon(async (client, cwd) => {
				const { unit } = await open(
					client,
					"ready-lines",
					processSpec(cwd, "process.stdout.write('booting\\nREADY\\n'); process.stdin.resume();", {
						pty,
						ready: { log: "^READY$", timeoutMs: 15_000 },
					}),
				);
				expect(unit).toMatchObject({ state: "ready", readyMatch: "READY" });
			});
		},
		35_000,
	);

	it("matches anchored readiness across distinct output chunks", async () => {
		await withDaemon(async (client, cwd) => {
			const { unit } = await open(
				client,
				"chunked",
				processSpec(
					cwd,
					`
process.stdout.write("booting\\nRE");
process.stdin.once("data", () => { process.stdout.write("ADY\\n"); });
process.stdin.resume();`,
				),
			);
			await waitFor(async () => (await logs(client, unit.id)).text.includes("booting\nRE"), "first chunk");
			const ready = client.request({
				op: "wait",
				unit: unit.id,
				for: "ready",
				pattern: "^READY$",
				timeoutMs: 5_000,
			});
			await client.request({ op: "send", unit: unit.id, data: "go\n" });
			expect(await ready).toMatchObject({ matched: true, match: "READY" });
		});
	}, 35_000);

	it("returns the captured PTY cursor even while additional output arrives during rendering", async () => {
		await withDaemon(async (client, cwd) => {
			const { unit } = await open(
				client,
				"cursor",
				processSpec(
					cwd,
					`
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => process.stdout.write("AFTER-SNAPSHOT\\n"));
process.stdout.write("READY\\n");`,
					{ pty: true, ready: { log: "READY", timeoutMs: 15_000 } },
				),
			);
			expect(unit.state).toBe("ready");
			const rendering = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const render = terminalOutput.renderTerminalOutput;
			const spy = vi
				.spyOn(terminalOutput, "renderTerminalOutput")
				.mockImplementationOnce(async (output, options) => {
					rendering.resolve();
					await release.promise;
					return render(output, options);
				});
			try {
				const snapshot = logs(client, unit.id);
				await rendering.promise;
				await client.request({ op: "send", unit: unit.id, data: "race\r" });
				const observed = await client.request({
					op: "wait",
					unit: unit.id,
					for: "ready",
					pattern: "AFTER-SNAPSHOT",
					timeoutMs: 5_000,
				});
				expect(observed.matched).toBeTrue();
				release.resolve();
				const prior = await snapshot;
				expect(prior.terminalOutput).toContain("READY");
				expect(prior.terminalOutput).not.toContain("AFTER-SNAPSHOT");
				const next = await logs(client, unit.id, prior.cursor);
				expect(next.cursor).toBeGreaterThan(prior.cursor);
				expect(next.text).toContain("AFTER-SNAPSHOT");
			} finally {
				release.resolve();
				spy.mockRestore();
			}
		});
	}, 35_000);

	it("answers terminal queries from a supervised PTY without echoing the response", async () => {
		await withDaemon(async (client, cwd) => {
			const script = path.join(cwd, "terminal-query.ts");
			await Bun.write(
				script,
				`
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => {
	input += chunk;
	const match = /\\x1b\\[(\\d+);(\\d+)R/.exec(input);
	if (!match) return;
	process.stdout.write("CPR:" + match[1] + ":" + match[2] + "\\n");
	process.exit(0);
});
process.stdout.write("READY\\x1b[6n");`,
			);
			const { unit } = await open(client, "terminal-query", { ...processSpec(cwd, ""), args: [script], pty: true });
			const ended = await client.request({ op: "wait", unit: unit.id, for: "exit", timeoutMs: 15_000 });
			expect(ended).toMatchObject({ matched: true, unit: { exitCode: 0 } });
			const output = await logs(client, unit.id);
			// Older ConPTY answers with the console's real cursor before the broker sees the query.
			expect(output.text).toMatch(process.platform === "win32" ? /CPR:\d+:\d+/u : /CPR:1:1/u);
			expect(output.terminalOutput).not.toContain("\x1b[1;1R");
		});
	}, 35_000);

	it("starts replacement generations with only their own output", async () => {
		await withDaemon(async (client, cwd) => {
			const initial = await open(
				client,
				"replace",
				processSpec(cwd, "console.log('FIRST'); process.stdin.resume();", {
					ready: { log: "FIRST", timeoutMs: 10_000 },
				}),
			);
			expect((await logs(client, initial.unit.id)).text).toContain("FIRST");
			const replacement = await open(
				client,
				"replace",
				processSpec(cwd, "console.log('SECOND'); process.stdin.resume();", {
					ready: { log: "SECOND", timeoutMs: 10_000 },
				}),
				true,
			);
			expect(replacement.unit.generation).not.toBe(initial.unit.generation);
			const output = await logs(client, replacement.unit.id);
			expect(output.text).toContain("SECOND");
			expect(output.text).not.toContain("FIRST");
			const quiet = await open(client, "replace", processSpec(cwd, "process.stdin.resume();"), true);
			expect(await logs(client, quiet.unit.id)).toMatchObject({ text: "", cursor: 0 });
		});
	}, 40_000);
});
