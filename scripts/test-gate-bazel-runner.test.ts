import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

for (const scenario of [
	"native exit",
	"missing evidence",
	"invalid evidence",
	"setup exception",
	"payload exit",
] as const) {
	test(`isolated driver reports ${scenario} before withheld cleanup`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-driver-failure-"));
		let child: Bun.Subprocess | undefined;
		try {
			await fs.copyFile(path.join(import.meta.dir, "test-gate-bazel-runner.ts"), path.join(root, "runner.ts"));
			await Bun.write(
				path.join(root, "test-gate-events.ts"),
				"export async function withChargedActivity(fn) { return await fn(); }",
			);
			await Bun.write(
				path.join(root, "test-gate-clock.ts"),
				"export function gateClockNanoseconds() { return process.hrtime.bigint(); }",
			);
			await Bun.write(
				path.join(root, "test-gate-bazel-report.ts"),
				"export async function recordBazelInvocation() {}",
			);
			await Bun.write(
				path.join(root, "test-gate-process.ts"),
				`
let calls = 0;
export async function requestPersistentBazel() {
  calls++;
  if (${JSON.stringify(scenario)} === "setup exception") throw new Error("fixture native setup cause");
  return { pid: process.pid, exited: Promise.resolve(${JSON.stringify(scenario)} === "native exit" ? 37 : ${JSON.stringify(scenario)} === "payload exit" && calls === 2 ? 39 : 0), async cancel() {} };
}
export function relayPersistentBazel() {}
`,
			);
			await Bun.write(
				path.join(root, "preload.ts"),
				`
Bun.serve = () => ({ url: new URL("http://127.0.0.1:1/"), async stop() {
  process.send({ type: "fixture-cleanup" });
  const release = Promise.withResolvers();
  process.on("message", message => { if (message === "fixture-release") release.resolve(); });
  await release.promise;
  throw new Error("fixture cleanup must not replace first cause");
} });
`,
			);
			const bep = path.join(root, "bep.json");
			if (scenario !== "missing evidence")
				await Bun.write(
					bep,
					scenario === "invalid evidence"
						? "not-json\n"
						: `${JSON.stringify({ finished: { overallSuccess: true } })}\n`,
				);
			await Bun.write(
				path.join(root, "batches.json"),
				JSON.stringify({
					batches: [
						{
							argv: ["fixture-only", `--output_base=${root}-output`, "test"],
							targets: [],
							bep,
							script: scenario === "payload exit" ? "fixture-payload" : undefined,
						},
					],
				}),
			);
			const events = path.join(root, "events");
			await Bun.write(events, "");
			const cleanup = Promise.withResolvers<void>();
			child = Bun.spawn(
				[
					process.execPath,
					"--preload",
					path.join(root, "preload.ts"),
					path.join(root, "runner.ts"),
					"bazel",
					path.join(root, "context.json"),
					path.join(root, "batches.json"),
				],
				{
					cwd: root,
					env: { ...process.env, OMP_GATE_EVENT_FILE: events, OMP_GATE_EVENT_TOKEN: "fixture-auth" },
					stdout: "ignore",
					stderr: "ignore",
					ipc(message) {
						if (message?.type === "fixture-cleanup") cleanup.resolve();
					},
				},
			);
			await Promise.race([
				cleanup.promise,
				child.exited.then(code => {
					throw new Error(`Driver exited before cleanup: ${code}`);
				}),
			]);
			const beforeCleanup = await Bun.file(events).text();
			child.send("fixture-release");
			expect(await child.exited).toBe(scenario === "native exit" ? 37 : scenario === "payload exit" ? 39 : 1);
			expect(beforeCleanup).toContain("OMP_GATE_EVENT fixture-auth ");
			const failures = (await Bun.file(events).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line.slice("OMP_GATE_EVENT fixture-auth ".length)));
			expect(failures).toHaveLength(1);
			expect(failures[0].exitCode).toBe(scenario === "native exit" ? 37 : scenario === "payload exit" ? 39 : 1);
			expect(failures[0].message).not.toContain("cleanup must not replace");
		} finally {
			if (child && child.exitCode === null) {
				try {
					child.send("fixture-release");
				} catch {}
			}
			await child?.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

for (const scenario of [
	"spawn exception",
	"artifact missing",
	"artifact output missing",
	"context setup exception",
] as const) {
	test(`isolated driver reports ${scenario} using context authentication`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-primitive-failure-"));
		try {
			const events = path.join(root, "events");
			await Bun.write(events, "");
			await Bun.write(
				path.join(root, "context.json"),
				JSON.stringify({ eventFile: events, eventToken: "context-auth" }),
			);
			const output = path.join(root, "result.success.json");
			const spec = {
				workspace: root,
				label: "fixture/primitive",
				cwd: root,
				argv:
					scenario === "spawn exception"
						? [path.join(root, "does-not-exist")]
						: [process.execPath, "-e", "process.exit(0)"],
				env: {},
				isolated: scenario === "context setup exception",
				artifactFiles: scenario.startsWith("artifact") ? ["required.txt"] : undefined,
			};
			await Bun.write(path.join(root, "spec.json"), JSON.stringify(spec));
			const env = { ...process.env };
			delete env.OMP_GATE_EVENT_FILE;
			delete env.OMP_GATE_EVENT_TOKEN;
			if (scenario === "context setup exception") {
				const blocked = path.join(root, "blocked");
				await Bun.write(blocked, "not a directory");
				env.TEST_TMPDIR = blocked;
			}
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "test-gate-bazel-runner.ts"),
					"execute",
					path.join(root, "spec.json"),
					...(scenario === "artifact output missing" ? [] : [output]),
				],
				{ cwd: root, env, stdout: "ignore", stderr: "ignore" },
			);
			expect(await child.exited).not.toBe(0);
			const lines = (await Bun.file(events).text()).trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toStartWith("OMP_GATE_EVENT context-auth ");
			const failure = JSON.parse(lines[0]!.slice("OMP_GATE_EVENT context-auth ".length));
			expect(failure.kind).toBe("failure");
			expect(failure.exitCode).toBe(scenario === "spawn exception" ? 127 : 1);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}
